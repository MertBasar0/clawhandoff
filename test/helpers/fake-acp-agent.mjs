import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const stateFile = process.argv[2];
if (!stateFile) {
  process.stderr.write("Missing stateFile argument\n");
  process.exit(1);
}

// Emit a non-JSON startup banner on stdout to ensure the ACP client ignores CLI wrapper lines.
process.stdout.write("Fake ACP Agent v1.0 starting over stdio...\n");

function loadState() {
  if (!existsSync(stateFile)) {
    return {
      sessions: {},
      queuedPrompts: [],
      permissionOutcomes: [],
      loadedSessions: [],
      cancelledSessions: [],
      setModes: [],
      setModels: [],
    };
  }
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function send(payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

let nextAgentReqId = 5000;
const pendingAgentRequests = new Map();
const activePromptsBySession = new Map();

function requestClient(method, params) {
  const id = nextAgentReqId++;
  return new Promise((resolve) => {
    pendingAgentRequests.set(id, resolve);
    send({ id, method, params });
  });
}

function runWorktreeGitAction(cwd, gitAction) {
  if (!gitAction || !cwd) return undefined;
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  if (gitAction.branch) {
    git(["checkout", "-B", gitAction.branch]);
  }
  if (gitAction.file && typeof gitAction.content === "string") {
    const targetPath = join(cwd, gitAction.file);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, gitAction.content, "utf8");
    git(["add", gitAction.file]);
    git([
      "-c",
      "user.name=ACP Worker",
      "-c",
      "user.email=acp@example.test",
      "commit",
      "-m",
      gitAction.commitMessage || "acp worktree commit",
    ]);
  }
  const headSha = git(["rev-parse", "HEAD"]);
  if (gitAction.pushRemote && gitAction.branch) {
    git(["push", "-f", gitAction.pushRemote, `HEAD:refs/heads/${gitAction.branch}`]);
  }
  return headSha;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  const msg = JSON.parse(trimmed);

  // Response to agent-initiated request (e.g. session/request_permission)
  if (msg.id !== undefined && !("method" in msg)) {
    const resolver = pendingAgentRequests.get(msg.id);
    if (resolver) {
      pendingAgentRequests.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  const { id, method, params = {} } = msg;

  // Notification: session/cancel has no JSON-RPC id
  if (id === undefined && method === "session/cancel") {
    const active = activePromptsBySession.get(params.sessionId);
    const state = loadState();
    state.cancelledSessions = [...(state.cancelledSessions ?? []), params.sessionId];
    saveState(state);
    if (active) {
      clearTimeout(active.timer);
      activePromptsBySession.delete(params.sessionId);
      send({ id: active.promptRequestId, result: { stopReason: "cancelled" } });
    }
    return;
  }

  if (id === undefined) {
    return;
  }

  const state = loadState();

  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
    });
    return;
  }

  if (method === "session/new") {
    const sessionId = `acp_sess_${Object.keys(state.sessions).length + 1}`;
    state.sessions[sessionId] = {
      sessionId,
      cwd: params.cwd,
      historyReplies: [],
    };
    saveState(state);
    send({ id, result: { sessionId } });
    return;
  }

  if (method === "session/load" || method === "session/resume") {
    const sess = state.sessions[params.sessionId];
    if (!sess) {
      send({ id, error: { code: -32602, message: `Unknown ACP session ${params.sessionId}` } });
      return;
    }
    if (params.cwd) sess.cwd = params.cwd;
    state.loadedSessions = [...(state.loadedSessions ?? []), params.sessionId];
    saveState(state);

    // Replay historical chunks during session/load to verify client replay suppression.
    for (const oldText of sess.historyReplies ?? []) {
      send({
        method: "session/update",
        params: {
          sessionId: sess.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[REPLAYED_HISTORY] ${oldText}` },
          },
        },
      });
    }
    send({ id, result: {} });
    return;
  }

  if (method === "session/set_mode") {
    state.setModes = [...(state.setModes ?? []), params];
    saveState(state);
    send({ id, result: {} });
    return;
  }

  if (method === "session/set_config_option" || method === "session/set_model") {
    state.setModels = [...(state.setModels ?? []), params];
    saveState(state);
    send({ id, result: {} });
    return;
  }

  if (method === "session/prompt") {
    const sess = state.sessions[params.sessionId];
    if (!sess) {
      send({ id, error: { code: -32602, message: `Unknown ACP session ${params.sessionId}` } });
      return;
    }
    const spec = state.queuedPrompts.shift() ?? {
      replyText: "Default ACP reply",
      delayMs: 20,
    };
    saveState(state);

    const runPrompt = async () => {
      activePromptsBySession.delete(sess.sessionId);

      if (spec.permissionRequests) {
        for (const perm of spec.permissionRequests) {
          const outcomeRes = await requestClient("session/request_permission", {
            sessionId: sess.sessionId,
            toolCall: {
              toolCallId: perm.toolCallId ?? "tc_1",
              kind: perm.kind,
              title: perm.title ?? `${perm.kind}: src/index.ts`,
            },
            options: [
              { optionId: "allow_always", name: "Allow Always", kind: "allow_always" },
              { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject Once", kind: "reject_once" },
            ],
          });
          const sPerm = loadState();
          sPerm.permissionOutcomes = [
            ...(sPerm.permissionOutcomes ?? []),
            { kind: perm.kind, outcome: outcomeRes?.outcome },
          ];
          saveState(sPerm);
        }
      }

      const headSha = runWorktreeGitAction(sess.cwd, spec.gitAction);
      const replyText =
        typeof spec.replyText === "string"
          ? spec.replyText.replaceAll("__WORKTREE_HEAD_SHA__", headSha ?? "")
          : "";

      // Stream reply in two chunks to exercise chunk concatenation
      const midpoint = Math.max(1, Math.floor(replyText.length / 2));
      for (const chunk of [replyText.slice(0, midpoint), replyText.slice(midpoint)]) {
        if (!chunk) continue;
        send({
          method: "session/update",
          params: {
            sessionId: sess.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            },
          },
        });
      }

      const sFinal = loadState();
      if (sFinal.sessions[sess.sessionId]) {
        sFinal.sessions[sess.sessionId].historyReplies.push(replyText);
      }
      saveState(sFinal);

      send({ id, result: { stopReason: "end_turn" } });
    };

    const delayMs = spec.delayMs ?? 20;
    const timer = setTimeout(() => {
      void runPrompt();
    }, delayMs);
    activePromptsBySession.set(sess.sessionId, { promptRequestId: id, timer });
    return;
  }

  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
