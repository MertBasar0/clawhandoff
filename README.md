# `agent-bridge-mcp`

Local-first Model Context Protocol (MCP) server and autonomous orchestrator contract for durable, Git-verified task handoffs between local developer assistants (**Claude Code**, **Codex**, **local OpenClaw**) and remote or shared **OpenClaw Gateways** (such as team `robo` instances behind Cloudflare Access).

Full architectural specification (Turkish): [`docs/RFC-v0.2.tr.md`](./docs/RFC-v0.2.tr.md)  
Orchestrator execution skill: [`skills/autonomous-handoff/SKILL.md`](./skills/autonomous-handoff/SKILL.md)

---

## Why This Exists

Cross-environment engineering workflows routinely pair a **local workstation agent** (with native OS toolchains such as Windows MSBuild/WinUI/Inno Setup or local hardware) with a **remote Linux OpenClaw Gateway** (with managed worktrees, review context, and bot publication workflows).

Without a structured local bridge, the human developer becomes a manual courier ("meat proxy")—copying prompts, shuffling ZIP archives, recovering stranded remote worktrees, and mediating multi-turn objection loops.

`agent-bridge-mcp` inverts the control plane (`Outbound-Only` from the developer's machine) and separates four concerns that naive chat wrappers conflate:

1. **Host-driven counter-evidence loop:** The calling local assistant evaluates remote objections, runs authorized local checks, and submits evidence through `bridge_handoff_continue`. The bridge stores progress and returns `orchestratorDirective`; it does not run a local reasoning agent itself. New evidence references count as progress even when the commit is unchanged; resending the same reference does not. The turn budget bounds further submissions. `COMPLETE` reports completion separately from `ESCALATE_TO_HUMAN`.
2. **Single publisher (`local` or cooperative `remote_gated`):** With `remote_gated`, the bridge sends Stage-2 authorization only after Git verification. Stage 1's instruction not to publish is a prompt contract, **not a revocation of the remote agent's tools or credentials**. When publication must be technically prevented until verification, use a local publisher and a remote worker without publication authority. For reconciliation, the bridge checks the exact open PR when its URL is known; otherwise it requires a unique same-repository match for the verified head. The contract does not name a destination branch; check it separately when it matters.
3. **Durable lifecycle (`start -> handoffId -> attach -> continue`):** SQLite records submission intent before the RPC. A recorded `runId` can be observed after restart. The bridge claims each submission before sending it and stores its remote session key. If a submission response is lost, the bridge looks for the submitted message and its run ID in session history. Without a match it returns `uncertain` with `ESCALATE_TO_HUMAN` and does not resend. A saved idempotency key alone cannot guarantee replay safety after the Gateway loses its deduplication state. Letting `waitBudgetMs` expire never cancels the remote job. Gateway targets support explicit cancellation by run ID.
4. **Checkout-free Git verification:** Candidate refs are fetched into an isolated bare mirror without checkout, recursive submodule fetching, hooks, external diff, or textconv. PR-base ancestry is checked separately from file locks. `lockedPaths` start at `pinnedSourceCommitSha` (or `pinnedBaseCommitSha` when no source is provided), so authorized local changes made before handoff are preserved. Remote modify-then-revert commits are still detected.

---

## Requirements & Build

- **Node.js `>= 22.13.0`** (uses built-in `node:sqlite`)
- **Git `>= 2.38`**
- Gateway targets require the **OpenClaw CLI**. Browser targets require a signed-in Chrome session and **Chrome DevTools MCP** with page ID and structured output support (tested with 1.11.0).
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

### Use an existing Robo chat in Chrome

Open the desired chat in exactly one tab of the Chrome profile you use for Team. Enable Chrome's remote debugging at `chrome://inspect/#remote-debugging` and accept the local connection prompt if Chrome shows one. The browser inherits the access of your signed-in account. Messages and evidence appear in that chat's ordinary history.

Add this entry to `targets` in the bridge config, replacing the URL and executable path with yours:

```json
{
  "robo-web": {
    "targetId": "robo-web",
    "transport": "browser",
    "agentId": "roboclaw",
    "sessionUrl": "https://team.example/chat/roboclaw/dashboard/YOUR-EXISTING-CHAT-ID",
    "browserMcp": {
      "command": "/absolute/path/to/chrome-devtools-mcp",
      "args": ["--no-usage-statistics", "--no-performance-crux"]
    }
  }
}
```

Use a locally installed [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) on the same OS as Chrome. From WSL with Windows Chrome, `command` can be the WSL path to Windows `node.exe`; give the Windows path to the installed `chrome-devtools-mcp.js` as the first argument. The bridge enables auto-connect and structured output. No Gateway CLI credentials or Team device pairing are needed for this target.

Call `bridge_preflight(targetId="robo-web")` and check `browserReady`. Start with `bridge_handoff_start` and use the returned `handoffId` for every attach or follow-up, just as for a Gateway target. Keep the chat open and its composer free. Each outgoing turn carries a unique marker. The bridge accepts a finished reply only when it can tie the visible assistant message to that turn. An ambiguous send is recorded as uncertain; `attach` only looks for the original message. For a virtualized transcript you may need to bring the relevant messages back into view.

Browser targets reuse the existing chat and its workspace. A named worktree requires a Gateway target. You can cancel an unsent browser turn with `bridge_handoff_abort`. After submission only the chat UI can stop the current response; the bridge cannot safely cancel a specific browser run. After inspecting an unresolved turn, an operator can explicitly call `bridge_handoff_abort(handoffId, localOnly=true)` to release the chat from local tracking. This does not stop Robo or deliver a message. Browser `runId` values identify the bridge's marked turns and cannot be passed to the Gateway API.

### Registering in Claude Code or Codex

```bash
# Claude Code
claude mcp add agent-bridge -- node /path/to/agent-bridge-mcp/dist/cli.js --config /path/to/bridge-config.json

# Codex
codex mcp add agent-bridge -- node /path/to/agent-bridge-mcp/dist/cli.js --config /path/to/bridge-config.json
```

Registration makes the tools available; it does not automatically load the orchestrator skill. Before the first handoff, ask the local assistant to read the complete `skills/autonomous-handoff/SKILL.md` from this installation and follow it for the task. If the host exposes MCP prompts, select `autonomous-handoff` with the target and goal. The local assistant must remain active to collect evidence and call the next tool; the MCP server does not independently resume a stopped assistant.

---

## MCP Tools & Prompts

| Surface | Purpose |
| :--- | :--- |
| **Prompt:** `autonomous-handoff` | Supplies the calling local assistant with the goal-ownership and counter-evidence instructions when the host selects it. |
| **Tool:** `bridge_preflight` | Verifies Gateway `health`, Access auth state (`AUTH_LOGIN_REQUIRED` remediation without SSH fallback), agent roster, and non-blocking rival PR warnings. |
| **Tool:** `bridge_handoff_start` | Validates `HandoffEnvelopeV2` (enforcing 40-hex pinned SHAs and rejecting mode/capability conflicts), records write-ahead SQLite state, opens the session, and observes up to `waitBudgetMs`. |
| **Tool:** `bridge_handoff_attach` | Observes a recorded run after timeout/restart; unknown dispatch acceptance requires reconciliation, not a second submission. |
| **Tool:** `bridge_handoff_continue` | Sends commit-bound counter-evidence/follow-ups (`counter_evidence_or_followup`) or sends Stage-2 managed publication authorization (`authorize_publish`) once Git checks pass; rejects submissions beyond the turn budget. |
| **Tool:** `bridge_verify_git` | Runs checkout-free bare-mirror verification of `pinnedBaseCommitSha` ancestry, `expectedTreeSha`, `lockedPaths` since the handed-off source commit, and the exact PR head through `gh`. |
| **Tool:** `bridge_handoff_abort` | Cancels a Gateway run via `chat.abort` or a browser turn before it has been sent. |

## Verification and real-host acceptance

`pnpm test` exercises the bridge with temporary Git repositories and simulated Gateway/GitHub responses. It covers transport, persistence, and decision behavior; it is not proof that a real Claude/Codex agent autonomously gathers evidence or that a live Gateway enforces publication permissions.

For restart proof, stop the bridge after a run ID is recorded, restart, and attach to that handoff. Separately test a lost submission response: unresolved acceptance must remain visible and must not cause another remote session or turn. Inspect the existing Gateway state before any deliberate retry. An uncertain publication must not be retried merely because a PR search is empty.

### Run the counter-evidence loop with a local agent

After building the bridge, run `node test/helpers/host-acceptance.mjs setup` in this checkout. It prints a temporary Git workspace, an MCP server configuration, a goal, and a verification command. Open the printed workspace in your local agent, register the printed server for that session, and give the agent the goal. The fixture Gateway raises an objection and accepts the follow-up only when it includes a receipt from the project's smoke check for the submitted commit.

When the agent finishes, run the printed `verify` command. It checks that one remote session received the receipt and that the bridge recorded `CONTINUE_AUTONOMOUSLY` followed by `COMPLETE`. The run uses the real local agent, MCP transport, Git, and SQLite with a simulated remote reviewer. Remove the temporary workspace and its enclosing fixture directory when finished.
