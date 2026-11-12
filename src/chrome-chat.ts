import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserDraftKind, BrowserPageHealth, ReloadOutcome } from "./browser-health.js";
import { browserTranscriptScript } from "./browser-turn.js";
import { parseBrowserSessionRoute, sameBrowserSessionUrl } from "./config.js";
import { BridgeError } from "./types.js";

export interface ChromeChatOptions {
  command: string;
  args: string[];
  sessionUrl: string;
  basePath?: string;
  /** Timeout Chrome gets for one reload or reopen of the chat tab. */
  navigationTimeoutMs?: number;
}

/** What one read of the chat tab shows. */
export interface ChatObservation {
  health: BrowserPageHealth;
  /** The composer content, classified inside the page against the turn key. */
  draft?: BrowserDraftKind;
  busy: boolean;
  /** The transcript projection, only when the chat is ready. */
  transcript?: string;
}

/** `sent`: clicked. `typed`: the draft is in the composer but the chat could not send it yet. */
export type SendOutcome = "sent" | "typed" | "unclaimed";

const NOT_READY: Record<Exclude<BrowserPageHealth, "ready">, string> = {
  loading: "The configured chat is still loading. Wait until its transcript and composer finish loading.",
  disconnected: "The configured chat is reconnecting to its Gateway and shows a saved conversation.",
  offline: "Chrome reports that it has no network connection.",
  error_page: "The chat tab shows Chrome's network error page.",
  wrong_url: "The chat tab shows another page than the configured Robo chat.",
  missing: "Open exactly one tab at the configured Robo chat URL and keep it open.",
};

/** The chat is not usable right now. Nothing was changed in it. */
export class BrowserNotReady extends BridgeError {
  constructor(readonly health: Exclude<BrowserPageHealth, "ready">) {
    super("TARGET_UNAVAILABLE", NOT_READY[health]);
  }
}

/** A draft that the bridge itself typed for some turn. Only these may be cleared without asking. */
export function isBridgeDraft(value: string): boolean {
  return /^Bridge-(?:Turn|Nudge): idem_[\w-]+$/.test(value.split("\n", 1)[0]!.trimEnd());
}

// Chrome's own navigation errors. ERR_ABORTED only means another navigation replaced this one.
const NETWORK_ERROR = /net::ERR_(?!ABORTED\b)[A-Z_]+/;

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
const ACTIONS = new Set(["fill", "click", "navigate_page"]);

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

