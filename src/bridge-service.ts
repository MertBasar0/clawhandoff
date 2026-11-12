import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { A2AClient, type A2ATurnObservation } from "./a2a-client.js";
import { AcpSessionClient, resolveAcpLaunchCommand } from "./acp-client.js";
import { githubCloneUrl, parseCandidateRef } from "./candidate-ref.js";
import { BrowserNotReady, ChromeChat, type SendOutcome } from "./chrome-chat.js";
import {
  browserRecoveryLimits,
  browserRestoreStep,
  decideBrowserRecovery,
  noteHealthy,
  noteReload,
  noteUnhealthy,
  type BrowserCondition,
  type BrowserPageHealth,
  type BrowserRecoveryLimits,
  type BrowserRecoveryState,
  type BrowserRecoveryStep,
} from "./browser-health.js";
import { inspectBrowserTurn, wrapBrowserNudge, wrapBrowserPrompt } from "./browser-turn.js";
import { CodexAppServerClient } from "./codex-client.js";
import { normalizeA2ABaseUrl, parseBrowserSessionRoute, sameBrowserSessionUrl } from "./config.js";
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
  type A2ATargetConfig,
  type AcpTargetConfig,
  type BridgeConfig,
  type BridgeTargetConfig,
  type BrowserTargetConfig,
  type CodexTargetConfig,
  type GatewayTargetConfig,
  type HandoffResultEnvelopeV2,
  type OrchestratorAction,
  type ObservedResult,
  type PreflightResult,
  type SessionRecord,
  type TargetTransport,
  type TurnRecord,
} from "./types.js";

/** Why a browser turn returns without a reply, as far as the bridge knows. */
interface BrowserWaiting {
  condition: BrowserCondition;
  health: BrowserPageHealth;
  reloads: number;
}

interface BrowserPublicationCheck {
  at: number;
  note: string;
  /** GitHub shows the pull request at a head with the verified tree. */
  landed?: { url: string; headSha: string };
  /** The head moved to a commit without the verified tree. */
  foreign?: string;
}

interface DirectiveOverride {
  action: OrchestratorAction;
  reason: string;
  condition?: BrowserCondition;
}

