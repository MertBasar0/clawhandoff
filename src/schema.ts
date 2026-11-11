import { z } from "zod";
import { BridgeError, type HandoffEnvelopeV2, type PublisherOwner } from "./types.js";

const HEX_SHA_40 = /^[0-9a-fA-F]{40}$/;
const noNullBytes = (value: string) => !value.includes("\0");
const safeText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(noNullBytes, "Text must not contain null bytes (\\u0000).");

export const Sha40Schema = z
  .string()
  .regex(HEX_SHA_40, "Must be a resolved 40-character hexadecimal Git SHA (not a moving branch or tag ref).");

const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/;

export const PublisherOwnerSchema = z.enum(["none", "local", "remote_gated"]);
const WaitBudgetMsSchema = z
  .number()
  .int()
  .min(0)
  .max(120_000)
  .describe("Milliseconds to wait for turn completion before returning POLL_ATTACH (0-120000).");

export function normalizeLockedPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    throw new BridgeError(
      "INVALID_INPUT",
      `Invalid lockedPath entry "${rawPath}". Locked paths must be clean repository-relative paths without ".." segments.`,
    );
  }
  return trimmed;
}

export const HandoffEnvelopeV2Schema = z.object({
  schemaVersion: z.literal("0.2"),
  requestId: safeText(1, 128),
  workspaceId: safeText(1, 200),
  title: safeText(3, 160),
  outcome: safeText(10, 4_000),
  mode: z.enum(["investigate", "implement", "verify_only", "publish_unchanged"]),
  publisherOwner: PublisherOwnerSchema.optional().describe(
    'Defaults to bridge defaultPublisherOwner ("remote_gated" unless configured otherwise). Use "none" when no PR is requested or "local" when local publication is explicitly requested.',
  ),
  gitContext: z.object({
    repoId: safeText(1, 200),
    localRepoPath: safeText(1, 1_024).optional(),
    remoteUrlOrPath: safeText(1, 1_024).optional(),
    pinnedBaseCommitSha: Sha40Schema,
    pinnedSourceCommitSha: Sha40Schema.optional(),
    sourceRemoteRef: safeText(1, 256).optional(),
    expectedTreeSha: Sha40Schema.optional(),
    lockedPaths: z.array(safeText(1, 512)).max(200).optional(),
    updatePullRequest: z.object({
      url: z.string().regex(PULL_URL, "Use the pull request's https://github.com/<owner>/<repo>/pull/<number> URL."),
      expectedHeadSha: Sha40Schema.describe("The pull request head before this handoff publishes. Publication is detected when the head moves to a commit with expectedTreeSha."),
    }).strict().optional().describe("Update this existing pull request instead of opening a new one. Requires expectedTreeSha."),
  }),
  requestedCapabilities: z.object({
    allowCodeEdit: z.boolean(),
    allowBranchPush: z.boolean(),
    allowManagedPublishStage: z
      .boolean()
      .default(false)
      .describe("Must be false on initial handoff creation; Stage-2 publish unlocks via bridge_handoff_continue(intent='authorize_publish')."),
  }),
  advisoryInstructions: z
    .array(
      z.object({
        instruction: safeText(1, 1_000),
        reason: safeText(1, 1_000),
      }),
    )
    .max(30)
    .default([]),
  priorEvidence: z
    .array(
      z.object({
        claim: safeText(1, 2_000),
        sourceRef: safeText(1, 500),
      }),
    )
    .max(50)
    .default([]),
  nonBindingHints: z.array(safeText(1, 1_000)).max(20).optional(),
  acceptanceCriteria: z.array(safeText(1, 1_000)).min(1).max(30),
});

