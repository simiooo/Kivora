import type { Session, SessionPhase } from "../../shared/domain.ts";
import { appendEvent, appendMessage, patchStatus, setSessionError, setSessionState } from "../repos/sessions.ts";
import { broadcast, speak } from "../bus.ts";
import { awaitApproval, openApproval } from "./approval-bus.ts";
import { getConfig } from "../repos/config.ts";
import { serializeError } from "../../shared/errors.ts";
import { describeTarget, parseFileTask, scanFiles, transferFiles } from "../tasks/files.ts";

/**
 * 任务执行器（v1）。
 *
 * 真实的 Pi 会话执行在 5.1 / pi-runner.ts 里接；这一版先把"任务生命周期"
 * 完整跑通：状态投影 → 事件流 → 审批 → 完成/失败，UI 全部有东西可看。
 * 所有 mock 步骤都带真实语义，不是假动画：事件类型、状态机、审批结构与真跑一致。
 */

type Step =
  | {
      kind: "event";
      delay: number;
      type: "started" | "turn" | "tool_start" | "tool_end" | "note";
      summary: string;
      status?: Partial<{
        state: Session;
        phase: SessionPhase;
        turn: number;
        tool: string | null;
        lastToolOk: boolean | null;
        artifacts: string[];
      }>;
      tool?: string;
      phase?: SessionPhase;
      turn?: number;
      artifacts?: string[];
      success?: boolean;
    }
  | {
      kind: "approval";
      delay: number;
      tool: string;
      risk: "G1" | "G2" | "G3";
      title: string;
      summary: string;
      detail: string[];
      speech: string;
    }
  | { kind: "finish"; delay: number; state: "done" | "failed" | "aborted"; summary: string }
  | { kind: "fail"; delay: number; code: string; message: string; summary: string; retryable: boolean };

interface Scenario {
  id: string;
  match: RegExp;
  /** 调度器立刻说出口的旁白（先出声） */
  narration: string;
  steps: Step[];
}

const INVOICE_FILES = ["发票-0912.pdf", "发票-0913.pdf", "发票-0914.pdf", "发票-0915.pdf"];

const SCENARIOS: Scenario[] = [
  {
    id: "invoice",
    match: /发票|pdf|文件|移动|挪|整理|归档|目录/i,
    narration: "好，我去整理。",
    steps: [
      { kind: "event", delay: 220, type: "started", summary: "新会话开始，模型 claude-sonnet-4-6", status: {}, turn: 1, phase: "thinking" },
      { kind: "event", delay: 520, type: "tool_start", summary: "读目录 ~/Downloads", tool: "读目录", phase: "acting" },
      {
        kind: "event",
        delay: 640,
        type: "tool_end",
        summary: "找到 4 个 pdf（本月）",
        success: true,
        artifacts: INVOICE_FILES,
        phase: "thinking",
      },
      {
        kind: "approval",
        delay: 260,
        tool: "move_file",
        risk: "G2",
        title: "移动到 文档/发票",
        summary: "要移动 4 个文件，可以吗？",
        detail: INVOICE_FILES,
        speech: "要移动 4 个文件，可以吗？",
      },
      { kind: "event", delay: 360, type: "tool_start", summary: "移动 4 个文件 → 文档/发票", tool: "移动文件", phase: "acting" },
      { kind: "event", delay: 520, type: "tool_end", summary: "4 个文件已就位", success: true, phase: "verifying" },
      { kind: "finish", delay: 260, state: "done", summary: "挪好了，4 个。" },
    ],
  },
  {
    id: "browser",
    match: /搜|买|京东|淘宝|浏览器|网页|查一下|找一下/i,
    narration: "好，我去搜。",
    steps: [
      { kind: "event", delay: 240, type: "started", summary: "新会话开始", turn: 1, phase: "thinking" },
      { kind: "event", delay: 420, type: "tool_start", summary: "启动浏览器", tool: "启动浏览器", phase: "acting", turn: 1 },
      { kind: "event", delay: 900, type: "tool_end", summary: "浏览器就绪", success: true, phase: "thinking" },
      { kind: "event", delay: 300, type: "turn", summary: "第 2 轮 · 打开搜索页", turn: 2, phase: "acting", tool: "打开页面" },
      { kind: "event", delay: 1200, type: "tool_end", summary: "搜索页已加载", success: true, phase: "thinking" },
      {
        kind: "event",
        delay: 400,
        type: "turn",
        summary: "第 3 轮 · 输入关键词并排序",
        turn: 3,
        phase: "acting",
        tool: "输入并排序",
        artifacts: ["搜索结果 32 条"],
      },
      { kind: "event", delay: 2600, type: "tool_end", summary: "按销量排序完成", success: true, phase: "verifying" },
      {
        kind: "finish",
        delay: 400,
        state: "done",
        summary: "按销量前三：Keychron K8、狼蛛 F87、达尔优 A98。要打开哪个？",
      },
    ],
  },
  {
    id: "messages",
    match: /未读|消息|微信|邮件|读一下|念一下/i,
    narration: "我去看看未读。",
    steps: [
      { kind: "event", delay: 220, type: "started", summary: "新会话开始", turn: 1, phase: "thinking" },
      { kind: "event", delay: 420, type: "tool_start", summary: "读取未读消息", tool: "读消息", phase: "acting" },
      { kind: "event", delay: 700, type: "tool_end", summary: "3 条未读", success: true, artifacts: ["张工 · 合同", "财务 · 报销", "群 · 周会"] },
      { kind: "finish", delay: 300, state: "done", summary: "3 条未读：张工问合同、财务催报销、群里改了周会时间。" },
    ],
  },
  {
    id: "fail-demo",
    match: /测试失败|演示失败|fail/i,
    narration: "我试一下。",
    steps: [
      { kind: "event", delay: 200, type: "started", summary: "新会话开始", turn: 1, phase: "thinking" },
      {
        kind: "fail",
        delay: 900,
        code: "unreachable",
        message: "浏览器启动超时 30s，可能是端口被占用。",
        summary: "浏览器启动超时 30s",
        retryable: true,
      },
    ],
  },
];

