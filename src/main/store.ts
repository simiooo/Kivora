import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../shared/errors.ts";

/**
 * 主进程独占 SQLite（7.1）。渲染进程永远拿不到连接，只通过 IPC 读投影后的数据。
 * - WAL；迁移失败拒绝启动（抛错，由 main 退出）。
 * - 所有写操作走 tx()，避免半截状态。
 */

let handle: DatabaseSync | null = null;
let dbFile = "";
let schemaVersion = 0;
let depth = 0;

const MIGRATIONS: string[] = [
  // v1 —— 最初的时间线骨架
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    prompt     TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    ts         INTEGER NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // v2 —— 会话状态投影、队列、审批总线、模型仓库
  `
  ALTER TABLE sessions ADD COLUMN cwd TEXT;
  ALTER TABLE sessions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN runner TEXT NOT NULL DEFAULT 'mock';
  ALTER TABLE sessions ADD COLUMN pi_session_file TEXT;
  ALTER TABLE sessions ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN summary TEXT;
  ALTER TABLE sessions ADD COLUMN error TEXT;
  ALTER TABLE sessions ADD COLUMN started_at INTEGER;
  ALTER TABLE sessions ADD COLUMN ended_at INTEGER;

  ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'text';
  ALTER TABLE messages ADD COLUMN approval_id TEXT;
  ALTER TABLE messages ADD COLUMN error TEXT;
  ALTER TABLE messages ADD COLUMN confidence REAL;

  ALTER TABLE events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE events ADD COLUMN summary TEXT;
  CREATE INDEX IF NOT EXISTS events_session_seq ON events (session_id, seq);

  CREATE TABLE IF NOT EXISTS session_status (
    session_id   TEXT PRIMARY KEY,
    state        TEXT NOT NULL DEFAULT 'queued',
    turn         INTEGER NOT NULL DEFAULT 0,
    phase        TEXT NOT NULL DEFAULT 'idle',
    tool         TEXT,
    last_tool_ok INTEGER,
    elapsed_ms   INTEGER NOT NULL DEFAULT 0,
    needs        TEXT,
    artifacts    TEXT NOT NULL DEFAULT '[]',
    summary      TEXT,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS queue (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    text        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'queue',
    position    INTEGER NOT NULL,
    enqueued_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS queue_position ON queue (position);

  CREATE TABLE IF NOT EXISTS approvals (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    session_id  TEXT,
    tool        TEXT NOT NULL,
    risk        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    title       TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '[]',
    options     TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'pending',
    speech      TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    resolution  TEXT,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at);

  CREATE TABLE IF NOT EXISTS grants (
    id         TEXT PRIMARY KEY,
    session_id TEXT,
    tool       TEXT NOT NULL,
    scope      TEXT NOT NULL,
    value      TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS models (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    provider        TEXT NOT NULL,
    capability      TEXT NOT NULL,
    base_url        TEXT NOT NULL,
    model_id        TEXT NOT NULL,
    params          TEXT NOT NULL DEFAULT '{}',
    headers         TEXT NOT NULL DEFAULT '[]',
    key_hint        TEXT,
    test_status     TEXT NOT NULL DEFAULT 'untested',
    test_latency_ms INTEGER,
    tested_at       INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bindings (
    module   TEXT PRIMARY KEY,
    model_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    name       TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS op_log (
    op_id      TEXT PRIMARY KEY,
    session_id TEXT,
    tool       TEXT NOT NULL,
    result     TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  `,
];

export function openStore(dataDir: string): { dbPath: string; schemaVersion: number } {
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, "kivora.db");
  handle = new DatabaseSync(dbFile);
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA foreign_keys = ON;");
  handle.exec("PRAGMA busy_timeout = 5000;");
  handle.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");

  const applied = new Set(
    (handle.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
  );

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (applied.has(version)) continue;
    try {
      handle.exec("BEGIN");
      handle.exec(MIGRATIONS[i]);
      handle.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      handle.exec("COMMIT");
      console.log(`[kivora] migrated to v${version}`);
    } catch (err) {
      handle.exec("ROLLBACK");
      throw new AppError("storage_failed", {
        message: `数据库迁移到 v${version} 失败，已阻止启动以免数据损坏。`,
        detail: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
    }
  }

  schemaVersion = MIGRATIONS.length;
  return { dbPath: dbFile, schemaVersion };
}

export function db(): DatabaseSync {
  if (!handle) throw new AppError("storage_failed", { message: "数据库还没打开。" });
  return handle;
}

/** 支持嵌套的写事务（内部用 savepoint） */
export function tx<T>(fn: () => T): T {
  const conn = db();
  const savepoint = depth > 0 ? `sp_${depth}` : null;
  if (savepoint) conn.exec(`SAVEPOINT ${savepoint}`);
  else conn.exec("BEGIN");
  depth++;
  try {
    const result = fn();
    depth--;
    if (savepoint) conn.exec(`RELEASE ${savepoint}`);
    else conn.exec("COMMIT");
    return result;
  } catch (err) {
    depth--;
    if (savepoint) conn.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    else conn.exec("ROLLBACK");
    throw err;
  }
}

export function storeInfo(): { dbPath: string; schemaVersion: number } {
  return { dbPath: dbFile, schemaVersion };
}

export function audit(actor: string, action: string, detail: Record<string, unknown> = {}): void {
  try {
    db()
      .prepare("INSERT INTO audit (ts, actor, action, detail) VALUES (?,?,?,?)")
      .run(Date.now(), actor, action, JSON.stringify(detail));
  } catch {
    // 审计不是关键路径，失败不阻断主流程
  }
}

/** 启动时把孤儿 running 标 failed(orphaned)（7.1） */
export function recoverOrphanSessions(): number {
  const now = Date.now();
  const rows = db()
    .prepare("SELECT id FROM sessions WHERE state IN ('starting','running','waiting_user')")
    .all() as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  tx(() => {
    for (const row of rows) {
      db()
        .prepare("UPDATE sessions SET state = 'failed', ended_at = ?, updated_at = ?, error = ? WHERE id = ?")
        .run(
          now,
          now,
          JSON.stringify({
            code: "internal",
            message: "上次退出时这个任务还在跑，已经停了，可以重试。",
            detail: null,
            retryable: true,
            at: now,
          }),
          row.id,
        );
      db()
        .prepare(
          "UPDATE session_status SET state = 'failed', phase = 'idle', updated_at = ? WHERE session_id = ?",
        )
        .run(now, row.id);
    }
    db().prepare("DELETE FROM queue").run();
  });
  return rows.length;
}

/** 保留策略：事件与审计只留 N 天 */
export function pruneOldData(retentionDays: number): void {
  if (retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  try {
    db().prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
    db().prepare("DELETE FROM audit WHERE ts < ?").run(cutoff);
    db().prepare("DELETE FROM approvals WHERE created_at < ? AND status <> 'pending'").run(cutoff);
    db().prepare("DELETE FROM op_log WHERE created_at < ?").run(cutoff);
  } catch (err) {
    console.warn("[kivora] prune failed", err);
  }
}

export function closeStore(): void {
  handle?.close();
  handle = null;
}
