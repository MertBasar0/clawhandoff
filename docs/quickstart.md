# Make your first handoff in an existing Robo chat

Use this guide to have your local assistant hand an investigation to Robo and answer a request for evidence in **the same chat**. For example, if Robo asks for a Windows test, the local assistant can run it in an authorized environment, check which commit it tested, and send the result back. The bridge records each turn. The local assistant owns the task until the evidence meets the acceptance criteria or it needs help.

The example below investigates a specific commit and requires no code changes or pull request. To start a separate Gateway session, see the [README](../README.md). For the handoff protocol and publishing rules, see the [design RFC](RFC-v0.2.md).

## 1. Build the bridge

Install Node.js 22.13 or later, pnpm, and Git 2.38 or later in the environment where your local assistant runs. If you already have a checkout, start with the install command in the repository root.

```sh
git clone https://github.com/MertBasar0/clawhandoff.git
cd clawhandoff
pnpm install --frozen-lockfile
pnpm run build
```

The build produces `dist/cli.js`. To try the full loop without a Team account, run `node test/helpers/host-acceptance.mjs setup` from the repository root. Open the printed `workspace` in your local assistant, register the server from `mcpServer`, and give the assistant the printed `goal`. Once it finishes, run the command and arguments in the `verify` array. Look for `accepted: true`, `sessions: 1`, and a sequence of actions starting with `CONTINUE_AUTONOMOUSLY` and ending with `COMPLETE`. This exercise uses Git and SQLite with a simulated remote agent.

## 2. Connect an existing Robo chat

