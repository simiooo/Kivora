import type { ModelRecord } from "../../shared/domain.ts";
import { chatCompletion } from "../providers/llm.ts";

/**
 * 调度 LLM 只做"判别 + 一句话旁白"，不做任何执行。
 * 它必须在 4 秒内回，回不来就整段降级到反射路由（3.10 降级）。
 */

export interface BrainDecision {
  action: "create_task" | "answer" | "status" | "cancel" | "queue" | "steer" | "promote" | "retry" | "clarify";
  title?: string;
  speech?: string;
  question?: string;
}

const SYSTEM = [
  "你是 Kivora 的语音调度层。你把用户的一句话判成一个动作，并给出要说的话。",
  "可选动作：",
  "- answer：用户只是在问一件事（时间、常识、刚才的情况），不需要动文件或电脑。答案放 speech。",
  "- create_task：需要实际动手（整理文件、搜索、读消息…）。title 是任务名。",
  "- status / cancel / queue / promote / retry：针对正在跑或刚跑完的会话。",
  "- clarify：信息不够，需要反问一句，问题放 question。",
  "要求：",
  "1. 只输出 JSON，形如 {\"action\":\"answer\",\"speech\":\"今天是 10 月 24 日，星期六。\"}",
  "2. answer 的 speech ≤ 40 个汉字，直接说结论，不要解释过程；不确定就说不知道。",
  "3. create_task 的 title ≤ 12 个汉字，speech ≤ 15 个汉字（马上要说的话）。",
  "4. 不要 markdown，不要多余文字。",
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
  diagnostics?: { failed?: boolean },
): Promise<BrainDecision | null> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 4000);
  // 模型不知道今天几号，把它当前的真实时间一起给它
  const now = new Date().toLocaleString("zh-CN", { hour12: false, weekday: "long" });
  try {
    const result = await chatCompletion(
      model,
      apiKey,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `现在是 ${now}。\n当前上下文：${context}\n用户说：${text}` },
      ],
      { maxTokens: 160, temperature: 0, signal: controller.signal },
    );
    const json = stripToJson(result.text);
    if (!json) return null;
    const parsed = JSON.parse(json) as Partial<BrainDecision>;
    const allowed = ["answer", "create_task", "status", "cancel", "queue", "steer", "promote", "retry", "clarify"];
    if (!parsed.action || !allowed.includes(parsed.action)) return null;
    return {
      action: parsed.action,
      title: typeof parsed.title === "string" ? parsed.title.slice(0, 24) : undefined,
      speech: typeof parsed.speech === "string" ? parsed.speech.slice(0, 120) : undefined,
      question: typeof parsed.question === "string" ? parsed.question.slice(0, 40) : undefined,
    };
  } catch (err) {
    console.warn("[kivora] brain classify failed, fallback to reflex", (err as Error).message);
    // 被主动打断不算"模型挂了"，不该给用户播降级提示
    if (diagnostics && !signal?.aborted) diagnostics.failed = true;
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
