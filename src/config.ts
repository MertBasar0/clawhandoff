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
  if (!segment || !/^[a-zA-Z0-9._~%!'()*-]+$/.test(segment) || segment === "." || segment === "..") {
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

const RESERVED_SESSION_RESTS = new Set(["main", "global", "boot", "sessions"]);

export function parseBrowserSessionRoute(
  sessionUrl: string,
  basePath?: string,
  expectedAgentId?: string,
): { identity: string; uuidRoute?: { prefix: string; uuid: string } } | null {
  try {
    const url = new URL(sessionUrl);
    if (
      url.protocol !== "https:" || url.origin + url.pathname !== sessionUrl ||
      url.pathname.endsWith("/")
    ) {
      return null;
    }
    const prefix = (basePath ?? "").replace(/\/$/, "") + "/";
    if (!url.pathname.startsWith(prefix)) return null;
    const parts = url.pathname.slice(prefix.length).split("/");
    if (!parts.every((part) => decodeSessionSegment(part) !== null)) return null;
    // OpenClaw uses the deployment mount, not the configured agent, to locate the namespace.
    // Without a mount, namespace words inside a session key must not authorize another agent.
    const candidates = (basePath === undefined ? parts : parts.slice(0, 1)).flatMap((part, index) => {
      if (part !== "chat" && part !== "dashboard") return [];
      const sessionStart = index + (parts[index + 2] === "~key" ? 3 : 2);
      const agent = decodeSessionSegment(parts[index + 1] ?? "")?.toLowerCase();
      return sessionStart < parts.length && agent ? [{ index, namespace: part, agent }] : [];
    });
    if (candidates.length !== 1) return null;
    const { index, namespace, agent } = candidates[0]!;
    if (expectedAgentId !== undefined && agent !== expectedAgentId.trim().toLowerCase()) return null;
    // OpenClaw Control UI rewrites the mutable display-name slug before a full 32-hex session UUID.
    if (parts.length === index + 3) {
      const segment = decodeSessionSegment(parts[index + 2]!)!;
      const uuid = !RESERVED_SESSION_RESTS.has(segment.toLowerCase())
        ? /^(?:.*-)?([0-9a-f]{32})$/iu.exec(segment)?.[1]?.toLowerCase()
        : undefined;
      if (uuid) {
        const mount = `${url.origin}${prefix}${parts.slice(0, index).join("/")}`.replace(/\/$/, "");
        return {
          identity: `${mount}/${namespace}/${encodeURIComponent(agent)}#${uuid}`,
          uuidRoute: { prefix: `${url.origin}${prefix}${parts.slice(0, index + 2).join("/")}/`, uuid },
        };
      }
    }
    return { identity: sessionUrl };
  } catch {
    return null;
  }
}

export function sameBrowserSessionUrl(a: string, b: string, basePath?: string): boolean {
  if (a === b) return true;
  const left = parseBrowserSessionRoute(a, basePath);
  const right = parseBrowserSessionRoute(b, basePath);
  return left !== null && right !== null && left.identity === right.identity;
}

const BrowserTargetSchema = z.object({
  transport: z.literal("browser"),
  targetId: z.string().min(1),
  agentId: z.string().min(1),
  sessionUrl: z.string().url(),
  basePath: z.string().regex(/^(?:\/[^/?#\\]+)*\/?$/, "Use an absolute UI mount path, or / for the root.").optional(),
  browserMcp: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  }).strict(),
}).strict().refine((target) => parseBrowserSessionRoute(target.sessionUrl, target.basePath, target.agentId) !== null, { path: ["sessionUrl"], message: "Use the exact HTTPS /chat/<agentId>/<session...> (or /dashboard/<agentId>/<session...>) URL without credentials, query, or fragment. If the route is ambiguous, set basePath to the UI mount (/ for the root)." });

const BridgeConfigFileSchema = z.object({
  dataDir: z.string().min(1).optional(),
  ghCliPath: z.string().min(1).optional(),
  defaultWaitBudgetMs: z.number().int().min(0).max(120_000).optional(),
  defaultMaxAutonomousTurns: z.number().int().min(1).max(15).optional(),
  targets: z.record(z.string(), z.union([BrowserTargetSchema, GatewayTargetSchema])),
});

export function loadBridgeConfig(explicitConfigPath?: string): BridgeConfig {
  const defaultDataDir =
    process.env.CLAWHANDOFF_DATA_DIR ?? join(homedir(), ".clawhandoff");

  const configPath = explicitConfigPath ?? process.env.CLAWHANDOFF_CONFIG_PATH;
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
      ghCliPath: parsed.data.ghCliPath ?? process.env.CLAWHANDOFF_GH_CLI,
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
    ghCliPath: process.env.CLAWHANDOFF_GH_CLI,
    targets,
  };
}
