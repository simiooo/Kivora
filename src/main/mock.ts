import type { AppConfig } from "../shared/ipc.ts";

/**
 * D0 mock dispatcher. Mirrors the shape of the real VoiceAgent result:
 * one short spoken line, no tool calls yet. Replaced in D3 by
 * pi-agent-core with the 14 dispatcher tools.
 */
export function mockDispatch(text: string, cfg: AppConfig): string {
  const t = text.trim();
  if (!t) return "我在。";
  if (/^(停|取消|算了|不用了)/.test(t)) return "好，停了。";
  if (/(怎么样|好了吗|做完|完事|搞定|进度|到哪了|还在|完成)/.test(t)) return "刚才那个还在跑，我盯着呢。";
  if (/^(你好|hi|hello|在吗)/i.test(t)) return "在。你说。";
  if (/(打开|搜索|整理|挪|移动|发给|查一下)/.test(t)) {
    return `好，我去办：「${t}」。当前是 mock，真实调度模型是 ${cfg.brainModel}。`;
  }
  return `收到：「${t}」。`;
}
