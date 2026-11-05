import type { ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnStdioProcess, terminateProcessTree } from "./process-spawn.js";
import { BridgeError, type CodexTargetConfig } from "./types.js";

export type CodexTurnObservation =
  | { state: "running" }
  | { state: "completed"; replyText: string }
  | { state: "failed"; errorMessage: string }
  | { state: "interrupted" }
  | { state: "not_found" };

interface TrackedCodexTurn {
  threadId: string;
  turnId: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  agentMessages: string[];
  errorMessage?: string;
  waiters: Set<() => void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractTurnAgentReply(turn: Record<string, unknown>): string {
  if (!Array.isArray(turn.items)) return "";
  const texts: string[] = [];
  for (const rawItem of turn.items) {
    const item = asRecord(rawItem);
    if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      texts.push(item.text);
    }
  }
  const withFence = [...texts].reverse().find((text) => /```handoff-result\s*[\s\S]*?```/i.test(text));
  return withFence ?? texts.join("\n\n").trim();
}

function normalizeCodexTurnStatus(rawStatus: unknown): TrackedCodexTurn["status"] {
  switch (rawStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "inProgress";
  }
}

export class CodexAppServerClient {
  private readonly target: CodexTargetConfig;
  private readonly timeoutMs: number;
  private child?: ChildProcess;
  private rl?: ReadlineInterface;
  private initPromise?: Promise<void>;
  private nextId = 1;
  private stderrTail = "";
  private readonly pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly loadedThreads = new Set<string>();
  private readonly turns = new Map<string, TrackedCodexTurn>();

  constructor(target: CodexTargetConfig) {
    this.target = target;
    this.timeoutMs = target.rpcTimeoutMs ?? 30_000;
  }