/** The one enabled control with one of these names, if there is exactly one. */
function enabledControl(node: RecordValue, role: string, names: readonly string[]): { id: string } | undefined {
  const matches = controls(node, role, names).filter((control) => control.disabled !== true);
  const id = matches[0]?.id;
  return matches.length === 1 && typeof id === "string" ? { id } : undefined;
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
  /** Tools the running Chrome DevTools MCP offers. */
  private tools = new Set<string>();
  /** The chat tab as last resolved, to recognize it when Chrome replaces it with an error page. */
  private lastPage?: ChatPage;

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
        this.tools = new Set(tools.map((tool) => tool.name));
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

  private async call(name: string, args: RecordValue, page?: ChatPage, timeoutMs = 75_000) {
    await this.connect();
    // Never send an id that an earlier connection issued: it can name a different tab now.
    if (page && page.epoch !== this.epoch) throw new StalePage(name);
    try {
      return await this.client.callTool(
        { name, arguments: page ? { pageId: page.id, ...args } : args }, undefined, { timeout: timeoutMs });
    } catch (error) {
      throw chromeFailure(name, chromeThrownFailure(error));
    }
  }

  private async tool(name: string, args: RecordValue, page?: ChatPage, timeoutMs?: number): Promise<RecordValue> {
    const reply = await this.call(name, args, page, timeoutMs);
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
   * Finds the tab that shows the configured chat. With no such tab, it can still recognize the
   * last known chat tab on Chrome's error page. More than one chat tab is the operator's to fix.
   */
  private async locate(): Promise<{ page: ChatPage; errorPage?: true } | undefined> {
    const { pages } = await this.tool("list_pages", {});
    const entries = Array.isArray(pages) ? pages.filter(isRecord) : [];
    const matches = entries.filter((entry) => this.matchesSessionUrl(entry.url));
    if (matches.length > 1) throw new BridgeError("TARGET_UNAVAILABLE", NOT_READY.missing);
    const id = matches[0]?.id;
    if (typeof id === "number") return { page: this.lastPage = { id, epoch: this.epoch } };
    const last = this.lastPage;
    const errorTab = last && last.epoch === this.epoch && entries.some((entry) =>
      entry.id === last.id && typeof entry.url === "string" && entry.url.startsWith("chrome-error:"));
    return last && errorTab ? { page: last, errorPage: true } : undefined;
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
      throw new BridgeError("TARGET_UNAVAILABLE", NOT_READY.missing);
    }
    return this.lastPage = { id, epoch: this.epoch };
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

  /** Reads the page's own projection. A chat that is not ready is reported, not refused. */
  private async readProjection(page: ChatPage, turnKey?: string, errorPage = false): Promise<RecordValue> {
    const script = `() => (${browserTranscriptScript})(${JSON.stringify(this.options.sessionUrl)}, ${JSON.stringify(turnKey ?? null)}, ${JSON.stringify(this.route?.uuidRoute ?? null)})`;
    const { message } = await this.tool("evaluate_script", { function: script, waitForStableDom: false }, page);
    const body = typeof message === "string" && /^Script ran on page and returned:\n```json\n([\s\S]*)\n```$/.exec(message)?.[1];
    let projection: unknown;
    try {
      projection = body ? JSON.parse(body) : undefined;
    } catch {
      throw new BridgeError("TARGET_UNAVAILABLE", "Chrome returned an unreadable chat snapshot.");
    }
    if (!isRecord(projection) || typeof projection.busy !== "boolean" || !Array.isArray(projection.messages)) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Chrome returned an unreadable chat snapshot.");
    }
    // A projection without health only knows whether the chat is ready.
    const health = typeof projection.health === "string"
      ? projection.health
      : projection.ready === true ? "ready" : "loading";
    if (errorPage || health === "error_page") return { ...projection, ready: false, health: "error_page" };
    if (health === "wrong_url" || !this.matchesSessionUrl(projection.url)) {
      return { ...projection, ready: false, health: "wrong_url" };
    }
    return { ...projection, health, ready: health === "ready" && projection.ready === true };
  }

  /** Reads a chat that must be ready, for preflight. */
  async read(turnKey?: string): Promise<string> {
    return JSON.stringify(await this.recovering(await this.page(), async (page) => {
      const projection = await this.readProjection(page, turnKey);
      if (projection.ready !== true) throw new BrowserNotReady(notReadyHealth(projection.health));
      return projection;
    }));
  }

  /** Reads the chat as it is, including why it is not ready. Changes nothing. */
  async observe(turnKey: string): Promise<ChatObservation> {
    const found = await this.locate();
    if (!found) return { health: "missing", busy: false };
    return await this.recovering(found.page, async (page, retry) => {
      const projection = await this.readProjection(page, turnKey, !retry && found.errorPage === true);
      const health = projection.health as BrowserPageHealth;
      const draft = typeof projection.draft === "string" ? projection.draft as BrowserDraftKind : undefined;
      return {
        health,
        ...(draft ? { draft } : {}),
        busy: projection.busy === true,
        ...(health === "ready" ? { transcript: JSON.stringify(projection) } : {}),
      };
    });
  }

  /**
   * Reloads the chat tab, or opens it again when no tab shows it. A page that warns about unsent
   * changes (such as offline messages waiting to reconnect) keeps them: its warning is dismissed.
   */
  async reload(): Promise<ReloadOutcome> {
    const timeout = this.options.navigationTimeoutMs ?? 30_000;
    const found = await this.locate();
    if (!found) {
      if (!this.tools.has("new_page")) return "unsupported";
      const reply = await this.call("new_page", { url: this.options.sessionUrl, background: true, timeout }, undefined, timeout + 15_000);
      if (isRecord(reply.structuredContent) && reply.structuredContent.reconnected === true) this.epoch++;
      return navigationOutcome(reply as { structuredContent?: unknown; content?: unknown; isError?: unknown });
    }
    if (!this.tools.has("navigate_page")) return "unsupported";
    try {
      const content = await this.tool("navigate_page", { type: "reload", handleBeforeUnload: "dismiss", timeout },
        found.page, timeout + 15_000);
      return navigationOutcome({ structuredContent: content });
    } catch (error) {
      // A renumbered tab was never reloaded. The next read resolves it again.
      if (error instanceof StalePage) return "failed";
      if (error instanceof BridgeError && /\(tool_error\)/.test(error.message)) return "failed";
      throw error;
    }
  }

  /**
   * Inspects the composer. `before_claim` and `claimed` need a ready, idle chat. `lenient` reports
   * the chat's state and, whenever the composer can be named, its value.
   */
  private async inspectComposer(page: ChatPage, mode: "before_claim" | "claimed" | "lenient"): Promise<ComposerState> {
    const proj = await this.readProjection(page);
    const health = proj.health as BrowserPageHealth;
    if (mode !== "lenient" && health !== "ready") throw new BrowserNotReady(notReadyHealth(health));
    if (mode !== "lenient" && proj.busy === true) {
      throw mode === "claimed"
        ? new BridgeError("RECONCILIATION_UNCERTAIN", "Robo started responding before submission; inspect the chat.")
        : new BridgeError("BUSY_ACTIVE_TURN", "Robo is already responding in the configured chat.");
    }
    const ctl = proj.controls;
    if (!isRecord(ctl) || typeof ctl.composerLabel !== "string" || !ctl.composerLabel.trim()) {
      if (mode === "lenient") return { page, health, busy: proj.busy === true };
      throw new BridgeError("TARGET_UNAVAILABLE", "Could not identify the chat composer's accessible name.");
    }
    const { snapshot } = await this.tool("take_snapshot", {}, page);
    if (!isRecord(snapshot) || snapshot.role !== "RootWebArea" || !this.matchesSessionUrl(snapshot.url)) {
      throw new BridgeError("TARGET_UNAVAILABLE", "The tab no longer displays the configured Robo chat.");
    }
    const stopping = controls(snapshot, "button", labelSet(ctl.stopLabel, STOP)).length > 0;
    if (stopping && mode === "before_claim") throw new BridgeError("BUSY_ACTIVE_TURN", "Robo is already responding in the configured chat.");
    if (stopping && mode === "claimed") {
      throw new BridgeError("RECONCILIATION_UNCERTAIN", "Robo started responding before submission; inspect the chat.");
    }
    const boxes = controls(snapshot, "textbox", [ctl.composerLabel]);
    const box = boxes.length === 1 && typeof boxes[0]!.id === "string" ? boxes[0]! : undefined;
    if (!box && mode !== "lenient") {
      throw new BridgeError("TARGET_UNAVAILABLE", `Could not identify the ${ctl.composerLabel} composer in this chat.`);
    }
    return {
      page,
      health,
      busy: proj.busy === true || stopping,
      snap: snapshot,
      ...(box ? { composer: { id: box.id as string, value: typeof box.value === "string" ? box.value : "" } } : {}),
      sendNames: labelSet(ctl.sendLabel, SEND),
    };
  }

  /**
   * Types `text` and clicks send. The claim runs exactly once, right before the first change that
   * belongs to this message. A stale bridge draft of another message is cleared first; the
   * operator's own draft is never touched. When the chat cannot send yet (still loading or
   * reconnecting), the draft stays in the composer and the outcome is `typed`.
   */
  async send(text: string, claim: () => boolean): Promise<SendOutcome> {
    // HTML textareas normalize Windows line endings in their value.
    const draftText = text.replace(/\r\n?/g, "\n");
    // Nothing that belongs to this message changes before the claim, so a reconnect only repeats these checks.
    const initial = await this.recovering(await this.page(), async (page) => {
      let state = await this.inspectComposer(page, "before_claim");
      const value = state.composer?.value ?? "";
      if (value !== "" && value !== draftText) {
        if (!isBridgeDraft(value)) {
          throw new BridgeError("BUSY_ACTIVE_TURN", "The chat has a draft. Leave the composer empty before starting a turn.");
        }
        // An earlier attempt typed this for another message and never sent it. It must not pile up.
        await this.page(page);
        await this.tool("fill", { uid: state.composer!.id, value: "" }, page);
        state = await this.inspectComposer(page, "before_claim");
        if ((state.composer?.value ?? "") !== "") {
          throw new BridgeError("BUSY_ACTIVE_TURN", "A stale bridge draft could not be cleared from the composer.");
        }
      }
      const typed = (state.composer?.value ?? "") === draftText;
      if (!typed && controls(state.snap!, "button", state.sendNames!).some((node) => node.disabled !== true)) {
        throw new BridgeError("BUSY_ACTIVE_TURN", "The chat has a draft. Leave the composer empty before starting a turn.");
      }
      await this.page(page);
      return { ...state, typed };
    });
    if (!claim()) return "unclaimed";
    // An action is repeated only after its first attempt provably never ran and the tab,
    // inspected again under its new id, still shows exactly the state the action expects.
    const filledPage = initial.typed ? initial.page : await this.recovering(initial.page, async (page, retry) => {
      const empty = retry ? await this.inspectComposer(page, "claimed") : initial;
      const before = empty.composer?.value ?? "";
      if (retry && before === draftText) return page;
      if (retry && before !== "") {
        throw new BridgeError("RECONCILIATION_UNCERTAIN", "The browser draft changed before submission; inspect the chat.");
      }
      if (retry) await this.page(page);
      await this.tool("fill", { uid: empty.composer!.id, value: draftText }, page);
      return page;
    });
    return await this.clickTyped(filledPage, draftText);
  }

  /** Clicks send for a draft that is already exactly in the composer. Never types. */
  private async clickTyped(start: ChatPage, draftText: string, claim?: () => boolean): Promise<SendOutcome> {
    let claimed = !claim;
    return await this.recovering(start, async (page) => {
      const filled = await this.inspectComposer(page, "lenient");
      if (!filled.composer) return "typed";
      if (filled.composer.value !== draftText) {
        throw new BridgeError("RECONCILIATION_UNCERTAIN", "The browser draft changed before submission; inspect the chat.");
      }
      const button = enabledControl(filled.snap!, "button", filled.sendNames!);
      // Still loading, reconnecting or answering: the draft waits in the composer.
      if (filled.health !== "ready" || filled.busy || !button) return "typed";
      await this.page(page);
      if (!claimed) {
        if (!claim!()) return "unclaimed";
        claimed = true;
      }
      await this.tool("click", { uid: button.id }, page);
      return "sent";
    });
  }

  /**
   * Sends a draft that an earlier attempt typed but could not send. It clicks only when the
   * composer holds exactly `text`, the chat is ready and idle, and `claim` allows it.
   */
  async submitTyped(text: string, claim: () => boolean): Promise<SendOutcome> {
    return await this.clickTyped(await this.page(), text.replace(/\r\n?/g, "\n"), claim);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

interface ComposerState {
  page: ChatPage;
  health: BrowserPageHealth;
  busy: boolean;
  snap?: RecordValue;
  composer?: { id: string; value: string };
  sendNames?: string[];
}

function notReadyHealth(health: unknown): Exclude<BrowserPageHealth, "ready"> {
  return typeof health === "string" && health !== "ready" && health in NOT_READY
    ? health as Exclude<BrowserPageHealth, "ready">
    : "loading";
}

/** Classifies a reload or reopen reply. Raw text, which can name the URL, stays here. */
function navigationOutcome(reply: { structuredContent?: unknown; content?: unknown; isError?: unknown }): ReloadOutcome {
  const content = reply.structuredContent;
  const message = isRecord(content) && typeof content.message === "string" ? content.message : "";
  const text = Array.isArray(reply.content)
    ? reply.content.map((part: unknown) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n")
    : "";
  if (NETWORK_ERROR.test(message) || NETWORK_ERROR.test(text)) return "offline";
  if (/Dismissed a beforeunload dialog/.test(message)) return "blocked";
  if (reply.isError === true || /Unable to (?:reload|navigate)/.test(message)) return "failed";
  return "reloaded";
}
