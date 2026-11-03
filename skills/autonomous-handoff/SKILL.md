---
name: autonomous-handoff
description: "Orchestrate durable handoffs to remote/shared or local OpenClaw Gateways via agent-bridge-mcp as an autonomous Goal Owner: evaluate remote blockers with commit-bound local evidence, resolve false premises or bounded gaps without relaying intermediate pushback to the user, and enforce single-publisher Git verification gates."
---

# Autonomous Handoff Orchestrator (`agent-bridge-mcp`)

Use this skill whenever delegating coding, cross-OS verification, review, or gated pull-request publication to an OpenClaw Gateway (`robo` or a sibling Gateway) through `agent-bridge-mcp`.

## Core Contract: Goal Ownership, Not Message Relay

You are the **Goal Owner** of the task—never a passive courier carrying raw objections between the remote session and the user.

1. **Pin Moving Git Refs Before Starting:**
   - Resolve moving refs (`origin/main`, `HEAD`, branch names) to exact 40-character hexadecimal commit SHAs (`git rev-parse HEAD`, `git rev-parse origin/main`) before calling `bridge_handoff_start`.
   - When handing off verified platform-specific code (for example Windows WinUI / Inno Setup `.iss` scripts to a Linux Gateway), list those files in `gitContext.lockedPaths` and set `expectedTreeSha` (`git rev-parse HEAD^{tree}`).

2. **Choose One Publisher Owner (`publisherOwner`):**
   - `"local"` (default): The remote session reviews, tests, or pushes a candidate branch, but **never** opens a PR. Once `observed` checks pass (`PUBLISH_LOCALLY`), publish locally or present the verified branch.
   - `"remote_gated"`: Use when managed remote bot publication is required. Stage 1 (`bridge_handoff_start`) runs with `allowManagedPublishStage: false`. Only when `orchestratorDirective.action === "AUTHORIZE_REMOTE_PUBLISH"` (after checkout-free `Tree-SHA` and `lockedPaths` verification pass) may you call `bridge_handoff_continue(intent="authorize_publish")`.
   - Never silently switch `publisherOwner` from `"remote_gated"` to `"local"` without explicit user approval.

3. **Follow `orchestratorDirective` Until Terminal Settlement:**
   - **`POLL_ATTACH`**: The remote run is still active or awaiting post-timeout reconciliation. Call `bridge_handoff_attach(handoffId)`—never start a duplicate session, and remember that letting `waitBudgetMs` expire does *not* cancel the remote run (use `bridge_handoff_abort` only when intentional cancellation is desired).
   - **`CONTINUE_AUTONOMOUSLY`**: Do **not** stop to ask the user *"The remote agent said X, what should we do?"*. Instead, classify the remote feedback against local truth:
     - *False Premise or Already-Satisfied Proof*: Verify that existing build/test output matches `pinnedSourceCommitSha`, then call `bridge_handoff_continue(intent="counter_evidence_or_followup")` with commit-bound `evidenceRefs`.
     - *Valid In-Scope Defect or Missing Check*: Run the required local build/test or apply the bounded fix in an isolated worktree (never stashing or clobbering uncommitted user work), push the updated commit, and call `bridge_handoff_continue` with `updatedSourceCommitSha` and `updatedSourceRemoteRef`.
     - *Contract Violation (`observed.lockedPathsClean === false`)*: Instruct the remote session to reset strictly to the pinned commit/tree without touching locked paths.
   - **`AUTHORIZE_REMOTE_PUBLISH`**: Call `bridge_handoff_continue(intent="authorize_publish")` to unlock Stage-2 managed PR creation for the exact verified `observedHeadSha`.
   - **`PUBLISH_LOCALLY` / `ESCALATE_TO_HUMAN`**: Return to the user **only** when:
     1. The task is verified complete,
     2. `AUTH_LOGIN_REQUIRED` indicates an interactive login (`cloudflared access login <url>`) is needed (never switch to SSH on your own),
     3. A genuine product, schema, config, or scope decision exceeds user-granted authority, or
     4. Stagnation is reached (`sameBlockerStreak >= 2` or `remainingTurnBudget === 0`).

4. **Trust `observed` Over `reported`:**
   - Treat `reported` fields as unverified agent claims. Base publication and completion verdicts strictly on `observed` (`reachableRefVerified`, `observedHeadSha`, `observedTreeSha`, `treeMatchesExpected`, `lockedPathsClean`, `reconciledPrState`).
