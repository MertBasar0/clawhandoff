import { z } from "zod";
import type { HandoffEnvelopeV2, ReportedResult } from "./types.js";

const ReportedResultSchema = z.object({
  disposition: z.enum([
    "completed",
    "needs_evidence",
    "blocked",
    "ready_for_publish_gate",
  ]),
  candidateCommitSha: z.string().min(7).max(64).optional(),
  candidateRef: z.string().min(1).max(256).optional(),
  prUrl: z.string().url().optional(),
  summaryDelta: z.string().min(1).max(4_000),
  blockers: z.array(z.string().min(1).max(1_000)).default([]),
  claimedChecks: z
    .array(
      z.object({
        command: z.string().min(1).max(500),
        exitCode: z.number().int().optional(),
        environment: z.string().max(200).optional(),
      }),
    )
    .default([]),
});

export function compileInitialHandoffPrompt(params: {
  handoffId: string;
  envelope: HandoffEnvelopeV2;
}): string {
  const { handoffId, envelope } = params;
  const g = envelope.gitContext;
  const lockedPaths = g.lockedPaths ?? [];

  const publishRule =
    envelope.publisherOwner === "remote_gated"
      ? [
          "- Publisher Ownership: `remote_gated` (Two-Step Gate — CURRENT STAGE: Stage 1 `prepare_only`).",
          "- DO NOT open or publish a pull request in this turn (`canOpenPrNow: false`).",
          "- Push or identify the reachable candidate Git ref and return its exact 40-char `candidateCommitSha` with `disposition: \"ready_for_publish_gate\"`. This is a cooperative publishing instruction, not a change to Gateway permissions. Managed PR creation is authorized only after the bridge verifies Git tree and locked-path invariants in Stage 2.",
        ].join("\n")
      : envelope.publisherOwner === "local"
        ? [
            "- Publisher Ownership: `local`.",
            "- DO NOT open or publish a pull request from this session. Return the verified findings and reachable candidate ref/commit so the local publisher owner can publish after verification.",
          ].join("\n")
        : "- Publisher Ownership: `none` (no PR creation requested).";

  const lines: string[] = [
    `# ${envelope.title}`,
    "",
    `Handoff-ID: \`${handoffId}\` | Request-ID: \`${envelope.requestId}\` | Mode: \`${envelope.mode}\``,
    "",
    "## Outcome",
    envelope.outcome,
    "",
    "## Pinned Git & Capability Contract",
    `- Repository: \`${g.repoId}\``,
    `- Pinned Base Commit SHA: \`${g.pinnedBaseCommitSha}\``,
  ];

  if (g.pinnedSourceCommitSha) {
    lines.push(`- Pinned Source Commit SHA: \`${g.pinnedSourceCommitSha}\``);
  }
  if (g.sourceRemoteRef) {
    lines.push(`- Reachable Source Ref: \`${g.sourceRemoteRef}\``);
  }
  if (g.expectedTreeSha) {
    lines.push(`- Expected Immutable Tree SHA: \`${g.expectedTreeSha}\``);
  }
  if (lockedPaths.length > 0) {
    lines.push(
      `- Locked Paths (must remain untouched since the pinned source commit (or base when no source is supplied)): ${lockedPaths.map((p) => `\`${p}\``).join(", ")}`,
    );
  }
  lines.push(
    `- Allow Code Edit: \`${envelope.requestedCapabilities.allowCodeEdit}\` | Allow Branch Push: \`${envelope.requestedCapabilities.allowBranchPush}\``,
    publishRule,
  );

  lines.push(
    "",
    "## Execution Discipline",
    "- Proceed directly on steps already within the granted capabilities above; do NOT pause just to ask 'should I start?'.",
    "- If you encounter a genuine missing permission, unreachable ref, or contradictory evidence, report it immediately in `blockers` instead of guessing or working around locked invariants.",
  );

  if (envelope.advisoryInstructions.length > 0) {
    lines.push("", "## Advisory Operating Instructions (Environment & Safety Context)");
    for (const item of envelope.advisoryInstructions) {
      lines.push(`- ${item.instruction} *(Reason: ${item.reason})*`);
    }
  }

  if (envelope.priorEvidence.length > 0) {
    lines.push("", "## Prior Evidence & Source References");
    for (const ev of envelope.priorEvidence) {
      lines.push(`- ${ev.claim} [ref: \`${ev.sourceRef}\`]`);
    }
  }

  if (envelope.nonBindingHints && envelope.nonBindingHints.length > 0) {
    lines.push("", "## Non-Binding Starting Hints (Adapt Freely Based on Codebase Reality)");
    for (const hint of envelope.nonBindingHints) {
      lines.push(`- ${hint}`);
    }
  }

  lines.push("", "## Acceptance Criteria");
  for (const criterion of envelope.acceptanceCriteria) {
    lines.push(`- ${criterion}`);
  }

  lines.push("", renderStructuredReturnFooter());
  return lines.join("\n");
}

