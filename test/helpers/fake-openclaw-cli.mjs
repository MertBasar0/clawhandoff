#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Stateful file-backed fake OpenClaw Gateway CLI for behavioral & crash-reconnect tests.
 * Driven via `FAKE_GATEWAY_STATE_FILE` in the environment.
 * Honors isolated profile rule: refuses if OPENCLAW_GATEWAY_URL override leaked into env!
 */
if (process.env.OPENCLAW_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_TOKEN) {
  process.stderr.write("Ambient OPENCLAW_GATEWAY_* env var leaked into isolated CLI call!\n");
  process.exit(2);
}

const statePath = process.env.FAKE_GATEWAY_STATE_FILE;
if (!statePath || !existsSync(statePath)) {
  process.stderr.write("FAKE_GATEWAY_STATE_FILE missing\n");
  process.exit(2);
}

const args = process.argv.slice(2);
// Expected: gateway call <method> --json --timeout <ms> --params <json>
if (args[0] !== "gateway" || args[1] !== "call") {
  process.stderr.write(`Unexpected CLI args: ${args.join(" ")}\n`);
  process.exit(2);
}

const method = args[2];
const paramsIdx = args.indexOf("--params");
const params = paramsIdx >= 0 && args[paramsIdx + 1] ? JSON.parse(args[paramsIdx + 1]) : {};

const state = JSON.parse(readFileSync(statePath, "utf8"));
state.rpcCounts = state.rpcCounts ?? {};
state.rpcCounts[method] = (state.rpcCounts[method] ?? 0) + 1;
state.sessions = state.sessions ?? {};
state.runs = state.runs ?? {};
state.createIdempotency = state.createIdempotency ?? {};
state.sendIdempotency = state.sendIdempotency ?? {};

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

if (state.simulateCloudflareExpired) {
  save();
  process.stderr.write('Exec provider "cloudflare-access" exited with code 1 (HTTP 302)\n');
  process.exit(1);
}