export class BridgeService {
  private readonly config: BridgeConfig;
  private readonly store: BridgeStore;
  private readonly gitVerifier: GitVerifier;
  private readonly githubReconciler: GitHubReconciler;
  private readonly browserChats = new Map<string, ChromeChat>();
  /** Last visible change per browser turn, for stall detection. */
  private readonly browserProgress = new Map<string, { progress: string; since: number }>();
  /** Nudges this process sent per browser turn, in case the chat does not show them as expected. */
  private readonly browserNudgesSent = new Map<string, number>();
  /** Turns whose nudge this process typed but could not send yet. */
  private readonly browserNudgeTyped = new Set<string>();
  /** Per browser turn: the current episode of a chat that is not ready. */
  private readonly browserRecovery = new Map<string, BrowserRecoveryState>();
  /** When a claimed request was first seen neither in the composer nor in the transcript. */
  private readonly browserUnsentSince = new Map<string, number>();
  /** The latest GitHub check of a browser turn that publishes an update. */
  private readonly browserPublicationChecks = new Map<string, BrowserPublicationCheck>();
  private readonly browserLimits: BrowserRecoveryLimits = browserRecoveryLimits();
  private readonly a2aClients = new Map<string, A2AClient>();
  private readonly codexClients = new Map<string, CodexAppServerClient>();
  private readonly acpClients = new Map<string, AcpSessionClient>();
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
    await Promise.all([
      ...[...this.browserChats.values()].map((chat) => chat.close()),
      ...[...this.codexClients.values()].map((client) => client.close()),
      ...[...this.acpClients.values()].map((client) => client.close()),
    ]);
    this.browserChats.clear();
    this.codexClients.clear();
    this.acpClients.clear();
    this.a2aClients.clear();
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
      chat = new ChromeChat({ ...target.browserMcp, sessionUrl: target.sessionUrl, basePath: target.basePath,
        navigationTimeoutMs: this.browserLimits.navigationTimeoutMs });
      this.browserChats.set(key, chat);
    }
    return chat;
  }

  private a2a(target: A2ATargetConfig): A2AClient {
    const key = JSON.stringify([
      normalizeA2ABaseUrl(target.url),
      target.agentCardPath,
      target.protocolVersion,
      target.authTokenEnvVar,
      target.authHeaderName,
      target.headers,
    ]);
    let client = this.a2aClients.get(key);
    if (!client) {
      client = new A2AClient(target);
      this.a2aClients.set(key, client);
    }
    return client;
  }

  private codex(target: CodexTargetConfig): CodexAppServerClient {
    const key = JSON.stringify([
      target.targetId,
      target.command,
      target.args,
      target.cwd,
      target.model,
      target.effort,
      target.approvalPolicy,
      target.sandbox,
    ]);
    let client = this.codexClients.get(key);
    if (!client) {
      client = new CodexAppServerClient(target);
      this.codexClients.set(key, client);
    }
    return client;
  }

  private acp(target: AcpTargetConfig): AcpSessionClient {
    const key = JSON.stringify([
      target.targetId,
      target.agent,
      target.command,
      target.args,
      target.cwd,
      target.model,
      target.modeId,
      target.permissionMode,
    ]);
    let client = this.acpClients.get(key);
    if (!client) {
      client = new AcpSessionClient(target);
      this.acpClients.set(key, client);
    }
    return client;
  }

  private buildRemoteSessionKey(target: BridgeTargetConfig, handoffId: string): string {
    if (target.transport === "browser") return `browser:${target.sessionUrl}`;
    if (target.transport === "a2a") return `a2a:${normalizeA2ABaseUrl(target.url)}#${handoffId}`;
    if (target.transport === "codex") return `codex:${target.targetId}#${handoffId}`;
    if (target.transport === "acp") return `acp:${resolveAcpLaunchCommand(target).agentLabel}#${handoffId}`;
    return `agent:${target.agentId}:bridge-${handoffId.slice(5)}`;
  }

  private sessionTransport(session: SessionRecord): TargetTransport {
    const key = session.remoteSessionKey ?? "";
    if (key.startsWith("browser:")) return "browser";
    if (key.startsWith("a2a:")) return "a2a";
    if (key.startsWith("codex:")) return "codex";
    if (key.startsWith("acp:")) return "acp";
    return "gateway";
  }

  private sessionMatchesTarget(session: SessionRecord, target: BridgeTargetConfig): boolean {
    const key = session.remoteSessionKey;
    if (!key) return false;
    if (target.transport === "browser") {
      return (
        key.startsWith("browser:") &&
        sameBrowserSessionUrl(key.slice("browser:".length), target.sessionUrl, target.basePath)
      );
    }
    if (target.transport === "a2a") {
      return key === `a2a:${normalizeA2ABaseUrl(target.url)}#${session.handoffId}`;
    }
    if (target.transport === "codex") {
      return key === `codex:${target.targetId}#${session.handoffId}`;
    }
    if (target.transport === "acp") {
      return key === `acp:${resolveAcpLaunchCommand(target).agentLabel}#${session.handoffId}`;
    }
    return (
      !key.startsWith("browser:") &&
      !key.startsWith("a2a:") &&
      !key.startsWith("codex:") &&
      !key.startsWith("acp:")
    );
  }

  private resolveExecutionCwd(session: SessionRecord, fallbackCwd?: string): string | undefined {
    if (session.worktreeName) {
      return this.gitVerifier.worktreePath(session.handoffId, session.worktreeName);
    }
    return session.localRepoPath ?? fallbackCwd;
  }

  private targetForSession(session: SessionRecord): BridgeTargetConfig {
    const target = this.getTarget(session.targetId);
    if (!this.sessionMatchesTarget(session, target)) {
      throw new BridgeError(
        "INVALID_CONTRACT_CONFLICT",
        "The configured transport or destination differs from this handoff's recorded destination.",
      );
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
        targetId: params.targetId,
        transport: "browser",
        gatewayHealthy: false,
        browserReady: true,
        targetHealthy: true,
        authReady: true,
        agentFound: true,
        availableAgentIds: [target.agentId],
        rivalPullRequests: await this.githubReconciler.findRivalPullRequests(params),
      };
    }
    if (target.transport === "a2a") {
      const client = this.a2a(target);
      let targetHealthy = false;
      let authReady = false;
      let agentCard: PreflightResult["agentCard"];
      let availableAgentIds: string[] = [];
      let remediation: string | undefined;
      try {
        const card = await client.discoverAgentCard(true);
        targetHealthy = true;
        authReady = true;
        agentCard = card;
        availableAgentIds = [card.name];
      } catch (err) {
        if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") {
          targetHealthy = false;
          authReady = false;
          remediation = err.remediation ?? err.message;
        } else {
          throw err;
        }
      }
      return {
        targetId: params.targetId,
        transport: "a2a",
        gatewayHealthy: false,
        targetHealthy,
        authReady,
        agentFound: targetHealthy,
        availableAgentIds,
        ...(agentCard ? { agentCard } : {}),
        rivalPullRequests: await this.githubReconciler.findRivalPullRequests(params),
        ...(remediation ? { remediation } : {}),
      };
    }
    if (target.transport === "codex") {
      const status = await this.codex(target).preflight();
      return {
        targetId: params.targetId,
        transport: "codex",
        gatewayHealthy: false,
        targetHealthy: status.healthy,
        authReady: status.authReady,
        agentFound: status.healthy,
        availableAgentIds: ["codex"],
        rivalPullRequests: await this.githubReconciler.findRivalPullRequests(params),
        ...(status.remediation ? { remediation: status.remediation } : {}),
      };
    }
    if (target.transport === "acp") {
      let targetHealthy = false;
      let authReady = false;
      let availableAgentIds: string[] = [];
      let remediation: string | undefined;
      try {
        const status = await this.acp(target).preflight();
        targetHealthy = status.healthy;
        authReady = status.authReady;
        availableAgentIds = [status.agentLabel];
      } catch (err) {
        if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") {
          targetHealthy = false;
          authReady = false;
          remediation = err.remediation ?? err.message;
        } else {
          throw err;
        }
      }
      return {
        targetId: params.targetId,
        transport: "acp",
        gatewayHealthy: false,
        targetHealthy,
        authReady,
        agentFound: targetHealthy,
        availableAgentIds,
        rivalPullRequests: await this.githubReconciler.findRivalPullRequests(params),
        ...(remediation ? { remediation } : {}),
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
      transport: "gateway",
      gatewayHealthy,
      targetHealthy: gatewayHealthy,
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
    const normalized = validateAndNormalizeEnvelope(
      params.envelope,
      this.config.defaultPublisherOwner ?? "remote_gated",
    );
    const target = this.getTarget(params.targetId);
    if ((target.transport === "browser" || target.transport === "a2a") && params.worktreeName) {
      throw new BridgeError(
        "INVALID_INPUT",
        `A ${target.transport} target cannot create a local named worktree.`,
      );
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

    const handoffId = `hoff_${randomUUID()}`;
    let isolatedWorktreePath: string | undefined;
    let effectiveLocalRepoPath = source.localRepoPath;
    if (params.worktreeName && (target.transport === "codex" || target.transport === "acp")) {
      const worktreeSourceRepo = source.localRepoPath ?? target.cwd;
      if (!worktreeSourceRepo) {
        throw new BridgeError(
          "INVALID_INPUT",
          `Creating a local isolated worktree for ${target.transport} target "${params.targetId}" requires gitContext.localRepoPath or target.cwd.`,
        );
      }
      isolatedWorktreePath = await this.gitVerifier.ensureIsolatedWorktree({
        sourceRepoPath: worktreeSourceRepo,
        handoffId,
        worktreeName: params.worktreeName,
        checkoutCommitSha: source.pinnedSourceCommitSha ?? source.pinnedBaseCommitSha,
      });
      effectiveLocalRepoPath = worktreeSourceRepo;
    }

    const envelopeWithTree = {
      ...normalized,
      gitContext: {
        ...normalized.gitContext,
        ...(effectiveLocalRepoPath ? { localRepoPath: effectiveLocalRepoPath } : {}),
        ...(expectedTreeSha ? { expectedTreeSha } : {}),
      },
    };

    const turnId = `turn_${randomUUID()}`;
    const idempotencyKey = `idem_${randomUUID()}`;
    const now = new Date().toISOString();
    const maxAutonomousTurns =
      params.maxAutonomousTurns ?? this.config.defaultMaxAutonomousTurns ?? 5;

    const promptText = compileInitialHandoffPrompt({
      handoffId,
      envelope: envelopeWithTree,
      isolatedWorktreePath,
    });

    const remoteSessionKey = this.buildRemoteSessionKey(target, handoffId);
    const isGateway = target.transport === undefined || target.transport === "gateway";
    const createRpcParams = isGateway
      ? {
          key: remoteSessionKey,
          agentId: target.agentId,
          label: envelopeWithTree.title,
          message: promptText,
          idempotencyKey,
          projectId: target.projectId,
          worktreeBaseRef: envelopeWithTree.gitContext.pinnedBaseCommitSha,
          worktreeName: params.worktreeName,
        }
      : undefined;
    const initialRemoteSessionUrl =
      target.transport === "browser"
        ? target.sessionUrl
        : target.transport === "a2a"
          ? normalizeA2ABaseUrl(target.url)
          : undefined;

    const sessionRecord: SessionRecord = {
      handoffId,
      requestId: envelopeWithTree.requestId,
      workspaceId: envelopeWithTree.workspaceId,
      targetId: params.targetId,
      title: envelopeWithTree.title,
      mode: envelopeWithTree.mode,
      publisherOwner: envelopeWithTree.publisherOwner,
      repoId: envelopeWithTree.gitContext.repoId,
      localRepoPath: effectiveLocalRepoPath,
      remoteUrlOrPath: envelopeWithTree.gitContext.remoteUrlOrPath,
      pinnedBaseCommitSha: envelopeWithTree.gitContext.pinnedBaseCommitSha,
      pinnedSourceCommitSha: envelopeWithTree.gitContext.pinnedSourceCommitSha,
      sourceRemoteRef: envelopeWithTree.gitContext.sourceRemoteRef,
      expectedTreeSha,
      lockedPaths: envelopeWithTree.gitContext.lockedPaths ?? [],
      envelope: envelopeWithTree,
      worktreeName: params.worktreeName,
      remoteSessionKey,
      remoteSessionUrl: initialRemoteSessionUrl,
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
        createParamsJson: createRpcParams ? JSON.stringify(createRpcParams) : undefined,
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
      if (target.transport === "a2a") {
        return await this.attachA2ATurn(session, latestTurn, target, waitBudgetMs);
      }
      if (target.transport === "codex") {
        return await this.attachCodexTurn(session, latestTurn, target, waitBudgetMs);
      }
      if (target.transport === "acp") {
        return await this.attachAcpTurn(session, latestTurn, target, waitBudgetMs);
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

  /** How long this turn's visible state has stayed the same, across attaches in this process. */
  private quietBrowserTurnMs(turnId: string, progress: string | undefined): number {
    if (progress === undefined) return 0;
    const now = Date.now();
    const seen = this.browserProgress.get(turnId);
    if (seen?.progress === progress) return now - seen.since;
    this.browserProgress.set(turnId, { progress, since: now });
    return 0;
  }

  /** Records a not-ready read of this turn's chat and decides what to do about it. */
  private browserRecoveryStep(turnId: string, health: Exclude<BrowserPageHealth, "ready">): BrowserRecoveryStep {
    const now = Date.now();
    const state = noteUnhealthy(this.browserRecovery.get(turnId) ?? noteHealthy(), now);
    this.browserRecovery.set(turnId, state);
    return decideBrowserRecovery(state, health, now, this.browserLimits);
  }

  /**
   * For a turn that authorized an update of an existing pull request, GitHub shows whether the
   * push already happened, whatever the chat shows. Checked at most once per interval unless forced.
   */
  private async browserPublication(session: SessionRecord, turn: TurnRecord, force: boolean): Promise<BrowserPublicationCheck | undefined> {
    const update = session.envelope.gitContext.updatePullRequest;
    if (turn.kind !== "authorize_publish" || !update || !session.expectedTreeSha) return undefined;
    const now = Date.now();
    const last = this.browserPublicationChecks.get(turn.turnId);
    if (last && (last.landed || (!force && now - last.at < this.browserLimits.publishCheckIntervalMs))) return last;
    const pr = await this.githubReconciler.reconcilePullRequestUpdate({
      repoId: session.repoId,
      url: update.url,
      expectedHeadSha: update.expectedHeadSha,
      publishedTreeSha: session.expectedTreeSha,
    });
    const check: BrowserPublicationCheck = { at: now, note: pr.note };
    if (pr.prState === "open_verified" && pr.headSha) {
      check.landed = { url: pr.prUrl, headSha: pr.headSha };
      this.store.recordPublicationLanded({ handoffId: session.handoffId, prUrl: pr.prUrl, now: new Date().toISOString() });
    } else if (pr.prState === "uncertain_in_flight" && pr.headSha && pr.headSha !== update.expectedHeadSha.toLowerCase()) {
      // The head moved, but not to the verified tree: someone else changed the pull request.
      check.foreign = pr.note;
    }
    this.browserPublicationChecks.set(turn.turnId, check);
    return check;
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
    const limits = this.browserLimits;
    const deadline = Date.now() + waitBudgetMs;
    let submitted = turn.dispatchState !== "prepared";
    let accepted = turn.dispatchState === "dispatched" || Boolean(turn.runId);
    let needsDispatchRecord = turn.dispatchState !== "dispatched";
    let reply: string | undefined;
    let markedUncertain = false;
    /** Why this attach returns without a reply, when the bridge knows more than "still running". */
    let waiting: BrowserWaiting | undefined;
    const recovery = {
      idleStallMs: target.recovery?.idleStallMs ?? 180_000,
      busyStallMs: target.recovery?.busyStallMs ?? 1_200_000,
      maxNudges: target.recovery?.maxNudges ?? 2,
    };
    const requestText = wrapBrowserPrompt(idempotencyKey, turn.promptText);
    const uncertain = (errorText: string) => {
      markedUncertain = true;
      this.store.markTurnUncertain({ handoffId, turnId, errorText, now: new Date().toISOString() });
    };
    /** Waits one poll interval inside the budget. False when the budget is spent. */
    const pause = async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(remaining, limits.pollMs));
      return true;
    };
    const claimRequest = () => {
      const claimed = this.store.claimDispatch(handoffId, turnId);
      submitted = true; // A competing attach may already have claimed the same turn.
      return claimed;
    };

    try {
      let transientIdlePolls = 0;
      for (;;) {
        // The chat must be ready before anything in it is read as progress or anything is typed.
        const view = await chat.observe(idempotencyKey);
        if (view.health !== "ready") {
          const step = this.browserRecoveryStep(turnId, view.health);
          if (step.kind === "give_up") {
            const state = this.browserRecovery.get(turnId)!;
            waiting = { condition: step.condition, health: view.health, reloads: state.reloads };
            break;
          }
          if (step.kind === "reload") {
            const outcome = await chat.reload();
            const state = noteReload(this.browserRecovery.get(turnId)!, outcome, Date.now());
            this.browserRecovery.set(turnId, state);
            waiting = { condition: view.health === "loading" ? "chat_loading" : "chat_disconnected", health: view.health, reloads: state.reloads };
            if (outcome === "offline") continue; // The next round reports browser_offline.
            if (!(await pause())) break;
            continue;
          }
          waiting = { condition: step.condition, health: view.health, reloads: this.browserRecovery.get(turnId)!.reloads };
          if (!(await pause())) break;
          continue;
        }
        if (this.browserRecovery.get(turnId)?.unhealthySince !== undefined) {
          // Time spent loading or disconnected is not Robo being quiet: the stall clock starts over.
          this.browserProgress.delete(turnId);
        }
        this.browserRecovery.set(turnId, noteHealthy());
        waiting = undefined;

        if (!submitted) {
          const outcome = await this.browserSend(() => chat.send(requestText, claimRequest));
          if (outcome === "typed") waiting = { condition: "request_typed_unsent", health: "ready", reloads: 0 };
          if (outcome !== "sent" && !(await pause())) break;
          continue;
        }

        const receipt = inspectBrowserTurn(view.transcript!, idempotencyKey, accepted);
        if (needsDispatchRecord && (receipt.state === "running" || receipt.state === "completed" || receipt.state === "failed")) {
          this.store.recordDispatched({
            handoffId, turnId, remoteSessionKey: `browser:${target.sessionUrl}`,
            remoteSessionUrl: target.sessionUrl, runId: `browser:${idempotencyKey}`, now: new Date().toISOString(),
          });
          accepted = true;
          needsDispatchRecord = false;
          this.browserUnsentSince.delete(turnId);
        }
        if (receipt.state === "completed") {
          this.forgetBrowserTurn(turnId);
          reply = receipt.text;
          break;
        }

        // Claimed, yet not in the transcript: either the request still waits in the composer, or it is in flight.
        if (receipt.state === "absent") {
          if (view.draft === "request") {
            waiting = { condition: "request_typed_unsent", health: "ready", reloads: 0 };
            if (!view.busy) {
              if (this.store.browserResendClaimed(turnId)) {
                uncertain("The bridge already pressed send once for this request, yet it is still in the composer and not in the transcript. Open the chat, press send yourself if the request is still unsent, then attach again.");
                break;
              }
              const outcome = await this.browserSend(() =>
                chat.submitTyped(requestText, () => this.store.claimBrowserResend(handoffId, turnId)));
              if (outcome === "sent") continue;
              if (outcome === "unclaimed") {
                uncertain("The request is still in the composer, and the bridge may not send it again. Open the chat, press send yourself if it is still unsent, then attach again.");
                break;
              }
            }
            if (!(await pause())) break;
            continue;
          }
          const since = this.browserUnsentSince.get(turnId) ?? Date.now();
          this.browserUnsentSince.set(turnId, since);
          if (Date.now() - since >= limits.unsentConfirmMs) {
            uncertain("The request was claimed for sending, but the chat shows it neither in the composer nor in the transcript. Open the chat: if it is not there or queued, abort this handoff locally and start again.");
            break;
          }
          if (!(await pause())) break;
          continue;
        }
        this.browserUnsentSince.delete(turnId);

        const quietMs = this.quietBrowserTurnMs(turnId, receipt.progress);
        const idleStalled = receipt.state === "running" && receipt.idleWithoutAnswer && quietMs >= recovery.idleStallMs;
        if (accepted && (receipt.state === "failed" || idleStalled)) {
          const nudges = Math.max(receipt.nudges ?? 0, this.browserNudgesSent.get(turnId) ?? 0);
          // A nudge can make Robo act again, so GitHub decides first whether a push already happened.
          const publication = await this.browserPublication(session, turn, true);
          if (publication?.foreign) {
            uncertain(`${publication.foreign} The bridge does not nudge Robo while the pull request has a head it did not authorize. Inspect the pull request and the chat, then attach again.`);
            break;
          }
          if (nudges >= recovery.maxNudges) {
            const landed = publication?.landed
              ? `The publication landed (${publication.landed.url} is at ${publication.landed.headSha} with the verified tree); only Robo's final reply, such as the pull request description edit, is missing. `
              : "";
            uncertain(landed + (receipt.state === "failed"
              ? `Robo's reply could not be completed${nudges ? ` after ${nudges} bridge nudge(s)` : ""}. Open the chat, check what already happened, press Try again if it fits, then attach again without resending.`
              : `Robo has been idle without answering for ${Math.round(quietMs / 60_000)} min${nudges ? ` after ${nudges} bridge nudge(s)` : ""}. Open the chat, then attach again without resending.`));
            break;
          }
          // A nudge this process typed but could not send is finished, not counted again.
          const typedBefore = this.browserNudgeTyped.has(turnId);
          const outcome = await this.browserSend(() => chat.send(wrapBrowserNudge(idempotencyKey, publication?.landed), () => {
            if (!typedBefore) this.browserNudgesSent.set(turnId, nudges + 1);
            return true;
          }));
          if (outcome === "typed") this.browserNudgeTyped.add(turnId);
          if (outcome === "sent") {
            this.browserNudgeTyped.delete(turnId);
            this.browserProgress.delete(turnId);
          }
          transientIdlePolls = 0;
          if (outcome !== "sent" && !(await pause())) break;
          continue;
        }
        if (receipt.state === "running" && !receipt.idleWithoutAnswer && quietMs >= recovery.busyStallMs) {
          uncertain(`Robo has shown as working for ${Math.round(quietMs / 60_000)} min with no visible progress. A sub-session may be stuck: open the chat and its sub-sessions, press Try again on any reply that could not be completed, then attach again without resending.`);
          break;
        }
        if (receipt.state === "running" || receipt.state === "pending") {
          transientIdlePolls = 0;
        }
        if (receipt.state === "uncertain") {
          if (receipt.transientIdle && waitBudgetMs > 0 && transientIdlePolls < 2) {
            const remainingForConfirm = deadline - Date.now();
            if (remainingForConfirm <= 0) {
              if (accepted) break;
            } else {
              transientIdlePolls += 1;
              await delay(Math.min(remainingForConfirm, limits.pollMs));
              continue;
            }
          }
          uncertain("The visible chat cannot tie a finished answer to this exact turn. Inspect the existing chat and attach again.");
          break;
        }
        if (!(await pause())) {
          if (receipt.state === "pending") {
            uncertain("The sent turn is not yet confirmed in the configured chat. Reopen it and attach without resending.");
          }
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      const attachAgain = `When the chat is ready, attach to ${handoffId}.`;
      if (!submitted) {
        throw new BridgeError(error.code, error.message, error.remediation ? `${error.remediation} ${attachAgain}` : attachAgain);
      }
      uncertain(error.remediation ? `${error.message} ${error.remediation}` : error.message);
    }
    if (reply) return this.finalizeSettledTurn({ session, turn, terminalReplyText: reply });
    const latest = this.requireLatestTurn(handoffId);
    const current = this.requireSession(handoffId);
    if (current.lifecycleStatus !== "running" && current.lifecycleStatus !== "uncertain") {
      return this.buildEnvelopeFromRecords(current, latest);
    }
    let publication: BrowserPublicationCheck | undefined;
    try {
      publication = await this.browserPublication(session, turn, false);
    } catch {
      // GitHub is only extra evidence here. The chat state stands on its own.
    }
    return this.buildRunningOrUncertainResult(current, latest,
      this.browserDirective(waiting, markedUncertain, publication?.landed));
  }

  /** Runs one send. A chat that stopped being ready before anything was claimed is read again. */
  private async browserSend(send: () => Promise<SendOutcome>): Promise<SendOutcome | "not_ready"> {
    try {
      return await send();
    } catch (error) {
      if (error instanceof BrowserNotReady) return "not_ready";
      throw error;
    }
  }

  private forgetBrowserTurn(turnId: string): void {
    this.browserProgress.delete(turnId);
    this.browserNudgesSent.delete(turnId);
    this.browserNudgeTyped.delete(turnId);
    this.browserRecovery.delete(turnId);
    this.browserUnsentSince.delete(turnId);
    this.browserPublicationChecks.delete(turnId);
  }

  /** Turns what this attach learned about the browser into the directive the caller acts on. */
  private browserDirective(
    waiting: BrowserWaiting | undefined,
    markedUncertain: boolean,
    landed: { url: string; headSha: string } | undefined,
  ): DirectiveOverride | undefined {
    const published = landed
      ? `The publication landed: ${landed.url} is at ${landed.headSha} with the verified tree, so do not authorize another publish. `
      : "";
    if (waiting?.condition === "browser_offline" || waiting?.condition === "chat_unreachable") {
      return { action: "RESTORE_BROWSER", condition: waiting.condition,
        reason: published + browserRestoreStep(waiting.condition, waiting.health, waiting.reloads) };
    }
    // A reason recorded in this attach needs a person; the conditions below never override it.
    if (markedUncertain) return undefined;
    if (waiting?.condition === "chat_loading" || waiting?.condition === "chat_disconnected") {
      const what = waiting.condition === "chat_loading" ? "is still loading" : "is reconnecting to its Gateway (it shows a saved conversation)";
      return { action: "POLL_ATTACH", condition: waiting.condition,
        reason: `${published}The chat ${what}. The bridge treats this as not yet observed, not as Robo stopping` +
          (waiting.reloads ? `, and reloaded the tab ${waiting.reloads} time(s)` : "") +
          `. Call bridge_handoff_attach again; nothing is resent and no nudge is typed while the chat is not ready.` };
    }
    if (waiting?.condition === "request_typed_unsent") {
      return { action: "POLL_ATTACH", condition: "request_typed_unsent",
        reason: `${published}The request is typed in the chat but not sent yet, because the chat could not send it. The bridge presses send once, as soon as the chat is ready and idle. Call bridge_handoff_attach again.` };
    }
    if (landed) {
      return { action: "POLL_ATTACH", condition: "published_reply_pending",
        reason: `${published}Robo's turn is still open, for example for the pull request description edit. Call bridge_handoff_attach again.` };
    }
    return undefined;
  }

  private async attachA2ATurn(
    session: SessionRecord,
    turn: TurnRecord,
    target: A2ATargetConfig,
    waitBudgetMs: number,
  ): Promise<HandoffResultEnvelopeV2> {
    const client = this.a2a(target);
    const deadline = Date.now() + waitBudgetMs;
    const remoteSessionKey = session.remoteSessionKey ?? this.buildRemoteSessionKey(target, session.handoffId);
    const remoteSessionUrl = normalizeA2ABaseUrl(target.url);
    let initialObs: A2ATurnObservation | undefined;

    if (!turn.runId) {
      if (turn.dispatchState !== "prepared") {
        try {
          initialObs = await client.findTaskByMessageId({
            messageId: turn.idempotencyKey,
            contextId: session.remoteSessionId,
          });
        } catch (err) {
          if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") throw err;
        }
        if (!initialObs || initialObs.kind !== "task") {
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            errorText:
              "Cannot confirm A2A submission receipt after interrupted dispatch. Inspect the remote A2A agent before continuing.",
            now: new Date().toISOString(),
          });
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }
        this.store.recordDispatched({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          remoteSessionKey,
          remoteSessionId: initialObs.contextId ?? session.remoteSessionId,
          remoteSessionUrl,
          runId: initialObs.taskId,
          now: new Date().toISOString(),
        });
      } else {
        await client.discoverAgentCard();
        if (!this.store.claimDispatch(session.handoffId, turn.turnId)) {
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }
        try {
          initialObs = await client.sendMessage({
            messageId: turn.idempotencyKey,
            promptText: turn.promptText,
            contextId: session.remoteSessionId,
            handoffId: session.handoffId,
          });
        } catch (err) {
          if (!(err instanceof BridgeError)) throw err;
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            errorText: err.message,
            now: new Date().toISOString(),
          });
          if (err.code === "AUTH_LOGIN_REQUIRED") throw err;
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }

        if (initialObs.kind === "message") {
          this.store.recordDispatched({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            remoteSessionKey,
            remoteSessionId: initialObs.contextId ?? session.remoteSessionId,
            remoteSessionUrl,
            runId: `a2a-msg:${initialObs.messageId}`,
            now: new Date().toISOString(),
          });
          return await this.finalizeSettledTurn({
            session: this.requireSession(session.handoffId),
            turn: this.requireLatestTurn(session.handoffId),
            terminalReplyText: initialObs.replyText,
          });
        }

        this.store.recordDispatched({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          remoteSessionKey,
          remoteSessionId: initialObs.contextId ?? session.remoteSessionId,
          remoteSessionUrl,
          runId: initialObs.taskId,
          now: new Date().toISOString(),
        });
      }
    }

    let activeSession = this.requireSession(session.handoffId);
    const activeTurn = this.requireLatestTurn(session.handoffId);
    if (!activeTurn.runId) {
      return this.buildRunningOrUncertainResult(activeSession, activeTurn);
    }

    let pendingObs: A2ATurnObservation | { kind: "not_found" } | undefined = initialObs;
    for (;;) {
      const obs = pendingObs ?? (await client.getTask(activeTurn.runId));
      pendingObs = undefined;

      if (obs.kind === "not_found") {
        this.store.markTurnUncertain({
          handoffId: activeSession.handoffId,
          turnId: activeTurn.turnId,
          errorText: `Remote A2A agent has no task record for "${activeTurn.runId}".`,
          now: new Date().toISOString(),
        });
        return this.buildRunningOrUncertainResult(
          this.requireSession(activeSession.handoffId),
          this.requireLatestTurn(activeSession.handoffId),
        );
      }

      if (obs.kind === "message") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          terminalReplyText: obs.replyText,
        });
      }

      if (obs.contextId && !activeSession.remoteSessionId) {
        this.store.bindRemoteSessionId(activeSession.handoffId, obs.contextId, new Date().toISOString());
        activeSession = this.requireSession(activeSession.handoffId);
      }

      if (obs.state === "completed") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          terminalReplyText: obs.replyText,
        });
      }
      if (obs.state === "input_required") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          terminalReplyText:
            obs.replyText || "Remote A2A agent requested additional input (TASK_STATE_INPUT_REQUIRED).",
          a2aInputRequired: true,
        });
      }
      if (obs.state === "failed" || obs.state === "auth_required") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          runFailedError: obs.errorMessage ?? "Remote A2A task failed.",
        });
      }
      if (obs.state === "canceled") {
        this.store.markAborted(
          activeSession.handoffId,
          activeTurn.turnId,
          "Remote A2A task was canceled.",
          new Date().toISOString(),
          activeTurn.dispatchState,
        );
        return this.buildEnvelopeFromRecords(
          this.requireSession(activeSession.handoffId),
          this.requireLatestTurn(activeSession.handoffId),
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return this.buildRunningOrUncertainResult(activeSession, activeTurn);
      }
      await delay(Math.min(400, remaining));
    }
  }

  private async attachCodexTurn(
    session: SessionRecord,
    turn: TurnRecord,
    target: CodexTargetConfig,
    waitBudgetMs: number,
  ): Promise<HandoffResultEnvelopeV2> {
    const client = this.codex(target);
    const deadline = Date.now() + waitBudgetMs;
    const cwd = this.resolveExecutionCwd(session, target.cwd);
    const remoteSessionKey = session.remoteSessionKey ?? this.buildRemoteSessionKey(target, session.handoffId);

    if (!turn.runId) {
      if (turn.dispatchState !== "prepared") {
        if (!session.remoteSessionId) {
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            errorText: "Codex handoff was interrupted before a thread ID was recorded.",
            now: new Date().toISOString(),
          });
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }
        const found = await client.findTurnByClientMessageId({
          threadId: session.remoteSessionId,
          clientUserMessageId: turn.idempotencyKey,
          cwd,
        });
        if (!found) {
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            errorText: "Codex thread has no matching turn for this submission's clientUserMessageId.",
            now: new Date().toISOString(),
          });
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }
        this.store.recordDispatched({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          remoteSessionKey,
          remoteSessionId: session.remoteSessionId,
          runId: found.turnId,
          now: new Date().toISOString(),
        });
      } else {
        const threadId = await client.ensureThread({ threadId: session.remoteSessionId, cwd });
        if (!session.remoteSessionId) {
          this.store.bindRemoteSessionId(session.handoffId, threadId, new Date().toISOString());
        }
        if (!this.store.claimDispatch(session.handoffId, turn.turnId)) {
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }
        try {
          const started = await client.startTurn({
            threadId,
            clientUserMessageId: turn.idempotencyKey,
            promptText: turn.promptText,
            cwd,
          });
          this.store.recordDispatched({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            remoteSessionKey,
            remoteSessionId: threadId,
            runId: started.turnId,
            now: new Date().toISOString(),
          });
        } catch (err) {
          if (!(err instanceof BridgeError)) throw err;
          this.store.markTurnUncertain({
            handoffId: session.handoffId,
            turnId: turn.turnId,
            errorText: err.message,
            now: new Date().toISOString(),
          });
          if (err.code === "AUTH_LOGIN_REQUIRED") throw err;
          return this.buildRunningOrUncertainResult(
            this.requireSession(session.handoffId),
            this.requireLatestTurn(session.handoffId),
          );
        }
      }
    }

    const activeSession = this.requireSession(session.handoffId);
    const activeTurn = this.requireLatestTurn(session.handoffId);
    if (!activeTurn.runId || !activeSession.remoteSessionId) {
      return this.buildRunningOrUncertainResult(activeSession, activeTurn);
    }

    do {
      const remaining = deadline - Date.now();
      const sliceMs = waitBudgetMs === 0 ? 50 : Math.max(50, Math.min(25_000, remaining));
      const obs = await client.waitTurnSlice({
        threadId: activeSession.remoteSessionId,
        turnId: activeTurn.runId,
        sliceMs,
        cwd,
      });
      if (obs.state === "completed") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          terminalReplyText: obs.replyText,
        });
      }
      if (obs.state === "failed") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          runFailedError: obs.errorMessage,
        });
      }
      if (obs.state === "interrupted") {
        this.store.markAborted(
          activeSession.handoffId,
          activeTurn.turnId,
          "Codex turn was interrupted.",
          new Date().toISOString(),
          activeTurn.dispatchState,
        );
        return this.buildEnvelopeFromRecords(
          this.requireSession(activeSession.handoffId),
          this.requireLatestTurn(activeSession.handoffId),
        );
      }
      if (obs.state === "not_found") {
        this.store.markTurnUncertain({
          handoffId: activeSession.handoffId,
          turnId: activeTurn.turnId,
          errorText: "Codex app-server no longer has a record of this turn ID.",
          now: new Date().toISOString(),
        });
        return this.buildRunningOrUncertainResult(
          this.requireSession(activeSession.handoffId),
          this.requireLatestTurn(activeSession.handoffId),
        );
      }
    } while (Date.now() < deadline);

    return this.buildRunningOrUncertainResult(activeSession, activeTurn);
  }

  private async attachAcpTurn(
    session: SessionRecord,
    turn: TurnRecord,
    target: AcpTargetConfig,
    waitBudgetMs: number,
  ): Promise<HandoffResultEnvelopeV2> {
    const client = this.acp(target);
    const deadline = Date.now() + waitBudgetMs;
    const cwd = this.resolveExecutionCwd(session, target.cwd);
    const remoteSessionKey = session.remoteSessionKey ?? this.buildRemoteSessionKey(target, session.handoffId);

    if (!turn.runId) {
      if (turn.dispatchState !== "prepared") {
        this.store.markTurnUncertain({
          handoffId: session.handoffId,
          turnId: turn.turnId,
          errorText:
            "ACP stdio turn was interrupted before dispatch completion; refusing automatic replay to prevent duplicate execution.",
          now: new Date().toISOString(),
        });
        return this.buildRunningOrUncertainResult(
          this.requireSession(session.handoffId),
          this.requireLatestTurn(session.handoffId),
        );
      }

      const sessionId = await client.ensureSession({ sessionId: session.remoteSessionId, cwd });
      if (!session.remoteSessionId) {
        this.store.bindRemoteSessionId(session.handoffId, sessionId, new Date().toISOString());
      }
      if (!this.store.claimDispatch(session.handoffId, turn.turnId)) {
        return this.buildRunningOrUncertainResult(
          this.requireSession(session.handoffId),
          this.requireLatestTurn(session.handoffId),
        );
      }
      const runId = `acp:${turn.idempotencyKey}`;
      await client.startPrompt({
        sessionId,
        runId,
        promptText: turn.promptText,
        cwd,
      });
      this.store.recordDispatched({
        handoffId: session.handoffId,
        turnId: turn.turnId,
        remoteSessionKey,
        remoteSessionId: sessionId,
        runId,
        now: new Date().toISOString(),
      });
    }

    const activeSession = this.requireSession(session.handoffId);
    const activeTurn = this.requireLatestTurn(session.handoffId);
    if (!activeTurn.runId) {
      return this.buildRunningOrUncertainResult(activeSession, activeTurn);
    }

    do {
      const remaining = deadline - Date.now();
      const sliceMs = waitBudgetMs === 0 ? 50 : Math.max(50, Math.min(25_000, remaining));
      const obs = await client.waitPromptSlice(activeTurn.runId, sliceMs);
      if (obs.state === "completed") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          terminalReplyText: obs.replyText,
        });
      }
      if (obs.state === "failed") {
        return await this.finalizeSettledTurn({
          session: activeSession,
          turn: activeTurn,
          runFailedError: obs.errorMessage,
        });
      }
      if (obs.state === "cancelled") {
        this.store.markAborted(
          activeSession.handoffId,
          activeTurn.turnId,
          "ACP prompt was cancelled.",
          new Date().toISOString(),
          activeTurn.dispatchState,
        );
        return this.buildEnvelopeFromRecords(
          this.requireSession(activeSession.handoffId),
          this.requireLatestTurn(activeSession.handoffId),
        );
      }
      if (obs.state === "not_found") {
        this.store.markTurnUncertain({
          handoffId: activeSession.handoffId,
          turnId: activeTurn.turnId,
          errorText: "ACP client restarted while prompt was active; inspect local repository state before continuing.",
          now: new Date().toISOString(),
        });
        return this.buildRunningOrUncertainResult(
          this.requireSession(activeSession.handoffId),
          this.requireLatestTurn(activeSession.handoffId),
        );
      }
    } while (Date.now() < deadline);

    return this.buildRunningOrUncertainResult(activeSession, activeTurn);
  }

  async continueHandoff(params: {
    handoffId: string;
    intent: "counter_evidence_or_followup" | "authorize_publish";
    message: string;
    updatedLocalRepoPath?: string;
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

        if (
          params.updatedLocalRepoPath ||
          params.updatedSourceCommitSha ||
          params.updatedSourceRemoteRef ||
          params.updatedExpectedTreeSha
        ) {
          throw new BridgeError("INVALID_CONTRACT_CONFLICT", "Submit changed Git coordinates for verification in a separate follow-up before authorizing publication.");
        }
        const before = this.store.getPublicationLedger(params.handoffId);
        const candidateRef = before.headRef ?? latestTurn.reported?.candidateRef ?? session.sourceRemoteRef;
        if (!candidateRef) {
          throw new BridgeError("CONTRACT_VIOLATION", "A reachable candidate ref is required before publication.");
        }
        const observed = await this.observeCandidate(session, candidateRef, latestTurn.reported?.prUrl);
        const update = session.envelope.gitContext.updatePullRequest;
        if (observed.reconciledPrState === "open_verified") {
          throw new BridgeError(
            "PUBLISH_GATE_BLOCKED",
            update
              ? `Pull request ${update.url} already has the verified tree. Refusing duplicate publish.`
              : `Pull request is already verified open (${observed.reconciledPrUrl ?? "recorded"}). Refusing duplicate publish.`,
          );
        }
        if (update && observed.reconciledPrState === "uncertain_in_flight") {
          throw new BridgeError(
            "RECONCILIATION_UNCERTAIN",
            `Cannot confirm that ${update.url} is still at ${update.expectedHeadSha}: ${observed.verificationNotes?.at(-1) ?? "unknown state"} Inspect it before authorizing again.`,
          );
        }
        // For an update, a head still at its expected commit proves an earlier attempt never landed.
        if (observed.reconciledPrState === "uncertain_in_flight" || (before.attempted && !update)) {
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
          ...(update ? { updatePullRequest: update } : {}),
        });
        authorizedHead = { ref: candidateRef, sha: session.verifiedPublishHeadSha };
      } else {
        if (params.updatedLocalRepoPath) {
          await this.gitVerifier.assertLocalRepository(params.updatedLocalRepoPath);
        }
        if (params.updatedExpectedTreeSha && !params.updatedSourceCommitSha) {
          throw new BridgeError("INVALID_CONTRACT_CONFLICT", "A new expected tree requires its pinned source commit.");
        }
        if (params.updatedSourceCommitSha && (session.expectedTreeSha || params.updatedExpectedTreeSha)) {
          const effectiveSource = {
            localRepoPath: params.updatedLocalRepoPath ?? session.localRepoPath,
            remoteUrlOrPath: session.remoteUrlOrPath,
            pinnedBaseCommitSha: session.pinnedBaseCommitSha,
          };
          const tree = await this.resolveSourceTree(effectiveSource, params.updatedSourceCommitSha);
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
        updatedLocalRepoPath: params.updatedLocalRepoPath,
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
    let git: ObservedResult = { reachableRefVerified: false, reconciledPrState: "none" };
    if (candidateRef && remoteSource) {
      // A target may report owner/repo:<ref>. A ref in another repository is fetched from GitHub.
      const location = parseCandidateRef(candidateRef, session.repoId);
      git = location
        ? await this.gitVerifier.verifyCandidate({
            remoteUrlOrPath: remoteSource,
            ...(location.repository ? { candidateRemoteUrlOrPath: githubCloneUrl(location.repository) } : {}),
            localRepoPath: session.localRepoPath,
            candidateRef: location.ref,
            pinnedBaseCommitSha: session.pinnedBaseCommitSha,
            pinnedSourceCommitSha: session.pinnedSourceCommitSha,
            expectedTreeSha: session.expectedTreeSha,
            lockedPaths: session.lockedPaths,
          })
        : { ...git, verificationNotes: [`Refusing candidateRef "${candidateRef}": expected a plain Git ref or owner/repo:<ref>.`] };
    }
    if (session.publisherOwner === "none" && !reportedPrUrl && !ledger.attempted && !ledger.prUrl) return git;

    const update = session.envelope.gitContext.updatePullRequest;
    if (update && session.expectedTreeSha) {
      // The pull request exists by contract. Only its head says whether this handoff's update landed.
      const pr = await this.githubReconciler.reconcilePullRequestUpdate({
        repoId: session.repoId,
        url: update.url,
        expectedHeadSha: update.expectedHeadSha,
        publishedTreeSha: session.expectedTreeSha,
      });
      const foreign = reportedPrUrl && reportedPrUrl !== update.url
        ? `The target reported another pull request (${reportedPrUrl}) than the one this handoff updates.` : undefined;
      return {
        ...git,
        reconciledPrState: foreign ? "uncertain_in_flight" : pr.prState,
        reconciledPrUrl: pr.prUrl,
        verificationNotes: [...(git.verificationNotes ?? []), pr.note, ...(foreign ? [foreign] : [])],
      };
    }

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
    const recordedTransport = this.sessionTransport(session);
    // Local-only abandonment never touches Chrome or remote processes, even if the operator changed the target URL.
    if (params.localOnly || (recordedTransport !== "gateway" && turn.dispatchState === "prepared")) {
      if (recordedTransport === "gateway") {
        throw new BridgeError("INVALID_INPUT", "localOnly applies to non-Gateway handoffs or existing browser chats.");
      }
      if (!this.store.markAborted(session.handoffId, turn.turnId, params.reason ?? `Local ${recordedTransport} handoff closed.`,
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
    if (target.transport === "a2a") {
      if (!turn.runId.startsWith("a2a-msg:")) {
        if (!(await this.a2a(target).cancelTask(turn.runId))) {
          throw new BridgeError("RECONCILIATION_UNCERTAIN", "Remote A2A agent did not confirm cancellation of this task. Attach to observe its outcome.");
        }
      }
      this.store.markAborted(session.handoffId, turn.turnId, params.reason ?? "Aborted by local orchestrator.", new Date().toISOString(), turn.dispatchState);
      return this.buildEnvelopeFromRecords(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
    }
    if (target.transport === "codex") {
      if (!session.remoteSessionId || !(await this.codex(target).interruptTurn(session.remoteSessionId, turn.runId, this.resolveExecutionCwd(session, target.cwd)))) {
        throw new BridgeError("RECONCILIATION_UNCERTAIN", "Codex app-server did not confirm turn interruption. Attach to observe its outcome.");
      }
      this.store.markAborted(session.handoffId, turn.turnId, params.reason ?? "Aborted by local orchestrator.", new Date().toISOString(), turn.dispatchState);
      return this.buildEnvelopeFromRecords(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
    }
    if (target.transport === "acp") {
      if (!session.remoteSessionId || !(await this.acp(target).cancelPrompt(session.remoteSessionId, turn.runId))) {
        throw new BridgeError("RECONCILIATION_UNCERTAIN", "ACP agent did not confirm prompt cancellation. Attach to observe its outcome.");
      }
      this.store.markAborted(session.handoffId, turn.turnId, params.reason ?? "Aborted by local orchestrator.", new Date().toISOString(), turn.dispatchState);
      return this.buildEnvelopeFromRecords(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
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
    a2aInputRequired?: boolean;
  }): Promise<HandoffResultEnvelopeV2> {
    const { session, turn, runFailedError, a2aInputRequired } = params;
    const rawReply =
      params.terminalReplyText?.trim()
        ? params.terminalReplyText
        : a2aInputRequired
          ? "Remote A2A agent requested additional input (TASK_STATE_INPUT_REQUIRED)."
          : undefined;
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
        errorText: "Run reached a terminal state, but its exact reply is unavailable. Inspect this target session before continuing.", now });
      return this.buildRunningOrUncertainResult(this.requireSession(session.handoffId), this.requireLatestTurn(session.handoffId));
    }
    const reported = parseReportedResult(rawReply, this.sessionTransport(session), {
      a2aInputRequired,
    });

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
    override?: DirectiveOverride,
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
      orchestratorDirective: override
        ? { ...override, remainingTurnBudget: evaluated.directive.remainingTurnBudget }
        : evaluated.directive,
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
