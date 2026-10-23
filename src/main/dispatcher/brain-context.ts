import type { SessionState } from "../../shared/domain.ts";

/**
 * 调度模型的上下文（方案 2.3 的瘦身版）。
 *
 * 分层的意义不是"喂更多字"，而是分层决定什么该稳定、什么该变动：
 * - 稳定的规则放 system（brain.ts 里，逐字不变，吃 provider 的前缀缓存）
 * - 每轮会变的东西（谁在跑、队列、刚才说过什么）放 user 消息的尾部
 *
 * 现在有 5 层：偏好 → 最近说过的 → 上次任务 → 当前状态 → 队列。
 * 没有"长期记忆"这一层：产品还没有记忆库，宁缺毋滥。
 */

export interface BrainContextInput {
  running: { title: string; phase: string } | null;
  pendingApproval: boolean;
  queueCount: number;
  lastRun: { title: string; state: SessionState; ageMs: number } | null;
  /** 最近几句用户原话，新的在前 */
  recentUtterances: string[];
  preferences: { asrLanguage: "zh" | "en" | "auto"; narration: boolean };
}

const STATE_LABEL: Record<SessionState, string> = {
  queued: "排队",
  starting: "刚要开始",
  running: "在跑",
  waiting_user: "等你确认",
  paused: "暂停",
  done: "做完了",
  failed: "失败了",
  aborted: "停了",
};

function ageLabel(ageMs: number): string {
  if (ageMs < 60_000) return "刚刚";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} 分钟前`;
  return `${Math.round(ageMs / 3_600_000)} 小时前`;
}

function clip(text: string, max = 30): string {
  const value = text.trim().replace(/\s+/g, " ");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function buildBrainContext(input: BrainContextInput): string {
  const lines: string[] = [];

  const language = input.preferences.asrLanguage === "en" ? "英文" : input.preferences.asrLanguage === "auto" ? "中英混合" : "中文";
  lines.push(`用户偏好：主要说${language}；${input.preferences.narration ? "允许出声" : "不要主动出声"}`);

  const recent = input.recentUtterances.slice(0, 3).map((item) => clip(item)).filter(Boolean);
  if (recent.length > 0) lines.push(`最近说过：${recent.join(" / ")}`);

  if (input.lastRun) {
    lines.push(`上次任务：${clip(input.lastRun.title, 18)}（${STATE_LABEL[input.lastRun.state]}，${ageLabel(input.lastRun.ageMs)}）`);
  }

  const current: string[] = [];
  if (input.running) current.push(`正在跑「${clip(input.running.title, 18)}」，阶段 ${input.running.phase}`);
  if (input.pendingApproval) current.push("有一个等确认的审批");
  lines.push(`当前：${current.join("；") || "空闲"}`);

  if (input.queueCount > 0) lines.push(`队列：${input.queueCount} 条`);

  return lines.join("\n");
}
