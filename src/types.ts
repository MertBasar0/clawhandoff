export type BridgeErrorCode =
  | "INVALID_CONTRACT_CONFLICT"
  | "INVALID_INPUT"
  | "AUTH_LOGIN_REQUIRED"
  | "TARGET_UNAVAILABLE"
  | "HANDOFF_NOT_FOUND"
  | "BUSY_ACTIVE_TURN"
  | "CONTRACT_VIOLATION"
  | "PUBLISH_GATE_BLOCKED"
  | "GIT_VERIFICATION_FAILED"
  | "RECONCILIATION_UNCERTAIN"
  | "AUTONOMOUS_BUDGET_EXHAUSTED";

export class BridgeError extends Error {
  public readonly code: BridgeErrorCode;
  public readonly remediation?: string;

  constructor(code: BridgeErrorCode, message: string, remediation?: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.remediation = remediation;
  }
}

export type HandoffMode =
  | "investigate"
  | "implement"
  | "verify_only"
  | "publish_unchanged";

export type PublisherOwner = "none" | "local" | "remote_gated";

export type LifecycleStatus =
  | "running"
  | "settled"
  | "uncertain"
  | "aborted"
  | "failed";

export type TurnKind = "initial" | "continue" | "authorize_publish";

export type DispatchState =
  | "prepared"
  | "dispatch_pending"
  | "dispatched"
  | "settled"
  | "uncertain"
  | "aborted"
  | "failed";

export type ReconciledPrState = "none" | "open_verified" | "uncertain_in_flight";

export interface GatewayTargetConfig {
  targetId: string;
  /** Public HTTPS or WS/WSS origin of the OpenClaw Gateway */
  url: string;
  authMode: "edge-cloudflare" | "direct-token" | "existing-profile";
  agentId: string;
  projectId?: string;
  cliPath?: string;
  cloudflaredPath?: string;
  tokenEnvVar?: string;
  profileDir?: string;
  rpcTimeoutMs?: number;
}

export interface BridgeConfig {
  dataDir: string;
  targets: Record<string, GatewayTargetConfig>;
  ghCliPath?: string;
  defaultWaitBudgetMs?: number;
  defaultMaxAutonomousTurns?: number;
}

export interface HandoffEnvelopeV2 {
  schemaVersion: "0.2";
  requestId: string;
  workspaceId: string;
  title: string;
  outcome: string;
  mode: HandoffMode;
  publisherOwner: PublisherOwner;
  gitContext: {
    repoId: string;
    localRepoPath?: string;
    remoteUrlOrPath?: string;
    pinnedBaseCommitSha: string;
    pinnedSourceCommitSha?: string;
    sourceRemoteRef?: string;
    expectedTreeSha?: string;
    lockedPaths?: string[];
  };
  requestedCapabilities: {
    allowCodeEdit: boolean;
    allowBranchPush: boolean;
    allowManagedPublishStage: boolean;
  };
  advisoryInstructions: Array<{
    instruction: string;
    reason: string;
  }>;
  priorEvidence: Array<{
    claim: string;
    sourceRef: string;
  }>;
  nonBindingHints?: string[];
  acceptanceCriteria: string[];
}

export interface ReportedCheck {
  command: string;
  exitCode?: number;
  environment?: string;
}

export type ReportedDisposition =
  | "completed"
  | "needs_evidence"
  | "blocked"
  | "ready_for_publish_gate";

export interface ReportedResult {
  disposition: ReportedDisposition;
  candidateCommitSha?: string;
  candidateRef?: string;
  prUrl?: string;
  summaryDelta: string;
  blockers: string[];
  claimedChecks: ReportedCheck[];
}

export interface ObservedResult {
  reachableRefVerified: boolean;
  observedHeadSha?: string;
  observedTreeSha?: string;
  baseIsAncestor?: boolean;
  treeMatchesExpected?: boolean;
  lockedPathsClean?: boolean;
  violatedPaths?: string[];
  inspectedCommitCount?: number;
  reconciledPrState: ReconciledPrState;
  reconciledPrUrl?: string;
  verificationNotes?: string[];
}

export type OrchestratorAction =
  | "COMPLETE"
  | "POLL_ATTACH"
  | "CONTINUE_AUTONOMOUSLY"
  | "AUTHORIZE_REMOTE_PUBLISH"
  | "PUBLISH_LOCALLY"
  | "ESCALATE_TO_HUMAN";

export interface OrchestratorDirective {
  action: OrchestratorAction;
  reason: string;
  remainingTurnBudget: number;
}

export interface HandoffResultEnvelopeV2 {
  schemaVersion: "0.2";
  handoffId: string;
  targetId: string;
  remoteSessionKey?: string;
  remoteSessionUrl?: string;
  turnNumber: number;
  runId: string;
  lifecycleStatus: LifecycleStatus;
  reported?: ReportedResult;
  observed: ObservedResult;
  orchestratorDirective: OrchestratorDirective;
}

export interface SessionRecord {
  handoffId: string;
  requestId: string;
  workspaceId: string;
  targetId: string;
  title: string;
  mode: HandoffMode;
  publisherOwner: PublisherOwner;
  repoId: string;
  localRepoPath?: string;
  remoteUrlOrPath?: string;
  pinnedBaseCommitSha: string;
  pinnedSourceCommitSha?: string;
  sourceRemoteRef?: string;
  expectedTreeSha?: string;
  lockedPaths: string[];
  envelope: HandoffEnvelopeV2;
  remoteSessionKey?: string;
  remoteSessionId?: string;
  remoteSessionUrl?: string;
  worktreeName?: string;
  lifecycleStatus: LifecycleStatus;
  maxAutonomousTurns: number;
  sameBlockerStreak: number;
  lastBlockerFingerprint?: string;
  verifiedPublishHeadSha?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnRecord {
  turnId: string;
  handoffId: string;
  turnNumber: number;
  kind: TurnKind;
  idempotencyKey: string;
  dispatchState: DispatchState;
  runId?: string;
  promptText: string;
  createParamsJson?: string;
  rawReplyText?: string;
  reported?: ReportedResult;
  observed?: ObservedResult;
  directive?: OrchestratorDirective;
  errorText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RivalPrWarning {
  number: number;
  url: string;
  state: string;
  title: string;
  headRefName?: string;
}

export interface PreflightResult {
  targetId: string;
  gatewayHealthy: boolean;
  authReady: boolean;
  agentFound: boolean;
  defaultAgentId?: string;
  availableAgentIds: string[];
  rivalPullRequests: RivalPrWarning[];
  remediation?: string;
}
