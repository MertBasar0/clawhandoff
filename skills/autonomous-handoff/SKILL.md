---
name: autonomous-handoff
description: "Use agent-bridge-mcp to hand work to an OpenClaw Gateway or an existing browser chat, answer objections with commit-bound evidence, and reconcile the outcome before publication."
---

# Run an autonomous handoff

The local assistant owns the user's task. It runs authorized local checks, interprets Robo's response, and calls the next MCP tool. The bridge persists each turn and verifies Git and PR facts. Read the skill before starting, or use the client's `autonomous-handoff` MCP prompt with `targetId` and `goal`. Registering the server alone does not start this loop.

## Start and retain the handoff

1. Choose the configured `targetId` and call `bridge_preflight`. For a browser target, check `browserReady` and keep the exact chat open in one Chrome tab with an empty composer. A browser handoff reuses that chat. A Gateway handoff opens a dedicated session.
2. Resolve the PR base and any source ref to 40-character Git commit SHAs. Give the task a unique, stable `requestId` and concrete `acceptanceCriteria`. For Git verification, supply a repository the bridge can read through `localRepoPath` or `remoteUrlOrPath`. Use `pinnedSourceCommitSha` to identify tested work. Use `expectedTreeSha` for an immutable tree and `lockedPaths` for files or directories that must stay unchanged after the source commit.
3. Choose `publisherOwner: "none"` when no publication is requested, `"local"` when the local operator owns publication, or `"remote_gated"` for a two-stage managed remote publication. Set `allowManagedPublishStage: false` on every initial request. Requested capabilities are instructions to Robo. For an enforced publication boundary, use a local publisher and a remote worker without publication credentials. Changing publishers requires the user's authority.
4. Call `bridge_handoff_start` with the target and envelope. Save the returned `handoffId` for all later calls. If the initial response is lost before you receive the ID, retry the same initial request with the same `requestId` and data directory. Reusing an ID reattaches to the existing handoff.

## Act on the returned directive

| `orchestratorDirective.action` | Local assistant's action |
| --- | --- |
| `POLL_ATTACH` | Call `bridge_handoff_attach` with the saved `handoffId`. An expired wait budget ends the wait only. |
| `CONTINUE_AUTONOMOUSLY` | Check the objection against source and evidence. Use `bridge_handoff_continue` with `intent: "counter_evidence_or_followup"`, a `message` and relevant `evidenceRefs` to advance the same handoff. |
| `AUTHORIZE_REMOTE_PUBLISH` | If the user authorized publication, call `bridge_handoff_continue` with `intent: "authorize_publish"` and a `message` for the verified candidate. The bridge checks the ref and PR state again immediately before sending the authorization. Submit changed Git coordinates in a separate evidence turn first. |
| `PUBLISH_LOCALLY` | Within the user's authority, publish the exact verified commit through the local owner. Verify the open PR's head and intended base branch. |
| `COMPLETE` | Check the user's acceptance criteria before reporting success. For example, a verified open PR can still have failing CI. |
| `ESCALATE_TO_HUMAN` | Inspect `orchestratorDirective.reason`, any `reported.blockers`, and `observed.verificationNotes`. Explain the remaining access, recovery, or scope decision. |

**When Robo asks for proof.** Check which commit the existing log or test artifact covers. If evidence is missing, run the authorized check in isolation. Return a specific `claim` and a stable `sourceRef` such as a CI job or artifact URL together with the tested commit in the claim. Rewording an old reference does not count as new evidence. If the fix changes the candidate, submit `updatedSourceCommitSha` and its reachable `updatedSourceRemoteRef` within the user's existing push authority. An explicitly supplied `updatedExpectedTreeSha` must match that new source commit.

**When a candidate becomes reachable.** For a settled or failed turn, call `bridge_verify_git` with its `handoffId` and `candidateRef` to refresh the Git and PR observations. Supply `remoteUrlOrPath` if the handoff has no repository locator, then follow the returned directive.

**When Git verification fails.** Inspect `violatedPaths`, base ancestry, and any tree mismatch. A later commit that reverts a locked file still leaves the offending commit in the checked history. If an authorized correction is possible, prepare a clean candidate from the pinned source and submit it for verification. Preserve other work and obtain authority before altering any shared branch or changing the contract.

**When delivery is uncertain.** Use the recorded `handoffId` and inspect the original session. A browser reply belongs to the current `Bridge-Reply` marker and ends in a flush-left fenced `handoff-result` block. A saved intent can still be waiting for Chrome permission or the connection to return. Recover using `bridge_handoff_attach`. For `AUTH_LOGIN_REQUIRED`, surface the operator action in the tool error's `remediation`. If a browser handoff must be abandoned after inspection, `bridge_handoff_abort(localOnly=true)` with its ID closes local tracking. Stopping an active response requires the chat UI. Gateway cancellation uses `bridge_handoff_abort` for the recorded run.

Treat `reported` as the agent's account and `observed` as the bridge's Git/PR inspection. Verify test results at the cited evidence source yourself. If a prior publication is uncertain, reconcile the existing PR before attempting another publication. Honor the selected publisher and the turn budget. If the same blocker appears on two consecutive turns without a new observed commit or a new evidence reference, or if the turn budget runs out, report the verified work and the outstanding decision.
