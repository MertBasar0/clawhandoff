import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCandidateRef } from "./candidate-ref.js";
import type { ReconciledPrState, RivalPrWarning } from "./types.js";

const execFileAsync = promisify(execFile);

export class GitHubReconciler {
  private readonly ghCliPath: string;

  constructor(ghCliPath = "gh") {
    this.ghCliPath = ghCliPath;
  }

  /**
   * Non-blocking preflight scan for open/merged PRs matching an issue or query.
   * Returns an empty list if `gh` is unavailable or unauthenticated so preflight remains advisory.
   */
  async findRivalPullRequests(params: {
    repoId?: string;
    issueQuery?: string;
  }): Promise<RivalPrWarning[]> {
    if (!params.repoId || !params.issueQuery) {
      return [];
    }
    try {
      const raw = await this.invokeGh([
        "pr",
        "list",
        "--repo",
        params.repoId,
        "--search",
        params.issueQuery,
        "--state",
        "all",
        "--limit",
        "10",
        "--json",
        "number,url,state,title,headRefName",
      ]);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.flatMap((item): RivalPrWarning[] => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.number !== "number" || typeof rec.url !== "string") {
          return [];
        }
        return [
          {
            number: rec.number,
            url: rec.url,
            state: typeof rec.state === "string" ? rec.state : "UNKNOWN",
            title: typeof rec.title === "string" ? rec.title : "",
            headRefName: typeof rec.headRefName === "string" ? rec.headRefName : undefined,
          },
        ];
      });
    } catch {
      return [];
    }
  }

  /**
   * Authoritatively reconciles PR state via `gh pr list`.
   * Strict `reported` vs `observed` separation: model-claimed `reportedPrUrl` is NEVER promoted to
   * `open_verified` without external `gh` confirmation; unconfirmed publish claims remain `uncertain_in_flight`.
   */
  async reconcilePullRequest(params: {
    repoId: string;
    headRef?: string;
    headSha?: string;
    handoffId: string;
    priorState: ReconciledPrState;
    priorUrl?: string;
    reportedPrUrl?: string;
  }): Promise<{ prState: ReconciledPrState; prUrl?: string }> {
    const uncertain = {
      prState: "uncertain_in_flight" as const,
      prUrl: params.priorUrl,
    };
    // A target may report owner/repo:<ref>, but gh filters by the branch name alone.
    const head = params.headRef ? parseCandidateRef(params.headRef, params.repoId) : undefined;
    const headRef = head?.ref ?? params.headRef;
    const headBranch = headRef?.replace(/^refs\/heads\//, "");
    if (!headBranch || !params.headSha) {
      return uncertain;
    }
    if (params.priorUrl && params.reportedPrUrl && params.priorUrl !== params.reportedPrUrl) {
      return uncertain;
    }
    const expectedUrl = params.priorUrl ?? params.reportedPrUrl;
    // Pull numbers belong to the repository that holds the ref.
    const pullRefMatch = head?.repository ? null : /^refs\/pull\/(\d+)\/head$/.exec(headRef ?? "");
    if (pullRefMatch) {
      try {
        const raw = await this.invokeGh([
          "pr",
          "view",
          pullRefMatch[1]!,
          "--repo",
          params.repoId,
          "--json",
          "url,headRefOid,state",
        ]);
        const rec = JSON.parse(raw) as Record<string, unknown>;
        const url = typeof rec?.url === "string" ? rec.url : undefined;
        const oid = typeof rec?.headRefOid === "string" ? rec.headRefOid.toLowerCase() : undefined;
        if (url && rec.state === "OPEN" && oid === params.headSha.toLowerCase() && (!expectedUrl || url === expectedUrl)) {
          return { prState: "open_verified", prUrl: url };
        }
      } catch {
        // Fall through to uncertain_in_flight when PR lookup fails.
      }
      return uncertain;
    }
    const lookupLimit = 10;

    try {
      const raw = await this.invokeGh([
        "pr",
        "list",
        "--repo",
        params.repoId,
        "--head",
        headBranch,
        "--state",
        "all",
        "--limit",
        String(lookupLimit),
        "--json",
        "url,headRefOid,state,isCrossRepository",
      ]);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return uncertain;
      }
      let candidateUrl: string | undefined;
      for (const item of parsed) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const rec = item as Record<string, unknown>;
        const url = typeof rec.url === "string" ? rec.url : undefined;
        const oid = typeof rec.headRefOid === "string" ? rec.headRefOid.toLowerCase() : undefined;
        if (!url || rec.state !== "OPEN" || oid !== params.headSha.toLowerCase()) {
          continue;
        }
        if (expectedUrl) {
          if (url === expectedUrl) return { prState: "open_verified", prUrl: url };
          continue;
        }
        // The handoff does not specify a fork owner or destination branch. Only
        // infer the PR from a unique same-repository match in a complete listing,
        // and never for a ref the target placed in another repository.
        if (rec.isCrossRepository !== false || head?.repository || candidateUrl || parsed.length >= lookupLimit) {
          return uncertain;
        }
        candidateUrl = url;
      }
      if (candidateUrl) return { prState: "open_verified", prUrl: candidateUrl };

      // A closed/merged/drifted PR is not permission to publish again. An empty
      // search also cannot disprove a prior publication whose response was lost.
      if (parsed.length > 0 || params.priorState !== "none" || expectedUrl) {
        return uncertain;
      }
      return { prState: "none" };
    } catch {
      // Failure is not a fresh observation of either presence or absence.
      return uncertain;
    }
  }

  /**
   * Reconciles an update to one existing pull request. A target's managed publication makes its own
   * commit, so the update is recognized by its tree, never by an exact commit SHA:
   * - head still at expectedHeadSha: the update has not landed ("none"),
   * - head moved to a commit whose tree is publishedTreeSha: it landed ("open_verified"),
   * - anything else (closed, other tree, lookup failure): "uncertain_in_flight".
   */
  async reconcilePullRequestUpdate(params: {
    repoId: string;
    url: string;
    expectedHeadSha: string;
    publishedTreeSha: string;
  }): Promise<{ prState: ReconciledPrState; prUrl: string; headSha?: string; note: string }> {
    const number = /\/pull\/(\d+)$/.exec(params.url)?.[1];
    const uncertain = (note: string, headSha?: string) =>
      ({ prState: "uncertain_in_flight" as const, prUrl: params.url, ...(headSha ? { headSha } : {}), note });
    if (!number) return uncertain("The pull request URL has no number.");
    let head: string | undefined;
    try {
      const rec = JSON.parse(await this.invokeGh([
        "pr", "view", number, "--repo", params.repoId, "--json", "url,headRefOid,state",
      ])) as Record<string, unknown>;
      head = typeof rec?.headRefOid === "string" ? rec.headRefOid.toLowerCase() : undefined;
      if (rec?.url !== params.url || !head) return uncertain("GitHub did not confirm this pull request.");
      if (rec.state !== "OPEN") return uncertain(`The pull request is ${String(rec.state).toLowerCase()}.`, head);
    } catch {
      return uncertain("The pull request lookup failed.");
    }
    if (head === params.expectedHeadSha.toLowerCase()) {
      return { prState: "none", prUrl: params.url, headSha: head, note: "The pull request is still at its expected pre-publish head." };
    }
    try {
      const commit = JSON.parse(await this.invokeGh(["api", `repos/${params.repoId}/git/commits/${head}`])) as
        { tree?: { sha?: unknown } };
      const tree = typeof commit?.tree?.sha === "string" ? commit.tree.sha.toLowerCase() : undefined;
      if (tree === params.publishedTreeSha.toLowerCase()) {
        return { prState: "open_verified", prUrl: params.url, headSha: head, note: "The pull request head now has the verified tree." };
      }
      return uncertain(`The pull request head moved to ${head}, whose tree is not the verified tree. Someone else may have updated it.`, head);
    } catch {
      return uncertain(`The pull request head moved to ${head}, and its tree could not be read.`, head);
    }
  }

  private async invokeGh(args: string[]): Promise<string> {
    const isJsScript = /\.(?:mjs|cjs|js)$/i.test(this.ghCliPath);
    const cmd = isJsScript ? process.execPath : this.ghCliPath;
    const finalArgs = isJsScript ? [this.ghCliPath, ...args] : args;
    const { stdout } = await execFileAsync(cmd, finalArgs, {
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout;
  }
}
