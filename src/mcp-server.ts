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
    name: "clawhandoff",
    version: "0.2.0",
  });

  server.registerPrompt(
    "autonomous-handoff",
    {
      title: "Autonomous Handoff & Counter-Evidence Resolution Loop",
      description:
        "Binds the local primary agent as goal owner across OpenClaw Gateway, browser, A2A, Codex, or ACP agent handoffs so intermediate objections or missing-proof requests are resolved autonomously with local evidence instead of relayed to the human.",
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
              "2. Use `publisherOwner: \"remote_gated\"` by default whenever a pull request is part of the goal (or omit `publisherOwner` to inherit the bridge's `remote_gated` default) so the remote agent publishes through the two-step verified gate under its managed identity. Include any contributor `Co-authored-by:` trailer requirement in Stage 1 before the commit SHA is locked. Use `\"none\"` when no PR is requested, or `\"local\"` only when explicitly configured or requested by the user.",
              "3. Never act as a passive message courier. When `orchestratorDirective.action` is:",
              "   - `POLL_ATTACH`: call `bridge_handoff_attach` (do not start a second session).",
              "   - `CONTINUE_AUTONOMOUSLY`: inspect `reported.blockers` against local commits, builds, and tests. If the objection is a false premise or already satisfied, cite commit-bound proof via `bridge_handoff_continue`. If a genuine in-scope gap exists, fix/test locally (passing `updatedLocalRepoPath` if a worktree was created mid-handoff), push the updated ref, and call `bridge_handoff_continue` without pausing to ask the human.",
              "   - `AUTHORIZE_REMOTE_PUBLISH`: `observed` Git verification passed; call `bridge_handoff_continue(intent='authorize_publish')` to unlock Stage-2 managed PR creation for the exact verified commit.",
              "   - `COMPLETE`: present the result and distinguish observed facts from reported checks. `PUBLISH_LOCALLY`: the authorized local owner acts on the exact verified commit. `ESCALATE_TO_HUMAN`: report the specific unresolved decision or blocker.",
              "   - `RESTORE_BROWSER` (browser targets): relay the concrete step in `reason` (for example restarting Chrome) to the user, then call `bridge_handoff_attach` again. Nothing is resent. `orchestratorDirective.condition` names the browser state.",
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
        "Checks the configured target (OpenClaw Gateway, browser chat, A2A Agent Card, local Codex app-server, or ACP agent) and optional rival PR warnings. Inspect targetHealthy/authReady (and browserReady for browser targets or agentCard for A2A targets).",
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
        "Stores the handoff before sending to an OpenClaw Gateway, browser chat, A2A endpoint, Codex app-server, or ACP agent. `envelope.publisherOwner` defaults to `remote_gated` (or configured `defaultPublisherOwner`) unless overridden. Gateway/Codex/ACP targets support optional isolated `worktreeName`. Observes up to waitBudgetMs and returns `orchestratorDirective` separating `reported` claims from `observed` Git/PR facts.",
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
        "Sends counter-evidence, updated pinned Git coordinates (`updatedSourceCommitSha`, `updatedSourceRemoteRef`, `updatedLocalRepoPath`), or Stage-2 `authorize_publish` approval into the same remote session (`single-flight` serialized).",
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
        "Cancels a Gateway run, A2A task, Codex turn, or ACP prompt by its active ID, or closes an unsent turn. For submitted browser turns (or local abandonment), localOnly=true closes local tracking without stopping the remote session.",
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
