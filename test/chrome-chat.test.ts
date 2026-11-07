import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { BridgeService } from "../src/bridge-service.js";
import { ChromeChat, chromeReplyFailure, chromeThrownFailure } from "../src/chrome-chat.js";
import { BridgeError } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

const sessionUrl = "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f";
const devtools = resolve("test/helpers/browser-devtools.mjs");
// The fixture plants these in every raw failure, as a real reply can describe other tabs.
const PRIVATE = /private\.example|Private Title|secret-dir/;
const prompt = "Bridge-Turn: idem_chrome-chat-1\n\nCheck the pinned commit.";

interface FixtureState {
  pageId?: number;
  draft: string;
  fills?: number;
  clicks?: number;
  messages: Array<{ role: string; text: string }>;
}

function openChat(t: TestContext, initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clawhandoff-chrome-"));
  const statePath = join(dir, "browser-state.json");
  const fresh = { sessionUrl, messages: [], draft: "", ackFirstClick: true };
  writeFileSync(statePath, JSON.stringify({ ...fresh, ...initial }));
  const chat = new ChromeChat({ command: process.execPath, args: [devtools, statePath], sessionUrl });
  t.after(async () => {
    await chat.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as FixtureState;
  const update = (patch: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...state(), ...patch }));
  const reset = (patch: Record<string, unknown> = {}) => update({ ...fresh, fills: 0, clicks: 0, ...patch });
  return { chat, dir, state, update, reset };
}

async function rejectsWithCause(promise: Promise<unknown>, cause: string, remediation?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BridgeError, String(error));
    assert.equal(error.code, "TARGET_UNAVAILABLE");
    assert.match(error.message, new RegExp(`\\(${cause}\\)`));
    if (remediation) assert.match(error.remediation ?? "", remediation);
    assert.doesNotMatch(`${error.message} ${error.remediation}`, PRIVATE);
    return true;
  });
}

test("Chrome DevTools MCP failures name a safe cause and never repeat raw tool output", async (t) => {
  const text = (value: string) => [{ type: "text", text: value }];
  const secret = "Cause: https://private.example/inbox (Private Title)";
  assert.equal(chromeReplyFailure({ isError: true, content: text(`Tool "list_pages" timed out after 60000ms waiting for the browser connection to be established.\n${secret}`) }), "browser_connect_timeout");
  assert.equal(chromeReplyFailure({ isError: true, content: text("Connection attempt was abandoned before it completed.") }), "browser_connect_timeout");
  assert.equal(chromeReplyFailure({ isError: true, content: text(`Could not connect to Chrome. Check if Chrome is running.\n${secret}`) }), "browser_connect_failed");
  assert.equal(chromeReplyFailure({ isError: true, content: text("Error: No page found"), structuredContent: { errorMessage: "No page found" } }), "page_closed");
  assert.equal(chromeReplyFailure({ isError: true, content: text("Error"), structuredContent: { reconnected: true, errorMessage: "x" } }), "browser_reconnected");
  assert.equal(chromeReplyFailure({ isError: true, content: text(secret), structuredContent: { errorMessage: secret } }), "tool_error");
  assert.equal(chromeReplyFailure({ content: text(secret) }), "missing_structured_content");
  assert.equal(chromeThrownFailure(new McpError(ErrorCode.RequestTimeout, "Request timed out")), "mcp_request_timeout");
  assert.equal(chromeThrownFailure(new McpError(ErrorCode.ConnectionClosed, "Connection closed")), "mcp_transport_closed");
  assert.equal(chromeThrownFailure(new Error("Not connected")), "mcp_transport_closed");
  assert.equal(chromeThrownFailure(new Error(secret)), "tool_error");

  const { chat, update } = openChat(t);
  await chat.read();
  const cases: Array<[kind: string, cause: string, remediation: RegExp]> = [
    ["connect_timeout", "browser_connect_timeout", /responsive/],
    ["connect_failed", "browser_connect_failed", /chrome:\/\/inspect\/#remote-debugging/],
    ["tool_error", "tool_error", /attachment permission/],
    ["unstructured", "missing_structured_content", /--experimentalStructuredContent/],
    // The process exits mid-call; the next call starts a new one.
    ["exit", "mcp_transport_closed", /restarts/],
  ];
  for (const [kind, cause, remediation] of cases) {
    for (const tool of ["list_pages", "evaluate_script"]) {
      update({ failNext: { tool, kind } });
      await rejectsWithCause(chat.read(), cause, remediation);
      // The failure was transient; the same chat recovers on the next call.
      assert.equal(JSON.parse(await chat.read()).ready, true);
    }
  }
});

test("Chrome DevTools MCP startup failures name a safe cause", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clawhandoff-chrome-start-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = async (command: string, state?: Record<string, unknown>) => {
    const statePath = join(dir, `state-${Math.random().toString(36).slice(2)}.json`);
    if (state) writeFileSync(statePath, JSON.stringify({ sessionUrl, messages: [], draft: "", ...state }));
    const chat = new ChromeChat({ command, args: [devtools, statePath], sessionUrl });
    try {
      return await chat.read();
    } finally {
      await chat.close();
    }
  };
  await rejectsWithCause(start(join(dir, "missing-chrome-devtools-mcp")), "mcp_start_failed", /run on its own/);
  await rejectsWithCause(start(process.execPath, { exitOnStartup: "Unexpected failure in C:\\secret-dir\\x" }), "mcp_start_failed");
  await rejectsWithCause(
    start(process.execPath, { exitOnStartup: "Error when opening/writing to log file: EACCES: permission denied, open 'C:\\secret-dir\\robo.log'" }),
    "mcp_log_file_failed", /--logFile/);
  await rejectsWithCause(start(process.execPath, { noPageIds: true }), "mcp_unsupported", /--slim/);
});

