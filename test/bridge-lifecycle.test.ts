import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { BridgeService } from "../src/bridge-service.js";
import { BridgeError, type BridgeConfig, type HandoffEnvelopeV2 } from "../src/types.js";
import { createTempGitFixture } from "./helpers/git-fixture.js";

const FAKE_OPENCLAW_CLI = resolve(process.cwd(), "test/helpers/fake-openclaw-cli.mjs");
const FAKE_GH_CLI = resolve(process.cwd(), "test/helpers/fake-gh-cli.mjs");

function formatResultBlock(payload: Record<string, unknown>): string {
  return `Analysis complete.\n\`\`\`handoff-result\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function makeConfig(dataDir: string): BridgeConfig {
  return {
    dataDir,
    ghCliPath: FAKE_GH_CLI,
    defaultWaitBudgetMs: 1_000,
    defaultMaxAutonomousTurns: 4,
    targets: {
      robo: {
        targetId: "robo",
        url: "https://gateway.example",
        authMode: "direct-token",
        tokenEnvVar: "TEST_TOKEN",
        agentId: "main",
        projectId: "openclaw",
        cliPath: FAKE_OPENCLAW_CLI,
      },
    },
  };
}

test("Crash-Reconnect Acceptance Test: closing and restarting BridgeService mid-run attaches cleanly with zero duplicate sessions, runs, or PRs", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-crash-"));
  const stateFile = join(dataDir, "fake-gateway-state.json");
  const prevStateEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = stateFile;

  try {
    const baseSha = fixture.commitFile("src/index.ts", "export const x = 1;\n", "base commit");
    fixture.git(["push", "origin", "main"]);

    writeFileSync(
      stateFile,
      JSON.stringify({
        queuedTurnReplies: [
          {
            // Requires multiple agent.wait slices so initial start returns `running`!
            pollsBeforeComplete: 4,
            replyText: formatResultBlock({
              disposition: "completed",
              candidateCommitSha: baseSha,
              candidateRef: "refs/heads/main",
              summaryDelta: "Linux test suite passed on pinned commit.",
              blockers: [],
              claimedChecks: [{ command: "pnpm test", exitCode: 0, environment: "linux" }],
            }),
          },
        ],
      }),
    );

    const envelope: HandoffEnvelopeV2 = {
      schemaVersion: "0.2",
      requestId: "req-crash-1",
      workspaceId: "ws-1",
      title: "Verify Linux suite on pinned commit",
      outcome: "Run Linux verification without modifying any files.",
      mode: "verify_only",
      publisherOwner: "local",
      gitContext: {
        repoId: "example/repo",
        localRepoPath: fixture.workRepoDir,
        remoteUrlOrPath: fixture.originBareDir,
        pinnedBaseCommitSha: baseSha,
        pinnedSourceCommitSha: baseSha,
        sourceRemoteRef: "refs/heads/main",
      },
      requestedCapabilities: {
        allowCodeEdit: false,
        allowBranchPush: false,
        allowManagedPublishStage: false,
      },
      advisoryInstructions: [],
      priorEvidence: [{ claim: "Windows build passed", sourceRef: baseSha }],
      acceptanceCriteria: ["Linux unit tests pass"],
    };

    // 1) Bridge instance #1 starts the task with waitBudgetMs=0 (returns `running` after 1 slice).
    const service1 = new BridgeService(makeConfig(dataDir));
    const started = await service1.startHandoff({
      targetId: "robo",
      envelope,
      worktreeName: "verify-linux-1",
      waitBudgetMs: 0,
    });

    assert.equal(started.lifecycleStatus, "running");
    assert.equal(started.orchestratorDirective.action, "POLL_ATTACH");
    const handoffId = started.handoffId;

    // Simulate process crash / restart while remote job is still running!
    service1.close();

    // 2) Boot completely fresh BridgeService #2 against the same SQLite database.
    //    Even if caller retries `startHandoff` with same `requestId`, or calls `attachHandoff`,
    //    it MUST NOT spawn a second remote session!
    const service2 = new BridgeService(makeConfig(dataDir));
    try {
      const reattachedViaDuplicateStart = await service2.startHandoff({
        targetId: "robo",
        envelope,
        waitBudgetMs: 0,
      });
      assert.equal(reattachedViaDuplicateStart.handoffId, handoffId);

      // Drain remaining polls until settled.
      let settled = reattachedViaDuplicateStart;
      for (let i = 0; i < 5 && settled.lifecycleStatus === "running"; i += 1) {
        settled = await service2.attachHandoff({ handoffId, waitBudgetMs: 0 });
      }

      assert.equal(settled.lifecycleStatus, "settled");
      assert.equal(settled.observed.reachableRefVerified, true);
      assert.equal(settled.observed.treeMatchesExpected, true);
      assert.equal(settled.orchestratorDirective.action, "PUBLISH_LOCALLY");

      const gwState = JSON.parse(readFileSync(stateFile, "utf8")) as {
        rpcCounts: Record<string, number>;
        sessions: Record<string, unknown>;
      };
      assert.equal(gwState.rpcCounts["sessions.create"], 1);
      assert.equal(Object.keys(gwState.sessions).length, 1);
    } finally {
      service2.close();
    }
  } finally {
    if (prevStateEnv === undefined) {
      delete process.env.FAKE_GATEWAY_STATE_FILE;
    } else {
      process.env.FAKE_GATEWAY_STATE_FILE = prevStateEnv;
    }
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Uncertain initial dispatch recovers via idempotencyKey even when cached replay returns runStarted:false", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-uncertain-"));
  const stateFile = join(dataDir, "fake-gateway-state.json");
  const prevStateEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = stateFile;

  try {
    const baseSha = fixture.commitFile("README.md", "# hello\n", "init");
    fixture.git(["push", "origin", "main"]);

    writeFileSync(
      stateFile,
      JSON.stringify({
        // Server commits session on call #1, then drops TCP connection before client gets response!
        dropNextCreateResponseOnce: true,
        queuedTurnReplies: [
          {
            pollsBeforeComplete: 0,
            replyText: formatResultBlock({
              disposition: "completed",
              summaryDelta: "Investigation finished cleanly.",
              blockers: [],
              claimedChecks: [],
            }),
          },
        ],
      }),
    );

    const service = new BridgeService(makeConfig(dataDir));
    try {
      const firstAttempt = await service.startHandoff({
        targetId: "robo",
        envelope: {
          schemaVersion: "0.2",
          requestId: "req-uncertain-1",
          workspaceId: "ws-1",
          title: "Investigate module ownership",
          outcome: "Identify owner boundary.",
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
          acceptanceCriteria: ["Return owner module path"],
        },
        waitBudgetMs: 500,
      });

      assert.equal(firstAttempt.lifecycleStatus, "uncertain");
      assert.equal(firstAttempt.orchestratorDirective.action, "POLL_ATTACH");

      // Re-attaching replays `sessions.create` with the identical idempotencyKey;
      // fake Gateway returns cached session with `runStarted: false` + `runId`!
      const recovered = await service.attachHandoff({
        handoffId: firstAttempt.handoffId,
        waitBudgetMs: 1_000,
      });

      assert.equal(recovered.lifecycleStatus, "settled");
      assert.equal(recovered.reported?.disposition, "completed");

      const gwState = JSON.parse(readFileSync(stateFile, "utf8")) as {
        sessions: Record<string, unknown>;
      };
      assert.equal(Object.keys(gwState.sessions).length, 1);
    } finally {
      service.close();
    }
  } finally {
    if (prevStateEnv === undefined) {
      delete process.env.FAKE_GATEWAY_STATE_FILE;
    } else {
      process.env.FAKE_GATEWAY_STATE_FILE = prevStateEnv;
    }
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Two-Step remote_gated Single-Publisher Gate blocks lockedPaths violations before PR creation and unlocks exact verified commit when clean", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-gate-"));
  const stateFile = join(dataDir, "fake-gateway-state.json");
  const prevStateEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = stateFile;

  try {
    const baseSha = fixture.commitFile(
      "installer.iss",
      "[Setup]\nAppName=SafeWinInstaller\n",
      "base installer",
    );
    const cleanSourceSha = fixture.commitFile("src/tray.ts", "export const tray = true;\n", "tray fix");
    fixture.git(["push", "origin", "main"]);

    // Create a bad remote branch where remote agent blindly edited `installer.iss`!
    fixture.git(["checkout", "-b", "robo/bad-branch"]);
    const badHeadSha = fixture.commitFile(
      "installer.iss",
      "[Setup]\nAppName=BrokenBlindEdit\n",
      "robo blind edit",
    );
    fixture.git(["push", "origin", "robo/bad-branch"]);

    // Also push a clean branch with untouched `installer.iss`.
    fixture.git(["checkout", cleanSourceSha]);
    fixture.git(["checkout", "-b", "robo/clean-branch"]);
    fixture.git(["push", "origin", "robo/clean-branch"]);

    writeFileSync(
      stateFile,
      JSON.stringify({
        queuedTurnReplies: [
          // Turn 1: Remote agent returns bad branch touching locked `installer.iss`!
          {
            pollsBeforeComplete: 0,
            replyText: formatResultBlock({
              disposition: "ready_for_publish_gate",
              candidateCommitSha: badHeadSha,
              candidateRef: "refs/heads/robo/bad-branch",
              summaryDelta: "Tweaked installer.iss and prepared branch.",
              blockers: [],
              claimedChecks: [],
            }),
          },
          // Turn 2: After orchestrator pushes back, remote agent resets to clean branch!
          {
            pollsBeforeComplete: 0,
            replyText: formatResultBlock({
              disposition: "ready_for_publish_gate",
              candidateCommitSha: cleanSourceSha,
              candidateRef: "refs/heads/robo/clean-branch",
              summaryDelta: "Reset branch strictly to verified Windows commit.",
              blockers: [],
              claimedChecks: [{ command: "pnpm typecheck", exitCode: 0, environment: "linux" }],
            }),
          },
          // Turn 3 (Stage-2 authorize_publish): Remote opens PR!
          {
            pollsBeforeComplete: 0,
            replyText: formatResultBlock({
              disposition: "completed",
              candidateCommitSha: cleanSourceSha,
              candidateRef: "refs/heads/robo/clean-branch",
              prUrl: "https://github.com/example/repo/pull/42",
              summaryDelta: "Draft PR #42 created.",
              blockers: [],
              claimedChecks: [],
            }),
          },
        ],
        openPrs: [],
      }),
    );

    const service = new BridgeService(makeConfig(dataDir));
    try {
      const turn1 = await service.startHandoff({
        targetId: "robo",
        envelope: {
          schemaVersion: "0.2",
          requestId: "req-gate-1",
          workspaceId: "ws-win",
          title: "Publish verified Windows tray & installer fix",
          outcome: "Review on Linux and prepare managed draft PR without modifying branch.",
          mode: "publish_unchanged",
          publisherOwner: "remote_gated",
          gitContext: {
            repoId: "example/repo",
            localRepoPath: fixture.workRepoDir,
            remoteUrlOrPath: fixture.originBareDir,
            pinnedBaseCommitSha: baseSha,
            pinnedSourceCommitSha: cleanSourceSha,
            sourceRemoteRef: "refs/heads/robo/clean-branch",
            lockedPaths: ["installer.iss"],
          },
          requestedCapabilities: {
            allowCodeEdit: false,
            allowBranchPush: true,
            allowManagedPublishStage: false,
          },
          advisoryInstructions: [
            {
              instruction: "Do not recompile Inno Setup on Linux",
              reason: "ISCC.exe is Windows-only",
            },
          ],
          priorEvidence: [{ claim: "ISCC.exe compiled cleanly", sourceRef: cleanSourceSha }],
          acceptanceCriteria: ["Immutable Tree-SHA preserved"],
        },
      });

      // Turn 1 caught the lockedPaths & Tree-SHA violation BEFORE any PR was published!
      assert.equal(turn1.observed.lockedPathsClean, false);
      assert.deepEqual(turn1.observed.violatedPaths, ["installer.iss"]);
      assert.equal(turn1.observed.treeMatchesExpected, false);
      assert.notEqual(turn1.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

      // Attempting Stage-2 `authorize_publish` anyway MUST throw CONTRACT_VIOLATION!
      await assert.rejects(
        () =>
          service.continueHandoff({
            handoffId: turn1.handoffId,
            intent: "authorize_publish",
            message: "Try forcing publish",
          }),
        (err: unknown) => err instanceof BridgeError && err.code === "CONTRACT_VIOLATION",
      );

      // Turn 2: Autonomous follow-up instructs remote session to reset to clean ref.
      const turn2 = await service.continueHandoff({
        handoffId: turn1.handoffId,
        intent: "counter_evidence_or_followup",
        message: "CONTRACT_VIOLATION: installer.iss is locked. Reset strictly to robo/clean-branch.",
      });

      assert.equal(turn2.observed.lockedPathsClean, true);
      assert.equal(turn2.observed.treeMatchesExpected, true);
      assert.equal(turn2.observed.observedHeadSha, cleanSourceSha.toLowerCase());
      assert.equal(turn2.orchestratorDirective.action, "AUTHORIZE_REMOTE_PUBLISH");

      // Simulate `gh pr list` seeing the PR once Stage-2 creates it.
      const currentState = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
      currentState.openPrs = [
        {
          number: 42,
          url: "https://github.com/example/repo/pull/42",
          headRefName: "robo/clean-branch",
          headRefOid: cleanSourceSha,
          body: `Handoff-ID: ${turn1.handoffId}`,
        },
      ];
      writeFileSync(stateFile, JSON.stringify(currentState, null, 2));

      // Turn 3: Stage-2 `authorize_publish` succeeds and verifies PR open!
      const turn3 = await service.continueHandoff({
        handoffId: turn1.handoffId,
        intent: "authorize_publish",
        message: "Proceed with Stage-2 draft PR creation.",
      });

      assert.equal(turn3.observed.reconciledPrState, "open_verified");
      assert.equal(turn3.observed.reconciledPrUrl, "https://github.com/example/repo/pull/42");
      assert.equal(turn3.orchestratorDirective.action, "ESCALATE_TO_HUMAN");

      // Any duplicate Stage-2 publish call MUST now be blocked!
      await assert.rejects(
        () =>
          service.continueHandoff({
            handoffId: turn1.handoffId,
            intent: "authorize_publish",
            message: "Accidental duplicate publish",
          }),
        (err: unknown) => err instanceof BridgeError && err.code === "PUBLISH_GATE_BLOCKED",
      );
    } finally {
      service.close();
    }
  } finally {
    if (prevStateEnv === undefined) {
      delete process.env.FAKE_GATEWAY_STATE_FILE;
    } else {
      process.env.FAKE_GATEWAY_STATE_FILE = prevStateEnv;
    }
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Autonomous Counter-Evidence Loop triggers CONTINUE_AUTONOMOUSLY on first objection and escalates on 2-turn stagnation, plus rejects contract conflicts", async () => {
  const fixture = createTempGitFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "agent-bridge-loop-"));
  const stateFile = join(dataDir, "fake-gateway-state.json");
  const prevStateEnv = process.env.FAKE_GATEWAY_STATE_FILE;
  process.env.FAKE_GATEWAY_STATE_FILE = stateFile;

  try {
    const baseSha = fixture.commitFile("src/core.ts", "export const a = 1;\n", "base");
    fixture.git(["push", "origin", "main"]);

    const repeatedBlockerReply = formatResultBlock({
      disposition: "needs_evidence",
      summaryDelta: "Cannot proceed without Windows smoke log.",
      blockers: ["Windows smoke log missing for pinned commit"],
      claimedChecks: [],
    });

    writeFileSync(
      stateFile,
      JSON.stringify({
        queuedTurnReplies: [
          { pollsBeforeComplete: 0, replyText: repeatedBlockerReply },
          { pollsBeforeComplete: 0, replyText: repeatedBlockerReply },
        ],
      }),
    );

    const service = new BridgeService(makeConfig(dataDir));
    try {
      // Contract conflict: publish_unchanged + allowCodeEdit=true MUST reject explicitly!
      await assert.rejects(
        () =>
          service.startHandoff({
            targetId: "robo",
            envelope: {
              schemaVersion: "0.2",
              requestId: "req-conflict",
              workspaceId: "ws-1",
              title: "Conflicting envelope",
              outcome: "Should fail validation immediately.",
              mode: "publish_unchanged",
              publisherOwner: "local",
              gitContext: {
                repoId: "example/repo",
                pinnedBaseCommitSha: baseSha,
                pinnedSourceCommitSha: baseSha,
              },
              requestedCapabilities: {
                allowCodeEdit: true,
                allowBranchPush: false,
                allowManagedPublishStage: false,
              },
              advisoryInstructions: [],
              priorEvidence: [],
              acceptanceCriteria: ["None"],
            },
          }),
        (err: unknown) => err instanceof BridgeError && err.code === "INVALID_CONTRACT_CONFLICT",
      );

      // Turn 1: Remote asks for Windows smoke log -> CONTINUE_AUTONOMOUSLY!
      const t1 = await service.startHandoff({
        targetId: "robo",
        envelope: {
          schemaVersion: "0.2",
          requestId: "req-stagnation",
          workspaceId: "ws-1",
          title: "Autonomous counter-evidence test",
          outcome: "Complete review cleanly.",
          mode: "verify_only",
          publisherOwner: "local",
          gitContext: {
            repoId: "example/repo",
            localRepoPath: fixture.workRepoDir,
            remoteUrlOrPath: fixture.originBareDir,
            pinnedBaseCommitSha: baseSha,
            pinnedSourceCommitSha: baseSha,
            sourceRemoteRef: "refs/heads/main",
          },
          requestedCapabilities: {
            allowCodeEdit: false,
            allowBranchPush: false,
            allowManagedPublishStage: false,
          },
          advisoryInstructions: [],
          priorEvidence: [],
          acceptanceCriteria: ["Verified"],
        },
      });

      assert.equal(t1.orchestratorDirective.action, "CONTINUE_AUTONOMOUSLY");

      // Turn 2: Remote repeats the EXACT same blocker with zero new commit -> ESCALATE_TO_HUMAN (stagnation)!
      const t2 = await service.continueHandoff({
        handoffId: t1.handoffId,
        intent: "counter_evidence_or_followup",
        message: "Attached Windows smoke receipt for commit.",
        evidenceRefs: [{ claim: "Tray exited 0", sourceRef: `${baseSha}:smoke.log` }],
      });

      assert.equal(t2.orchestratorDirective.action, "ESCALATE_TO_HUMAN");
      assert.match(t2.orchestratorDirective.reason, /Stagnation detected/i);
    } finally {
      service.close();
    }
  } finally {
    if (prevStateEnv === undefined) {
      delete process.env.FAKE_GATEWAY_STATE_FILE;
    } else {
      process.env.FAKE_GATEWAY_STATE_FILE = prevStateEnv;
    }
    fixture.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
