import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { BridgeService } from "../src/bridge-service.js";
import { BridgeError, type BridgeConfig } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

async function preparePublication(t: TestContext, reportedSha?: string) {
  const fixture = createTempGitFixture();
  const head = fixture.commitFile("README.md", "verified tree", "prepare candidate");
  const ref = "refs/heads/main";
  fixture.git(["push", "origin", ref]);
  const statePath = join(fixture.rootDir, "gateway.json");
  const originalEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = statePath;
  const queuedTurnReplies = ["ready_for_publish_gate", "completed"].map((disposition) => ({
    replyText: "```handoff-result\n" + JSON.stringify({ disposition, candidateRef: ref,
      candidateCommitSha: reportedSha ?? head, summaryDelta: disposition, blockers: [], claimedChecks: [] }) + "\n```",
  }));
  writeFileSync(statePath, JSON.stringify({ queuedTurnReplies, openPrs: [] }));
  const config: BridgeConfig = {
    dataDir: fixture.rootDir,
    ghCliPath: resolve("test/helpers/fake-gh-cli.mjs"),
    targets: { robo: { targetId: "robo", url: "https://gateway.example", authMode: "direct-token",
      agentId: "main", cliPath: resolve("test/helpers/fake-openclaw-cli.mjs") } },
  };
  let service = new BridgeService(config);
  t.after(() => {
    service.close();
    if (originalEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = originalEnv;
    fixture.cleanup();
  });
  const ready = await service.startHandoff({ targetId: "robo", envelope: {
    schemaVersion: "0.2", requestId: "gate-test", workspaceId: "workspace", title: "Publish verified commit",
    outcome: "Publish a draft after exact commit verification.", mode: "publish_unchanged", publisherOwner: "remote_gated",
    gitContext: { repoId: "example/repo", remoteUrlOrPath: fixture.originBareDir, pinnedBaseCommitSha: head,
      pinnedSourceCommitSha: head, expectedTreeSha: fixture.revParse("HEAD^{tree}"), sourceRemoteRef: ref },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["Only the approved commit is published"],
  } });
  assert.equal(ready.orchestratorDirective.action, reportedSha ? "CONTINUE_AUTONOMOUSLY" : "AUTHORIZE_REMOTE_PUBLISH");
  const { handoffId } = ready;
  return {
    authorize: () => service.continueHandoff({ handoffId, intent: "authorize_publish", message: "Publish the verified commit." }),
    verify: () => service.verifyGit({ handoffId, candidateRef: ref }),
    restart: () => { service.close(); service = new BridgeService(config); },
    moveHead: () => {
      fixture.git(["commit", "--allow-empty", "-m", "another commit with the same tree"]);
      fixture.git(["push", "origin", ref]);
      return fixture.revParse("HEAD");
    },
    statePath,
  };
}

test("Stage 1 must bind the target's reported commit to the reachable head", async (t) => {
  const gate = await preparePublication(t, "a".repeat(40));
  await assert.rejects(gate.authorize, (err: unknown) =>
    err instanceof BridgeError && err.code === "CONTRACT_VIOLATION");
  assert.equal(JSON.parse(readFileSync(gate.statePath, "utf8")).rpcCounts["chat.send"] ?? 0, 0);
});

test("Stage 2 rejects a moved ref on repeated authorization before sending a publish message", async (t) => {
  const gate = await preparePublication(t);
  gate.moveHead();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(gate.authorize, (e: unknown) => e instanceof BridgeError && e.code === "CONTRACT_VIOLATION");
  }
  const state = JSON.parse(readFileSync(gate.statePath, "utf8"));
  assert.equal(state.rpcCounts["chat.send"] ?? 0, 0);
});

test("Fresh verification after restart cannot replace a pending publication's authorized commit", async (t) => {
  const gate = await preparePublication(t);
  const pending = await gate.authorize();
  assert.equal(pending.observed.reconciledPrState, "uncertain_in_flight");
  const moved = gate.moveHead();
  const state = JSON.parse(readFileSync(gate.statePath, "utf8"));
  state.openPrs = [{ url: "https://github.com/example/repo/pull/8", headRefName: "main", headRefOid: moved }];
  writeFileSync(gate.statePath, JSON.stringify(state));
  for (let observation = 0; observation < 2; observation++) {
    gate.restart();
    const result = await gate.verify();
    assert.equal(result.observed.observedHeadSha, moved);
    assert.equal(result.observed.reconciledPrState, "uncertain_in_flight");
    await assert.rejects(gate.authorize, (e: unknown) => e instanceof BridgeError && e.code === "RECONCILIATION_UNCERTAIN");
  }
  assert.equal(JSON.parse(readFileSync(gate.statePath, "utf8")).rpcCounts["chat.send"], 1);
});
