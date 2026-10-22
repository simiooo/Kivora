import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Role, TimelineMessage } from "../shared/ipc.ts";

let db: DatabaseSync | null = null;
let dbFile = "";
let schemaVersion = 0;

const DEFAULT_CONFIG: AppConfig = {
  hotkey: "CommandOrControl+Alt+Space",
  mockMode: true,
  asrBaseUrl: "https://api.openai.com/v1",
  asrModel: "whisper-1",
  ttsBaseUrl: "https://api.openai.com/v1",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
  brainBaseUrl: "https://api.openai.com/v1",
  brainModel: "gpt-4.1-mini",
  taskBaseUrl: "https://api.openai.com/v1",
  taskModel: "claude-sonnet-4-6",
};

const MIGRATIONS: string[] = [
  // v1
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
];

export function openStore(dataDir: string): { dbPath: string; schemaVersion: number } {
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, "kivora.db");
  db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
  );

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (applied.has(version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  schemaVersion = MIGRATIONS.length;
  seed();
  return { dbPath: dbFile, schemaVersion };
}

function seed(): void {
  const now = Date.now();
  const has = get().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  if (has.n === 0) {
    get()
      .prepare("INSERT INTO sessions (id, title, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("s_welcome", "欢迎", "", "idle", now, now);
    get()
      .prepare("INSERT INTO messages (session_id, role, content, ts) VALUES (?,?,?,?)")
      .run(
        "s_welcome",
        "assistant",
        "我是 Kivora。按住 Ctrl+Alt+Space 说话，我会开一个独立会话去把事做完。现在跑的是 mock 端点。",
        now,
      );
  }
}

function get(): DatabaseSync {
  if (!db) throw new Error("store not open");
  return db;
}

export function storeInfo(): { dbPath: string; schemaVersion: number } {
  return { dbPath: dbFile, schemaVersion };
}

export function listTimeline(limit = 50): TimelineMessage[] {
  const rows = get()
    .prepare("SELECT id, session_id AS sessionId, role, content, ts FROM messages ORDER BY ts DESC, id DESC LIMIT ?")
    .all(limit) as unknown as TimelineMessage[];
  return rows.reverse();
}

export function appendMessage(role: Role, content: string, sessionId: string | null = null): TimelineMessage {
  const ts = Date.now();
  const res = get()
    .prepare("INSERT INTO messages (session_id, role, content, ts) VALUES (?,?,?,?)")
    .run(sessionId, role, content, ts);
  const id = Number(res.lastInsertRowid);
  if (sessionId) {
    get().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(ts, sessionId);
  }
  return { id, sessionId, role, content, ts };
}

export function getConfig(): AppConfig {
  const rows = get().prepare("SELECT key, value FROM config").all() as Array<{ key: string; value: string }>;
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // ignore corrupt rows, fall back to defaults
    }
  }
  return { ...DEFAULT_CONFIG, ...stored } as AppConfig;
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const now = Date.now();
  const stmt = get().prepare(
    "INSERT INTO config (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) continue;
    stmt.run(key, JSON.stringify(value), now);
  }
  return getConfig();
}

export function closeStore(): void {
  db?.close();
  db = null;
}
