import { z } from "zod";
import { BridgeError, type HandoffEnvelopeV2 } from "./types.js";

const HEX_SHA_40 = /^[0-9a-fA-F]{40}$/;

export const Sha40Schema = z
  .string()
  .regex(HEX_SHA_40, "Must be a resolved 40-character hexadecimal Git SHA (not a moving branch or tag ref).");

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
  requestId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(200),
  title: z.string().min(3).max(160),
  outcome: z.string().min(10).max(4_000),
  mode: z.enum(["investigate", "implement", "verify_only", "publish_unchanged"]),
  publisherOwner: z.enum(["none", "local", "remote_gated"]),
  gitContext: z.object({
    repoId: z.string().min(1).max(200),
    localRepoPath: z.string().min(1).optional(),
    remoteUrlOrPath: z.string().min(1).optional(),
    pinnedBaseCommitSha: Sha40Schema,
    pinnedSourceCommitSha: Sha40Schema.optional(),
    sourceRemoteRef: z.string().min(1).max(256).optional(),
    expectedTreeSha: Sha40Schema.optional(),
    lockedPaths: z.array(z.string().min(1).max(512)).max(200).optional(),
  }),
  requestedCapabilities: z.object({
    allowCodeEdit: z.boolean(),
    allowBranchPush: z.boolean(),
    allowManagedPublishStage: z.boolean(),
  }),
  advisoryInstructions: z
    .array(
      z.object({
        instruction: z.string().min(1).max(1_000),
        reason: z.string().min(1).max(1_000),
      }),
    )
    .max(30)
    .default([]),
  priorEvidence: z
    .array(
      z.object({
        claim: z.string().min(1).max(2_000),
        sourceRef: z.string().min(1).max(500),
      }),
    )
    .max(50)
    .default([]),
  nonBindingHints: z.array(z.string().min(1).max(1_000)).max(20).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(30),
});

export function validateAndNormalizeEnvelope(input: unknown): HandoffEnvelopeV2 {
  const parsed = HandoffEnvelopeV2Schema.safeParse(input);
  if (!parsed.success) {
    throw new BridgeError(
      "INVALID_INPUT",
      `Invalid HandoffEnvelopeV2: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const env = parsed.data;

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

  if (env.mode === "publish_unchanged" && env.publisherOwner === "none") {
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
  waitBudgetMs: z.number().int().min(0).max(120_000).optional(),
  maxAutonomousTurns: z.number().int().min(1).max(15).optional(),
});

export const AttachHandoffInputSchema = z.object({
  handoffId: z.string().min(1).max(128),
  waitBudgetMs: z.number().int().min(0).max(120_000).optional(),
});

export const ContinueHandoffInputSchema = z.object({
  handoffId: z.string().min(1).max(128),
  intent: z.enum(["counter_evidence_or_followup", "authorize_publish"]),
  message: z.string().min(1).max(8_000),
  updatedSourceCommitSha: Sha40Schema.optional(),
  updatedSourceRemoteRef: z.string().min(1).max(256).optional(),
  updatedExpectedTreeSha: Sha40Schema.optional(),
  evidenceRefs: z
    .array(
      z.object({
        claim: z.string().min(1).max(2_000),
        sourceRef: z.string().min(1).max(500),
      }),
    )
    .max(30)
    .optional(),
  waitBudgetMs: z.number().int().min(0).max(120_000).optional(),
});

export const VerifyGitInputSchema = z.object({
  handoffId: z.string().min(1).max(128),
  candidateRef: z.string().min(1).max(256),
  remoteUrlOrPath: z.string().min(1).optional(),
});

export const AbortHandoffInputSchema = z.object({
  handoffId: z.string().min(1).max(128),
  reason: z.string().min(1).max(500).optional(),
});
