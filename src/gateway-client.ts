import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BridgeError, type GatewayTargetConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface GatewayCreateSessionResponse {
  key: string;
  sessionId?: string;
  runId?: string;
  runStarted: boolean;
  runError?: unknown;
  status?: string;
  worktree?: { id?: string; path?: string; branch?: string };
}

export interface GatewayWaitObservation {
  state: "completed" | "running" | "failed" | "not_found";
  terminalReplyText?: string;
  errorMessage?: string;
}

export interface GatewayHistoryMessage {
  id?: string;
  runId?: string;
  role: "user" | "assistant" | "other";
  finalAnswer?: boolean;
  text: string;
}

export interface GatewayHistorySnapshot {
  sessionKey?: string;
  sessionId?: string;
  acceptedRunId?: string;
  lastTerminalRun?: { id: string; status: string };
  messages: GatewayHistoryMessage[];
}

function toWsUrl(url: string): string {
  return url.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

function toHttpsAppUrl(url: string): string {
  return url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

export function buildPrettySessionUrl(params: {
  originUrl: string;
  agentId: string;
  label: string;
  sessionKey: string;
}): string {
  const base = toHttpsAppUrl(params.originUrl).replace(/\/+$/, "");
  const uuidPart = (params.sessionKey.split(":").pop() ?? params.sessionKey).replace(/-/g, "");
  const slug = params.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base}/chat/${params.agentId}/${slug}-${uuidPart}`;
}

export class OpenClawGatewayClient {
  private readonly target: GatewayTargetConfig;
  private readonly profileDir: string;

  constructor(target: GatewayTargetConfig, dataDir: string) {
    this.target = target;
    this.profileDir = target.profileDir ?? join(dataDir, "profiles", target.targetId);
  }

  getTargetConfig(): GatewayTargetConfig {
    return this.target;
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await this.callRpc("health", {});
    const ok = res.ok !== false && !res.error;
    return { ok };
  }

  async listAgents(): Promise<{ defaultId?: string; agentIds: string[] }> {
    const res = await this.callRpc("agents.list", {});
    const rawAgents = Array.isArray(res.agents) ? res.agents : [];
    const agentIds = rawAgents.flatMap((a): string[] => {
      if (a && typeof a === "object") {
        const id = (a as Record<string, unknown>).id;
        if (typeof id === "string") {
          return [id];
        }
      }
      return [];
    });
    return {
      defaultId: typeof res.defaultId === "string" ? res.defaultId : undefined,
      agentIds,
    };
  }

  async createSession(params: {
    key?: string;
    agentId: string;
    label: string;
    message: string;
    idempotencyKey: string;
    projectId?: string;
    worktreeBaseRef?: string;
    worktreeName?: string;
  }): Promise<GatewayCreateSessionResponse> {
    const rpcParams: Record<string, unknown> = {
      ...(params.key ? { key: params.key } : {}),
      agentId: params.agentId,
      label: params.label,
      message: params.message,
      idempotencyKey: params.idempotencyKey,
    };
    if (params.projectId) {
      rpcParams.projectId = params.projectId;
      rpcParams.worktree = true;
      if (params.worktreeBaseRef) {
        rpcParams.worktreeBaseRef = params.worktreeBaseRef;
      }
      if (params.worktreeName) {
        rpcParams.worktreeName = params.worktreeName;
      }
    }

    const res = await this.callRpc("sessions.create", rpcParams);
    if (typeof res.key !== "string" || !res.key) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway sessions.create did not return a session key for target "${this.target.targetId}".`,
      );
    }

    return {
      key: res.key,
      sessionId: typeof res.sessionId === "string" ? res.sessionId : undefined,
      runId: typeof res.runId === "string" ? res.runId : undefined,
      runStarted: res.runStarted !== false,
      runError: res.runError,
      status: typeof res.status === "string" ? res.status : undefined,
      worktree:
        res.worktree && typeof res.worktree === "object"
          ? (res.worktree as GatewayCreateSessionResponse["worktree"])
          : undefined,
    };
  }

  async describeSession(sessionKey: string): Promise<{
    exists: boolean;
    sessionId?: string;
    agentId?: string;
  }> {
    try {
      const res = await this.callRpc("sessions.describe", {
        key: sessionKey,
        includeDerivedTitles: true,
      });
      const session =
        res.session && typeof res.session === "object"
          ? (res.session as Record<string, unknown>)
          : undefined;
      if (!session) {
        return { exists: false };
      }
      return {
        exists: true,
        sessionId: typeof session.sessionId === "string" ? session.sessionId : undefined,
        agentId: typeof session.agentId === "string" ? session.agentId : undefined,
      };
    } catch {
      return { exists: false };
    }
  }

  async sendChat(params: {
    sessionKey: string;
    sessionId?: string;
    agentId: string;
    message: string;
    idempotencyKey: string;
  }): Promise<{ runId: string; status?: string }> {
    const res = await this.callRpc("chat.send", {
      sessionKey: params.sessionKey,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      agentId: params.agentId,
      message: params.message,
      idempotencyKey: params.idempotencyKey,
    });

    if (typeof res.runId !== "string" || !res.runId) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway chat.send did not return a runId for session "${params.sessionKey}".`,
      );
    }

    return {
      runId: res.runId,
      status: typeof res.status === "string" ? res.status : undefined,
    };
  }

  /**
   * Waits one bounded slice (`<= 50_000 ms`) for `runId`.
   * Matches OpenClaw `extensions/mcp-relay/src/operations.ts:273-312` and
   * `src/gateway/agent-turn/agent-wait.ts:72-79` terminal-timeout semantics.
   */
  async waitRunSlice(runId: string, sliceMs: number): Promise<GatewayWaitObservation> {
    const boundedMs = Math.max(100, Math.min(50_000, Math.floor(sliceMs)));
    let res: Record<string, unknown>;
    try {
      res = await this.callRpc(
        "agent.wait",
        { runId, timeoutMs: boundedMs },
        boundedMs + 15_000,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof BridgeError && err.code === "TARGET_UNAVAILABLE" && /agent run was not found/i.test(msg)) {
        return { state: "not_found" };
      }
      if (/CLIENT_TIMEOUT|AGENT_TIMEOUT|timed out/i.test(msg)) {
        return { state: "running" };
      }
      throw err;
    }

    const terminalTimeout =
      res.status === "timeout" &&
      res.pendingError !== true &&
      (typeof res.endedAt === "number" ||
        (typeof res.stopReason === "string" && res.stopReason.length > 0) ||
        (typeof res.livenessState === "string" && res.livenessState.length > 0) ||
        res.timeoutPhase === "preflight" ||
        res.timeoutPhase === "provider" ||
        res.timeoutPhase === "post_turn" ||
        res.providerStarted === true);

    if (res.status === "error" || terminalTimeout) {
      return {
        state: "failed",
        errorMessage:
          typeof res.stopReason === "string"
            ? res.stopReason
            : "Remote agent run terminated with an error or terminal timeout.",
      };
    }

    if (res.status === "timeout" || res.status === "pending") {
      return { state: "running" };
    }

    if (res.status === "ok") {
      const terminal =
        res.terminalReply && typeof res.terminalReply === "object"
          ? (res.terminalReply as Record<string, unknown>)
          : undefined;
      const terminalReplyText =
        terminal?.disposition === "visible" && typeof terminal.text === "string"
          ? terminal.text
          : undefined;
      return {
        state: "completed",
        terminalReplyText,
      };
    }

    return { state: "running" };
  }

  async readHistory(sessionKey: string, sessionId?: string, inputRunId?: string): Promise<GatewayHistorySnapshot> {
    const res = await this.callRpc("chat.history", {
      sessionKey,
      agentId: this.target.agentId,
      ...(sessionId ? { sessionId } : {}),
      ...(inputRunId ? { inputRunIds: [inputRunId] } : {}),
      limit: 50,
      maxChars: 32_000,
      maxBytes: 512_000,
    });

    const rawMessages = Array.isArray(res.messages) ? res.messages : [];

    const messages: GatewayHistoryMessage[] = rawMessages.map((raw) => {
      if (!raw || typeof raw !== "object") {
        return { role: "other", text: "" };
      }
      const m = raw as Record<string, unknown>;
      const meta =
        m.__openclaw && typeof m.__openclaw === "object"
          ? (m.__openclaw as Record<string, unknown>)
          : undefined;
      const role =
        m.role === "user" || m.role === "assistant" ? m.role : ("other" as const);
      const text = extractMessageText(m);
      const id =
        typeof meta?.id === "string"
          ? meta.id
          : typeof m.id === "string"
            ? m.id
            : undefined;
      // OpenClaw persists each submitted user message with the exact "<runId>:user" key.
      const userKey = meta?.idempotencyKey ?? m.idempotencyKey;
      const userRunId = role === "user" && typeof userKey === "string" && userKey.endsWith(":user")
        ? userKey.slice(0, -5) : undefined;
      const runId = userRunId || (typeof meta?.runId === "string" ? meta.runId : undefined);
      return { id, runId, role, text, finalAnswer: role === "assistant" && m.stopReason === "stop" && meta?.truncated !== true };
    });

    const accepted = inputRunId && Array.isArray(res.inputReceipts) && res.inputReceipts.some(
      (r) => r?.runId === inputRunId && (r.state === "consumed" || (r.state === "pending" && r.cancelled !== true)),
    );
    const info = res.sessionInfo && typeof res.sessionInfo === "object"
      ? res.sessionInfo as Record<string, unknown> : undefined;
    // The row projects the latest terminal run; an archived history page may carry a different current row.
    const lastTerminalRun = info && info.sessionId === res.sessionId && info.hasActiveRun === false &&
      typeof info.lastRunId === "string" && typeof info.status === "string" &&
      ["done", "failed", "timeout", "killed", "interrupted"].includes(info.status)
      ? { id: info.lastRunId, status: info.status } : undefined;
    return {
      lastTerminalRun,
      sessionKey: typeof res.sessionKey === "string" ? res.sessionKey : undefined,
      sessionId: typeof res.sessionId === "string" ? res.sessionId : undefined,
      acceptedRunId: accepted ? inputRunId : undefined,
      messages,
    };
  }

  async abortRun(sessionKey: string, runId: string): Promise<boolean> {
    const result = await this.callRpc("chat.abort", {
      sessionKey,
      agentId: this.target.agentId,
      runId,
    });
    return result.aborted === true && Array.isArray(result.runIds) && result.runIds.includes(runId);
  }

  private ensureIsolatedProfile(): string {
    const configPath = join(this.profileDir, "openclaw.json");
    const wsUrl = toWsUrl(this.target.url);
    const appUrl = toHttpsAppUrl(this.target.url);

    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const gateway = (parsed.gateway ?? {}) as Record<string, unknown>;
      const remote = (gateway.remote ?? {}) as Record<string, unknown>;
      if (remote.url !== wsUrl) {
        throw new BridgeError(
          "INVALID_INPUT",
          `Cached Gateway profile at "${configPath}" targets "${String(remote.url)}", expected "${wsUrl}". Refusing to route to a mismatched Gateway.`,
        );
      }
      return configPath;
    }

    if (this.target.authMode === "existing-profile") {
      throw new BridgeError(
        "INVALID_INPUT",
        `Target "${this.target.targetId}" uses authMode="existing-profile", but "${configPath}" does not exist.`,
      );
    }

    mkdirSync(this.profileDir, { recursive: true });
    let configObj: Record<string, unknown>;

    if (this.target.authMode === "edge-cloudflare") {
      const cloudflaredBin = this.resolveCloudflaredBinary();
      configObj = {
        secrets: {
          providers: {
            "cloudflare-access": {
              source: "exec",
              command: cloudflaredBin,
              args: ["access", "token", `-app=${appUrl}`],
              jsonOnly: false,
              passEnv: ["HOME", "USERPROFILE", "LOCALAPPDATA"],
              trustedDirs: [dirname(cloudflaredBin)],
            },
          },
        },
        gateway: {
          mode: "remote",
          remote: {
            url: wsUrl,
            edgeAuth: {
              "Cf-Access-Token": {
                source: "exec",
                provider: "cloudflare-access",
                id: "token",
              },
            },
          },
        },
      };
    } else {
      const envVar = this.target.tokenEnvVar ?? "OPENCLAW_BRIDGE_TARGET_TOKEN";
      configObj = {
        gateway: {
          mode: "remote",
          remote: {
            transport: "direct",
            url: wsUrl,
            token: `\${${envVar}}`,
          },
        },
      };
    }

    writeFileSync(configPath, JSON.stringify(configObj, null, 2), { mode: 0o600 });
    try {
      chmodSync(configPath, 0o600);
    } catch {
      // Best-effort POSIX mode on platforms without chmod semantics.
    }
    return configPath;
  }

  private resolveCloudflaredBinary(): string {
    if (this.target.cloudflaredPath) {
      return existsSync(this.target.cloudflaredPath)
        ? realpathSync(this.target.cloudflaredPath)
        : this.target.cloudflaredPath;
    }
    return "cloudflared";
  }

  private async callRpc(
    method: string,
    params: Record<string, unknown>,
    timeoutOverrideMs?: number,
  ): Promise<Record<string, unknown>> {
    const configPath = this.ensureIsolatedProfile();
    const cli = this.target.cliPath ?? "openclaw";
    const timeoutMs = timeoutOverrideMs ?? this.target.rpcTimeoutMs ?? 60_000;

    // Strip ambient Gateway overrides so the validated isolated profile always owns routing.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.OPENCLAW_GATEWAY_URL;
    delete childEnv.OPENCLAW_GATEWAY_TOKEN;
    delete childEnv.OPENCLAW_GATEWAY_PASSWORD;
    childEnv.OPENCLAW_STATE_DIR = this.profileDir;
    childEnv.OPENCLAW_CONFIG_PATH = configPath;

    const cliArgs = [
      "gateway",
      "call",
      method,
      "--json",
      "--timeout",
      String(timeoutMs),
      "--params",
      JSON.stringify(params),
    ];

    const isNodeScript = /\.(?:mjs|cjs|js)$/i.test(cli);
    const execCmd = isNodeScript ? process.execPath : cli;
    const execArgs = isNodeScript ? [cli, ...cliArgs] : cliArgs;

    let stdout = "";
    let stderr = "";
    try {
      const res = await execFileAsync(execCmd, execArgs, {
        env: childEnv,
        timeout: timeoutMs + 10_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const errOut =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr?: unknown }).stderr ?? "")
          : "";
      const stdOut =
        err && typeof err === "object" && "stdout" in err
          ? String((err as { stdout?: unknown }).stdout ?? "")
          : "";
      const combined = `${rawMsg}\n${errOut}\n${stdOut}`;

      if (
        /cloudflare-access.*exited with code 1|HTTP 302|302 Found|access login/i.test(
          combined,
        )
      ) {
        const appUrl = toHttpsAppUrl(this.target.url);
        throw new BridgeError(
          "AUTH_LOGIN_REQUIRED",
          `Cloudflare Access session for "${appUrl}" has expired or is unauthenticated.`,
          `Run \`cloudflared access login ${appUrl}\` interactively, then call \`bridge_handoff_attach\` or retry. Never switch to SSH automatically.`,
        );
      }

      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway RPC "${method}" failed on target "${this.target.targetId}": ${combined.trim().slice(0, 600)}`,
      );
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway RPC "${method}" returned empty output (${stderr.trim().slice(0, 300)}).`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway RPC "${method}" returned non-JSON output: ${trimmed.slice(0, 300)}`,
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway RPC "${method}" returned invalid JSON payload.`,
      );
    }

    const obj = parsed as Record<string, unknown>;
    if (obj.ok === false || obj.error) {
      const errDetail = JSON.stringify(obj.error ?? obj);
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `Gateway RPC "${method}" rejected request: ${errDetail}`,
      );
    }

    return obj;
  }
}

function extractMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .flatMap((block): string[] => {
        if (block && typeof block === "object") {
          const rec = block as Record<string, unknown>;
          if (rec.type === "text" && typeof rec.text === "string") {
            return [rec.text];
          }
        }
        return [];
      })
      .join("\n");
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  return "";
}
