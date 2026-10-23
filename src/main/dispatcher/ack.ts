/**
 * 接话：模型还在判断的时候，先说一句"让我捋一下"，别让人对着空气等。
 *
 * 只做意图粗分，不调用任何模型——它要抢在 brain 判断之前出声（通常几十毫秒内），
 * 所以用词面特征：问句、动作动词、其余归到"嗯，我想想"。
 * 短语固定、可缓存，合成一次以后复用（ackEnabled 的缓存就是它）。
 */

type AckKind = "task" | "question" | "unclear";

const PHRASES: Record<AckKind, string[]> = {
  task: ["好，让我先捋一捋。", "行，我先理一下。", "好，我来安排。"],
  question: ["我看一下。", "让我查一下。"],
  unclear: ["嗯，我想想。"],
};

const QUESTION = /(\?|？|吗|呢)\s*$|什么|怎么|为什么|为啥|多少|哪个|哪里|哪些|是不是|能不能|有没有|谁|几点|什么时候/;
const ACTION =
  /(整理|收拾|挪|移动|搬|复制|删|重命名|搜|查|找|打开|关掉|发|写|存|下载|上传|安装|卸载|运行|跑|读取|总结|翻译|生成|做个|弄个|搞个)/;

export function ackKindOf(text: string): AckKind {
  const value = text.trim();
  if (!value) return "unclear";
  if (QUESTION.test(value)) return "question";
  if (ACTION.test(value)) return "task";
  return "unclear";
}

/** 这句像不像在问问题（用来决定"该答"还是"该干活"） */
export function isQuestion(text: string): boolean {
  return QUESTION.test(text.trim());
}

/** 有没有明确的动作词——有问题但也要动手的句子，仍然按任务走 */
export function looksActionable(text: string): boolean {
  return ACTION.test(text.trim());
}

let cursor = 0;

/** 轮着用几种说法，避免每次都一模一样；短语固定，TTS 缓存能复用 */
export function acknowledgmentFor(text: string): string {
  const options = PHRASES[ackKindOf(text)];
  const phrase = options[cursor % options.length] ?? "好，让我先捋一捋。";
  cursor += 1;
  return phrase;
}

export function resetAckCursor(): void {
  cursor = 0;
}