const GENERIC: Scenario = {
  id: "generic",
  match: /.*/,
  narration: "好，我去做。",
  steps: [
    { kind: "event", delay: 220, type: "started", summary: "新会话开始", turn: 1, phase: "thinking" },
    { kind: "event", delay: 500, type: "tool_start", summary: "拆解任务", tool: "拆解任务", phase: "acting" },
    { kind: "event", delay: 600, type: "tool_end", summary: "拆成 2 步", success: true, phase: "thinking" },
    { kind: "finish", delay: 400, state: "done", summary: "做完了。" },
  ],
};

export function pickScenario(prompt: string): Scenario {
  return SCENARIOS.find((scenario) => scenario.match.test(prompt)) ?? GENERIC;
}

/* ------------------------------------------------------------- 运行时 */

interface RunState {
  cancelled: boolean;
}

const runs = new Map<string, RunState>();

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

export function runningCount(): number {
  return runs.size;
}

export function cancelRun(sessionId: string): void {
  const run = runs.get(sessionId);
  if (run) run.cancelled = true;
}

function sleep(ms: number): Promise<void> {
  const speed = Number(process.env.KIVORA_MOCK_SPEED ?? "1");
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms / (speed || 1)))));
}

export interface RunnerHooks {
  /** 任务结束（完成/失败/取消）后回调，调度器据此启动下一条排队 */
  onFinish(sessionId: string): void;
}

export function startRun(session: Session, hooks: RunnerHooks): void {
  const run: RunState = { cancelled: false };
  runs.set(session.id, run);
  const scenario = pickScenario(session.prompt);
  void execute(session, scenario, run).finally(() => {
    runs.delete(session.id);
    hooks.onFinish(session.id);
  });
}

export type RunMode = "mock" | "real";

/** 演练模式走脚本；关掉演练就走真正能干的那条路（文件整理） */
export function startTask(session: Session, hooks: RunnerHooks, mode: RunMode): void {
  if (mode === "real") startRealRun(session, hooks);
  else startRun(session, hooks);
}

/**
 * 真实执行：解析意图 → 扫描 → 审批 → 搬文件。
 * 不认识的指令不装模作样，直接失败并说清现在能做什么。
 */
function startRealRun(session: Session, hooks: RunnerHooks): void {
  const run: RunState = { cancelled: false };
  runs.set(session.id, run);
  void executeReal(session, run).finally(() => {
    runs.delete(session.id);
    hooks.onFinish(session.id);
  });
}

