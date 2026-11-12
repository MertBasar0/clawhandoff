import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeService } from "../src/bridge-service.js";
import {
  BROWSER_RECOVERY_DEFAULTS,
  browserRecoveryLimits,
  decideBrowserRecovery,
  noteHealthy,
  noteReload,
  noteUnhealthy,
  type BrowserRecoveryLimits,
} from "../src/browser-health.js";
import { browserTranscriptScript, inspectBrowserTurn } from "../src/browser-turn.js";
import { BrowserNotReady, ChromeChat, isBridgeDraft } from "../src/chrome-chat.js";
import { BridgeError, type HandoffResultEnvelopeV2 } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

const sessionUrl = "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f";
const devtools = resolve("test/helpers/browser-devtools.mjs");
const fakeGh = resolve("test/helpers/fake-gh-cli.mjs");
const PRIVATE = /private\.example|Private Title/;

// ---------------------------------------------------------------------------------------------
// Recovery decisions

const limits: BrowserRecoveryLimits = {
  ...BROWSER_RECOVERY_DEFAULTS, settleGraceMs: 1_000, reloadSettleMs: 5_000, maxReloads: 2,
};

test("a chat that is loading or reconnecting gets a grace period, then bounded reloads, then a person", () => {
  let state = noteUnhealthy(noteHealthy(), 0);
  assert.deepEqual(decideBrowserRecovery(state, "loading", 500, limits), { kind: "wait", condition: "chat_loading" });
  assert.deepEqual(decideBrowserRecovery(state, "disconnected", 500, limits), { kind: "wait", condition: "chat_disconnected" });
  assert.deepEqual(decideBrowserRecovery(state, "disconnected", 1_000, limits), { kind: "reload", reopen: false });

  state = noteReload(state, "reloaded", 1_000);
  // A reload gets time to bring the chat back before it counts as failed.
  assert.deepEqual(decideBrowserRecovery(state, "disconnected", 3_000, limits), { kind: "wait", condition: "chat_disconnected" });
  assert.deepEqual(decideBrowserRecovery(state, "loading", 6_000, limits), { kind: "reload", reopen: false });
  state = noteReload(state, "reloaded", 6_000);
  assert.equal(state.reloads, 2);
  assert.deepEqual(decideBrowserRecovery(state, "loading", 10_000, limits), { kind: "wait", condition: "chat_loading" });
  assert.deepEqual(decideBrowserRecovery(state, "loading", 11_000, limits), { kind: "give_up", condition: "chat_unreachable" });

  // One ready read ends the episode.
  assert.deepEqual(noteHealthy(), { reloads: 0 });
});

test("Chrome's own network failures go to a person, and a missing tab is reopened at once", () => {
  const fresh = noteUnhealthy(noteHealthy(), 0);
  assert.deepEqual(decideBrowserRecovery(fresh, "missing", 0, limits), { kind: "reload", reopen: true });
  assert.deepEqual(decideBrowserRecovery(fresh, "error_page", 0, limits), { kind: "reload", reopen: false });
  assert.deepEqual(decideBrowserRecovery(fresh, "wrong_url", 0, limits), { kind: "give_up", condition: "chat_unreachable" });
  // A short network drop recovers by itself; a lasting one needs Chrome restarted.
  assert.deepEqual(decideBrowserRecovery(fresh, "offline", 500, limits), { kind: "wait", condition: "chat_disconnected" });
  assert.deepEqual(decideBrowserRecovery(fresh, "offline", 1_000, limits), { kind: "give_up", condition: "browser_offline" });
  // A reload that failed with net::ERR_* is not tried again.
  const failed = noteReload(fresh, "offline", 0);
  assert.equal(failed.networkFailure, true);
  assert.deepEqual(decideBrowserRecovery(failed, "error_page", 0, limits), { kind: "give_up", condition: "browser_offline" });
  // Reloads that only ever show Chrome's error page mean Chrome cannot load pages.
  const exhausted = noteReload(noteReload(fresh, "reloaded", 0), "reloaded", 0);
  assert.deepEqual(decideBrowserRecovery(exhausted, "error_page", 60_000, limits), { kind: "give_up", condition: "browser_offline" });
});