export function compileFollowupPrompt(params: {
  handoffId: string;
  turnNumber: number;
  message: string;
  updatedSourceCommitSha?: string;
  updatedSourceRemoteRef?: string;
  updatedExpectedTreeSha?: string;
  evidenceRefs?: Array<{ claim: string; sourceRef: string }>;
}): string {
  const lines: string[] = [
    `## Handoff Follow-up (Handoff-ID: \`${params.handoffId}\`, Turn ${params.turnNumber})`,
    "",
    params.message,
  ];

  if (
    params.updatedSourceCommitSha ||
    params.updatedSourceRemoteRef ||
    params.updatedExpectedTreeSha
  ) {
    lines.push("", "### Updated Pinned Git Coordinates");
    if (params.updatedSourceCommitSha) {
      lines.push(`- Updated Source Commit SHA: \`${params.updatedSourceCommitSha}\``);
    }
    if (params.updatedSourceRemoteRef) {
      lines.push(`- Updated Reachable Ref: \`${params.updatedSourceRemoteRef}\``);
    }
    if (params.updatedExpectedTreeSha) {
      lines.push(`- Updated Expected Tree SHA: \`${params.updatedExpectedTreeSha}\``);
    }
  }

  if (params.evidenceRefs && params.evidenceRefs.length > 0) {
    lines.push("", "### Commit-Bound Evidence");
    for (const ev of params.evidenceRefs) {
      lines.push(`- ${ev.claim} [ref: \`${ev.sourceRef}\`]`);
    }
  }

  lines.push("", renderStructuredReturnFooter());
  return lines.join("\n");
}

export function compileAuthorizePublishPrompt(params: {
  handoffId: string;
  turnNumber: number;
  verifiedHeadSha: string;
  verifiedTreeSha: string;
  candidateRef: string;
  operatorNote: string;
}): string {
  return [
    `## Stage-2 Managed Publish Authorization (Handoff-ID: \`${params.handoffId}\`, Turn ${params.turnNumber})`,
    "",
    "The local bridge has verified the candidate Git objects (`Tree-SHA` and `lockedPaths` checks passed) and verified no duplicate PR is open.",
    "",
    `- Authorized Exact Commit SHA: \`${params.verifiedHeadSha}\``,
    `- Verified Tree SHA: \`${params.verifiedTreeSha}\``,
    `- Authorized Branch Ref: \`${params.candidateRef}\``,
    "",
    "### Strict Publish Rule",
    `- You are now authorized to publish a draft pull request **ONLY** for exact commit \`${params.verifiedHeadSha}\` without modifying any file or rebasing.`,
    "- Include marker `Handoff-ID: " + params.handoffId + "` in internal tracking if supported, or return the created `prUrl` in the result block below.",
    "- If managed publication fails or returns an uncertain error, DO NOT retry blindly; report the exact error in `blockers`.",
    "",
    params.operatorNote,
    "",
    renderStructuredReturnFooter(),
  ].join("\n");
}

function renderStructuredReturnFooter(): string {
  return [
    "## Required Machine-Readable Result Block",
    "At the very end of your response, include a fenced `handoff-result` JSON block with this exact shape:",
    "```handoff-result",
    JSON.stringify(
      {
        disposition: "completed | needs_evidence | blocked | ready_for_publish_gate",
        candidateCommitSha: "<40-char-sha-if-applicable>",
        candidateRef: "<pushed-branch-or-ref-if-applicable>",
        prUrl: "<https-pr-url-only-if-actually-created>",
        summaryDelta: "<concise summary of new findings/changes in this turn>",
        blockers: ["<empty array if none, or concrete blocker strings>"],
        claimedChecks: [{ command: "<executed command>", exitCode: 0, environment: "linux" }],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

export function parseReportedResult(rawText: string): ReportedResult {
  const taggedRegex = /```handoff-result\s*([\s\S]*?)```/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = taggedRegex.exec(rawText)) !== null) {
    lastMatch = m;
  }

  const candidateJson = lastMatch?.[1]?.trim();
  if (candidateJson) {
    try {
      const parsedObj: unknown = JSON.parse(candidateJson);
      const validated = ReportedResultSchema.safeParse(parsedObj);
      if (validated.success) {
        return validated.data;
      }
    } catch {
      // Fall through to conservative plain-text fallback below.
    }
  }

  // Conservative fallback: never assume completion if machine-readable block is missing or malformed.
  const trimmed = rawText.trim();
  const preview = trimmed.length > 800 ? `${trimmed.slice(0, 800)}...` : trimmed;
  return {
    disposition: "needs_evidence",
    summaryDelta: preview || "(Empty assistant response)",
    blockers: [
      "Target response omitted a valid ```handoff-result``` JSON block; treating status conservatively as needs_evidence.",
    ],
    claimedChecks: [],
  };
}
