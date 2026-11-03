import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { evaluateOrchestratorDirective } from "./directive.js";
import { buildPrettySessionUrl, OpenClawGatewayClient } from "./gateway-client.js";
import { GitVerifier } from "./git-verifier.js";
import { GitHubReconciler } from "./github-reconciler.js";
import {
  compileAuthorizePublishPrompt,
  compileFollowupPrompt,
  compileInitialHandoffPrompt,
  parseReportedResult,
} from "./prompt-compiler.js";
import { validateAndNormalizeEnvelope } from "./schema.js";
import { BridgeStore } from "./store.js";
import {
  BridgeError,
  type BridgeConfig,
  type GatewayTargetConfig,
  type HandoffResultEnvelopeV2,
  type ObservedResult,
  type PreflightResult,
  type SessionRecord,
  type TurnRecord,
} from "./types.js";

export class BridgeService {
  private readonly config: BridgeConfig;
  private readonly store: BridgeStore;
  private readonly gitVerifier: GitVerifier;
  private readonly githubReconciler: GitHubReconciler;
  private readonly inFlightMutations = new Set<string>();

  constructor(config: BridgeConfig) {
    this.config = config;
    const dbPath = join(config.dataDir, "bridge-state.sqlite");
    this.store = new BridgeStore(dbPath);
    this.gitVerifier = new GitVerifier(config.dataDir);
    this.githubReconciler = new GitHubReconciler(config.ghCliPath);
  }

  close(): void {
    this.store.close();
  }

  private getClient(targetId: string): { target: GatewayTargetConfig; client: OpenClawGatewayClient } {
    const target = this.config.targets[targetId];
    if (!target) {
      const known = Object.keys(this.config.targets).join(", ") || "(none configured)";
      throw new BridgeError(
        "INVALID_INPUT",
        `Unknown targetId "${targetId}". Configured targets: ${known}.`,
      );
    }
    return {
      target,
      client: new OpenClawGatewayClient(target, this.config.dataDir),
    };
  }

  async preflight(params: {
    targetId: string;
    repoId?: string;
    issueQuery?: string;
  }): Promise<PreflightResult> {
    const { target, client } = this.getClient(params.targetId);
    let gatewayHealthy = false;
    let authReady = false;
    let agentFound = false;
    let defaultAgentId: string | undefined;
    let availableAgentIds: string[] = [];
    let remediation: string | undefined;

    try {
      const h = await client.health();
      gatewayHealthy = h.ok;
      authReady = h.ok;
      if (gatewayHealthy) {
        const roster = await client.listAgents();
        defaultAgentId = roster.defaultId;
        availableAgentIds = roster.agentIds;
        agentFound =
          roster.agentIds.length === 0 || roster.agentIds.includes(target.agentId);
        if (!agentFound) {
          remediation = `Configured agentId "${target.agentId}" not found on target "${params.targetId}". Available agents: ${roster.agentIds.join(", ")}.`;
        }
      }
    } catch (err) {
      if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") {
        gatewayHealthy = false;
        authReady = false;
        remediation = err.remediation ?? err.message;
      } else {
        throw err;
      }
    }

    const rivalPullRequests = await this.githubReconciler.findRivalPullRequests({
      repoId: params.repoId,
      issueQuery: params.issueQuery,
    });

