import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitVerifier } from "../src/git-verifier.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

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
