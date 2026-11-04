import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeService } from "./bridge-service.js";
import {
  AbortHandoffInputSchema,
  AttachHandoffInputSchema,
  ContinueHandoffInputSchema,
  PreflightInputSchema,
  StartHandoffInputSchema,
  VerifyGitInputSchema,
} from "./schema.js";
import { BridgeError } from "./types.js";

function formatToolSuccess(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatToolError(err: unknown) {
  if (err instanceof BridgeError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              errorCode: err.code,
              message: err.message,
              ...(err.remediation ? { remediation: err.remediation } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            errorCode: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function createBridgeMcpServer(service: BridgeService): McpServer {
  const server = new McpServer({
    name: "agent-bridge-mcp",
    version: "0.2.0",
  });

  server.registerPrompt(
    "autonomous-handoff",
    {
      title: "Autonomous Handoff & Counter-Evidence Resolution Loop",
      description:
        "Binds the local primary agent as goal owner across remote OpenClaw handoffs so intermediate objections or missing-proof requests are resolved autonomously with local evidence instead of relayed to the human.",
      argsSchema: {
        targetId: z.string().default("robo"),
        goal: z.string(),
      },
    },
    ({ targetId, goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `You are the local Goal Owner orchestrating target "${targetId}" to complete: ${goal}`,
              "",
              "Mandatory Autonomous Loop Contract:",
              "1. Resolve moving Git refs (`origin/main`, branch names) to exact 40-char commit SHAs before calling `bridge_handoff_start`.",
              "2. Choose a single `publisherOwner` (`local` by default, or `remote_gated` when managed remote bot identity is required).",
              "3. Never act as a passive message courier. When `orchestratorDirective.action` is:",
              "   - `POLL_ATTACH`: call `bridge_handoff_attach` (do not start a second session).",
              "   - `CONTINUE_AUTONOMOUSLY`: inspect `reported.blockers` against local commits, builds, and tests. If the objection is a false premise or already satisfied, cite commit-bound proof via `bridge_handoff_continue`. If a genuine in-scope gap exists, fix/test locally, push the updated ref, and call `bridge_handoff_continue` without pausing to ask the human.",
              "   - `AUTHORIZE_REMOTE_PUBLISH`: `observed` Git verification passed; call `bridge_handoff_continue(intent='authorize_publish')` to unlock Stage-2 managed PR creation for the exact verified commit.",
              "   - `COMPLETE`: present the result and distinguish observed facts from reported checks. `PUBLISH_LOCALLY`: the authorized local owner acts on the exact verified commit. `ESCALATE_TO_HUMAN`: report the specific unresolved decision or blocker.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "bridge_preflight",
    {
      title: "Bridge Preflight Check",
      description:
        "Checks OpenClaw Gateway health, authentication readiness, agent availability, and optional non-blocking rival PR warnings before starting a handoff.",
      inputSchema: PreflightInputSchema.shape,
    },
    async (args) => {
      try {
        return formatToolSuccess(await service.preflight(args));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.registerTool(
    "bridge_handoff_start",
    {
      title: "Start Durable Agent Handoff",
      description:
        "Persists write-ahead SQLite intent, opens an isolated OpenClaw Gateway handoff session with pinned 40-char Git SHAs, and observes up to waitBudgetMs. Returns `orchestratorDirective` separating `reported` claims from `observed` Git/PR facts.",
      inputSchema: StartHandoffInputSchema.shape,
    },
    async (args) => {
      try {
        return formatToolSuccess(await service.startHandoff(args));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.registerTool(
    "bridge_handoff_attach",
    {
      title: "Attach & Reconcile Handoff",
      description:
        "Reconnects to an existing `handoffId` after waitBudgetMs expiry, network interruption, or process restart without spawning a duplicate run or duplicate PR.",
      inputSchema: AttachHandoffInputSchema.shape,
    },
    async (args) => {
      try {
        return formatToolSuccess(await service.attachHandoff(args));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.registerTool(
    "bridge_handoff_continue",
    {
      title: "Continue Handoff or Authorize Stage-2 Publish",
      description:
        "Sends counter-evidence, updated pinned Git coordinates, or Stage-2 `authorize_publish` approval into the same remote session (`single-flight` serialized).",
      inputSchema: ContinueHandoffInputSchema.shape,
    },
    async (args) => {
      try {
        return formatToolSuccess(await service.continueHandoff(args));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.registerTool(
    "bridge_verify_git",
    {
      title: "Checkout-Free Git Object Verification",
      description:
        "Fetches a candidate Git ref into an isolated bare mirror without checkout or hooks, verifying `pinnedBaseCommitSha` ancestry, `expectedTreeSha`, and `lockedPaths` since the pinned source commit (or base when no source is supplied).",
      inputSchema: VerifyGitInputSchema.shape,
    },
    async (args) => {
      try {
        return formatToolSuccess(await service.verifyGit(args));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.registerTool(
    "bridge_handoff_abort",
    {
      title: "Abort Remote Handoff Run",
      description:
        "Explicitly cancels the remote OpenClaw run via `chat.abort` (distinct from letting local waitBudgetMs expire).",
      inputSchema: AbortHandoffInputSchema.shape,
    },
    async (args) => {
      try {
        return formatToolSuccess(await service.abortHandoff(args));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  return server;
}
