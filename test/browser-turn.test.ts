import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserTranscriptScript, inspectBrowserTurn, wrapBrowserPrompt } from "../src/browser-turn.js";
import { loadBridgeConfig } from "../src/config.js";
import { parseReportedResult } from "../src/prompt-compiler.js";

const key = "idem_1234";
const request = { role: "user", text: "Bridge-Turn: " + key };
const answer = { role: "assistant", text: "Bridge-Reply: " + key +
  '\n\n```handoff-result\n{"disposition":"needs_evidence","summaryDelta":"Missing test output"}\n```' };
const otherUser = { role: "user", text: "" };
const observe = (
  messages: Array<{ role: string; text: string; unconfirmed?: boolean; sendState?: string; settling?: boolean; loading?: boolean }>,
  busy = false,
) => inspectBrowserTurn(JSON.stringify({ ready: true, busy, messages }), key);

test("browser target config accepts OpenClaw multi-segment session URLs and rejects invalid ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-"));
  try {
    const check = (sessionUrl: string, agentId = "roboclaw") => {
      const p = join(dir, "cfg.json");
      writeFileSync(p, JSON.stringify({
        targets: { robo: { targetId: "robo", transport: "browser", agentId, sessionUrl, browserMcp: { command: "node", args: [] } } },
      }));
      return loadBridgeConfig(p);
    };
    for (const validUrl of [
      "https://team.example/chat/roboclaw/verify-linux-00112233445566778899aabbccddeeff",
      "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f",
      "https://team.example/dashboard/roboclaw/33257e49-0012-426e-80ab-6ba8f8eb881f",
      "https://team.example/chat/roboclaw/~key/subagent/run-42",
      "https://team.example/ui/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f",
    ]) {
      assert.equal(check(validUrl).targets.robo?.transport, "browser", validUrl);
    }
    for (const invalidUrl of [
      "https://team.example/chat/roboclaw",
      "https://team.example/chat/roboclaw/",
      "https://team.example/chat/roboclaw/~key",
      "https://team.example/chat/other/33257e49-0012-426e-80ab-6ba8f8eb881f",
      "http://team.example/chat/roboclaw/33257e49-0012-426e-80ab-6ba8f8eb881f",
      "https://user:pass@team.example/chat/roboclaw/33257e49-0012-426e-80ab-6ba8f8eb881f",
      "https://team.example/chat/roboclaw/33257e49-0012-426e-80ab-6ba8f8eb881f?x=1",
      "https://team.example/chat/roboclaw/33257e49-0012-426e-80ab-6ba8f8eb881f#top",
    ]) {
      assert.throws(() => check(invalidUrl), /Invalid bridge config/, invalidUrl);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser turn settles only its acknowledged final reply after the matching submission", () => {
  assert.equal(wrapBrowserPrompt(key, "Check receipt").split("\n")[0], request.text);
  const observed = observe([answer, otherUser, request, answer]);
  assert.equal(observed.state, "completed");
  assert.equal(parseReportedResult(observed.text!).summaryDelta, "Missing test output");
  assert.equal(observe([request, { role: "assistant", text: "Completed review.\n\n" + answer.text }]).state, "completed");
  assert.equal(observe([request, answer], true).state, "running");
  assert.equal(observe([request, { role: "assistant", text: "", settling: true }]).state, "running");
  assert.equal(observe([request, { role: "assistant", text: "", loading: true }]).state, "running");
  assert.equal(observe([{ ...request, sendState: "waiting-reconnect" }]).state, "pending");
  assert.equal(observe([{ ...request, sendState: "failed" }]).state, "uncertain");
  assert.equal(observe([{ ...request, unconfirmed: true }]).state, "uncertain");
  assert.equal(observe([request, otherUser, answer]).state, "uncertain");
  assert.equal(observe([request, request, answer]).state, "uncertain");
  assert.equal(observe([request, { ...answer, text: "> " + answer.text }]).state, "uncertain");
  assert.equal(observe([request, { role: "assistant", text: "```text\n" + answer.text + "\n```" }]).state, "uncertain");
  assert.equal(observe([answer, { role: "assistant", text: request.text }]).state, "absent");
});

