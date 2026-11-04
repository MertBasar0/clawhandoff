import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError, type BridgeConfig, type GatewayTargetConfig } from "./types.js";

const GatewayTargetSchema = z.object({
  transport: z.literal("gateway").optional(),
  targetId: z.string().min(1),
  url: z.string().min(1),
  authMode: z.enum(["edge-cloudflare", "direct-token", "existing-profile"]),
  agentId: z.string().min(1).default("main"),
  projectId: z.string().min(1).optional(),
  cliPath: z.string().min(1).optional(),
  cloudflaredPath: z.string().min(1).optional(),
  tokenEnvVar: z.string().min(1).optional(),
  profileDir: z.string().min(1).optional(),
  rpcTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

function decodeSessionSegment(segment: string): string | null {
  if (!segment || !/^[a-zA-Z0-9._~%-]+$/.test(segment) || segment === "." || segment === "..") {
    return null;
  }
  if (segment === "~dot") return ".";
  if (segment === "~dotdot") return "..";
  try {
    return decodeURIComponent(segment.startsWith("~~") ? segment.slice(1) : segment) || null;
  } catch {
    return null;
  }
}

const BrowserTargetSchema = z.object({
  transport: z.literal("browser"),
  targetId: z.string().min(1),
  agentId: z.string().min(1),
  sessionUrl: z.string().url(),
  browserMcp: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }).strict(),
}).strict().refine((target) => {
  try {
    const url = new URL(target.sessionUrl);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.href !== target.sessionUrl || url.pathname.endsWith("/")
    ) {
      return false;
    }
    const parts = url.pathname.slice(1).split("/");
    if (!parts.every((part) => decodeSessionSegment(part) !== null)) return false;
    const nsIndex = parts.findIndex((part) => part === "chat" || part === "dashboard");
    if (nsIndex < 0) return false;
    const agent = decodeSessionSegment(parts[nsIndex + 1] ?? "")?.toLowerCase();
    if (agent !== target.agentId.trim().toLowerCase()) return false;
    const rest = parts[nsIndex + 2] === "~key" ? parts.slice(nsIndex + 3) : parts.slice(nsIndex + 2);
    return rest.length >= 1;
  } catch {
    return false;
  }
}, { path: ["sessionUrl"], message: "Use the exact HTTPS /chat/<agentId>/<session...> (or /dashboard/<agentId>/<session...>) URL without credentials, query, or fragment." });

const BridgeConfigFileSchema = z.object({
  dataDir: z.string().min(1).optional(),
  ghCliPath: z.string().min(1).optional(),
  defaultWaitBudgetMs: z.number().int().min(0).max(120_000).optional(),
  defaultMaxAutonomousTurns: z.number().int().min(1).max(15).optional(),
  targets: z.record(z.string(), z.union([BrowserTargetSchema, GatewayTargetSchema])),
});

export function loadBridgeConfig(explicitConfigPath?: string): BridgeConfig {
  const defaultDataDir =
    process.env.AGENT_BRIDGE_DATA_DIR ?? join(homedir(), ".agent-bridge-mcp");

  const configPath = explicitConfigPath ?? process.env.AGENT_BRIDGE_CONFIG_PATH;
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new BridgeError(
        "INVALID_INPUT",
        `Bridge config file not found at "${configPath}".`,
      );
    }
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    const parsed = BridgeConfigFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BridgeError(
        "INVALID_INPUT",
        `Invalid bridge config file: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    return {
      dataDir: parsed.data.dataDir ?? defaultDataDir,
      ghCliPath: parsed.data.ghCliPath ?? process.env.AGENT_BRIDGE_GH_CLI,
      defaultWaitBudgetMs: parsed.data.defaultWaitBudgetMs,
      defaultMaxAutonomousTurns: parsed.data.defaultMaxAutonomousTurns,
      targets: parsed.data.targets,
    };
  }

  // Zero-config compatibility with standard OPENCLAW_HANDOFF_* operator environment variables.
  const targets: Record<string, GatewayTargetConfig> = {};
  const handoffUrl = process.env.OPENCLAW_HANDOFF_URL;
  if (handoffUrl) {
    const targetId = process.env.OPENCLAW_HANDOFF_TARGET_ID ?? "robo";
    const authMode =
      (process.env.OPENCLAW_HANDOFF_AUTH_MODE as GatewayTargetConfig["authMode"] | undefined) ??
      "edge-cloudflare";
    targets[targetId] = {
      targetId,
      url: handoffUrl,
      authMode,
      agentId: process.env.OPENCLAW_HANDOFF_AGENT ?? "main",
      projectId: process.env.OPENCLAW_HANDOFF_PROJECT,
      cliPath: process.env.OPENCLAW_HANDOFF_CLI,
      cloudflaredPath: process.env.OPENCLAW_HANDOFF_CLOUDFLARED,
      profileDir: process.env.OPENCLAW_HANDOFF_PROFILE_DIR,
    };
  }

  return {
    dataDir: defaultDataDir,
    ghCliPath: process.env.AGENT_BRIDGE_GH_CLI,
    targets,
  };
}
