import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

const CLI_ENTRYPOINT = resolve(process.cwd(), "dist/cli.js");
const FAKE_OPENCLAW_CLI = resolve(process.cwd(), "test/helpers/fake-openclaw-cli.mjs");
const FAKE_GH_CLI = resolve(process.cwd(), "test/helpers/fake-gh-cli.mjs");

test("MCP Stdio E2E: exposes all 6 tools and autonomous-handoff prompt cleanly over JSON-RPC stdio", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-mcp-e2e-"));
  const stateFile = join(dataDir, "fake-gateway-state.json");
  const configFile = join(dataDir, "bridge-config.json");

  try {
    const baseSha = fixture.commitFile("src/main.ts", "export const ok = 1;\n", "init");
    fixture.git(["push", "origin", "main"]);

    writeFileSync(
      stateFile,
      JSON.stringify({
        rivalPrs: [
          {
            number: 99,
            url: "https://github.com/example/repo/pull/99",
            state: "OPEN",
            title: "Competing fix",
            headRefName: "rival/branch",
          },
        ],
        queuedTurnReplies: [
          {
            pollsBeforeComplete: 2,
            replyText:
              'Done.\n```handoff-result\n{"disposition":"completed","summaryDelta":"All good","blockers":[],"claimedChecks":[]}\n```',
          },
        ],
      }),
    );

    writeFileSync(
      configFile,
      JSON.stringify({
        dataDir,
        ghCliPath: FAKE_GH_CLI,
        targets: {
          robo: {
            targetId: "robo",
            url: "https://gateway.example",
            authMode: "direct-token",
            tokenEnvVar: "TEST_TOKEN",
            agentId: "main",
            cliPath: FAKE_OPENCLAW_CLI,
          },
        },
      }),
    );

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") {
        childEnv[k] = v;
      }
    }
    childEnv.FAKE_GATEWAY_STATE_FILE = stateFile;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_ENTRYPOINT, "--config", configFile],
      env: childEnv,
    });

    const client = new Client({ name: "e2e-test-client", version: "1.0.0" });
    await client.connect(transport);

    try {
      const toolsList = await client.listTools();
      const toolNames = toolsList.tools.map((t) => t.name).sort();
      assert.deepEqual(toolNames, [
        "bridge_handoff_abort",
        "bridge_handoff_attach",
        "bridge_handoff_continue",
        "bridge_handoff_start",
        "bridge_preflight",
        "bridge_verify_git",
      ]);

      const promptsList = await client.listPrompts();
      assert.ok(promptsList.prompts.some((p) => p.name === "autonomous-handoff"));

      // 1) Preflight check
      const preflightRes = await client.callTool({
        name: "bridge_preflight",
        arguments: {
          targetId: "robo",
          repoId: "example/repo",
          issueQuery: "123",
        },
      });
      const preflightText = (preflightRes.content as Array<{ type: string; text: string }>)[0]!.text;
      const preflightJson = JSON.parse(preflightText) as {
        gatewayHealthy: boolean;
        rivalPullRequests: Array<{ number: number }>;
      };
      assert.equal(preflightJson.gatewayHealthy, true);
      assert.equal(preflightJson.rivalPullRequests[0]?.number, 99);

      // 2) Start with waitBudgetMs=0 -> running -> explicit abort
      const startRes = await client.callTool({
        name: "bridge_handoff_start",
        arguments: {
          targetId: "robo",
          waitBudgetMs: 0,
          envelope: {
            schemaVersion: "0.2",
            requestId: "req-mcp-e2e-1",
            workspaceId: "ws-e2e",
            title: "MCP stdio test handoff",
            outcome: "Verify MCP stdio transport.",
            mode: "investigate",
            publisherOwner: "none",
            gitContext: {
              repoId: "example/repo",
              pinnedBaseCommitSha: baseSha,
            },
            requestedCapabilities: {
              allowCodeEdit: false,
              allowBranchPush: false,
              allowManagedPublishStage: false,
            },
            advisoryInstructions: [],
            priorEvidence: [],
            acceptanceCriteria: ["Responds cleanly"],
          },
        },
      });
      const startJson = JSON.parse(
        (startRes.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { handoffId: string; lifecycleStatus: string };
      assert.equal(startJson.lifecycleStatus, "running");

      const abortRes = await client.callTool({
        name: "bridge_handoff_abort",
        arguments: {
          handoffId: startJson.handoffId,
          reason: "E2E test cancellation",
        },
      });
      const abortJson = JSON.parse(
        (abortRes.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as { lifecycleStatus: string };
      assert.equal(abortJson.lifecycleStatus, "aborted");
    } finally {
      await client.close();
    }
  } finally {
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
