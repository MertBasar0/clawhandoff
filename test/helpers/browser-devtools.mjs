// A local Chrome DevTools MCP fixture. The bridge itself runs unchanged in a separate process.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const file = process.argv[2];
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (state) => writeFileSync(file, JSON.stringify(state));
const result = (structuredContent) => ({ structuredContent, content: [] });
const errorText = (text) => ({ isError: true, content: [{ type: "text", text }] });
const pageIdOf = (state) => state.pageId ?? 7;
// What the chat tab shows: "ready", "loading", "disconnected", "offline" or "error_page".
const healthOf = (state) => state.health ?? "ready";
// Like the Control UI's composer, the projection classifies the draft without exporting it.
const draftKind = (draft, key) => {
  const first = (draft ?? "").split("\n", 1)[0];
  if (!(draft ?? "").trim()) return "empty";
  if (key && first === `Bridge-Turn: ${key}`) return "request";
  if (key && first === `Bridge-Nudge: ${key}`) return "nudge";
  return /^Bridge-(?:Turn|Nudge): idem_[\w-]+$/.test(first) ? "bridge_other" : "text";
};
// Stands in for what a raw reply can reveal about other tabs. The bridge must never repeat it.
const PRIVATE = "https://private.example/inbox?thread=42 (Private Title)";

