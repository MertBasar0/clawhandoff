import assert from "node:assert/strict";
import { test } from "node:test";
import { browserTranscriptScript, inspectBrowserTurn, wrapBrowserPrompt } from "../src/browser-turn.js";
import { parseReportedResult } from "../src/prompt-compiler.js";

const key = "idem_1234";
const request = { role: "user", text: "Bridge-Turn: " + key };
const answer = { role: "assistant", text: "Bridge-Reply: " + key +
  '\n\n```handoff-result\n{"disposition":"needs_evidence","summaryDelta":"Missing test output"}\n```' };
const otherUser = { role: "user", text: "" };
const observe = (messages: Array<{ role: string; text: string; unconfirmed?: boolean }>, busy = false) =>
  inspectBrowserTurn(JSON.stringify({ ready: true, busy, messages }), key);

test("browser turn settles only its acknowledged final reply after the matching submission", () => {
  assert.equal(wrapBrowserPrompt(key, "Check receipt").split("\n")[0], request.text);
  const observed = observe([answer, otherUser, request, answer]);
  assert.equal(observed.state, "completed");
  assert.equal(parseReportedResult(observed.text!).summaryDelta, "Missing test output");
  assert.equal(observe([request, answer], true).state, "running");
  assert.equal(observe([{ ...request, unconfirmed: true }]).state, "uncertain");
  assert.equal(observe([request, otherUser, answer]).state, "uncertain");
  assert.equal(observe([request, request, answer]).state, "uncertain");
  assert.equal(observe([request, { ...answer, text: "> " + answer.text }]).state, "uncertain");
  assert.equal(observe([answer, { role: "assistant", text: request.text }]).state, "absent");
});

test("browser transcript refuses a different route before reading its DOM", () => {
  const read = new Function("location", "document", "return (" + browserTranscriptScript + ")(\"https://team.example/chat/target\")");
  assert.equal(read({ href: "https://team.example/chat/other" }, null).ready, false);
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