test("recovery limits are named constants that the environment can override", () => {
  assert.deepEqual(browserRecoveryLimits({}), BROWSER_RECOVERY_DEFAULTS);
  const tuned = browserRecoveryLimits({
    CLAWHANDOFF_BROWSER_MAX_RELOADS: "5",
    CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS: "2500",
    CLAWHANDOFF_BROWSER_RELOAD_SETTLE_MS: "not a number",
    CLAWHANDOFF_BROWSER_POLL_MS: "-1",
  });
  assert.equal(tuned.maxReloads, 5);
  assert.equal(tuned.settleGraceMs, 2_500);
  assert.equal(tuned.reloadSettleMs, BROWSER_RECOVERY_DEFAULTS.reloadSettleMs);
  assert.equal(tuned.pollMs, BROWSER_RECOVERY_DEFAULTS.pollMs);
});

// ---------------------------------------------------------------------------------------------
// The page's own projection

const key = "idem_recovery-1";
type Projection = { ready: boolean; busy: boolean; health: string; draft?: string; messages: unknown[] };

function project(opts: {
  href?: string; protocol?: string; draft?: string; connection?: boolean; splash?: boolean;
  sendHeld?: boolean; sending?: boolean; online?: boolean;
} = {}): Projection {
  const run = new Function("location", "document", "navigator",
    `return (${browserTranscriptScript})(${JSON.stringify(sessionUrl)}, ${JSON.stringify(key)})`,
  ) as (loc: unknown, doc: unknown, nav: unknown) => Projection;
  const shown = { closest: () => null };
  const composer = {
    value: opts.draft ?? "",
    getAttribute: (n: string) => ({ "aria-label": "Chat composer", "aria-autocomplete": "list" } as Record<string, string>)[n] ?? null,
    closest: (sel: string) => sel === ".agent-chat__input--chat" ? {} : null,
  };
  const sendBtn = {
    textContent: "Send",
    classList: { contains: (c: string) => c === "chat-send-btn--sending" && Boolean(opts.sending) },
    getAttribute: (n: string) => n === "aria-label" ? (opts.sendHeld ? "Loading chat…" : "Send message")
      : n === "aria-busy" ? String(Boolean(opts.sendHeld || opts.sending)) : null,
    closest: () => null,
  };
  const userGroup = { classList: { contains: (c: string) => c === "user" }, matches: () => false, hasAttribute: () => false, querySelector: () => null };
  const request = {
    parentElement: { closest: () => null },
    classList: { contains: () => false },
    closest: (sel: string) => sel === ".chat-group" ? userGroup : null,
    getAttribute: (n: string) => n === "data-message-text" ? `Bridge-Turn: ${key}\n\nWork.` : n === "data-message-id" ? "u1" : null,
    querySelector: () => null,
  };
  const scope = {
    getElementsByTagName: (tag: string) => tag === "textarea" ? [composer] : [],
    querySelector: (sel: string) => {
      if (sel.includes("chat-send-btn--send") && !sel.includes("sending")) return sendBtn;
      if (sel.includes("chat-send-btn--sending") && opts.sending) return sendBtn;
      if (sel === ".chat-pane__connection") return opts.connection ? shown : null;
      return null;
    },
  };
  const thread = { classList: { contains: () => false }, closest: (sel: string) => sel === "main" ? scope : null, querySelectorAll: () => [request] };
  const document = {
    querySelectorAll: () => [thread],
    querySelector: (sel: string) => sel === ".gateway-connection-view" && opts.splash ? shown : null,
  };
  return run({ href: opts.href ?? sessionUrl, protocol: opts.protocol ?? "https:" }, document, { onLine: opts.online ?? true });
}

