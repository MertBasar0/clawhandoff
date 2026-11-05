import { randomUUID } from "node:crypto";
import { normalizeA2ABaseUrl } from "./config.js";
import { BridgeError, type A2ATargetConfig } from "./types.js";

export interface ResolvedAgentCard {
  name: string;
  version?: string;
  protocolVersion: "1.0" | "0.3";
  rpcUrl: string;
  streaming?: boolean;
}

export type A2AObservedTaskState =
  | "running"
  | "completed"
  | "input_required"
  | "failed"
  | "auth_required"
  | "canceled";

export type A2ATurnObservation =
  | {
      kind: "message";
      messageId: string;
      contextId?: string;
      replyText: string;
    }
  | {
      kind: "task";
      taskId: string;
      contextId?: string;
      state: A2AObservedTaskState;
      replyText?: string;
      errorMessage?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractPartsText(partsValue: unknown): string {
  if (!Array.isArray(partsValue)) return "";
  const chunks: string[] = [];
  for (const rawPart of partsValue) {
    const part = asRecord(rawPart);
    if (!part) continue;
    if (typeof part.text === "string" && part.text.length > 0) {
      chunks.push(part.text);
    } else if (part.data !== undefined && typeof part.data === "object" && part.data !== null) {
      chunks.push(JSON.stringify(part.data));
    }
  }
  return chunks.join("\n").trim();
}

function extractMessageText(messageValue: unknown): string {
  const message = asRecord(messageValue);
  if (!message) return "";
  return extractPartsText(message.parts ?? message.content);
}

function isAgentRole(roleValue: unknown): boolean {
  if (typeof roleValue !== "string") return false;
  const upper = roleValue.toUpperCase();
  return upper === "AGENT" || upper === "ROLE_AGENT" || upper === "ASSISTANT";
}

function isUserRole(roleValue: unknown): boolean {
  if (typeof roleValue !== "string") return false;
  const upper = roleValue.toUpperCase();
  return upper === "USER" || upper === "ROLE_USER";
}

function extractTaskReplyText(task: Record<string, unknown>): string {
  const candidates: string[] = [];

  if (Array.isArray(task.artifacts)) {
    const artifactTexts: string[] = [];
    for (const rawArtifact of task.artifacts) {
      const artifact = asRecord(rawArtifact);
      if (!artifact) continue;
      const text = extractPartsText(artifact.parts ?? artifact.content);
      if (text) artifactTexts.push(text);
    }
    if (artifactTexts.length > 0) {
      candidates.push(artifactTexts.join("\n\n"));
    }
  }

  const status = asRecord(task.status);
  const statusText = extractMessageText(status?.message);
  if (statusText) {
    candidates.push(statusText);
  }

  if (Array.isArray(task.history)) {
    for (let i = task.history.length - 1; i >= 0; i -= 1) {
      const entry = asRecord(task.history[i]);
      if (entry && isAgentRole(entry.role)) {
        const text = extractMessageText(entry);
        if (text) {
          candidates.push(text);
          break;
        }
      }
    }
  }

  const withFence = candidates.find((text) => /```handoff-result\s*[\s\S]*?```/i.test(text));
  if (withFence) return withFence;
  return candidates.join("\n\n").trim();
}

function normalizeTaskState(rawState: unknown): A2AObservedTaskState {
  const cleaned = typeof rawState === "string"
    ? rawState.trim().replace(/^TASK_STATE_/i, "").toLowerCase().replace(/_/g, "-")
    : "";
  switch (cleaned) {
    case "submitted":
    case "working":
    case "unspecified":
    case "":
      return "running";
    case "completed":
      return "completed";
    case "input-required":
      return "input_required";
    case "auth-required":
      return "auth_required";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "failed":
    case "rejected":
    default:
      return "failed";
  }
}

function parseTaskObservation(task: Record<string, unknown>): A2ATurnObservation {
  const taskId = readString(task, "id");
  if (!taskId) {
    throw new BridgeError("TARGET_UNAVAILABLE", "A2A server returned a Task payload without a task id.");
  }
  const contextId = readString(task, "contextId") ?? readString(task, "context_id");
  const status = asRecord(task.status);
  const state = normalizeTaskState(status?.state);
  const replyText = extractTaskReplyText(task) || undefined;
  const statusMsg = extractMessageText(status?.message);
  return {
    kind: "task",
    taskId,
    contextId,
    state,
    replyText,
    errorMessage:
      state === "failed" || state === "auth_required"
        ? statusMsg || `Remote A2A task ended in state "${String(status?.state ?? state)}".`
        : undefined,
  };
}

function parseSendResult(result: unknown): A2ATurnObservation {
  const record = asRecord(result);
  if (!record) {
    throw new BridgeError("TARGET_UNAVAILABLE", "A2A server returned a non-object JSON-RPC result.");
  }
  // A2A v1.0 SendMessageResponse wraps `{ task }` or `{ message }`.
  const wrappedTask = asRecord(record.task);
  if (wrappedTask) return parseTaskObservation(wrappedTask);
  const wrappedMessage = asRecord(record.message);
  if (wrappedMessage) {
    return {
      kind: "message",
      messageId: readString(wrappedMessage, "messageId") ?? readString(wrappedMessage, "message_id") ?? randomUUID(),
      contextId: readString(wrappedMessage, "contextId") ?? readString(wrappedMessage, "context_id"),
      replyText: extractMessageText(wrappedMessage),
    };
  }
  // A2A v0.3 returns Task (`kind: "task"` or `status` + `id`) or Message (`kind: "message"` or `parts`) directly.
  if (record.kind === "message" || (Array.isArray(record.parts) && !record.status)) {
    return {
      kind: "message",
      messageId: readString(record, "messageId") ?? readString(record, "message_id") ?? randomUUID(),
      contextId: readString(record, "contextId") ?? readString(record, "context_id"),
      replyText: extractMessageText(record),
    };
  }
  return parseTaskObservation(record);
}

export class A2AClient {
  private readonly target: A2ATargetConfig;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private cachedCard?: ResolvedAgentCard;

  constructor(target: A2ATargetConfig) {
    this.target = target;
    this.baseUrl = normalizeA2ABaseUrl(target.url);
    this.timeoutMs = target.rpcTimeoutMs ?? 30_000;
  }

  private buildHeaders(protocolVersion?: "1.0" | "0.3", includeJsonContentType = false): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.target.headers ?? {}),
    };
    if (includeJsonContentType) {
      headers["Content-Type"] = "application/json";
    }
    if (protocolVersion === "1.0") {
      headers["A2A-Version"] = "1.0";
    }
    if (this.target.authTokenEnvVar) {
      const token = process.env[this.target.authTokenEnvVar]?.trim();
      if (!token) {
        throw new BridgeError(
          "AUTH_LOGIN_REQUIRED",
          `Environment variable "${this.target.authTokenEnvVar}" is not set for A2A target "${this.target.targetId}".`,
          `Export ${this.target.authTokenEnvVar} before running handoffs to "${this.target.targetId}".`,
        );
      }
      if (this.target.authHeaderName) {
        headers[this.target.authHeaderName] = token;
      } else {
        headers.Authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
      }
    }
    return headers;
  }

  async discoverAgentCard(forceRefresh = false): Promise<ResolvedAgentCard> {
    if (this.cachedCard && !forceRefresh) {
      return this.cachedCard;
    }

    const parsedBase = new URL(this.baseUrl);
    const origin = parsedBase.origin;
    const basePrefix = parsedBase.pathname === "/" ? "" : parsedBase.pathname;
    const candidatePaths = this.target.agentCardPath
      ? [this.target.agentCardPath]
      : [
          `${basePrefix}/.well-known/agent-card.json`,
          `${basePrefix}/.well-known/agent.json`,
          ...(basePrefix ? ["/.well-known/agent-card.json", "/.well-known/agent.json"] : []),
        ];

    const headers = this.buildHeaders(undefined, false);
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (const relPath of candidatePaths) {
      const cardUrl = new URL(relPath.startsWith("/") ? relPath : `/${relPath}`, `${origin}/`).toString();
      let response: Response;
      try {
        response = await fetch(cardUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new BridgeError(
          "AUTH_LOGIN_REQUIRED",
          `A2A Agent Card endpoint "${cardUrl}" rejected authentication (HTTP ${response.status}).`,
          this.target.authTokenEnvVar
            ? `Verify credentials in ${this.target.authTokenEnvVar}.`
            : "Configure authTokenEnvVar on this A2A target.",
        );
      }

      if (response.status === 404) {
        lastStatus = 404;
        continue;
      }

      if (!response.ok) {
        lastStatus = response.status;
        lastError = `HTTP ${response.status}`;
        continue;
      }

      let rawCard: unknown;
      try {
        rawCard = await response.json();
      } catch (err) {
        throw new BridgeError(
          "TARGET_UNAVAILABLE",
          `A2A Agent Card at "${cardUrl}" returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const card = this.resolveCardObject(rawCard);
      this.cachedCard = card;
      return card;
    }

    throw new BridgeError(
      "TARGET_UNAVAILABLE",
      `Unable to resolve A2A Agent Card from "${this.baseUrl}" (${lastError ?? (lastStatus ? `HTTP ${lastStatus}` : "unreachable")}).`,
    );
  }

  private resolveCardObject(raw: unknown): ResolvedAgentCard {
    const card = asRecord(raw);
    if (!card) {
      throw new BridgeError("TARGET_UNAVAILABLE", "A2A Agent Card payload is not a JSON object.");
    }
    const name = readString(card, "name") ?? this.target.targetId;
    const version = readString(card, "version");
    const capabilities = asRecord(card.capabilities);
    const streaming = typeof capabilities?.streaming === "boolean" ? capabilities.streaming : undefined;
    const configuredVersion = this.target.protocolVersion ?? "auto";

    // A2A v1.0 supportedInterfaces array
    if (Array.isArray(card.supportedInterfaces)) {
      const jsonRpcIface = card.supportedInterfaces
        .map(asRecord)
        .find((iface) => {
          const binding = (readString(iface, "protocolBinding") ?? readString(iface, "transport") ?? "").toUpperCase();
          return !binding || binding === "JSONRPC" || binding === "JSON-RPC";
        });
      if (jsonRpcIface) {
        const ifaceUrl = readString(jsonRpcIface, "url") ?? this.baseUrl;
        const ifaceProto = readString(jsonRpcIface, "protocolVersion") ?? readString(card, "protocolVersion") ?? "1.0";
        const resolvedProto: "1.0" | "0.3" =
          configuredVersion !== "auto"
            ? configuredVersion
            : ifaceProto.startsWith("0.")
              ? "0.3"
              : "1.0";
        return {
          name,
          version,
          protocolVersion: resolvedProto,
          rpcUrl: new URL(ifaceUrl, `${this.baseUrl}/`).toString(),
          streaming,
        };
      }
    }

    // A2A v0.3 url + preferredTransport / additionalInterfaces
    let rpcUrl = readString(card, "url") ?? this.baseUrl;
    const preferredTransport = (readString(card, "preferredTransport") ?? "JSONRPC").toUpperCase();
    if (preferredTransport !== "JSONRPC" && preferredTransport !== "JSON-RPC" && Array.isArray(card.additionalInterfaces)) {
      const altJsonRpc = card.additionalInterfaces
        .map(asRecord)
        .find((iface) => {
          const transport = (readString(iface, "transport") ?? "").toUpperCase();
          return transport === "JSONRPC" || transport === "JSON-RPC";
        });
      const altUrl = readString(altJsonRpc ?? null, "url");
      if (altUrl) rpcUrl = altUrl;
    }

    const declaredProto = readString(card, "protocolVersion") ?? "0.3.0";
    const resolvedProto: "1.0" | "0.3" =
      configuredVersion !== "auto"
        ? configuredVersion
        : declaredProto.startsWith("1.")
          ? "1.0"
          : "0.3";

    return {
      name,
      version,
      protocolVersion: resolvedProto,
      rpcUrl: new URL(rpcUrl, `${this.baseUrl}/`).toString(),
      streaming,
    };
  }

  private async rpcCall(
    card: ResolvedAgentCard,
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: { code?: number; message: string } }> {
    const headers = this.buildHeaders(card.protocolVersion, true);
    let response: Response;
    try {
      response = await fetch(card.rpcUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `A2A JSON-RPC call "${method}" to "${card.rpcUrl}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new BridgeError(
        "AUTH_LOGIN_REQUIRED",
        `A2A endpoint "${card.rpcUrl}" rejected authentication on "${method}" (HTTP ${response.status}).`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `A2A endpoint "${card.rpcUrl}" returned non-JSON HTTP ${response.status} on "${method}".`,
      );
    }

    const envelope = asRecord(parsed);
    const errObj = asRecord(envelope?.error);
    if (errObj) {
      return {
        error: {
          code: typeof errObj.code === "number" ? errObj.code : undefined,
          message: readString(errObj, "message") ?? JSON.stringify(errObj),
        },
      };
    }

    if (!response.ok) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `A2A endpoint "${card.rpcUrl}" failed with HTTP ${response.status} on "${method}".`,
      );
    }

    return { result: envelope?.result };
  }

  async sendMessage(params: {
    messageId: string;
    promptText: string;
    contextId?: string;
    handoffId: string;
  }): Promise<A2ATurnObservation> {
    const card = await this.discoverAgentCard();
    const isV1 = card.protocolVersion === "1.0";
    const method = isV1 ? "SendMessage" : "message/send";
    const rpcParams: Record<string, unknown> = isV1
      ? {
          message: {
            messageId: params.messageId,
            role: "ROLE_USER",
            parts: [{ text: params.promptText }],
            ...(params.contextId ? { contextId: params.contextId } : {}),
          },
          configuration: {
            returnImmediately: true,
          },
          metadata: {
            handoffId: params.handoffId,
          },
        }
      : {
          message: {
            kind: "message",
            messageId: params.messageId,
            role: "user",
            parts: [{ kind: "text", text: params.promptText }],
            ...(params.contextId ? { contextId: params.contextId } : {}),
          },
          configuration: {
            blocking: false,
          },
          metadata: {
            handoffId: params.handoffId,
          },
        };

    const res = await this.rpcCall(card, method, rpcParams);
    if (res.error) {
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `A2A ${method} failed (${res.error.code ?? "error"}): ${res.error.message}`,
      );
    }
    return parseSendResult(res.result);
  }

  async getTask(taskId: string): Promise<A2ATurnObservation | { kind: "not_found" }> {
    const card = await this.discoverAgentCard();
    const method = card.protocolVersion === "1.0" ? "GetTask" : "tasks/get";
    const res = await this.rpcCall(card, method, { id: taskId });
    if (res.error) {
      // -32001 is standard A2A TaskNotFoundError
      if (res.error.code === -32001 || /not\s*found/i.test(res.error.message)) {
        return { kind: "not_found" };
      }
      throw new BridgeError(
        "TARGET_UNAVAILABLE",
        `A2A ${method} failed (${res.error.code ?? "error"}): ${res.error.message}`,
      );
    }
    const record = asRecord(res.result);
    if (!record) {
      throw new BridgeError("TARGET_UNAVAILABLE", `A2A ${method} returned an empty result.`);
    }
    return parseTaskObservation(record);
  }

  /** Attempt crash-recovery reconciliation by searching ListTasks for the exact user messageId. */
  async findTaskByMessageId(params: {
    messageId: string;
    contextId?: string;
  }): Promise<A2ATurnObservation | undefined> {
    const card = await this.discoverAgentCard();
    if (card.protocolVersion !== "1.0") {
      return undefined;
    }
    const res = await this.rpcCall(card, "ListTasks", {
      ...(params.contextId ? { contextId: params.contextId } : {}),
      includeArtifacts: true,
      historyLength: 20,
    });
    if (res.error) {
      return undefined;
    }
    const body = asRecord(res.result);
    if (!Array.isArray(body?.tasks)) {
      return undefined;
    }
    const matching = body.tasks.map(asRecord).filter((task): task is Record<string, unknown> => {
      if (!task || !Array.isArray(task.history)) return false;
      return task.history.some((entryValue) => {
        const entry = asRecord(entryValue);
        const msgId = readString(entry, "messageId") ?? readString(entry, "message_id");
        return Boolean(entry && isUserRole(entry.role) && msgId === params.messageId);
      });
    });
    if (matching.length !== 1) {
      return undefined;
    }
    return parseTaskObservation(matching[0]!);
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const card = await this.discoverAgentCard();
    const method = card.protocolVersion === "1.0" ? "CancelTask" : "tasks/cancel";
    const res = await this.rpcCall(card, method, { id: taskId });
    if (res.error) {
      return false;
    }
    const record = asRecord(res.result);
    if (!record) return false;
    const obs = parseTaskObservation(record);
    return obs.kind === "task" && obs.state === "canceled";
  }
}
