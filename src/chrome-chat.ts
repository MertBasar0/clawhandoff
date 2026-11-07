import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { browserTranscriptScript } from "./browser-turn.js";
import { parseBrowserSessionRoute, sameBrowserSessionUrl } from "./config.js";
import { BridgeError } from "./types.js";

export interface ChromeChatOptions {
  command: string;
  args: string[];
  sessionUrl: string;
  basePath?: string;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Raw replies and stderr can name unrelated tabs, so they never leave this module. A failure is
// reported only as one of these causes, recognized by fixed markers from Chrome DevTools MCP 1.11.
const CAUSES = {
  browser_connect_timeout: [
    "Chrome did not finish attaching within Chrome DevTools MCP's 60-second limit",
    "Keep Chrome open and responsive (closing unused tabs makes attaching faster) and allow its remote debugging prompt.",
  ],
  browser_connect_failed: [
    "Chrome DevTools MCP could not connect to Chrome",
    "Start Chrome, enable remote debugging at chrome://inspect/#remote-debugging and allow the connection.",
  ],
  browser_reconnected: [
    "the browser reconnected, and the configured chat tab could not be resolved again",
    "Keep exactly one tab open at the configured Robo chat URL.",
  ],
  page_closed: [
    "the chat tab closed or was replaced while the bridge used it",
    "Keep exactly one tab open at the configured Robo chat URL.",
  ],
  mcp_transport_closed: [
    "the Chrome DevTools MCP process exited or closed its connection",
    "The next call restarts it. If it keeps exiting, check the browserMcp command and its --logFile.",
  ],
  mcp_request_timeout: [
    "Chrome DevTools MCP did not answer within 75 seconds",
    "Check that Chrome and the chat tab still respond.",
  ],
  missing_structured_content: [
    "the reply carried no structured content",
    "Use Chrome DevTools MCP 1.11 or newer. The bridge passes --experimentalStructuredContent itself.",
  ],
  tool_error: [
    "the tool reported an error, withheld because it can describe other tabs",
    "Check the open chat and Chrome's local attachment permission.",
  ],
  mcp_start_failed: [
    "the browserMcp command could not start or exited before the MCP handshake",
    "Check that the browserMcp command starts Chrome DevTools MCP when run on its own.",
  ],
  mcp_log_file_failed: [
    "Chrome DevTools MCP could not open its --logFile",
    "Create the --logFile directory and make it writable, or remove --logFile.",
  ],
  mcp_start_timeout: [
    "the MCP handshake did not finish within 30 seconds",
    "Check the browserMcp command. A first npx run may still be downloading the package.",
  ],
  mcp_unsupported: [
    "its tools do not accept explicit page IDs",
    "Use Chrome DevTools MCP 1.11 or newer, without --slim or --no-page-id-routing.",
  ],
} as const;

export type ChromeFailureCause = keyof typeof CAUSES;

export function chromeFailure(action: string, cause: ChromeFailureCause): BridgeError {
  const [reason, remediation] = CAUSES[cause];
  const what = action === "start" ? "could not start" : `could not complete ${action}`;
  return new BridgeError("TARGET_UNAVAILABLE", `Chrome DevTools MCP ${what} (${cause}): ${reason}.`, remediation);
}

const REPLY_MARKERS: ReadonlyArray<readonly [RegExp, ChromeFailureCause]> = [
  // ToolHandler's ToolCallTimeoutError, or a queued call that found that attempt abandoned.
  [/waiting for the browser connection to be established|Connection attempt was abandoned/, "browser_connect_timeout"],
  // BrowserManager: no DevToolsActivePort (remote debugging is off), or Chrome refused to connect.
  [/Could not connect to Chrome|Browser was closed while initializing/, "browser_connect_failed"],
];
// The logger exits the process when it cannot open --logFile.
const LOG_FILE_MARKER = /Error when opening\/writing to log file/;

/** Names the cause of a Chrome DevTools MCP reply that cannot be used. */
export function chromeReplyFailure(reply: RecordValue): ChromeFailureCause {
  const text = Array.isArray(reply.content)
    ? reply.content.map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n")
    : "";
  const marked = REPLY_MARKERS.find(([marker]) => marker.test(text));
  if (marked) return marked[1];
  const content = reply.structuredContent;
  if (!isRecord(content)) return reply.isError ? "tool_error" : "missing_structured_content";
  if (content.reconnected === true) return "browser_reconnected";
  return content.errorMessage === "No page found" ? "page_closed" : "tool_error";
}

/** Names the cause of an exception raised while calling Chrome DevTools MCP. */
export function chromeThrownFailure(error: unknown): ChromeFailureCause {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return "mcp_request_timeout";
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) return "mcp_transport_closed";
  return error instanceof Error && error.message === "Not connected" ? "mcp_transport_closed" : "tool_error";
}

