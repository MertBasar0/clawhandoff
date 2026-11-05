# clawhandoff architecture (RFC v0.2)

When an OpenClaw agent asks for proof that a build works on Windows, the local assistant runs the check and sends the result back to the same remote session. The bridge records which turn requested the evidence, verifies Git and pull request (PR) state, and tells the local assistant what to do next.

For setup and a first handoff, see the [quickstart](quickstart.md). This RFC covers the design decisions, the implemented v0.2 contract, and options deferred to a later phase. The [input schemas](https://github.com/MertBasar0/clawhandoff/blob/c210b9022aadbf9a6518ed8582095bab29402526/src/schema.ts) and [output types](https://github.com/MertBasar0/clawhandoff/blob/c210b9022aadbf9a6518ed8582095bab29402526/src/types.ts) define the MCP contract at the revision documented here.

## 1. Who owns the task?

The local assistant can use the developer's build tools and test environment. The remote OpenClaw agent can use its own workspace, source code, or managed publishing tools. For example, a remote Linux agent can ask the local assistant for evidence from a Windows build.

The local assistant first checks which commit is under test. If an existing test record covers that commit, it sends the record to the same remote session. If the check is missing, the assistant runs it within the user's authorization. If it finds a source defect, it verifies the fix separately. The user can leave the exchange of evidence to the assistants.

The connection starts on the developer's machine. The local bridge records the request, response, and next step. The remote agent has no direct access to local command execution. Before running remote code, the local assistant checks its origin and the user's authorization for the task. Browser permission prompts, an unverifiable PR publication, or an unresolved scope decision can still require human intervention.

## 2. Alternatives considered

The table describes the versions of OpenClaw and Codex evaluated when this RFC was written. Paths and line numbers refer to those external repositories at the time. [Section 6](#6-implemented-tools-and-acceptance-criteria) describes the bridge's own tools.

| Mechanism | Source at the time of evaluation | Design implications |
| --- | --- | --- |
| OpenClaw `beam` and `session-share` | `docs/plugins/beam.md`, `docs/plugins/session-share.md` | These mechanisms shared transcripts read-only or in one direction. They offered no task execution or continuation. |
| OpenClaw `extensions/mcp-relay` | `extensions/mcp-relay/src/operations.ts:254-478` | The relay could observe long runs through `reply.get` in 50-second windows. It was disabled by default on the shared server and carried raw chat. The handoff contract, Git object verification, publish gate, and autonomous follow-up loop had to be supplied elsewhere. |
| OpenClaw `@openclaw/codex` and `@openclaw/acpx` | `extensions/codex/README.md:23`, `extensions/acpx/skills/acp-router/SKILL.md:11-33` | Paired nodes supported listing and reading sessions. Only the machine hosting the Gateway could run `continue` and `archive`, so a remote Linux Gateway could not drive a local Windows agent. |
| Client `edgeAuth` with `trusted-proxy` | `docs/gateway/remote.md:162-195` | A `cloudflared access token` handled proxy authentication during the WebSocket upgrade. Deployment without a server change requires an existing Gateway that exposes `sessions.create`, `chat.send`, `agent.wait`, and `chat.history` to the user's role. The bridge's `bridge_preflight` checks health, identity access, and the agent list. Write RPC permissions need separate confirmation. |
| Codex `mcp-server` and `app-server` | `codex-rs/mcp-server/src/message_processor.rs:475`, `codex-rs/core/src/thread_manager.rs:1366`, `codex-rs/app-server/README.md:20-84` | In `codex mcp-server`, `codex-reply` looked up `threadId` only in the in-memory `self.threads` map. Restarting the process lost that mapping, and the interface was being deprecated. Phase 2 implements `transport: "codex"` over `codex app-server --stdio` (`thread/start`, `thread/resume`, `thread/read`, `turn/start` with `clientUserMessageId`, and `turn/interrupt`) alongside `transport: "a2a"` and `transport: "acp"`. |

## 3. Safety and correctness contracts

The design distinguishes instructions given to an agent, restrictions the bridge can enforce, violations it can detect, and actions it can recover after interruption.

### 3.1 Publishing authority and the single publisher

A publish request in a model-generated envelope does not grant permission. The local orchestrator checks the user's authorization, the target's permissions, and the task scope. The bridge rejects contradictory contract fields. Rules that depend on the remote agent's cooperation are advisory instructions. The bridge cannot authorize or intercept every tool call on the target.

Use `publisherOwner: "none"` for work that requires no PR. When `publisherOwner` is omitted, the bridge defaults to `"remote_gated"` (overridable via `defaultPublisherOwner` in bridge configuration or `CLAWHANDOFF_DEFAULT_PUBLISHER_OWNER`).

- **Managed remote publisher (`remote_gated`, default).** With `publisherOwner: "remote_gated"`, a managed remote bot publishes through the following cooperative two-stage process.

  1. **Prepare the candidate.** The initial request sets `allowManagedPublishStage` to `false`. The remote agent prepares the candidate (including any contributor `Co-authored-by:` commit trailer in Stage 1, before the commit SHA is locked), then reports its `candidateCommitSha` and a reachable `candidateRef`.
  2. **Verify the Git objects.** The bridge reads `observedHeadSha` and `observedTreeSha`. It checks ancestry against `pinnedBaseCommitSha`, checks locked paths, and compares the expected tree if one was provided.
  3. **Authorize publication.** After receiving `AUTHORIZE_REMOTE_PUBLISH`, the local assistant calls `bridge_handoff_continue` within the user's authorization, supplying `intent: "authorize_publish"` and a `message`. The bridge rechecks the same commit and open PR state before sending approval to the same remote session. If verification fails, it withholds the approval message and directs the assistant to correct or escalate the problem.

- **Local publisher (`local`, opt-in).** With `publisherOwner: "local"`, the remote agent reviews, tests, and prepares a candidate branch. Its instructions tell it to leave PR creation to the local publisher. The bridge verifies the candidate commit and the local publisher acts under the user's existing authorization. To technically prevent the remote agent from publishing, restrict its tools or credentials separately.

The remote publish gate depends on the agent respecting the first-stage instructions. Switching to a local `gh` publisher requires explicit user approval to change `publisherOwner`, because switching can bypass the remote service's review and authorization rules.

### 3.2 Durable turns and recovery

A 20-minute remote task can outlive its MCP call. The bridge persists each turn so the local assistant can return to the same run.

```text
bridge_handoff_start    Record handoffId and idempotencyKey in SQLite before sending.
           |
           v
        running         The remote run is in progress.
           |
           v
bridge_handoff_attach   Reconnect to or reconcile the same run.
           |
           v
        settled         The bridge has recorded this turn's reply.
          /   \
         /     \
  Resolvable blocker     Task complete or human decision required
  or evidence request               |
         |                          v
         v                  Report the result or ask for a decision.
bridge_handoff_continue
```

1. **Record intent before sending.** The bridge writes the `handoffId`, `idempotencyKey`, and bridge-owned remote session key to SQLite before the network call. It claims the right to send atomically. After a crash it must determine whether the previous send took effect before trying again.
2. **Reconcile uncertain delivery.** If a `runId` is recorded, attach observes that run. If acceptance is unknown, the bridge looks in the recorded session's history for the sent message and its associated run ID. Without a match, it returns `uncertain` and a concrete `ESCALATE_TO_HUMAN` reason. It neither resends the request nor starts a new session or an indefinite attach loop. A stored `idempotencyKey` alone cannot make a retry safe because the Gateway's deduplication cache may expire or disappear on restart.
3. **Account for cache hits and delayed cleanup.** In the OpenClaw source evaluated for the RFC, even a cached response could return `runStarted: false` (`src/gateway/server-methods/session-create-initial-turn.ts:99-108`). Archiving with `sessions.patch(archived: true)` deferred worktree cleanup to garbage collection (`src/gateway/server-methods/sessions-patch-archive.ts:424`). The bridge uses the recorded run ID and relevant message history when it sees `runStarted: false`. That flag alone is insufficient grounds to archive the session. If acceptance remains uncertain, a retry requires reconciliation against the authoritative state.
4. **Separate waiting from cancellation.** When `waitBudgetMs` expires, a run in progress can return `lifecycleStatus: "running"` with `POLL_ATTACH`. A send whose acceptance is unknown can return `uncertain`. The remote job continues after the wait expires. To stop a Gateway run, call `bridge_handoff_abort`. To stop a browser response, use the chat UI. For a browser handoff, `localOnly: true` ends only local tracking.
5. **Allow one active turn per handoff.** A second `bridge_handoff_continue` on the same `handoffId` fails with `BUSY_ACTIVE_TURN` while a turn is active or `uncertain`.
6. **Match the reply to the turn.** When reading history, the bridge matches the `runId` or finds the run tied to the exact outgoing message. The most recent assistant reply can belong to another turn, and the length of a windowed message list is not a durable sequence number.

### 3.3 Git integrity and untrusted candidates

**Pin references.** The local assistant first resolves branch names such as `origin/main` to exact commits. The bridge validates the 40-digit hexadecimal SHA values in the request and records them in SQLite.

**Check the tree and the history.** `expectedTreeSha === observedTreeSha` establishes that the committed Git tree objects match byte for byte. A tree match alone cannot establish whether the remote test used a clean working directory, installed the same dependencies, or changed a locked file in an intermediate commit and later restored it.

The lock baseline is `pinnedSourceCommitSha` when supplied, otherwise `pinnedBaseCommitSha`. The bridge checks the net difference from that baseline to the candidate and inspects **every intermediate commit**. Authorized local changes made before handoff remain valid, and changing a locked file and later restoring it after handoff still counts as a violation. The bridge checks PR base ancestry separately.

**Inspect untrusted objects before checkout.** Treat a branch pushed by a remote or shared agent as untrusted input. The bridge inspects objects without checking out files, in an isolated repository it manages separately from the user's working tree. It disables hooks for `git fetch --no-recurse-submodules` and `git diff-tree --no-ext-diff --no-textconv`, explicitly selects allowed transport protocols, and reads NUL-delimited filenames.

Checking out code and running tests cross a separate trust boundary. A local subagent that writes files or runs tests uses a separate `git worktree`. The user's uncommitted changes must never be silently stashed or overwritten.

If the PR URL is known, the bridge verifies the head commit of that open PR. Without a URL, there must be exactly one open PR matching the repository, source branch, and verified commit. The target branch name is outside the contract and must be checked separately.

## 4. How the local assistant resolves objections

Before the first task, give the local assistant the [autonomous handoff instructions](../skills/autonomous-handoff/SKILL.md). Clients that support MCP prompts can select `autonomous-handoff` with the target and task. In both cases the local assistant assesses the objection, runs the check, and calls the next tool. If the assistant stops, the bridge retains the record so work can resume with the saved `handoffId`.

| Robo's reply or the bridge's observation | Local assistant's next step |
| --- | --- |
| Robo asks for proof of a test that already ran. | Verify that the test record covers the relevant commit. Call `bridge_handoff_continue` on the same handoff with what the check establishes (`claim`) and where to verify it (`sourceRef`). |
| A test is missing or the code has a real defect. | Run the test or fix and verify the defect in isolation, within the user's authorization. If the new commit was pushed to an authorized branch, continue in the same session with `updatedSourceCommitSha` and `updatedSourceRemoteRef`. |
| A locked path changed or the candidate's Git tree differs from the expected tree. | Stop publication and report the difference. If authorized to fix it, prepare a compliant candidate from the pinned source commit. A later revert leaves the intermediate violation in the history. |
| The task needs sign-in, further permission, or a user decision about scope. | Identify the blocked action and the information or permission that would unblock it. If delivery is uncertain, reconcile it using the same session. |

The bridge stores the submitted `sourceRef` values. Rephrasing a claim while reusing the same reference does not count as new evidence. The local assistant verifies the content of that evidence. If the same blocker persists for two consecutive turns with neither a new commit nor a different evidence reference, or if the turn budget runs out, the bridge asks for human intervention. The default `maxAutonomousTurns` is 5, including the initial turn. On `COMPLETE`, the local assistant checks the user's acceptance criteria and reports the outcome.

## 5. Request and result envelopes

### 5.1 Request envelope (`bridge_handoff_start.envelope`)

```typescript
export interface HandoffEnvelopeV2 {
  schemaVersion: "0.2";
  requestId: string;          // Unique per task, unchanged on retry (1–128 characters)
  workspaceId: string;        // Repository or workspace identifier
  title: string;
  outcome: string;

  mode: "investigate" | "implement" | "verify_only" | "publish_unchanged";
  publisherOwner?: "none" | "local" | "remote_gated"; // Defaults to "remote_gated" (or config defaultPublisherOwner)

  gitContext: {
    repoId: string;                 // For example, "openclaw/openclaw"
    localRepoPath?: string;         // Local source repository the bridge can read
    remoteUrlOrPath?: string;       // Fetch source for candidate ref verification
    pinnedBaseCommitSha: string;    // Resolved 40-digit hexadecimal Git commit SHA
    pinnedSourceCommitSha?: string; // Reachable source commit sent with the handoff
    sourceRemoteRef?: string;       // Branch or ref the remote agent can fetch
    expectedTreeSha?: string;       // For verify_only or publish_unchanged, supply this or resolve it from the source commit
    lockedPaths?: string[];         // Protected after the source commit, including intermediate commits
  };

  requestedCapabilities: {
    allowCodeEdit: boolean;
    allowBranchPush: boolean;
    allowManagedPublishStage: boolean; // Initially false. Stage 2 requires a separate continue call.
  };

  /** Working instructions sent to the target agent that the bridge cannot enforce. */
  advisoryInstructions?: Array<{
    instruction: string;
    reason: string;
  }>;

  /** Preliminary findings backed by evidence references. */
  priorEvidence?: Array<{
    claim: string;
    sourceRef: string; // For example, a permanent CI job link, or a commit and file path
  }>;

  nonBindingHints?: string[];
  acceptanceCriteria: string[];
}
```

If `mode === "publish_unchanged"` and `requestedCapabilities.allowCodeEdit === true`, the bridge returns `INVALID_CONTRACT_CONFLICT`. It does not silently rewrite the request.

### 5.2 Result envelope (`HandoffResultEnvelopeV2`)

Parse the text in a successful handoff call's `content` array as JSON. The `reported` section contains the remote agent's claims. The `observed` section contains facts the bridge checked independently. A `settled` turn has a recorded reply. The local assistant must still check the task's acceptance criteria.

```typescript
export interface HandoffResultEnvelopeV2 {
  schemaVersion: "0.2";
  handoffId: string;
  targetId: string;
  remoteSessionKey?: string;
  remoteSessionUrl?: string;
  turnNumber: number;
  runId: string; // "unassigned" until the run ID is known

  /** Current lifecycle state. */
  lifecycleStatus: "running" | "settled" | "uncertain" | "aborted" | "failed";

  /** Claims made by the target agent. Treat them as unverified. */
  reported?: {
    disposition: "completed" | "needs_evidence" | "blocked" | "ready_for_publish_gate";
    candidateCommitSha?: string;
    candidateRef?: string;
    prUrl?: string;
    summaryDelta: string;
    blockers: string[];
    claimedChecks: Array<{ command: string; exitCode?: number; environment?: string }>;
  };

  /** Facts the bridge verified using Git objects, RPC state, and GitHub. */
  observed: {
    reachableRefVerified: boolean;
    observedHeadSha?: string;
    observedTreeSha?: string;
    baseIsAncestor?: boolean;
    treeMatchesExpected?: boolean;
    lockedPathsClean?: boolean;
    violatedPaths?: string[];
    inspectedCommitCount?: number;
    verificationNotes?: string[];
    reconciledPrState: "none" | "open_verified" | "uncertain_in_flight";
    reconciledPrUrl?: string;
  };

  /** Next step for the local orchestrator. */
  orchestratorDirective: {
    action:
      | "POLL_ATTACH"               // The run is still in progress.
      | "CONTINUE_AUTONOMOUSLY"     // Answer or resolve the in-scope blocker with evidence and continue.
      | "AUTHORIZE_REMOTE_PUBLISH"  // Candidate verified. Send stage 2 publish authorization.
      | "PUBLISH_LOCALLY"           // Verification complete. The local owner may publish.
      | "COMPLETE"                  // The local agent presents evidence of acceptance.
      | "ESCALATE_TO_HUMAN";        // Decision exceeds authority, uncertainty persists, or progress has stalled.
    reason: string;
    remainingTurnBudget: number;
  };
}
```

## 6. Implemented tools and acceptance criteria

### 6.1 Implemented transports and recovery limits

`clawhandoff` supports five target transports under a single SQLite write-ahead ledger, checkout-free Git verifier, and single-publisher gate. If delivery or publication is uncertain, the bridge keeps the state visible so the caller can reconcile it before taking an action that could duplicate the work.

- **Gateway (`transport: "gateway"`).** Uses the remote shared `robo` Gateway or a local OpenClaw Gateway (`sessions.create`, `chat.send`, `agent.wait`, `chat.history`, and `chat.abort`).
- **Browser (`transport: "browser"`).** Uses one open, signed-in Control UI chat tab on the operator's machine via `chrome-devtools-mcp`. It uses the accessibility tree and a read-only DOM projection and needs neither device pairing nor a CLI token. Each request starts with `Bridge-Turn: <idempotencyKey>`, and the bridge reads the final unindented `handoff-result` block after `Bridge-Reply: <idempotencyKey>`. SQLite rejects a second concurrent handoff for the same `sessionUrl`.
- **Agent2Agent (`transport: "a2a"`).** Discovers the remote Agent Card (`/.well-known/agent-card.json` with `/.well-known/agent.json` fallback) and speaks A2A v1.0 (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask` with `A2A-Version: 1.0`) and A2A v0.3 (`message/send`, `tasks/get`, `tasks/cancel`). Multi-turn continuations preserve `contextId`; `TASK_STATE_INPUT_REQUIRED` routes remote questions into `CONTINUE_AUTONOMOUSLY`; crash recovery queries `ListTasks` for the exact user `messageId`.
- **Codex (`transport: "codex"`).** Drives `codex app-server --stdio` (`initialize` / `initialized`, `account/read`, `thread/start`, `thread/resume`, `thread/read(includeTurns: true)`, `turn/start`, and `turn/interrupt`). Passing `clientUserMessageId` (`turn.idempotencyKey`) persists `clientId` on the `userMessage` item so interrupted turns reconcile across restarts without duplicate execution. Supports isolated detached Git worktrees via `worktreeName`.
- **Agent Client Protocol (`transport: "acp"`).** Drives any ACP v1 stdio agent (built-in presets for `claude`, `gemini`, `cursor`, `copilot`, `codex`, `opencode`, `pi`, `droid`, `kimi`, `kiro`, `qwen`, `openclaw`, or custom `command`) using `initialize`, `session/new`, `session/resume` / `session/load` (suppressing replayed history chunks), `session/prompt`, `session/request_permission` policy handling, `session/cancel` notifications, and isolated detached Git worktrees via `worktreeName`.

**Publication recovery.** Local takeover requires work pushed to a reachable Git reference. Unpushed files in a remote worktree are outside the phase 1 recovery scope. If remote publication is `uncertain_in_flight`, the bridge withholds new publish authorization. An empty PR search alone cannot resolve the uncertainty. An open PR must match the exact candidate commit, even if its body contains the task marker. The publishing owner writes the PR text and checks it for secrets. Phase 1 provides no general-purpose text sanitizer.

| MCP tool | What it does |
| --- | --- |
| `bridge_preflight` | Checks connectivity, identity access, and the agent list for Gateway targets. For browser targets, `browserReady` indicates that the bridge found the intended tab and composer. An optional PR search is advisory for either transport. |
| `bridge_handoff_start` | Records the task and its pinned Git commits in SQLite and returns a durable `handoffId`. A Gateway handoff opens a dedicated session. A browser handoff uses the configured chat. If the run outlasts `waitBudgetMs`, the call can return `lifecycleStatus: "running"`. |
| `bridge_handoff_attach` | Resumes the saved handoff after interruption, restart, or wait expiry. It can send a prepared message for the first time. If a send was attempted, attach looks for its receipt or follows the recorded run. If it cannot establish delivery, it reports the uncertainty. |
| `bridge_handoff_continue` | Requires the same `handoffId`, a `message`, and an `intent`. Use `counter_evidence_or_followup` to submit evidence or newly verified Git information. Use `authorize_publish` to send separate approval for the verified candidate. |
| `bridge_verify_git` | Inspects an isolated repository without checkout. It checks ancestry against `pinnedBaseCommitSha`, verifies `observedHeadSha` and `observedTreeSha`, and checks `lockedPaths` in intermediate commits after the source commit. |
| `bridge_handoff_abort` | Stops a recorded Gateway run or cancels a browser turn before submission. To stop a submitted browser response, use the chat UI. After inspecting the chat, use `localOnly: true` to close local tracking. Ending a wait alone leaves the run active. |

### 6.2 Phase 1 acceptance tests and success metrics

The automated tests use temporary Git repositories and simulated Gateway and GitHub responses. They exercise state transitions, transport behavior, and decision logic. Real Claude or Codex reasoning and permissions on a live Gateway require separate evidence.

**Live local assistant test.** Choose a task in an isolated repository that requires no publication, and load the handoff skill into the local assistant. Have Robo ask for missing proof of a locally runnable check on a pinned commit. The local assistant must run the actual check and send a new `evidenceRefs.sourceRef` tied to that commit on the same `handoffId`. Robo must accept the evidence and complete the task without a human relaying messages. A second, distinct request for evidence on the same commit must also count as progress. Retain the actual command output together with the handoff and reply record from the same session.

**Crash and reconnect test.** Stop and restart the bridge after it records the remote `runId`. Use `bridge_handoff_attach(handoffId)` to retrieve the result of that same run. Separately, simulate losing the send response. If acceptance cannot be reconciled, expect a visible `uncertain` outcome and zero new sends. Inspect existing Gateway state before attempting a retry.

| Measure | Target |
| --- | --- |
| Human interventions per task, excluding initiation and final approval | 0 |
| Jobs or PRs lost or duplicated after interruption or timeout | 0 |
| Published commits that exactly match the verified `observedHeadSha` | 100% |
