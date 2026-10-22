import { db, tx } from "../store.ts";
import type {
  Approval,
  ApprovalOption,
  ApprovalResolution,
  ApprovalStatus,
  Grant,
  Risk,
} from "../../shared/domain.ts";
import { approvalTimeoutMs, newId } from "../../shared/domain.ts";
import { AppError } from "../../shared/errors.ts";

interface ApprovalRow {
  id: string;
  source: string;
  session_id: string | null;
  tool: string;
  risk: string;
  summary: string;
  title: string;
  detail: string;
  options: string;
  status: string;
  speech: string;
  created_at: number;
  expires_at: number | null;
  resolution: string | null;
  resolved_at: number | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toApproval(row: ApprovalRow, sessionTitle: string | null): Approval {
  return {
    id: row.id,
    source: row.source as Approval["source"],
    sessionId: row.session_id,
    sessionTitle,
    tool: row.tool,
    risk: row.risk as Risk,
    summary: row.summary,
    title: row.title,
    detail: parseJson<string[]>(row.detail, []),
    options: parseJson<ApprovalOption[]>(row.options, ["allow_once", "deny"]),
    status: row.status as ApprovalStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolution: (row.resolution ?? null) as ApprovalResolution | null,
    resolvedAt: row.resolved_at,
    speech: row.speech,
  };
}

const SELECT = `
  SELECT a.*, s.title AS session_title
  FROM approvals a LEFT JOIN sessions s ON s.id = a.session_id
`;

export interface CreateApprovalInput {
  source: Approval["source"];
  sessionId: string | null;
  tool: string;
  risk: Risk;
  title: string;
  summary: string;
  detail: string[];
  speech: string;
  options?: ApprovalOption[];
  timeoutMs?: number | null;
}

export function createApproval(input: CreateApprovalInput): Approval {
  const now = Date.now();
  const id = newId("ap");
  const timeout = input.timeoutMs === undefined ? approvalTimeoutMs(input.risk) : input.timeoutMs;
  const options: ApprovalOption[] =
    input.options ?? (input.risk === "G3" ? ["allow_once", "deny"] : ["allow_once", "allow_scope", "deny"]);
  db()
    .prepare(
      `INSERT INTO approvals (id, source, session_id, tool, risk, summary, title, detail, options, status, speech, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.source,
      input.sessionId,
      input.tool,
      input.risk,
      input.summary,
      input.title,
      JSON.stringify(input.detail),
      JSON.stringify(options),
      "pending",
      input.speech,
      now,
      timeout ? now + timeout : null,
    );
  const created = getApproval(id);
  if (!created) throw new Error("createApproval failed");
  return created;
}

export function getApproval(id: string): Approval | null {
  const row = db().prepare(`${SELECT} WHERE a.id = ?`).get(id) as unknown as (ApprovalRow & { session_title?: string }) | undefined;
  return row ? toApproval(row, row.session_title ?? null) : null;
}

export function listApprovals(status?: ApprovalStatus): Approval[] {
  const rows = status
    ? (db().prepare(`${SELECT} WHERE a.status = ? ORDER BY a.created_at ASC`).all(status) as unknown as Array<
        ApprovalRow & { session_title?: string }
      >)
    : (db().prepare(`${SELECT} ORDER BY a.created_at DESC LIMIT 100`).all() as unknown as Array<
        ApprovalRow & { session_title?: string }
      >);
  return rows.map((row) => toApproval(row, row.session_title ?? null));
}

export function pendingApprovals(): Approval[] {
  return listApprovals("pending");
}

export function pendingForSession(sessionId: string): Approval | null {
  const row = db()
    .prepare(`${SELECT} WHERE a.session_id = ? AND a.status = 'pending' ORDER BY a.created_at ASC LIMIT 1`)
    .get(sessionId) as unknown as (ApprovalRow & { session_title?: string }) | undefined;
  return row ? toApproval(row, row.session_title ?? null) : null;
}

export function resolveApproval(id: string, resolution: ApprovalResolution): Approval {
  const current = getApproval(id);
  if (!current) throw new AppError("not_found", { message: "这个审批已经不在了。" });
  if (current.status !== "pending") {
    // 幂等：重复点击不报错，直接返回现状
    return current;
  }
  const status: ApprovalStatus =
    resolution === "allow_once" || resolution === "allow_scope"
      ? "allowed"
      : resolution === "deny"
        ? "denied"
        : resolution === "timeout"
          ? "expired"
          : "cancelled";
  const now = Date.now();
  tx(() => {
    db()
      .prepare("UPDATE approvals SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?")
      .run(status, resolution, now, id);
    db()
      .prepare("UPDATE session_status SET needs = NULL, updated_at = ? WHERE session_id = ?")
      .run(now, current.sessionId);
    if (resolution === "allow_scope" && current.sessionId) {
      addGrant({
        sessionId: current.sessionId,
        tool: current.tool,
        scope: "any",
        value: current.summary,
        expiresAt: null,
      });
    }
  });
  const next = getApproval(id);
  if (!next) throw new AppError("internal");
  return next;
}

/** 超时处理：G1/G2 到期自动拒绝，G3 不超时 */
export function expireStaleApprovals(now = Date.now()): Approval[] {
  const rows = db()
    .prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
    .all(now) as Array<{ id: string }>;
  return rows.map((row) => resolveApproval(row.id, "timeout"));
}

/* ------------------------------------------------------------- grants */

interface GrantRow {
  id: string;
  session_id: string | null;
  tool: string;
  scope: string;
  value: string;
  expires_at: number | null;
  created_at: number;
}

export function addGrant(input: Omit<Grant, "id" | "createdAt">): Grant {
  const id = newId("gr");
  const now = Date.now();
  db()
    .prepare("INSERT INTO grants (id, session_id, tool, scope, value, expires_at, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, input.sessionId, input.tool, input.scope, input.value, input.expiresAt, now);
  return { ...input, id, createdAt: now };
}

export function listGrants(): Grant[] {
  const rows = db().prepare("SELECT * FROM grants ORDER BY created_at DESC").all() as unknown as GrantRow[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    tool: row.tool,
    scope: row.scope as Grant["scope"],
    value: row.value,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export function hasGrant(tool: string): boolean {
  const now = Date.now();
  const row = db()
    .prepare(
      "SELECT id FROM grants WHERE tool = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1",
    )
    .get(tool, now);
  return Boolean(row);
}

export function revokeGrants(sessionId?: string): number {
  const res = sessionId
    ? db().prepare("DELETE FROM grants WHERE session_id = ?").run(sessionId)
    : db().prepare("DELETE FROM grants").run();
  return Number(res.changes);
}