    return {
      targetId: params.targetId,
      gatewayHealthy,
      authReady,
      agentFound,
      defaultAgentId,
      availableAgentIds,
      rivalPullRequests,
      ...(remediation ? { remediation } : {}),
    };
  }

  async startHandoff(params: {
    targetId: string;
    envelope: unknown;
    worktreeName?: string;
    waitBudgetMs?: number;
    maxAutonomousTurns?: number;
  }): Promise<HandoffResultEnvelopeV2> {
    const normalized = validateAndNormalizeEnvelope(params.envelope);
    const { target } = this.getClient(params.targetId);

    // Idempotent requestId check: never create a duplicate handoff if retried with same requestId.
    const existing = this.store.getSessionByRequestId(normalized.requestId);
    if (existing) {
      return await this.attachHandoff({
        handoffId: existing.handoffId,
        waitBudgetMs: params.waitBudgetMs,
      });
    }

    let expectedTreeSha = normalized.gitContext.expectedTreeSha;
    if (
      !expectedTreeSha &&
      normalized.gitContext.pinnedSourceCommitSha &&
      normalized.gitContext.localRepoPath
    ) {
      expectedTreeSha = await this.gitVerifier.resolveLocalCommitTree(
        normalized.gitContext.localRepoPath,
        normalized.gitContext.pinnedSourceCommitSha,
      );
    }

    const envelopeWithTree = {
      ...normalized,
      gitContext: {
        ...normalized.gitContext,
        ...(expectedTreeSha ? { expectedTreeSha } : {}),
      },
    };

    const handoffId = `hoff_${randomUUID()}`;
    const turnId = `turn_${randomUUID()}`;
    const idempotencyKey = `idem_${randomUUID()}`;
    const now = new Date().toISOString();
    const maxAutonomousTurns =
      params.maxAutonomousTurns ?? this.config.defaultMaxAutonomousTurns ?? 5;

    const promptText = compileInitialHandoffPrompt({
      handoffId,
      envelope: envelopeWithTree,
    });

    const createRpcParams = {
      agentId: target.agentId,
      label: envelopeWithTree.title,
      message: promptText,
      idempotencyKey,
      projectId: target.projectId,
      worktreeBaseRef: envelopeWithTree.gitContext.pinnedBaseCommitSha,
      worktreeName: params.worktreeName,
    };

    const sessionRecord: SessionRecord = {
      handoffId,
      requestId: envelopeWithTree.requestId,
      workspaceId: envelopeWithTree.workspaceId,
      targetId: params.targetId,
      title: envelopeWithTree.title,
      mode: envelopeWithTree.mode,
      publisherOwner: envelopeWithTree.publisherOwner,
      repoId: envelopeWithTree.gitContext.repoId,
      localRepoPath: envelopeWithTree.gitContext.localRepoPath,
      remoteUrlOrPath: envelopeWithTree.gitContext.remoteUrlOrPath,
      pinnedBaseCommitSha: envelopeWithTree.gitContext.pinnedBaseCommitSha,
      pinnedSourceCommitSha: envelopeWithTree.gitContext.pinnedSourceCommitSha,
      sourceRemoteRef: envelopeWithTree.gitContext.sourceRemoteRef,
      expectedTreeSha,
      lockedPaths: envelopeWithTree.gitContext.lockedPaths ?? [],
      envelope: envelopeWithTree,
      worktreeName: params.worktreeName,
      lifecycleStatus: "running",
      maxAutonomousTurns,
      sameBlockerStreak: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Write-ahead persistence BEFORE network call.
    this.store.createInitialIntent({
      session: sessionRecord,
      turn: {
        turnId,
        idempotencyKey,
        promptText,
        createParamsJson: JSON.stringify(createRpcParams),
        now,
      },
    });

    return await this.attachHandoff({
      handoffId,
      waitBudgetMs: params.waitBudgetMs,
    });
  }

  async attachHandoff(params: {
    handoffId: string;
    waitBudgetMs?: number;
  }): Promise<HandoffResultEnvelopeV2> {
    const session = this.requireSession(params.handoffId);
    const latestTurn = this.requireLatestTurn(params.handoffId);

    if (
      (latestTurn.dispatchState === "settled" ||
        latestTurn.dispatchState === "aborted" ||
        latestTurn.dispatchState === "failed") &&
      latestTurn.observed &&
      latestTurn.directive
    ) {
      return this.buildEnvelopeFromRecords(session, latestTurn);
    }

    if (this.inFlightMutations.has(params.handoffId)) {
      throw new BridgeError(
        "BUSY_ACTIVE_TURN",
        `Another operation is currently reconciling or dispatching handoff "${params.handoffId}".`,
      );
    }

    this.inFlightMutations.add(params.handoffId);
    try {
      const { target, client } = this.getClient(session.targetId);
      const waitBudgetMs = params.waitBudgetMs ?? this.config.defaultWaitBudgetMs ?? 30_000;
      const deadline = Date.now() + waitBudgetMs;

      // Phase 1: Reconcile dispatch_pending or uncertain turns without duplicating work.
      let activeSession = this.requireSession(params.handoffId);
      let activeTurn = this.requireLatestTurn(params.handoffId);

      if (!activeTurn.runId) {
        await this.reconcileUndispatchedTurn(activeSession, activeTurn, target, client);
        activeSession = this.requireSession(params.handoffId);
        activeTurn = this.requireLatestTurn(params.handoffId);
      }

      if (activeTurn.dispatchState === "failed" || activeTurn.dispatchState === "aborted") {
        return this.buildEnvelopeFromRecords(activeSession, activeTurn);
      }

      if (!activeTurn.runId || !activeSession.remoteSessionKey) {
        return this.buildRunningOrUncertainResult(activeSession, activeTurn);
      }

      // Phase 2: Bounded wait slices (`cancel_wait` returns running without aborting remote job).
      let terminalReplyText: string | undefined;
      let runFailedError: string | undefined;
      let runSettled = false;

      // Always perform at least one quick observation probe (even when waitBudgetMs === 0).
      do {
        const remaining = deadline - Date.now();
        const sliceMs = waitBudgetMs === 0 ? 150 : Math.max(150, Math.min(25_000, remaining));
        const obs = await client.waitRunSlice(activeTurn.runId, sliceMs);
        if (obs.state === "completed") {
          runSettled = true;
          terminalReplyText = obs.terminalReplyText;
          break;
        }
        if (obs.state === "failed") {
          runSettled = true;
          runFailedError = obs.errorMessage ?? "Remote run failed.";
          break;
        }
      } while (Date.now() < deadline);

      if (!runSettled) {
        return this.buildRunningOrUncertainResult(activeSession, activeTurn);
      }

      // Phase 3: Run settled — correlate exact turn reply from chat.history + verify Git & PR state.
      return await this.finalizeSettledTurn({
        session: activeSession,
        turn: activeTurn,
        client,
        terminalReplyText,
        runFailedError,
      });
    } finally {
      this.inFlightMutations.delete(params.handoffId);
    }
  }

  async continueHandoff(params: {
    handoffId: string;
    intent: "counter_evidence_or_followup" | "authorize_publish";
    message: string;
    updatedSourceCommitSha?: string;
    updatedSourceRemoteRef?: string;
    updatedExpectedTreeSha?: string;
    evidenceRefs?: Array<{ claim: string; sourceRef: string }>;
    waitBudgetMs?: number;
  }): Promise<HandoffResultEnvelopeV2> {
    if (this.inFlightMutations.has(params.handoffId)) {
      throw new BridgeError(
        "BUSY_ACTIVE_TURN",
        `Handoff "${params.handoffId}" already has an operation in flight.`,
      );
    }

    const session = this.requireSession(params.handoffId);
    const latestTurn = this.requireLatestTurn(params.handoffId);

    if (
      session.lifecycleStatus === "running" ||
      session.lifecycleStatus === "uncertain" ||
      latestTurn.dispatchState === "dispatch_pending" ||
      latestTurn.dispatchState === "dispatched" ||
      latestTurn.dispatchState === "uncertain"
    ) {
      throw new BridgeError(
        "BUSY_ACTIVE_TURN",
        `Handoff "${params.handoffId}" has an active or uncertain turn (${latestTurn.dispatchState}). Call bridge_handoff_attach first to reconcile before sending another turn.`,
      );
    }

    if (session.lifecycleStatus === "aborted") {
      throw new BridgeError(
        "INVALID_CONTRACT_CONFLICT",
        `Handoff "${params.handoffId}" was aborted and cannot be continued.`,
      );
    }

    if (!session.remoteSessionKey) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Handoff "${params.handoffId}" has no bound remoteSessionKey.`,
      );
    }

    const nextTurnNumber = latestTurn.turnNumber + 1;
    let promptText: string;
    let markPublishInFlight = false;

    if (params.intent === "authorize_publish") {
      if (session.publisherOwner !== "remote_gated") {
        throw new BridgeError(
          "PUBLISH_GATE_BLOCKED",
          `Cannot authorize remote publish because publisherOwner is "${session.publisherOwner}" (expected "remote_gated").`,
        );
      }

      const pubLedger = this.store.getPublicationLedger(params.handoffId);
      if (pubLedger.prState === "open_verified") {
        throw new BridgeError(
          "PUBLISH_GATE_BLOCKED",
          `Pull request is already verified open (${pubLedger.prUrl ?? "recorded"}). Refusing duplicate publish.`,
        );
      }
      if (pubLedger.prState === "uncertain_in_flight") {
        throw new BridgeError(
          "RECONCILIATION_UNCERTAIN",
          "A previous remote publish attempt is still uncertain_in_flight. Reconcile PR state first before issuing another publish authorization.",
        );
      }

      const lastObserved = latestTurn.observed;
      if (
        !session.verifiedPublishHeadSha ||
        !lastObserved?.reachableRefVerified ||
        lastObserved.lockedPathsClean === false ||
        lastObserved.treeMatchesExpected === false ||
        !lastObserved.observedTreeSha
      ) {
        throw new BridgeError(
          "CONTRACT_VIOLATION",
          "Stage-2 managed publish is blocked: candidate commit has not passed checkout-free Git Tree-SHA and lockedPaths verification.",
        );
      }

      const candidateRef =
        latestTurn.reported?.candidateRef ??
        pubLedger.headRef ??
        session.sourceRemoteRef ??
        session.verifiedPublishHeadSha;

      promptText = compileAuthorizePublishPrompt({
        handoffId: params.handoffId,
        turnNumber: nextTurnNumber,
        verifiedHeadSha: session.verifiedPublishHeadSha,
        verifiedTreeSha: lastObserved.observedTreeSha,
        candidateRef,
        operatorNote: params.message,
      });
      markPublishInFlight = true;
    } else {
      promptText = compileFollowupPrompt({
        handoffId: params.handoffId,
        turnNumber: nextTurnNumber,
        message: params.message,
        updatedSourceCommitSha: params.updatedSourceCommitSha?.toLowerCase(),
        updatedSourceRemoteRef: params.updatedSourceRemoteRef,
        updatedExpectedTreeSha: params.updatedExpectedTreeSha?.toLowerCase(),
        evidenceRefs: params.evidenceRefs,
      });
    }

    const { client } = this.getClient(session.targetId);
    const historySnapshot = await client.readHistory(session.remoteSessionKey, 50);
    const baselineMessageCount = historySnapshot.messages.length;

    const turnId = `turn_${randomUUID()}`;
    const idempotencyKey = `idem_${randomUUID()}`;
    const now = new Date().toISOString();

    // Write-ahead followup intent BEFORE network dispatch.
    this.store.createFollowupIntent({
      handoffId: params.handoffId,
      turnId,
      turnNumber: nextTurnNumber,
      kind: params.intent === "authorize_publish" ? "authorize_publish" : "continue",
      idempotencyKey,
      promptText,
      baselineMessageCount,
      updatedSourceCommitSha: params.updatedSourceCommitSha?.toLowerCase(),
      updatedSourceRemoteRef: params.updatedSourceRemoteRef,
      updatedExpectedTreeSha: params.updatedExpectedTreeSha?.toLowerCase(),
      markPublishInFlight,
      now,
    });

    return await this.attachHandoff({
      handoffId: params.handoffId,
      waitBudgetMs: params.waitBudgetMs,
    });
  }

  async verifyGit(params: {
    handoffId: string;
    candidateRef: string;
    remoteUrlOrPath?: string;
  }): Promise<HandoffResultEnvelopeV2> {
    const session = this.requireSession(params.handoffId);
    const latestTurn = this.requireLatestTurn(params.handoffId);
    const remoteSource =
      params.remoteUrlOrPath ?? session.remoteUrlOrPath ?? session.localRepoPath;

    if (!remoteSource) {
      throw new BridgeError(
        "INVALID_INPUT",
        `No remoteUrlOrPath or localRepoPath configured on handoff "${params.handoffId}" to fetch "${params.candidateRef}".`,
      );
    }

    const pubLedger = this.store.getPublicationLedger(params.handoffId);
    const gitObserved = await this.gitVerifier.verifyCandidate({
      remoteUrlOrPath: remoteSource,
      localRepoPath: session.localRepoPath,
      candidateRef: params.candidateRef,
      pinnedBaseCommitSha: session.pinnedBaseCommitSha,
      expectedTreeSha: session.expectedTreeSha,
      lockedPaths: session.lockedPaths,
      existingPrState: pubLedger.prState,
      existingPrUrl: pubLedger.prUrl,
    });

    const prReconciled = await this.githubReconciler.reconcilePullRequest({
      repoId: session.repoId,
      headRef: params.candidateRef,
      headSha: gitObserved.observedHeadSha,
      handoffId: session.handoffId,
      priorState: pubLedger.prState,
      priorUrl: pubLedger.prUrl,
      reportedPrUrl: latestTurn.reported?.prUrl,
    });

    const observed: ObservedResult = {
      ...gitObserved,
      reconciledPrState: prReconciled.prState,
      reconciledPrUrl: prReconciled.prUrl,
    };

    const verifiedPublishHeadSha =
      observed.reachableRefVerified &&
      observed.lockedPathsClean !== false &&
      observed.treeMatchesExpected !== false
        ? observed.observedHeadSha
        : undefined;

    const evaluated = evaluateOrchestratorDirective({
      lifecycleStatus: session.lifecycleStatus,
      publisherOwner: session.publisherOwner,
      turnNumber: latestTurn.turnNumber,
      maxAutonomousTurns: session.maxAutonomousTurns,
      priorSameBlockerStreak: session.sameBlockerStreak,
      priorBlockerFingerprint: session.lastBlockerFingerprint,
      reported: latestTurn.reported,
      observed,
    });

    this.store.updateVerifiedGitSnapshot({
      handoffId: session.handoffId,
      turnId: latestTurn.turnId,
      observed,
      directive: evaluated.directive,
      verifiedPublishHeadSha,
      headRef: params.candidateRef,
      now: new Date().toISOString(),
    });

    const refreshedSession = this.requireSession(params.handoffId);
    const refreshedTurn = this.requireLatestTurn(params.handoffId);
    return this.buildEnvelopeFromRecords(refreshedSession, refreshedTurn);
  }

  async abortHandoff(params: {
    handoffId: string;
    reason?: string;
  }): Promise<HandoffResultEnvelopeV2> {
    const session = this.requireSession(params.handoffId);
    const latestTurn = this.store.getLatestTurn(params.handoffId);
    const reason = params.reason ?? "Aborted explicitly by local orchestrator.";

    if (session.remoteSessionKey) {
      const { client } = this.getClient(session.targetId);
      await client.abortRun(session.remoteSessionKey, latestTurn?.runId);
    }

    const now = new Date().toISOString();
    this.store.markAborted(params.handoffId, latestTurn?.turnId, reason, now);

    const updatedSession = this.requireSession(params.handoffId);
    const updatedTurn = this.requireLatestTurn(params.handoffId);
    const pubLedger = this.store.getPublicationLedger(params.handoffId);
    const observed: ObservedResult = updatedTurn.observed ?? {
      reachableRefVerified: false,
      reconciledPrState: pubLedger.prState,
      reconciledPrUrl: pubLedger.prUrl,
    };

    return {
      schemaVersion: "0.2",
      handoffId: updatedSession.handoffId,
      targetId: updatedSession.targetId,
      remoteSessionKey: updatedSession.remoteSessionKey,
      remoteSessionUrl: updatedSession.remoteSessionUrl,
      turnNumber: updatedTurn.turnNumber,
      runId: updatedTurn.runId ?? "unassigned",
      lifecycleStatus: "aborted",
      reported: updatedTurn.reported,
      observed,
      orchestratorDirective: {
        action: "ESCALATE_TO_HUMAN",
        reason,
        remainingTurnBudget: 0,
      },
    };
  }

  private async reconcileUndispatchedTurn(
    session: SessionRecord,
    turn: TurnRecord,
    target: GatewayTargetConfig,
    client: OpenClawGatewayClient,
  ): Promise<void> {
    const now = new Date().toISOString();

    if (turn.kind === "initial") {
      if (!turn.createParamsJson) {
        throw new BridgeError(
          "INVALID_INPUT",
          `Initial turn "${turn.turnId}" is missing persisted createParamsJson.`,
        );
      }
      const createParams = JSON.parse(turn.createParamsJson) as {
        agentId: string;
        label: string;
        message: string;
        idempotencyKey: string;
        projectId?: string;
        worktreeBaseRef?: string;
        worktreeName?: string;
      };

      try {
        const created = await client.createSession(createParams);
        const prettyUrl = buildPrettySessionUrl({
          originUrl: target.url,
          agentId: target.agentId,
          label: session.title,
          sessionKey: created.key,
        });

        // Per OpenClaw `session-create-initial-turn.ts:99-108`, cached idempotent replay
        // returns `runStarted: false` while still returning `runId`! Only treat as failed
        // when `runError` is present and no `runId` exists.
        if (created.runError && !created.runId) {
          const observed: ObservedResult = {
            reachableRefVerified: false,
            reconciledPrState: "none",
            verificationNotes: [
              `Initial turn rejected during sessions.create: ${JSON.stringify(created.runError)}`,
            ],
          };
          this.store.recordInitialDispatched({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            remoteSessionKey: created.key,
            remoteSessionId: created.sessionId,
            remoteSessionUrl: prettyUrl,
            runId: "failed_initial_turn",
            now,
          });
          this.store.settleTurn({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            lifecycleStatus: "failed",
            dispatchState: "failed",
            observed,
            directive: {
              action: "ESCALATE_TO_HUMAN",
              reason: `Remote session "${created.key}" was created, but its initial turn failed: ${JSON.stringify(created.runError)}`,
              remainingTurnBudget: Math.max(0, session.maxAutonomousTurns - 1),
            },
            sameBlockerStreak: 0,
            errorText: JSON.stringify(created.runError),
            now,
          });
          return;
        }

        if (!created.runId) {
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            remoteSessionKey: created.key,
            remoteSessionId: created.sessionId,
            remoteSessionUrl: prettyUrl,
            errorText:
              "Gateway sessions.create returned session key without runId; awaiting reconciliation.",
            now,
          });
          return;
        }

        this.store.recordInitialDispatched({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          remoteSessionKey: created.key,
          remoteSessionId: created.sessionId,
          remoteSessionUrl: prettyUrl,
          runId: created.runId,
          now,
        });
      } catch (err) {
        if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") {
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            errorText: err.message,
            now,
          });
          throw err;
        }
        this.store.markTurnUncertain({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          errorText: err instanceof Error ? err.message : String(err),
          now,
        });
      }
      return;
    }

    // Follow-up (`continue` or `authorize_publish`): replay with exact idempotencyKey.
    if (!session.remoteSessionKey) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Cannot dispatch follow-up turn "${turn.turnId}" without remoteSessionKey.`,
      );
    }

    try {
      const sent = await client.sendChat({
        sessionKey: session.remoteSessionKey,
        sessionId: session.remoteSessionId,
        agentId: target.agentId,
        message: turn.promptText,
        idempotencyKey: turn.idempotencyKey,
      });
      this.store.recordFollowupDispatched({
        handoffId: session.handoffId,
        turnId: turn.turnId,
        runId: sent.runId,
        now,
      });
    } catch (err) {
      if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") {
        this.store.markTurnUncertain({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          errorText: err.message,
          now,
        });
        throw err;
      }
      this.store.markTurnUncertain({
        handoffId: session.handoffId,
        turnId: turn.turnId,
        errorText: err instanceof Error ? err.message : String(err),
        now,
      });
    }
  }

  private async finalizeSettledTurn(params: {
    session: SessionRecord;
    turn: TurnRecord;
    client: OpenClawGatewayClient;
    terminalReplyText?: string;
    runFailedError?: string;
  }): Promise<HandoffResultEnvelopeV2> {
    const { session, turn, client, terminalReplyText, runFailedError } = params;
    const now = new Date().toISOString();
    const pubLedger = this.store.getPublicationLedger(session.handoffId);

    if (runFailedError) {
      const prCheck = await this.githubReconciler.reconcilePullRequest({
        repoId: session.repoId,
        headRef: pubLedger.headRef ?? session.sourceRemoteRef,
        headSha: pubLedger.headSha ?? session.pinnedSourceCommitSha,
        handoffId: session.handoffId,
        priorState: pubLedger.prState,
        priorUrl: pubLedger.prUrl,
      });
      const observed: ObservedResult = {
        reachableRefVerified: false,
        reconciledPrState: prCheck.prState,
        reconciledPrUrl: prCheck.prUrl,
        verificationNotes: [runFailedError],
      };
      const evalRes = evaluateOrchestratorDirective({
        lifecycleStatus: "failed",
        publisherOwner: session.publisherOwner,
        turnNumber: turn.turnNumber,
        maxAutonomousTurns: session.maxAutonomousTurns,
        priorSameBlockerStreak: session.sameBlockerStreak,
        priorBlockerFingerprint: session.lastBlockerFingerprint,
        observed,
      });

      this.store.settleTurn({
        handoffId: session.handoffId,
        turnId: turn.turnId,
        lifecycleStatus: "failed",
        dispatchState: "failed",
        observed,
        directive: evalRes.directive,
        sameBlockerStreak: evalRes.sameBlockerStreak,
        lastBlockerFingerprint: evalRes.blockerFingerprint,
        errorText: runFailedError,
        now,
      });

      return this.buildEnvelopeFromRecords(
        this.requireSession(session.handoffId),
        this.requireLatestTurn(session.handoffId),
      );
    }

    // Correlate assistant reply strictly to this turn (`runId` match first, then post-baseline slice).
    let correlatedText = terminalReplyText;
    if (session.remoteSessionKey) {
      const history = await client.readHistory(session.remoteSessionKey, 50);
      const exactRunMatch = [...history.messages]
        .reverse()
        .find((m) => m.role === "assistant" && turn.runId && m.runId === turn.runId && m.text.trim());

      if (exactRunMatch) {
        correlatedText = exactRunMatch.text;
      } else {
        const postBaseline = history.messages
          .slice(turn.baselineMessageCount)
          .filter((m) => m.role === "assistant" && m.text.trim());
        if (postBaseline.length > 0) {
          correlatedText = postBaseline[postBaseline.length - 1]!.text;
        }
      }
    }

    const rawReply = correlatedText ?? "";
    const reported = parseReportedResult(rawReply);

    const candidateRef = reported.candidateRef ?? session.sourceRemoteRef;
    const remoteSource = session.remoteUrlOrPath ?? session.localRepoPath;

    let observed: ObservedResult = {
      reachableRefVerified: false,
      reconciledPrState: pubLedger.prState,
      reconciledPrUrl: pubLedger.prUrl,
    };

    if (candidateRef && remoteSource) {
      observed = await this.gitVerifier.verifyCandidate({
        remoteUrlOrPath: remoteSource,
        localRepoPath: session.localRepoPath,
        candidateRef,
        pinnedBaseCommitSha: session.pinnedBaseCommitSha,
        expectedTreeSha: session.expectedTreeSha,
        lockedPaths: session.lockedPaths,
        existingPrState: pubLedger.prState,
        existingPrUrl: pubLedger.prUrl,
      });
    }

    const prReconciled = await this.githubReconciler.reconcilePullRequest({
      repoId: session.repoId,
      headRef: candidateRef ?? pubLedger.headRef,
      headSha: observed.observedHeadSha ?? reported.candidateCommitSha,
      handoffId: session.handoffId,
      priorState: pubLedger.prState,
      priorUrl: pubLedger.prUrl,
      reportedPrUrl: turn.kind === "authorize_publish" ? reported.prUrl : undefined,
    });

    observed = {
      ...observed,
      reconciledPrState: prReconciled.prState,
      reconciledPrUrl: prReconciled.prUrl,
    };

    const verifiedPublishHeadSha =
      observed.reachableRefVerified &&
      observed.lockedPathsClean !== false &&
      observed.treeMatchesExpected !== false
        ? observed.observedHeadSha
        : undefined;

    const evaluated = evaluateOrchestratorDirective({
      lifecycleStatus: "settled",
      publisherOwner: session.publisherOwner,
      turnNumber: turn.turnNumber,
      maxAutonomousTurns: session.maxAutonomousTurns,
      priorSameBlockerStreak: session.sameBlockerStreak,
      priorBlockerFingerprint: session.lastBlockerFingerprint,
      reported,
      observed,
    });

    this.store.settleTurn({
      handoffId: session.handoffId,
      turnId: turn.turnId,
      lifecycleStatus: "settled",
      dispatchState: "settled",
      rawReplyText: rawReply,
      reported,
      observed,
      directive: evaluated.directive,
      sameBlockerStreak: evaluated.sameBlockerStreak,
      lastBlockerFingerprint: evaluated.blockerFingerprint,
      verifiedPublishHeadSha,
      headRef: candidateRef,
      now,
    });

    return this.buildEnvelopeFromRecords(
      this.requireSession(session.handoffId),
      this.requireLatestTurn(session.handoffId),
    );
  }

  private buildRunningOrUncertainResult(
    session: SessionRecord,
    turn: TurnRecord,
  ): HandoffResultEnvelopeV2 {
    const pubLedger = this.store.getPublicationLedger(session.handoffId);
    const status = turn.dispatchState === "uncertain" ? "uncertain" : "running";
    const observed: ObservedResult = turn.observed ?? {
      reachableRefVerified: false,
      reconciledPrState: pubLedger.prState,
      reconciledPrUrl: pubLedger.prUrl,
      ...(turn.errorText ? { verificationNotes: [turn.errorText] } : {}),
    };
    const evaluated = evaluateOrchestratorDirective({
      lifecycleStatus: status,
      publisherOwner: session.publisherOwner,
      turnNumber: turn.turnNumber,
      maxAutonomousTurns: session.maxAutonomousTurns,
      priorSameBlockerStreak: session.sameBlockerStreak,
      priorBlockerFingerprint: session.lastBlockerFingerprint,
      observed,
    });
    return {
      schemaVersion: "0.2",
      handoffId: session.handoffId,
      targetId: session.targetId,
      remoteSessionKey: session.remoteSessionKey,
      remoteSessionUrl: session.remoteSessionUrl,
      turnNumber: turn.turnNumber,
      runId: turn.runId ?? "pending_reconciliation",
      lifecycleStatus: status,
      reported: turn.reported,
      observed,
      orchestratorDirective: evaluated.directive,
    };
  }

  private buildEnvelopeFromRecords(
    session: SessionRecord,
    turn: TurnRecord,
  ): HandoffResultEnvelopeV2 {
    const pubLedger = this.store.getPublicationLedger(session.handoffId);
    const observed: ObservedResult = turn.observed ?? {
      reachableRefVerified: false,
      reconciledPrState: pubLedger.prState,
      reconciledPrUrl: pubLedger.prUrl,
    };
    const directive =
      turn.directive ??
      evaluateOrchestratorDirective({
        lifecycleStatus: session.lifecycleStatus,
        publisherOwner: session.publisherOwner,
        turnNumber: turn.turnNumber,
        maxAutonomousTurns: session.maxAutonomousTurns,
        priorSameBlockerStreak: session.sameBlockerStreak,
        priorBlockerFingerprint: session.lastBlockerFingerprint,
        reported: turn.reported,
        observed,
      }).directive;

    return {
      schemaVersion: "0.2",
      handoffId: session.handoffId,
      targetId: session.targetId,
      remoteSessionKey: session.remoteSessionKey,
      remoteSessionUrl: session.remoteSessionUrl,
      turnNumber: turn.turnNumber,
      runId: turn.runId ?? "unassigned",
      lifecycleStatus: session.lifecycleStatus,
      reported: turn.reported,
      observed,
      orchestratorDirective: directive,
    };
  }

  private requireSession(handoffId: string): SessionRecord {
    const s = this.store.getSession(handoffId);
    if (!s) {
      throw new BridgeError("HANDOFF_NOT_FOUND", `Unknown handoffId "${handoffId}".`);
    }
    return s;
  }

  private requireLatestTurn(handoffId: string): TurnRecord {
    const t = this.store.getLatestTurn(handoffId);
    if (!t) {
      throw new BridgeError(
        "HANDOFF_NOT_FOUND",
        `No turn records found for handoffId "${handoffId}".`,
      );
    }
    return t;
  }
}
