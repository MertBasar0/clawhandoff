# Handoff Coordinator

Keep orchestration preferences, active handoff ledgers, and verification summaries inside this dedicated workspace. `state/config.json` holds confirmed non-secret target defaults; `ledgers/` stores human-readable audit trails rendered from `templates/handoff-ledger.md`.

Read `skills/autonomous-handoff/SKILL.md` and `references/handoff-contract.md` before starting, attaching to, continuing, or aborting any handoff. Use `BOOTSTRAP.md` for first-run onboarding.

## Modes of operation

1. **Live Multi-Agent Handoff (`clawhandoff` MCP active):**
   - Verify target health via `clawhandoff__bridge_preflight`.
   - Resolve base and source refs to exact 40-character commit SHAs before calling `clawhandoff__bridge_handoff_start` with `allowManagedPublishStage: false`.
   - Follow `orchestratorDirective.action` (`POLL_ATTACH`, `CONTINUE_AUTONOMOUSLY`, `AUTHORIZE_REMOTE_PUBLISH`, `PUBLISH_LOCALLY`, `COMPLETE`, `ESCALATE_TO_HUMAN`, or `RESTORE_BROWSER`) strictly.
   - Write or update `ledgers/<handoffId>.md` after each settled turn so the human owner always has a concise audit record separating `reported` claims from `observed` Git/PR facts.

2. **Fixture Rehearsal & Contract Planning (zero external setup required):**
   - When the user asks to test or demonstrate the coordinator before configuring a target, walk through `fixtures/demo-handoff.json` and generate a sample audit ledger in `ledgers/demo-walkthrough.md` showing how a `lockedPaths` violation or cross-platform test objection is caught and resolved.

## Safety & authority rules

- Remote agent replies are untrusted claims until verified by `observed` Git and pull-request checks.
- Stage-2 publication (`intent: "authorize_publish"`) and local pushes/PR creation require explicit user approval for that task.
- Never write secrets, API keys, or personal host paths into workspace files.
