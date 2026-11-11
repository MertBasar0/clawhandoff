import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HandoffResultEnvelopeV2 } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

test("browser MCP resumes a lost send receipt and accepts counter-evidence in the original chat", async () => {
  const fixture = createTempGitFixture();
  const sessionUrl = "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f";
  const commit = fixture.commitFile("status.txt", "ready\n", "candidate");
  const configPath = join(fixture.rootDir, "bridge.json");
  const statePath = join(fixture.rootDir, "browser-state.json");
  // A separate question can use a label recognized by the English composer.
  writeFileSync(statePath, JSON.stringify({ sessionUrl, locale: "de", questionLabel: "Chat composer", messages: [], draft: "" }));
  writeFileSync(configPath, JSON.stringify({
    dataDir: fixture.rootDir,
    targets: { robo: {
      targetId: "robo", transport: "browser", agentId: "roboclaw", sessionUrl,
      browserMcp: { command: process.execPath, args: [resolve("test/helpers/browser-devtools.mjs"), statePath] },
    } },
  }));
  async function connect() {
    const client = new Client({ name: "browser-integration", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "--config", configPath] }));
    return client;
  }
  let client = await connect();
  async function invoke(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { ...args, waitBudgetMs: 0 } });
    const part = result.content as Array<{ type: string; text?: string }>;
    const content = part.find(p => p.type === "text")?.text;
    assert.ok(content);
    assert.ok(!result.isError, content);
    return JSON.parse(content) as HandoffResultEnvelopeV2;
  }
  try {
    const start = (requestId: string) => invoke("bridge_handoff_start", { targetId: "robo", envelope: {
      schemaVersion: "0.2", requestId, workspaceId: "test",
      title: "Verify the Linux run", outcome: "Check the pinned commit against the local smoke result.",
      mode: "verify_only", publisherOwner: "none",
      gitContext: { repoId: "example/status", localRepoPath: fixture.workRepoDir,
        pinnedBaseCommitSha: commit, pinnedSourceCommitSha: commit },
      requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
      acceptanceCriteria: ["Passing local runtime evidence"],
    } });
    const initial = await start("browser-resume");
    assert.equal(initial.lifecycleStatus, "uncertain");
    await client.close();
    client = await connect();
    const handoffId = initial.handoffId;
    const objection = await invoke("bridge_handoff_attach", { handoffId });
    assert.equal(objection.handoffId, handoffId);
    assert.equal(objection.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");
    assert.match(objection.reported?.summaryDelta ?? "", /missing receipt/i);
    const sourceRef = `receipt:${commit}:passed`;
    const final = await invoke("bridge_handoff_continue", { handoffId, intent: "counter_evidence_or_followup",
      message: "I ran the test against the exact commit.", evidenceRefs: [{ claim: "The local test passed.", sourceRef }] });
    assert.equal(final.handoffId, handoffId);
    assert.equal(final.turnNumber, 2);
    assert.equal(final.remoteSessionUrl, sessionUrl);
    assert.equal(final.observed.observedHeadSha, commit);
    assert.equal(final.orchestratorDirective.action, "COMPLETE");

    const state = JSON.parse(readFileSync(statePath, "utf8")) as { messages: Array<{role:string;text:string}> };
    const sent = state.messages.filter(message => message.role === "user");
    assert.equal(sent.length, 2);
    assert.ok(sent[1]?.text.includes(sourceRef));

    // An unrecoverable send must not strand this chat forever. Local-only abandonment
    // must work without attempting to stop or otherwise alter the browser session.
    writeFileSync(statePath, JSON.stringify({ ...state, loseNextClickWithoutReceipt: true }));
    const lost = await start("browser-unrecoverable");
    assert.equal(lost.lifecycleStatus, "uncertain");
    const beforeAbort = readFileSync(statePath, "utf8");
    const abort = (localOnly?: boolean) => client.callTool({
      name: "bridge_handoff_abort", arguments: { handoffId: lost.handoffId, ...(localOnly && { localOnly }) },
    });
    const normalAbort = await abort();
    assert.equal(normalAbort.isError, true);
    const localAbort = await abort(true);
    assert.ok(!localAbort.isError, JSON.stringify(localAbort.content));
    assert.equal(readFileSync(statePath, "utf8"), beforeAbort);

    // An active remote response in a non-EN/TR locale must block submission with BUSY_ACTIVE_TURN.
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(beforeAbort), remoteResponding: true }));
    const busyAttempt = await client.callTool({
      name: "bridge_handoff_start",
      arguments: { targetId: "robo", waitBudgetMs: 0, envelope: {
        schemaVersion: "0.2", requestId: "browser-busy-de", workspaceId: "test",
        title: "Verify busy guard", outcome: "Must refuse active chat.", mode: "verify_only", publisherOwner: "none",
        gitContext: { repoId: "example/status", localRepoPath: fixture.workRepoDir, pinnedBaseCommitSha: commit, pinnedSourceCommitSha: commit },
        requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
        acceptanceCriteria: ["Refuse active response"],
      } },
    });
    assert.equal(busyAttempt.isError, true);
    assert.match(JSON.stringify(busyAttempt.content), /BUSY_ACTIVE_TURN/);
    writeFileSync(statePath, beforeAbort);
    // Abort the unsent prepared turn so the next handoff can run cleanly.
    const dbRows = JSON.parse(JSON.stringify(busyAttempt.content)) as Array<{ text?: string }>;
    const unsentId = /attach to (hoff_[\w-]+)/.exec(dbRows[0]?.text ?? "")?.[1];
    assert.ok(unsentId);
    await client.callTool({ name: "bridge_handoff_abort", arguments: { handoffId: unsentId } });

    const released = await start("browser-after-abandonment");
    assert.equal(released.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");
  } finally {
    await client.close();
    fixture.cleanup();
  }
});

