import { db, tx } from "../store.ts";
import type {
  Message,
  Role,
  Session,
  SessionEvent,
  SessionEventType,
  SessionListItem,
  SessionPhase,
  SessionState,
  SessionStatus,
} from "../../shared/domain.ts";
import { isActive, newId } from "../../shared/domain.ts";

interface SessionRow {
  id: string;
  title: string;
  prompt: string;
  state: string;
  created_at: number;
  updated_at: number;
  cwd: string | null;
  priority: number;
  runner: string;
  pi_session_file: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  summary: string | null;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  st_state: string | null;
  turn: number | null;
  phase: string | null;
  tool: string | null;
  last_tool_ok: number | null;
  needs: string | null;
  artifacts: string | null;
  st_summary: string | null;
  st_updated: number | null;
}

const SELECT_SESSION = `
  SELECT s.*, st.state AS st_state, st.turn, st.phase, st.tool, st.last_tool_ok,
         st.needs, st.artifacts, st.summary AS st_summary, st.updated_at AS st_updated
  FROM sessions s LEFT JOIN session_status st ON st.session_id = s.id
`;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toSession(row: SessionRow): Session {
  const state = (row.st_state ?? row.state) as SessionState;
  const started = row.started_at ?? row.created_at;
  const ended = row.ended_at ?? (isActive(state) ? Date.now() : row.updated_at);
  const status: SessionStatus = {
    state,
    turn: row.turn ?? 0,
    phase: (row.phase ?? "idle") as SessionPhase,
    tool: row.tool,
    lastToolOk: row.last_tool_ok === null ? null : row.last_tool_ok === 1,
    elapsedMs: Math.max(0, ended - started),
    needs: (row.needs ?? null) as SessionStatus["needs"],
    artifacts: parseJson<string[]>(row.artifacts, []),
    summary: row.st_summary ?? row.summary,
    updatedAt: row.st_updated ?? row.updated_at,
  };
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    state,
    priority: row.priority,
    runner: row.runner === "pi" ? "pi" : "mock",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    error: parseJson(row.error, null),
    status,
  };
}

export interface CreateSessionInput {
  title: string;
  prompt: string;
  runner: "mock" | "pi";
  state?: SessionState;
  createdAt?: number;
}

