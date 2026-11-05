import type { ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnStdioProcess, terminateProcessTree } from "./process-spawn.js";
import { BridgeError, type AcpTargetConfig } from "./types.js";

const ACP_AGENT_ARGV_REGISTRY: Record<string, readonly string[]> = {
  pi: ["npx", "-y", "pi-acp@^0.0.31"],
  openclaw: ["openclaw", "acp"],
  codex: ["npx", "-y", "@agentclientprotocol/codex-acp@^1.1.5"],
  claude: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@^0.60.0"],
  gemini: ["gemini", "--acp"],
  cursor: ["cursor-agent", "acp"],
  copilot: ["copilot", "--acp", "--stdio"],
  droid: ["droid", "exec", "--output-format", "acp"],
  "fast-agent": ["uvx", "fast-agent-mcp", "acp"],
  iflow: ["iflow", "--experimental-acp"],
  kilocode: ["npx", "-y", "@kilocode/cli", "acp"],
  kimi: ["kimi", "acp"],
  kiro: ["kiro-cli-chat", "acp"],
  mux: ["npx", "-y", "mux@^0.28.0", "acp"],
  opencode: ["npx", "-y", "opencode-ai", "acp"],
  qoder: ["qodercli", "--acp"],
  qwen: ["qwen", "--acp"],
  trae: ["traecli", "acp", "serve"],
  zeroclaw: ["zeroclaw", "acp"],
};

export type AcpPromptObservation =
  | { state: "running" }
  | { state: "completed"; replyText: string }
  | { state: "cancelled" }
  | { state: "failed"; errorMessage: string }
  | { state: "not_found" };

interface TrackedAcpPrompt {
  runId: string;
  sessionId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  chunks: string[];
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

export function resolveAcpLaunchCommand(target: AcpTargetConfig): {
  agentLabel: string;
  command: string;
  args: string[];
} {
  if (target.command) {
    return {
      agentLabel: target.agent ?? target.command,
      command: target.command,
      args: [...(target.args ?? [])],
    };
  }
  const normalized = (target.agent ?? "").trim().toLowerCase();
  const preset = ACP_AGENT_ARGV_REGISTRY[normalized];
  if (preset) {
    return {
      agentLabel: normalized,
      command: preset[0]!,
      args: [...preset.slice(1), ...(target.args ?? [])],
    };
  }
  if (!normalized) {
    throw new BridgeError("INVALID_INPUT", `ACP target "${target.targetId}" has neither agent nor command configured.`);
  }
  return {
    agentLabel: normalized,
    command: normalized,
    args: [...(target.args ?? [])],
  };
}

function isReadOnlyToolKind(kind: string | undefined, title: string | undefined): boolean {
  const k = kind?.toLowerCase();
  if (k === "read" || k === "search" || k === "think") return true;
  if (!k && title) {
    const head = title.split(/[:\s]/, 1)[0]?.toLowerCase() ?? "";
    if (["read", "cat", "search", "find", "grep"].some((w) => head.includes(w))) {
      return true;
    }
  }
  return false;
}

export class AcpSessionClient {
  private readonly target: AcpTargetConfig;
  private readonly timeoutMs: number;
  private child?: ChildProcess;
  private rl?: ReadlineInterface;
  private initPromise?: Promise<void>;
  private nextId = 1;
  private stderrTail = "";
  private supportsLoadSession = false;
  private supportsResumeSession = false;
  private suppressUpdatesUntilSessionReady = false;
  private readonly activeSessions = new Set<string>();
  private readonly activeRunBySession = new Map<string, TrackedAcpPrompt>();
  private readonly runs = new Map<string, TrackedAcpPrompt>();
  private readonly pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(target: AcpTargetConfig) {
    this.target = target;
    this.timeoutMs = target.rpcTimeoutMs ?? 30_000;
  }

