import type { ApprovalResolution, Risk, SessionState } from "../../shared/domain.ts";

/**
 * 反射路由：零模型、零网络，先跑（3.5）。
 * 纯函数，输入一句话 + 当前上下文，输出动作，方便单测。
 */

export type Intent =
  | { kind: "approve"; resolution: ApprovalResolution }
  | { kind: "cancel"; sessionId: string }
  | { kind: "retry"; sessionId: string; mode: "continue" | "restart" }
  | { kind: "resume"; sessionId: string }
  | { kind: "status"; sessionId: string | null }
  | { kind: "create_task"; text: string; preempt: boolean }
  | { kind: "queue"; sessionId: string; text: string }
  | { kind: "promote" }
  | { kind: "help" }
  | { kind: "none" };

export interface RouterContext {
  pendingApproval: { id: string; risk: Risk } | null;
  running: { id: string; state: SessionState; title: string; phase: string } | null;
  lastFailed: { id: string } | null;
  lastPaused: { id: string } | null;
  lastReferenced: { id: string } | null;
  queueCount: number;
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~～…]+/g, "");
}

const AFFIRM = new Set([
  "可以",
  "行",
  "好",
  "好的",
  "好嘞",
  "嗯",
  "恩",
  "确认",
  "允许",
  "没问题",
  "同意",
  "对",
  "对的",
  "是的",
  "ok",
  "okay",
  "yes",
  "y",
  "继续",
  "就这样",
  "批准",
]);

const SCOPE = ["以后都行", "都允许", "以后都允许", "一直允许", "以后不用问", "别问了", "以后都这样"];

const DENY = new Set(["不行", "不要", "拒绝", "取消", "别", "不", "算了", "no", "n", "停", "不用", "不可以"]);

const CANCEL = ["停", "停止", "别做了", "别弄了", "中断", "取消任务", "停下", "不做了"];
const CANCEL_STRONG = ["取消任务", "全部取消", "都取消", "全部停"];

const RETRY = ["重试", "再来一次", "再试一次", "再试", "重新做", "重新来", "再来"];
const STATUS = [
  "做完了吗",
  "好了吗",
  "怎么样了",
  "进度",
  "到哪了",
  "哪儿了",
  "哪了",
  "还在吗",
  "什么情况",
  "状态",
  "跑完了吗",
  "搞定没",
];
const PROMOTE = ["先做这个", "插队", "优先", "先弄这个", "这个先来"];
const HELP = ["你能做什么", "怎么用", "帮助", "help", "会什么"];

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function route(text: string, ctx: RouterContext): Intent {
  const raw = text.trim();
  const norm = normalize(raw);
  if (!norm) return { kind: "none" };

  // 1) 审批优先：同一时刻只问一个（4.5）
  if (ctx.pendingApproval) {
    const approval = ctx.pendingApproval;
    // G3 永不走语音，只出卡片
    if (approval.risk !== "G3") {
      if (hasAny(norm, SCOPE) && norm.length <= 12) return { kind: "approve", resolution: "allow_scope" };
      if (AFFIRM.has(norm) || (norm.length <= 5 && norm.includes("可以"))) {
        return { kind: "approve", resolution: "allow_once" };
      }
      if (DENY.has(norm) || (norm.length <= 4 && hasAny(norm, CANCEL))) {
        return { kind: "approve", resolution: "deny" };
      }
    }
  }

  // 2) 取消：只有短句才算，"停在哪儿了"这种问句交给状态查询
  if (ctx.running && hasAny(norm, CANCEL_STRONG)) return { kind: "cancel", sessionId: ctx.running.id };
  if (ctx.running && norm.length <= 4 && hasAny(norm, CANCEL)) {
    return { kind: "cancel", sessionId: ctx.running.id };
  }

  // 3) 重试 / 续做
  if (hasAny(norm, RETRY)) {
    const target = ctx.lastFailed ?? ctx.running;
    if (target) return { kind: "retry", sessionId: target.id, mode: "continue" };
  }
  if ((norm === "继续" || norm === "接着做" || norm === "继续吧") && (ctx.lastPaused ?? ctx.running)) {
    const target = ctx.lastPaused ?? ctx.running;
    return { kind: "resume", sessionId: target!.id };
  }

  // 4) 状态
  if (hasAny(norm, STATUS)) {
    const target = ctx.running ?? ctx.lastReferenced;
    return { kind: "status", sessionId: target?.id ?? null };
  }

  // 5) 抢占
  if (hasAny(norm, PROMOTE)) return { kind: "promote" };

  // 6) 帮助
  if (HELP.some((word) => norm === normalize(word))) return { kind: "help" };

  // 7) 默认：建任务。说"先/马上/立刻"视为插队
  const preempt = /^(先|马上|立刻|现在先)/.test(norm);
  return { kind: "create_task", text: raw, preempt };
}

/* --------------------------------------------------------- 口语化渲染 */

const STATE_SPEECH: Record<SessionState, string> = {
  queued: "还在排队",
  starting: "刚要开始",
  running: "在跑",
  waiting_user: "等你确认",
  paused: "暂停着",
  done: "已经做完",
  failed: "失败了",
  aborted: "停了",
};

const PHASE_SPEECH: Record<string, string> = {
  thinking: "在想",
  acting: "在操作",
  verifying: "在核对",
  idle: "空闲",
};

export interface StatusFacts {
  title: string;
  state: SessionState;
  phase: string;
  turn: number;
  tool: string | null;
  elapsedMs: number;
  needs: string | null;
  summary: string | null;
  artifacts: string[];
}

/** 一句话说清"卡在哪一步"（验收要求 9/10） */
export function renderStatus(facts: StatusFacts): string {
  const title = facts.title || "这个任务";
  const seconds = Math.max(1, Math.round(facts.elapsedMs / 1000));
  const base = `「${title}」${STATE_SPEECH[facts.state] ?? facts.state}`;
  if (facts.state === "done" && facts.summary) return `${base}：${facts.summary}`;
  if (facts.state === "failed") return `${base}，${facts.summary ?? "原因还没拿到"}`;
  if (facts.state === "waiting_user") return `${base}，等你点一下。`;
  if (facts.state === "queued") return `${base}，前面还有任务。`;
  const phase = PHASE_SPEECH[facts.phase] ?? facts.phase;
  const tool = facts.tool ? `，正在${facts.tool}` : "";
  return `${base}，${phase}${tool}，第 ${Math.max(1, facts.turn)} 轮，已经 ${seconds} 秒。`;
}