1. Open the chat in **a single tab** in the Chrome profile signed in to Team. Leave the message box empty and copy the full chat URL from the address bar.
2. In Chrome, enable remote debugging at `chrome://inspect/#remote-debugging`. Chrome may ask you to approve a new connection. The bridge uses your signed-in browser session, and its messages appear in the Team chat history. [Chrome connection guide](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
3. Locate the Chrome DevTools MCP executable on the system running Chrome. The bridge relies on support for page IDs and structured output. The project has tested version `1.11.0`. [Chrome DevTools MCP setup](https://github.com/ChromeDevTools/chrome-devtools-mcp)

Save the following configuration as `bridge.json`. On Linux or WSL, you can create the directory with `mkdir -p ~/.config/clawhandoff` and save the file there. Replace `sessionUrl` with the chat URL you copied and `command` with the absolute path to your executable. In this example, `robo-web` is the name your local assistant uses for the target and `roboclaw` is the agent ID in the chat URL.

```json
{
  "targets": {
    "robo-web": {
      "targetId": "robo-web",
      "transport": "browser",
      "agentId": "roboclaw",
      "sessionUrl": "https://team.example/chat/roboclaw/example-session",
      "browserMcp": {
        "command": "/absolute/path/to/chrome-devtools-mcp",
        "args": ["--no-usage-statistics", "--no-performance-crux"]
      }
    }
  }
}
```

- **Chrome on Windows, bridge in WSL.** Set `browserMcp.command` to the WSL path to Windows `node.exe`. Add the Windows path to the installed Chrome DevTools MCP entry file as the first argument, before the flags. Use paths in the bridge's own environment for `dist/cli.js` and `bridge.json`.
- **Custom Control UI path.** If your Control UI is mounted at `/dashboard` and the URL looks like `/dashboard/chat/roboclaw/topic`, add `"basePath": "/dashboard"` to the browser target. If the URL is ambiguous and the UI is mounted at the root, use `"basePath": "/"`.

Register a **stdio** MCP server named `clawhandoff` in your local assistant. Use the following `command` and `args` in your client's configuration format, replacing all three paths with absolute paths. Your assistant uses these settings to start the bridge, which reads the target from `bridge.json`.

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/clawhandoff/dist/cli.js",
    "--config",
    "/absolute/path/to/bridge.json"
  ]
}
```

With Codex CLI on Linux or WSL, you can register the server from the repository root with this command if you saved the configuration in `~/.config/clawhandoff`.

```sh
codex mcp add clawhandoff -- "$(node -p 'process.execPath')" "$PWD/dist/cli.js" --config "$HOME/.config/clawhandoff/bridge.json"
```

Confirm that your assistant can see the `bridge_preflight` tool. Before the first handoff, have it read the [local orchestration instructions](../skills/autonomous-handoff/SKILL.md). In clients that support MCP prompts, you can also open `autonomous-handoff` with the target name and task.

## 3. Check the connection and start the handoff

Ask the local assistant to call `bridge_preflight` with the target name.

```json
{"targetId": "robo-web"}
```

Look for `browserReady: true`, which means the bridge can read the selected chat. A browser target normally reports `gatewayHealthy: false`. The next tool, `bridge_handoff_start`, **sends a message to the live chat**. Use the following arguments to ask Robo why a success report from a previous turn cannot complete the current task.

```json
{
  "targetId": "robo-web",
  "envelope": {
    "schemaVersion": "0.2",
    "requestId": "browser-receipt-review-001",
    "workspaceId": "bridge-docs-example",
    "title": "Investigate stale success reports",
    "outcome": "Use the source at the pinned commit to explain why a success report from an earlier turn cannot complete the current task.",
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
    "acceptanceCriteria": ["Show how the source ties the result block to the current turn marker."]
  }
}
```

For your own task, use `git rev-parse HEAD` to get the full 40-character commit SHA. Choose a new `requestId` for each new task. To retry the same start request, keep its ID and contents unchanged. Save the **`handoffId`** from the response for every subsequent call on this task.

## 4. Answer a request for evidence in the same chat

The bridge returns the next action in `orchestratorDirective.action`.

| Action | What the local assistant does next |
| --- | --- |
| `POLL_ATTACH` | Call `bridge_handoff_attach` with the same `handoffId`. The remote work continues if the wait times out. |
| `CONTINUE_AUTONOMOUSLY` | Read Robo's objection in `reported.blockers`. Check it against the pinned commit and available evidence. Run an authorized test if needed, then send the result with `bridge_handoff_continue`. |
| `COMPLETE` | Check the evidence against the acceptance criteria before reporting the outcome. `reported` records Robo's claims. `observed` records what the bridge could independently verify from Git and the pull request. |
| `ESCALATE_TO_HUMAN` | Check the reason, such as uncertain delivery, missing permission, or an exhausted turn budget. If delivery is uncertain, compare the saved turn with the chat history first. |

If Robo asks what prevents an earlier success report from completing this turn, inspect both the turn marker check and the result parser at the pinned commit.

```sh
git grep -n -E -A 8 'function (browserReplySection|terminalBrowserResultJson)|replySection\(raw' c210b9022aadbf9a6518ed8582095bab29402526 -- src/browser-turn.ts
```

If that source answers the objection, call `bridge_handoff_continue` with the evidence below. Replace `HANDOFF_ID` with the value returned by `bridge_handoff_start`. If Robo needs runtime evidence, include the actual test result and a reference to that run.

```json
{
  "handoffId": "HANDOFF_ID",
  "intent": "counter_evidence_or_followup",
  "message": "A success report from the earlier turn carries the wrong reply marker. I checked how the bridge selects this turn's reply and reads its result.",
  "evidenceRefs": [{
    "claim": "The browser passes the current turn's Bridge-Reply marker to browserReplySection. The function selects text starting at that marker and rejects the reply as ambiguous if another marker follows. terminalBrowserResultJson reads a handoff-result block only at the end of the selected reply.",
    "sourceRef": "https://github.com/MertBasar0/clawhandoff/blob/c210b9022aadbf9a6518ed8582095bab29402526/src/browser-turn.ts#L34-L113"
  }]
}
```

## Recover an interrupted connection

If Chrome's permission prompt expires, keep the target chat tab open. If the error or a previous response includes a `handoffId`, call `bridge_handoff_attach` with **that same ID** and approve the new Chrome prompt.

```json
{"handoffId": "HANDOFF_ID", "waitBudgetMs": 30000}
```

Attaching can send a prepared message for the first time. If delivery is uncertain, the bridge looks for the turn marker in the chat history. If you see `BUSY_ACTIVE_TURN`, check for a draft or a Robo reply in progress. Leave the user's draft intact and attach to the existing handoff when the chat is ready. Keep the same `dataDir` when reconnecting so the bridge can find its saved records.

Confirm receipt from Robo's reply and check CI status in the corresponding GitHub Actions run. The connected GitHub account and Robo's tools may have different permissions. This example explicitly sets `publisherOwner: "none"` and ends with the investigation. When `publisherOwner` is omitted, the bridge defaults to `"remote_gated"` (two-stage managed remote publication); see when to use `"remote_gated"`, `"local"`, or `"none"` in the [local orchestration instructions](../skills/autonomous-handoff/SKILL.md).