async function executeReal(session: Session, run: RunState): Promise<void> {
  const config = getConfig();
  setSessionState(session.id, "running");
  broadcast("sessions");
  appendEvent(session.id, "started", "开始 · 内置文件工具", {}, Date.now());
  patchStatus(session.id, { state: "running", phase: "thinking", turn: 1 });

  const task = parseFileTask(session.prompt);
  if (!task) {
    fail(
      session.id,
      "unsupported",
      "这条指令需要浏览器或桌面控制，v1 还没接。",
      "现在能做的是文件整理：说「把下载目录里上周的 pdf 挪到文档/发票」。",
      false,
    );
    return;
  }

  const targetLabel = describeTarget(task.targetDir);
  patchStatus(session.id, { phase: "acting", tool: "读目录" });
  appendEvent(session.id, "tool_start", `读目录 ${task.sourceDir}`, { tool: "read_dir" });
  broadcast("sessions");

  let files;
  try {
    files = scanFiles(task);
  } catch (err) {
    const serialized = serializeError(err);
    fail(session.id, serialized.code, serialized.message, serialized.detail, serialized.retryable);
    return;
  }

  if (run.cancelled) {
    finishAborted(session.id, "按你说的停了。");
    return;
  }

  appendEvent(session.id, "tool_end", `找到 ${files.length} 个 ${task.label}`, { ok: true });
  patchStatus(session.id, {
    phase: "thinking",
    tool: null,
    lastToolOk: true,
    artifacts: files.map((file) => file.name),
  });
  broadcast("sessions");

  if (files.length === 0) {
    finish(session.id, "done", `没找到符合条件的 ${task.label}，一个都没动。`);
    return;
  }

  patchStatus(session.id, { state: "waiting_user", needs: "confirm", phase: "acting", tool: task.action === "move" ? "move_file" : "copy_file" });
  appendEvent(session.id, "approval", `等待确认 · ${task.action === "move" ? "移动到" : "复制到"} ${targetLabel}`, {
    risk: "G2",
  });
  broadcast("sessions");

  const approval = openApproval({
    source: "session",
    sessionId: session.id,
    tool: task.action === "move" ? "move_file" : "copy_file",
    risk: "G2",
    title: `${task.action === "move" ? "移动到" : "复制到"} ${targetLabel}`,
    summary: `要${task.action === "move" ? "移动" : "复制"} ${files.length} 个文件，可以吗？`,
    detail: files.map((file) => file.name),
    speech: `要${task.action === "move" ? "移动" : "复制"} ${files.length} 个文件，可以吗？`,
    question: `要${task.action === "move" ? "移动" : "复制"} ${files.length} 个文件，可以吗？`,
  });

  const resolution = await awaitApproval(approval.id);
  if (run.cancelled || resolution === "cancelled") {
    finishAborted(session.id, "按你说的停了。");
    return;
  }
  if (resolution === "deny" || resolution === "timeout") {
    patchStatus(session.id, { state: "running", needs: null });
    const summary = resolution === "timeout" ? "等太久，我没动。" : "没动，原样留着。";
    appendEvent(session.id, "note", `${resolution === "timeout" ? "超时" : "拒绝"} · 没执行`, { resolution });
    finish(session.id, "aborted", summary);
    if (config.narration) void speak(summary);
    return;
  }

  patchStatus(session.id, { state: "running", needs: null, phase: "acting", tool: task.action === "move" ? "移动文件" : "复制文件" });
  appendEvent(session.id, "tool_start", `${task.action === "move" ? "移动" : "复制"} ${files.length} 个文件 → ${targetLabel}`, {
    tool: task.action,
  });
  broadcast("sessions");

  const result = transferFiles(files, task.targetDir, task.action);
  const artifacts = files.map((file) => file.name);
  patchStatus(session.id, { phase: "verifying", artifacts });
  appendEvent(session.id, "tool_end", `${result.moved.length} 个文件已就位`, {
    ok: result.moved.length > 0,
    skipped: result.skipped.length,
  });
  broadcast("sessions");

  if (result.moved.length === 0) {
    fail(
      session.id,
      "conflict",
      "一个也没挪成。",
      result.skipped.map((item) => `${item.name}：${item.reason}`).join("\n"),
      false,
    );
    return;
  }

  const skippedNote = result.skipped.length ? `，${result.skipped.length} 个跳过了` : "";
  finish(session.id, "done", `挪好了，${result.moved.length} 个${skippedNote}。`);
}

