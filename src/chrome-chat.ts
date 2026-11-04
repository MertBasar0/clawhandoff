import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserTranscriptScript } from "./browser-turn.js";
import { BridgeError } from "./types.js";

export interface ChromeChatOptions {
  command: string;
  args: string[];
  sessionUrl: string;
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SEND = ["Send message", "Mesaj gönder"];
const STOP = ["Stop", "Stop generating", "Durdur", "Yanıt oluşturmayı durdur"];

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

export class ChromeChat {
  private readonly client = new Client({ name: "clawhandoff-browser", version: "0.2.0" });
  private connected?: Promise<void>;

  constructor(private readonly options: ChromeChatOptions) {
    // A later attach can reconnect if Chrome or its local MCP process exited.
    this.client.onclose = () => { this.connected = undefined; };
  }

  private connect(): Promise<void> {
    return this.connected ??= this.open().catch((error: unknown) => {
      this.connected = undefined;
      throw error;
    });
  }

  private async open(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [
        ...this.options.args,
        ...(this.options.args.includes("--autoConnect") ? [] : ["--autoConnect"]),
        "--experimentalStructuredContent",
      ],
      stderr: "ignore",
    });
    try {
      await this.client.connect(transport, { timeout: 30_000 });
      const { tools } = await this.client.listTools();
      for (const name of ["take_snapshot", "evaluate_script", "fill", "click"]) {
        if (!tools.find((tool) => tool.name === name)?.inputSchema.properties?.pageId) {
          throw new Error("Chrome DevTools MCP does not support explicit page IDs");
        }
      }
    } catch {
      await transport.close();
      throw new BridgeError("TARGET_UNAVAILABLE", "Could not start a compatible Chrome DevTools MCP. Check the executable and its pageId support.");
    }
  }

  private async tool(name: string, args: RecordValue): Promise<RecordValue> {
    await this.connect();
    // Raw tool errors can include unrelated tabs, URLs, or browser state.
    try {
      const reply = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 75_000 });
      if (reply.isError || !isRecord(reply.structuredContent) || reply.structuredContent.reconnected === true) {
        throw new Error();
      }
      return reply.structuredContent;
    } catch {
      throw new BridgeError("TARGET_UNAVAILABLE", `Chrome DevTools MCP could not complete ${name}. Check the open chat and Chrome's local attachment permission.`);
    }
  }

  private async page(expectedId?: number): Promise<number> {
    const { pages } = await this.tool("list_pages", {});
    const matches = Array.isArray(pages)
      ? pages.filter((entry): entry is RecordValue => isRecord(entry) && entry.url === this.options.sessionUrl)
      : [];
    const id = matches[0]?.id;
    if (matches.length !== 1 || typeof id !== "number" || (expectedId !== undefined && id !== expectedId)) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Open exactly one tab at the configured Robo chat URL and keep it open.");
    }
    return id;
  }

  private async readProjection(pageId: number, turnKey?: string): Promise<RecordValue> {
    const script = `() => (${browserTranscriptScript})(${JSON.stringify(this.options.sessionUrl)}, ${JSON.stringify(turnKey ?? null)})`;
    const { message } = await this.tool("evaluate_script", { pageId, function: script, waitForStableDom: false });
    const body = typeof message === "string" && /^Script ran on page and returned:\n```json\n([\s\S]*)\n```$/.exec(message)?.[1];
    let projection: unknown;
    try {
      projection = body ? JSON.parse(body) : undefined;
    } catch {
      throw new BridgeError("TARGET_UNAVAILABLE", "Chrome returned an unreadable chat snapshot.");
    }
    if (!isRecord(projection) || projection.url !== this.options.sessionUrl ||
        projection.ready !== true || typeof projection.busy !== "boolean" || !Array.isArray(projection.messages)) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Open the configured chat and wait for its transcript and composer to finish loading.");
    }
    return projection;
  }

  async read(turnKey?: string): Promise<string> {
    const pageId = await this.page();
    return JSON.stringify(await this.readProjection(pageId, turnKey));
  }

  private async composerSnapshot(pageId: number, stopNames: readonly string[]): Promise<RecordValue> {
    const { snapshot } = await this.tool("take_snapshot", { pageId });
    if (!isRecord(snapshot) || snapshot.role !== "RootWebArea" || snapshot.url !== this.options.sessionUrl) {
      throw new BridgeError("TARGET_UNAVAILABLE", "The tab no longer displays the configured Robo chat.");
    }
    if (controls(snapshot, "button", stopNames).length > 0) {
      throw new BridgeError("BUSY_ACTIVE_TURN", "Robo is already responding in the configured chat.");
    }
    return snapshot;
  }

  private async inspectComposer(
    pageId: number,
    busyCode: "BUSY_ACTIVE_TURN" | "RECONCILIATION_UNCERTAIN",
    busyMessage: string,
  ) {
    const proj = await this.readProjection(pageId);
    if (proj.busy === true) throw new BridgeError(busyCode, busyMessage);
    const ctl = proj.controls;
    if (!isRecord(ctl) || typeof ctl.composerLabel !== "string" || !ctl.composerLabel.trim()) {
      throw new BridgeError("TARGET_UNAVAILABLE", "Could not identify the chat composer's accessible name.");
    }
    const snap = await this.composerSnapshot(pageId, labelSet(ctl.stopLabel, STOP));
    return {
      snap,
      composer: oneEnabled(snap, "textbox", [ctl.composerLabel]),
      sendNames: labelSet(ctl.sendLabel, SEND),
    };
  }

  async send(text: string, claim: () => boolean): Promise<void> {
    // HTML textareas normalize Windows line endings in their value.
    const draftText = text.replace(/\r\n?/g, "\n");
    const pageId = await this.page();
    const initial = await this.inspectComposer(pageId, "BUSY_ACTIVE_TURN", "Robo is already responding in the configured chat.");
    if ((initial.composer.value ?? "") !== "" || controls(initial.snap, "button", initial.sendNames).some((node) => !node.disabled)) {
      throw new BridgeError("BUSY_ACTIVE_TURN", "The chat has a draft. Leave the composer empty before starting a turn.");
    }
    await this.page(pageId);
    if (!claim()) return;
    await this.tool("fill", { pageId, uid: initial.composer.id, value: draftText });

    const filled = await this.inspectComposer(pageId, "RECONCILIATION_UNCERTAIN", "Robo started responding before submission; inspect the chat.");
    if (filled.composer.value !== draftText) {
      throw new BridgeError("RECONCILIATION_UNCERTAIN", "The browser draft changed before submission; inspect the chat.");
    }
    const button = oneEnabled(filled.snap, "button", filled.sendNames);
    await this.page(pageId);
    await this.tool("click", { pageId, uid: button.id });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