test("a browser reconnect resolves the chat tab again and repeats a read once", async (t) => {
  const { chat, state, update } = openChat(t);
  update({ reconnectBefore: { tool: "evaluate_script" } });
  assert.equal(JSON.parse(await chat.read()).ready, true);
  assert.equal(state().pageId, 107);

  // A second reconnect during the repeat, or a tab that is no longer unique, fails closed.
  update({ reconnectBefore: { tool: "evaluate_script", count: 2 } });
  await rejectsWithCause(chat.read(), "browser_reconnected", /exactly one tab/);
  update({ reconnectBefore: { tool: "evaluate_script", duplicateTab: true } });
  await rejectsWithCause(chat.read(), "browser_reconnected", /exactly one tab/);
});

test("a send interrupted by a reconnect repeats only freshly inspected steps and acts once", async (t) => {
  const { chat, state, reset } = openChat(t);
  // Every call of a send, in order: resolve, inspect, confirm, claim, fill, inspect, confirm, click.
  const points = [
    { tool: "list_pages" }, { tool: "evaluate_script" }, { tool: "take_snapshot" }, { tool: "list_pages", skip: 1 },
    { tool: "fill" }, { tool: "evaluate_script", skip: 1 }, { tool: "take_snapshot", skip: 1 },
    { tool: "list_pages", skip: 2 }, { tool: "click" },
  ];
  for (const reconnectBefore of points) {
    const before = state().pageId ?? 7;
    reset({ reconnectBefore });
    let claims = 0;
    await chat.send(prompt, () => ++claims === 1);
    const after = state();
    const label = JSON.stringify(reconnectBefore);
    assert.equal(after.pageId, before + 100, label);
    assert.equal(claims, 1, label);
    assert.equal(after.fills, 1, label);
    assert.equal(after.clicks, 1, label);
    assert.equal(after.draft, "", label);
    assert.deepEqual(after.messages.filter((message) => message.role === "user").map((message) => message.text), [prompt], label);
  }

  // After the claim, a composer that changed while the connection was down stops the send.
  reset({ reconnectBefore: { tool: "fill", draft: "typed by the user" } });
  await assert.rejects(chat.send(prompt, () => true), (error: unknown) =>
    error instanceof BridgeError && error.code === "RECONCILIATION_UNCERTAIN");
  assert.equal(state().fills, 0);
  reset({ reconnectBefore: { tool: "click", draft: "typed by the user" } });
  await assert.rejects(chat.send(prompt, () => true), (error: unknown) =>
    error instanceof BridgeError && error.code === "RECONCILIATION_UNCERTAIN");
  assert.equal(state().clicks, 0);
  assert.equal(state().messages.length, 0);

  // An action whose reply reports a reconnect may have run, so it is never repeated.
  reset({ reconnectedAfterNextAction: "fill" });
  await rejectsWithCause(chat.send(prompt, () => true), "browser_reconnected");
  assert.deepEqual([state().fills, state().clicks], [1, 0]);
  reset({ reconnectedAfterNextAction: "click" });
  await rejectsWithCause(chat.send(prompt, () => true), "browser_reconnected");
  assert.deepEqual([state().fills, state().clicks, state().messages.length], [1, 1, 2]);
});

