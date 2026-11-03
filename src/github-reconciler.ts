import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
    if (params.priorState === "open_verified" && params.priorUrl) {
      return { prState: "open_verified", prUrl: params.priorUrl };
    }

    const headBranch = params.headRef?.replace(/^refs\/heads\//, "");
    if (!headBranch) {
      return {
        prState: params.reportedPrUrl ? "uncertain_in_flight" : params.priorState,
        prUrl: params.priorUrl,
      };
    }

    try {
      const raw = await this.invokeGh([
        "pr",
        "list",
        "--repo",
        params.repoId,
        "--head",
        headBranch,
        "--state",
        "open",
        "--limit",
        "10",
        "--json",
        "number,url,headRefOid,body",
      ]);
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") {
            continue;
          }
          const rec = item as Record<string, unknown>;
          const url = typeof rec.url === "string" ? rec.url : undefined;
          const oid = typeof rec.headRefOid === "string" ? rec.headRefOid.toLowerCase() : undefined;
          const body = typeof rec.body === "string" ? rec.body : "";
          if (
            url &&
            (!params.headSha ||
              oid === params.headSha.toLowerCase() ||
              body.includes(params.handoffId))
          ) {
            return { prState: "open_verified", prUrl: url };
          }
        }
      }

      // `gh` succeeded and returned no matching open PR:
      if (params.reportedPrUrl) {
        // Model claimed a PR URL that `gh` did not yet return (e.g. fork/eventual consistency) -> keep uncertain.
        return { prState: "uncertain_in_flight" };
      }
      return { prState: "none" };
    } catch {
      // `gh` failed or is unconfigured: fail closed if a publish was attempted or claimed.
      if (params.priorState === "uncertain_in_flight" || params.reportedPrUrl) {
        return { prState: "uncertain_in_flight", prUrl: params.priorUrl };
      }
      return { prState: params.priorState, prUrl: params.priorUrl };
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