test("browser transcript script guards route, streaming placeholder footers, and oversized loading bubbles", () => {
  const targetUrl = "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f";
  const runScript = new Function(
    "location",
    "document",
    `return (${browserTranscriptScript})(${JSON.stringify(targetUrl)}, ${JSON.stringify(key)})`,
  ) as (loc: { href: string }, doc: unknown) => {
    ready: boolean;
    busy: boolean;
    controls?: { composerLabel: string; sendLabel: string };
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(runScript({ href: "https://team.example/chat/other" }, null).ready, false);

  const makeDom = (opts: {
    footerSettled: boolean;
    streamingAttr?: boolean;
    sendState?: string;
    assistantText: string;
    fullMessageStatus?: "loading" | "loaded" | "error";
    loadErrorDom?: boolean;
  }) => {
    const composer = {
      getAttribute: (n: string) => (n === "aria-label" ? "Nachricht eingeben" : null),
      closest: () => null,
    };
    const sendBtn = {
      disabled: false,
      textContent: "Senden",
      getAttribute: (n: string) => (n === "aria-label" ? "Nachricht senden" : null),
      closest: () => null,
    };
    const userGroup = {
      classList: { contains: (c: string) => c === "user" },
      matches: () => false,
      hasAttribute: () => false,
      querySelector: (sel: string) =>
        sel === "[data-send-state]" && opts.sendState
          ? { getAttribute: (n: string) => (n === "data-send-state" ? opts.sendState : null) }
          : null,
    };
    const assistantGroup = {
      classList: { contains: (c: string) => c === "assistant" },
      matches: () => false,
      hasAttribute: (n: string) => Boolean(opts.streamingAttr && n === "data-chat-streaming"),
      querySelector: (sel: string) => {
        if (sel === ".chat-group-footer") return {}; // Present even while streaming!
        if (sel.includes(".chat-group-footer__meta")) return opts.footerSettled ? {} : null;
        return null;
      },
    };
    const userBubble = {
      parentElement: { closest: () => null },
      classList: { contains: () => false },
      closest: (sel: string) => (sel === ".chat-group" ? userGroup : null),
      getAttribute: (n: string) => (n === "data-message-text" ? request.text : null),
      querySelector: () => null,
    };
    const assistantBubble = {
      parentElement: { closest: () => null },
      classList: { contains: () => false },
      closest: (sel: string) => (sel === ".chat-group" ? assistantGroup : null),
      getAttribute: (n: string) => (n === "data-message-text" ? opts.assistantText : null),
      querySelector: (sel: string) => (sel === ".chat-message-load-error" && opts.loadErrorDom ? {} : null),
      ...(opts.fullMessageStatus
        ? { messageActions: { fullMessage: { messageId: "m1", state: { status: opts.fullMessageStatus, revision: 1 } } } }
        : {}),
    };
    const scope = {
      querySelector: (sel: string) => {
        if (sel.includes("textarea")) return composer;
        if (sel.includes("chat-send-btn--send") && !sel.includes("sending")) return sendBtn;
        return null;
      },
    };
    const thread = {
      classList: { contains: () => false },
      closest: (sel: string) => (sel === "main" ? scope : null),
      querySelectorAll: () => [userBubble, assistantBubble],
    };
    return { querySelectorAll: () => [thread] };
  };

  // 1. Streaming placeholder footer (aria-hidden="true", no meta) must stay running, never premature completed/uncertain.
  const streamingSnap = JSON.stringify(runScript({ href: targetUrl }, makeDom({ footerSettled: false, assistantText: answer.text })));
  assert.equal(inspectBrowserTurn(streamingSnap, key).state, "running");

  // 2. Oversized message still loading via chat.message.get must stay running until loaded.
  const loadingSnap = JSON.stringify(runScript({
    href: targetUrl,
  }, makeDom({ footerSettled: true, assistantText: "This message is too large to display here.", fullMessageStatus: "loading" })));
  assert.equal(inspectBrowserTurn(loadingSnap, key).state, "running");

  // 3. Exhausted oversized load (.chat-message-load-error) surfaces uncertain.
  const loadErrSnap = JSON.stringify(runScript({
    href: targetUrl,
  }, makeDom({ footerSettled: true, assistantText: "This message is too large to display here.", fullMessageStatus: "error", loadErrorDom: true })));
  assert.equal(inspectBrowserTurn(loadErrSnap, key).state, "uncertain");

  // 4. Fenced marker inside DOM bubble must not match, while settled preamble + marker completes.
  const fencedSnap = JSON.stringify(runScript({
    href: targetUrl,
  }, makeDom({ footerSettled: true, assistantText: "```text\n" + answer.text + "\n```" })));
  assert.equal(inspectBrowserTurn(fencedSnap, key).state, "uncertain");

  const settledProj = runScript({
    href: targetUrl,
  }, makeDom({ footerSettled: true, assistantText: "Kurzfassung:\n\n" + answer.text, fullMessageStatus: "loaded" }));
  assert.equal(settledProj.controls?.composerLabel, "Nachricht eingeben");
  assert.equal(settledProj.controls?.sendLabel, "Nachricht senden");
  assert.equal(inspectBrowserTurn(JSON.stringify(settledProj), key).state, "completed");
});

test("a result with no candidate ref or PR keeps the target's evidence blockers", () => {
  const message = {
    disposition: "needs_evidence",
    candidateCommitSha: "a".repeat(40), candidateRef: "", prUrl: "",
    summaryDelta: "Clean checkout proof is missing.",
    blockers: ["Missing test output", "Missing checkout identity"], claimedChecks: [],
  };
  const parse = (fields: object) => parseReportedResult(
    "```handoff-result\n" + JSON.stringify({ ...message, ...fields }) + "\n```",
  );
  const reported = parse({});
  assert.deepEqual(reported.blockers, message.blockers);
  assert.equal(reported.candidateCommitSha, message.candidateCommitSha);
  assert.equal(reported.candidateRef, undefined);
  assert.equal(reported.prUrl, undefined);
  assert.equal(parse({ candidateCommitSha: "", disposition: "completed" }).disposition, "completed");
  assert.equal(parse({ disposition: "completed", prUrl: "not a URL" }).disposition, "needs_evidence");
  assert.equal(parse({ disposition: "completed", candidateCommitSha: "x".repeat(40) }).disposition, "needs_evidence");
});