switch (method) {
  case "health": {
    save();
    process.stdout.write(JSON.stringify({ ok: true }));
    break;
  }

  case "agents.list": {
    save();
    process.stdout.write(
      JSON.stringify({
        ok: true,
        defaultId: "main",
        agents: [{ id: "main", name: "Main Robo" }],
      }),
    );
    break;
  }

  case "sessions.create": {
    const idem = params.idempotencyKey;
    if (idem && state.createIdempotency[idem]) {
      const cached = state.createIdempotency[idem];
      save();
      // Matches OpenClaw `session-create-initial-turn.ts:99-108`: cached replay sets runStarted:false!
      process.stdout.write(
        JSON.stringify({
          ...cached,
          runStarted: false,
        }),
      );
      break;
    }

    const sessionKey = params.key ?? `agent:${params.agentId ?? "main"}:${randomUUID()}`;
    const sessionId = `sid_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const queuedReply = (state.queuedTurnReplies ?? []).shift() ?? {
      pollsBeforeComplete: 0,
      replyText: "Default reply",
    };

    state.sessions[sessionKey] = {
      key: sessionKey,
      sessionId,
      agentId: params.agentId ?? "main",
      label: params.label,
      status: "running",
      aborted: false,
      messages: [
        {
          id: `msg_u_${randomUUID()}`,
          role: "user",
          idempotencyKey: `${runId}:user`,
          content: params.message,
        },
      ],
    };

    state.runs[runId] = {
      runId,
      sessionKey,
      pollsRemaining: queuedReply.pollsBeforeComplete ?? 0,
      replyText: queuedReply.replyText,
      createdPr: queuedReply.createdPr,
      failError: queuedReply.failError ?? null,
      completed: false,
      aborted: false,
    };

    const responsePayload = {
      ok: true,
      key: sessionKey,
      sessionId,
      runId,
      runStarted: true,
      status: "started",
      worktree: params.projectId
        ? {
            id: `wt_${randomUUID()}`,
            path: `/srv/worktrees/${params.worktreeName ?? "auto"}`,
            branch: `openclaw/${params.worktreeName ?? "auto"}`,
          }
        : undefined,
    };

    if (idem) {
      state.createIdempotency[idem] = responsePayload;
    }

    // Optional fault injection: drop network AFTER server committed session!
    if (state.dropNextCreateResponseOnce) {
      state.dropNextCreateResponseOnce = false;
      save();
      process.stderr.write("Simulated network reset after server commit\n");
      process.exit(1);
    }

    save();
    process.stdout.write(JSON.stringify(responsePayload));
    break;
  }

  case "sessions.describe": {
    const s = state.sessions[params.key];
    save();
    if (!s) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: "INVALID_REQUEST" } }));
      break;
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        session: {
          key: s.key,
          sessionId: s.sessionId,
          agentId: s.agentId,
          label: s.label,
          updatedAt: Date.now(),
        },
      }),
    );
    break;
  }

  case "chat.send": {
    const s = state.sessions[params.sessionKey];
    if (!s) {
      save();
      process.stdout.write(JSON.stringify({ ok: false, error: "Session not found" }));
      break;
    }
    const idem = params.idempotencyKey;
    if (idem && state.sendIdempotency[idem]) {
      const cachedRunId = state.sendIdempotency[idem];
      save();
      process.stdout.write(JSON.stringify({ ok: true, runId: cachedRunId, status: "in_flight" }));
      break;
    }

    const runId = params.idempotencyKey;
    const queuedReply = (state.queuedTurnReplies ?? []).shift() ?? {
      pollsBeforeComplete: 0,
      replyText: "Default follow-up reply",
    };

    s.messages.push({
      id: `msg_u_${randomUUID()}`,
      role: "user",
      idempotencyKey: `${runId}:user`,
      content: params.message,
    });
    s.status = "running";

    state.runs[runId] = {
      runId,
      sessionKey: s.key,
      pollsRemaining: queuedReply.pollsBeforeComplete ?? 0,
      replyText: queuedReply.replyText,
      createdPr: queuedReply.createdPr,
      failError: queuedReply.failError ?? null,
      completed: false,
      aborted: false,
    };

    if (idem) {
      state.sendIdempotency[idem] = runId;
    }

    if (state.dropNextSendResponseOnce) {
      state.dropNextSendResponseOnce = false;
      save();
      process.stderr.write("Simulated network reset after chat.send commit\n");
      process.exit(1);
    }

    save();
    process.stdout.write(JSON.stringify({ ok: true, runId, status: "started" }));
    break;
  }

  case "agent.wait": {
    const run = state.runs[params.runId];
    if (!run) {
      save();
      process.stdout.write(JSON.stringify({ runId: params.runId, status: "timeout" }));
      break;
    }
    if (run.aborted) {
      save();
      process.stdout.write(
        JSON.stringify({
          ok: true,
          runId: run.runId,
          status: "error",
          stopReason: "aborted",
        }),
      );
      break;
    }
    if (run.pollsRemaining > 0) {
      run.pollsRemaining -= 1;
      save();
      // Matches OpenClaw `agent-wait.ts:73`: slice timeout while still running!
      process.stdout.write(
        JSON.stringify({
          ok: true,
          runId: run.runId,
          status: "timeout",
        }),
      );
      break;
    }

    if (run.failError) {
      const s = state.sessions[run.sessionKey];
      if (s) s.status = "idle";
      save();
      process.stdout.write(
        JSON.stringify({
          ok: true,
          runId: run.runId,
          status: "timeout",
          endedAt: Date.now(),
          timeoutPhase: "provider",
          providerStarted: true,
          stopReason: run.failError,
        }),
      );
      break;
    }

    if (!run.completed) {
      run.completed = true;
      if (run.createdPr) (state.openPrs ??= []).push(run.createdPr);
      const s = state.sessions[run.sessionKey];
      if (s) {
        s.status = "idle";
        s.messages.push({
          id: `msg_a_${randomUUID()}`,
          role: "assistant",
          content: [{ type: "text", text: run.replyText }],
          __openclaw: {
            id: `oc_${randomUUID()}`,
            runId: run.runId,
            recordTimestampMs: Date.now(),
          },
        });
      }
    }

    save();
    process.stdout.write(
      JSON.stringify({
        ok: true,
        runId: run.runId,
        status: "ok",
        terminalReply: {
          disposition: "visible",
          text: run.replyText,
        },
      }),
    );
    break;
  }

  case "chat.history": {
    const s = state.sessions[params.sessionKey];
    save();
    if (!s) {
      process.stdout.write(JSON.stringify({ ok: false, error: "Session not found" }));
      break;
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        sessionKey: s.key,
        sessionId: s.sessionId,
        sessionInfo: { sessionId: s.sessionId, status: s.status, lastRunId: s.lastRunId, hasActiveRun: s.status === "running" },
        messages: s.messages,
      }),
    );
    break;
  }

  case "chat.abort": {
    const s = state.sessions[params.sessionKey];
    const run = state.runs[params.runId];
    const aborted = Boolean(s && run?.sessionKey === s.key && !run.completed && !run.aborted);
    if (aborted) {
      run.aborted = true;
      s.aborted = true;
      s.status = "aborted";
    }
    save();
    process.stdout.write(JSON.stringify({ ok: true, aborted, runIds: aborted ? [params.runId] : [] }));
    break;
  }

  default: {
    save();
    process.stderr.write(`Unsupported fake RPC method: ${method}\n`);
    process.exit(2);
  }
}
