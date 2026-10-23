/**
 * 把一次按键事件翻译成 Electron accelerator。
 * 纯函数，方便单测（不依赖 DOM 的 KeyboardEvent）。
 *
 * 规则：
 * - 修饰键 + 普通键（字母/数字/符号/F 键/方向键/空格…）
 * - 单独的 F1–F24 也允许（不占用字母键，冲突少）
 * - 只有修饰键、或者单独的字母/数字，不算数（返回 null）
 */

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const NAMED: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

export function acceleratorFromKey(event: KeyLike): string | null {
  const mods: string[] = [];
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Command");

  const code = event.code;
  let key: string | null = null;

  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (NAMED[code]) key = NAMED[code];

  if (!key) return null;

  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (mods.length === 0 && !isFunctionKey) return null;

  // 只有 Shift + 字母，等于大写字母，不适合当全局热键
  if (mods.length === 1 && mods[0] === "Shift" && /^[A-Z0-9]$/.test(key)) return null;

  return [...mods, key].join("+");
}

/** 按键过程中给用户看的提示（还没按完） */
export function describeModifiers(event: Pick<KeyLike, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Win");
  return parts.join(" + ");
}
