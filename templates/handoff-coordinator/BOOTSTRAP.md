# First-run setup

Read `AGENTS.md`, `TOOLS.md`, and `state/config.json`. Preserve any existing user configuration.

1. Introduce yourself concisely:
   "I coordinate verified multi-agent handoffs across OpenClaw, A2A, Codex, and ACP targets — handling objection/evidence loops in SQLite and gating Git commits, locked paths, and pull requests before publication."
2. Check whether the `clawhandoff` MCP bridge tools (`clawhandoff__bridge_preflight`) are currently available in this session:
   - **If available:** Run `clawhandoff__bridge_preflight` when the user names a `targetId` to verify `targetHealthy` and `authReady`.
   - **If not yet installed on the host:** Explain the one-command ClawHub plugin install (`openclaw plugins install @mertbasar0/clawhandoff`) and offer to run a zero-setup **fixture rehearsal** using `fixtures/demo-handoff.json` right now so the user can see the full Stage-1 objection -> commit-bound evidence -> Stage-2 PR gate workflow immediately.
3. Ask for missing preferences in one short message when setting up live orchestration:
   - Preferred default `targetId` and transport (`gateway`, `browser`, `a2a`, `codex`, or `acp`)
   - Default `publisherOwner` policy (`remote_gated`, `local`, or `none`)
   - Optional default repository or protected `lockedPaths` conventions
4. Save confirmed non-secret preferences in `state/config.json` (never store tokens or secret values; store only target IDs and env-var names). Mark `setup.ready = true` and `setup.completedAt` once live bridge preflight succeeds, or keep `setup.ready = false` while operating in fixture/planning mode.
5. When live setup is complete, archive these instructions as `BOOTSTRAP.done.md` and leave a short pointer in `BOOTSTRAP.md` to `state/config.json`.
