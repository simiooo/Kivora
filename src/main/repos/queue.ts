import { db } from "../store.ts";
import type { QueueItem, QueueKind } from "../../shared/domain.ts";
import { QUEUE_LIMIT, newId } from "../../shared/domain.ts";
import { AppError } from "../../shared/errors.ts";

interface QueueRow {
  id: string;
  session_id: string;
  text: string;
  kind: string;
  position: number;
  enqueued_at: number;
}

function toItem(row: QueueRow): QueueItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    kind: row.kind === "steer" ? "steer" : "queue",
    position: row.position,
    enqueuedAt: row.enqueued_at,
  };
}

export function listQueue(): QueueItem[] {
  const rows = db()
    .prepare("SELECT * FROM queue ORDER BY position ASC, enqueued_at ASC")
    .all() as unknown as QueueRow[];
  return rows.map(toItem);
}

export function countSessionQueue(sessionId: string): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM queue WHERE session_id = ?").get(sessionId) as { n: number };
  return row.n;
}

export function enqueue(sessionId: string, text: string, kind: QueueKind = "queue"): QueueItem {
  const total = (db().prepare("SELECT COUNT(*) AS n FROM queue").get() as { n: number }).n;
  if (total >= QUEUE_LIMIT) {
    throw new AppError("conflict", {
      message: `待处理最多 ${QUEUE_LIMIT} 条，先说「全部取消」再排。`,
      retryable: false,
    });
  }
  if (countSessionQueue(sessionId) >= 2) {
    throw new AppError("conflict", {
      message: "同一个会话最多 2 条待执行指令，等它跑完一轮再说。",
      retryable: false,
    });
  }
  const max = (db().prepare("SELECT coalesce(max(position), 0) AS p FROM queue").get() as { p: number }).p;
  const id = newId("q");
  const now = Date.now();
  db()
    .prepare("INSERT INTO queue (id, session_id, text, kind, position, enqueued_at) VALUES (?,?,?,?,?,?)")
    .run(id, sessionId, text, kind, max + 1, now);
  return { id, sessionId, text, kind, position: max + 1, enqueuedAt: now };
}

export function removeFromQueue(id: string): void {
  const res = db().prepare("DELETE FROM queue WHERE id = ?").run(id);
  if (Number(res.changes) === 0) throw new AppError("not_found", { message: "这条排队指令已经不在了。" });
}

export function clearQueue(): number {
  const res = db().prepare("DELETE FROM queue").run();
  return Number(res.changes);
}

export function clearSessionQueue(sessionId: string): void {
  db().prepare("DELETE FROM queue WHERE session_id = ?").run(sessionId);
}

/** 提前：把一条移到队首 */
export function promoteQueued(id: string): number {
  const row = db().prepare("SELECT * FROM queue WHERE id = ?").get(id) as unknown as QueueRow | undefined;
  if (!row) throw new AppError("not_found", { message: "这条排队指令已经不在了。" });
  const min = (db().prepare("SELECT coalesce(min(position), 0) AS p FROM queue").get() as { p: number }).p;
  const position = min - 1;
  db().prepare("UPDATE queue SET position = ? WHERE id = ?").run(position, id);
  return 1;
}

/** 取队首并删掉（调用方负责真的去执行） */
export function takeNextQueued(): QueueItem | null {
  const row = db()
    .prepare("SELECT * FROM queue ORDER BY position ASC, enqueued_at ASC LIMIT 1")
    .get() as unknown as QueueRow | undefined;
  if (!row) return null;
  db().prepare("DELETE FROM queue WHERE id = ?").run(row.id);
  return toItem(row);
}