async function execute(session: Session, scenario: Scenario, run: RunState): Promise<void> {
  const config = getConfig();
  setSessionState(session.id, "running");
  broadcast("sessions");

  let turn = 0;
  let lastArtifacts: string[] = [];

  for (const step of scenario.steps) {
    await sleep(step.delay);
    if (run.cancelled) {
      finishAborted(session.id, "按你说的停了。");
      return;
    }

    if (step.kind === "event") {
      if (step.turn) turn = step.turn;
      if (step.type === "started") {
        appendEvent(session.id, "started", step.summary);
      } else if (step.type === "turn") {
        appendEvent(session.id, "turn", step.summary, { turn });
      } else if (step.type === "tool_start") {
        appendEvent(session.id, "tool_start", step.summary, { tool: step.tool });
      } else if (step.type === "tool_end") {
        appendEvent(session.id, "tool_end", step.summary, { ok: step.success });
      } else {
        appendEvent(session.id, "note", step.summary);
      }
      if (step.artifacts) lastArtifacts = [...lastArtifacts, ...step.artifacts];
      patchStatus(session.id, {
        turn: step.turn ?? turn,
        phase: step.phase,
        tool: step.tool ?? null,
        lastToolOk: step.type === "tool_end" ? Boolean(step.success) : undefined,
        artifacts: lastArtifacts.length ? lastArtifacts : undefined,
        state: "running",
      });
      broadcast("sessions");
      continue;
    }

    if (step.kind === "approval") {
      patchStatus(session.id, { state: "waiting_user", needs: "confirm", phase: "acting", tool: step.tool });
      appendEvent(session.id, "approval", `等待确认 · ${step.title}`, { tool: step.tool, risk: step.risk });
      broadcast("sessions");
      const approval = openApproval({
        source: "session",
        sessionId: session.id,
        tool: step.tool,
        risk: step.risk,
        title: step.title,
        summary: step.summary,
        detail: step.detail,
        speech: step.speech,
        question: step.summary,
      });
      const resolution = await awaitApproval(approval.id);
      if (run.cancelled || resolution === "cancelled") {
        finishAborted(session.id, "按你说的停了。");
        return;
      }
      patchStatus(session.id, { state: "running", needs: null, phase: "acting" });
      broadcast("sessions");
      if (resolution === "deny" || resolution === "timeout") {
        const summary = resolution === "timeout" ? "等太久，我先不动了。" : "没动，原样留着。";
        appendEvent(session.id, "note", `拒绝 · ${step.title}`, { resolution });
        finish(session.id, "aborted", summary);
        if (resolution === "deny" && config.narration) void speak(summary);
        return;
      }
      appendEvent(session.id, "note", `已允许 · ${step.title}`, { resolution });
      continue;
    }

    if (step.kind === "fail") {
      setSessionError(session.id, {
        code: step.code,
        message: step.message,
        detail: "mock 故障注入",
        retryable: step.retryable,
        at: Date.now(),
      });
      appendEvent(session.id, "failed", step.summary, { code: step.code });
      finish(session.id, "failed", step.summary);
      return;
    }

    if (step.kind === "finish") {
      appendEvent(session.id, step.state, step.summary);
      finish(session.id, step.state, step.summary);
      return;
    }
  }

  // 没有显式 finish 的场景，按成功收尾
  finish(session.id, "done", scenario.narration);
}

function finish(sessionId: string, state: "done" | "failed" | "aborted", summary: string): void {
  setSessionState(sessionId, state, { summary });
  patchStatus(sessionId, { phase: "idle", tool: null, summary, needs: null });
  if (state === "done") {
    appendMessage({ role: "assistant", content: summary, sessionId });
    broadcast("timeline");
    const config = getConfig();
    if (config.narration) void speak(summary);
  }
  broadcast("sessions");
  broadcast("timeline");
}

/** 失败也要给出下一步：错误码 + 人话 + 可重试与否 */
function fail(sessionId: string, code: string, message: string, detail: string | null, retryable: boolean): void {
  const error = { code, message, detail, retryable, at: Date.now() };
  setSessionError(sessionId, error);
  appendEvent(sessionId, "failed", message, { code, retryable });
  appendMessage({ role: "assistant", content: message, sessionId, error });
  patchStatus(sessionId, { phase: "idle", tool: null, needs: null });
  finish(sessionId, "failed", message);
}

function finishAborted(sessionId: string, summary: string): void {
  appendEvent(sessionId, "aborted", summary);
  setSessionState(sessionId, "aborted", { summary });
  patchStatus(sessionId, { phase: "idle", tool: null, summary });
  appendMessage({ role: "assistant", content: summary, sessionId });
  broadcast("sessions");
  broadcast("timeline");
}
