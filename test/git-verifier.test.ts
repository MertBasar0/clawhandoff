import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { githubCloneUrl, parseCandidateRef } from "../src/candidate-ref.js";
import { GitVerifier } from "../src/git-verifier.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

test("a candidate ref may name its GitHub repository and must otherwise be a plain ref", () => {
  const repoId = "openclaw/openclaw-windows-node";
  // Both forms Robo reported for openclaw-windows-node PR updates.
  assert.deepEqual(
    parseCandidateRef("openclaw/openclaw-windows-node:refs/heads/openclaw/tray-tests-isolate-user-profile", repoId),
    { ref: "refs/heads/openclaw/tray-tests-isolate-user-profile" },
  );
  assert.deepEqual(
    parseCandidateRef("MertBasar0/openclaw-windows-node:refs/heads/tray-tests-isolate-user-profile-1961", repoId),
    { ref: "refs/heads/tray-tests-isolate-user-profile-1961", repository: "MertBasar0/openclaw-windows-node" },
  );
  assert.equal(githubCloneUrl("MertBasar0/openclaw-windows-node"), "https://github.com/MertBasar0/openclaw-windows-node.git");
  // GitHub names are case-insensitive.
  assert.deepEqual(parseCandidateRef("OpenClaw/OpenClaw-Windows-Node:refs/heads/x", repoId), { ref: "refs/heads/x" });
  for (const plain of ["refs/heads/main", "main", "robo/feature", "refs/pull/42/head", "refs/heads/a+b", "a".repeat(40)]) {
    assert.deepEqual(parseCandidateRef(plain, repoId), { ref: plain }, plain);
  }
  for (const refused of [
    "", "refs/heads/a:refs/heads/b", "owner/repo:refs/heads/a:refs/heads/b", "owner/repo:", "-owner/repo:refs/heads/x",
    "owner/..:refs/heads/x", "https://github.com/owner/repo:refs/heads/x", "+refs/heads/main", "-q", "refs/heads/*",
    "refs/heads/[x]", "a?b", "main~1", "HEAD^", "a..b", "a@{1}", "@", "x.", "refs/heads/x.lock", "refs/heads/.hidden",
    "refs//heads", "/refs/heads/x", "refs/heads/x/", "a b", "a\\b", "a\nb",
  ]) {
    assert.equal(parseCandidateRef(refused, repoId), undefined, JSON.stringify(refused));
  }
});