export function createSession(input: CreateSessionInput): Session {
  const id = newId("s");
  const now = input.createdAt ?? Date.now();
  const state = input.state ?? "queued";
  tx(() => {
    db()
      .prepare(
        `INSERT INTO sessions (id, title, prompt, state, priority, runner, created_at, updated_at, started_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, input.title, input.prompt, state, 0, input.runner, now, now, state === "queued" ? null : now);
    db()
      .prepare(
        `INSERT INTO session_status (session_id, state, turn, phase, elapsed_ms, artifacts, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, state, 0, "idle", 0, "[]", now);
  });
  const created = getSession(id);
  if (!created) throw new Error("createSession failed");
  return created;
}

export function getSession(id: string): Session | null {
  const row = db().prepare(`${SELECT_SESSION} WHERE s.id = ?`).get(id) as unknown as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function listSessions(options: { query?: string; limit?: number; state?: SessionState } = {}): Session[] {
  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.state) {
    clauses.push("coalesce(st.state, s.state) = ?");
    params.push(options.state);
  }
  const query = options.query?.trim();
  if (query) {
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    clauses.push(
      `(s.title LIKE ? ESCAPE '\\' OR s.prompt LIKE ? ESCAPE '\\' OR coalesce(s.summary,'') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db()
    .prepare(`${SELECT_SESSION} ${where} ORDER BY s.updated_at DESC LIMIT ?`)
    .all(...params, limit) as unknown as SessionRow[];
  return rows.map(toSession);
}

export function listActiveSessions(): Session[] {
  const rows = db()
    .prepare(
      `${SELECT_SESSION} WHERE coalesce(st.state, s.state) IN ('starting','running','waiting_user','paused')
       ORDER BY s.priority DESC, s.created_at ASC`,
    )
    .all() as unknown as SessionRow[];
  return rows.map(toSession);
}

export function findRunningSession(): Session | null {
  const rows = db()
    .prepare(
      `${SELECT_SESSION} WHERE coalesce(st.state, s.state) IN ('starting','running','waiting_user')
       ORDER BY s.priority DESC, s.created_at ASC LIMIT 1`,
    )
    .all() as unknown as SessionRow[];
  const session = rows[0] ? toSession(rows[0]) : null;
  return session;
}

export function findLastSession(state?: SessionState): Session | null {
  const row = state
    ? (db()
        .prepare(`${SELECT_SESSION} WHERE coalesce(st.state, s.state) = ? ORDER BY s.updated_at DESC LIMIT 1`)
        .get(state) as unknown as SessionRow | undefined)
    : (db().prepare(`${SELECT_SESSION} ORDER BY s.updated_at DESC LIMIT 1`).get() as unknown as SessionRow | undefined);
  return row ? toSession(row) : null;
}

export function setSessionState(
  id: string,
  state: SessionState,
  patch: { summary?: string | null; endedAt?: number } = {},
): void {
  const now = Date.now();
  tx(() => {
    const ends = state === "done" || state === "failed" || state === "aborted";
    db()
      .prepare(
        `UPDATE sessions SET state = ?, updated_at = ?, started_at = coalesce(started_at, ?),
           ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
           summary = coalesce(?, summary)
         WHERE id = ?`,
      )
      .run(
        state,
        patch.endedAt ?? now,
        state === "queued" ? null : now,
        ends ? 1 : 0,
        patch.endedAt ?? now,
        patch.summary ?? null,
        id,
      );
    db()
      .prepare(
        `UPDATE session_status SET state = ?, phase = ?, updated_at = ?, needs = CASE WHEN ? IN ('waiting_user') THEN needs ELSE NULL END
         WHERE session_id = ?`,
      )
      .run(state, state === "running" ? "thinking" : "idle", now, state, id);
  });
}

export function patchStatus(
  id: string,
  patch: Partial<{
    state: SessionState;
    turn: number;
    phase: SessionPhase;
    tool: string | null;
    lastToolOk: boolean | null;
    needs: "confirm" | "clarify" | null;
    artifacts: string[];
    summary: string | null;
  }>,
): void {
  const now = Date.now();
  const current = db()
    .prepare("SELECT state, turn, phase, tool, last_tool_ok, needs, artifacts, summary FROM session_status WHERE session_id = ?")
    .get(id) as
    | {
        state: string;
        turn: number;
        phase: string;
        tool: string | null;
        last_tool_ok: number | null;
        needs: string | null;
        artifacts: string;
        summary: string | null;
      }
    | undefined;
  if (!current) return;
  db()
    .prepare(
      `UPDATE session_status SET state = ?, turn = ?, phase = ?, tool = ?, last_tool_ok = ?,
         needs = ?, artifacts = ?, summary = ?, updated_at = ? WHERE session_id = ?`,
    )
    .run(
      patch.state ?? current.state,
      patch.turn ?? current.turn,
      patch.phase ?? current.phase,
      patch.tool === undefined ? current.tool : patch.tool,
      patch.lastToolOk === undefined ? current.last_tool_ok : patch.lastToolOk === null ? null : patch.lastToolOk ? 1 : 0,
      patch.needs === undefined ? current.needs : patch.needs,
      patch.artifacts ? JSON.stringify(patch.artifacts) : current.artifacts,
      patch.summary === undefined ? current.summary : patch.summary,
      now,
      id,
    );
  db().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
}

export function renameSession(id: string, title: string): void {
  db().prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title.slice(0, 60), Date.now(), id);
}

export function setSessionError(id: string, error: Session["error"]): void {
  db()
    .prepare("UPDATE sessions SET error = ?, updated_at = ? WHERE id = ?")
    .run(error ? JSON.stringify(error) : null, Date.now(), id);
}

export function bumpSessionStats(id: string, tokensIn: number, tokensOut: number): void {
  db()
    .prepare("UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?")
    .run(tokensIn, tokensOut, id);
}

export function deleteSession(id: string): void {
  tx(() => {
    db().prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM events WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM session_status WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM queue WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM approvals WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM grants WHERE session_id = ?").run(id);
    db().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
}

/* ------------------------------------------------------------- 事件 */

export function appendEvent(
  sessionId: string | null,
  type: SessionEventType,
  summary: string,
  payload: Record<string, unknown> = {},
  ts?: number,
): SessionEvent {
  const now = ts ?? Date.now();
  const last = sessionId
    ? (db()
        .prepare("SELECT coalesce(max(seq), 0) AS seq FROM events WHERE session_id = ?")
        .get(sessionId) as { seq: number })
    : { seq: 0 };
  const seq = last.seq + 1;
  const res = db()
    .prepare("INSERT INTO events (session_id, ts, type, payload, seq, summary) VALUES (?,?,?,?,?,?)")
    .run(sessionId, now, type, JSON.stringify(payload), seq, summary);
  return {
    id: Number(res.lastInsertRowid),
    sessionId: sessionId ?? "",
    seq,
    ts: now,
    type,
    summary,
    payload,
  };
}

interface EventRow {
  id: number;
  session_id: string | null;
  ts: number;
  type: string;
  payload: string;
  seq: number;
  summary: string | null;
}

export function listEvents(sessionId: string, limit = 120): SessionEvent[] {
  const rows = db()
    .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
    .all(sessionId, Math.min(Math.max(limit, 1), 500)) as unknown as EventRow[];
  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id ?? "",
      seq: row.seq,
      ts: row.ts,
      type: row.type as SessionEventType,
      summary: row.summary ?? "",
      payload: parseJson<Record<string, unknown>>(row.payload, {}),
    }));
}

/* ----------------------------------------------------------- 消息 */

interface MessageRow {
  id: number;
  session_id: string | null;
  role: string;
  content: string;
  ts: number;
  source: string;
  approval_id: string | null;
  error: string | null;
  confidence: number | null;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Role,
    content: row.content,
    ts: row.ts,
    source: (row.source as Message["source"]) ?? "text",
    approvalId: row.approval_id,
    error: parseJson(row.error, null),
    confidence: row.confidence,
  };
}

export interface AppendMessageInput {
  role: Role;
  content: string;
  sessionId?: string | null;
  source?: Message["source"];
  approvalId?: string | null;
  error?: Message["error"];
  confidence?: number | null;
  ts?: number;
}

export function appendMessage(input: AppendMessageInput): Message {
  const ts = input.ts ?? Date.now();
  const res = db()
    .prepare(
      "INSERT INTO messages (session_id, role, content, ts, source, approval_id, error, confidence) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      input.sessionId ?? null,
      input.role,
      input.content,
      ts,
      input.source ?? "text",
      input.approvalId ?? null,
      input.error ? JSON.stringify(input.error) : null,
      input.confidence ?? null,
    );
  const id = Number(res.lastInsertRowid);
  if (input.sessionId) {
    db().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(ts, input.sessionId);
  }
  return {
    id,
    sessionId: input.sessionId ?? null,
    role: input.role,
    content: input.content,
    ts,
    source: input.source ?? "text",
    approvalId: input.approvalId ?? null,
    error: input.error ?? null,
    confidence: input.confidence ?? null,
  };
}

/**
 * 旧版本每次启动都会往时间线写一条欢迎语（`session_id` 为空的那条），
 * 启动几次就重复几条。现在不写了，这里把历史遗留的删掉。
 * 只匹配那句话的模板，不碰真正的回复。
 */
export function pruneBootGreetings(): number {
  const res = db()
    .prepare(
      `DELETE FROM messages
       WHERE session_id IS NULL
         AND role = 'assistant'
         AND content LIKE '我是 Kivora。按 %说一句话，我会开独立会话去把事做完。%'`,
    )
    .run();
  return Number(res.changes);
}

export function listTimeline(limit = 80): Message[] {
  const rows = db()
    .prepare("SELECT * FROM messages ORDER BY ts DESC, id DESC LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 400)) as unknown as MessageRow[];
  return rows.reverse().map(toMessage);
}

export function listSessionMessages(sessionId: string): Message[] {
  const rows = db()
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY ts ASC, id ASC")
    .all(sessionId) as unknown as MessageRow[];
  return rows.map(toMessage);
}

/** 建会话之后把发起它的那条用户消息挂上去，会话详情里才看得到"谁让它干的" */
export function attachMessageToSession(messageId: number, sessionId: string): void {
  db().prepare("UPDATE messages SET session_id = ? WHERE id = ?").run(sessionId, messageId);
}

export function listSessionItems(query?: string, limit = 60): SessionListItem[] {
  return listSessions({ query, limit }).map(toItem);
}

export function toItem(session: Session): SessionListItem {
  return {
    id: session.id,
    title: session.title,
    state: session.state,
    summary: session.status.summary ?? session.status.summary,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    turn: session.status.turn,
    tool: session.status.tool,
    artifactCount: session.status.artifacts.length,
    elapsedMs: session.status.elapsedMs,
    error: session.error,
  };
}

export function countSessions(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  return row.n;
}
