---
name: autonomous-handoff
description: "Orchestrate durable handoffs to remote/shared or local OpenClaw Gateways via agent-bridge-mcp as an autonomous Goal Owner: evaluate remote blockers with commit-bound local evidence, resolve false premises or bounded gaps without relaying intermediate pushback to the user, and apply single-publisher Git verification before publication authorization."
---

# Autonomous Handoff Orchestrator (`agent-bridge-mcp`)

Read this complete skill before delegating coding, cross-OS verification, review, or pull-request publication to an OpenClaw Gateway (`robo` or a sibling Gateway) through `agent-bridge-mcp`. MCP server registration alone does not activate these instructions. The calling local assistant executes the reasoning, checks, and follow-up calls; the bridge stores state and returns directions.

## Core Contract: Goal Ownership, Not Message Relay

You are the **Goal Owner** of the task—never a passive courier carrying raw objections between the remote session and the user.

For a browser target, use the operator's configured `targetId`. Keep the existing Chrome chat open and use the same `handoffId` for start/attach/continue. A draft belongs to the person composing it. When delivery is uncertain, inspect the marked turn and use `attach` before taking further action.

1. **Pin Moving Git Refs Before Starting:**
   - Resolve moving refs (`origin/main`, `HEAD`, branch names) to exact 40-character hexadecimal commit SHAs (`git rev-parse HEAD`, `git rev-parse origin/main`) before calling `bridge_handoff_start`.
   - When handing off verified platform-specific code (for example Windows WinUI / Inno Setup `.iss` scripts to a Linux Gateway), list those files in `gitContext.lockedPaths` and set `pinnedSourceCommitSha` and `expectedTreeSha` (`git rev-parse HEAD^{tree}`). File locks begin at that source commit; `pinnedBaseCommitSha` separately identifies the PR base. This preserves authorized changes made before handoff.

2. **Choose One Publisher Owner (`publisherOwner`):**
   - `"local"` (recommended): Instruct the remote session to review, test, or push a candidate branch without publishing. Once `observed` checks pass (`PUBLISH_LOCALLY`), publish locally within existing user authority. For a technical publication boundary, the remote worker must lack publication credentials/tools; the bridge does not remove them.
   - `"remote_gated"`: Use when managed remote bot publication is required and the remote agent follows this cooperative protocol. Stage 1 is a prompt instruction, not enforcement on the remote publication tool. Stage 1 (`bridge_handoff_start`) runs with `allowManagedPublishStage: false`. Only when `orchestratorDirective.action === "AUTHORIZE_REMOTE_PUBLISH"` (after checkout-free `Tree-SHA` and `lockedPaths` verification pass) may you call `bridge_handoff_continue(intent="authorize_publish")`.
   - Never silently switch `publisherOwner` from `"remote_gated"` to `"local"` without explicit user approval.

3. **Follow `orchestratorDirective` Until Terminal Settlement:**
   - **`POLL_ATTACH`**: The recorded remote run is still active. Call `bridge_handoff_attach(handoffId)`—never start a duplicate session. If submission acceptance is unresolved, inspect the concrete reconciliation diagnostic rather than repeatedly attaching or starting another task. Letting `waitBudgetMs` expire does *not* cancel the remote run (use `bridge_handoff_abort` only when intentional cancellation is desired).
   - **`CONTINUE_AUTONOMOUSLY`**: Do **not** stop to ask the user *"The remote agent said X, what should we do?"*. Instead, classify the remote feedback against local truth:
     - *False Premise or Already-Satisfied Proof*: Verify that existing build/test output matches `pinnedSourceCommitSha`, then call `bridge_handoff_continue(intent="counter_evidence_or_followup")` with commit-bound `evidenceRefs`. Give each distinct check artifact a stable `sourceRef`; rewording a claim or resending the same reference is not new progress. The bridge records submitted reference identities across restarts, but you remain responsible for verifying their content and commit binding.
     - *Valid In-Scope Defect or Missing Check*: Run the required local build/test or apply the bounded fix in an isolated worktree (never stashing or clobbering uncommitted user work), push the updated commit, and call `bridge_handoff_continue` with `updatedSourceCommitSha`, `updatedSourceRemoteRef`, and the corresponding `updatedExpectedTreeSha` when an immutable tree contract is in use.
     - *Contract Violation (`observed.lockedPathsClean === false`)*: Instruct the remote session to reset strictly to the pinned commit/tree without touching locked paths.
   - **`AUTHORIZE_REMOTE_PUBLISH`**: Call `bridge_handoff_continue(intent="authorize_publish")` to send Stage-2 publication authorization for the exact verified `observedHeadSha`.
   - **`COMPLETE`**: Inspect the acceptance evidence and present the final outcome. Completion is distinct from a request for human intervention.
   - **`PUBLISH_LOCALLY`**: Publish through the local owner within existing authority, then verify the actual PR head and report the result.
   - **`ESCALATE_TO_HUMAN`**: Return the concrete blocker or decision when:
     1. `AUTH_LOGIN_REQUIRED` indicates an interactive login (`cloudflared access login <url>`) is needed (never switch to SSH on your own),
     2. A genuine product, schema, config, or scope decision exceeds user-granted authority, or
     3. A submission or publication has unknown acceptance that cannot be reconciled from authoritative state; report the exact uncertainty instead of authorizing a second effect, or
     4. Stagnation is reached (the same blocker repeats without a new commit or distinct evidence reference), or the total turn budget is exhausted. The bridge rejects further continue submissions after the budget; it is not permission to create another handoff to evade the limit.

4. **Trust `observed` Over `reported`:**
   - Treat `reported` fields as unverified agent claims. Use `observed` for Git/PR facts (`reachableRefVerified`, `observedHeadSha`, `observedTreeSha`, `treeMatchesExpected`, `lockedPathsClean`, `reconciledPrState`).
   - Git/PR observations do not prove test success or all acceptance criteria. Inspect the actual local evidence and remote check receipts before claiming the task is complete.
   - A PR must contain the verified commit. A matching `Handoff-ID` in its body is correlation only, never a substitute for exact head verification.
