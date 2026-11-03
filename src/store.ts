import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DispatchState,
  HandoffEnvelopeV2,
  LifecycleStatus,
  ObservedResult,
  OrchestratorDirective,
  ReconciledPrState,
  ReportedResult,
  SessionRecord,
  TurnKind,
  TurnRecord,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS handoff_sessions (
  handoff_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  publisher_owner TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  local_repo_path TEXT,
  remote_url_or_path TEXT,
  pinned_base_commit_sha TEXT NOT NULL,
  pinned_source_commit_sha TEXT,
  source_remote_ref TEXT,
  expected_tree_sha TEXT,
  locked_paths_json TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  remote_session_key TEXT,
  remote_session_id TEXT,
  remote_session_url TEXT,
  worktree_name TEXT,
  lifecycle_status TEXT NOT NULL,
  max_autonomous_turns INTEGER NOT NULL,
  same_blocker_streak INTEGER NOT NULL DEFAULT 0,
  last_blocker_fingerprint TEXT,
  verified_publish_head_sha TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS handoff_turns (
  turn_id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoff_sessions(handoff_id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  dispatch_state TEXT NOT NULL,
  run_id TEXT,
  prompt_text TEXT NOT NULL,
  create_params_json TEXT,
  baseline_message_count INTEGER NOT NULL DEFAULT 0,
  raw_reply_text TEXT,
  reported_json TEXT,
  observed_json TEXT,
  directive_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(handoff_id, turn_number)
) STRICT;

CREATE TABLE IF NOT EXISTS publication_ledger (
  handoff_id TEXT PRIMARY KEY REFERENCES handoff_sessions(handoff_id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  head_ref TEXT,
  head_sha TEXT,
  tree_sha TEXT,
  pr_state TEXT NOT NULL,
  pr_url TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_turns_handoff_num ON handoff_turns(handoff_id, turn_number);
`;

type RawRow = Record<string, unknown>;

export class BridgeStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /** Synchronous-only commit section. Never run async work inside fn. */
  withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback error if SQLite already rolled back.
      }
      throw err;
    }
  }

  getSessionByRequestId(requestId: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM handoff_sessions WHERE request_id = ?")
      .get(requestId) as RawRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  getSession(handoffId: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM handoff_sessions WHERE handoff_id = ?")
      .get(handoffId) as RawRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  createInitialIntent(params: {
    session: SessionRecord;
    turn: {
      turnId: string;
      idempotencyKey: string;
      promptText: string;
      createParamsJson: string;
      now: string;
    };
  }): void {
    const { session: s, turn: t } = params;
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO handoff_sessions (
            handoff_id, request_id, workspace_id, target_id, title, mode, publisher_owner,
            repo_id, local_repo_path, remote_url_or_path, pinned_base_commit_sha,
            pinned_source_commit_sha, source_remote_ref, expected_tree_sha, locked_paths_json,
            envelope_json, remote_session_key, remote_session_id, remote_session_url,
            worktree_name, lifecycle_status, max_autonomous_turns, same_blocker_streak,
            last_blocker_fingerprint, verified_publish_head_sha, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          s.handoffId,
          s.requestId,
          s.workspaceId,
          s.targetId,
          s.title,
          s.mode,
          s.publisherOwner,
          s.repoId,
          s.localRepoPath ?? null,
          s.remoteUrlOrPath ?? null,
          s.pinnedBaseCommitSha,
          s.pinnedSourceCommitSha ?? null,
          s.sourceRemoteRef ?? null,
          s.expectedTreeSha ?? null,
          JSON.stringify(s.lockedPaths),
          JSON.stringify(s.envelope),
          s.remoteSessionKey ?? null,
          s.remoteSessionId ?? null,
          s.remoteSessionUrl ?? null,
          s.worktreeName ?? null,
          s.lifecycleStatus,
          s.maxAutonomousTurns,
          s.sameBlockerStreak,
          s.lastBlockerFingerprint ?? null,
          s.verifiedPublishHeadSha ?? null,
          s.createdAt,
          s.updatedAt,
        );

      this.db
        .prepare(
          `INSERT INTO handoff_turns (
            turn_id, handoff_id, turn_number, kind, idempotency_key, dispatch_state,
            run_id, prompt_text, create_params_json, baseline_message_count,
            created_at, updated_at
          ) VALUES (?, ?, 1, 'initial', ?, 'dispatch_pending', NULL, ?, ?, 0, ?, ?)`,
        )
        .run(
          t.turnId,
          s.handoffId,
          t.idempotencyKey,
          t.promptText,
          t.createParamsJson,
          t.now,
          t.now,
        );

      this.db
        .prepare(
          `INSERT INTO publication_ledger (
            handoff_id, repo_id, head_ref, head_sha, tree_sha, pr_state, pr_url, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'none', NULL, ?)`,
        )
        .run(
          s.handoffId,
          s.repoId,
          s.sourceRemoteRef ?? null,
          s.pinnedSourceCommitSha ?? null,
          s.expectedTreeSha ?? null,
          t.now,
        );
    });
  }

  createFollowupIntent(params: {
    handoffId: string;
    turnId: string;
    turnNumber: number;
    kind: TurnKind;
    idempotencyKey: string;
    promptText: string;
    baselineMessageCount: number;
    updatedSourceCommitSha?: string;
    updatedSourceRemoteRef?: string;
    updatedExpectedTreeSha?: string;
    markPublishInFlight?: boolean;
    now: string;
  }): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET lifecycle_status = 'running',
               pinned_source_commit_sha = COALESCE(?, pinned_source_commit_sha),
               source_remote_ref = COALESCE(?, source_remote_ref),
               expected_tree_sha = COALESCE(?, expected_tree_sha),
               updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(
          params.updatedSourceCommitSha ?? null,
          params.updatedSourceRemoteRef ?? null,
          params.updatedExpectedTreeSha ?? null,
          params.now,
          params.handoffId,
        );

      this.db
        .prepare(
          `INSERT INTO handoff_turns (
            turn_id, handoff_id, turn_number, kind, idempotency_key, dispatch_state,
            run_id, prompt_text, create_params_json, baseline_message_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'dispatch_pending', NULL, ?, NULL, ?, ?, ?)`,
        )
        .run(
          params.turnId,
          params.handoffId,
          params.turnNumber,
          params.kind,
          params.idempotencyKey,
          params.promptText,
          params.baselineMessageCount,
          params.now,
          params.now,
        );

      if (params.markPublishInFlight) {
        this.db
          .prepare(
            `UPDATE publication_ledger
             SET pr_state = 'uncertain_in_flight', updated_at = ?
             WHERE handoff_id = ? AND pr_state != 'open_verified'`,
          )
          .run(params.now, params.handoffId);
      }
    });
  }

  recordInitialDispatched(params: {
    handoffId: string;
    turnId: string;
    remoteSessionKey: string;
    remoteSessionId?: string;
    remoteSessionUrl?: string;
    runId: string;
    now: string;
  }): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET remote_session_key = ?,
               remote_session_id = COALESCE(?, remote_session_id),
               remote_session_url = COALESCE(?, remote_session_url),
               lifecycle_status = 'running',
               updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(
          params.remoteSessionKey,
          params.remoteSessionId ?? null,
          params.remoteSessionUrl ?? null,
          params.now,
          params.handoffId,
        );

      this.db
        .prepare(
          `UPDATE handoff_turns
           SET dispatch_state = 'dispatched',
               run_id = ?,
               error_text = NULL,
               updated_at = ?
           WHERE turn_id = ?`,
        )
        .run(params.runId, params.now, params.turnId);
    });
  }

  recordFollowupDispatched(params: {
    handoffId: string;
    turnId: string;
    runId: string;
    now: string;
  }): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET lifecycle_status = 'running', updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(params.now, params.handoffId);

      this.db
        .prepare(
          `UPDATE handoff_turns
           SET dispatch_state = 'dispatched',
               run_id = ?,
               error_text = NULL,
               updated_at = ?
           WHERE turn_id = ?`,
        )
        .run(params.runId, params.now, params.turnId);
    });
  }

  markTurnUncertain(params: {
    handoffId: string;
    turnId: string;
    errorText: string;
    remoteSessionKey?: string;
    remoteSessionId?: string;
    remoteSessionUrl?: string;
    now: string;
  }): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET lifecycle_status = 'uncertain',
               remote_session_key = COALESCE(?, remote_session_key),
               remote_session_id = COALESCE(?, remote_session_id),
               remote_session_url = COALESCE(?, remote_session_url),
               updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(
          params.remoteSessionKey ?? null,
          params.remoteSessionId ?? null,
          params.remoteSessionUrl ?? null,
          params.now,
          params.handoffId,
        );

      this.db
        .prepare(
          `UPDATE handoff_turns
           SET dispatch_state = 'uncertain', error_text = ?, updated_at = ?
           WHERE turn_id = ?`,
        )
        .run(params.errorText, params.now, params.turnId);
    });
  }

  settleTurn(params: {
    handoffId: string;
    turnId: string;
    lifecycleStatus: LifecycleStatus;
    dispatchState: DispatchState;
    rawReplyText?: string;
    reported?: ReportedResult;
    observed: ObservedResult;
    directive: OrchestratorDirective;
    sameBlockerStreak: number;
    lastBlockerFingerprint?: string;
    verifiedPublishHeadSha?: string;
    headRef?: string;
    errorText?: string;
    now: string;
  }): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET lifecycle_status = ?,
               same_blocker_streak = ?,
               last_blocker_fingerprint = ?,
               verified_publish_head_sha = COALESCE(?, verified_publish_head_sha),
               updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(
          params.lifecycleStatus,
          params.sameBlockerStreak,
          params.lastBlockerFingerprint ?? null,
          params.verifiedPublishHeadSha ?? null,
          params.now,
          params.handoffId,
        );

      this.db
        .prepare(
          `UPDATE handoff_turns
           SET dispatch_state = ?,
               raw_reply_text = COALESCE(?, raw_reply_text),
               reported_json = ?,
               observed_json = ?,
               directive_json = ?,
               error_text = ?,
               updated_at = ?
           WHERE turn_id = ?`,
        )
        .run(
          params.dispatchState,
          params.rawReplyText ?? null,
          params.reported ? JSON.stringify(params.reported) : null,
          JSON.stringify(params.observed),
          JSON.stringify(params.directive),
          params.errorText ?? null,
          params.now,
          params.turnId,
        );

      this.db
        .prepare(
          `UPDATE publication_ledger
           SET head_ref = COALESCE(?, head_ref),
               head_sha = COALESCE(?, head_sha),
               tree_sha = COALESCE(?, tree_sha),
               pr_state = ?,
               pr_url = COALESCE(?, pr_url),
               updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(
          params.headRef ?? null,
          params.observed.observedHeadSha ?? null,
          params.observed.observedTreeSha ?? null,
          params.observed.reconciledPrState,
          params.observed.reconciledPrUrl ?? null,
          params.now,
          params.handoffId,
        );
    });
  }

  updateVerifiedGitSnapshot(params: {
    handoffId: string;
    turnId?: string;
    observed: ObservedResult;
    directive: OrchestratorDirective;
    verifiedPublishHeadSha?: string;
    headRef?: string;
    now: string;
  }): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET verified_publish_head_sha = ?, updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(params.verifiedPublishHeadSha ?? null, params.now, params.handoffId);

      if (params.turnId) {
        this.db
          .prepare(
            `UPDATE handoff_turns
             SET observed_json = ?, directive_json = ?, updated_at = ?
             WHERE turn_id = ?`,
          )
          .run(
            JSON.stringify(params.observed),
            JSON.stringify(params.directive),
            params.now,
            params.turnId,
          );
      }

      this.db
        .prepare(
          `UPDATE publication_ledger
           SET head_ref = COALESCE(?, head_ref),
               head_sha = COALESCE(?, head_sha),
               tree_sha = COALESCE(?, tree_sha),
               pr_state = ?,
               pr_url = COALESCE(?, pr_url),
               updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(
          params.headRef ?? null,
          params.observed.observedHeadSha ?? null,
          params.observed.observedTreeSha ?? null,
          params.observed.reconciledPrState,
          params.observed.reconciledPrUrl ?? null,
          params.now,
          params.handoffId,
        );
    });
  }

  markAborted(handoffId: string, latestTurnId: string | undefined, reason: string, now: string): void {
    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE handoff_sessions
           SET lifecycle_status = 'aborted', updated_at = ?
           WHERE handoff_id = ?`,
        )
        .run(now, handoffId);

      if (latestTurnId) {
        this.db
          .prepare(
            `UPDATE handoff_turns
             SET dispatch_state = 'aborted', error_text = ?, updated_at = ?
             WHERE turn_id = ?`,
          )
          .run(reason, now, latestTurnId);
      }
    });
  }

  getLatestTurn(handoffId: string): TurnRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM handoff_turns
         WHERE handoff_id = ?
         ORDER BY turn_number DESC
         LIMIT 1`,
      )
      .get(handoffId) as RawRow | undefined;
    return row ? this.mapTurn(row) : undefined;
  }

  listTurns(handoffId: string): TurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM handoff_turns
         WHERE handoff_id = ?
         ORDER BY turn_number ASC`,
      )
      .all(handoffId) as RawRow[];
    return rows.map((r) => this.mapTurn(r));
  }

  getPublicationLedger(handoffId: string): {
    prState: ReconciledPrState;
    prUrl?: string;
    headRef?: string;
    headSha?: string;
  } {
    const row = this.db
      .prepare("SELECT * FROM publication_ledger WHERE handoff_id = ?")
      .get(handoffId) as RawRow | undefined;
    if (!row) {
      return { prState: "none" };
    }
    return {
      prState: (row.pr_state as ReconciledPrState) ?? "none",
      prUrl: typeof row.pr_url === "string" ? row.pr_url : undefined,
      headRef: typeof row.head_ref === "string" ? row.head_ref : undefined,
      headSha: typeof row.head_sha === "string" ? row.head_sha : undefined,
    };
  }

  private mapSession(row: RawRow): SessionRecord {
    return {
      handoffId: String(row.handoff_id),
      requestId: String(row.request_id),
      workspaceId: String(row.workspace_id),
      targetId: String(row.target_id),
      title: String(row.title),
      mode: row.mode as SessionRecord["mode"],
      publisherOwner: row.publisher_owner as SessionRecord["publisherOwner"],
      repoId: String(row.repo_id),
      localRepoPath: typeof row.local_repo_path === "string" ? row.local_repo_path : undefined,
      remoteUrlOrPath:
        typeof row.remote_url_or_path === "string" ? row.remote_url_or_path : undefined,
      pinnedBaseCommitSha: String(row.pinned_base_commit_sha),
      pinnedSourceCommitSha:
        typeof row.pinned_source_commit_sha === "string"
          ? row.pinned_source_commit_sha
          : undefined,
      sourceRemoteRef:
        typeof row.source_remote_ref === "string" ? row.source_remote_ref : undefined,
      expectedTreeSha:
        typeof row.expected_tree_sha === "string" ? row.expected_tree_sha : undefined,
      lockedPaths: JSON.parse(String(row.locked_paths_json)) as string[],
      envelope: JSON.parse(String(row.envelope_json)) as HandoffEnvelopeV2,
      remoteSessionKey:
        typeof row.remote_session_key === "string" ? row.remote_session_key : undefined,
      remoteSessionId:
        typeof row.remote_session_id === "string" ? row.remote_session_id : undefined,
      remoteSessionUrl:
        typeof row.remote_session_url === "string" ? row.remote_session_url : undefined,
      worktreeName: typeof row.worktree_name === "string" ? row.worktree_name : undefined,
      lifecycleStatus: row.lifecycle_status as LifecycleStatus,
      maxAutonomousTurns: Number(row.max_autonomous_turns),
      sameBlockerStreak: Number(row.same_blocker_streak),
      lastBlockerFingerprint:
        typeof row.last_blocker_fingerprint === "string"
          ? row.last_blocker_fingerprint
          : undefined,
      verifiedPublishHeadSha:
        typeof row.verified_publish_head_sha === "string"
          ? row.verified_publish_head_sha
          : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapTurn(row: RawRow): TurnRecord {
    return {
      turnId: String(row.turn_id),
      handoffId: String(row.handoff_id),
      turnNumber: Number(row.turn_number),
      kind: row.kind as TurnKind,
      idempotencyKey: String(row.idempotency_key),
      dispatchState: row.dispatch_state as DispatchState,
      runId: typeof row.run_id === "string" ? row.run_id : undefined,
      promptText: String(row.prompt_text),
      createParamsJson:
        typeof row.create_params_json === "string" ? row.create_params_json : undefined,
      baselineMessageCount: Number(row.baseline_message_count),
      rawReplyText: typeof row.raw_reply_text === "string" ? row.raw_reply_text : undefined,
      reported:
        typeof row.reported_json === "string"
          ? (JSON.parse(row.reported_json) as ReportedResult)
          : undefined,
      observed:
        typeof row.observed_json === "string"
          ? (JSON.parse(row.observed_json) as ObservedResult)
          : undefined,
      directive:
        typeof row.directive_json === "string"
          ? (JSON.parse(row.directive_json) as OrchestratorDirective)
          : undefined,
      errorText: typeof row.error_text === "string" ? row.error_text : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