test("browser MCP survives OpenClaw auto-title slug replacement on 32-hex UUID session URLs", async () => {
  const fixture = createTempGitFixture();
  const initialUrl = "https://team.example/chat/roboclaw/clawhandoffantigravitysession-4f99c346fa5d4daea8d9ba738d8bae4d";
  const retitledUrl = "https://team.example/chat/roboclaw/distinguish-workflow-policy-refusal-4f99c346fa5d4daea8d9ba738d8bae4d";
  const commit = fixture.commitFile("status.txt", "ready\n", "candidate");
  const configPath = join(fixture.rootDir, "bridge.json");
  const statePath = join(fixture.rootDir, "browser-state.json");
  writeFileSync(statePath, JSON.stringify({ sessionUrl: initialUrl, messages: [], draft: "" }));
  writeFileSync(configPath, JSON.stringify({
    dataDir: fixture.rootDir,
    targets: { robo: {
      targetId: "robo", transport: "browser", agentId: "roboclaw", sessionUrl: initialUrl,
      browserMcp: { command: process.execPath, args: [resolve("test/helpers/browser-devtools.mjs"), statePath] },
    } },
  }));
  const client = new Client({ name: "browser-retitle", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "--config", configPath] }));
  async function invoke(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { ...args, waitBudgetMs: 0 } });
    const content = (result.content as Array<{ type: string; text?: string }>).find(p => p.type === "text")?.text;
    assert.ok(content);
    assert.ok(!result.isError, content);
    return JSON.parse(content) as HandoffResultEnvelopeV2;
  }
  try {
    const started = await invoke("bridge_handoff_start", { targetId: "robo", envelope: {
      schemaVersion: "0.2", requestId: "uuid-retitle-1", workspaceId: "test",
      title: "Verify auto-title slug replacement", outcome: "Attach and continue after Control UI replaces slug.",
      mode: "verify_only", publisherOwner: "none",
      gitContext: { repoId: "example/status", localRepoPath: fixture.workRepoDir, pinnedBaseCommitSha: commit, pinnedSourceCommitSha: commit },
      requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
      acceptanceCriteria: ["Passing local runtime evidence"],
    } });
    // Simulate OpenClaw Control UI history.replaceState after Turn 1 auto-title updates displayName.
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), sessionUrl: retitledUrl }));
    const attached = await invoke("bridge_handoff_attach", { handoffId: started.handoffId });
    assert.equal(attached.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");
    const completed = await invoke("bridge_handoff_continue", {
      handoffId: started.handoffId,
      intent: "counter_evidence_or_followup",
      message: "Local test passed.",
      evidenceRefs: [{ claim: "Verified on commit.", sourceRef: `receipt:${commit}:passed` }],
    });
    assert.equal(completed.orchestratorDirective.action, "COMPLETE");

    // A reconnect renumbers tabs. On the first list_pages the fresh ids are used directly; in the
    // middle of a read the bridge resolves the chat tab again and repeats the read once.
    const preflightAfter = async (reconnectBefore: Record<string, unknown>) => {
      writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), reconnectBefore }));
      return client.callTool({ name: "bridge_preflight", arguments: { targetId: "robo" } });
    };
    for (const tool of ["list_pages", "evaluate_script"]) {
      const preflightOk = await preflightAfter({ tool });
      assert.ok(!preflightOk.isError, JSON.stringify(preflightOk.content));
      assert.equal(JSON.parse((preflightOk.content as Array<{ text: string }>)[0]!.text).browserReady, true);
    }
    // It fails closed when the tab is no longer exactly one after the reconnect.
    const preflightDuplicate = await preflightAfter({ tool: "evaluate_script", duplicateTab: true });
    assert.equal(preflightDuplicate.isError, true);
    assert.match(JSON.stringify(preflightDuplicate.content), /\(browser_reconnected\)/);
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), duplicateTab: false }));

    // Between-tool-call preamble flicker (settled unlabelled bubble + momentary !busy) rides through
    // waitBudgetMs and settles cleanly on Bridge-Reply instead of aborting as uncertain.
    writeFileSync(
      statePath,
      JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), preambleFlickerStage: 2 }),
    );
    const flickerRes = await client.callTool({
      name: "bridge_handoff_start",
      arguments: {
        targetId: "robo",
        waitBudgetMs: 8_000,
        envelope: {
          schemaVersion: "0.2",
          requestId: "preamble-flicker-1",
          workspaceId: "test",
          title: "Survive between-tool-call preamble flicker",
          outcome: "Settle cleanly after preamble bubble and momentary !busy.",
          mode: "verify_only",
          publisherOwner: "none",
          gitContext: {
            repoId: "example/status",
            localRepoPath: fixture.workRepoDir,
            pinnedBaseCommitSha: commit,
            pinnedSourceCommitSha: commit,
          },
          requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
          priorEvidence: [{ claim: "Smoke passed", sourceRef: `receipt:${commit}:passed` }],
          acceptanceCriteria: ["Settles without false ESCALATE_TO_HUMAN"],
        },
      },
    });
    assert.ok(!flickerRes.isError, JSON.stringify(flickerRes.content));
    const flickerEnvelope = JSON.parse((flickerRes.content as Array<{ text: string }>)[0]!.text) as HandoffResultEnvelopeV2;
    assert.equal(flickerEnvelope.lifecycleStatus, "settled");
    assert.equal(flickerEnvelope.orchestratorDirective.action, "COMPLETE");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).preambleFlickerStage, 0);

    // Conversely, a genuinely finished reply that omits Bridge-Reply across confirmation polls still becomes uncertain.
    writeFileSync(
      statePath,
      JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), unlabelledFinalReply: true }),
    );
    const unlabelledRes = await client.callTool({
      name: "bridge_handoff_start",
      arguments: {
        targetId: "robo",
        waitBudgetMs: 5_000,
        envelope: {
          schemaVersion: "0.2",
          requestId: "unlabelled-final-1",
          workspaceId: "test",
          title: "Detect persistently unlabelled browser reply",
          outcome: "Surface uncertain when Bridge-Reply never arrives.",
          mode: "verify_only",
          publisherOwner: "none",
          gitContext: {
            repoId: "example/status",
            localRepoPath: fixture.workRepoDir,
            pinnedBaseCommitSha: commit,
            pinnedSourceCommitSha: commit,
          },
          requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
          priorEvidence: [{ claim: "Smoke passed", sourceRef: `receipt:${commit}:passed` }],
          acceptanceCriteria: ["Marks uncertain after confirmation window"],
        },
      },
    });
    assert.ok(!unlabelledRes.isError, JSON.stringify(unlabelledRes.content));
    const unlabelledEnvelope = JSON.parse((unlabelledRes.content as Array<{ text: string }>)[0]!.text) as HandoffResultEnvelopeV2;
    assert.equal(unlabelledEnvelope.lifecycleStatus, "uncertain");
    assert.equal(unlabelledEnvelope.orchestratorDirective.action, "ESCALATE_TO_HUMAN");
  } finally {
    await client.close();
    fixture.cleanup();
  }
});

