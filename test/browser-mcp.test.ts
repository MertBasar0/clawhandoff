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
  const sessionUrl = "https://team.example/chat/roboclaw/verify-linux-00112233445566778899aabbccddeeff";
  const commit = fixture.commitFile("status.txt", "ready\n", "candidate");
  const configPath = join(fixture.rootDir, "bridge.json");
  const statePath = join(fixture.rootDir, "browser-state.json");
  writeFileSync(statePath, JSON.stringify({ sessionUrl, messages: [], draft: "" }));
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
    const released = await start("browser-after-abandonment");
    assert.equal(released.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
