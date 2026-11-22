import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BridgeService, loadBridgeConfig } from "../src/index.js";
import { BridgeError, type HandoffEnvelopeV2 } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

const FAKE_GH_CLI = resolve(process.cwd(), "test/helpers/fake-gh-cli.mjs");
const FAKE_ACP_AGENT = resolve(process.cwd(), "test/helpers/fake-acp-agent.mjs");

function resultBlock(payload: Record<string, unknown>): string {
  return `Done.\n\`\`\`handoff-result\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

const needsEvidence = resultBlock({
  disposition: "needs_evidence",
  summaryDelta: "Read the issue; need the reporter's timeline.",
  blockers: ["Timeline missing"],
  claimedChecks: [],
});

function setup(queuedPrompts: Array<Record<string, unknown>>) {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-acp-reconcile-"));
  const acpStateFile = join(dataDir, "acp-state.json");
  const ghStateFile = join(dataDir, "fake-gh-state.json");
  const configPath = join(dataDir, "bridge.json");
  const baseSha = fixture.commitFile("src/app.ts", "export const a = 1;\n", "base");
  fixture.git(["push", "origin", "main"]);
  writeFileSync(ghStateFile, JSON.stringify({ openPrs: [] }), "utf8");
  writeFileSync(acpStateFile, JSON.stringify({ sessions: {}, queuedPrompts }), "utf8");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      ghCliPath: FAKE_GH_CLI,
      defaultPublisherOwner: "local",
      targets: {
        codex: {
          transport: "acp",
          targetId: "codex",
          agent: "codex",
          command: process.execPath,
          args: [FAKE_ACP_AGENT, acpStateFile],
          cwd: fixture.workRepoDir,
        },
      },
    }),
    "utf8",
  );
  const envelope: HandoffEnvelopeV2 = {
    schemaVersion: "0.2",
    requestId: `acp-reconcile-${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws",
    title: "Investigate an app-owned replacement deadlock",
    outcome: "Report a design for the root-cause fix.",
    mode: "investigate",
    publisherOwner: "local",
    gitContext: {
      repoId: "example/app",
      localRepoPath: fixture.workRepoDir,
      remoteUrlOrPath: fixture.originBareDir,
      pinnedBaseCommitSha: baseSha,
    },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["A design is reported"],
    advisoryInstructions: [],
    priorEvidence: [],
  } as HandoffEnvelopeV2;
  const prevGh = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = ghStateFile;
  return {
    config: loadBridgeConfig(configPath),
    dataDir,
    envelope,
    restoreEnv: () => {
      if (prevGh === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
      else process.env.FAKE_GATEWAY_STATE_FILE = prevGh;
    },
  };
}

test("ACP: a prompt that ends without any reply settles as failed, and the handoff continues", async () => {
  // The first prompt ends with end_turn and no text, as an agent does when every model failed auth.
  const ctx = setup([{ delayMs: 20, replyText: "" }, { delayMs: 20, replyText: needsEvidence }]);
  const service = new BridgeService(ctx.config);
  try {
    const started = await service.startHandoff({ targetId: "codex", waitBudgetMs: 5_000, envelope: ctx.envelope });
    assert.equal(started.lifecycleStatus, "failed");
    assert.match(started.observed.verificationNotes?.join(" ") ?? "", /ended without a reply \(stopReason=end_turn\)/);

    const next = await service.continueHandoff({
      handoffId: started.handoffId,
      intent: "counter_evidence_or_followup",
      message: "The login is fixed. Please start again.",
      waitBudgetMs: 5_000,
    });
    assert.equal(next.turnNumber, 2);
    assert.equal(next.lifecycleStatus, "settled");
    assert.equal(next.reported?.disposition, "needs_evidence");
  } finally {
    await service.close();
    ctx.restoreEnv();
  }
});

test("ACP: an uncertain turn after a bridge restart can be closed with a reason and continued in the same session", async () => {
  // The first prompt is still running when the bridge process exits, so the next process cannot find it.
  const ctx = setup([{ delayMs: 60_000, replyText: "never delivered" }, { delayMs: 20, replyText: needsEvidence }]);
  const first = new BridgeService(ctx.config);
  const started = await first.startHandoff({ targetId: "codex", waitBudgetMs: 200, envelope: ctx.envelope });
  assert.equal(started.lifecycleStatus, "running");
  await first.close();

  const second = new BridgeService(ctx.config);
  try {
    const attached = await second.attachHandoff({ handoffId: started.handoffId, waitBudgetMs: 200 });
    assert.equal(attached.lifecycleStatus, "uncertain");

    await assert.rejects(
      second.continueHandoff({
        handoffId: started.handoffId,
        intent: "counter_evidence_or_followup",
        message: "Try again.",
        waitBudgetMs: 1_000,
      }),
      (err: unknown) => err instanceof BridgeError && err.code === "BUSY_ACTIVE_TURN",
    );
    await assert.rejects(
      second.reconcileUncertainTurn({ handoffId: started.handoffId, reason: "ok" }),
      (err: unknown) => err instanceof BridgeError && err.code === "INVALID_INPUT",
    );

    const closed = await second.reconcileUncertainTurn({
      handoffId: started.handoffId,
      reason: "Gateway log shows the run failed before any model replied; no repository change.",
    });
    assert.equal(closed.lifecycleStatus, "failed");
    assert.match(closed.observed.verificationNotes?.join(" ") ?? "", /Closed by the operator as failed/);

    const next = await second.continueHandoff({
      handoffId: started.handoffId,
      intent: "counter_evidence_or_followup",
      message: "Please start again.",
      waitBudgetMs: 5_000,
    });
    assert.equal(next.turnNumber, 2);
    assert.equal(next.remoteSessionKey, started.remoteSessionKey);
    assert.equal(next.lifecycleStatus, "settled");
  } finally {
    await second.close();
    ctx.restoreEnv();
  }
});

test("reconcile refuses an uncertain turn that authorized publication", async () => {
  const ctx = setup([{ delayMs: 60_000, replyText: "never delivered" }]);
  const first = new BridgeService(ctx.config);
  const started = await first.startHandoff({ targetId: "codex", waitBudgetMs: 200, envelope: ctx.envelope });
  await first.close();

  const db = new DatabaseSync(join(ctx.dataDir, "bridge-state.sqlite"));
  db.prepare("UPDATE handoff_turns SET kind = 'authorize_publish' WHERE handoff_id = ?").run(started.handoffId);
  db.close();

  const second = new BridgeService(ctx.config);
  try {
    await second.attachHandoff({ handoffId: started.handoffId, waitBudgetMs: 200 });
    await assert.rejects(
      second.reconcileUncertainTurn({
        handoffId: started.handoffId,
        reason: "Checked the chat; nothing seems to have happened.",
      }),
      (err: unknown) => err instanceof BridgeError && err.code === "PUBLISH_GATE_BLOCKED",
    );
  } finally {
    await second.close();
    ctx.restoreEnv();
  }
});

test("reconcile ignores a publication record older than the uncertain turn, and refuses one written during it", async () => {
  const ctx = setup([
    { delayMs: 60_000, replyText: "never delivered" },
    { delayMs: 60_000, replyText: "never delivered either" },
  ]);
  const first = new BridgeService(ctx.config);
  const older = await first.startHandoff({ targetId: "codex", waitBudgetMs: 200, envelope: ctx.envelope });
  const newer = await first.startHandoff({
    targetId: "codex",
    waitBudgetMs: 200,
    envelope: { ...ctx.envelope, requestId: `${ctx.envelope.requestId}-b` },
  });
  await first.close();

  // An earlier turn reported an existing pull request (stored as uncertain_in_flight) long before
  // the uncertain turn; on the other handoff the record changed after the turn went out.
  const db = new DatabaseSync(join(ctx.dataDir, "bridge-state.sqlite"));
  const setLedger = (handoffId: string, updatedAt: string) => {
    const res = db
      .prepare("UPDATE publication_ledger SET pr_state = 'uncertain_in_flight', updated_at = ? WHERE handoff_id = ?")
      .run(updatedAt, handoffId);
    if (res.changes === 0) {
      db.prepare(
        "INSERT INTO publication_ledger (handoff_id, repo_id, pr_state, updated_at) VALUES (?, 'example/app', 'uncertain_in_flight', ?)",
      ).run(handoffId, updatedAt);
    }
  };
  setLedger(older.handoffId, "2000-01-01T00:00:00.000Z");
  setLedger(newer.handoffId, "2999-01-01T00:00:00.000Z");
  db.close();

  const second = new BridgeService(ctx.config);
  try {
    const reason = "Gateway log shows the run failed before any model replied; no repository change.";
    const closed = await second.reconcileUncertainTurn({ handoffId: older.handoffId, reason });
    assert.equal(closed.lifecycleStatus, "failed");
    await assert.rejects(
      second.reconcileUncertainTurn({ handoffId: newer.handoffId, reason }),
      (err: unknown) => err instanceof BridgeError && err.code === "RECONCILIATION_UNCERTAIN",
    );
  } finally {
    await second.close();
    ctx.restoreEnv();
  }
});
