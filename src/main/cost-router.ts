/**
 * 成本路由（方案 0 / 1.2 的 A0–A3 与实时预算）。
 *
 * 把每一轮按"花了多少钱"分档：
 *   a0  反射命中，零模型零网络（"停"、"可以"、查进度…）
 *   a1  一次短补全 + 缓存 ack（问句、调度判别）
 *   a2  批次语音（整段识别 / 整段合成）
 *   l3  实时通道（全双工、边说边回）——最贵，硬预算 3%
 *
 * 现在真正存在的实时能力只有流式识别（算 a2，和批次同一价档），
 * 所以 l3 目前没有消费者；这里的预算阀门先建好并被单测覆盖，
 * 等接上实时语音时直接用它挡。统计数字在「关于」里能看到。
 */

export type TurnClass = "a0" | "a1" | "a2" | "l3";

/** 实时通道的硬上限：超过就退回批次（方案 voice 0 的"≤3%"） */
export const REALTIME_BUDGET = 0.03;

/** 样本太少时不做比例判断，否则前几轮全是实时 */
const MIN_TURNS_FOR_BUDGET = 20;

interface Stats {
  turns: Record<TurnClass, number>;
  total: number;
}

const stats: Stats = { turns: { a0: 0, a1: 0, a2: 0, l3: 0 }, total: 0 };

export function noteTurn(kind: TurnClass): void {
  stats.turns[kind] += 1;
  stats.total += 1;
}

export interface ChannelStats {
  total: number;
  a0: number;
  a1: number;
  a2: number;
  l3: number;
  /** 实时通道占比（0–1） */
  realtimeRatio: number;
  /** 现在还能不能用实时通道 */
  realtimeAllowed: boolean;
}

export function channelStats(): ChannelStats {
  const ratio = stats.total === 0 ? 0 : stats.turns.l3 / stats.total;
  return {
    total: stats.total,
    a0: stats.turns.a0,
    a1: stats.turns.a1,
    a2: stats.turns.a2,
    l3: stats.turns.l3,
    realtimeRatio: ratio,
    realtimeAllowed: canUseRealtime(),
  };
}

/** 实时预算还有没有：样本足够时才按比例挡 */
export function canUseRealtime(): boolean {
  if (stats.total < MIN_TURNS_FOR_BUDGET) return true;
  return stats.turns.l3 / stats.total < REALTIME_BUDGET;
}

export interface AsrRouteInput {
  /** 绑定的识别模型是不是流式 */
  streamingReady: boolean;
  /** 免按键/唤醒词这类"持续对话"场景 */
  conversational: boolean;
}

export interface AsrRoute {
  /** realtime 走流式会话，batch 走整段上传 */
  channel: "realtime" | "batch";
  reason: string;
}

/**
 * 识别通道：流式只在"持续对话"里开，单次指令用批次。
 * 两者同一价档，所以不计入 l3 预算；这里省的是连接与句柄，不是钱。
 */
export function chooseAsrChannel(input: AsrRouteInput): AsrRoute {
  if (!input.streamingReady) return { channel: "batch", reason: "没有绑定流式识别模型" };
  if (!input.conversational) return { channel: "batch", reason: "单次指令，批次更省事" };
  return { channel: "realtime", reason: "持续对话，边说边出字" };
}

/** 测试用：清空统计 */
export function resetChannelStats(): void {
  stats.turns = { a0: 0, a1: 0, a2: 0, l3: 0 };
  stats.total = 0;
}
