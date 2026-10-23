/**
 * 唤醒词检测：只看文字，不看音频。
 *
 * 为什么不做本地音频唤醒：那需要一个声学模型（Porcupine 要商业 key，
 * openWakeWord 要 ONNX 运行时和训练数据），体积与授权都不适合现在。
 * 折中方案是"先开口，再把前 1.5 秒送去识别，看有没有叫名字"——
 * 代价是没叫名字的那一小段也会经过识别服务，所以默认关闭，
 * 设置里写清这一点，由用户自己决定要不要换这点隐私换误触发保护。
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~～…"'“”‘’（）()《》【】[\]]+/g, "");
}

/** 说的这句话里有没有叫名字（子串匹配，容忍标点和大小写） */
export function containsWakeWord(text: string, word: string): boolean {
  const target = normalize(word);
  if (!target) return false;
  return normalize(text).includes(target);
}

/** 去掉开头的称呼，留下真正的指令（"小栗，把发票挪过去" → "把发票挪过去"） */
export function withoutWakeWord(text: string, word: string): string {
  const trimmed = text.trim();
  const target = normalize(word);
  if (!target) return trimmed;
  const pattern = new RegExp(
    `^\\s*(hey\\s+)?${target.split("").map(escapeRegExp).join("[\\s，。,.!！:：]*")}[\\s，。,.!！:：]*`,
    "i",
  );
  const stripped = trimmed.replace(pattern, "").trim();
  return stripped || trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