const SEND = ["Send message", "Mesaj gönder"];
const STOP = ["Stop", "Stop generating", "Durdur", "Yanıt oluşturmayı durdur"];
const ACTIONS = new Set(["fill", "click"]);

function labelSet(dynamicLabel: unknown, defaults: readonly string[]): string[] {
  return typeof dynamicLabel === "string" && dynamicLabel.trim() && !defaults.includes(dynamicLabel)
    ? [dynamicLabel, ...defaults]
    : [...defaults];
}

// Only genuine accessibility nodes can supply a UID. Text rendered by a user or an
// assistant may itself contain strings that look like a printed accessibility tree.
function controls(node: RecordValue, role: string, names: readonly string[]): RecordValue[] {
  const matches = node.role === role && typeof node.name === "string" && names.includes(node.name)
    ? [node] : [];
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (isRecord(child)) matches.push(...controls(child, role, names));
    }
  }
  return matches;
}

function oneEnabled(node: RecordValue, role: string, names: readonly string[]): { id: string; value: unknown } {
  const matches = controls(node, role, names);
  const control = matches[0];
  if (matches.length !== 1 || !control || typeof control.id !== "string" || control.disabled === true) {
    throw new BridgeError("TARGET_UNAVAILABLE", `Could not identify the enabled ${names[0]} control in this chat.`);
  }
  return { id: control.id, value: control.value };
}

/**
 * The configured chat tab under the id one browser connection gave it. A browser reconnect or a
 * new Chrome DevTools MCP process renumbers tabs and voids every snapshot uid taken before.
 */
interface ChatPage {
  readonly id: number;
  readonly epoch: number;
}

/** A page id went stale before the call could reach a page. */
class StalePage extends Error {
  constructor(readonly tool: string) {
    super(`${tool} used a page id from an earlier browser connection`);
  }
}

