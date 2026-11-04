import assert from "node:assert/strict";
import { test } from "node:test";
import { browserTranscriptScript, inspectBrowserTurn, wrapBrowserPrompt } from "../src/browser-turn.js";
import { parseReportedResult } from "../src/prompt-compiler.js";

const key = "idem_1234";
const request = { role: "user", text: "Bridge-Turn: " + key };
const answer = { role: "assistant", text: "Bridge-Reply: " + key +
  '\n\n```handoff-result\n{"disposition":"needs_evidence","summaryDelta":"Missing test output"}\n```' };
const otherUser = { role: "user", text: "" };
const observe = (
  messages: Array<{ role: string; text: string; unconfirmed?: boolean; sendState?: string; settling?: boolean; loading?: boolean }>,
  busy = false,
  alreadyDispatched = false,
) => inspectBrowserTurn(JSON.stringify({ ready: true, busy, messages }), key, alreadyDispatched);

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
  // Already-dispatched turns survive Control UI history reload/virtualization when the user prompt scrolls out.
  assert.equal(observe([answer], false, true).state, "completed");
  assert.equal(observe([], true, true).state, "running");
  assert.equal(observe([], false, true).state, "uncertain");
  assert.equal(observe([otherUser, answer], false, true).state, "uncertain");
});

test("a browser handoff result belongs only to the section starting at the current reply marker", () => {
  const completed = '```handoff-result\n{"disposition":"completed","summaryDelta":"Previous task"}\n```';
  const preamble = "Previous run:\nBridge-Reply: idem_old\n" + completed + "\n\n";
  const marker = "Bridge-Reply: " + key;
  const current = marker + "\r\nNo evidence for this run.";
  const read = (text: string) => observe([request, { role: "assistant", text }]);

  const missing = read(preamble + current);
  assert.equal(missing.state, "completed");
  assert.equal(parseReportedResult(missing.text!, "browser").disposition, "needs_evidence");
  assert.equal(missing.text, current);
  const fresh = read(preamble + answer.text);
  assert.equal(fresh.text, answer.text);
  assert.equal(parseReportedResult(fresh.text!, "browser").summaryDelta, "Missing test output");

  for (const competing of [marker, "Bridge-Reply: idem_other"]) {
    assert.equal(read(current + "\n" + competing + "\n" + completed).state, "uncertain");
  }
  const quotedMarker = marker + "\n~~~~text\nBridge-Reply: idem_old\n~~~~\n" + completed;
  assert.equal(read(quotedMarker).text, quotedMarker);
  const exampleOnly = marker + "\nEarlier output:\n~~~~text\n" + completed + "\n~~~~";
  assert.equal(parseReportedResult(read(exampleOnly).text!, "browser").disposition, "needs_evidence");
  const listedExample = marker + "\nCannot confirm this run.\n- Previous result:\n\n" + completed.replace(/^/gm, "  ");
  assert.equal(parseReportedResult(read(listedExample).text!, "browser").disposition, "needs_evidence");
  for (const asymmetric of ["  " + completed, completed.replace(/\n```$/, "\n  ```")]) {
    assert.equal(parseReportedResult(read(marker + "\n" + asymmetric).text!, "browser").disposition, "needs_evidence");
  }
  const notFinal = marker + "\n" + completed + "\nNo evidence for *this* request.";
  assert.equal(parseReportedResult(read(notFinal).text!, "browser").disposition, "needs_evidence");
  assert.equal(parseReportedResult(read(marker + "\n" + completed + "\r\n\n").text!, "browser").disposition, "completed");

  const longCommand = `node --input-type=module <<'NODE'\n${"console.log('verified');\n".repeat(35)}NODE`;
  assert.ok(longCommand.length > 500);
  const longCheckBlock =
    "```handoff-result\n" +
    JSON.stringify({
      disposition: "completed",
      summaryDelta: "Verified with multi-line inline probe",
      blockers: [],
      claimedChecks: [{ command: longCommand, exitCode: 0, environment: "linux" }],
    }) +
    "\n```";
  const parsedLong = parseReportedResult(read(marker + "\n" + longCheckBlock).text!, "browser");
  assert.equal(parsedLong.disposition, "completed");
  assert.equal(parsedLong.claimedChecks[0]?.command, longCommand);
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
    composerCount?: number;
  }) => {
    // A nonblocking question can render a labelled answer before the main chat input.
    const question = {
      getAttribute: (n: string) => (n === "aria-label" ? "Eigene Antwort" : null),
      closest: () => null,
    };
    const composerAttrs: Record<string, string> = { "aria-label": "Nachricht eingeben", "aria-autocomplete": "list" };
    const textareas = [question, ...Array.from({ length: opts.composerCount ?? 1 }, () => ({
      getAttribute: (n: string) => composerAttrs[n] ?? null,
      closest: (sel: string) => sel === ".agent-chat__input--chat" ? {} : null,
    }))];
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
      getElementsByTagName: (tag: string) => tag === "textarea" ? textareas : [],
      querySelector: (sel: string) => {
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

  const projectComposer = (composerCount: number) =>
    runScript({ href: targetUrl }, makeDom({ footerSettled: true, composerCount, assistantText: "" }));
  assert.equal(projectComposer(1).controls?.composerLabel, "Nachricht eingeben");
  assert.equal(projectComposer(0).ready, false);

  const uuidRoute = { prefix: "https://team.example/chat/roboclaw/", uuid: "4f99c346fa5d4daea8d9ba738d8bae4d" };
  const runUuidScript = new Function(
    "location",
    "document",
    `return (${browserTranscriptScript})(${JSON.stringify("https://team.example/chat/roboclaw/old-4f99c346fa5d4daea8d9ba738d8bae4d")}, ${JSON.stringify(key)}, ${JSON.stringify(uuidRoute)})`,
  ) as typeof runScript;
  const dom = makeDom({ footerSettled: true, assistantText: "" });
  assert.equal(runUuidScript({ href: "https://team.example/chat/roboclaw/new-slug-4f99c346fa5d4daea8d9ba738d8bae4d" }, dom).ready, true);
  assert.equal(runUuidScript({ href: "https://team.example/chat/roboclaw/new-slug-00000000fa5d4daea8d9ba738d8bae4d" }, dom).ready, false);
  assert.equal(runUuidScript({ href: "https://team.example/chat/roboclaw/new-slug-4f99c346fa5d4daea8d9ba738d8bae4d?focus=composer" }, dom).ready, false);
  assert.equal(projectComposer(2).ready, false);

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
  const indented = runScript({ href: targetUrl }, makeDom({
    footerSettled: true, assistantText: "    " + answer.text,
  }));
  assert.equal(inspectBrowserTurn(JSON.stringify(indented), key).state, "uncertain");

  const settledProj = runScript({
    href: targetUrl,
  }, makeDom({ footerSettled: true, assistantText: "Kurzfassung:\n\n" + answer.text, fullMessageStatus: "loaded" }));
  assert.equal(settledProj.controls?.composerLabel, "Nachricht eingeben");
  assert.equal(settledProj.controls?.sendLabel, "Nachricht senden");
  assert.deepEqual(inspectBrowserTurn(JSON.stringify(settledProj), key), { state: "completed", text: answer.text });
  const ambiguous = runScript({ href: targetUrl }, makeDom({
    footerSettled: true, assistantText: answer.text + "\nBridge-Reply: idem_other",
  }));
  assert.equal(inspectBrowserTurn(JSON.stringify(ambiguous), key).state, "uncertain");
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