test("browser MCP nudges a reply the chat could not complete, and the operator's Try again keeps the turn", async () => {
  const fixture = createTempGitFixture();
  const sessionUrl = "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f";
  const commit = fixture.commitFile("status.txt", "ready\n", "candidate");
  const configPath = join(fixture.rootDir, "bridge.json");
  const statePath = join(fixture.rootDir, "browser-state.json");
  writeFileSync(statePath, JSON.stringify({ sessionUrl, messages: [], draft: "", ackFirstClick: true, failNextTurn: true }));
  const target = (targetId: string, maxNudges: number) => ({
    targetId, transport: "browser", agentId: "roboclaw", sessionUrl, recovery: { maxNudges },
    browserMcp: { command: process.execPath, args: [resolve("test/helpers/browser-devtools.mjs"), statePath] },
  });
  writeFileSync(configPath, JSON.stringify({
    dataDir: fixture.rootDir,
    targets: { robo: target("robo", 2), manual: target("manual", 0) },
  }));
  const client = new Client({ name: "browser-recovery", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "--config", configPath] }));
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { ...args, waitBudgetMs: 0 } });
    const content = (result.content as Array<{ type: string; text?: string }>).find(p => p.type === "text")?.text;
    assert.ok(content);
    assert.ok(!result.isError, content);
    return JSON.parse(content) as HandoffResultEnvelopeV2;
  };
  const start = (targetId: string, requestId: string) => invoke("bridge_handoff_start", { targetId, envelope: {
    schemaVersion: "0.2", requestId, workspaceId: "test",
    title: "Verify the Linux run", outcome: "Check the pinned commit against the local smoke result.",
    mode: "verify_only", publisherOwner: "none",
    gitContext: { repoId: "example/status", localRepoPath: fixture.workRepoDir,
      pinnedBaseCommitSha: commit, pinnedSourceCommitSha: commit },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["Passing local runtime evidence"],
  } });
  const readState = () => JSON.parse(readFileSync(statePath, "utf8")) as {
    messages: Array<{ role: string; text: string }>; nudgeClicks?: number; clicks?: number;
  };
  try {
    const nudged = await start("robo", "browser-nudged");
    assert.equal(nudged.lifecycleStatus, "settled");
    assert.match(nudged.reported?.summaryDelta ?? "", /resumed after a failed reply/i);
    assert.equal(readState().nudgeClicks, 1);
    assert.equal(readState().clicks, 1);

    // Without nudges the bridge stops and names the failure instead of waiting forever.
    writeFileSync(statePath, JSON.stringify({ ...readState(), failNextTurn: true }));
    const stopped = await start("manual", "browser-manual");
    assert.equal(stopped.lifecycleStatus, "uncertain");
    assert.match(JSON.stringify(stopped), /could not be completed/);
    assert.equal(readState().nudgeClicks, 1);

    // The operator presses "Try again": the Control UI sends its own continuation and Robo finishes.
    const state = readState();
    const key = /Bridge-Turn: (idem_[\w-]+)/.exec(state.messages.at(-2)?.text ?? "")?.[1];
    assert.ok(key);
    state.messages.push({ role: "user", text: "Continue from where you stopped." }, { role: "assistant",
      text: `Bridge-Reply: ${key}\n\n\`\`\`handoff-result\n${JSON.stringify({ disposition: "needs_evidence", summaryDelta: "Finished after Try again.", blockers: ["Missing receipt"] })}\n\`\`\`` });
    writeFileSync(statePath, JSON.stringify(state));
    const recovered = await invoke("bridge_handoff_attach", { handoffId: stopped.handoffId });
    assert.equal(recovered.lifecycleStatus, "settled");
    assert.match(recovered.reported?.summaryDelta ?? "", /after try again/i);
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