function ended(stream: Readable | null): Promise<void> {
  return new Promise((resolve) => {
    if (!stream || stream.readableEnded || stream.destroyed) return resolve();
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
    stream.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

export class ChromeChat {
  private readonly client = new Client({ name: "clawhandoff-browser", version: "0.2.0" });
  private readonly route: ReturnType<typeof parseBrowserSessionRoute>;
  private connected?: Promise<void>;
  /** Advances whenever Chrome DevTools MCP may have renumbered its tabs. */
  private epoch = 0;

  constructor(private readonly options: ChromeChatOptions) {
    this.route = parseBrowserSessionRoute(options.sessionUrl, options.basePath);
    // A later attach can reconnect if Chrome or its local MCP process exited.
    this.client.onclose = () => { this.connected = undefined; };
  }

  private matchesSessionUrl(url: unknown): url is string {
    return typeof url === "string" && sameBrowserSessionUrl(url, this.options.sessionUrl, this.options.basePath);
  }

  private connect(): Promise<void> {
    return this.connected ??= this.open().catch((error: unknown) => {
      this.connected = undefined;
      throw error;
    });
  }

  private async open(): Promise<void> {
    // Each Chrome DevTools MCP process numbers tabs from scratch.
    this.epoch++;
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [
        ...this.options.args,
        ...(this.options.args.includes("--autoConnect") ? [] : ["--autoConnect"]),
        "--experimentalStructuredContent",
      ],
      // Drained in memory and only matched against fixed startup markers.
      stderr: "pipe",
    });
    const stderr = transport.stderr as Readable | null;
    let output = "";
    const collect = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-16_384); };
    stderr?.on("data", collect);
    let cause: ChromeFailureCause = "mcp_unsupported";
    try {
      await this.client.connect(transport, { timeout: 30_000 });
      const { tools } = await this.client.listTools();
      if (["take_snapshot", "evaluate_script", "fill", "click"].every((name) =>
        tools.find((tool) => tool.name === name)?.inputSchema.properties?.pageId)) {
        stderr?.off("data", collect).resume();
        return;
      }
    } catch (error) {
      cause = error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "mcp_start_timeout" : "mcp_start_failed";
    }
    await transport.close();
    if (cause === "mcp_start_failed") {
      await ended(stderr);
      if (LOG_FILE_MARKER.test(output)) cause = "mcp_log_file_failed";
    }
    throw chromeFailure("start", cause);
  }

  private async tool(name: string, args: RecordValue, page?: ChatPage): Promise<RecordValue> {
    await this.connect();
    // Never send an id that an earlier connection issued: it can name a different tab now.
    if (page && page.epoch !== this.epoch) throw new StalePage(name);
    let reply: Awaited<ReturnType<Client["callTool"]>>;
    try {
      reply = await this.client.callTool(
        { name, arguments: page ? { pageId: page.id, ...args } : args }, undefined, { timeout: 75_000 });
    } catch (error) {
      throw chromeFailure(name, chromeThrownFailure(error));
    }
    const content = reply.structuredContent;
    if (isRecord(content) && content.reconnected === true) {
      this.epoch++;
      if (page) {
        // A renumbered id fails before the tool runs. Reads can always run again, but an
        // action runs again only when its reply proves that it never reached a page.
        if (!ACTIONS.has(name) || (reply.isError === true && content.errorMessage === "No page found")) {
          throw new StalePage(name);
        }
        throw chromeFailure(name, "browser_reconnected");
      }
    }
    if (reply.isError || !isRecord(content)) throw chromeFailure(name, chromeReplyFailure(reply));
    return content;
  }

  /**
   * Resolves the one tab that shows the configured chat. With `expected`, it also confirms
   * that this is still the tab the caller inspected.
   */
  private async page(expected?: ChatPage, cause?: ChromeFailureCause): Promise<ChatPage> {
    const { pages } = await this.tool("list_pages", {});
    // Ids from before a reconnect cannot be compared. The caller inspects the tab again.
    if (expected && expected.epoch !== this.epoch) throw new StalePage("list_pages");
    const matches = Array.isArray(pages)
      ? pages.filter((entry): entry is RecordValue => isRecord(entry) && this.matchesSessionUrl(entry.url))
      : [];
    const id = matches[0]?.id;
    if (matches.length !== 1 || typeof id !== "number" || (expected !== undefined && id !== expected.id)) {
      if (cause) throw chromeFailure("list_pages", cause);
      throw new BridgeError("TARGET_UNAVAILABLE", "Open exactly one tab at the configured Robo chat URL and keep it open.");
    }
    return { id, epoch: this.epoch };
  }

  /**
   * Runs one step against `page`. If a reconnect voids its page id and snapshot uids, the step
   * runs once more, from its first inspection, against the tab resolved again.
   */
  private async recovering<T>(page: ChatPage, step: (page: ChatPage, retry: boolean) => Promise<T>): Promise<T> {
    try {
      return await step(page, false);
    } catch (error) {
      if (!(error instanceof StalePage)) throw error;
    }
    const again = await this.page(undefined, "browser_reconnected");
    try {
      return await step(again, true);
    } catch (error) {
      throw error instanceof StalePage ? chromeFailure(error.tool, "browser_reconnected") : error;
    }
  }

  private async readProjection(page: ChatPage, turnKey?: string): Promise<RecordValue> {
    const script = `() => (${browserTranscriptScript})(${JSON.stringify(this.options.sessionUrl)}, ${JSON.stringify(turnKey ?? null)}, ${JSON.stringify(this.route?.uuidRoute ?? null)})`;
    const { message } = await this.tool("evaluate_script", { function: script, waitForStableDom: false }, page);
    const body = typeof message === "string" && /^Script ran on page and returned:\n```json\n([\s\S]*)\n```$/.exec(message)?.[1];
    let projection: unknown;
    try {
      projection = body ? JSON.parse(body) : undefined;
    } catch {
      throw new BridgeError("TARGET_UNAVAILABLE", "Chrome returned an unreadable chat snapshot.");
    }
    if (!isRecord(projection) || !this.matchesSessionUrl(projection.url) ||
        projection.ready !== true || typeof projection.busy !== "boolean" || !Array.isArray(projection.messages)) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Open the configured chat and wait for its transcript and composer to finish loading.");
    }
    return projection;
  }

  async read(turnKey?: string): Promise<string> {
    return JSON.stringify(await this.recovering(await this.page(), (page) => this.readProjection(page, turnKey)));
  }

  private async composerSnapshot(page: ChatPage, stopNames: readonly string[]): Promise<RecordValue> {
    const { snapshot } = await this.tool("take_snapshot", {}, page);
    if (!isRecord(snapshot) || snapshot.role !== "RootWebArea" || !this.matchesSessionUrl(snapshot.url)) {
      throw new BridgeError("TARGET_UNAVAILABLE", "The tab no longer displays the configured Robo chat.");
    }
    if (controls(snapshot, "button", stopNames).length > 0) {
      throw new BridgeError("BUSY_ACTIVE_TURN", "Robo is already responding in the configured chat.");
    }
    return snapshot;
  }

  private async inspectComposer(
    page: ChatPage,
    busyCode: "BUSY_ACTIVE_TURN" | "RECONCILIATION_UNCERTAIN",
    busyMessage: string,
  ) {
    const proj = await this.readProjection(page);
    if (proj.busy === true) throw new BridgeError(busyCode, busyMessage);
    const ctl = proj.controls;
    if (!isRecord(ctl) || typeof ctl.composerLabel !== "string" || !ctl.composerLabel.trim()) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Could not identify the chat composer's accessible name.");
    }
    const snap = await this.composerSnapshot(page, labelSet(ctl.stopLabel, STOP));
    return {
      page,
      snap,
      composer: oneEnabled(snap, "textbox", [ctl.composerLabel]),
      sendNames: labelSet(ctl.sendLabel, SEND),
    };
  }

  /** Inspects a composer that must be empty. After the claim, any surprise leaves the send uncertain. */
  private async emptyComposer(page: ChatPage, claimed: boolean) {
    const state = claimed
      ? await this.inspectComposer(page, "RECONCILIATION_UNCERTAIN", "Robo started responding before submission; inspect the chat.")
      : await this.inspectComposer(page, "BUSY_ACTIVE_TURN", "Robo is already responding in the configured chat.");
    if ((state.composer.value ?? "") !== "" || controls(state.snap, "button", state.sendNames).some((node) => !node.disabled)) {
      throw claimed
        ? new BridgeError("RECONCILIATION_UNCERTAIN", "The browser draft changed before submission; inspect the chat.")
        : new BridgeError("BUSY_ACTIVE_TURN", "The chat has a draft. Leave the composer empty before starting a turn.");
    }
    return state;
  }

  async send(text: string, claim: () => boolean): Promise<void> {
    // HTML textareas normalize Windows line endings in their value.
    const draftText = text.replace(/\r\n?/g, "\n");
    // Nothing in the chat changes before the claim, so a reconnect only repeats these checks.
    const initial = await this.recovering(await this.page(), async (page) => {
      const state = await this.emptyComposer(page, false);
      await this.page(page);
      return state;
    });
    if (!claim()) return;
    // An action is repeated only after its first attempt provably never ran and the tab,
    // inspected again under its new id, still shows exactly the state the action expects.
    const filledPage = await this.recovering(initial.page, async (page, retry) => {
      const empty = retry ? await this.emptyComposer(page, true) : initial;
      if (retry) await this.page(page);
      await this.tool("fill", { uid: empty.composer.id, value: draftText }, page);
      return page;
    });
    await this.recovering(filledPage, async (page) => {
      const filled = await this.inspectComposer(page, "RECONCILIATION_UNCERTAIN", "Robo started responding before submission; inspect the chat.");
      if (filled.composer.value !== draftText) {
        throw new BridgeError("RECONCILIATION_UNCERTAIN", "The browser draft changed before submission; inspect the chat.");
      }
      const button = oneEnabled(filled.snap, "button", filled.sendNames);
      await this.page(page);
      await this.tool("click", { uid: button.id }, page);
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