const startup = load();
if (startup.exitOnStartup) {
  process.stderr.write(`${startup.exitOnStartup}\n`, () => process.exit(1));
} else {
  const server = new McpServer({ name: "fixture-chrome", version: "1" });
  const page = startup.noPageIds ? {} : { pageId: z.number() };

  // Like Chrome DevTools MCP 1.11 reconnecting to the browser right before a call: every tab
  // gets a new id, a call with an old id fails with "No page found" before its tool runs, and
  // that reply carries the one-time `reconnected` notice.
  const reconnectsBefore = (state, name) => {
    const plan = state.reconnectBefore;
    if (plan?.tool !== name) return false;
    if (plan.skip) {
      plan.skip -= 1;
      return false;
    }
    state.reconnectBefore = plan.count > 1 ? { ...plan, count: plan.count - 1 } : undefined;
    state.pageId = pageIdOf(state) + 100;
    if (plan.duplicateTab) state.duplicateTab = true;
    // The composer can change while the connection is down.
    if (typeof plan.draft === "string") state.draft = plan.draft;
    return true;
  };

  // Failure shapes Chrome DevTools MCP 1.11 produces, each carrying private tab details.
  const failure = (name, kind) => {
    if (kind === "exit") process.exit(3);
    if (kind === "connect_timeout") {
      return errorText(`Tool "${name}" timed out after 60000ms waiting for the browser connection to be established. The connection attempt will be retried automatically on the next tool call.\nCause: ${PRIVATE}`);
    }
    if (kind === "connect_failed") {
      return errorText(`Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.\nCause: ${PRIVATE}`);
    }
    if (kind === "unstructured") return { content: [{ type: "text", text: PRIVATE }] };
    return { ...errorText(`Error: ${PRIVATE}`), structuredContent: { errorMessage: PRIVATE } };
  };

  const tool = (name, schema, handler) => server.registerTool(name, { inputSchema: schema }, async (args) => {
    const state = load();
    const reconnected = reconnectsBefore(state, name);
    const kind = state.failNext?.tool === name ? state.failNext.kind : undefined;
    if (kind) delete state.failNext;
    save(state);
    if (kind) return failure(name, kind);
    if ("pageId" in schema && args.pageId !== pageIdOf(state)) {
      return { ...errorText("Error: No page found"), structuredContent: { ...(reconnected && { reconnected: true }), errorMessage: "No page found" } };
    }
    const reply = await handler(args);
    return reconnected ? { ...reply, structuredContent: { ...reply.structuredContent, reconnected: true } } : reply;
  });

  // Snapshot uids belong to one page id, as they belong to one snapshot in Chrome DevTools MCP.
  const uid = (state, n) => `${pageIdOf(state)}_${n}`;
  const unknownUid = (value) => ({ ...errorText(`Element uid "${value}" not found.`), structuredContent: { errorMessage: "Element uid not found" } });
  // The action ran, yet its reply reports a reconnect. Chrome DevTools MCP 1.11 never does this.
  const acted = (state, name) => {
    if (state.reconnectedAfterNextAction !== name) {
      save(state);
      return result({});
    }
    delete state.reconnectedAfterNextAction;
    state.pageId = pageIdOf(state) + 100;
    save(state);
    return result({ reconnected: true });
  };

  tool("list_pages", {}, async () => {
    const state = load();
    const id = pageIdOf(state);
    return result({ pages: [
      ...(state.missingTab ? [] : [{ id, url: state.errorTab ? "chrome-error://chromewebdata/" : state.sessionUrl }]),
      ...(state.duplicateTab ? [{ id: id + 1, url: state.sessionUrl }] : []),
      { id: id + 12, url: "https://example.invalid/unrelated" },
    ] });
  });
  tool("take_snapshot", page, async () => {
    const state = load();
    const { sessionUrl, draft, locale, remoteResponding, questionLabel } = state;
    const de = locale === "de";
    const composerLabel = de ? "Nachricht eingeben" : "Chat composer";
    const held = healthOf(state) !== "ready";
    const sendLabel = held ? "Loading chat…" : draft ? (de ? "Nachricht senden" : "Send message") : (de ? "Zuerst eine Nachricht eingeben" : "Write a message first");
    const stopLabel = de ? "Generierung stoppen" : "Stop generating";
    return result({ snapshot: { id: uid(state, 0), role: "RootWebArea", url: sessionUrl, children: [
      ...(questionLabel ? [{ id: uid(state, 4), role: "textbox", name: questionLabel }] : []),
      { id: uid(state, 1), role: "textbox", name: composerLabel, ...(draft && { value: draft }) },
      ...(remoteResponding ? [{ id: uid(state, 3), role: "button", name: stopLabel, disabled: false }] : []),
      { id: uid(state, 2), role: "button", name: sendLabel, disabled: held || !draft || Boolean(remoteResponding) },
    ] } });
  });
  tool("fill", { ...page, uid: z.string(), value: z.string() }, async ({ uid: target, value }) => {
    const state = load();
    if (target !== uid(state, 1)) return unknownUid(target);
    if (value === "") {
      // The bridge clears a stale draft of its own before typing a new message.
      state.clears = (state.clears ?? 0) + 1;
      state.draft = "";
      return acted(state, "fill");
    }
    assert.equal(state.draft, "");
    state.draft = value;
    state.fills = (state.fills ?? 0) + 1;
    // "Loading chat": the Control UI starts reloading the route right after the draft was typed.
    if (state.healthAfterFill) {
      state.health = state.healthAfterFill;
      delete state.healthAfterFill;
    }
    return acted(state, "fill");
  });
  tool("click", { ...page, uid: z.string() }, async ({ uid: target }) => {
    const state = load();
    if (target !== uid(state, 2)) return unknownUid(target);
    if (healthOf(state) !== "ready") {
      state.clicksWhileNotReady = (state.clicksWhileNotReady ?? 0) + 1;
      save(state);
      return result({});
    }
    if (state.swallowClicks) {
      // The click reached nothing: the draft stays and the transcript does not change.
      state.swallowClicks -= 1;
      state.swallowedClicks = (state.swallowedClicks ?? 0) + 1;
      save(state);
      return result({});
    }
    if (state.loseNextClickWithoutReceipt) {
      save({ ...state, draft: "", loseNextClickWithoutReceipt: false });
      return { isError: true, content: [{ type: "text", text: "browser disconnected before a receipt was observable" }] };
    }
    const nudgeKey = /^Bridge-Nudge: (idem_[\w-]+)$/m.exec(state.draft)?.[1];
    if (nudgeKey) {
      state.nudgeTexts = [...(state.nudgeTexts ?? []), state.draft];
      // A nudge resumes the failed turn, which then finishes with its original reply marker.
      const report = { disposition: "needs_evidence", summaryDelta: "Resumed after a failed reply.", blockers: ["Missing receipt"] };
      state.messages.push({ role: "user", text: state.draft }, { role: "assistant",
        text: `Bridge-Reply: ${nudgeKey}\n\n\`\`\`handoff-result\n${JSON.stringify(report)}\n\`\`\`` });
      state.draft = "";
      state.nudgeClicks = (state.nudgeClicks ?? 0) + 1;
      return acted(state, "click");
    }
    const key = /^Bridge-Turn: (idem_[\w-]+)$/m.exec(state.draft)?.[1];
    assert.ok(key, "bridge must correlate each submission");
    if (state.failNextTurn) {
      // The Control UI gave up on this reply and shows "Unable to finish this reply".
      state.messages.push({ role: "user", text: state.draft }, { role: "failure", text: "", retryable: true });
      state.draft = "";
      state.failNextTurn = false;
      state.clicks = (state.clicks ?? 0) + 1;
      return acted(state, "click");
    }
    if (state.silentRobo) {
      // Robo accepts the turn and then goes quiet without a final answer.
      state.messages.push({ role: "user", text: state.draft });
      state.draft = "";
      state.clicks = (state.clicks ?? 0) + 1;
      return acted(state, "click");
    }
    if (state.replyQueue?.length) {
      const report = state.replyQueue.shift();
      state.messages.push({ role: "user", text: state.draft }, { role: "assistant",
        text: `Bridge-Reply: ${key}\n\n\`\`\`handoff-result\n${JSON.stringify(report)}\n\`\`\`` });
      state.draft = "";
      state.clicks = (state.clicks ?? 0) + 1;
      return acted(state, "click");
    }
    const missing = !state.draft.includes("receipt:");
    const report = missing
      ? { disposition: "needs_evidence", summaryDelta: "Missing receipt for the local run.", blockers: ["Missing receipt"] }
      : { disposition: "completed", summaryDelta: "Local evidence received.", blockers: [] };
    state.messages.push({ role: "user", text: state.draft }, { role: "assistant",
      text: `Bridge-Reply: ${key}\n\n\`\`\`handoff-result\n${JSON.stringify(report)}\n\`\`\`` });
    state.draft = "";
    state.clicks = (state.clicks ?? 0) + 1;
    // The click reached the chat. Unless told otherwise, simulate losing its acknowledgement on the first turn.
    if (state.messages.length === 2 && !state.ackFirstClick) {
      save(state);
      return { isError: true, content: [{ type: "text", text: "click acknowledgement lost" }] };
    }
    return acted(state, "click");
  });
  tool("evaluate_script", { ...page, function: z.string(), waitForStableDom: z.literal(false) }, async ({ function: fnSource }) => {
    const state = load();
    const turnKey = /, "(idem_[\w-]+)", /.exec(fnSource)?.[1];
    const health = healthOf(state);
    state.reads = (state.reads ?? 0) + 1;
    if (health !== "ready" && typeof state.recoverAfterReads === "number") {
      state.recoverAfterReads -= 1;
      if (state.recoverAfterReads <= 0) {
        state.health = "ready";
        delete state.recoverAfterReads;
      }
    }
    save(state);
    if (health === "error_page") {
      return result({ message: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({ url: "chrome-error://chromewebdata/", ready: false, busy: false, health, messages: [] })}\n\`\`\`` });
    }
    const { sessionUrl: url, messages, draft, locale, remoteResponding } = state;
    let visibleMessages = messages;
    let busy = Boolean(remoteResponding);
    const isTurnRead = fnSource.includes('"idem_');
    if (isTurnRead && typeof state.preambleFlickerStage === "number" && state.preambleFlickerStage > 0) {
      const stage = state.preambleFlickerStage;
      save({ ...state, preambleFlickerStage: stage - 1 });
      if (stage === 2) {
        // Stage 2 (Turn Poll #1): assistant emitted an unlabelled preamble bubble and busy briefly flickered false!
        visibleMessages = [
          ...messages.slice(0, -1),
          { role: "assistant", text: "I will inspect the commit and run checks now." },
        ];
        busy = false;
      } else if (stage === 1) {
        // Stage 1 (Turn Poll #2): next tool call is actively streaming (`busy: true`).
        visibleMessages = [
          ...messages.slice(0, -1),
          { role: "assistant", text: "I will inspect the commit and run checks now." },
        ];
        busy = true;
      }
    } else if (isTurnRead && state.unlabelledFinalReply) {
      visibleMessages = [
        ...messages.slice(0, -1),
        { role: "assistant", text: "Finished without a Bridge-Reply marker." },
      ];
      busy = false;
    }
    const de = locale === "de";
    const controls = {
      composerLabel: de ? "Nachricht eingeben" : "Chat composer",
      sendLabel: draft ? (de ? "Nachricht senden" : "Send message") : (de ? "Zuerst eine Nachricht eingeben" : "Write a message first"),
      stopLabel: busy ? (de ? "Generierung stoppen" : "Stop generating") : "",
    };
    if (health !== "ready") {
      // A saved or loading transcript is never reported as messages.
      const held = { ...controls, sendLabel: "Loading chat…" };
      const projection = { url, ready: false, busy, health, draft: draftKind(draft, turnKey), controls: held, messages: [] };
      return result({ message: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(projection)}\n\`\`\`` });
    }
    const projection = { url, ready: true, busy, health, draft: draftKind(draft, turnKey), controls, messages: visibleMessages.map(({ role, text, retryable }) => {
      const firstLine = text.split("\n", 1)[0];
      if (role === "failure") return { role, text: "", ...(retryable && { retryable }) };
      if (role === "user" && firstLine.startsWith("Bridge-Nudge: ")) return { role, text: "", nudge: true };
      return { role, text: role === "user" ? firstLine : text };
    }) };
    return result({ message: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(projection)}\n\`\`\`` });
  });
  tool("navigate_page", { ...page, type: z.enum(["url", "back", "forward", "reload"]).optional(),
    handleBeforeUnload: z.enum(["accept", "dismiss"]).optional(), timeout: z.number().optional() }, async (args) => {
    const state = load();
    assert.equal(args.type, "reload");
    assert.equal(args.handleBeforeUnload, "dismiss", "a reload must keep unsent offline changes");
    state.reloads = (state.reloads ?? 0) + 1;
    if (state.reloadError) {
      state.errorTab = true;
      state.health = "error_page";
      save(state);
      return result({ message: `Unable to reload the selected page: ${state.reloadError} at ${PRIVATE}.` });
    }
    if (typeof state.recoverAfterReloads === "number" && state.reloads >= state.recoverAfterReloads) {
      state.health = "ready";
      state.errorTab = false;
    }
    save(state);
    return result({ message: "Successfully reloaded the page." });
  });
  tool("new_page", { url: z.string(), background: z.boolean().optional(), timeout: z.number().optional() }, async ({ url }) => {
    const state = load();
    assert.equal(url, state.sessionUrl);
    state.reopens = (state.reopens ?? 0) + 1;
    state.missingTab = false;
    save(state);
    return result({ pages: [{ id: pageIdOf(state), url }] });
  });
  await server.connect(new StdioServerTransport());
}
