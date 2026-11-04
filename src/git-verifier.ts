import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeLockedPath } from "./schema.js";
import { BridgeError, type ObservedResult, type ReconciledPrState } from "./types.js";

const execFileAsync = promisify(execFile);

function isLocalPath(remote: string): boolean {
  if (/^(https?|ssh|git):\/\//i.test(remote) || /^[\w.-]+@[\w.-]+:/.test(remote)) {
    return false;
  }
  try {
    return existsSync(remote) && statSync(remote).isDirectory();
  } catch {
    return false;
  }
}

function matchesLockedPath(changedPath: string, lockedPaths: readonly string[]): boolean {
  const normChanged = changedPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  for (const rawLocked of lockedPaths) {
    const locked = rawLocked.replace(/\/+$/, "");
    if (normChanged === locked || normChanged.startsWith(`${locked}/`)) {
      return true;
    }
  }
  return false;
}

export class GitVerifier {
  private readonly mirrorsRoot: string;

  constructor(dataDir: string) {
    this.mirrorsRoot = join(dataDir, "git-mirrors");
    mkdirSync(this.mirrorsRoot, { recursive: true });
  }

  /** Resolve a commit's tree SHA from an existing local repository without touching working tree files. */
  async resolveLocalCommitTree(localRepoPath: string, commitSha: string): Promise<string> {
    const out = await this.runGit(
      localRepoPath,
      ["rev-parse", "--verify", `${commitSha}^{tree}`],
      false,
    );
    return out.trim().toLowerCase();
  }

