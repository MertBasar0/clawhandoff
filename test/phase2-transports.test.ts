import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BridgeService, loadBridgeConfig, resolveAcpLaunchCommand } from "../src/index.js";
import { BridgeError, type HandoffEnvelopeV2, type HandoffResultEnvelopeV2 } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

const FAKE_GH_CLI = resolve(process.cwd(), "test/helpers/fake-gh-cli.mjs");
const FAKE_CODEX_SERVER = resolve(process.cwd(), "test/helpers/fake-codex-app-server.mjs");
const FAKE_ACP_AGENT = resolve(process.cwd(), "test/helpers/fake-acp-agent.mjs");

function formatResultBlock(payload: Record<string, unknown>): string {
  return `Completed step.\n\`\`\`handoff-result\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("A2A v1.0 & v0.3 HTTP/JSON-RPC: Agent Card discovery, Bearer auth, INPUT_REQUIRED loop, crash recovery via ListTasks, remote_gated publish, and CancelTask", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-a2a-"));
  const ghStateFile = join(dataDir, "fake-gh-state.json");
  const prevGhEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  const prevTokenEnv = process.env.TEST_A2A_BEARER_TOKEN;
  process.env.FAKE_GATEWAY_STATE_FILE = ghStateFile;

  const baseSha = fixture.commitFile("src/core.ts", "export const v = 1;\n", "base commit");
  const lockCommitSha = fixture.commitFile("SECURITY.md", "locked policy\n", "add locked file");
  fixture.git(["push", "origin", "main"]);

  const candidateBranch = "a2a/fix-branch";
  fixture.git(["checkout", "-b", candidateBranch]);
  const candidateSha = fixture.commitFile("src/core.ts", "export const v = 2;\n", "implement fix");
  fixture.git(["push", "origin", candidateBranch]);
  fixture.git(["checkout", "main"]);

  writeFileSync(ghStateFile, JSON.stringify({ openPrs: [] }), "utf8");

  interface StoredA2ATask {
    id: string;
    contextId: string;
    pollsRemaining: number;
    targetState: string;
    replyText: string;
    history: Array<Record<string, unknown>>;
    canceled?: boolean;
  }

  const v1Tasks = new Map<string, StoredA2ATask>();
  const v03Tasks = new Map<string, StoredA2ATask>();
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
  let v1TurnCounter = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    seenHeaders.push(req.headers);

    // Enforce Bearer auth on /v1/* endpoints
    if (url.startsWith("/v1")) {
      if (req.headers.authorization !== "Bearer secret-a2a-token-123") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (req.method === "GET" && url === "/v1/.well-known/agent-card.json") {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "Remote A2A Reviewer v1",
          version: "1.2.0",
          capabilities: { streaming: false },
          supportedInterfaces: [
            {
              url: `http://127.0.0.1:${addr.port}/v1/rpc`,
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
            },
          ],
        }),
      );
      return;
    }

    // v0.3 legacy card fallback (/.well-known/agent-card.json -> 404, /.well-known/agent.json -> 200)
    if (req.method === "GET" && url === "/v03/.well-known/agent.json") {
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "Legacy A2A Agent v0.3",
          version: "0.3.0",
          protocolVersion: "0.3.0",
          preferredTransport: "JSONRPC",
          url: `http://127.0.0.1:${addr.port}/v03/rpc`,
        }),
      );
      return;
    }

    if (req.method === "POST" && url === "/v1/rpc") {
      assert.equal(req.headers["a2a-version"], "1.0");
      const body = await readJsonBody(req);
      const rpcId = body.id;
      const method = body.method;
      const params = (body.params ?? {}) as Record<string, unknown>;

      if (method === "SendMessage") {
        const msg = params.message as Record<string, unknown>;
        assert.equal(msg.role, "ROLE_USER");
        v1TurnCounter += 1;
        const taskId = `a2a_task_${v1TurnCounter}`;
        const contextId = (msg.contextId as string | undefined) ?? "ctx_v1_shared";

        let targetState = "TASK_STATE_COMPLETED";
        let replyText = "";
        let pollsRemaining = 1;

        if (v1TurnCounter === 1) {
          // Turn 1 enters TASK_STATE_INPUT_REQUIRED with a plain-text question (no handoff-result fence!)
          targetState = "TASK_STATE_INPUT_REQUIRED";
          replyText = "Please provide the local Windows smoke receipt for locked commit before I push.";
          pollsRemaining = 1;
        } else if (v1TurnCounter === 2) {
          targetState = "TASK_STATE_COMPLETED";
          replyText = formatResultBlock({
            disposition: "ready_for_publish_gate",
            candidateCommitSha: candidateSha,
            candidateRef: `refs/heads/${candidateBranch}`,
            summaryDelta: "Verified smoke receipt and pushed clean Stage-1 candidate branch.",
            blockers: [],
            claimedChecks: [{ command: "pnpm test", exitCode: 0, environment: "linux" }],
          });
          pollsRemaining = 0;
        } else if (v1TurnCounter === 3) {
          // Stage 2 managed publish!
          writeFileSync(
            ghStateFile,
            JSON.stringify({
              openPrs: [
                {
                  number: 402,
                  url: "https://github.com/example/repo/pull/402",
                  state: "OPEN",
                  headRefName: candidateBranch,
                  headRefOid: candidateSha,
                  body: "Managed PR",
                },
              ],
            }),
            "utf8",
          );
          targetState = "TASK_STATE_COMPLETED";
          replyText = formatResultBlock({
            disposition: "completed",
            candidateCommitSha: candidateSha,
            candidateRef: `refs/heads/${candidateBranch}`,
            prUrl: "https://github.com/example/repo/pull/402",
            summaryDelta: "Opened draft PR #402 for verified commit.",
            blockers: [],
            claimedChecks: [],
          });
          pollsRemaining = 0;
        } else {
          // Long-running task for CancelTask test
          targetState = "TASK_STATE_WORKING";
          replyText = "";
          pollsRemaining = 999;
        }

        const stored: StoredA2ATask = {
          id: taskId,
          contextId,
          pollsRemaining,
          targetState,
          replyText,
          history: [msg],
        };
        v1Tasks.set(taskId, stored);

        const immediateState = pollsRemaining > 0 ? "TASK_STATE_WORKING" : targetState;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              task: {
                id: taskId,
                contextId,
                status: {
                  state: immediateState,
                  ...(immediateState !== "TASK_STATE_WORKING" && replyText
                    ? { message: { role: "ROLE_AGENT", parts: [{ text: replyText }] } }
                    : {}),
                },
                history: stored.history,
              },
            },
          }),
        );
        return;
      }

      if (method === "GetTask") {
        const task = v1Tasks.get(String(params.id));
        if (!task) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32001, message: "Task not found" } }));
          return;
        }
        if (task.pollsRemaining > 0) task.pollsRemaining -= 1;
        const currentState = task.canceled
          ? "TASK_STATE_CANCELED"
          : task.pollsRemaining > 0
            ? "TASK_STATE_WORKING"
            : task.targetState;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              id: task.id,
              contextId: task.contextId,
              status: {
                state: currentState,
                ...(currentState !== "TASK_STATE_WORKING" && task.replyText
                  ? { message: { role: "ROLE_AGENT", parts: [{ text: task.replyText }] } }
                  : {}),
              },
              history: task.history,
            },
          }),
        );
        return;
      }

      if (method === "ListTasks") {
        const list = [...v1Tasks.values()]
          .filter((t) => !params.contextId || t.contextId === params.contextId)
          .map((t) => ({
            id: t.id,
            contextId: t.contextId,
            status: {
              state: t.canceled ? "TASK_STATE_CANCELED" : t.targetState,
              ...(t.replyText ? { message: { role: "ROLE_AGENT", parts: [{ text: t.replyText }] } } : {}),
            },
            history: t.history,
          }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: { tasks: list } }));
        return;
      }

      if (method === "CancelTask") {
        const task = v1Tasks.get(String(params.id));
        if (!task) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32001, message: "Task not found" } }));
          return;
        }
        task.canceled = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              id: task.id,
              contextId: task.contextId,
              status: { state: "TASK_STATE_CANCELED" },
            },
          }),
        );
        return;
      }
    }

    if (req.method === "POST" && url === "/v03/rpc") {
      const body = await readJsonBody(req);
      const rpcId = body.id;
      const method = body.method;
      const params = (body.params ?? {}) as Record<string, unknown>;

      if (method === "message/send") {
        const msg = params.message as Record<string, unknown>;
        assert.equal(msg.role, "user");
        const taskId = "v03_task_1";
        const replyText = formatResultBlock({
          disposition: "completed",
          candidateCommitSha: lockCommitSha,
          candidateRef: "refs/heads/main",
          summaryDelta: "Legacy A2A v0.3 verification passed.",
          blockers: [],
          claimedChecks: [{ command: "pytest", exitCode: 0, environment: "linux" }],
        });
        v03Tasks.set(taskId, {
          id: taskId,
          contextId: "ctx_v03",
          pollsRemaining: 1,
          targetState: "completed",
          replyText,
          history: [msg],
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              kind: "task",
              id: taskId,
              contextId: "ctx_v03",
              status: { state: "working" },
            },
          }),
        );
        return;
      }

      if (method === "tasks/get") {
        const task = v03Tasks.get(String(params.id))!;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              kind: "task",
              id: task.id,
              contextId: task.contextId,
              status: { state: "completed" },
              artifacts: [{ artifactId: "art_1", parts: [{ kind: "text", text: task.replyText }] }],
            },
          }),
        );
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;

  let activeService: BridgeService | undefined;
  try {
    const config = {
      dataDir,
      ghCliPath: FAKE_GH_CLI,
      targets: {
        "a2a-v1": {
          transport: "a2a" as const,
          targetId: "a2a-v1",
          url: `http://127.0.0.1:${port}/v1`,
          authTokenEnvVar: "TEST_A2A_BEARER_TOKEN",
        },
        "a2a-v03": {
          transport: "a2a" as const,
          targetId: "a2a-v03",
          url: `http://127.0.0.1:${port}/v03`,
        },
      },
    };

    const service = new BridgeService(config);
    activeService = service;

    // 1) Missing token env var -> preflight reports authReady: false with remediation
    delete process.env.TEST_A2A_BEARER_TOKEN;
    const pfUnauth = await service.preflight({ targetId: "a2a-v1" });
    assert.equal(pfUnauth.transport, "a2a");
    assert.equal(pfUnauth.authReady, false);
    assert.match(pfUnauth.remediation ?? "", /TEST_A2A_BEARER_TOKEN/);

    // 2) Valid token -> preflight discovers v1.0 Agent Card
    process.env.TEST_A2A_BEARER_TOKEN = "secret-a2a-token-123";
    const pfOk = await service.preflight({ targetId: "a2a-v1" });
    assert.equal(pfOk.targetHealthy, true);
    assert.equal(pfOk.authReady, true);
    assert.equal(pfOk.agentCard?.protocolVersion, "1.0");
    assert.equal(pfOk.agentCard?.name, "Remote A2A Reviewer v1");

    // 3) Start handoff with waitBudgetMs: 0 -> returns running (POLL_ATTACH), then attach -> INPUT_REQUIRED -> CONTINUE_AUTONOMOUSLY
    const envelope: HandoffEnvelopeV2 = {
      schemaVersion: "0.2",
      requestId: "a2a-e2e-1",
      workspaceId: "ws-a2a",
      title: "Implement core v2 via A2A",
      outcome: "Prepare verified branch and open managed PR.",
      mode: "implement",
      publisherOwner: "remote_gated",
      gitContext: {
        repoId: "example/repo",
        localRepoPath: fixture.workRepoDir,
        remoteUrlOrPath: fixture.originBareDir,
        pinnedBaseCommitSha: baseSha,
        pinnedSourceCommitSha: lockCommitSha,
        lockedPaths: ["SECURITY.md"],
      },
      requestedCapabilities: {
        allowCodeEdit: true,
        allowBranchPush: true,
        allowManagedPublishStage: false,
      },
      advisoryInstructions: [],
      priorEvidence: [],
      acceptanceCriteria: ["SECURITY.md untouched", "PR opened"],
    };

    const started = await service.startHandoff({
      targetId: "a2a-v1",
      envelope,
      waitBudgetMs: 0,
    });
    assert.equal(started.lifecycleStatus, "running");
    assert.equal(started.orchestratorDirective.action, "POLL_ATTACH");

    const turn1Settled = await service.attachHandoff({
      handoffId: started.handoffId,
      waitBudgetMs: 2_000,
    });
    assert.equal(turn1Settled.lifecycleStatus, "settled");
    assert.equal(turn1Settled.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");
    assert.match(turn1Settled.reported?.blockers[0] ?? "", /Windows smoke receipt/);

    // 4) Turn 2: Continue with evidence -> ready_for_publish_gate -> GitVerifier unlocks AUTHORIZE_REMOTE_PUBLISH
    const turn2 = await service.continueHandoff({
      handoffId: started.handoffId,
      intent: "counter_evidence_or_followup",
      message: "Windows smoke passed on locked commit.",
      evidenceRefs: [{ claim: "Windows smoke green", sourceRef: `win-smoke:${lockCommitSha}` }],
      waitBudgetMs: 2_000,
    });
    assert.equal(turn2.observed.lockedPathsClean, true);
    assert.equal(turn2.observed.observedHeadSha, candidateSha);
    assert.equal(turn2.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

    // Simulate crash recovery via ListTasks: reset Turn 2 in SQLite to uncertain + NULL run_id and verify attach recovers without resending!
    await service.close();
    activeService = undefined;
    const rawDb = new DatabaseSync(join(dataDir, "bridge-state.sqlite"));
    rawDb
      .prepare("UPDATE handoff_turns SET dispatch_state = 'uncertain', run_id = NULL, observed_json = NULL, directive_json = NULL WHERE handoff_id = ? AND turn_number = 2")
      .run(started.handoffId);
    rawDb
      .prepare("UPDATE handoff_sessions SET lifecycle_status = 'uncertain' WHERE handoff_id = ?")
      .run(started.handoffId);
    rawDb.close();

    const serviceAfterCrash = new BridgeService(config);
    activeService = serviceAfterCrash;
    const recoveredTurn2 = await serviceAfterCrash.attachHandoff({
      handoffId: started.handoffId,
      waitBudgetMs: 2_000,
    });
    assert.equal(v1TurnCounter, 2, "Crash recovery via ListTasks must NOT send a duplicate A2A message");
    assert.equal(recoveredTurn2.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

    // 5) Stage 2 authorize_publish -> COMPLETE with open_verified PR!
    const published = await serviceAfterCrash.continueHandoff({
      handoffId: started.handoffId,
      intent: "authorize_publish",
      message: "Authorized Stage-2 PR creation.",
      waitBudgetMs: 2_000,
    });
    assert.equal(published.observed.reconciledPrState, "open_verified");
    assert.equal(published.observed.reconciledPrUrl, "https://github.com/example/repo/pull/402");
    assert.equal(published.orchestratorDirective.action, "COMPLETE");

    // 6) CancelTask abort on active A2A task
    const cancelTarget = await serviceAfterCrash.startHandoff({
      targetId: "a2a-v1",
      envelope: {
        ...envelope,
        requestId: "a2a-cancel-1",
        publisherOwner: "none",
      },
      waitBudgetMs: 0,
    });
    assert.equal(cancelTarget.lifecycleStatus, "running");
    const aborted = await serviceAfterCrash.abortHandoff({ handoffId: cancelTarget.handoffId });
    assert.equal(aborted.lifecycleStatus, "aborted");

    // 7) Legacy A2A v0.3 fallback (/.well-known/agent.json + message/send + tasks/get)
    const pfV03 = await serviceAfterCrash.preflight({ targetId: "a2a-v03" });
    assert.equal(pfV03.agentCard?.protocolVersion, "0.3");
    const v03Res = await serviceAfterCrash.startHandoff({
      targetId: "a2a-v03",
      envelope: {
        ...envelope,
        requestId: "a2a-v03-1",
        mode: "verify_only",
        publisherOwner: "none",
        requestedCapabilities: {
          allowCodeEdit: false,
          allowBranchPush: false,
          allowManagedPublishStage: false,
        },
      },
      waitBudgetMs: 2_000,
    });
    assert.equal(v03Res.lifecycleStatus, "settled");
    assert.equal(v03Res.orchestratorDirective.action, "COMPLETE");

    await serviceAfterCrash.close();
    activeService = undefined;
  } finally {
    await activeService?.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (prevGhEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = prevGhEnv;
    if (prevTokenEnv === undefined) delete process.env.TEST_A2A_BEARER_TOKEN;
    else process.env.TEST_A2A_BEARER_TOKEN = prevTokenEnv;
    rmSync(dataDir, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("Codex app-server --stdio: preflight, isolated worktreeName, server approval RPC, clientId crash recovery, Stage-2 publish, and turn/interrupt", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-codex-"));
  const codexStateFile = join(dataDir, "codex-state.json");
  const ghStateFile = join(dataDir, "gh-state.json");
  const prevGhEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.FAKE_GATEWAY_STATE_FILE = ghStateFile;
  delete process.env.OPENAI_API_KEY;

  let activeCodexService: BridgeService | undefined;
  try {
    const baseSha = fixture.commitFile("src/app.ts", "export const mode = 'v1';\n", "base");
    const lockedSha = fixture.commitFile("LOCKED.txt", "do not touch\n", "lock baseline");
    fixture.git(["push", "origin", "main"]);

    // Dirty the primary working tree to prove Codex runs inside an isolated detached worktree!
    const dirtyPrimaryPath = join(fixture.workRepoDir, "src/app.ts");
    writeFileSync(dirtyPrimaryPath, "UNCOMMITTED_PRIMARY_WORKTREE_EDIT\n", "utf8");

    writeFileSync(ghStateFile, JSON.stringify({ openPrs: [] }), "utf8");
    writeFileSync(
      codexStateFile,
      JSON.stringify({
        requiresOpenaiAuth: true,
        account: null,
        threads: {},
        queuedReplies: [],
        approvalsReceived: [],
        interruptedTurns: [],
        startTurnCount: 0,
      }),
      "utf8",
    );

    const makeConfig = () => ({
      dataDir,
      ghCliPath: FAKE_GH_CLI,
      targets: {
        "codex-local": {
          transport: "codex" as const,
          targetId: "codex-local",
          command: process.execPath,
          args: [FAKE_CODEX_SERVER, codexStateFile],
          cwd: fixture.workRepoDir,
          approvalPolicy: "never" as const,
          sandbox: "workspace-write" as const,
        },
      },
    });

    const service1 = new BridgeService(makeConfig());
    activeCodexService = service1;

    // 1) Preflight detects missing OpenAI auth cleanly
    const pfNoAuth = await service1.preflight({ targetId: "codex-local" });
    assert.equal(pfNoAuth.transport, "codex");
    assert.equal(pfNoAuth.targetHealthy, true);
    assert.equal(pfNoAuth.authReady, false);

    // Enable auth + queue Turn 1 (commits in isolated worktree & requests command approval) and Turn 2 (Stage 2 PR)
    writeFileSync(
      codexStateFile,
      JSON.stringify({
        requiresOpenaiAuth: true,
        account: { type: "chatgpt", email: "dev@example.com" },
        threads: {},
        approvalsReceived: [],
        interruptedTurns: [],
        startTurnCount: 0,
        queuedReplies: [
          {
            delayMs: 120,
            requestCommandApproval: true,
            gitAction: {
              branch: "codex/isolated-fix",
              file: "src/app.ts",
              content: "export const mode = 'v2-from-codex-worktree';\n",
              commitMessage: "feat: update mode in isolated worktree",
              pushRemote: fixture.originBareDir,
            },
            replyText: formatResultBlock({
              disposition: "ready_for_publish_gate",
              candidateCommitSha: "__WORKTREE_HEAD_SHA__",
              candidateRef: "refs/heads/codex/isolated-fix",
              summaryDelta: "Implemented fix inside isolated Codex worktree.",
              blockers: [],
              claimedChecks: [{ command: "pnpm test", exitCode: 0, environment: "windows" }],
            }),
          },
          {
            delayMs: 30,
            ghStateFile,
            writeGhState: {
              openPrs: [
                {
                  number: 501,
                  url: "https://github.com/example/repo/pull/501",
                  state: "OPEN",
                  headRefName: "codex/isolated-fix",
                  headRefOid: "__WORKTREE_HEAD_SHA__",
                  body: "Codex PR",
                },
              ],
            },
            replyText: formatResultBlock({
              disposition: "completed",
              candidateCommitSha: "__WORKTREE_HEAD_SHA__",
              candidateRef: "refs/heads/codex/isolated-fix",
              prUrl: "https://github.com/example/repo/pull/501",
              summaryDelta: "Created managed PR #501.",
              blockers: [],
              claimedChecks: [],
            }),
          },
          {
            delayMs: 10_000,
            replyText: "Long running turn to interrupt",
          },
        ],
      }),
      "utf8",
    );

    const pfReady = await service1.preflight({ targetId: "codex-local" });
    assert.equal(pfReady.authReady, true);

    const envelope: HandoffEnvelopeV2 = {
      schemaVersion: "0.2",
      requestId: "codex-wt-1",
      workspaceId: "ws-codex",
      title: "Fix mode in isolated worktree",
      outcome: "Commit clean fix without touching LOCKED.txt or primary dirty tree.",
      mode: "implement",
      publisherOwner: "remote_gated",
      gitContext: {
        repoId: "example/repo",
        localRepoPath: fixture.workRepoDir,
        remoteUrlOrPath: fixture.originBareDir,
        pinnedBaseCommitSha: baseSha,
        pinnedSourceCommitSha: lockedSha,
        lockedPaths: ["LOCKED.txt"],
      },
      requestedCapabilities: {
        allowCodeEdit: true,
        allowBranchPush: true,
        allowManagedPublishStage: false,
      },
      advisoryInstructions: [],
      priorEvidence: [],
      acceptanceCriteria: ["Isolated worktree commit verified"],
    };

    // 2) Start with waitBudgetMs: 0 -> returns POLL_ATTACH while Turn 1 runs in isolated worktree
    const started = await service1.startHandoff({
      targetId: "codex-local",
      envelope,
      worktreeName: "iso-branch",
      waitBudgetMs: 0,
    });
    assert.equal(started.lifecycleStatus, "running");
    assert.equal(started.orchestratorDirective.action, "POLL_ATTACH");

    const expectedWtDir = join(dataDir, "worktrees", `${started.handoffId}-iso-branch`);
    assert.equal(existsSync(expectedWtDir), true, "Isolated git worktree must exist");
    assert.equal(
      readFileSync(dirtyPrimaryPath, "utf8"),
      "UNCOMMITTED_PRIMARY_WORKTREE_EDIT\n",
      "Primary working tree dirty file must remain untouched",
    );

    // Wait deterministically until fake-codex-app-server persists Turn 1 completion on disk,
    // then simulate a Bridge crash where run_id was lost (`uncertain`)!
    const waitDeadline = Date.now() + 8_000;
    while (Date.now() < waitDeadline) {
      const diskState = JSON.parse(readFileSync(codexStateFile, "utf8")) as {
        threads?: Record<string, { turns?: Array<{ status?: string }> }>;
      };
      if (diskState.threads?.thr_1?.turns?.[0]?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await service1.close();
    activeCodexService = undefined;

    const db = new DatabaseSync(join(dataDir, "bridge-state.sqlite"));
    db.prepare("UPDATE handoff_turns SET dispatch_state = 'uncertain', run_id = NULL WHERE handoff_id = ? AND turn_number = 1").run(
      started.handoffId,
    );
    db.prepare("UPDATE handoff_sessions SET lifecycle_status = 'uncertain' WHERE handoff_id = ?").run(started.handoffId);
    db.close();

    // 3) Restart BridgeService: attach recovers exact turn via thread/read + clientUserMessageId (`clientId`) with zero duplicate turns!
    const service2 = new BridgeService(makeConfig());
    activeCodexService = service2;
    const settled1 = await service2.attachHandoff({
      handoffId: started.handoffId,
      waitBudgetMs: 2_000,
    });
    assert.equal(settled1.lifecycleStatus, "settled");
    assert.equal(settled1.observed.lockedPathsClean, true);
    assert.equal(settled1.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

    const codexStateAfterTurn1 = JSON.parse(readFileSync(codexStateFile, "utf8")) as {
      startTurnCount: number;
      approvalsReceived: Array<{ decision: string }>;
    };
    assert.equal(codexStateAfterTurn1.startTurnCount, 1, "Must not duplicate turn/start on clientId recovery");
    assert.equal(codexStateAfterTurn1.approvalsReceived[0]?.decision, "acceptForSession");

    const published = await service2.continueHandoff({
      handoffId: started.handoffId,
      intent: "authorize_publish",
      message: "Proceed with Stage-2 PR.",
      waitBudgetMs: 2_000,
    });
    assert.equal(published.orchestratorDirective.action, "COMPLETE");
    assert.equal(published.observed.reconciledPrState, "open_verified");

    // 4) Test turn/interrupt via bridge_handoff_abort
    const interruptible = await service2.startHandoff({
      targetId: "codex-local",
      envelope: {
        ...envelope,
        requestId: "codex-interrupt-1",
        publisherOwner: "none",
      },
      waitBudgetMs: 0,
    });
    assert.equal(interruptible.lifecycleStatus, "running");
    const aborted = await service2.abortHandoff({ handoffId: interruptible.handoffId });
    assert.equal(aborted.lifecycleStatus, "aborted");
    const finalCodexState = JSON.parse(readFileSync(codexStateFile, "utf8")) as { interruptedTurns: string[] };
    assert.equal(finalCodexState.interruptedTurns.length, 1);

    await service2.close();
    activeCodexService = undefined;
  } finally {
    await activeCodexService?.close();
    if (prevGhEnv === undefined) delete process.env.FAKE_GATEWAY_STATE_FILE;
    else process.env.FAKE_GATEWAY_STATE_FILE = prevGhEnv;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
    rmSync(dataDir, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("ACP stdio over MCP E2E: agent presets, isolated worktree, permissionMode gating, session/load replay suppression across restart, and session/cancel", async () => {
  // 1) Verify built-in ACP preset command resolution & config schema validation
  assert.equal(resolveAcpLaunchCommand({ transport: "acp", targetId: "c", agent: "claude" }).agentLabel, "claude");
  assert.deepEqual(resolveAcpLaunchCommand({ transport: "acp", targetId: "g", agent: "gemini" }).args, ["--acp"]);
  assert.deepEqual(resolveAcpLaunchCommand({ transport: "acp", targetId: "cu", agent: "cursor" }).command, "cursor-agent");
  assert.deepEqual(resolveAcpLaunchCommand({ transport: "acp", targetId: "cp", agent: "copilot" }).args, [
    "--acp",
    "--stdio",
  ]);
  assert.throws(
    () => resolveAcpLaunchCommand({ transport: "acp", targetId: "empty" }),
    (err: unknown) => err instanceof BridgeError && err.code === "INVALID_INPUT",
  );

  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "clawhandoff-acp-"));
  const acpStateFile = join(dataDir, "acp-state.json");
  const configPath = join(dataDir, "bridge-acp.json");

  const baseSha = fixture.commitFile("src/widget.ts", "export const w = 1;\n", "base widget");
  fixture.git(["push", "origin", "main"]);

  writeFileSync(
    acpStateFile,
    JSON.stringify({
      sessions: {},
      permissionOutcomes: [],
      loadedSessions: [],
      cancelledSessions: [],
      setModes: [],
      setModels: [],
      queuedPrompts: [
        {
          delayMs: 60,
          permissionRequests: [
            { kind: "read", title: "read: src/widget.ts" },
            { kind: "edit", title: "edit: src/widget.ts" },
          ],
          replyText: formatResultBlock({
            disposition: "needs_evidence",
            summaryDelta: "Need confirmation of target widget version before committing.",
            blockers: ["Confirm widget version v2"],
            claimedChecks: [],
          }),
        },
        {
          delayMs: 60,
          gitAction: {
            branch: "acp/widget-v2",
            file: "src/widget.ts",
            content: "export const w = 2;\n",
            commitMessage: "feat: widget v2 via ACP",
            pushRemote: fixture.originBareDir,
          },
          replyText: formatResultBlock({
            disposition: "completed",
            candidateCommitSha: "__WORKTREE_HEAD_SHA__",
            candidateRef: "refs/heads/acp/widget-v2",
            summaryDelta: "Committed and pushed widget v2 from isolated ACP worktree.",
            blockers: [],
            claimedChecks: [{ command: "node --test", exitCode: 0, environment: "windows" }],
          }),
        },
        {
          delayMs: 10_000,
          replyText: "Long ACP prompt to cancel",
        },
      ],
    }),
    "utf8",
  );

  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      ghCliPath: FAKE_GH_CLI,
      defaultPublisherOwner: "local",
      targets: {
        "claude-acp": {
          transport: "acp",
          targetId: "claude-acp",
          agent: "claude",
          command: process.execPath,
          args: [FAKE_ACP_AGENT, acpStateFile],
          cwd: fixture.workRepoDir,
          modeId: "architect",
          model: "claude-sonnet-4-6",
          permissionMode: "approve-reads",
        },
      },
    }),
    "utf8",
  );

  // Validate loadBridgeConfig parses ACP target cleanly
  const loadedCfg = loadBridgeConfig(configPath);
  assert.equal(loadedCfg.targets["claude-acp"]?.transport, "acp");

  async function connectMcp() {
    const mcpClient = new Client({ name: "acp-e2e-client", version: "1.0.0" });
    await mcpClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/cli.js"), "--config", configPath],
      }),
    );
    return mcpClient;
  }

  let client = await connectMcp();
  async function invoke<T = HandoffResultEnvelopeV2>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text?: string }>).find((p) => p.type === "text")?.text;
    assert.ok(text);
    assert.ok(!res.isError, text);
    return JSON.parse(text) as T;
  }

  try {
    const pf = await invoke<{ transport: string; targetHealthy: boolean; availableAgentIds: string[] }>(
      "bridge_preflight",
      { targetId: "claude-acp" },
    );
    assert.equal(pf.transport, "acp");
    assert.equal(pf.targetHealthy, true);
    assert.deepEqual(pf.availableAgentIds, ["claude"]);

    // Turn 1 with isolated worktreeName
    const turn1 = await invoke("bridge_handoff_start", {
      targetId: "claude-acp",
      worktreeName: "acp-wt",
      waitBudgetMs: 3_000,
      envelope: {
        schemaVersion: "0.2",
        requestId: "acp-e2e-1",
        workspaceId: "ws-acp",
        title: "Upgrade widget via ACP",
        outcome: "Commit widget v2 in isolated worktree.",
        mode: "implement",
        publisherOwner: "local",
        gitContext: {
          repoId: "example/widget",
          localRepoPath: fixture.workRepoDir,
          remoteUrlOrPath: fixture.originBareDir,
          pinnedBaseCommitSha: baseSha,
        },
        requestedCapabilities: {
          allowCodeEdit: true,
          allowBranchPush: true,
          allowManagedPublishStage: false,
        },
        acceptanceCriteria: ["Widget v2 pushed cleanly"],
      },
    });
    assert.equal(turn1.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");

    // Verify permissionMode: "approve-reads" approved "read" and rejected "edit"!
    const stateAfterT1 = JSON.parse(readFileSync(acpStateFile, "utf8")) as {
      permissionOutcomes: Array<{ kind: string; outcome: { outcome: string; optionId: string } }>;
    };
    assert.equal(stateAfterT1.permissionOutcomes[0]?.kind, "read");
    assert.equal(stateAfterT1.permissionOutcomes[0]?.outcome.optionId, "allow_always");
    assert.equal(stateAfterT1.permissionOutcomes[1]?.kind, "edit");
    assert.equal(stateAfterT1.permissionOutcomes[1]?.outcome.optionId, "reject_once");

    // Restart the MCP bridge process to force ACP `session/load` + historical chunk replay suppression on Turn 2!
    await client.close();
    client = await connectMcp();

    const turn2 = await invoke("bridge_handoff_continue", {
      handoffId: turn1.handoffId,
      intent: "counter_evidence_or_followup",
      message: "Confirmed widget v2 spec.",
      evidenceRefs: [{ claim: "Spec v2 approved", sourceRef: `spec:${baseSha}:v2` }],
      waitBudgetMs: 3_000,
    });
    assert.equal(turn2.lifecycleStatus, "settled");
    assert.equal(turn2.observed.reachableRefVerified, true);
    assert.equal(turn2.observed.baseIsAncestor, true);
    assert.equal(turn2.orchestratorDirective.action, "PUBLISH_LOCALLY");
    assert.ok(
      !turn2.reported?.summaryDelta.includes("[REPLAYED_HISTORY]"),
      "session/load replayed chunks must be suppressed",
    );

    const stateAfterT2 = JSON.parse(readFileSync(acpStateFile, "utf8")) as { loadedSessions: string[] };
    assert.equal(stateAfterT2.loadedSessions.length, 1, "Turn 2 after restart must resume via session/load");

    // Primary repo widget.ts must still have v1 while worktree pushed v2!
    assert.equal(readFileSync(join(fixture.workRepoDir, "src/widget.ts"), "utf8"), "export const w = 1;\n");

    // Verify session/cancel notification on bridge_handoff_abort
    const runningTurn = await invoke("bridge_handoff_start", {
      targetId: "claude-acp",
      waitBudgetMs: 0,
      envelope: {
        schemaVersion: "0.2",
        requestId: "acp-cancel-1",
        workspaceId: "ws-acp",
        title: "Cancel ACP prompt",
        outcome: "Test session/cancel notification.",
        mode: "investigate",
        publisherOwner: "none",
        gitContext: {
          repoId: "example/widget",
          localRepoPath: fixture.workRepoDir,
          pinnedBaseCommitSha: baseSha,
        },
        requestedCapabilities: {
          allowCodeEdit: false,
          allowBranchPush: false,
          allowManagedPublishStage: false,
        },
        acceptanceCriteria: ["Cancels cleanly"],
      },
    });
    assert.equal(runningTurn.lifecycleStatus, "running");

    const cancelled = await invoke("bridge_handoff_abort", {
      handoffId: runningTurn.handoffId,
    });
    assert.equal(cancelled.lifecycleStatus, "aborted");
    const finalState = JSON.parse(readFileSync(acpStateFile, "utf8")) as { cancelledSessions: string[] };
    assert.equal(finalState.cancelledSessions.length, 1);
  } finally {
    await client.close();
    rmSync(dataDir, { recursive: true, force: true });
    fixture.cleanup();
  }
});
