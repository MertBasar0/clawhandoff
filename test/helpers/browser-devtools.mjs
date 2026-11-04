// A local Chrome DevTools MCP fixture. The bridge itself runs unchanged in a separate process.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const file = process.argv[2];
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (state) => writeFileSync(file, JSON.stringify(state));
const server = new McpServer({ name: "fixture-chrome", version: "1" });
const result = (structuredContent) => ({ structuredContent, content: [] });
const page = { pageId: z.literal(7) };

server.registerTool("list_pages", { inputSchema: {} }, async () => result({
  pages: [{ id: 7, url: load().sessionUrl }, { id: 19, url: "https://example.invalid/unrelated" }],
}));
server.registerTool("take_snapshot", { inputSchema: page }, async () => {
  const { sessionUrl, draft, locale, remoteResponding, questionLabel } = load();
  const de = locale === "de";
  const composerLabel = de ? "Nachricht eingeben" : "Chat composer";
  const sendLabel = draft ? (de ? "Nachricht senden" : "Send message") : (de ? "Zuerst eine Nachricht eingeben" : "Write a message first");
  const stopLabel = de ? "Generierung stoppen" : "Stop generating";
  return result({ snapshot: { id: "1_0", role: "RootWebArea", url: sessionUrl, children: [
    ...(questionLabel ? [{ id: "1_4", role: "textbox", name: questionLabel }] : []),
    { id: "1_1", role: "textbox", name: composerLabel, ...(draft && { value: draft }) },
    ...(remoteResponding ? [{ id: "1_3", role: "button", name: stopLabel, disabled: false }] : []),
    { id: "1_2", role: "button", name: sendLabel, disabled: !draft || Boolean(remoteResponding) },
  ] } });
});
server.registerTool("fill", { inputSchema: { ...page, uid: z.literal("1_1"), value: z.string() } }, async ({ value }) => {
  const state = load();
  assert.equal(state.draft, "");
  save({ ...state, draft: value });
  return result({});
});
server.registerTool("click", { inputSchema: { ...page, uid: z.literal("1_2") } }, async () => {
  const state = load();
  if (state.loseNextClickWithoutReceipt) {
    save({ ...state, draft: "", loseNextClickWithoutReceipt: false });
    return { isError: true, content: [{ type: "text", text: "browser disconnected before a receipt was observable" }] };
  }
  const key = /^Bridge-Turn: (idem_[\w-]+)$/m.exec(state.draft)?.[1];
  assert.ok(key, "bridge must correlate each submission");
  const missing = !state.draft.includes("receipt:");
  const report = missing
    ? { disposition: "needs_evidence", summaryDelta: "Missing receipt for the local run.", blockers: ["Missing receipt"] }
    : { disposition: "completed", summaryDelta: "Local evidence received.", blockers: [] };
  state.messages.push({ role: "user", text: state.draft }, { role: "assistant",
    text: `Bridge-Reply: ${key}\n\n\`\`\`handoff-result\n${JSON.stringify(report)}\n\`\`\`` });
  state.draft = "";
  save(state);
  // The click reached the chat. Simulate losing its acknowledgement on the first turn.
  if (state.messages.length === 2) return { isError: true, content: [{ type: "text", text: "click acknowledgement lost" }] };
  return result({});
});
server.registerTool("evaluate_script", { inputSchema: { ...page, function: z.string(), waitForStableDom: z.literal(false) } }, async () => {
  const { sessionUrl: url, messages, draft, locale, remoteResponding } = load();
  const de = locale === "de";
  const controls = {
    composerLabel: de ? "Nachricht eingeben" : "Chat composer",
    sendLabel: draft ? (de ? "Nachricht senden" : "Send message") : (de ? "Zuerst eine Nachricht eingeben" : "Write a message first"),
    stopLabel: remoteResponding ? (de ? "Generierung stoppen" : "Stop generating") : "",
  };
  const projection = { url, ready: true, busy: Boolean(remoteResponding), controls, messages: messages.map(({ role, text }) => ({
    role, text: role === "user" ? text.split("\n", 1)[0] : text,
  })) };
  return result({ message: `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify(projection)}\n\`\`\`` });
});
await server.connect(new StdioServerTransport());
