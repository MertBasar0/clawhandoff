// Opt-in host acceptance. Run `node test/helpers/host-acceptance.mjs setup`, connect
// a local agent to the printed MCP server, then run the printed verification command.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const write = (path, data) => writeFileSync(path, JSON.stringify(data));
const blocker = "The reviewer believes statusText(0) is incorrect. Supply a passing local smoke receipt tied to the submitted commit.";

function reply(accepted) {
  const result = {
    disposition: accepted ? "completed" : "needs_evidence",
    summaryDelta: accepted ? "Accepted the matching commit-bound smoke receipt." : blocker,
    blockers: accepted ? [] : [blocker],
  };
  return { replyText: "```handoff-result\n" + JSON.stringify(result) + "\n```" };
}

if (process.argv[2] === "setup") {
  const root = mkdtempSync(join(tmpdir(), "clawhandoff-host-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "-q", "--initial-branch=main");
  writeFileSync(join(workspace, "status.mjs"), 'export const statusText = (code) => code === 0 ? "passed" : "failed";\n');
  write(join(workspace, "package.json"), { private: true, scripts: { "test:smoke": "node smoke.mjs" } });
  writeFileSync(join(workspace, ".gitignore"), ".smoke-receipt.json\n");
  writeFileSync(join(workspace, "smoke.mjs"), `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {statusText} from './status.mjs';
assert.equal(statusText(0), 'passed');
assert.equal(statusText(1), 'failed');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const receipt = {commit, sourceRef:commit + ':smoke:' + randomUUID()};
writeFileSync('.smoke-receipt.json', JSON.stringify(receipt));
console.log('PASS', receipt.sourceRef);
`);
  git("add", ".");
  git("-c", "user.name=Acceptance", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  write(join(root, "gateway.json"), { commit, queuedTurnReplies: [reply(false)] });
  const config = join(root, "config.json");
  write(config, {
    dataDir: join(root, "data"), ghCliPath: join(dirname(script), "fake-gh-cli.mjs"),
    targets: { robo: { targetId: "robo", url: "https://fixture.invalid", authMode: "direct-token", agentId: "main", profileDir: join(root, "profile"), cliPath: script } },
  });
  const goal = `Have robo verify statusText in verify_only mode with publisherOwner=none. Set localRepoPath to ${workspace} and pinnedSourceCommitSha to ${commit}. This project has no remote branch. Own the result using the autonomous-handoff prompt.`;
  console.log(JSON.stringify({ workspace, commit, mcpServer: { command: process.execPath, args: [resolve(dirname(script), "../../dist/cli.js"), "--config", config] }, goal, verify: [process.execPath, script, "verify", root] }, null, 2));
} else if (process.argv[2] === "verify") {
  const root = process.argv[3];
  const state = read(join(root, "gateway.json"));
  const receipt = read(join(root, "project", ".smoke-receipt.json"));
  assert.equal(receipt.commit, state.commit);
  const sessions = Object.values(state.sessions);
  assert.equal(sessions.length, 1);
  const messages = sessions[0].messages;
  assert.ok(messages.some((m) => m.role === "assistant" && m.content[0].text.includes(blocker)));
  assert.ok(messages.some((m) => m.role === "user" && m.content.includes(receipt.sourceRef)));
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.ok(messages.at(-1).content[0].text.includes('"disposition":"completed"'));
  const db = new DatabaseSync(join(root, "data", "bridge-state.sqlite"), { readOnly: true });
  try {
    const turns = db.prepare(`SELECT t.directive_json FROM handoff_turns t
      JOIN handoff_sessions s ON t.handoff_id = s.handoff_id
      WHERE s.remote_session_key = ? ORDER BY t.turn_number`).all(sessions[0].key);
    const actions = turns.map((turn) => JSON.parse(turn.directive_json).action);
    assert.equal(actions[0], "CONTINUE_AUTONOMOUSLY");
    assert.equal(actions.at(-1), "COMPLETE");
    console.log(JSON.stringify({ accepted: true, commit: receipt.commit, sessions: sessions.length, actions }));
  } finally {
    db.close();
  }
} else if (process.argv[2] === "gateway") {
  const root = dirname(process.env.OPENCLAW_STATE_DIR);
  const statePath = join(root, "gateway.json");
  process.env.FAKE_GATEWAY_STATE_FILE = statePath;
  if (process.argv[4] === "chat.send") {
    const state = read(statePath);
    const params = JSON.parse(process.argv[process.argv.indexOf("--params") + 1]);
    const receiptPath = join(root, "project", ".smoke-receipt.json");
    const receipt = existsSync(receiptPath) ? read(receiptPath) : undefined;
    const accepted = receipt?.commit === state.commit && params.message.includes(receipt.sourceRef);
    state.queuedTurnReplies = [reply(accepted)];
    write(statePath, state);
  }
  await import("./fake-openclaw-cli.mjs");
} else {
  throw new Error("Expected setup or verify <fixture-directory>.");
}