test("GitVerifier fetches a candidate from the repository that holds it and refuses refspec syntax", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-fork-"));
  try {
    const base = fixture.commitFile("README.md", "base\n", "base");
    fixture.git(["push", "origin", "main"]);
    // Only a fork holds the candidate branch.
    const forkDir = join(fixture.rootDir, "fork.git");
    fixture.git(["clone", "--bare", fixture.originBareDir, forkDir], fixture.rootDir);
    fixture.git(["checkout", "-b", "robo/fork-fix"]);
    const candidate = fixture.commitFile("src/fix.ts", "export const fixed = true;\n", "fork fix");
    fixture.git(["push", forkDir, "robo/fork-fix"]);

    const verifier = new GitVerifier(dataDir);
    const params = {
      remoteUrlOrPath: fixture.originBareDir,
      candidateRef: "refs/heads/robo/fork-fix",
      pinnedBaseCommitSha: base,
      pinnedSourceCommitSha: base,
    };
    assert.equal((await verifier.verifyCandidate(params)).reachableRefVerified, false);
    const fromFork = await verifier.verifyCandidate({ ...params, candidateRemoteUrlOrPath: forkDir });
    assert.equal(fromFork.reachableRefVerified, true);
    assert.equal(fromFork.observedHeadSha, candidate.toLowerCase());
    assert.equal(fromFork.baseIsAncestor, true);
    assert.equal(fromFork.lockedPathsClean, true);

    // These would widen or break the fetch refspec, so they are refused before any fetch.
    for (const candidateRef of ["owner/repo:refs/heads/robo/fork-fix", "refs/heads/main:refs/heads/x", "+refs/heads/main", "refs/heads/*", "HEAD^"]) {
      const refused = await verifier.verifyCandidate({ ...params, candidateRemoteUrlOrPath: forkDir, candidateRef });
      assert.equal(refused.reachableRefVerified, false, candidateRef);
      assert.match((refused.verificationNotes ?? []).join("\n"), /is not a plain Git ref/, candidateRef);
    }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("GitVerifier locks the handed-off source, catches remote edits and reverts, and leaves dirty local files untouched", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-verifier-"));

  try {
    const installerPath = "installer/installer.iss";
    const baseSha = fixture.commitFile(
      installerPath,
      "[Setup]\nAppName=ExampleApp\n",
      "initial base",
    );
    fixture.commitFile(installerPath, "[Setup]\nAppName=VerifiedLocalFix\n", "local installer fix");
    fixture.commitFile("src/app.ts", "export const v = 1;\n", "add app");
    const verifiedSourceSha = fixture.revParse("HEAD");
    const verifiedTreeSha = fixture.revParse("HEAD^{tree}");
    fixture.git(["push", "origin", "main"]);

    // Plant a trap post-checkout hook and uncommitted user file in workRepoDir to prove checkout-free safety.
    const hookMarker = join(fixture.rootDir, "hook-ran.txt");
    const hookPath = join(fixture.workRepoDir, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, `#!/bin/sh\necho PWNED > "${hookMarker}"\n`, "utf8");
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows ignores POSIX exec bit.
    }
    writeFileSync(join(fixture.workRepoDir, "src/app.ts"), "export const dirtyLocalEdit = true;\n");

    const verifier = new GitVerifier(dataDir);

    // 1) Exact match on untouched branch (`publish_unchanged` contract).
    const candidate = {
      remoteUrlOrPath: fixture.originBareDir,
      localRepoPath: fixture.workRepoDir,
      candidateRef: "refs/heads/main",
      pinnedBaseCommitSha: baseSha,
      pinnedSourceCommitSha: verifiedSourceSha,
      expectedTreeSha: verifiedTreeSha,
      lockedPaths: [installerPath],
    };
    const cleanObs = await verifier.verifyCandidate(candidate);

    assert.equal(cleanObs.reachableRefVerified, true);
    assert.equal(cleanObs.observedHeadSha, verifiedSourceSha.toLowerCase());
    assert.equal(cleanObs.treeMatchesExpected, true);
    assert.equal(cleanObs.lockedPathsClean, true);
    assert.deepEqual(cleanObs.violatedPaths, []);

    // Dirty local working tree was NOT touched or stashed, and no hook executed.
    assert.equal(
      readFileSync(join(fixture.workRepoDir, "src/app.ts"), "utf8"),
      "export const dirtyLocalEdit = true;\n",
    );
    assert.equal(existsSync(hookMarker), false);

    // 2) Simulate a remote branch that modifies locked `installer.iss` in commit A, then reverts it
    //    back to identical bytes in commit B while editing `src/feature.ts`.
    //    Net `source..head` has identical installer bytes, but remote history violated the lock.
    const remoteClone = join(fixture.rootDir, "remote-worker");
    fixture.git(["clone", fixture.originBareDir, remoteClone], fixture.rootDir);
    fixture.git(["checkout", "-b", "robo/sneaky-revert"], remoteClone);
    fixture.commitFile(
      installerPath,
      "[Setup]\nAppName=BrokenLinuxRewrite\n",
      "blind edit to locked iss",
      remoteClone,
    );
    fixture.commitFile(
      installerPath,
      "[Setup]\nAppName=VerifiedLocalFix\n",
      "revert iss back to original bytes",
      remoteClone,
    );
    fixture.commitFile("src/feature.ts", "export const ok = true;\n", "add feature", remoteClone);
    fixture.git(["push", "origin", "robo/sneaky-revert"], remoteClone);

    const sneakyObs = await verifier.verifyCandidate({
      ...candidate,
      candidateRef: "refs/heads/robo/sneaky-revert",
      expectedTreeSha: undefined,
    });

    assert.equal(sneakyObs.reachableRefVerified, true);
    assert.equal(sneakyObs.lockedPathsClean, false);
    assert.deepEqual(sneakyObs.violatedPaths, [installerPath]);
    assert.equal(sneakyObs.inspectedCommitCount, 3);
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("GitVerifier requires both PR base and handoff source ancestry even without locked files", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-ancestry-"));
  try {
    const baseSha = fixture.commitFile("README.md", "main", "main history");
    fixture.git(["push", "origin", "main"]);
    fixture.git(["checkout", "--orphan", "unrelated"]);
    const otherSha = fixture.commitFile("README.md", "other", "unrelated history");
    fixture.git(["push", "origin", "unrelated"]);
    const verifier = new GitVerifier(dataDir);
    for (const [base, source] of [[otherSha, baseSha], [baseSha, otherSha]] as const) {
      const candidate = {
        remoteUrlOrPath: fixture.originBareDir,
        candidateRef: "refs/heads/main",
        pinnedBaseCommitSha: base,
        pinnedSourceCommitSha: source,
      };
      const observed = await verifier.verifyCandidate(candidate);
      assert.equal(observed.reachableRefVerified, true);
      assert.equal(observed.baseIsAncestor, base === baseSha);
      assert.equal(observed.lockedPathsClean, false);
    }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("GitVerifier detects locked paths containing Unicode and whitespace", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-paths-"));
  try {
    const lockedPath = "installer/kurulum özel.iss";
    const base = fixture.commitFile(lockedPath, "verified", "base");
    fixture.commitFile(lockedPath, "remote edit", "change locked path");
    fixture.git(["push", "origin", "main"]);
    const observed = await new GitVerifier(dataDir).verifyCandidate({
      remoteUrlOrPath: fixture.originBareDir,
      candidateRef: "refs/heads/main",
      pinnedBaseCommitSha: base,
      lockedPaths: [lockedPath],
    });
    assert.equal(observed.lockedPathsClean, false);
    assert.deepEqual(observed.violatedPaths, [lockedPath]);
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("GitVerifier borrows common object store from linked Git worktrees for delta-only verification", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-worktree-"));
  try {
    const base = fixture.commitFile("README.md", "base\n", "base commit");
    fixture.git(["push", "origin", "main"]);
    const worktreeDir = join(fixture.rootDir, "linked-wt");
    fixture.git(["worktree", "add", "-b", "wt-branch", worktreeDir, "HEAD"]);
    const candidateSha = fixture.commitFile("src/wt.ts", "export const wt = 1;\n", "wt commit", worktreeDir);
    const candidateTree = fixture.revParse("HEAD^{tree}", worktreeDir);
    fixture.git(["push", "origin", "wt-branch"], worktreeDir);

    const verifier = new GitVerifier(dataDir);
    const observed = await verifier.verifyCandidate({
      remoteUrlOrPath: fixture.originBareDir,
      localRepoPath: worktreeDir,
      candidateRef: "refs/heads/wt-branch",
      pinnedBaseCommitSha: base,
      pinnedSourceCommitSha: candidateSha,
      expectedTreeSha: candidateTree,
    });
    assert.equal(observed.reachableRefVerified, true);
    assert.equal(observed.observedHeadSha, candidateSha.toLowerCase());
    assert.equal(observed.treeMatchesExpected, true);
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("GitVerifier kills the full git child+grandchild process tree on fetch timeout", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-timeout-tree-"));
  const pidFile = join(dataDir, "grandchild.pid");
  const sshScript = join(dataDir, "fake-ssh.mjs");
  const prevSsh = process.env.GIT_SSH_COMMAND;

  writeFileSync(
    sshScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(sub.pid), "utf8");`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  // Forward-slash paths keep Git's sh-parsed GIT_SSH_COMMAND portable across Windows and POSIX.
  process.env.GIT_SSH_COMMAND = `"${process.execPath.replace(/\\/g, "/")}" "${sshScript.replace(/\\/g, "/")}"`;

  try {
    const base = fixture.commitFile("README.md", "base\n", "base commit");
    const verifier = new GitVerifier(dataDir, { fetchTimeoutMs: 400 });
    const observed = await verifier.verifyCandidate({
      remoteUrlOrPath: "ssh://git@127.0.0.1/example/repo.git",
      localRepoPath: fixture.workRepoDir,
      candidateRef: "refs/heads/main",
      pinnedBaseCommitSha: base,
    });

    assert.equal(observed.reachableRefVerified, false);
    assert.match((observed.verificationNotes ?? []).join("\n"), /timed out/i);
    assert.equal(existsSync(pidFile), true, "fake ssh helper must have spawned grandchild before timeout");

    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    // Allow OS process-tree teardown (taskkill /T /F on win32) a brief moment to reap the grandchild.
    let alive = true;
    for (let i = 0; i < 15 && alive; i += 1) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    try {
      if (alive) process.kill(grandchildPid, "SIGKILL");
    } catch {
      // Already exited.
    }
    assert.equal(alive, false, `Grandchild PID ${grandchildPid} should be terminated with git fetch timeout`);
  } finally {
    if (prevSsh === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = prevSsh;
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
