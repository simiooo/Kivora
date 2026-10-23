import type { ModelRecord } from "../../shared/domain.ts";
import { chatCompletion } from "../providers/llm.ts";

/**
 * 调度 LLM 只做"判别 + 一句话旁白"，不做任何执行。
 * 它必须在 4 秒内回，回不来就整段降级到反射路由（3.10 降级）。
 */

export interface BrainDecision {
  action: "create_task" | "status" | "cancel" | "queue" | "steer" | "promote" | "retry" | "clarify";
  title?: string;
  speech?: string;
  question?: string;
}

const SYSTEM = [
  "你是 Kivora 的语音调度层。你只做一件事：把用户的一句话判成一个动作。",
  "可选动作：create_task（开新任务）、status（查进度）、cancel（停止）、queue（追加到当前会话）、promote（插队）、retry（重试）、clarify（需要问一句）。",
  "要求：",
  "1. 只输出 JSON，形如 {\"action\":\"create_task\",\"title\":\"整理发票\",\"speech\":\"好，我去整理。\"}",
  "2. title ≤ 12 个汉字，是任务名；speech ≤ 15 个汉字，是马上要说出的话。",
  "3. 不要解释，不要 markdown。",
].join("\n");

function stripToJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return "";
  return text.slice(start, end + 1);
}

export async function classify(
  model: ModelRecord,
  apiKey: string | null,
  text: string,
  context: string,
  signal?: AbortSignal,
): Promise<BrainDecision | null> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const result = await chatCompletion(
      model,
      apiKey,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `当前上下文：${context}\n用户说：${text}` },
      ],
      { maxTokens: 120, temperature: 0, signal: controller.signal },
    );
    const json = stripToJson(result.text);
    if (!json) return null;
    const parsed = JSON.parse(json) as Partial<BrainDecision>;
    const allowed = ["create_task", "status", "cancel", "queue", "steer", "promote", "retry", "clarify"];
    if (!parsed.action || !allowed.includes(parsed.action)) return null;
    return {
      action: parsed.action,
      title: typeof parsed.title === "string" ? parsed.title.slice(0, 24) : undefined,
      speech: typeof parsed.speech === "string" ? parsed.speech.slice(0, 40) : undefined,
      question: typeof parsed.question === "string" ? parsed.question.slice(0, 40) : undefined,
    };
  } catch (err) {
    console.warn("[kivora] brain classify failed, fallback to reflex", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
