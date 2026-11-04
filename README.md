# clawhandoff

`clawhandoff` connects a local assistant to an OpenClaw agent such as Robo. Suppose Robo asks for a Windows test it cannot run. Your local assistant can run the test, send the result back to the same conversation and check Robo’s reply. The bridge records each turn in SQLite and can verify Git commits and pull requests. The local assistant owns the investigation and must stay active to advance it.

[Guided browser quickstart](docs/quickstart.md) · [Architecture and protocol (RFC v0.2)](docs/RFC-v0.2.md) · [Local orchestrator skill](skills/autonomous-handoff/SKILL.md)

## Build from source

Install Node.js 22.13 or newer, pnpm and Git 2.38 or newer. Clone the repository and build the server.

```sh
git clone https://github.com/MertBasar0/clawhandoff.git
cd clawhandoff
pnpm install --frozen-lockfile
pnpm run build
node -p "process.execPath"
```

To try the handoff loop without a Team account, use the [local acceptance exercise](#test-the-loop-locally) after building.

The build creates `dist/cli.js`. Keep the printed absolute Node path for your MCP client configuration.

## Configure a target

| Choose | What it does | What you need |
| --- | --- | --- |
| Browser | Uses a specific, existing Robo conversation. Messages appear in its ordinary Team history. | The exact chat URL, your signed-in Chrome profile and [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) with explicit page IDs and structured output (tested with 1.11.0). |
| Gateway | Creates a dedicated agent session over RPC. Supports named worktrees and cancellation by run ID. | An OpenClaw CLI with access to the Gateway. Cloudflare Access targets also need `cloudflared`. |

### Use an existing Robo chat in Chrome

1. Open the intended conversation in exactly one tab. Copy its full HTTPS URL and leave the message box empty.
2. In that Chrome instance, open `chrome://inspect/#remote-debugging` and enable remote debugging. Allow the connection in Chrome when prompted. Browser mode uses the signed-in session and requires no Team device pairing. [Chrome connection instructions](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
3. Save the following as `bridge-config.json`. Replace the example URL and executable with yours. `targetId` is the bridge’s local name for this connection. `agentId` identifies the agent in the URL.

```json
{
  "targets": {
    "robo-web": {
      "targetId": "robo-web",
      "transport": "browser",
      "agentId": "roboclaw",
      "sessionUrl": "https://team.example/chat/roboclaw/YOUR-EXISTING-CHAT-ID",
      "browserMcp": {
        "command": "/absolute/path/to/chrome-devtools-mcp",
        "args": ["--no-usage-statistics", "--no-performance-crux"]
      }
    }
  }
}
```

Use Chrome DevTools MCP on the same OS as Chrome. If the bridge runs in WSL and Chrome runs on Windows, set `browserMcp.command` to the WSL path to Windows `node.exe`. Set the first entry in `browserMcp.args` to the Windows path to the installed `chrome-devtools-mcp.js`, followed by the options above. The bridge adds the auto-connect and structured-output flags. Robo uses the tools and GitHub identity available in that Team session.

If more than one part of the URL could be the start of the session route, set the target’s `basePath` to the Control UI mount. For `https://team.example/dashboard/chat/roboclaw/topic` served under `/dashboard`, use `"basePath": "/dashboard"`. Use `"/"` for a root deployment. Unambiguous URLs work without this field.

### Connect to a Gateway

For Gateway access, save this as your config or merge the target into the same `targets` object. The bridge stores its client profile under its data directory by default.

```json
{
  "targets": {
    "robo": {
      "targetId": "robo",
      "transport": "gateway",
      "url": "https://gateway.example",
      "authMode": "edge-cloudflare",
      "cloudflaredPath": "/absolute/path/to/cloudflared",
      "agentId": "main",
      "projectId": "example-project"
    }
  }
}
```

- **Cloudflare Access.** Supply your Gateway URL, agent and project. If preflight reports `AUTH_LOGIN_REQUIRED` or returns login instructions, run `cloudflared access login` with the URL in the remediation and check again.
- **Direct token.** Use `"authMode": "direct-token"` with the appropriate `ws://` or `wss://` Gateway URL. Set `tokenEnvVar` to the **name** of the environment variable containing the token. The bridge process must inherit it. The default name is `OPENCLAW_BRIDGE_TARGET_TOKEN`.
- **Existing profile.** Use `"authMode": "existing-profile"` and a `profileDir` containing an `openclaw.json` for the configured Gateway. The bridge checks that the stored remote URL matches.

For one Gateway, you can omit the config file and set `OPENCLAW_HANDOFF_URL`, `OPENCLAW_HANDOFF_AGENT` and, when applicable, `OPENCLAW_HANDOFF_PROJECT` in the MCP server’s environment. `OPENCLAW_HANDOFF_TARGET_ID` defaults to `robo` and `OPENCLAW_HANDOFF_AUTH_MODE` defaults to `edge-cloudflare`. `OPENCLAW_HANDOFF_CLI` and `OPENCLAW_HANDOFF_CLOUDFLARED` override the executable paths. An explicit `--config` or `CLAWHANDOFF_CONFIG_PATH` selects file-based targets instead.

## Register the bridge with your local assistant

Register a **stdio MCP server** named `clawhandoff` using the Node path from the build step. For clients that accept an `mcpServers` JSON object, the entry looks like this. Replace all three paths with absolute paths on the machine running the client.

```json
{
  "mcpServers": {
    "clawhandoff": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/clawhandoff/dist/cli.js", "--config", "/absolute/path/to/bridge-config.json"]
    }
  }
}
```

Claude Code and Codex can register the same server from the command line. Run the command for your client.

```sh
# Claude Code
claude mcp add clawhandoff -- /absolute/path/to/node /absolute/path/to/clawhandoff/dist/cli.js --config /absolute/path/to/bridge-config.json

# Codex
codex mcp add clawhandoff -- /absolute/path/to/node /absolute/path/to/clawhandoff/dist/cli.js --config /absolute/path/to/bridge-config.json
```

Ask your assistant to read the [orchestrator skill](skills/autonomous-handoff/SKILL.md) before the first handoff. Hosts that expose MCP prompts can also select `autonomous-handoff` with `targetId` and `goal`. Registration alone makes the tools available.

## Run a first handoff

These are arguments for MCP tools in your local assistant. Use `robo` in place of `robo-web` if you configured the Gateway example.

**1. Check the target.** Call `bridge_preflight` with `{"targetId":"robo-web"}`. For Chrome, expect `browserReady: true`. Its `gatewayHealthy: false` field is expected because no Gateway RPC ran. For a Gateway target, look for `gatewayHealthy: true`, `authReady: true` and `agentFound: true`. Preflight sends no task message.

**2. Start a read-only code investigation.** Call `bridge_handoff_start` with the following object. It uses a published commit of this project and requests no edits, pushes or publication. For other work, run `git rev-parse HEAD` in the repository you want reviewed and use the full SHA. Use a fresh `requestId` for each new task and reuse that ID if the same start call needs a retry.

```json
{
  "targetId": "robo-web",
  "waitBudgetMs": 5000,
  "maxAutonomousTurns": 3,
  "envelope": {
    "schemaVersion": "0.2",
    "requestId": "browser-receipt-review-01",
    "workspaceId": "clawhandoff",
    "title": "Review browser reply ownership",
    "outcome": "Explain how the bridge handles a past success report quoted in a new Robo reply.",
    "mode": "investigate",
    "publisherOwner": "none",
    "gitContext": {
      "repoId": "MertBasar0/clawhandoff",
      "pinnedBaseCommitSha": "c210b9022aadbf9a6518ed8582095bab29402526"
    },
    "requestedCapabilities": {
      "allowCodeEdit": false,
      "allowBranchPush": false,
      "allowManagedPublishStage": false
    },
    "acceptanceCriteria": ["Identify the code that binds the result to the current turn, or say what evidence is missing."]
  }
}
```

**3. Save the returned `handoffId` and follow `orchestratorDirective.action`.** `waitBudgetMs` controls how long to observe a turn during a call. If the work is still running, the bridge returns `POLL_ATTACH`. Call `bridge_handoff_attach` with that `handoffId`, including after restarting the bridge. Use the same data directory across restarts (default `~/.clawhandoff`, configurable via `dataDir` or `CLAWHANDOFF_DATA_DIR`).

| Action | What the local assistant does |
| --- | --- |
| `POLL_ATTACH` | Observe the existing turn with `bridge_handoff_attach`. |
| `CONTINUE_AUTONOMOUSLY` | Read `reported.blockers`, inspect the pinned source or run the authorized local check, then call `bridge_handoff_continue` with the evidence. |
| `COMPLETE` | Check the acceptance criteria against the evidence and report the outcome. Read the remote agent’s claims in `reported` and the bridge’s Git and PR observations in `observed`. |
| `ESCALATE_TO_HUMAN` | Explain the specific permission, unresolved submission, repeated blocker or exhausted turn budget. |
| `PUBLISH_LOCALLY` / `AUTHORIZE_REMOTE_PUBLISH` | Follow the selected [publication contract](#git-verification-and-publication) within the authority already granted. |

For example, if Robo asks whether the regression test passes, the local assistant can run it at the pinned revision and send its receipt with `bridge_handoff_continue`. Replace the placeholders below with the returned ID and the actual test receipt.

```json
{
  "handoffId": "REPLACE_WITH_RETURNED_HANDOFF_ID",
  "intent": "counter_evidence_or_followup",
  "message": "REPLACE_WITH_THE_TEST_NAME_AND_ACTUAL_RESULT",
  "evidenceRefs": [
    {"claim": "REPLACE_WITH_WHAT_THE_RESULT_SHOWS", "sourceRef": "REPLACE_WITH_COMMIT_BOUND_TEST_RECEIPT"}
  ]
}
```

Use a stable `sourceRef` for each distinct artifact. The assistant verifies its contents and summarizes the relevant result for Robo. Reusing the same reference does not count as new evidence. The turn budget includes the first turn and all follow-ups. The loop pauses when the local assistant stops calling tools.

## Recover an interrupted handoff

Keep exactly one tab open at the configured chat URL with its input empty. If a Chrome connection request times out, call `bridge_handoff_attach` with the saved `handoffId` (or the ID in the error message). Keep Chrome visible and accept the new connection prompt while the call is waiting. A virtualized chat may require scrolling back to the relevant turn. The bridge correlates a submitted `Bridge-Turn` with a reply marked `Bridge-Reply`. The reply’s final `handoff-result` block must open and close at the start of a line.

SQLite records the intent before sending. An attach may deliver a prepared, unsent intent. If a send was attempted and its acceptance is unknown, attach looks for the existing receipt. If `lifecycleStatus` is `uncertain`, inspect the original conversation before retrying to avoid sending the task twice.

Use `bridge_handoff_abort` for an intentional cancellation. It can cancel a recorded Gateway run or close a browser turn before submission. For a submitted browser turn, stop Robo in the chat UI if necessary. After reviewing the conversation, `localOnly: true` closes local browser tracking while the remote conversation continues.

## Git verification and publication

For a task that needs Git verification, configure a repository to fetch from with `gitContext.remoteUrlOrPath` or `gitContext.localRepoPath`. `bridge_verify_git` accepts a `handoffId` and a reachable `candidateRef`. It fetches into an isolated bare mirror without checking out candidate code, running hooks or fetching submodules. It checks the candidate’s ancestry and optional expected tree. `lockedPaths` are protected from changes after `pinnedSourceCommitSha` (or `pinnedBaseCommitSha` if no source commit was supplied), including changes reverted before the tip.

The initial `publisherOwner` determines who can be asked to publish. When omitted from the envelope, the bridge defaults to `remote_gated` (configurable via `defaultPublisherOwner` in `bridge-config.json` or `CLAWHANDOFF_DEFAULT_PUBLISHER_OWNER`).

| `publisherOwner` | Who acts |
| --- | --- |
| `remote_gated` (default) | The remote agent prepares the candidate with `allowManagedPublishStage: false` (including any contributor `Co-authored-by:` commit trailer in Stage 1). On `AUTHORIZE_REMOTE_PUBLISH`, call `bridge_handoff_continue` with `intent: "authorize_publish"`, the handoff ID and an authorization message. The bridge rechecks the verified commit before sending the authorization. The remote agent cooperates with this protocol using its existing permissions. |
| `none` | Use for a report or verification without publication. |
| `local` | Opt-in local publication: the local assistant publishes the verified candidate when authorized. To enforce a local-only boundary, use a remote worker without publishing credentials or tools. |

PR reconciliation requires an authenticated GitHub CLI (`gh`) with read access to the repository. The bridge checks an open PR’s exact head. Without a PR URL it requires a unique same-repository match. Verify the destination branch separately when it matters. If a publish might have succeeded, an empty search is insufficient to repeat it safely. Preflight can optionally search for rival PRs when given both `repoId` and `issueQuery`. An empty advisory list can also mean `gh` was unavailable.

## Test the loop locally

`pnpm test` exercises the bridge against temporary Git repositories and simulated browser, Gateway and GitHub responses.

For a test with a real local assistant and a simulated remote reviewer, run `node test/helpers/host-acceptance.mjs setup` from the built checkout. Open the printed workspace in your assistant, register the printed MCP configuration, give it the printed goal and let it run the smoke test. Then run the printed verification command. Success includes `"accepted": true`, one remote session and the recorded actions `CONTINUE_AUTONOMOUSLY` followed by `COMPLETE`. The test runs entirely against the fixture and requires no Team account.
