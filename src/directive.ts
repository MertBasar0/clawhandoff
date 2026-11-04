import { createHash } from "node:crypto";
import type {
  HandoffMode,
  LifecycleStatus,
  ObservedResult,
  OrchestratorDirective,
  PublisherOwner,
  ReportedResult,
} from "./types.js";

export interface DirectiveEvaluation {
  directive: OrchestratorDirective;
  sameBlockerStreak: number;
  blockerFingerprint?: string;
}

export function evaluateOrchestratorDirective(params: {
  lifecycleStatus: LifecycleStatus;
  mode?: HandoffMode;
  publicationAttempted?: boolean;
  publisherOwner: PublisherOwner;
  turnNumber: number;
  maxAutonomousTurns: number;
  priorSameBlockerStreak: number;
  priorBlockerFingerprint?: string;
  reported?: ReportedResult;
  evidenceSourceRefs?: readonly string[];
  observed: ObservedResult;
}): DirectiveEvaluation {
  const remainingTurnBudget = Math.max(0, params.maxAutonomousTurns - params.turnNumber);

  if (params.lifecycleStatus === "uncertain") {
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason: "The submission or its result could not be confirmed. Attach checks the recorded session without resending. Reconcile it before starting new work.",
        remainingTurnBudget,
      },
      sameBlockerStreak: params.priorSameBlockerStreak,
      blockerFingerprint: params.priorBlockerFingerprint,
    };
  }
  if (params.lifecycleStatus === "running") {
    return {
      directive: {
        action: "POLL_ATTACH",
        reason:
          "Target turn is still in progress or awaiting reconciliation. Call bridge_handoff_attach with this handoffId without starting a new run.",
        remainingTurnBudget,
      },
      sameBlockerStreak: params.priorSameBlockerStreak,
      blockerFingerprint: params.priorBlockerFingerprint,
    };
  }

  if (params.lifecycleStatus === "aborted" || params.lifecycleStatus === "failed") {
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason: `Target run ended in "${params.lifecycleStatus}" state. Inspect observed diagnostics before deciding whether to continue or restart.`,
        remainingTurnBudget,
      },
      sameBlockerStreak: params.priorSameBlockerStreak,
      blockerFingerprint: params.priorBlockerFingerprint,
    };
  }

  if (params.observed.reconciledPrState === "uncertain_in_flight" &&
      (params.reported?.prUrl || params.publicationAttempted)) {
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason: "Publication may already be in flight. Reconcile the recorded PR before taking another action.",
        remainingTurnBudget,
      },
      sameBlockerStreak: params.priorSameBlockerStreak,
      blockerFingerprint: params.priorBlockerFingerprint,
    };
  }

  // Contract violation check: observed facts always outrank reported claims.
  if (params.observed.lockedPathsClean === false) {
    const violated = (params.observed.violatedPaths ?? []).join(", ") || "unknown";
    const fingerprint = `violation:locked:${violated}`;
    const streak = fingerprint === params.priorBlockerFingerprint ? params.priorSameBlockerStreak + 1 : 1;
    if (remainingTurnBudget > 0 && streak < 2 && params.publisherOwner === "remote_gated") {
      return {
        directive: {
          action: "CONTINUE_AUTONOMOUSLY",
          reason: `CONTRACT_VIOLATION: Target modified locked path(s) [${violated}] or diverged from pinned base. Do NOT authorize publish. Instruct target via bridge_handoff_continue to reset strictly to the pinned commit/tree, or escalate if intentional.`,
          remainingTurnBudget,
        },
        sameBlockerStreak: streak,
        blockerFingerprint: fingerprint,
      };
    }
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason: `CONTRACT_VIOLATION: Target modified locked path(s) [${violated}]. Publication is blocked.`,
        remainingTurnBudget,
      },
      sameBlockerStreak: streak,
      blockerFingerprint: fingerprint,
    };
  }

  if (params.observed.treeMatchesExpected === false) {
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason: `CONTRACT_VIOLATION: Observed Git Tree-SHA (${params.observed.observedTreeSha ?? "unknown"}) does not match expected immutable Tree-SHA. Publication is blocked.`,
        remainingTurnBudget,
      },
      sameBlockerStreak: params.priorSameBlockerStreak + 1,
      blockerFingerprint: `violation:tree:${params.observed.observedTreeSha ?? "none"}`,
    };
  }

  const reported = params.reported;
  const blockerFingerprint = computeBlockerFingerprint(reported, params.observed, params.evidenceSourceRefs);
  const sameBlockerStreak =
    blockerFingerprint && blockerFingerprint === params.priorBlockerFingerprint
      ? params.priorSameBlockerStreak + 1
      : blockerFingerprint
        ? 1
        : 0;

  if (sameBlockerStreak >= 2) {
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason:
          "Stagnation detected: identical blocker repeated across 2 consecutive turns with no new observed commit or submitted evidence reference. Surface exact evidence and blocker to the user.",
        remainingTurnBudget,
      },
      sameBlockerStreak,
      blockerFingerprint,
    };
  }

  if (
    reported?.disposition === "ready_for_publish_gate" ||
    reported?.disposition === "completed"
  ) {
    if (params.publisherOwner !== "none" && params.observed.reachableRefVerified &&
        params.observed.reconciledPrState === "uncertain_in_flight") {
      return {
        directive: {
          action: "ESCALATE_TO_HUMAN",
          reason: "Publication is uncertain. Reconcile the existing PR before issuing publication instructions.",
          remainingTurnBudget,
        },
        sameBlockerStreak,
        blockerFingerprint,
      };
    }
    if (params.publisherOwner !== "none" && params.observed.reachableRefVerified &&
        (reported.candidateCommitSha || params.publisherOwner === "remote_gated") &&
        reported.candidateCommitSha?.toLowerCase() !== params.observed.observedHeadSha) {
      return {
        directive: {
          action: remainingTurnBudget > 0 ? "CONTINUE_AUTONOMOUSLY" : "ESCALATE_TO_HUMAN",
          reason: "The target must confirm the full commit it checked matches the reachable candidate head before publication.",
          remainingTurnBudget,
        },
        sameBlockerStreak,
        blockerFingerprint,
      };
    }
    // Already published and verified open.
    if (params.observed.reconciledPrState === "open_verified") {
      return {
        directive: {
          action: "COMPLETE",
          reason: `Task settled and pull request is verified open (${params.observed.reconciledPrUrl ?? "URL recorded"}). Present final verified outcome to the user.`,
          remainingTurnBudget,
        },
        sameBlockerStreak: 0,
        blockerFingerprint: undefined,
      };
    }

    if (params.publisherOwner === "remote_gated") {
      if (
        remainingTurnBudget > 0 &&
        params.observed.reachableRefVerified &&
        params.observed.baseIsAncestor === true &&
        params.observed.lockedPathsClean === true
      ) {
        return {
          directive: {
            action: "AUTHORIZE_REMOTE_PUBLISH",
            reason: `Stage-1 candidate commit ${params.observed.observedHeadSha} passed checkout-free Git object verification. Call bridge_handoff_continue(intent="authorize_publish") to unlock Stage-2 managed PR creation for this exact commit.`,
            remainingTurnBudget,
          },
          sameBlockerStreak: 0,
          blockerFingerprint: undefined,
        };
      }
      if (remainingTurnBudget > 0) {
        return {
          directive: {
            action: "CONTINUE_AUTONOMOUSLY",
            reason:
              "Target reported completion/ready_for_publish_gate, but no reachable candidate Git ref has been verified yet. Ask target to push its candidate branch ref or call bridge_verify_git with the reachable ref.",
            remainingTurnBudget,
          },
          sameBlockerStreak,
          blockerFingerprint,
        };
      }
    }

    if (params.publisherOwner === "local") {
      if (
        params.observed.reachableRefVerified &&
        params.observed.lockedPathsClean === true
      ) {
        return {
          directive: {
            action: "PUBLISH_LOCALLY",
            reason: `Candidate commit ${params.observed.observedHeadSha} passed checkout-free Git verification. Local publisher owner may now publish or present the verified branch to the user.`,
            remainingTurnBudget,
          },
          sameBlockerStreak: 0,
          blockerFingerprint: undefined,
        };
      }
    }

    if (params.publisherOwner === "none" && (params.mode !== "verify_only" ||
        (params.observed.reachableRefVerified && params.observed.treeMatchesExpected === true &&
          params.observed.lockedPathsClean === true))) {
      return {
        directive: {
          action: "COMPLETE",
          reason: "Target reports completion. Check the evidence against the acceptance criteria and present the result; no publication was requested.",
          remainingTurnBudget,
        },
        sameBlockerStreak: 0,
        blockerFingerprint: undefined,
      };
    }
  }

  // Resolvable objection / missing proof / blocker loop (RFC v0.2 Section 4 autonomous resolution contract).
  if (remainingTurnBudget <= 0) {
    return {
      directive: {
        action: "ESCALATE_TO_HUMAN",
        reason:
          "Autonomous turn budget exhausted before reaching terminal completion. Summarize verified progress and remaining blockers for the user.",
        remainingTurnBudget: 0,
      },
      sameBlockerStreak,
      blockerFingerprint,
    };
  }

  return {
    directive: {
      action: "CONTINUE_AUTONOMOUSLY",
      reason: params.mode === "verify_only" && reported?.disposition === "completed" && !params.observed.reachableRefVerified
        ? "No reachable Git candidate was verified. Supply the pinned source or a reachable ref before claiming verification is complete."
        : "Target raised an objection, evidence request, or actionable blocker within autonomous turn budget. Do NOT relay raw pushback to the user: verify against pinned local commits/tests, gather proof or apply bounded in-scope fix, and call bridge_handoff_continue on this same handoffId.",
      remainingTurnBudget,
    },
    sameBlockerStreak,
    blockerFingerprint,
  };
}

function computeBlockerFingerprint(
  reported: ReportedResult | undefined,
  observed: ObservedResult,
  evidenceSourceRefs: readonly string[] = [],
): string | undefined {
  if (!reported) {
    return undefined;
  }
  if (reported.disposition !== "needs_evidence" && reported.disposition !== "blocked") {
    return undefined;
  }
  const normalizedBlockers = reported.blockers
    .map((b) => b.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((b) => b.length > 0)
    .sort();
  const payload = JSON.stringify({
    disposition: reported.disposition,
    blockers:
      normalizedBlockers.length > 0
        ? normalizedBlockers
        : [reported.summaryDelta.trim().toLowerCase().slice(0, 200)],
    head: observed.observedHeadSha ?? "none",
    evidence: [...new Set(evidenceSourceRefs)].sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}
