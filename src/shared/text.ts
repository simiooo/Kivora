/**
 * 文本呈现规则（画板 10 / 14 的落地）。
 *
 * 两种省略号不能混用：
 * - 散文用尾部省略：只留开头，结尾一个 `…`。
 * - 路径 / URL / 模型 ID / Key 用中间省略：保留头尾，中间一个 `…`。
 *   因为路径的尾部（文件名）才是人要确认的东西。
 */

const ELLIPSIS = "…";

export function tailEllipsis(value: string, max: number): string {
  const text = value.trim();
  if (max <= 1) return ELLIPSIS;
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + ELLIPSIS;
}

/** 按头尾比例切：默认 35% 头 / 65% 尾，路径优先保住文件名 */
export function middleEllipsis(value: string, max: number, headRatio = 0.35): string {
  const text = value.trim();
  if (max <= 3) return ELLIPSIS;
  if (text.length <= max) return text;
  const budget = max - 1;
  const headLen = Math.max(2, Math.min(budget - 2, Math.round(budget * headRatio)));
  const tailLen = budget - headLen;
  return text.slice(0, headLen).trimEnd() + ELLIPSIS + text.slice(text.length - tailLen).trimStart();
}

/** 路径：先归一化分隔符，再中间省略 */
export function displayPath(value: string, max = 44): string {
  return middleEllipsis(value.replace(/\//g, "\\"), max, 0.32);
}

export function displayUrl(value: string, max = 44): string {
  return middleEllipsis(value.replace(/\/+$/, ""), max, 0.45);
}

/** API Key 只留头尾：sk-••••••9f2c */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  const head = trimmed.slice(0, Math.min(3, trimmed.length - 4));
  const tail = trimmed.slice(-4);
  return `${head}${"•".repeat(6)}${tail}`;
}

export function countChars(value: string): number {
  return Array.from(value).length;
}

/** Electron accelerator → 人看的写法：CommandOrControl+Alt+Space → Ctrl+Alt+Space */
export function formatHotkey(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl|Control/g, "Ctrl")
    .replace(/Command/g, "⌘")
    .replace(/Option/g, "Alt")
    .replace(/\+/g, "+");
}

/** 按行折叠：超出行数时返回截断文本与是否截断 */
export function foldLines(value: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = value.split("\n");
  if (lines.length <= maxLines) return { text: value, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

/** 工具输出：8 行或 2000 字符，首尾保留 */
export function foldOutput(value: string, maxLines = 8, maxChars = 2000): { text: string; truncated: boolean } {
  const byLines = foldLines(value, maxLines);
  if (!byLines.truncated && countChars(byLines.text) <= maxChars) {
    return { text: byLines.text, truncated: false };
  }
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    // 字符不多，只是行数多：按行折叠就够
    return { text: byLines.text, truncated: byLines.truncated };
  }
  const budget = Math.floor(maxChars / 2);
  return {
    text: chars.slice(0, budget).join("") + "\n" + ELLIPSIS + "\n" + chars.slice(-budget).join(""),
    truncated: true,
  };
}

const timeFmt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" });
const fullFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatTime(ts: number): string {
  return timeFmt.format(new Date(ts));
}

export function formatDate(ts: number): string {
  return dateFmt.format(new Date(ts));
}

export function formatFullTime(ts: number): string {
  return fullFmt.format(new Date(ts));
}

/** 8s / 1m20s / 2h */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(ts);
}

/** 会话列表分组：今天 / 昨天 / 更早 */
export function dayBucket(ts: number, now = Date.now()): "今天" | "昨天" | "更早" {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();
  if (ts >= todayStart) return "今天";
  if (ts >= todayStart - 86_400_000) return "昨天";
  return "更早";
}

export function plural(count: number, unit: string): string {
  return `${count} ${unit}`;
}
