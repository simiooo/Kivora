import {
  appendEvent,
  appendMessage,
  countSessions,
  createSession,
  patchStatus,
  setSessionState,
} from "./repos/sessions.ts";
import { createApproval, resolveApproval } from "./repos/approvals.ts";
import { enqueue } from "./repos/queue.ts";

/**
 * 演示数据：只在 `--shots` 截图模式（临时 userData）或显式 KIVORA_DEMO=1 时写入。
 * 时间全部相对"现在"，免得截图里出现 1h20m 这种跟叙述不符的时长。
 */

const FILES = ["发票-0912.pdf", "发票-0913.pdf", "发票-0914.pdf", "发票-0915.pdf"];
const LATE_FILES = ["发票-0916.pdf", "发票-0917.pdf", "发票-0918.pdf"];

export function seedDemoData(): void {
  if (countSessions() > 1) return;

  const now = Date.now();
  const minute = 60_000;
  const tInvoice = now - 26 * minute; // 已完成的那段对话
  const tBrowser = now - 12 * minute; // 正在跑
  const tQueue = now - 11 * minute;
  const tPending = now - 40_000; // 刚问的问题

  // A. 已完成的整理发票（画板 05 的详情）
  const a = createSession({
    title: "整理发票",
    prompt: "把下载目录里上周的 pdf 挪到文档/发票",
    runner: "mock",
    state: "running",
    createdAt: tInvoice,
  });
  appendEvent(a.id, "started", "开始 · claude-sonnet-4-6", {}, tInvoice);
  appendEvent(a.id, "tool_start", "读目录 ~/Downloads · 4 个 pdf", { tool: "read_dir" }, tInvoice + 900);
  appendEvent(a.id, "tool_end", "找到 4 个 pdf（本月）", { ok: true }, tInvoice + 1400);
  appendEvent(a.id, "approval", "等待确认 · 移动到 文档/发票", { risk: "G2" }, tInvoice + 1800);
  appendEvent(a.id, "approval_resolved", "语音允许 · 移动到 文档/发票", { resolution: "allow_once" }, tInvoice + 30_000);
  appendEvent(a.id, "tool_start", "移动 4 个文件 → 文档/发票", { tool: "move_file" }, tInvoice + 31_000);
  appendEvent(a.id, "tool_end", "4 个文件已就位", { ok: true }, tInvoice + 31_400);
  appendEvent(a.id, "done", "挪好了，4 个。", {}, tInvoice + 32_000);

  const approval = createApproval({
    source: "session",
    sessionId: a.id,
    tool: "move_file",
    risk: "G2",
    title: "移动到 文档/发票",
    summary: "要移动 4 个文件，可以吗？",
    detail: FILES,
    speech: "要移动 4 个文件，可以吗？",
    timeoutMs: null,
  });
  appendMessage({ role: "user", content: "把下载目录里上周的 pdf 挪到文档/发票", ts: tInvoice, source: "voice", confidence: 0.94, sessionId: a.id });
  appendMessage({ role: "assistant", content: "要移动 4 个文件，可以吗？", ts: tInvoice + 2_000, approvalId: approval.id, sessionId: a.id });
  appendMessage({ role: "user", content: "可以", ts: tInvoice + 30_000, source: "voice", confidence: 0.98, sessionId: a.id });
  appendMessage({ role: "assistant", content: "挪好了，4 个。", ts: tInvoice + 32_000, sessionId: a.id });
  resolveApproval(approval.id, "allow_once");
  patchStatus(a.id, { turn: 2, phase: "idle", tool: null, artifacts: FILES, summary: "挪好了，4 个。" });
  setSessionState(a.id, "done", { summary: "挪好了，4 个。", endedAt: tInvoice + 32_000 });

  // B. 正在跑的搜索（画板 01 的任务条 / 02 的过程日志）
  const b = createSession({
    title: "搜索机械键盘",
    prompt: "帮我在京东搜机械键盘，按销量排",
    runner: "mock",
    state: "running",
    createdAt: tBrowser,
  });
  appendEvent(b.id, "started", "开始 · claude-sonnet-4-6", {}, tBrowser);
  appendEvent(b.id, "tool_start", "启动浏览器", { tool: "browser" }, tBrowser + 500);
  appendEvent(b.id, "turn", "第 2 轮 · 打开搜索页", { turn: 2 }, tBrowser + 1_500);
  appendEvent(b.id, "tool_end", "搜索页已加载", { ok: true }, tBrowser + 2_500);
  appendEvent(b.id, "turn", "第 3 轮 · 输入关键词并排序", { turn: 3 }, tBrowser + 3_500);
  patchStatus(b.id, {
    state: "running",
    turn: 3,
    phase: "acting",
    tool: "输入并排序",
    artifacts: ["搜索结果 32 条"],
  });
  appendMessage({ role: "user", content: "帮我在京东搜机械键盘，按销量排", ts: tBrowser, source: "voice", confidence: 0.91, sessionId: b.id });
  appendMessage({ role: "assistant", content: "好，我去搜。", ts: tBrowser + 300, sessionId: b.id });

  // 长回复：用来演示 6 行折叠 + 阅读器（画板 10 / 14）
  const longReply = [
    "按销量排下来，前 12 个是这些（价格是页面标价，没算券）：",
    "1. Keychron K8 Pro · 87 键 · ¥699 · 三模热插拔",
    "2. 狼蛛 F87 Pro · 87 键 · ¥299 · 侧刻 PBT",
    "3. 达尔优 A98 Pro · 98 键 · ¥499 · 天空轴 V4",
    "4. 珂芝 K75 · 75 键 · ¥399 · 金粉轴",
    "5. 京造 JZ870 · 87 键 · ¥199 · 有线单模",
    "6. RK R87 · 87 键 · ¥189 · 入门款",
    "7. 黑爵 AK820 · 82 键 · ¥329 · Gasket 结构",
    "8. 高斯 HS87T · 87 键 · ¥329 · 干电池",
    "9. 御斧 Y87 · 87 键 · ¥429 · 全键热插拔",
    "10. 腹灵 MK870 · 87 键 · ¥399 · 客制化入门",
    "11. 阿米洛 VA87 · 87 键 · ¥899 · 静电容手感",
    "12. 杜伽 K320 · 87 键 · ¥599 · 原厂轴",
    "要我把前三个的链接整理出来，还是先按你的预算筛一遍？",
  ].join("\n");
  appendMessage({ role: "assistant", content: longReply, ts: tBrowser + 4_500, sessionId: b.id });

  // C. 排队的第三条（画板 07）
  const c = createSession({
    title: "读一下未读消息",
    prompt: "读一下未读消息",
    runner: "mock",
    state: "queued",
    createdAt: tQueue,
  });
  enqueue(c.id, "读一下未读消息", "queue");
  appendEvent(c.id, "queued", "排队中 · 前面是「搜索机械键盘」", {}, tQueue);

  // D. 等确认的第二批发票（画板 09 的浮窗来源）
  const d = createSession({
    title: "整理第二批发票",
    prompt: "把下载目录里新到的发票也挪过去",
    runner: "mock",
    state: "waiting_user",
    createdAt: tPending - 8_000,
  });
  appendEvent(d.id, "started", "开始 · claude-sonnet-4-6", {}, tPending - 8_000);
  appendEvent(d.id, "tool_start", "读目录 ~/Downloads", { tool: "read_dir" }, tPending - 6_000);
  appendEvent(d.id, "tool_end", "找到 3 个新 pdf", { ok: true }, tPending - 5_000);
  appendEvent(d.id, "approval", "等待确认 · 移动到 文档/发票", { risk: "G2" }, tPending);
  patchStatus(d.id, {
    state: "waiting_user",
    needs: "confirm",
    turn: 1,
    phase: "acting",
    tool: "move_file",
    artifacts: LATE_FILES,
  });
  const pending = createApproval({
    source: "session",
    sessionId: d.id,
    tool: "move_file",
    risk: "G2",
    title: "移动到 文档/发票",
    summary: "还有 3 个新的，要一起挪吗？",
    detail: LATE_FILES,
    speech: "还有 3 个新的，要一起挪吗？",
    timeoutMs: 60_000,
  });
  appendMessage({ role: "assistant", content: "还有 3 个新的，要一起挪吗？", ts: tPending, approvalId: pending.id, sessionId: d.id });

  console.log("[kivora] demo data seeded");
}
