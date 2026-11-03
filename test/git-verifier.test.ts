import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitVerifier } from "../src/git-verifier.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

test("GitVerifier verifies immutable Tree-SHA, catches intermediate modify-then-revert of lockedPaths, and never touches dirty local working trees or executes hooks", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-verifier-"));

  try {
    const baseSha = fixture.commitFile(
      "installer/installer.iss",
      "[Setup]\nAppName=ExampleApp\n",
      "initial base",
    );
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
    const cleanObs = await verifier.verifyCandidate({
      remoteUrlOrPath: fixture.originBareDir,
      localRepoPath: fixture.workRepoDir,
      candidateRef: "refs/heads/main",
      pinnedBaseCommitSha: baseSha,
      expectedTreeSha: verifiedTreeSha,
      lockedPaths: ["installer/installer.iss"],
    });

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
    //    Net `base..head` tree has identical `installer.iss`, yet intermediate commit history violated the lock!
    const remoteClone = join(fixture.rootDir, "remote-worker");
    fixture.git(["clone", fixture.originBareDir, remoteClone], fixture.rootDir);
    fixture.git(["checkout", "-b", "robo/sneaky-revert"], remoteClone);
    fixture.commitFile(
      "installer/installer.iss",
      "[Setup]\nAppName=BrokenLinuxRewrite\n",
      "blind edit to locked iss",
      remoteClone,
    );
    fixture.commitFile(
      "installer/installer.iss",
      "[Setup]\nAppName=ExampleApp\n",
      "revert iss back to original bytes",
      remoteClone,
    );
    fixture.commitFile("src/feature.ts", "export const ok = true;\n", "add feature", remoteClone);
    fixture.git(["push", "origin", "robo/sneaky-revert"], remoteClone);

    const sneakyObs = await verifier.verifyCandidate({
      remoteUrlOrPath: fixture.originBareDir,
      candidateRef: "refs/heads/robo/sneaky-revert",
      pinnedBaseCommitSha: verifiedSourceSha,
      lockedPaths: ["installer/installer.iss"],
    });

    assert.equal(sneakyObs.reachableRefVerified, true);
    assert.equal(sneakyObs.lockedPathsClean, false);
    assert.deepEqual(sneakyObs.violatedPaths, ["installer/installer.iss"]);
    assert.equal(sneakyObs.inspectedCommitCount, 3);
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
