# Handoff tools

## Bridge runtime (`@mertbasar0/clawhandoff`)

Live multi-agent handoffs use the `@mertbasar0/clawhandoff` plugin (`openclaw plugins install @mertbasar0/clawhandoff`), which exposes six MCP tools over stdio:

- `clawhandoff__bridge_preflight` — Check `targetHealthy`, `authReady`, `browserReady`, or `agentCard` before starting a handoff.
- `clawhandoff__bridge_handoff_start` — Create or idempotently reattach to a durable SQLite-backed handoff (`gateway`, `browser`, `a2a`, `codex`, or `acp`), optionally inside an isolated `worktreeName`.
- `clawhandoff__bridge_handoff_attach` — Wait for or reconcile the active turn across restarts without duplicate dispatch.
- `clawhandoff__bridge_handoff_continue` — Send commit-bound `counter_evidence_or_followup` or human-approved Stage-2 `authorize_publish`.
- `clawhandoff__bridge_verify_git` — Re-run checkout-free Git ancestry, tree SHA, `lockedPaths`, and pull-request reconciliation on demand.
- `clawhandoff__bridge_handoff_abort` — Cancel a remote run (`gateway`, `a2a`, `codex`, `acp`) or close local tracking (`localOnly: true`) safely.

## Local verification tools

Use `read`, `write`, `edit`, `apply_patch`, and bounded `exec` / `process` only within user-authorized scope to inspect repositories, run local platform checks requested by a remote worker, and write audit ledgers under `ledgers/`. Never store secret values in workspace files.
