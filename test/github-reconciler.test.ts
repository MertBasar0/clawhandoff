import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { GitHubReconciler } from "../src/github-reconciler.js";
import type { ReconciledPrState } from "../src/types.js";

test("PR reconciliation verifies the exact open head and preserves uncertain publication outcomes", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-pr-state-"));
  const stateFile = join(dataDir, "github-state.json");
  const previousStateFile = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = stateFile;
  const reconciler = new GitHubReconciler(resolve("test/helpers/fake-gh-cli.mjs"));
  const headSha = "a".repeat(40);
  const priorUrl = "https://github.com/example/repo/pull/42";
  const pr = {
    number: 42,
    url: priorUrl,
    headRefName: "candidate",
    headRefOid: headSha,
    body: "Handoff-ID: handoff-42",
    state: "OPEN",
    isCrossRepository: false,
  };
  const another = { ...pr, number: 43, url: "https://github.com/example/repo/pull/43" };
  const cases: Array<{
    name: string;
    records: Array<typeof pr>;
    priorState: ReconciledPrState;
    expected: ReconciledPrState;
    fail?: boolean;
    headSha?: string;
    reportedPrUrl?: string;
  }> = [
    { name: "exact open commit", records: [pr], priorState: "uncertain_in_flight", expected: "open_verified", headSha },
    { name: "task marker cannot override a different commit", records: [{ ...pr, headRefOid: "b".repeat(40) }], priorState: "none", expected: "uncertain_in_flight", headSha },
    { name: "missing expected commit cannot verify a PR", records: [pr], priorState: "none", expected: "uncertain_in_flight" },
    { name: "empty search before publication", records: [], priorState: "none", expected: "none", headSha },
    { name: "empty search after uncertain publication", records: [], priorState: "uncertain_in_flight", expected: "uncertain_in_flight", headSha },
    { name: "previously verified PR is now closed", records: [{ ...pr, state: "CLOSED" }], priorState: "open_verified", expected: "uncertain_in_flight", headSha },
    { name: "merged PR prevents duplicate publication", records: [{ ...pr, state: "MERGED" }], priorState: "none", expected: "uncertain_in_flight", headSha },
    { name: "previously verified PR head changed", records: [{ ...pr, headRefOid: "b".repeat(40) }], priorState: "open_verified", expected: "uncertain_in_flight", headSha },
    { name: "unavailable GitHub cannot confirm an old observation", records: [], priorState: "open_verified", expected: "uncertain_in_flight", fail: true, headSha },
    { name: "unavailable GitHub cannot certify absence", records: [], priorState: "none", expected: "uncertain_in_flight", fail: true, headSha },
    { name: "same head on a different PR cannot replace the recorded URL", records: [another], priorState: "open_verified", expected: "uncertain_in_flight", headSha },
    { name: "same head on a different PR cannot verify the reported URL", records: [another], reportedPrUrl: priorUrl, priorState: "none", expected: "uncertain_in_flight", headSha },
    { name: "multiple open PRs on the same head need disambiguation", records: [another, pr], priorState: "none", expected: "uncertain_in_flight", headSha },
    { name: "a fork with the same branch and commit needs an explicit PR identity", records: [{ ...pr, isCrossRepository: true }], priorState: "none", expected: "uncertain_in_flight", headSha },
    { name: "explicit URL identifies the open fork PR among equal heads", records: [another, { ...pr, isCrossRepository: true }], reportedPrUrl: priorUrl, priorState: "none", expected: "open_verified", headSha },
  ];

  try {
    for (const c of cases) {
      await t.test(c.name, async () => {
        writeFileSync(stateFile, JSON.stringify({ openPrs: c.records, ghFailure: c.fail }));
        const result = await reconciler.reconcilePullRequest({
          repoId: "example/repo",
          headRef: "refs/heads/candidate",
          headSha: c.headSha,
          handoffId: "handoff-42",
          priorState: c.priorState,
          priorUrl: c.priorState === "open_verified" ? priorUrl : undefined,
          reportedPrUrl: c.reportedPrUrl,
        });
        assert.equal(result.prState, c.expected);
        if (c.expected === "open_verified") {
          assert.equal(result.prUrl, priorUrl);
        }
      });
    }
  } finally {
    if (previousStateFile === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = previousStateFile;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