  async verifyCandidate(params: {
    remoteUrlOrPath: string;
    localRepoPath?: string;
    candidateRef: string;
    pinnedBaseCommitSha: string;
    pinnedSourceCommitSha?: string;
    expectedTreeSha?: string;
    lockedPaths?: readonly string[];
    existingPrState?: ReconciledPrState;
    existingPrUrl?: string;
  }): Promise<ObservedResult> {
    const {
      remoteUrlOrPath,
      localRepoPath,
      candidateRef,
      pinnedBaseCommitSha,
      pinnedSourceCommitSha,
      expectedTreeSha,
      lockedPaths = [],
      existingPrState = "none",
      existingPrUrl,
    } = params;

    const normalizedLocks = lockedPaths.map(normalizeLockedPath);
    const lockBaseSha = pinnedSourceCommitSha ?? pinnedBaseCommitSha;
    const mirrorDir = await this.ensureBareMirror(remoteUrlOrPath);
    const tempRef = `refs/bridge/verify/${randomUUID()}`;
    const notes: string[] = [];

    try {
      // The PR base and handed-off source have different roles: local fixes before
      // the handoff are allowed, while subsequent remote edits remain locked.
      for (const sha of new Set([pinnedBaseCommitSha, lockBaseSha])) {
        if (localRepoPath && isLocalPath(localRepoPath)) {
          await this.ensureCommitPresent(mirrorDir, localRepoPath, sha);
        }
        await this.ensureCommitPresent(mirrorDir, remoteUrlOrPath, sha);
      }

      const remoteIsLocal = isLocalPath(remoteUrlOrPath);
      const bloblessArgs = remoteIsLocal ? [] : ["--filter=blob:none"];
      try {
        await this.runGit(
          mirrorDir,
          [
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            ...bloblessArgs,
            "--",
            remoteUrlOrPath,
            `${candidateRef}:${tempRef}`,
          ],
          remoteIsLocal,
        );
      } catch (err) {
        notes.push(
          `Failed to fetch candidateRef "${candidateRef}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          reachableRefVerified: false,
          reconciledPrState: existingPrState,
          reconciledPrUrl: existingPrUrl,
          verificationNotes: notes,
        };
      }

      const observedHeadSha = (
        await this.runGit(mirrorDir, ["rev-parse", "--verify", `${tempRef}^{commit}`], false)
      )
        .trim()
        .toLowerCase();

      const observedTreeSha = (
        await this.runGit(mirrorDir, ["rev-parse", "--verify", `${observedHeadSha}^{tree}`], false)
      )
        .trim()
        .toLowerCase();

      const baseExists = await this.hasCommit(mirrorDir, pinnedBaseCommitSha);
      let baseIsAncestor = false;
      if (baseExists) {
        baseIsAncestor = await this.isAncestor(mirrorDir, pinnedBaseCommitSha, observedHeadSha);
        if (!baseIsAncestor) {
          notes.push(
            `Pinned base commit ${pinnedBaseCommitSha} is NOT an ancestor of candidate head ${observedHeadSha}.`,
          );
        }
      } else {
        notes.push(
          `Pinned base commit ${pinnedBaseCommitSha} could not be fetched into isolated mirror.`,
        );
      }

      const lockBaseIsAncestor =
        lockBaseSha === pinnedBaseCommitSha
          ? baseIsAncestor
          : (await this.hasCommit(mirrorDir, lockBaseSha)) &&
            (await this.isAncestor(mirrorDir, lockBaseSha, observedHeadSha));
      if (!lockBaseIsAncestor && lockBaseSha !== pinnedBaseCommitSha) {
        notes.push(
          `Pinned source commit ${lockBaseSha} is unavailable or is not an ancestor of candidate head ${observedHeadSha}.`,
        );
      }

      const treeMatchesExpected = expectedTreeSha
        ? observedTreeSha === expectedTreeSha.toLowerCase()
        : undefined;
      if (treeMatchesExpected === false) {
        notes.push(
          `Tree SHA mismatch: expected ${expectedTreeSha?.toLowerCase()}, observed ${observedTreeSha}.`,
        );
      }

      let lockedPathsClean: boolean | undefined;
      let violatedPaths: string[] | undefined;
      let inspectedCommitCount = 0;

      if (!baseIsAncestor || !lockBaseIsAncestor) {
        lockedPathsClean = false;
        violatedPaths = [];
      } else if (normalizedLocks.length === 0) {
        lockedPathsClean = true;
        violatedPaths = [];
      } else {
        const violated = new Set<string>();

        // 1) Compare the handed-off source with the candidate head.
        const netDiffOut = await this.runGit(
          mirrorDir,
          [
            "diff-tree",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            "-r",
            lockBaseSha,
            observedHeadSha,
          ],
          false,
        );
        for (const file of netDiffOut.split("\0").filter(Boolean)) {
          if (matchesLockedPath(file, normalizedLocks)) {
            violated.add(file);
          }
        }

        // 2) Inspect post-handoff commits so modify-then-revert is also caught.
        const revListOut = await this.runGit(
          mirrorDir,
          ["rev-list", `${lockBaseSha}..${observedHeadSha}`],
          false,
        );
        const commits = splitLines(revListOut);
        inspectedCommitCount = commits.length;

        for (const commit of commits) {
          const commitDiffOut = await this.runGit(
            mirrorDir,
            [
              "diff-tree",
              "--no-commit-id",
              "--no-ext-diff",
              "--no-textconv",
              "--name-only",
              "-z",
              "-r",
              "-m",
              "--root",
              commit,
            ],
            false,
          );
          for (const file of commitDiffOut.split("\0").filter(Boolean)) {
            if (matchesLockedPath(file, normalizedLocks)) {
              violated.add(file);
            }
          }
        }

        violatedPaths = Array.from(violated).sort();
        lockedPathsClean = violatedPaths.length === 0;
        if (violatedPaths.length > 0) {
          notes.push(
            `Locked paths modified after handoff source (${inspectedCommitCount} commit(s) inspected): ${violatedPaths.join(", ")}`,
          );
        }
      }

      return {
        reachableRefVerified: true,
        observedHeadSha,
        observedTreeSha,
        baseIsAncestor,
        treeMatchesExpected,
        lockedPathsClean,
        violatedPaths,
        inspectedCommitCount,
        reconciledPrState: existingPrState,
        reconciledPrUrl: existingPrUrl,
        ...(notes.length > 0 ? { verificationNotes: notes } : {}),
      };
    } finally {
      try {
        await this.runGit(mirrorDir, ["update-ref", "-d", tempRef], false);
      } catch {
        // Best-effort temporary ref cleanup.
      }
    }
  }

  private async ensureBareMirror(keySource: string): Promise<string> {
    const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 24);
    const mirrorDir = join(this.mirrorsRoot, `${hash}.git`);
    if (!existsSync(join(mirrorDir, "HEAD"))) {
      mkdirSync(mirrorDir, { recursive: true });
      await this.runGit(mirrorDir, ["init", "--bare", "--quiet"], false);
    }
    return mirrorDir;
  }

  private async hasCommit(mirrorDir: string, sha: string): Promise<boolean> {
    try {
      await this.runGit(mirrorDir, ["cat-file", "-e", `${sha}^{commit}`], false);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureCommitPresent(
    mirrorDir: string,
    sourceUrlOrPath: string,
    sha: string,
  ): Promise<void> {
    if (await this.hasCommit(mirrorDir, sha)) {
      return;
    }
    const localSource = isLocalPath(sourceUrlOrPath);
    const bloblessArgs = localSource ? [] : ["--filter=blob:none"];
    try {
      await this.runGit(
        mirrorDir,
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          ...bloblessArgs,
          "--",
          sourceUrlOrPath,
          sha,
        ],
        localSource,
      );
    } catch {
      // Some remotes disallow direct unadvertised SHA fetch; fallback to fetching default heads if needed.
      try {
        await this.runGit(
          mirrorDir,
          [
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            ...bloblessArgs,
            "--",
            sourceUrlOrPath,
            "+refs/heads/*:refs/bridge/remotes/*",
          ],
          localSource,
        );
      } catch {
        // Handled by caller via hasCommit check.
      }
    }
  }

  private async isAncestor(mirrorDir: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
    try {
      await this.runGit(
        mirrorDir,
        ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
        false,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async runGit(
    cwd: string,
    args: string[],
    allowFileProtocol: boolean,
  ): Promise<string> {
    const hardenedPrefix = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      ...(allowFileProtocol ? ["-c", "protocol.file.allow=always"] : []),
    ];

    try {
      const { stdout } = await execFileAsync("git", [...hardenedPrefix, ...args], {
        cwd,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      return stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BridgeError("GIT_VERIFICATION_FAILED", `Git command failed (${args[0]}): ${msg}`);
    }
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
