/**
 * 播报拆句：一句话太长时，先合成第一句先出声，后面的在后面合成/排播。
 * 这样长结论（任务总结、读消息）不用等整段合成完才听到第一个字。
 *
 * 规则：
 * - 短句（≤26 字）不拆，避免把一句完整的话切碎
 * - 按句末标点切，最多 4 段；剩下的并进最后一段
 * - 每段都去掉首尾空白，空段丢弃
 */

const MAX_CHUNKS = 4;
const SHORT_ENOUGH = 26;
const SENTENCE_END = /[。！？!?；;\n]/;

export function splitSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= SHORT_ENOUGH) return [trimmed];

  const pieces: string[] = [];
  let current = "";
  for (const char of trimmed) {
    current += char;
    if (SENTENCE_END.test(char)) {
      const piece = current.trim();
      if (piece) pieces.push(piece);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) {
    if (pieces.length > 0 && pieces.length >= MAX_CHUNKS) pieces[pieces.length - 1] += tail;
    else pieces.push(tail);
  }
  if (pieces.length <= 1) return [trimmed];

  // 超过上限就把多余的并进最后一段
  if (pieces.length > MAX_CHUNKS) {
    const head = pieces.slice(0, MAX_CHUNKS - 1);
    head.push(pieces.slice(MAX_CHUNKS - 1).join(""));
    return head;
  }
  return pieces;
}
