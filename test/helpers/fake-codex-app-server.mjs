import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const stateFile = process.argv[2];
if (!stateFile) {
  process.stderr.write("Missing stateFile argument\n");
  process.exit(1);
}

function loadState() {
  if (!existsSync(stateFile)) {
    return {
      requiresOpenaiAuth: false,
      account: { type: "apiKey" },
      threads: {},
      queuedReplies: [],
      approvalsReceived: [],
      interruptedTurns: [],
      startTurnCount: 0,
    };
  }
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let nextServerReqId = 9000;
const pendingServerRequests = new Map();
const activeTurnTimers = new Map();

function requestClient(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
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
      "user.name=Codex Worker",
      "-c",
      "user.email=codex@example.test",
      "commit",
      "-m",
      gitAction.commitMessage || "codex worktree commit",
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

  if (msg.id !== undefined && !("method" in msg)) {
    const resolver = pendingServerRequests.get(msg.id);
    if (resolver) {
      pendingServerRequests.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  if (msg.id === undefined && typeof msg.method === "string") {
    return;
  }

  const { id, method, params = {} } = msg;
  const state = loadState();

  if (method === "initialize") {
    send({ id, result: { userAgent: "fake-codex-app-server/0.2.0" } });
    return;
  }

  if (method === "account/read") {
    send({
      id,
      result: {
        requiresOpenaiAuth: Boolean(state.requiresOpenaiAuth),
        account: state.account ?? null,
      },
    });
    return;
  }

  if (method === "thread/start") {
    const threadId = `thr_${Object.keys(state.threads).length + 1}`;
    const thread = {
      id: threadId,
      cwd: params.cwd ?? process.cwd(),
      model: params.model ?? "gpt-5.4",
      turns: [],
    };
    state.threads[threadId] = thread;
    saveState(state);
    send({ id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }

  if (method === "thread/resume") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      send({ id, error: { code: -32602, message: `Unknown thread ${params.threadId}` } });
      return;
    }
    if (params.cwd) thread.cwd = params.cwd;
    saveState(state);
    send({ id, result: { thread } });
    return;
  }

  if (method === "thread/read") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      send({ id, error: { code: -32602, message: `Unknown thread ${params.threadId}` } });
      return;
    }
    send({
      id,
      result: {
        thread: params.includeTurns ? thread : { ...thread, turns: [] },
      },
    });
    return;
  }

  if (method === "turn/interrupt") {
    const timerInfo = activeTurnTimers.get(params.turnId);
    if (timerInfo) {
      clearTimeout(timerInfo.timer);
      activeTurnTimers.delete(params.turnId);
    }
    const latest = loadState();
    const thread = latest.threads[params.threadId];
    const turn = thread?.turns?.find((t) => t.id === params.turnId);
    if (!turn) {
      send({ id, error: { code: -32602, message: `Unknown turn ${params.turnId}` } });
      return;
    }
    turn.status = "interrupted";
    latest.interruptedTurns = [...(latest.interruptedTurns ?? []), params.turnId];
    saveState(latest);
    send({ id, result: {} });
    send({
      method: "turn/completed",
      params: { threadId: params.threadId, turn },
    });
    return;
  }

  if (method === "turn/start") {
    const thread = state.threads[params.threadId];
    if (!thread) {
      send({ id, error: { code: -32602, message: `Unknown thread ${params.threadId}` } });
      return;
    }
    state.startTurnCount = (state.startTurnCount ?? 0) + 1;
    const spec = state.queuedReplies.shift() ?? {
      replyText: "Default reply",
      delayMs: 10,
    };
    const turnId = `codex_turn_${state.startTurnCount}`;
    const userItem = {
      type: "userMessage",
      id: `item_user_${state.startTurnCount}`,
      clientId: params.clientUserMessageId ?? null,
      content: params.input ?? [],
    };
    const turn = {
      id: turnId,
      status: "inProgress",
      items: [userItem],
      error: null,
    };
    thread.turns.push(turn);
    saveState(state);

    if (!spec.dropTurnStartResponse) {
      send({ id, result: { turn } });
    }
    send({ method: "turn/started", params: { threadId: thread.id, turn } });

    const finishTurn = async () => {
      activeTurnTimers.delete(turnId);
      if (spec.requestCommandApproval) {
        const approval = await requestClient("item/commandExecution/requestApproval", {
          threadId: thread.id,
          turnId,
          itemId: `cmd_${turnId}`,
          command: "pnpm test",
        });
        const sAfterApproval = loadState();
        sAfterApproval.approvalsReceived = [
          ...(sAfterApproval.approvalsReceived ?? []),
          approval,
        ];
        saveState(sAfterApproval);
      }

      const effectiveCwd = params.cwd ?? thread.cwd;
      const actionHeadSha = runWorktreeGitAction(effectiveCwd, spec.gitAction);
      let currentHead = actionHeadSha ?? "";
      if (!currentHead && effectiveCwd && spec.replyText?.includes("__WORKTREE_HEAD_SHA__")) {
        try {
          currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: effectiveCwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        } catch {
          currentHead = "";
        }
      }
      if (spec.writeGhState && spec.ghStateFile) {
        const ghPayload = JSON.parse(
          JSON.stringify(spec.writeGhState).replaceAll("__WORKTREE_HEAD_SHA__", currentHead),
        );
        writeFileSync(spec.ghStateFile, JSON.stringify(ghPayload, null, 2), "utf8");
      }

      const sFinal = loadState();
      const tRef = sFinal.threads[thread.id]?.turns?.find((t) => t.id === turnId);
      if (!tRef || tRef.status === "interrupted") return;

      const replyText =
        typeof spec.replyText === "string"
          ? spec.replyText.replaceAll("__WORKTREE_HEAD_SHA__", currentHead)
          : "";

      const agentItem = {
        type: "agentMessage",
        id: `item_agent_${turnId}`,
        text: replyText,
      };
      tRef.items.push(agentItem);
      tRef.status = spec.failMessage ? "failed" : "completed";
      if (spec.failMessage) {
        tRef.error = { message: spec.failMessage };
      }
      saveState(sFinal);

      if (!spec.dropTurnStartResponse) {
        send({
          method: "item/completed",
          params: { threadId: thread.id, turnId, item: agentItem },
        });
        send({
          method: "turn/completed",
          params: { threadId: thread.id, turn: tRef },
        });
      }
    };

    const delayMs = spec.delayMs ?? 20;
    const timer = setTimeout(() => {
      void finishTurn();
    }, delayMs);
    activeTurnTimers.set(turnId, { timer });
    return;
  }

  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