  async close(): Promise<void> {
    this.initPromise = undefined;
    this.activeSessions.clear();
    this.activeRunBySession.clear();
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pendingEntries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new BridgeError("TARGET_UNAVAILABLE", "ACP client closed."));
    }
    for (const run of this.runs.values()) {
      for (const wake of run.waiters) wake();
      run.waiters.clear();
    }
    this.rl?.close();
    this.rl = undefined;
    const proc = this.child;
    this.child = undefined;
    if (proc) {
      try {
        proc.stdin?.end();
      } catch {
        // Ignore broken pipe.
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
    const launch = resolveAcpLaunchCommand(this.target);
    this.stderrTail = "";
    this.activeSessions.clear();
    this.supportsLoadSession = false;
    this.supportsResumeSession = false;

    let child: ChildProcess;
    try {
      child = spawnStdioProcess({
        command: launch.command,
        args: launch.args,
        cwd: this.target.cwd,
      });
    } catch (err) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Failed to spawn ACP agent "${launch.agentLabel}": ${err instanceof Error ? err.message : String(err)}`,
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
          `ACP agent "${launch.agentLabel}" failed to start: ${err.message}`,
        ),
      );
    });

    child.on("close", (code, signal) => {
      const detail = this.stderrTail.trim() || `exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`;
      this.handleDisconnect(
        new BridgeError("TARGET_UNAVAILABLE", `ACP agent "${launch.agentLabel}" exited: ${detail}`),
      );
    });

    if (!child.stdout || !child.stdin) {
      throw new BridgeError("TARGET_UNAVAILABLE", `ACP agent "${launch.agentLabel}" stdio streams are unavailable.`);
    }

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;
    rl.on("line", (line) => this.handleLine(line));

    const initRes = asRecord(
      await this.sendRequest(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: {
            name: "clawhandoff",
            version: "0.2.0",
          },
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
            terminal: false,
          },
        },
        this.timeoutMs,
      ),
    );

    const agentCaps = asRecord(initRes?.agentCapabilities);
    this.supportsLoadSession = agentCaps?.loadSession === true;
    const sessionCaps = asRecord(agentCaps?.sessionCapabilities);
    this.supportsResumeSession = Boolean(sessionCaps && "resume" in sessionCaps && sessionCaps.resume);
  }

  private handleDisconnect(error: BridgeError): void {
    this.initPromise = undefined;
    this.activeSessions.clear();
    this.activeRunBySession.clear();
    const pendingEntries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pendingEntries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    for (const run of this.runs.values()) {
      if (run.status === "running") {
        run.status = "failed";
        run.errorMessage = error.message;
      }
      for (const wake of run.waiters) wake();
      run.waiters.clear();
    }
  }

  private writeJsonLine(payload: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new BridgeError("TARGET_UNAVAILABLE", "ACP agent stdin is closed.");
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeJsonLine({ method, params });
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new BridgeError(
                  "TARGET_UNAVAILABLE",
                  `ACP request "${method}" timed out after ${timeoutMs}ms.`,
                ),
              );
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeJsonLine({ id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private wakeRun(run: TrackedAcpPrompt): void {
    for (const wake of run.waiters) wake();
    run.waiters.clear();
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    // Ignore non-JSON banner lines emitted by CLI wrappers on stdout.
    if (!trimmed.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const msg = asRecord(parsed);
    if (!msg) return;

    // 1) Response to client request
    if (typeof msg.id === "number" && !("method" in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      const errObj = asRecord(msg.error);
      if (errObj) {
        const message = readString(errObj, "message") ?? JSON.stringify(errObj);
        if (/auth|login|unauthorized|credential/i.test(message)) {
          pending.reject(new BridgeError("AUTH_LOGIN_REQUIRED", `ACP authentication required: ${message}`));
        } else {
          pending.reject(new BridgeError("TARGET_UNAVAILABLE", `ACP error: ${message}`));
        }
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    // 2) Agent-initiated JSON-RPC request (permissions, elicitations)
    if ((typeof msg.id === "number" || typeof msg.id === "string") && typeof msg.method === "string") {
      this.handleAgentRequest(msg.id, msg.method, asRecord(msg.params));
      return;
    }

    // 3) Agent-initiated notification (`session/update`)
    if (msg.method === "session/update") {
      if (this.suppressUpdatesUntilSessionReady) return;
      const params = asRecord(msg.params);
      const sessionId = readString(params, "sessionId");
      const update = asRecord(params?.update);
      if (!sessionId || !update) return;
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = asRecord(update.content);
        if (content?.type === "text" && typeof content.text === "string" && content.text.length > 0) {
          const active = this.activeRunBySession.get(sessionId);
          if (active && active.status === "running") {
            active.chunks.push(content.text);
          }
        }
      }
    }
  }

  private handleAgentRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown> | null,
  ): void {
    try {
      if (method === "session/request_permission") {
        const mode = this.target.permissionMode ?? "approve-all";
        const options = Array.isArray(params?.options) ? params.options.map(asRecord) : [];
        const toolCall = asRecord(params?.toolCall);
        const allow =
          mode === "approve-all" ||
          (mode === "approve-reads" &&
            isReadOnlyToolKind(readString(toolCall, "kind"), readString(toolCall, "title")));

        const preferredKinds = allow
          ? ["allow_always", "allow_once"]
          : ["reject_once", "reject_always"];
        const chosen =
          preferredKinds
            .map((kind) => options.find((opt) => readString(opt, "kind") === kind))
            .find(Boolean) ??
          (allow ? options[0] : undefined);
        const optionId = readString(chosen ?? null, "optionId");

        this.writeJsonLine({
          id,
          result: optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } },
        });
        return;
      }

      if (method === "elicitation/create") {
        this.writeJsonLine({
          id,
          result: { action: "cancel", _meta: { message: "Non-interactive handoff session" } },
        });
        return;
      }

      this.writeJsonLine({
        id,
        error: { code: -32601, message: `Method not supported by headless bridge: ${method}` },
      });
    } catch {
      // Ignore write failures if agent closed stdio.
    }
  }

  async preflight(): Promise<{ healthy: boolean; authReady: boolean; agentLabel: string }> {
    const launch = resolveAcpLaunchCommand(this.target);
    await this.ensureConnected();
    return {
      healthy: true,
      authReady: true,
      agentLabel: launch.agentLabel,
    };
  }

  async ensureSession(params: { sessionId?: string; cwd?: string }): Promise<string> {
    const effectiveCwd = params.cwd ?? this.target.cwd ?? process.cwd();
    await this.ensureConnected();

    if (params.sessionId) {
      if (this.activeSessions.has(params.sessionId)) {
        return params.sessionId;
      }
      if (!this.supportsResumeSession && !this.supportsLoadSession) {
        throw new BridgeError(
          "RECONCILIATION_UNCERTAIN",
          `ACP agent does not advertise session/load or session/resume to reattach session "${params.sessionId}" after bridge restart.`,
        );
      }
      this.suppressUpdatesUntilSessionReady = true;
      try {
        const method = this.supportsResumeSession ? "session/resume" : "session/load";
        await this.sendRequest(
          method,
          {
            sessionId: params.sessionId,
            cwd: effectiveCwd,
            mcpServers: [],
          },
          this.timeoutMs,
        );
        await delay(80);
      } finally {
        this.suppressUpdatesUntilSessionReady = false;
      }
      this.activeSessions.add(params.sessionId);
      await this.applySessionPreferences(params.sessionId);
      return params.sessionId;
    }

    const res = asRecord(
      await this.sendRequest(
        "session/new",
        {
          cwd: effectiveCwd,
          mcpServers: [],
        },
        this.timeoutMs,
      ),
    );
    const sessionId = readString(res, "sessionId");
    if (!sessionId) {
      throw new BridgeError("TARGET_UNAVAILABLE", "ACP session/new returned no sessionId.");
    }
    this.activeSessions.add(sessionId);
    await this.applySessionPreferences(sessionId);
    return sessionId;
  }

  private async applySessionPreferences(sessionId: string): Promise<void> {
    if (this.target.modeId) {
      await this.sendRequest("session/set_mode", { sessionId, modeId: this.target.modeId }, this.timeoutMs).catch(
        () => {},
      );
    }
    if (this.target.model) {
      try {
        await this.sendRequest(
          "session/set_config_option",
          { sessionId, configId: "model", value: this.target.model },
          this.timeoutMs,
        );
      } catch {
        await this.sendRequest(
          "session/set_model",
          { sessionId, modelId: this.target.model },
          this.timeoutMs,
        ).catch(() => {});
      }
    }
  }

  async startPrompt(params: {
    sessionId: string;
    runId: string;
    promptText: string;
    cwd?: string;
  }): Promise<void> {
    await this.ensureSession({ sessionId: params.sessionId, cwd: params.cwd });
    const tracked: TrackedAcpPrompt = {
      runId: params.runId,
      sessionId: params.sessionId,
      status: "running",
      chunks: [],
      waiters: new Set(),
    };
    this.runs.set(params.runId, tracked);
    this.activeRunBySession.set(params.sessionId, tracked);

    // session/prompt runs asynchronously until end_turn or cancellation; do not apply a short RPC timeout.
    void this.sendRequest("session/prompt", {
      sessionId: params.sessionId,
      prompt: [{ type: "text", text: params.promptText }],
    })
      .then((rawRes) => {
        const res = asRecord(rawRes);
        const stopReason = readString(res, "stopReason");
        if (stopReason === "cancelled") {
          tracked.status = "cancelled";
        } else {
          tracked.status = "completed";
        }
      })
      .catch((err) => {
        tracked.status = "failed";
        tracked.errorMessage = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (this.activeRunBySession.get(params.sessionId) === tracked) {
          this.activeRunBySession.delete(params.sessionId);
        }
        this.wakeRun(tracked);
      });
  }

  private observationFromRun(tracked: TrackedAcpPrompt): AcpPromptObservation {
    if (tracked.status === "running") return { state: "running" };
    if (tracked.status === "cancelled") return { state: "cancelled" };
    if (tracked.status === "failed") {
      return { state: "failed", errorMessage: tracked.errorMessage ?? "ACP prompt failed." };
    }
    return {
      state: "completed",
      replyText: tracked.chunks.join("").trim(),
    };
  }

  async waitPromptSlice(runId: string, sliceMs: number): Promise<AcpPromptObservation> {
    const tracked = this.runs.get(runId);
    if (!tracked) {
      return { state: "not_found" };
    }
    if (tracked.status !== "running") {
      return this.observationFromRun(tracked);
    }
    await new Promise<void>((resolve) => {
      const onWake = () => {
        clearTimeout(timer);
        tracked.waiters.delete(onWake);
        resolve();
      };
      const timer = setTimeout(onWake, sliceMs);
      tracked.waiters.add(onWake);
    });
    return this.observationFromRun(tracked);
  }

  async cancelPrompt(sessionId: string, runId: string): Promise<boolean> {
    const tracked = this.runs.get(runId);
    if (!this.child || this.child.exitCode !== null) {
      return false;
    }
    this.sendNotification("session/cancel", { sessionId });
    if (!tracked) {
      return true;
    }
    const obs = await this.waitPromptSlice(runId, Math.min(5_000, this.timeoutMs));
    return obs.state === "cancelled";
  }
}
