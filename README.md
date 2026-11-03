# `agent-bridge-mcp`

Local-first Model Context Protocol (MCP) server and autonomous orchestrator contract for durable, Git-verified task handoffs between local developer assistants (**Claude Code**, **Codex**, **local OpenClaw**) and remote or shared **OpenClaw Gateways** (such as team `robo` instances behind Cloudflare Access).

Full architectural specification (Turkish): [`docs/RFC-v0.2.tr.md`](./docs/RFC-v0.2.tr.md)  
Orchestrator execution skill: [`skills/autonomous-handoff/SKILL.md`](./skills/autonomous-handoff/SKILL.md)

---

## Why This Exists

Cross-environment engineering workflows routinely pair a **local workstation agent** (with native OS toolchains such as Windows MSBuild/WinUI/Inno Setup or local hardware) with a **remote Linux OpenClaw Gateway** (with managed worktrees, review context, and bot publication workflows).

Without a structured local bridge, the human developer becomes a manual courier ("meat proxy")—copying prompts, shuffling ZIP archives, recovering stranded remote worktrees, and mediating multi-turn objection loops.

`agent-bridge-mcp` inverts the control plane (`Outbound-Only` from the developer's machine) and separates four concerns that naive chat wrappers conflate:

1. **Autonomous Counter-Evidence Loop (`orchestratorDirective` + `SKILL.md`):** Remote objections or missing-proof claims are evaluated locally against pinned commits and test evidence via `bridge_handoff_continue` until terminal completion, an out-of-scope policy gate, or anti-spin stagnation (`sameBlockerStreak >= 2`).
2. **Preventive Single-Publisher Gate (`local` or Two-Step `remote_gated`):** In `remote_gated` mode, Stage 1 (`prepare_only`) forbids PR creation while the remote agent prepares a reachable Git ref. Stage 2 (`authorize_publish`) unlocks managed PR creation **only after** checkout-free verification confirms `expectedTreeSha` and `lockedPaths` invariants.
3. **Crash-Safe Durable Lifecycle (`start -> handoffId -> attach -> continue`):** Write-ahead SQLite intents (`node:sqlite` WAL + `STRICT` tables) persist `idempotencyKey` and session metadata before every RPC call. If the MCP client or bridge restarts mid-run, `bridge_handoff_attach` reconnects to the existing run without spawning duplicate sessions, turns, or pull requests. Letting `waitBudgetMs` expire (`POLL_ATTACH`) never cancels the remote job; explicit cancellation lives in `bridge_handoff_abort`.
4. **Checkout-Free Untrusted Git Object Verification (`reported` vs `observed`):** Candidate refs are fetched into an isolated bare mirror with hooks, submodules, external diff, and textconv disabled (`core.hooksPath=/dev/null`, `--no-recurse-submodules`, `git diff-tree --no-ext-diff --no-textconv`). `lockedPaths` are checked across **every commit** in `pinnedBaseCommitSha..observedHeadSha` (catching modify-then-revert sequences) without ever touching or stashing the user's working tree.

---

## Requirements & Build

- **Node.js `>= 22.13.0`** (uses built-in `node:sqlite`)
- **Git `>= 2.38`**
- **OpenClaw CLI** (`openclaw`) on `PATH` or configured via `cliPath` / `OPENCLAW_HANDOFF_CLI`
- Optional: `cloudflared` (for `edge-cloudflare` Gateways) and `gh` (for PR reconciliation & rival-PR preflight warnings)

```bash
pnpm install
pnpm run build
pnpm test
```

---

## Configuration

### Option A: Zero-Config Environment Variables
If you already use `OPENCLAW_HANDOFF_*` variables, `agent-bridge-mcp` automatically provisions an isolated client profile (never modifying your primary local `openclaw.json`):

```bash
export OPENCLAW_HANDOFF_URL="https://gateway.example"
export OPENCLAW_HANDOFF_AGENT="main"
export OPENCLAW_HANDOFF_PROJECT="example-project"
# Optional:
# export OPENCLAW_HANDOFF_TARGET_ID="robo"
# export OPENCLAW_HANDOFF_CLI="/usr/local/bin/openclaw"
# export OPENCLAW_HANDOFF_CLOUDFLARED="/usr/local/bin/cloudflared"
# export AGENT_BRIDGE_DATA_DIR="$HOME/.agent-bridge-mcp"
```

### Option B: Multi-Target JSON Config (`--config` or `AGENT_BRIDGE_CONFIG_PATH`)

```json
{
  "dataDir": "/path/to/bridge-data",
  "defaultWaitBudgetMs": 30000,
  "defaultMaxAutonomousTurns": 5,
  "targets": {
    "robo": {
      "targetId": "robo",
      "url": "https://gateway.example",
      "authMode": "edge-cloudflare",
      "agentId": "main",
      "projectId": "openclaw"
    },
    "local-openclaw": {
      "targetId": "local-openclaw",
      "url": "ws://127.0.0.1:18789",
      "authMode": "direct-token",
      "tokenEnvVar": "LOCAL_OPENCLAW_TOKEN",
      "agentId": "main"
    }
  }
}
```

### Registering in Claude Code or Codex

```bash
# Claude Code
claude mcp add agent-bridge -- node /path/to/agent-bridge-mcp/dist/cli.js --config /path/to/bridge-config.json

# Codex
codex mcp add agent-bridge -- node /path/to/agent-bridge-mcp/dist/cli.js --config /path/to/bridge-config.json
```

---

## MCP Tools & Prompts

| Surface | Purpose |
| :--- | :--- |
| **Prompt:** `autonomous-handoff` | Binds the calling local assistant to the Goal-Ownership & Counter-Evidence Resolution contract. |
| **Tool:** `bridge_preflight` | Verifies Gateway `health`, Access auth state (`AUTH_LOGIN_REQUIRED` remediation without SSH fallback), agent roster, and non-blocking rival PR warnings. |
| **Tool:** `bridge_handoff_start` | Validates `HandoffEnvelopeV2` (enforcing 40-hex pinned SHAs and rejecting mode/capability conflicts), records write-ahead SQLite state, opens the session, and observes up to `waitBudgetMs`. |
| **Tool:** `bridge_handoff_attach` | Reconnects to an in-flight or `uncertain` `handoffId` across timeouts or process restarts without duplicating runs or PRs. |
| **Tool:** `bridge_handoff_continue` | Sends commit-bound counter-evidence/follow-ups (`counter_evidence_or_followup`) or unlocks Stage-2 managed PR creation (`authorize_publish`) once `observed` Git checks pass. |
| **Tool:** `bridge_verify_git` | Runs checkout-free bare-mirror verification of `pinnedBaseCommitSha` ancestry, `expectedTreeSha`, `lockedPaths` across all intermediate commits, and `gh` PR state. |
| **Tool:** `bridge_handoff_abort` | Explicitly cancels the remote run via `chat.abort`. |