test("the page reports why a chat is not ready, and a saved transcript is never read as progress", () => {
  const ready = project();
  assert.equal(ready.health, "ready");
  assert.equal(ready.ready, true);
  assert.equal(ready.messages.length, 1);

  // "Bağlanıyor… · Kaydedilmiş konuşma": a saved transcript while the Gateway reconnects.
  const saved = project({ connection: true });
  assert.equal(saved.health, "disconnected");
  assert.equal(saved.ready, false);
  assert.deepEqual(saved.messages, []);
  assert.equal(inspectBrowserTurn(JSON.stringify(saved), key, true).state, "uncertain");

  // "Sohbet yükleniyor…": the send control holds while the chat loads.
  assert.equal(project({ sendHeld: true }).health, "loading");
  // A message that is being sent is not a loading chat.
  const sending = project({ sending: true });
  assert.equal(sending.health, "ready");
  assert.equal(sending.busy, true);

  assert.equal(project({ splash: true }).health, "disconnected");
  assert.equal(project({ online: false }).health, "offline");
  assert.equal(project({ href: "chrome-error://chromewebdata/", protocol: "chrome-error:" }).health, "error_page");
  assert.equal(project({ href: "https://team.example/chat/other" }).health, "wrong_url");
});

test("the page classifies the draft without exporting it", () => {
  assert.equal(project().draft, "empty");
  assert.equal(project({ draft: `Bridge-Turn: ${key}\n\nWork.` }).draft, "request");
  assert.equal(project({ draft: `Bridge-Nudge: ${key}\n\nContinue.` }).draft, "nudge");
  assert.equal(project({ draft: "Bridge-Nudge: idem_older\n\nContinue." }).draft, "bridge_other");
  assert.equal(project({ draft: "My own notes" }).draft, "text");
  // The draft is still known while the chat reconnects, so an unsent request is never lost.
  assert.equal(project({ connection: true, draft: `Bridge-Turn: ${key}\n\nWork.` }).draft, "request");
  const exported = JSON.stringify(project({ draft: "My own notes" }));
  assert.doesNotMatch(exported, /My own notes/);

  assert.equal(isBridgeDraft("Bridge-Turn: idem_a-1\n\nx"), true);
  assert.equal(isBridgeDraft("Bridge-Reply: idem_a-1"), false);
  assert.equal(isBridgeDraft("Note: Bridge-Turn: idem_a-1"), false);
});

// ---------------------------------------------------------------------------------------------
// The chat tab, through the Chrome DevTools MCP fixture

interface ChatState {
  draft: string;
  fills?: number;
  clears?: number;
  clicks?: number;
  clicksWhileNotReady?: number;
  swallowedClicks?: number;
  nudgeClicks?: number;
  nudgeTexts?: string[];
  reloads?: number;
  reopens?: number;
  messages: Array<{ role: string; text: string }>;
}

