import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ChromeChat } from "./chrome-chat.js";
import { inspectBrowserTurn, wrapBrowserPrompt } from "./browser-turn.js";
import { parseBrowserSessionRoute, sameBrowserSessionUrl } from "./config.js";
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
  type BridgeTargetConfig,
  type BrowserTargetConfig,
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
  private readonly browserChats = new Map<string, ChromeChat>();
  private readonly inFlightMutations = new Set<string>();

  constructor(config: BridgeConfig) {
    this.config = config;
    const dbPath = join(config.dataDir, "bridge-state.sqlite");
    this.store = new BridgeStore(dbPath);
    this.gitVerifier = new GitVerifier(config.dataDir);
    this.githubReconciler = new GitHubReconciler(config.ghCliPath);
  }

  async close(): Promise<void> {
    this.store.close();
    await Promise.all([...this.browserChats.values()].map((chat) => chat.close()));
  }

  private getTarget(targetId: string): BridgeTargetConfig {
    const target = this.config.targets[targetId];
    if (!target) {
      const known = Object.keys(this.config.targets).join(", ") || "(none configured)";
      throw new BridgeError(
        "INVALID_INPUT",
        `Unknown targetId "${targetId}". Configured targets: ${known}.`,
      );
    }
    return target;
  }

  private browser(target: BrowserTargetConfig): ChromeChat {
    const identity = parseBrowserSessionRoute(target.sessionUrl, target.basePath)?.identity ?? target.sessionUrl;
    const key = JSON.stringify([identity, target.browserMcp.command, target.browserMcp.args]);
    let chat = this.browserChats.get(key);
    if (!chat) {
      chat = new ChromeChat({ ...target.browserMcp, sessionUrl: target.sessionUrl, basePath: target.basePath });
      this.browserChats.set(key, chat);
    }
    return chat;
  }

  private targetForSession(session: SessionRecord): BridgeTargetConfig {
    const target = this.getTarget(session.targetId);
    const key = session.remoteSessionKey;
    if (
      target.transport === "browser"
        ? !key?.startsWith("browser:") ||
          !sameBrowserSessionUrl(key.slice("browser:".length), target.sessionUrl, target.basePath)
        : key?.startsWith("browser:")
    ) {
      throw new BridgeError("INVALID_CONTRACT_CONFLICT", "The configured transport or browser chat differs from this handoff's recorded destination.");
    }
    return target;
  }

  async preflight(params: {
    targetId: string;
    repoId?: string;
    issueQuery?: string;
  }): Promise<PreflightResult> {
    const target = this.getTarget(params.targetId);
    if (target.transport === "browser") {
      await this.browser(target).read();
      return {
        targetId: params.targetId, gatewayHealthy: false, browserReady: true, authReady: true, agentFound: true, availableAgentIds: [target.agentId],
        rivalPullRequests: await this.githubReconciler.findRivalPullRequests(params),
      };
    }
    const client = new OpenClawGatewayClient(target, this.config.dataDir);
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

  private async resolveSourceTree(
    source: { localRepoPath?: string; remoteUrlOrPath?: string; pinnedBaseCommitSha: string },
    commit: string,
  ): Promise<string> {
    if (source.localRepoPath) return this.gitVerifier.resolveLocalCommitTree(source.localRepoPath, commit);
    if (source.remoteUrlOrPath) {
      const pinned = await this.gitVerifier.verifyCandidate({
        remoteUrlOrPath: source.remoteUrlOrPath, candidateRef: commit,
        pinnedBaseCommitSha: source.pinnedBaseCommitSha,
      });
      if (pinned.baseIsAncestor && pinned.observedTreeSha) return pinned.observedTreeSha;
    }
    throw new BridgeError("INVALID_CONTRACT_CONFLICT", "Cannot resolve the pinned source tree from the configured repository.");
  }

  async startHandoff(params: {
    targetId: string;
    envelope: unknown;
    worktreeName?: string;
    waitBudgetMs?: number;
    maxAutonomousTurns?: number;
  }): Promise<HandoffResultEnvelopeV2> {
    const normalized = validateAndNormalizeEnvelope(params.envelope);
    const target = this.getTarget(params.targetId);
    if (target.transport === "browser" && params.worktreeName) {
      throw new BridgeError("INVALID_INPUT", "A browser target uses its existing chat and cannot create a named worktree.");
    }

    // Idempotent requestId check: never create a duplicate handoff if retried with same requestId.
    const existing = this.store.getSessionByRequestId(normalized.requestId);
    if (existing) {
      return await this.attachHandoff({
        handoffId: existing.handoffId,
        waitBudgetMs: params.waitBudgetMs,
      });
    }

    const source = normalized.gitContext;
    const immutable = normalized.mode === "publish_unchanged" || normalized.mode === "verify_only";
    const expectedTreeSha = source.expectedTreeSha ?? (immutable && source.pinnedSourceCommitSha
      ? await this.resolveSourceTree(source, source.pinnedSourceCommitSha)
      : undefined);

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

    const remoteSessionKey = target.transport === "browser"
      ? `browser:${target.sessionUrl}`
      : `agent:${target.agentId}:bridge-${handoffId.slice(5)}`;
    const createRpcParams = target.transport === "browser" ? undefined : {
      key: remoteSessionKey,
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
      remoteSessionKey,
      remoteSessionUrl: target.transport === "browser" ? target.sessionUrl : undefined,
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

    if (latestTurn.dispatchState === "aborted") return this.buildEnvelopeFromRecords(session, latestTurn);
    if (
      (latestTurn.dispatchState === "settled" ||
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
      const target = this.targetForSession(session);
      const waitBudgetMs = params.waitBudgetMs ?? this.config.defaultWaitBudgetMs ?? 30_000;
      if (target.transport === "browser") {
        return await this.attachBrowserTurn(session, latestTurn, target, waitBudgetMs);
      }
      const client = new OpenClawGatewayClient(target, this.config.dataDir);
      const deadline = Date.now() + waitBudgetMs;

      // Only a prepared intent may be sent; reconcile uncertain submissions by reading.
      let activeSession = this.requireSession(params.handoffId);
      let activeTurn = this.requireLatestTurn(params.handoffId);

      if (!activeTurn.runId) {
        await this.reconcileUndispatchedTurn(activeSession, activeTurn, target, client);
        activeSession = this.requireSession(params.handoffId);
        activeTurn = this.requireLatestTurn(params.handoffId);
      }

      if (activeTurn.dispatchState === "settled" || activeTurn.dispatchState === "failed" || activeTurn.dispatchState === "aborted") {
        return this.buildEnvelopeFromRecords(activeSession, activeTurn);
      }

      if (!activeTurn.runId || !activeSession.remoteSessionKey) {
        return this.buildRunningOrUncertainResult(activeSession, activeTurn);
      }

      // Phase 2: Bounded wait slices (`cancel_wait` returns running without aborting remote job).
      let terminalReplyText: string | undefined;
      let runFailedError: string | undefined;
      let runSettled = false;
      let waitRecordMissing = false;

      // Always perform at least one quick observation probe (even when waitBudgetMs === 0).
      do {
        const remaining = deadline - Date.now();
        const sliceMs = waitBudgetMs === 0 ? 150 : Math.max(150, Math.min(25_000, remaining));
        const obs = await client.waitRunSlice(activeTurn.runId, sliceMs);
        if (obs.state === "not_found") {
          waitRecordMissing = true;
          break;
        }
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

      // A terminal agent.wait snapshot expires on the Gateway. At most once per attach,
      // consult its durable projection and bind the answer to this physical session and run.
      if (!runFailedError && !terminalReplyText && activeSession.remoteSessionId &&
          (latestTurn.runId || runSettled || waitRecordMissing)) {
        const history = await client.readHistory(activeSession.remoteSessionKey, activeSession.remoteSessionId);
        if (history.sessionKey === activeSession.remoteSessionKey && history.sessionId === activeSession.remoteSessionId) {
          if (!runSettled && history.lastTerminalRun?.id === activeTurn.runId) {
            runSettled = true;
            if (history.lastTerminalRun.status !== "done") runFailedError = `Remote run ended with status ${history.lastTerminalRun.status}.`;
          }
          if (runSettled && !runFailedError) {
            terminalReplyText = [...history.messages].reverse()
              .find((m) => m.finalAnswer && m.runId === activeTurn.runId && m.text.trim())?.text;
          }
        }
      }
      if (!runSettled) {
        if (waitRecordMissing) {
          this.store.markTurnUncertain({ handoffId: activeSession.handoffId, turnId: activeTurn.turnId,
            errorText: "Gateway no longer has this run's wait record or exact terminal history. Inspect the bound session before continuing.", now: new Date().toISOString() });
          return this.buildRunningOrUncertainResult(this.requireSession(activeSession.handoffId), this.requireLatestTurn(activeSession.handoffId));
        }
        return this.buildRunningOrUncertainResult(activeSession, activeTurn);
      }

      // Phase 3: Run settled — correlate exact turn reply from chat.history + verify Git & PR state.
      return await this.finalizeSettledTurn({
        session: activeSession,
        turn: activeTurn,
        terminalReplyText,
        runFailedError,
      });
    } finally {
      this.inFlightMutations.delete(params.handoffId);
    }
  }

  private async attachBrowserTurn(
    session: SessionRecord,
    turn: TurnRecord,
    target: BrowserTargetConfig,
    waitBudgetMs: number,
  ): Promise<HandoffResultEnvelopeV2> {
    const { handoffId } = session;
    const { turnId, idempotencyKey } = turn;
    const chat = this.browser(target);
    const deadline = Date.now() + waitBudgetMs;
    let submitted = turn.dispatchState !== "prepared";
    let accepted = turn.dispatchState === "dispatched" || Boolean(turn.runId);
    let needsDispatchRecord = turn.dispatchState !== "dispatched";
    let reply: string | undefined;
    const uncertain = (errorText: string) =>
      this.store.markTurnUncertain({ handoffId, turnId, errorText, now: new Date().toISOString() });

    try {
      if (!submitted) {
        await chat.send(wrapBrowserPrompt(idempotencyKey, turn.promptText), () => {
          const claimed = this.store.claimDispatch(handoffId, turnId);
          submitted = true; // A competing attach may already have claimed the same turn.
          return claimed;
        });
      }
      for (;;) {
        const receipt = inspectBrowserTurn(await chat.read(idempotencyKey), idempotencyKey, accepted);
        if (needsDispatchRecord && (receipt.state === "running" || receipt.state === "completed")) {
          this.store.recordDispatched({
            handoffId, turnId, remoteSessionKey: `browser:${target.sessionUrl}`,
            remoteSessionUrl: target.sessionUrl, runId: `browser:${idempotencyKey}`, now: new Date().toISOString(),
          });
          accepted = true;
          needsDispatchRecord = false;
        }
        if (receipt.state === "completed") {
          reply = receipt.text;
          break;
        }
        if (receipt.state === "uncertain") {
          uncertain("The visible chat cannot tie a finished answer to this exact turn. Inspect the existing chat and attach again.");
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          if (receipt.state === "absent" || receipt.state === "pending") {
            uncertain("The sent turn is not yet confirmed in the configured chat. Reopen it and attach without resending.");
          }
          break;
        }
        await delay(Math.min(remaining, 1200));
      }
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      if (!submitted) throw new BridgeError(error.code, error.message, `When the chat is ready, attach to ${handoffId}.`);
      uncertain(error.message);
    }
    if (reply) return this.finalizeSettledTurn({ session, turn, terminalReplyText: reply });
    const latest = this.requireLatestTurn(handoffId);
    const current = this.requireSession(handoffId);
    return current.lifecycleStatus === "running" || current.lifecycleStatus === "uncertain"
      ? this.buildRunningOrUncertainResult(current, latest)
      : this.buildEnvelopeFromRecords(current, latest);
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

    this.inFlightMutations.add(params.handoffId);
    try {
      const session = this.requireSession(params.handoffId);
      this.targetForSession(session);
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
      if (nextTurnNumber > session.maxAutonomousTurns) {
        throw new BridgeError("AUTONOMOUS_BUDGET_EXHAUSTED", "Autonomous turn budget exhausted. Report progress and remaining blockers instead of dispatching another turn.");
      }
      let promptText: string;
      let authorizedHead: { ref: string; sha: string } | undefined;

      if (params.intent === "authorize_publish") {
        if (session.publisherOwner !== "remote_gated") {
          throw new BridgeError(
            "PUBLISH_GATE_BLOCKED",
            `Cannot authorize remote publish because publisherOwner is "${session.publisherOwner}" (expected "remote_gated").`,
          );
        }

        if (params.updatedSourceCommitSha || params.updatedSourceRemoteRef || params.updatedExpectedTreeSha) {
          throw new BridgeError("INVALID_CONTRACT_CONFLICT", "Submit changed Git coordinates for verification in a separate follow-up before authorizing publication.");
        }
        const before = this.store.getPublicationLedger(params.handoffId);
        const candidateRef = before.headRef ?? latestTurn.reported?.candidateRef ?? session.sourceRemoteRef;
        if (!candidateRef) {
          throw new BridgeError("CONTRACT_VIOLATION", "A reachable candidate ref is required before publication.");
        }
        const observed = await this.observeCandidate(session, candidateRef, latestTurn.reported?.prUrl);
        if (observed.reconciledPrState === "open_verified") {
          throw new BridgeError(
            "PUBLISH_GATE_BLOCKED",
            `Pull request is already verified open (${observed.reconciledPrUrl ?? "recorded"}). Refusing duplicate publish.`,
          );
        }
        if (observed.reconciledPrState === "uncertain_in_flight" || before.attempted) {
          throw new BridgeError(
            "RECONCILIATION_UNCERTAIN",
            "A previous remote publish attempt is still uncertain_in_flight. Reconcile PR state first before issuing another publish authorization.",
          );
        }

        if (
          latestTurn.directive?.action !== "AUTHORIZE_REMOTE_PUBLISH" ||
          !session.verifiedPublishHeadSha || !observed.observedTreeSha ||
          session.verifiedPublishHeadSha !== this.verifiedHead(session, observed)
        ) {
          throw new BridgeError(
            "CONTRACT_VIOLATION",
            "Stage-2 managed publish is blocked: candidate commit has not passed checkout-free Git Tree-SHA and lockedPaths verification.",
          );
        }

        promptText = compileAuthorizePublishPrompt({
          handoffId: params.handoffId,
          turnNumber: nextTurnNumber,
          verifiedHeadSha: session.verifiedPublishHeadSha,
          verifiedTreeSha: observed.observedTreeSha,
          candidateRef,
          operatorNote: params.message,
        });
        authorizedHead = { ref: candidateRef, sha: session.verifiedPublishHeadSha };
      } else {
        if (params.updatedExpectedTreeSha && !params.updatedSourceCommitSha) {
          throw new BridgeError("INVALID_CONTRACT_CONFLICT", "A new expected tree requires its pinned source commit.");
        }
        if (params.updatedSourceCommitSha && (session.expectedTreeSha || params.updatedExpectedTreeSha)) {
          const tree = await this.resolveSourceTree(session, params.updatedSourceCommitSha);
          if (params.updatedExpectedTreeSha && tree !== params.updatedExpectedTreeSha.toLowerCase()) {
            throw new BridgeError("INVALID_CONTRACT_CONFLICT", "The submitted tree does not match the new pinned source commit.");
          }
          params = { ...params, updatedExpectedTreeSha: tree };
        }
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
        updatedSourceCommitSha: params.updatedSourceCommitSha?.toLowerCase(),
        updatedSourceRemoteRef: params.updatedSourceRemoteRef,
        updatedExpectedTreeSha: params.updatedExpectedTreeSha?.toLowerCase(),
        markPublishInFlight: !!authorizedHead,
        authorizedHead,
        evidenceRefs: params.evidenceRefs,
        now,
      });
    } finally {
      this.inFlightMutations.delete(params.handoffId);
    }

    return await this.attachHandoff({
      handoffId: params.handoffId,
      waitBudgetMs: params.waitBudgetMs,
    });
  }

  private verifiedHead(session: SessionRecord, observed: ObservedResult): string | undefined {
    return observed.reachableRefVerified && observed.baseIsAncestor === true &&
      observed.lockedPathsClean === true && (!session.expectedTreeSha || observed.treeMatchesExpected === true)
      ? observed.observedHeadSha : undefined;
  }

  private async observeCandidate(
    session: SessionRecord,
    candidateRef?: string,
    reportedPrUrl?: string,
    remoteSource = session.remoteUrlOrPath ?? session.localRepoPath,
  ): Promise<ObservedResult> {
    const ledger = this.store.getPublicationLedger(session.handoffId);
    const git: ObservedResult = candidateRef && remoteSource
      ? await this.gitVerifier.verifyCandidate({
          remoteUrlOrPath: remoteSource,
          localRepoPath: session.localRepoPath,
          candidateRef,
          pinnedBaseCommitSha: session.pinnedBaseCommitSha,
          pinnedSourceCommitSha: session.pinnedSourceCommitSha,
          expectedTreeSha: session.expectedTreeSha,
          lockedPaths: session.lockedPaths,
        })
      : { reachableRefVerified: false, reconciledPrState: "none" };
    if (session.publisherOwner === "none" && !reportedPrUrl && !ledger.attempted && !ledger.prUrl) return git;

    const pr = await this.githubReconciler.reconcilePullRequest({
      repoId: session.repoId,
      handoffId: session.handoffId,
      headRef: ledger.attempted ? ledger.headRef : candidateRef,
      headSha: ledger.attempted ? ledger.headSha : git.observedHeadSha,
      priorState: ledger.attempted || ledger.prUrl ? ledger.prState : "none",
      priorUrl: ledger.prUrl,
      reportedPrUrl,
    });
    return { ...git, reconciledPrState: pr.prState, reconciledPrUrl: pr.prUrl };
  }

  async verifyGit(params: {
    handoffId: string;
    candidateRef: string;
    remoteUrlOrPath?: string;
  }): Promise<HandoffResultEnvelopeV2> {
    const session = this.requireSession(params.handoffId);
    const latestTurn = this.requireLatestTurn(params.handoffId);
    if (session.lifecycleStatus !== "settled" && session.lifecycleStatus !== "failed") {
      throw new BridgeError("BUSY_ACTIVE_TURN", "Attach to settle the current turn before updating its verification result.");
    }
    const remoteSource =
      params.remoteUrlOrPath ?? session.remoteUrlOrPath ?? session.localRepoPath;

    if (!remoteSource) {
      throw new BridgeError(
        "INVALID_INPUT",
        `No remoteUrlOrPath or localRepoPath configured on handoff "${params.handoffId}" to fetch "${params.candidateRef}".`,
      );
    }

    const observed = await this.observeCandidate(session, params.candidateRef, latestTurn.reported?.prUrl, remoteSource);
    const verifiedPublishHeadSha = this.verifiedHead(session, observed);

    const evaluated = evaluateOrchestratorDirective({
      mode: session.mode,
      publicationAttempted: this.store.getPublicationLedger(session.handoffId).attempted,
      lifecycleStatus: session.lifecycleStatus,
      publisherOwner: session.publisherOwner,
      turnNumber: latestTurn.turnNumber,
      maxAutonomousTurns: session.maxAutonomousTurns,
      // Rechecking this turn is not another response from the target.
      priorSameBlockerStreak: Math.max(0, session.sameBlockerStreak - 1),
      priorBlockerFingerprint: session.lastBlockerFingerprint,
      evidenceSourceRefs: session.envelope.priorEvidence.map((item) => item.sourceRef),
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
    localOnly?: boolean;
    reason?: string;
  }): Promise<HandoffResultEnvelopeV2> {
    const session = this.requireSession(params.handoffId);
    const turn = this.requireLatestTurn(params.handoffId);
    if (turn.dispatchState === "aborted" || turn.dispatchState === "settled" || turn.dispatchState === "failed") {
      return this.buildEnvelopeFromRecords(session, turn);
    }
    // Local-only abandonment never touches Chrome, even if the operator changed the target URL.
    if (params.localOnly || (session.remoteSessionKey?.startsWith("browser:") && turn.dispatchState === "prepared")) {
      if (!session.remoteSessionKey?.startsWith("browser:")) {
        throw new BridgeError("INVALID_INPUT", "localOnly applies to existing browser chats.");
      }
      if (!this.store.markAborted(session.handoffId, turn.turnId, params.reason ?? "Local browser handoff closed.",
        new Date().toISOString(), turn.dispatchState)) {
        throw new BridgeError("BUSY_ACTIVE_TURN", "The turn changed while closing the handoff. Attach to check its current state.");
      }
      return this.buildEnvelopeFromRecords(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
    }
    const target = this.targetForSession(session);
    if (target.transport === "browser") {
      throw new BridgeError("INVALID_CONTRACT_CONFLICT", "A browser chat cannot safely stop a specific run. Inspect the chat; localOnly=true closes tracking without stopping Robo.");
    }
    if (!session.remoteSessionKey || !turn.runId) {
      throw new BridgeError("RECONCILIATION_UNCERTAIN", "Cannot abort without an accepted run ID. Attach to this handoff to reconcile its submission.");
    }
    const client = new OpenClawGatewayClient(target, this.config.dataDir);
    if (!await client.abortRun(session.remoteSessionKey, turn.runId)) {
      throw new BridgeError("RECONCILIATION_UNCERTAIN", "Gateway did not confirm cancellation of this run. Attach to observe its outcome.");
    }
    this.store.markAborted(session.handoffId, turn.turnId, params.reason ?? "Aborted by local orchestrator.", new Date().toISOString());
    return this.buildEnvelopeFromRecords(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
  }

  private async reconcileUndispatchedTurn(
    session: SessionRecord,
    turn: TurnRecord,
    target: GatewayTargetConfig,
    client: OpenClawGatewayClient,
  ): Promise<void> {
    const { handoffId, remoteSessionKey } = session;
    const { turnId } = turn;
    const recordUncertain = (errorText: string) =>
      this.store.markTurnUncertain({ handoffId, turnId, errorText, now: new Date().toISOString() });
    const recordAccepted = (runId: string, key: string, sessionId?: string) =>
      this.store.recordDispatched({
        handoffId, turnId, runId, remoteSessionKey: key, remoteSessionId: sessionId,
        remoteSessionUrl: buildPrettySessionUrl({ originUrl: target.url, agentId: target.agentId, label: session.title, sessionKey: key }),
        now: new Date().toISOString(),
      });

    // Older 'dispatch_pending' rows predate the pre-I/O claim and may have reached the Gateway.
    if (turn.dispatchState !== "prepared") {
      if (!remoteSessionKey) {
        recordUncertain("The original submission has no recorded session key. Inspect the Gateway before starting another handoff.");
        return;
      }
      const expectedRunId = turn.kind === "initial" ? undefined : turn.idempotencyKey;
      let history;
      try {
        history = await client.readHistory(remoteSessionKey, session.remoteSessionId, expectedRunId);
      } catch (err) {
        if (!(err instanceof BridgeError) || err.code === "AUTH_LOGIN_REQUIRED") throw err;
        recordUncertain(`Cannot confirm submission in Gateway history: ${err.message}`);
        return;
      }
      // Initial runs use a Gateway-generated UUID; followups use the chat.send idempotency key.
      // Only the exact stored user submission or an input receipt proves which run was accepted.
      const matching = history.messages.filter((m) =>
        m.role === "user" && m.text === turn.promptText && m.runId && (!expectedRunId || m.runId === expectedRunId));
      const runId = history.acceptedRunId ?? (matching.length === 1 ? matching[0]?.runId : undefined);
      if (history.sessionKey !== remoteSessionKey || !history.sessionId ||
          (session.remoteSessionId && session.remoteSessionId !== history.sessionId) || !runId) {
        recordUncertain("No exact acceptance record for this turn in the bound Gateway session. Inspect the session or attach again when its receipt becomes visible.");
        return;
      }
      recordAccepted(runId, remoteSessionKey, history.sessionId);
      return;
    }

    // Fail authentication read-only, while the never-submitted intent is still safe to resume.
    await client.health();
    const initialParams = turn.kind === "initial" && turn.createParamsJson
      ? JSON.parse(turn.createParamsJson) as Parameters<OpenClawGatewayClient["createSession"]>[0] : undefined;
    if (!remoteSessionKey || (turn.kind === "initial" && initialParams?.key !== remoteSessionKey)) {
      throw new BridgeError("INVALID_INPUT", "Prepared turn has no matching target session key.");
    }
    if (!this.store.claimDispatch(handoffId, turnId)) return;
    let result;
    try {
      result = initialParams ? await client.createSession(initialParams) : await client.sendChat({
        sessionKey: remoteSessionKey, sessionId: session.remoteSessionId,
        agentId: target.agentId, message: turn.promptText, idempotencyKey: turn.idempotencyKey,
      });
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
      recordUncertain(err.message);
      if (err.code === "AUTH_LOGIN_REQUIRED") throw err;
      return;
    }
    if ("key" in result && result.key !== remoteSessionKey) {
      recordUncertain("Gateway returned a different session key than the prepared handoff. Inspect the original submission.");
      return;
    }
    if ("runError" in result && result.runError && !result.runId) {
      const error = `Gateway rejected the opening turn: ${JSON.stringify(result.runError)}`;
      this.store.settleTurn({ handoffId, turnId, lifecycleStatus: "failed", dispatchState: "failed",
        observed: { reachableRefVerified: false, reconciledPrState: "none", verificationNotes: [error] },
        directive: { action: "ESCALATE_TO_HUMAN", reason: error, remainingTurnBudget: Math.max(0, session.maxAutonomousTurns - 1) },
        sameBlockerStreak: 0, errorText: error, now: new Date().toISOString() });
      return;
    }
    if (result.runId) {
      recordAccepted(result.runId, remoteSessionKey, "sessionId" in result ? result.sessionId : session.remoteSessionId);
    } else {
      recordUncertain("Gateway returned a session without a run ID. Attach to look for this exact submission.");
    }
  }

  private async finalizeSettledTurn(params: {
    session: SessionRecord;
    turn: TurnRecord;
    terminalReplyText?: string;
    runFailedError?: string;
  }): Promise<HandoffResultEnvelopeV2> {
    const { session, turn, terminalReplyText: rawReply, runFailedError } = params;
    const now = new Date().toISOString();
    const pubLedger = this.store.getPublicationLedger(session.handoffId);

    if (runFailedError) {
      const prCheck = await this.githubReconciler.reconcilePullRequest({
        repoId: session.repoId,
        headRef: pubLedger.headRef ?? session.sourceRemoteRef,
        headSha: pubLedger.headSha ?? session.pinnedSourceCommitSha,
        handoffId: session.handoffId,
        priorState: pubLedger.attempted || pubLedger.prUrl ? pubLedger.prState : "none",
        priorUrl: pubLedger.prUrl,
      });
      const observed: ObservedResult = {
        reachableRefVerified: false,
        reconciledPrState: prCheck.prState,
        reconciledPrUrl: prCheck.prUrl,
        verificationNotes: [runFailedError],
      };
      const evalRes = evaluateOrchestratorDirective({
        mode: session.mode,
        lifecycleStatus: "failed",
        publisherOwner: session.publisherOwner,
        turnNumber: turn.turnNumber,
        maxAutonomousTurns: session.maxAutonomousTurns,
        priorSameBlockerStreak: session.sameBlockerStreak,
        priorBlockerFingerprint: session.lastBlockerFingerprint,
        evidenceSourceRefs: session.envelope.priorEvidence.map((item) => item.sourceRef),
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

    if (!rawReply?.trim()) {
      this.store.markTurnUncertain({ handoffId: session.handoffId, turnId: turn.turnId,
        errorText: "Run reached a terminal state, but its exact reply is unavailable. Inspect this Gateway run before continuing.", now });
      return this.buildRunningOrUncertainResult(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
    }
    const reported = parseReportedResult(rawReply, session.remoteSessionKey?.startsWith("browser:") ? "browser" : "gateway");

    const candidateRef = reported.candidateRef ?? session.sourceRemoteRef ??
      (session.mode === "verify_only" && session.publisherOwner === "none" ? session.pinnedSourceCommitSha : undefined);
    const observed = await this.observeCandidate(session, candidateRef, reported.prUrl);
    const verifiedPublishHeadSha = this.verifiedHead(session, observed);

    const evaluated = evaluateOrchestratorDirective({
      mode: session.mode,
      lifecycleStatus: "settled",
      publicationAttempted: pubLedger.attempted,
      publisherOwner: session.publisherOwner,
      turnNumber: turn.turnNumber,
      maxAutonomousTurns: session.maxAutonomousTurns,
      priorSameBlockerStreak: session.sameBlockerStreak,
      priorBlockerFingerprint: session.lastBlockerFingerprint,
      evidenceSourceRefs: session.envelope.priorEvidence.map((item) => item.sourceRef),
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
      mode: session.mode,
      lifecycleStatus: status,
      publisherOwner: session.publisherOwner,
      turnNumber: turn.turnNumber,
      maxAutonomousTurns: session.maxAutonomousTurns,
      priorSameBlockerStreak: session.sameBlockerStreak,
      priorBlockerFingerprint: session.lastBlockerFingerprint,
      evidenceSourceRefs: session.envelope.priorEvidence.map((item) => item.sourceRef),
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
    const directive = turn.dispatchState === "aborted" && session.remoteSessionKey?.startsWith("browser:")
      ? {
          action: "ESCALATE_TO_HUMAN" as const,
          reason: "Local tracking closed. The bridge did not stop a remote browser run.",
          remainingTurnBudget: Math.max(0, session.maxAutonomousTurns - turn.turnNumber),
        }
      : turn.directive ??
      evaluateOrchestratorDirective({
        mode: session.mode,
        lifecycleStatus: session.lifecycleStatus,
        publisherOwner: session.publisherOwner,
        turnNumber: turn.turnNumber,
        maxAutonomousTurns: session.maxAutonomousTurns,
        priorSameBlockerStreak: session.sameBlockerStreak,
        priorBlockerFingerprint: session.lastBlockerFingerprint,
        evidenceSourceRefs: session.envelope.priorEvidence.map((item) => item.sourceRef),
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
