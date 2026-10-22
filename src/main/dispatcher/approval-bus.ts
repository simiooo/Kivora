import type { Approval, ApprovalResolution } from "../../shared/domain.ts";
import { createApproval, getApproval, listApprovals, resolveApproval, type CreateApprovalInput } from "../repos/approvals.ts";
import { appendEvent, appendMessage } from "../repos/sessions.ts";
import { broadcast, speak } from "../bus.ts";
import { getConfig } from "../repos/config.ts";
import { AppError } from "../../shared/errors.ts";

/**
 * 审批总线的运行时部分：一次只问一个（4.5）：
 * - 新审批进 approvals(pending)；
 * - 有语音通道时播 speech，同时出卡片；
 * - 15s 没回应再问一次（只一次）；
 * - 到期按 G1/G2 默认拒绝；G3 不自动超时。
 */

const waiters = new Map<string, (resolution: ApprovalResolution) => void>();
const settled = new Map<string, ApprovalResolution>();
const timers = new Map<string, NodeJS.Timeout>();
const reaskTimers = new Map<string, NodeJS.Timeout>();

export interface OpenApprovalInput extends CreateApprovalInput {
  /** 卡片上方的那句问话，也是播报内容 */
  question: string;
}

export function openApproval(input: OpenApprovalInput): Approval {
  const config = getConfig();
  const approval = createApproval(input);
  appendMessage({
    role: "assistant",
    content: input.question,
    approvalId: approval.id,
    sessionId: input.sessionId,
  });

  if (approval.expiresAt) {
    const delay = Math.max(0, approval.expiresAt - Date.now());
    timers.set(
      approval.id,
      setTimeout(() => {
        settleApproval(approval.id, "timeout", "timeout");
      }, delay),
    );
    // 15 秒复问一次
    if (delay > 16_000) {
      reaskTimers.set(
        approval.id,
        setTimeout(() => {
          if (getApproval(approval.id)?.status !== "pending") return;
          if (config.narration) void speak("还在等你确认。");
        }, 15_000),
      );
    }
  }

  const canSpeak = config.narration && (approval.risk !== "G3" || config.g3Voice);
  if (canSpeak && approval.speech) void speak(approval.speech);

  broadcast("approvals");
  broadcast("timeline");
  return approval;
}

export function awaitApproval(id: string): Promise<ApprovalResolution> {
  const already = settled.get(id);
  if (already) return Promise.resolve(already);
  return new Promise((resolve) => {
    waiters.set(id, resolve);
  });
}

export function settleApproval(id: string, resolution: ApprovalResolution, source: "voice" | "gui" | "timeout" | "cancel" = "gui"): Approval {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const reask = reaskTimers.get(id);
  if (reask) {
    clearTimeout(reask);
    reaskTimers.delete(id);
  }

  const approved = resolveApproval(id, resolution);
  settled.set(id, resolution);
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter(resolution);
  }

  if (source === "timeout") {
    void speak("我先不动了。");
  } else if (approved.sessionId && approved.status === "allowed" && resolution === "allow_scope") {
    void speak("好，以后这类不用再问你。");
  }

  announceResolution(approved, resolution);
  broadcast("approvals");
  broadcast("timeline");
  broadcast("sessions");
  return approved;
}

function announceResolution(approval: Approval, resolution: ApprovalResolution): void {
  if (!approval.sessionId) return;
  const label =
    resolution === "allow_once"
      ? "语音允许"
      : resolution === "allow_scope"
        ? "以后都允许"
        : resolution === "deny"
          ? "拒绝"
          : resolution === "timeout"
            ? "超时默认拒绝"
            : "取消";
  appendEvent(approval.sessionId, "approval_resolved", `${label} · ${approval.title}`, { resolution });
}

/** 定时清理过期审批：走 settle，才会叫醒正在等答案的会话 */
export function expireApprovals(now = Date.now()): Approval[] {
  const expired: Approval[] = [];
  for (const approval of listApprovals("pending")) {
    if (approval.expiresAt !== null && approval.expiresAt <= now) {
      expired.push(settleApproval(approval.id, "timeout", "timeout"));
    }
  }
  return expired;
}

export function cancelApprovalsForSession(sessionId: string): void {
  for (const approval of listPendingIdsForSession(sessionId)) {
    settleApproval(approval, "cancelled", "cancel");
  }
}

function listPendingIdsForSession(sessionId: string): string[] {
  return [...waiters.keys()].filter((id) => getApproval(id)?.sessionId === sessionId);
}

export function pendingAwaitCount(): number {
  return waiters.size;
}

export function currentApproval(): Approval | null {
  const ids = [...waiters.keys()];
  for (const id of ids) {
    const approval = getApproval(id);
    if (approval && approval.status === "pending") return approval;
  }
  return null;
}

export function answerById(id: string, resolution: ApprovalResolution): Approval {
  const approval = getApproval(id);
  if (!approval) throw new AppError("not_found", { message: "这个审批已经不在了。" });
  return settleApproval(id, resolution, "gui");
}
