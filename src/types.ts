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

export type TargetTransport = "gateway" | "browser" | "a2a" | "codex" | "acp";

export interface GatewayTargetConfig {
  transport?: "gateway";
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

export interface BrowserTargetConfig {
  transport: "browser";
  targetId: string;
  agentId: string;
  sessionUrl: string;
  /** Control UI mount for resolving ambiguous session URLs; use "/" for the root. */
  basePath?: string;
  browserMcp: { command: string; args: string[] };
  /** How long a turn may show no visible progress before the bridge acts, and how often it may nudge. */
  recovery?: {
    /** Idle chat with no answer to the request (default 3 minutes). Then the bridge nudges. */
    idleStallMs?: number;
    /** Chat still marked busy with nothing changing (default 20 minutes). Then the turn needs the operator. */
    busyStallMs?: number;
    /** Bridge nudges per turn after a failed or stalled reply (default 2). */
    maxNudges?: number;
  };
}

export interface A2ATargetConfig {
  transport: "a2a";
  targetId: string;
  /** HTTP or HTTPS base URL or JSON-RPC endpoint of the A2A agent. */
  url: string;
  /** Optional relative Agent Card discovery path (defaults to /.well-known/agent-card.json with /.well-known/agent.json fallback). */
  agentCardPath?: string;
  /** A2A wire binding version ("auto" inspects the Agent Card). */
  protocolVersion?: "auto" | "1.0" | "0.3";
  /** Environment variable holding the Bearer token or API key secret. */
  authTokenEnvVar?: string;
  /** Custom header name when authTokenEnvVar carries an API key instead of Authorization: Bearer. */
  authHeaderName?: string;
  /** Static non-secret HTTP headers sent on card discovery and JSON-RPC requests. */
  headers?: Record<string, string>;
  rpcTimeoutMs?: number;
}

export interface CodexTargetConfig {
  transport: "codex";
  targetId: string;
  /** Executable used to launch Codex app-server (defaults to "codex"). */
  command?: string;
  /** Arguments passed to launch stdio app-server (defaults to ["app-server", "--stdio"]). */
  args?: string[];
  /** Default working directory when no isolated worktree or localRepoPath is active. */
  cwd?: string;
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  rpcTimeoutMs?: number;
}

export interface AcpTargetConfig {
  transport: "acp";
  targetId: string;
  /** Built-in ACP agent preset (e.g. "claude", "gemini", "cursor", "copilot", "opencode", "pi", "kimi"). */
  agent?: string;
  /** Custom ACP stdio server executable (provide agent, command, or both). */
  command?: string;
  args?: string[];
  cwd?: string;
  model?: string;
  modeId?: string;
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
  rpcTimeoutMs?: number;
}

export type BridgeTargetConfig =
  | GatewayTargetConfig
  | BrowserTargetConfig
  | A2ATargetConfig
  | CodexTargetConfig
  | AcpTargetConfig;

export interface BridgeConfig {
  dataDir: string;
  targets: Record<string, BridgeTargetConfig>;
  ghCliPath?: string;
  defaultPublisherOwner?: PublisherOwner;
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
    /** Update this open pull request, currently at expectedHeadSha, to a head with expectedTreeSha. */
    updatePullRequest?: { url: string; expectedHeadSha: string };
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
  transport?: TargetTransport;
  gatewayHealthy: boolean;
  browserReady?: boolean;
  targetHealthy?: boolean;
  authReady: boolean;
  agentFound: boolean;
  defaultAgentId?: string;
  availableAgentIds: string[];
  agentCard?: {
    name: string;
    version?: string;
    protocolVersion: "1.0" | "0.3";
    rpcUrl: string;
    streaming?: boolean;
  };
  rivalPullRequests: RivalPrWarning[];
  remediation?: string;
}