test("a classified browser failure reaches the handoff without tab details", async (t) => {
  const fixture = createTempGitFixture();
  const commit = fixture.commitFile("status.txt", "ready\n", "candidate");
  const statePath = join(fixture.rootDir, "browser-state.json");
  writeFileSync(statePath, JSON.stringify({ sessionUrl, messages: [], draft: "", ackFirstClick: true }));
  const service = new BridgeService({
    dataDir: fixture.rootDir,
    targets: { robo: {
      targetId: "robo", transport: "browser", agentId: "roboclaw", sessionUrl,
      browserMcp: { command: process.execPath, args: [devtools, statePath] },
    } },
  });
  t.after(async () => {
    await service.close();
    fixture.cleanup();
  });
  const update = (patch: Record<string, unknown>) =>
    writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...patch }));
  const start = (requestId: string) => service.startHandoff({ targetId: "robo", waitBudgetMs: 0, envelope: {
    schemaVersion: "0.2", requestId, workspaceId: "test",
    title: "Verify the Linux run", outcome: "Check the pinned commit.", mode: "verify_only", publisherOwner: "none",
    gitContext: { repoId: "example/status", localRepoPath: fixture.workRepoDir, pinnedBaseCommitSha: commit, pinnedSourceCommitSha: commit },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["Passing local runtime evidence"],
  } });

  // Before the claim nothing was sent: the caller gets the cause, its remedy and the handoff to attach to.
  update({ failNext: { tool: "list_pages", kind: "connect_failed" } });
  let unsent: string | undefined;
  await assert.rejects(start("chrome-before-claim"), (error: unknown) => {
    assert.ok(error instanceof BridgeError);
    assert.match(error.message, /\(browser_connect_failed\)/);
    assert.match(error.remediation ?? "", /chrome:\/\/inspect\/#remote-debugging.* attach to hoff_/);
    assert.doesNotMatch(`${error.message} ${error.remediation}`, PRIVATE);
    unsent = /attach to (hoff_[\w-]+)/.exec(error.remediation ?? "")?.[1];
    return true;
  });
  assert.ok(unsent);
  // The chat takes one unfinished handoff at a time.
  await service.abortHandoff({ handoffId: unsent });

  // After the claim the turn is uncertain, and its recorded error names the cause.
  update({ failNext: { tool: "click", kind: "connect_timeout" } });
  const uncertain = await start("chrome-after-claim");
  assert.equal(uncertain.lifecycleStatus, "uncertain");
  const notes = (uncertain.observed.verificationNotes ?? []).join("\n");
  assert.match(notes, /Chrome DevTools MCP could not complete click \(browser_connect_timeout\)/);
  assert.match(notes, /responsive/);
  assert.doesNotMatch(notes, PRIVATE);
});