export function validateAndNormalizeEnvelope(
  input: unknown,
  defaultPublisherOwner: PublisherOwner = "remote_gated",
): HandoffEnvelopeV2 {
  const parsed = HandoffEnvelopeV2Schema.safeParse(input);
  if (!parsed.success) {
    throw new BridgeError(
      "INVALID_INPUT",
      `Invalid HandoffEnvelopeV2: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const env = parsed.data;
  const publisherOwner: PublisherOwner = env.publisherOwner ?? defaultPublisherOwner;

  // Reject silent capability/mode contradictions explicitly per RFC v0.2 Section 5.1.
  if (
    (env.mode === "publish_unchanged" || env.mode === "verify_only" || env.mode === "investigate") &&
    env.requestedCapabilities.allowCodeEdit
  ) {
    throw new BridgeError(
      "INVALID_CONTRACT_CONFLICT",
      `Mode "${env.mode}" forbids allowCodeEdit=true. Resolve the contract conflict explicitly instead of mutating capabilities silently.`,
    );
  }

  if (
    (env.mode === "publish_unchanged" || env.mode === "verify_only") &&
    !env.gitContext.expectedTreeSha &&
    !env.gitContext.pinnedSourceCommitSha
  ) {
    throw new BridgeError(
      "INVALID_CONTRACT_CONFLICT",
      `Mode "${env.mode}" requires expectedTreeSha or pinnedSourceCommitSha so the bridge can verify tree immutability.`,
    );
  }

  if (env.requestedCapabilities.allowManagedPublishStage) {
    throw new BridgeError(
      "INVALID_CONTRACT_CONFLICT",
      "allowManagedPublishStage cannot be enabled on initial handoff creation. Managed remote publishing is unlocked only in Stage 2 via bridge_handoff_continue(intent='authorize_publish') after Git object verification succeeds.",
    );
  }

  const update = env.gitContext.updatePullRequest;
  if (update) {
    const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(update.url)?.[1];
    if (repo?.toLowerCase() !== env.gitContext.repoId.toLowerCase()) {
      throw new BridgeError("INVALID_CONTRACT_CONFLICT", `updatePullRequest.url must be a pull request in ${env.gitContext.repoId}.`);
    }
    if (!env.gitContext.expectedTreeSha || publisherOwner === "none") {
      throw new BridgeError("INVALID_CONTRACT_CONFLICT", "updatePullRequest needs expectedTreeSha (the tree the pull request must end up with) and a publisher.");
    }
  }

  if (env.mode === "publish_unchanged" && publisherOwner === "none") {
    throw new BridgeError(
      "INVALID_CONTRACT_CONFLICT",
      'Mode "publish_unchanged" requires publisherOwner to be "local" or "remote_gated".',
    );
  }

  const normalizedLocked = env.gitContext.lockedPaths
    ? Array.from(new Set(env.gitContext.lockedPaths.map(normalizeLockedPath)))
    : undefined;

  return {
    ...env,
    publisherOwner,
    gitContext: {
      ...env.gitContext,
      pinnedBaseCommitSha: env.gitContext.pinnedBaseCommitSha.toLowerCase(),
      pinnedSourceCommitSha: env.gitContext.pinnedSourceCommitSha?.toLowerCase(),
      expectedTreeSha: env.gitContext.expectedTreeSha?.toLowerCase(),
      lockedPaths: normalizedLocked,
    },
  };
}

export const PreflightInputSchema = z.object({
  targetId: z.string().min(1).max(64),
  repoId: z.string().min(1).max(200).optional(),
  issueQuery: z.string().min(1).max(200).optional(),
});

export const StartHandoffInputSchema = z.object({
  targetId: z.string().min(1).max(64),
  envelope: HandoffEnvelopeV2Schema,
  worktreeName: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{2,64}$/)
    .optional(),
  waitBudgetMs: WaitBudgetMsSchema.optional(),
  maxAutonomousTurns: z.number().int().min(1).max(15).optional(),
});

export const AttachHandoffInputSchema = z.object({
  handoffId: z.string().min(1).max(128),
  waitBudgetMs: WaitBudgetMsSchema.optional(),
});

export const ContinueHandoffInputSchema = z.object({
  handoffId: safeText(1, 128),
  intent: z.enum(["counter_evidence_or_followup", "authorize_publish"]),
  message: safeText(1, 8_000),
  updatedLocalRepoPath: safeText(1, 1_024)
    .optional()
    .describe("Local repository or git worktree path created mid-handoff for local object borrowing and tree verification."),
  updatedSourceCommitSha: Sha40Schema.optional(),
  updatedSourceRemoteRef: safeText(1, 256).optional(),
  updatedExpectedTreeSha: Sha40Schema.optional(),
  evidenceRefs: z
    .array(
      z.object({
        claim: safeText(1, 2_000),
        sourceRef: safeText(1, 500),
      }),
    )
    .max(30)
    .optional(),
  waitBudgetMs: WaitBudgetMsSchema.optional(),
});

export const VerifyGitInputSchema = z.object({
  handoffId: z.string().min(1).max(128),
  candidateRef: z.string().min(1).max(256),
  remoteUrlOrPath: z.string().min(1).optional(),
});

export const AbortHandoffInputSchema = z.object({
  localOnly: z.boolean().optional(),
  handoffId: z.string().min(1).max(128),
  reason: z.string().min(1).max(500).optional(),
});
