import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { loadBridgeConfig, parseBrowserSessionRoute, sameBrowserSessionUrl } from "../src/config.js";

const team = "https://team.example";

function configReader(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "browser-route-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  return (sessionUrl: string, agentId = "roboclaw", basePath?: string) => {
    const target = {
      transport: "browser", targetId: "robo", agentId, sessionUrl, basePath,
      browserMcp: { command: "node" },
    };
    writeFileSync(path, JSON.stringify({ targets: { robo: target } }));
    return loadBridgeConfig(path).targets.robo?.transport;
  };
}

test("browser target config accepts OpenClaw multi-segment session URLs and rejects invalid ones", (t) => {
  const read = configReader(t);
  for (const validUrl of [
    "https://team.example/chat/roboclaw/verify-linux-00112233445566778899aabbccddeeff",
    "https://team.example/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f",
    "https://team.example/dashboard/roboclaw/33257e49-0012-426e-80ab-6ba8f8eb881f",
    "https://team.example/chat/roboclaw/~key/subagent/run-42",
    "https://team.example/ui/chat/roboclaw/dashboard/33257e49-0012-426e-80ab-6ba8f8eb881f",
  ]) {
    assert.equal(read(validUrl), "browser", validUrl);
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
    assert.throws(() => read(invalidUrl), /Invalid bridge config/, invalidUrl);
  }
});

test("OpenClaw session links preserve punctuation left literal by encodeURIComponent", (t) => {
  const read = configReader(t);
  assert.equal(read(team + "/ui/chat/roboclaw/release(qa)", "roboclaw"), "browser");
  const key = "today's run!(1)*";
  assert.equal(read(team + "/chat/roboclaw/~key/" + encodeURIComponent(key), "roboclaw"), "browser");
});

test("an ambiguous session URL requires the deployment base path, independently of the configured agent", (t) => {
  const read = configReader(t);
  const url = team + "/dashboard/chat/roboclaw/topic";
  for (const agent of ["chat", "roboclaw"]) assert.throws(() => read(url, agent), /basePath/);
  assert.equal(read(url, "roboclaw", "/dashboard"), "browser");
  assert.throws(() => read(url, "chat", "/dashboard"), /Invalid bridge config/);
  assert.equal(read(url, "chat", "/"), "browser");
  assert.throws(() => read(url, "roboclaw", "/"), /Invalid bridge config/);
});

test("literal session namespaces cannot override an explicit deployment base path", (t) => {
  const read = configReader(t);
  const url = team + "/ui/chat/roboclaw/~key/dashboard/other/topic";
  assert.equal(read(url, "roboclaw", "/ui/"), "browser");
  assert.throws(() => read(url, "other", "/ui"), /Invalid bridge config/);
  assert.throws(() => read(url, "roboclaw", "/u"), /Invalid bridge config/);
  assert.throws(() => read(url, "other"), /basePath/);
  assert.throws(() => read(team + "/ui/chat/roboclaw/topic", "roboclaw", "/ui//"), /Invalid bridge config/);
  assert.equal(read(team + "/chat/roboclaw/dashboard/session-id", "roboclaw"), "browser");
  assert.throws(() => read(team + "/chat/roboclaw/topic?", "roboclaw"), /Invalid bridge config/);
  assert.throws(() => read(team + "/chat/roboclaw/topic#", "roboclaw"), /Invalid bridge config/);
});

test("32-hex UUID browser session routes tolerate display-slug replacement without relaxing session identity", () => {
  const initial = `${team}/chat/roboclaw/clawhandoff-session-4f99c346fa5d4daea8d9ba738d8bae4d`;
  const retitled = `${team}/chat/roboclaw/distinguish-workflow-policy-refusal-4f99c346fa5d4daea8d9ba738d8bae4d`;
  const bareUuid = `${team}/chat/roboclaw/4f99c346fa5d4daea8d9ba738d8bae4d`;
  assert.equal(sameBrowserSessionUrl(initial, retitled), true);
  assert.equal(sameBrowserSessionUrl(initial, bareUuid), true);
  assert.deepEqual(parseBrowserSessionRoute(initial)?.uuidRoute, {
    prefix: `${team}/chat/roboclaw/`,
    uuid: "4f99c346fa5d4daea8d9ba738d8bae4d",
  });
  for (const distinct of [
    `${team}/dashboard/roboclaw/distinguish-workflow-policy-refusal-4f99c346fa5d4daea8d9ba738d8bae4d`,
    `${team}/chat/other/distinguish-workflow-policy-refusal-4f99c346fa5d4daea8d9ba738d8bae4d`,
    `${team}/chat/roboclaw/~key/distinguish-workflow-policy-refusal-4f99c346fa5d4daea8d9ba738d8bae4d`,
    `${team}/chat/roboclaw/distinguish-workflow-policy-refusal-99999999fa5d4daea8d9ba738d8bae4d`,
    `${team}/chat/roboclaw/distinguish-workflow-policy-refusal-4f99c346fa5d4daea8d9ba738d8bae4d?x=1`,
  ]) {
    assert.equal(sameBrowserSessionUrl(initial, distinct), false, distinct);
  }
  // Short 8-hex prefixes rely on slugHint tie-breaking and stay exact.
  assert.equal(
    sameBrowserSessionUrl(`${team}/chat/roboclaw/old-title-4f99c346`, `${team}/chat/roboclaw/new-title-4f99c346`),
    false,
  );
});