  async close(): Promise<void> {
    this.initPromise = undefined;
    this.loadedThreads.clear();
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pendingEntries) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError("TARGET_UNAVAILABLE", "Codex app-server client closed."));
    }
    for (const tracked of this.turns.values()) {
      for (const wake of tracked.waiters) wake();
      tracked.waiters.clear();
    }
    this.rl?.close();
    this.rl = undefined;
    const proc = this.child;
    this.child = undefined;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        // Ignore broken pipe on close.
      }
      await terminateProcessTree(proc);
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null && this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.spawnAndInitialize().catch((err) => {
      this.initPromise = undefined;
      throw err;
    });
    return this.initPromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    const command = this.target.command ?? "codex";
    const args = this.target.args ?? ["app-server", "--stdio"];
    this.stderrTail = "";
    this.loadedThreads.clear();

    let child: ChildProcess;
    try {
      child = spawnStdioProcess({
        command,
        args,
        cwd: this.target.cwd,
      });
    } catch (err) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Failed to spawn Codex app-server "${command}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4_096);
    });

    child.on("error", (err) => {
      this.handleDisconnect(
        new BridgeError(
          "TARGET_UNAVAILABLE",
          `Codex app-server "${command}" failed to start: ${err.message}`,
        ),
      );
    });

    child.on("close", (code, signal) => {
      const detail = this.stderrTail.trim() || `exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
      this.handleDisconnect(
        new BridgeError("TARGET_UNAVAILABLE", `Codex app-server exited unexpectedly: ${detail}`),
      );
    });

    if (!child.stdout || !child.stdin) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Codex app-server stdio streams are unavailable.");
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;
    rl.on("line", (line) => this.handleLine(line));

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "clawhandoff",
        title: "ClawHandoff Bridge",
        version: "0.2.0",
      },
      capabilities: {
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "item/commandExecution/outputDelta",
        ],
      },
    });
    this.sendNotification("initialized", {});
  }

  private handleDisconnect(error: BridgeError): void {
    this.initPromise = undefined;
    this.loadedThreads.clear();
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pendingEntries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const tracked of this.turns.values()) {
      if (tracked.status === "inProgress") {
        tracked.status = "failed";
        tracked.errorMessage = error.message;
      }
      for (const wake of tracked.waiters) wake();
      tracked.waiters.clear();
    }
  }

  private writeJsonLine(payload: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Codex app-server stdin is closed.");
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeJsonLine({ method, params });
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            "TARGET_UNAVAILABLE",
            `Codex app-server request "${method}" timed out after ${this.timeoutMs}ms.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeJsonLine({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private getOrCreateTurnTracker(threadId: string, turnId: string): TrackedCodexTurn {
    let tracked = this.turns.get(turnId);
    if (!tracked) {
      tracked = {
        threadId,
        turnId,
        status: "inProgress",
        agentMessages: [],
        waiters: new Set(),
      };
      this.turns.set(turnId, tracked);
    }
    return tracked;
  }

  private notifyTurnWaiters(tracked: TrackedCodexTurn): void {
    for (const wake of tracked.waiters) wake();
    tracked.waiters.clear();
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const msg = asRecord(parsed);
    if (!msg) return;

    // 1) Response to client-initiated request
    if (typeof msg.id === "number" && !("method" in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      const errObj = asRecord(msg.error);
      if (errObj) {
        const message = readString(errObj, "message") ?? JSON.stringify(errObj);
        if (/unauthorized|login|auth/i.test(message)) {
          pending.reject(
            new BridgeError("AUTH_LOGIN_REQUIRED", `Codex authentication required: ${message}`, "Run `codex login` or set OPENAI_API_KEY."),
          );
        } else {
          pending.reject(new BridgeError("TARGET_UNAVAILABLE", `Codex RPC error: ${message}`));
        }
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    // 2) Server-initiated JSON-RPC request (approvals, permissions, elicitations, time)
    if ((typeof msg.id === "number" || typeof msg.id === "string") && typeof msg.method === "string") {
      this.handleServerRequest(msg.id, msg.method, asRecord(msg.params));
      return;
    }

    // 3) Server-initiated event notifications
    if (typeof msg.method === "string") {
      this.handleNotification(msg.method, asRecord(msg.params));
    }
  }

  private handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown> | null,
  ): void {
    const autoAccept = (this.target.approvalPolicy ?? "never") === "never";
    try {
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        this.writeJsonLine({
          id,
          result: { decision: autoAccept ? "acceptForSession" : "decline" },
        });
        return;
      }
      if (method === "item/permissions/requestApproval") {
        const requested = asRecord(params?.permissions);
        this.writeJsonLine({
          id,
          result: {
            scope: "turn",
            permissions: autoAccept && requested ? requested : {},
          },
        });
        return;
      }
      if (method === "mcpServer/elicitation/request") {
        this.writeJsonLine({ id, result: { action: "decline", content: null } });
        return;
      }
      if (method === "item/tool/requestUserInput") {
        this.writeJsonLine({ id, result: { answers: {} } });
        return;
      }
      if (method === "currentTime/read") {
        this.writeJsonLine({ id, result: { currentTimeAt: Math.floor(Date.now() / 1_000) } });
        return;
      }
      this.writeJsonLine({
        id,
        error: { code: -32601, message: `Unsupported server request: ${method}` },
      });
    } catch {
      // Ignore write errors if connection already closed.
    }
  }

  private handleNotification(method: string, params: Record<string, unknown> | null): void {
    if (!params) return;
    if (method === "turn/started") {
      const turn = asRecord(params.turn);
      const turnId = readString(turn, "id");
      const threadId = readString(params, "threadId") ?? "";
      if (turnId) {
        this.getOrCreateTurnTracker(threadId, turnId);
      }
      return;
    }
    if (method === "item/completed") {
      const turnId = readString(params, "turnId");
      const threadId = readString(params, "threadId") ?? "";
      const item = asRecord(params.item);
      if (turnId && item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        const tracked = this.getOrCreateTurnTracker(threadId, turnId);
        tracked.agentMessages.push(item.text);
      }
      return;
    }
    if (method === "error") {
      const turnId = readString(params, "turnId");
      const threadId = readString(params, "threadId") ?? "";
      const errObj = asRecord(params.error);
      if (turnId && errObj) {
        const tracked = this.getOrCreateTurnTracker(threadId, turnId);
        tracked.errorMessage = readString(errObj, "message") ?? tracked.errorMessage;
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      const turnId = readString(turn, "id");
      const threadId = readString(params, "threadId") ?? "";
      if (!turnId || !turn) return;
      const tracked = this.getOrCreateTurnTracker(threadId, turnId);
      tracked.status = normalizeCodexTurnStatus(turn.status);
      const fallbackText = extractTurnAgentReply(turn);
      if (fallbackText && tracked.agentMessages.length === 0) {
        tracked.agentMessages.push(fallbackText);
      }
      const errObj = asRecord(turn.error);
      if (errObj) {
        tracked.errorMessage = readString(errObj, "message") ?? tracked.errorMessage;
      }
      this.notifyTurnWaiters(tracked);
    }
  }

  async preflight(): Promise<{ healthy: boolean; authReady: boolean; remediation?: string }> {
    await this.ensureConnected();
    try {
      const res = asRecord(await this.sendRequest("account/read", { refreshToken: false }));
      const requiresAuth = res?.requiresOpenaiAuth === true;
      const hasAccount = res?.account !== null && res?.account !== undefined;
      if (requiresAuth && !hasAccount && !process.env.OPENAI_API_KEY) {
        return {
          healthy: true,
          authReady: false,
          remediation: "Run `codex login` or set OPENAI_API_KEY before dispatching to this Codex target.",
        };
      }
    } catch (err) {
      if (err instanceof BridgeError && err.code === "AUTH_LOGIN_REQUIRED") {
        return { healthy: true, authReady: false, remediation: err.remediation ?? err.message };
      }
      // Custom/minimal app-server implementations may omit account/read; initialize already succeeded.
    }
    return { healthy: true, authReady: true };
  }

  async ensureThread(params: { threadId?: string; cwd?: string }): Promise<string> {
    await this.ensureConnected();
    const effectiveCwd = params.cwd ?? this.target.cwd;
    if (params.threadId) {
      if (this.loadedThreads.has(params.threadId)) {
        return params.threadId;
      }
      const res = asRecord(
        await this.sendRequest("thread/resume", {
          threadId: params.threadId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(this.target.model ? { model: this.target.model } : {}),
          approvalPolicy: this.target.approvalPolicy ?? "never",
          sandbox: this.target.sandbox ?? "workspace-write",
        }),
      );
      const thread = asRecord(res?.thread);
      const resumedId = readString(thread, "id") ?? params.threadId;
      this.loadedThreads.add(resumedId);
      return resumedId;
    }

    const res = asRecord(
      await this.sendRequest("thread/start", {
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(this.target.model ? { model: this.target.model } : {}),
        approvalPolicy: this.target.approvalPolicy ?? "never",
        sandbox: this.target.sandbox ?? "workspace-write",
        serviceName: "clawhandoff",
      }),
    );
    const thread = asRecord(res?.thread);
    const threadId = readString(thread, "id");
    if (!threadId) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Codex thread/start returned no thread.id.");
    }
    this.loadedThreads.add(threadId);
    return threadId;
  }

  async startTurn(params: {
    threadId: string;
    clientUserMessageId: string;
    promptText: string;
    cwd?: string;
  }): Promise<{ turnId: string }> {
    await this.ensureThread({ threadId: params.threadId, cwd: params.cwd });
    const effectiveCwd = params.cwd ?? this.target.cwd;
    const res = asRecord(
      await this.sendRequest("turn/start", {
        threadId: params.threadId,
        clientUserMessageId: params.clientUserMessageId,
        input: [{ type: "text", text: params.promptText }],
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(this.target.model ? { model: this.target.model } : {}),
        ...(this.target.effort ? { effort: this.target.effort } : {}),
        approvalPolicy: this.target.approvalPolicy ?? "never",
      }),
    );
    const turn = asRecord(res?.turn);
    const turnId = readString(turn, "id");
    if (!turnId) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Codex turn/start returned no turn.id.");
    }
    const tracked = this.getOrCreateTurnTracker(params.threadId, turnId);
    const initialStatus = normalizeCodexTurnStatus(turn?.status);
    if (initialStatus !== "inProgress") {
      tracked.status = initialStatus;
      const reply = turn ? extractTurnAgentReply(turn) : "";
      if (reply && tracked.agentMessages.length === 0) tracked.agentMessages.push(reply);
      const errObj = asRecord(turn?.error);
      if (errObj) tracked.errorMessage = readString(errObj, "message") ?? tracked.errorMessage;
    }
    return { turnId };
  }

  /** Reconcile a turn across process restarts using the persisted clientUserMessageId (`clientId`). */
  async findTurnByClientMessageId(params: {
    threadId: string;
    clientUserMessageId: string;
    cwd?: string;
  }): Promise<{ turnId: string; observation: CodexTurnObservation } | undefined> {
    await this.ensureConnected();
    const res = asRecord(
      await this.sendRequest("thread/read", {
        threadId: params.threadId,
        includeTurns: true,
      }),
    );
    const thread = asRecord(res?.thread);
    if (!Array.isArray(thread?.turns)) return undefined;
    for (const rawTurn of thread.turns) {
      const turn = asRecord(rawTurn);
      const turnId = readString(turn, "id");
      if (!turn || !turnId || !Array.isArray(turn.items)) continue;
      const matched = turn.items.some((rawItem) => {
        const item = asRecord(rawItem);
        return item?.type === "userMessage" && item.clientId === params.clientUserMessageId;
      });
      if (matched) {
        return { turnId, observation: this.observationFromPersistedTurn(turn) };
      }
    }
    return undefined;
  }

  private observationFromPersistedTurn(turn: Record<string, unknown>): CodexTurnObservation {
    const status = normalizeCodexTurnStatus(turn.status);
    if (status === "inProgress") return { state: "running" };
    if (status === "interrupted") return { state: "interrupted" };
    if (status === "failed") {
      const errObj = asRecord(turn.error);
      return {
        state: "failed",
        errorMessage: readString(errObj, "message") ?? "Codex turn failed.",
      };
    }
    return {
      state: "completed",
      replyText: extractTurnAgentReply(turn),
    };
  }

  private observationFromTracker(tracked: TrackedCodexTurn): CodexTurnObservation {
    if (tracked.status === "inProgress") return { state: "running" };
    if (tracked.status === "interrupted") return { state: "interrupted" };
    if (tracked.status === "failed") {
      return { state: "failed", errorMessage: tracked.errorMessage ?? "Codex turn failed." };
    }
    const withFence = [...tracked.agentMessages]
      .reverse()
      .find((text) => /```handoff-result\s*[\s\S]*?```/i.test(text));
    return {
      state: "completed",
      replyText: withFence ?? tracked.agentMessages.join("\n\n").trim(),
    };
  }

  async waitTurnSlice(params: {
    threadId: string;
    turnId: string;
    sliceMs: number;
    cwd?: string;
  }): Promise<CodexTurnObservation> {
    await this.ensureConnected();
    const tracked = this.turns.get(params.turnId);
    if (tracked) {
      if (tracked.status !== "inProgress") {
        return this.observationFromTracker(tracked);
      }
      await new Promise<void>((resolve) => {
        const onWake = () => {
          clearTimeout(timer);
          tracked.waiters.delete(onWake);
          resolve();
        };
        const timer = setTimeout(onWake, params.sliceMs);
        tracked.waiters.add(onWake);
      });
      return this.observationFromTracker(tracked);
    }

    // Reconnected after BridgeService restart: resume/read persisted rollout state.
    const deadline = Date.now() + params.sliceMs;
    for (;;) {
      const res = asRecord(
        await this.sendRequest("thread/read", {
          threadId: params.threadId,
          includeTurns: true,
        }),
      );
      const thread = asRecord(res?.thread);
      const turns = Array.isArray(thread?.turns) ? thread.turns.map(asRecord) : [];
      const matching = turns.find((turn) => readString(turn, "id") === params.turnId);
      if (!matching) return { state: "not_found" };
      const obs = this.observationFromPersistedTurn(matching);
      if (obs.state !== "running") return obs;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state: "running" };
      await delay(Math.min(400, remaining));
    }
  }

  async interruptTurn(threadId: string, turnId: string, cwd?: string): Promise<boolean> {
    await this.ensureThread({ threadId, cwd });
    try {
      await this.sendRequest("turn/interrupt", { threadId, turnId });
      return true;
    } catch {
      return false;
    }
  }
}
