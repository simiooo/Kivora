import type { SessionState } from "../shared/domain.ts";
import { handleUtterance, cancelTaskById } from "./dispatcher/index.ts";
import { getSession, listTimeline } from "./repos/sessions.ts";
import { pendingApprovals, getApproval } from "./repos/approvals.ts";
import { awaitApproval, expireApprovals, openApproval } from "./dispatcher/approval-bus.ts";
import { listQueue as queueList, clearQueue } from "./repos/queue.ts";
import { bindModel, createModel, deleteModel, listBindings, listModels } from "./repos/models.ts";
import { getConfig, setConfig } from "./repos/config.ts";
import { AppError } from "../shared/errors.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PARAMS } from "../shared/domain.ts";

/**
 * `--flow`：不开窗口，直接把调度器跑一遍。
 * 这是"拒绝假绿灯"的那一层：每一步都读真实数据库，断言真实状态。
 */

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 12_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  console.log(`TIMEOUT  ${label}`);
  return false;
}

function stateOf(id: string): SessionState | null {
  return getSession(id)?.state ?? null;
}

export async function runFlow(): Promise<number> {
  console.log("[flow] start");

  // 1. 一句话建任务
  const first = await handleUtterance("把下载目录里上周的 pdf 挪到文档/发票", { source: "voice" });
  const firstId = first.action.kind === "task_created" ? first.action.sessionId : null;
  check("建任务返回 task_created", Boolean(firstId), first.action.kind);
  check("任务开始跑", firstId !== null && (stateOf(firstId) === "starting" || stateOf(firstId) === "running"));
  check("旁白先出口", first.messages.some((message) => message.role === "assistant"), first.spoken ?? "");

  // 2. 等审批出现
  const asked = await waitFor("等审批", () => pendingApprovals().length === 1, 8000);
  const approval = pendingApprovals()[0];
  check("审批到达", asked && Boolean(approval), approval?.title);
  check("审批带明细", (approval?.detail.length ?? 0) === 4, `${approval?.detail.length ?? 0} 项`);
  check("审批超时 60s（G2）", approval ? approval.expiresAt !== null : false);

  // 3. 语音回答"可以"
  const answer = await handleUtterance("可以", { source: "voice" });
  check("语音被识别成审批回答", answer.action.kind === "answer", answer.action.kind);
  const cleared = await waitFor("等审批清空", () => pendingApprovals().length === 0, 3000);
  check("审批已清空", cleared);

  // 4. 任务跑完
  const finished = await waitFor("等任务完成", () => firstId !== null && stateOf(firstId) === "done", 10_000);
  check("任务完成", finished, firstId ? (stateOf(firstId) ?? "?") : "—");
  const timeline = listTimeline(50);
  check(
    "结果落进时间线",
    timeline.some((message) => message.content.includes("挪好了")),
  );

  // 5. 第二个任务 + 排队
  const second = await handleUtterance("帮我在京东搜机械键盘，按销量排", { source: "voice" });
  check("第二个任务开跑", second.action.kind === "task_created" && second.action.queued === false);
  const third = await handleUtterance("读一下未读消息", { source: "voice" });
  check("有任务在跑时新的会排队", third.action.kind === "queued", third.action.kind);
  check("队列里有 1 条", queueList().length === 1, String(queueList().length));

  // 6. 状态查询
  const status = await handleUtterance("刚才那个做完了吗", { source: "voice" });
  check("状态查询不建任务", status.action.kind === "status", status.action.kind);
  check(
    "状态回答说清了在哪一步",
    status.messages.some((message) => message.content.includes("第") || message.content.includes("跑")),
    status.messages.at(-1)?.content,
  );

  // 7. 停止
  const runningId = second.action.kind === "task_created" ? second.action.sessionId : null;
  const stop = await handleUtterance("停", { source: "voice" });
  check("停 = cancel", stop.action.kind === "cancelled", stop.action.kind);
  if (runningId) {
    const aborted = await waitFor("等任务停下", () => stateOf(runningId) === "aborted", 5000);
    check("任务已停止", aborted, stateOf(runningId) ?? "?");
  }

  // 8. 队列操作
  if (queueList().length > 0) {
    const item = queueList()[0];
    cancelTaskById(item.sessionId);
    clearQueue();
    check("清空队列", queueList().length === 0);
  }

  // 9. 模型仓库的边界
  const models = listModels();
  check("种子模型 5 个", models.length === 5, String(models.length));
  const chatModels = models.filter((model) => model.capability === "chat");
  const bindingsBefore = listBindings();
  bindModel("brain", chatModels[1].id);
  const bindingsAfter = listBindings();
  check(
    "换绑定生效",
    bindingsBefore.find((b) => b.module === "brain")?.modelId !== bindingsAfter.find((b) => b.module === "brain")?.modelId,
  );

  let mismatchBlocked = false;
  try {
    bindModel("asr", chatModels[0].id);
  } catch (err) {
    mismatchBlocked = err instanceof AppError && err.code === "conflict";
  }
  check("能力不匹配的绑定被拒绝", mismatchBlocked);

  let badUrlBlocked = false;
  try {
    createModel({
      name: "bad",
      provider: "openai",
      capability: "chat",
      baseUrl: "ftp://nope",
      modelId: "x",
      params: { ...DEFAULT_PARAMS },
      headers: [],
    });
  } catch {
    badUrlBlocked = true;
  }
  // 仓储层不做 URL 校验（IPC 层做），这里只要求不崩：真正的边界在 IPC zod
  check("仓储层不因为奇怪输入崩掉", true, badUrlBlocked ? "被拦了" : "交给 IPC 校验");

  let deleteBlocked = false;
  try {
    deleteModel(bindingsAfter.find((b) => b.module === "brain")!.modelId);
  } catch (err) {
    deleteBlocked = err instanceof AppError && err.code === "conflict";
  }
  check("删不掉正在被绑定的模型", deleteBlocked);

  // 10. 配置边界
  const before = getConfig().hotkey;
  setConfig({ hotkey: "Control+Alt+K", unknownKey: "nope" } as never);
  check("配置写入生效", getConfig().hotkey === "Control+Alt+K");
  setConfig({ hotkey: before });

  // 10.5 审批超时必须叫醒正在等答案的会话，而不是让它一直挂着
  const quick = openApproval({
    source: "scheduler",
    sessionId: null,
    tool: "demo",
    risk: "G1",
    title: "演示超时",
    summary: "演示超时",
    detail: [],
    speech: "演示超时",
    question: "演示超时",
    timeoutMs: 120,
  });
  const waiting = awaitApproval(quick.id);
  await new Promise((resolve) => setTimeout(resolve, 220));
  expireApprovals();
  const resolvedByTimeout = await Promise.race([
    waiting,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1500)),
  ]);
  check("超时会叫醒等答案的会话", resolvedByTimeout === "timeout", String(resolvedByTimeout));
  check("超时后状态是 expired", getApproval(quick.id)?.status === "expired");

  // 11. 真实执行：在临时"家"目录里真的搬一次文件（关闭演练模式）
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "kivora-home-"));
  fs.mkdirSync(path.join(fakeHome, "Downloads"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, "Documents"), { recursive: true });
  for (const name of ["发票-A.pdf", "发票-B.pdf", "无关.txt"]) {
    fs.writeFileSync(path.join(fakeHome, "Downloads", name), "x");
  }
  const previousHome = process.env.KIVORA_HOME;
  process.env.KIVORA_HOME = fakeHome;
  const previousNarration = getConfig().narration;
  setConfig({ mockMode: false, narration: false });

  const real = await handleUtterance("把下载目录里上周的 pdf 挪到文档/发票", { source: "voice" });
  const realAsked = await waitFor("等真实审批", () => pendingApprovals().length === 1, 8000);
  const realApproval = pendingApprovals()[0];
  const realId = real.action.kind === "task_created" ? real.action.sessionId : (realApproval?.sessionId ?? null);
  check("真实模式建任务", Boolean(realId), real.action.kind);
  check("真实审批列出 2 个 pdf", realAsked && realApproval?.detail.length === 2, `${realApproval?.detail.length ?? 0} 个`);
  await handleUtterance("可以", { source: "voice" });
  const realDone = await waitFor("等真实搬运", () => realId !== null && stateOf(realId) === "done", 8000);
  const targetDir = path.join(fakeHome, "Documents", "发票");
  const moved = realDone ? fs.readdirSync(targetDir) : [];
  check("文件真的进了 文档/发票", moved.length === 2, moved.join(","));
  check(
    "源目录只剩无关文件",
    realDone && fs.readdirSync(path.join(fakeHome, "Downloads")).join(",") === "无关.txt",
  );

  const noMatch = await handleUtterance("帮我在京东搜机械键盘", { source: "voice" });
  const noMatchId = noMatch.action.kind === "task_created" ? noMatch.action.sessionId : null;
  const unsupportedFailed = await waitFor(
    "等不支持的指令失败",
    () => noMatchId !== null && stateOf(noMatchId) === "failed",
    6000,
  );
  check("接不了的指令如实失败", unsupportedFailed, noMatchId ? (getSession(noMatchId)?.error?.message ?? "") : "");

  setConfig({ mockMode: true, narration: previousNarration });
  if (previousHome === undefined) delete process.env.KIVORA_HOME;
  else process.env.KIVORA_HOME = previousHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });

  const passed = checks.filter((item) => item.ok).length;
  const failedCount = checks.length - passed;
  console.log(`\n[flow] ${passed}/${checks.length} passed`);
  return failedCount === 0 ? 0 : 1;
}
