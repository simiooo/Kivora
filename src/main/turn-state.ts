import { broadcast, isSpeaking, setSpeaking } from "./bus.ts";

/**
 * 一轮对话的"现在是什么状态"：在想、在说、被打断。
 *
 * 悬浮窗照着它画状态，所以任何变化都广播一次 overlay。
 * interrupt 做三件事：掐掉正在播的语音、取消正在等的那次判断、让这一轮的后续副作用作废。
 */

let thinking = false;
let turnSeq = 0;
let controller: AbortController | null = null;
let lastInteractionAt = Date.now();

/** 一次交互（说话/点按钮都算）：免按键模式靠它判断"多久没人理我了" */
export function markInteraction(): void {
  lastInteractionAt = Date.now();
}

export function idleMs(): number {
  return Date.now() - lastInteractionAt;
}

export interface TurnTicket {
  seq: number;
  signal: AbortSignal;
}

/** 每处理一句话开一张票；新的一句会作废上一张 */
export function beginTurn(): TurnTicket {
  controller?.abort();
  controller = new AbortController();
  turnSeq += 1;
  markInteraction();
  return { seq: turnSeq, signal: controller.signal };
}

/** 这张票还有效吗（被打断之后就别再往下写了） */
export function isCurrentTurn(seq: number): boolean {
  return seq === turnSeq;
}

export function setThinking(value: boolean): void {
  if (thinking === value) return;
  thinking = value;
  broadcast("overlay");
}

export function isThinking(): boolean {
  return thinking;
}

/** 打断：停播报、停判断、清状态。不负责取消任务（那是「停」这条指令的事） */
export function interruptTurn(): boolean {
  const wasBusy = thinking || isSpeaking();
  controller?.abort();
  controller = null;
  turnSeq += 1;
  setSpeaking(false);
  if (thinking) {
    thinking = false;
    broadcast("overlay");
  }
  return wasBusy;
}