function chatFixture(t: TestContext, initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clawhandoff-recovery-"));
  const statePath = join(dir, "browser-state.json");
  writeFileSync(statePath, JSON.stringify({ sessionUrl, messages: [], draft: "", ackFirstClick: true, ...initial }));
  const chat = new ChromeChat({ command: process.execPath, args: [devtools, statePath], sessionUrl });
  t.after(async () => {
    await chat.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as ChatState;
  return { chat, state };
}

const prompt = `Bridge-Turn: ${key}\n\nCheck the pinned commit.`;

test("a stale bridge draft is cleared before typing, and the operator's own draft is never touched", async (t) => {
  const stale = chatFixture(t, { draft: "Bridge-Nudge: idem_older\n\nContinue." });
  assert.equal(await stale.chat.send(prompt, () => true), "sent");
  assert.equal(stale.state().clears, 1);
  assert.equal(stale.state().fills, 1);
  assert.equal(stale.state().clicks, 1);

  const own = chatFixture(t, { draft: "My own notes" });
  let claimed = false;
  await assert.rejects(own.chat.send(prompt, () => (claimed = true)),
    (error: unknown) => error instanceof BridgeError && error.code === "BUSY_ACTIVE_TURN");
  assert.equal(claimed, false);
  assert.equal(own.state().draft, "My own notes");
  assert.equal(own.state().clears ?? 0, 0);
});

test("nothing is typed into a chat that is not ready, and a chat that starts loading after typing keeps the draft", async (t) => {
  const loading = chatFixture(t, { health: "loading" });
  let claimed = false;
  await assert.rejects(loading.chat.send(prompt, () => (claimed = true)),
    (error: unknown) => error instanceof BrowserNotReady && error.health === "loading");
  assert.equal(claimed, false);
  assert.equal(loading.state().fills ?? 0, 0);

  const later = chatFixture(t, { healthAfterFill: "loading" });
  assert.equal(await later.chat.send(prompt, () => true), "typed");
  assert.equal(later.state().draft, prompt);
  assert.equal(later.state().clicks ?? 0, 0);
  assert.equal(later.state().clicksWhileNotReady ?? 0, 0);
  const view = await later.chat.observe(key);
  assert.equal(view.health, "loading");
  assert.equal(view.draft, "request");
  assert.equal(view.transcript, undefined);
});

// ---------------------------------------------------------------------------------------------
// Handoffs: the three failures of 2026-11-12

const testLimits = {
  CLAWHANDOFF_BROWSER_POLL_MS: "20",
  CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS: "0",
  CLAWHANDOFF_BROWSER_RELOAD_SETTLE_MS: "0",
  CLAWHANDOFF_BROWSER_MAX_RELOADS: "2",
  CLAWHANDOFF_BROWSER_UNSENT_CONFIRM_MS: "60000",
  CLAWHANDOFF_PUBLISH_CHECK_INTERVAL_MS: "0",
};

function withEnv(t: TestContext, vars: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function browserBridge(
  t: TestContext,
  initial: Record<string, unknown> = {},
  opts: { env?: Record<string, string>; recovery?: Record<string, number>; gh?: Record<string, unknown> } = {},
) {
  const fixture = createTempGitFixture();
  const statePath = join(fixture.rootDir, "browser-state.json");
  const ghPath = join(fixture.rootDir, "gh-state.json");
  writeFileSync(statePath, JSON.stringify({ sessionUrl, messages: [], draft: "", ackFirstClick: true, ...initial }));
  writeFileSync(ghPath, JSON.stringify(opts.gh ?? {}));
  withEnv(t, { ...testLimits, ...opts.env, FAKE_GATEWAY_STATE_FILE: ghPath });
  const service = new BridgeService({
    dataDir: fixture.rootDir,
    ghCliPath: fakeGh,
    targets: { robo: {
      targetId: "robo", transport: "browser", agentId: "roboclaw", sessionUrl,
      browserMcp: { command: process.execPath, args: [devtools, statePath] },
      ...(opts.recovery ? { recovery: opts.recovery } : {}),
    } },
  });
  t.after(async () => {
    await service.close();
    fixture.cleanup();
  });
  const state = () => JSON.parse(readFileSync(statePath, "utf8")) as ChatState;
  const update = (patch: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...state(), ...patch }));
  const gh = (patch: Record<string, unknown>) =>
    writeFileSync(ghPath, JSON.stringify({ ...JSON.parse(readFileSync(ghPath, "utf8")), ...patch }));
  const commit = fixture.commitFile("status.txt", "ready\n", "candidate");
  const start = () => service.startHandoff({ targetId: "robo", waitBudgetMs: 0, envelope: {
    schemaVersion: "0.2", requestId: `recovery-${Math.random()}`, workspaceId: "test",
    title: "Verify the Linux run", outcome: "Check the pinned commit against the local smoke result.",
    mode: "verify_only", publisherOwner: "none",
    gitContext: { repoId: "example/status", localRepoPath: fixture.workRepoDir, pinnedBaseCommitSha: commit, pinnedSourceCommitSha: commit },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["Passing local runtime evidence"],
  } });
  const attach = (handoffId: string, waitBudgetMs = 0) => service.attachHandoff({ handoffId, waitBudgetMs });
  return { service, fixture, state, update, gh, start, attach };
}

const directive = (result: HandoffResultEnvelopeV2) => result.orchestratorDirective;

test("failure 1: a request typed while the chat loads is sent exactly once, after the chat is ready", async (t) => {
  // A long grace keeps the bridge from reloading, as the Control UI finishes loading by itself.
  const b = browserBridge(t, { healthAfterFill: "loading" }, { env: { CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS: "600000" } });
  const typed = await b.start();
  assert.equal(directive(typed).action, "POLL_ATTACH");
  assert.equal(directive(typed).condition, "request_typed_unsent");
  assert.match(directive(typed).reason, /presses send once/);
  assert.equal(b.state().fills, 1);
  assert.equal(b.state().clicks ?? 0, 0);
  assert.equal(b.state().clicksWhileNotReady ?? 0, 0);

  const loading = await b.attach(typed.handoffId);
  assert.equal(directive(loading).action, "POLL_ATTACH");
  assert.equal(directive(loading).condition, "chat_loading");
  assert.equal(b.state().reloads ?? 0, 0);

  b.update({ health: "ready" });
  const done = await b.attach(typed.handoffId);
  assert.equal(done.lifecycleStatus, "settled");
  assert.equal(b.state().clicks, 1);
  assert.equal(b.state().fills, 1);
  await b.attach(typed.handoffId);
  assert.equal(b.state().clicks, 1);
});

test("failure 1: a request the operator already sent by hand is never sent again", async (t) => {
  const b = browserBridge(t, { healthAfterFill: "loading" }, { env: { CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS: "600000" } });
  const typed = await b.start();
  const draft = b.state().draft;
  // The transcript now has the request. The composer still shows it, which must not matter.
  b.update({ health: "ready", messages: [{ role: "user", text: draft }] });
  const running = await b.attach(typed.handoffId);
  assert.equal(running.lifecycleStatus, "running");
  assert.equal(directive(running).action, "POLL_ATTACH");
  assert.equal(b.state().clicks ?? 0, 0);
  assert.equal(b.state().swallowedClicks ?? 0, 0);
});

test("failure 1: the bridge presses send for a typed request at most once, across attaches", async (t) => {
  const b = browserBridge(t, { healthAfterFill: "loading" }, { env: { CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS: "600000" } });
  const typed = await b.start();
  b.update({ health: "ready", swallowClicks: 5 });
  const stuck = await b.attach(typed.handoffId);
  assert.equal(stuck.lifecycleStatus, "uncertain");
  assert.equal(directive(stuck).action, "ESCALATE_TO_HUMAN");
  assert.match((stuck.observed.verificationNotes ?? []).join(" "), /already pressed send once/);
  await b.attach(typed.handoffId);
  assert.equal(b.state().swallowedClicks, 1);
});

test("failure 2: a disconnected chat is reloaded within bounds and never nudged; quiet time restarts after it returns", async (t) => {
  const b = browserBridge(t, { silentRobo: true }, { recovery: { idleStallMs: 150, maxNudges: 2 } });
  const started = await b.start();
  assert.equal(started.lifecycleStatus, "running");

  // "Bağlanıyor… · Kaydedilmiş konuşma" for longer than the idle stall limit.
  b.update({ health: "disconnected" });
  await delay(200);
  const first = await b.attach(started.handoffId);
  assert.equal(first.lifecycleStatus, "running");
  assert.equal(directive(first).action, "POLL_ATTACH");
  assert.equal(directive(first).condition, "chat_disconnected");
  assert.match(directive(first).reason, /not yet observed, not as Robo stopping/);
  assert.equal(b.state().reloads, 1);
  await b.attach(started.handoffId);
  assert.equal(b.state().reloads, 2);
  const unreachable = await b.attach(started.handoffId);
  assert.equal(directive(unreachable).action, "RESTORE_BROWSER");
  assert.equal(directive(unreachable).condition, "chat_unreachable");
  assert.match(directive(unreachable).reason, /after 2 reload\(s\).*nothing is resent/);
  assert.equal(unreachable.lifecycleStatus, "running");
  assert.equal(b.state().reloads, 2);
  assert.equal(b.state().nudgeClicks ?? 0, 0);
  assert.equal(b.state().fills, 1);

  // The chat returns. The time it spent disconnected does not count as Robo being quiet.
  b.update({ health: "ready", silentRobo: false });
  const back = await b.attach(started.handoffId);
  assert.equal(directive(back).action, "POLL_ATTACH");
  assert.equal(directive(back).condition, undefined);
  assert.equal(b.state().nudgeClicks ?? 0, 0);
  await delay(200);
  const resumed = await b.attach(started.handoffId);
  assert.equal(resumed.lifecycleStatus, "settled");
  assert.equal(b.state().nudgeClicks, 1);
});

test("a chat that reconnects by itself within the grace period is not reloaded", async (t) => {
  const b = browserBridge(t, { silentRobo: true }, { env: { CLAWHANDOFF_BROWSER_SETTLE_GRACE_MS: "600000" } });
  const started = await b.start();
  b.update({ health: "disconnected", recoverAfterReads: 3 });
  const back = await b.attach(started.handoffId, 2_000);
  assert.equal(back.lifecycleStatus, "running");
  assert.equal(directive(back).condition, undefined);
  assert.equal(b.state().reloads ?? 0, 0);
});

test("a closed chat tab is reopened", async (t) => {
  const b = browserBridge(t, { silentRobo: true });
  const started = await b.start();
  b.update({ missingTab: true });
  await b.attach(started.handoffId);
  assert.equal(b.state().reopens, 1);
  const back = await b.attach(started.handoffId);
  assert.equal(back.lifecycleStatus, "running");
  assert.equal(directive(back).condition, undefined);
});

test("failure 3: Chrome without network gets a browser_offline directive with a concrete step", async (t) => {
  const b = browserBridge(t, { silentRobo: true });
  const started = await b.start();
  b.update({ health: "disconnected", reloadError: "net::ERR_INTERNET_DISCONNECTED" });
  const offline = await b.attach(started.handoffId);
  assert.equal(directive(offline).action, "RESTORE_BROWSER");
  assert.equal(directive(offline).condition, "browser_offline");
  assert.match(directive(offline).reason, /quit Chrome completely and start it again/);
  assert.doesNotMatch(JSON.stringify(offline), PRIVATE);
  assert.equal(offline.lifecycleStatus, "running");
  assert.equal(b.state().reloads, 1);

  // After Chrome is restarted, the same turn carries on.
  b.update({ health: "ready", errorTab: false, reloadError: null });
  const back = await b.attach(started.handoffId);
  assert.equal(directive(back).action, "POLL_ATTACH");
  assert.equal(directive(back).condition, undefined);
  assert.equal(b.state().clicks, 1);
});

async function publishingBridge(t: TestContext, initial: Record<string, unknown> = {}) {
  const prUrl = "https://github.com/example/repo/pull/9";
  const publishCommit = "c".repeat(40);
  const b = browserBridge(t, initial, { recovery: { idleStallMs: 150, maxNudges: 2 } });
  const prHead = b.fixture.commitFile("README.md", "published before", "current pull request head");
  const candidate = b.fixture.commitFile("README.md", "refreshed tree", "refresh candidate");
  const tree = b.fixture.revParse("HEAD^{tree}");
  const ref = "refs/heads/main";
  b.fixture.git(["push", "origin", ref]);
  b.gh({
    openPrs: [{ number: 9, url: prUrl, headRefName: "feature", headRefOid: prHead }],
    commitTrees: { [publishCommit]: tree, ["d".repeat(40)]: "e".repeat(40) },
  });
  b.update({ replyQueue: [{ disposition: "ready_for_publish_gate", candidateRef: ref, candidateCommitSha: candidate, prUrl,
    summaryDelta: "Ready to publish.", blockers: [], claimedChecks: [] }] });
  const ready = await b.service.startHandoff({ targetId: "robo", waitBudgetMs: 0, envelope: {
    schemaVersion: "0.2", requestId: "browser-update-pr", workspaceId: "workspace", title: "Refresh the pull request",
    outcome: "Update the existing pull request to the verified tree.", mode: "publish_unchanged", publisherOwner: "remote_gated",
    gitContext: { repoId: "example/repo", remoteUrlOrPath: b.fixture.originBareDir, pinnedBaseCommitSha: prHead,
      pinnedSourceCommitSha: candidate, expectedTreeSha: tree, sourceRemoteRef: ref,
      updatePullRequest: { url: prUrl, expectedHeadSha: prHead } },
    requestedCapabilities: { allowCodeEdit: false, allowBranchPush: false, allowManagedPublishStage: false },
    acceptanceCriteria: ["The pull request ends with exactly the verified tree"],
  } });
  assert.equal(directive(ready).action, "AUTHORIZE_REMOTE_PUBLISH", JSON.stringify(ready.observed.verificationNotes));
  // Robo accepts the publish turn and then goes quiet.
  b.update({ silentRobo: true });
  const publishing = await b.service.continueHandoff({ handoffId: ready.handoffId, intent: "authorize_publish",
    message: "Update it.", waitBudgetMs: 0 });
  assert.equal(directive(publishing).action, "POLL_ATTACH");
  assert.equal(directive(publishing).condition, undefined);
  return { ...b, handoffId: ready.handoffId, prUrl, publishCommit };
}

test("failure 2: a push seen on GitHub is reported as progress, and the nudge forbids a second push", async (t) => {
  const b = await publishingBridge(t);
  // Robo pushed, then the chat lost its connection before the pull request body edit.
  b.gh({ openPrs: [{ number: 9, url: b.prUrl, headRefName: "feature", headRefOid: b.publishCommit }] });
  b.update({ health: "disconnected" });
  const disconnected = await b.attach(b.handoffId);
  assert.equal(directive(disconnected).action, "POLL_ATTACH");
  assert.equal(directive(disconnected).condition, "chat_disconnected");
  assert.match(directive(disconnected).reason, new RegExp(`publication landed: ${b.prUrl} is at ${b.publishCommit}`));
  assert.equal(disconnected.observed.reconciledPrState, "open_verified");

  // Back online and still working: publish happened, the reply is pending.
  b.update({ health: "ready", remoteResponding: true });
  const working = await b.attach(b.handoffId);
  assert.equal(directive(working).action, "POLL_ATTACH");
  assert.equal(directive(working).condition, "published_reply_pending");

  // Robo goes quiet. The nudge names the push that already happened.
  b.update({ remoteResponding: false, silentRobo: false });
  await b.attach(b.handoffId);
  await delay(200);
  const settled = await b.attach(b.handoffId);
  assert.equal(settled.lifecycleStatus, "settled");
  const nudges = b.state().nudgeTexts ?? [];
  assert.equal(nudges.length, 1);
  assert.match(nudges[0]!, new RegExp(`GitHub already shows ${b.prUrl} at ${b.publishCommit} with the verified tree`));
  assert.match(nudges[0]!, /Do not push, force-push or publish again/);
  await assert.rejects(
    b.service.continueHandoff({ handoffId: b.handoffId, intent: "authorize_publish", message: "Again." }),
    (error: unknown) => error instanceof BridgeError && error.code === "PUBLISH_GATE_BLOCKED",
  );
});

test("a pull request head the bridge did not authorize stops nudges", async (t) => {
  const b = await publishingBridge(t);
  b.gh({ openPrs: [{ number: 9, url: b.prUrl, headRefName: "feature", headRefOid: "d".repeat(40) }] });
  await b.attach(b.handoffId);
  await delay(200);
  const stopped = await b.attach(b.handoffId);
  assert.equal(stopped.lifecycleStatus, "uncertain");
  assert.match((stopped.observed.verificationNotes ?? []).join(" "), /does not nudge Robo/);
  assert.equal(b.state().nudgeTexts, undefined);
});
