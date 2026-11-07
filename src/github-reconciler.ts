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
