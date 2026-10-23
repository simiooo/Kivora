import type { Message, Session, TurnResult } from "../../shared/domain.ts";
import { isActive, newId } from "../../shared/domain.ts";
import {
  appendEvent,
  appendMessage,
  attachMessageToSession,
  createSession,
  findLastSession,
  findRunningSession,
  getSession,
  listActiveSessions,
  renameSession,
  setSessionError,
  setSessionState,
} from "../repos/sessions.ts";
import { enqueue, promoteQueued, takeNextQueued, listQueue } from "../repos/queue.ts";
import { currentApproval, answerById, cancelApprovalsForSession } from "./approval-bus.ts";
import { route, renderStatus, type RouterContext } from "./router.ts";
import { cancelRun, isRunning, pickScenario, startTask } from "./runner.ts";
import { cancelPiRun, isPiRunning, steerPiRun } from "./pi-runner.ts";
import { mockMode, piAvailable } from "../env.ts";
import { beginTurn, isCurrentTurn, setThinking } from "../turn-state.ts";
import { acknowledgmentFor, isQuestion, looksActionable, stripWakeName } from "./ack.ts";
import { setConfig } from "../repos/config.ts";
import { broadcast, speak } from "../bus.ts";
import { getConfig } from "../repos/config.ts";
import { getBoundModel, updateModel } from "../repos/models.ts";
import { classify, type BrainDecision } from "./brain.ts";
import { getSecret, modelSecretName } from "../secrets.ts";
import { AppError } from "../../shared/errors.ts";
import { tailEllipsis } from "../../shared/text.ts";

/**
 * 调度器：一句话进来 → 反射路由（零模型）→ 必要时问 brain → 落到会话/队列/审批。
 * 语音层只做调度，真正的活是独立会话干的（6.1）。
 */

let lastReferenced: string | null = null;
let pumping = false;

function maxArtifacts(session: Session): string[] {
  return session.status.artifacts;
}

function buildContext(): RouterContext {
  const approval = currentApproval();
  const running = findRunningSession();
  const failed = findLastSession("failed");
  const paused = findLastSession("paused");
  const now = Date.now();
  const recentFailed = failed && now - failed.updatedAt < 15 * 60_000 ? failed : null;
  const recentPaused = paused && now - paused.updatedAt < 15 * 60_000 ? paused : null;
  return {
    pendingApproval: approval ? { id: approval.id, risk: approval.risk } : null,
    running: running
      ? { id: running.id, state: running.state, title: running.title, phase: running.status.phase }
      : null,
    lastFailed: recentFailed ? { id: recentFailed.id } : null,
    lastPaused: recentPaused ? { id: recentPaused.id } : null,
    lastReferenced: lastReferenced ? { id: lastReferenced } : null,
    queueCount: listQueue().length,
  };
}

export function makeTitle(text: string): string {
  const cleaned = text
    .replace(/^(帮我|请帮我|麻烦|请|你能不能|能不能|可以帮我|给我)/, "")
    .replace(/[，。！？、,.!?~～…]+$/g, "")
    .trim();
  return tailEllipsis(cleaned || text.trim(), 18);
}

function collect(): { push: (message: Message) => void; messages: Message[] } {
  const messages: Message[] = [];
  return { messages, push: (message) => messages.push(message) };
}

function say(turn: ReturnType<typeof collect>, content: string, opts: { speak?: boolean; sessionId?: string | null } = {}): Message {
  const message = appendMessage({ role: "assistant", content, sessionId: opts.sessionId ?? null });
  turn.push(message);
  const config = getConfig();
  if (opts.speak !== false && config.narration) void speak(content);
  return message;
}

function cancelAnyRun(id: string): void {
  cancelRun(id);
  cancelPiRun(id);
}

function taskIsRunning(id: string): boolean {
  return isRunning(id) || isPiRunning(id);
}

function currentMode(): "mock" | "real" | "pi" {
  const config = getConfig();
  if (mockMode()) return "mock";
  return config.taskRuntime === "pi" && piAvailable() ? "pi" : "real";
}

function launch(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) return;
  setSessionState(sessionId, "starting");
  setSessionError(sessionId, null);
  appendEvent(sessionId, "queued", `开始执行：${session.title}`);
  broadcast("sessions");
  startTask(session, { onFinish: () => pump() }, currentMode());
}

/** 有排队且没有在跑的，就启动下一条 */
export function pump(): void {
  if (pumping) return;
  pumping = true;
  try {
    const running = findRunningSession();
    if (running && (running.state === "running" || running.state === "starting" || running.state === "waiting_user")) {
      return;
    }
    for (;;) {
      const next = takeNextQueued();
      if (!next) return;
      const session = getSession(next.sessionId);
      if (!session) continue;
      if (next.kind === "steer") {
        if (session.state === "running" || session.state === "waiting_user") {
          appendEvent(session.id, "note", `插话：${next.text}`, { kind: "steer" });
          void speak("收到。");
          broadcast("sessions");
          continue;
        }
      }
      setSessionState(session.id, "queued");
      launch(session.id);
      return;
    }
  } finally {
    pumping = false;
  }
}

async function brainDecision(text: string, context: string, signal?: AbortSignal): Promise<BrainDecision | null> {
  if (mockMode()) return null;
  const model = getBoundModel("brain");
  if (!model) return null;
  const key = getSecret(modelSecretName(model.id));
  if (!key && model.provider !== "custom") return null;
  return classify(model, key, text, context, signal);
}

export async function handleUtterance(
  text: string,
  options: { source?: "voice" | "text"; confidence?: number | null } = {},
): Promise<TurnResult> {
  // 叫了名字也不影响指令本身（还没有唤醒词门，先去称呼）
  const raw = stripWakeName(text.trim());
  const turn = collect();
  if (!raw) {
    return { messages: [], action: { kind: "none" }, spoken: null };
  }

  const ticket = beginTurn();
  // 只听不记：原话不落库，只留一句占位，动作和结果照常记录
  const privateMode = getConfig().privateMode;
  const user = appendMessage({
    role: "user",
    content: privateMode ? "（只说了一句，没记下来）" : raw,
    source: options.source ?? "text",
    confidence: options.confidence ?? null,
  });
  turn.push(user);

  /**
   * 先出声（方案 3.9）：把话交给模型判断时进入"在想"，并在 400ms 还没结果时
   * 播一句缓存的接话。400ms 内就拿到结论的，不播 ack——直接说真正的旁白，
   * 免得一句话被 ack + 结论拆成两段。
   */
  const ACK_AFTER_MS = 400;
  let acked = false;
  const think = async <T,>(work: () => Promise<T>): Promise<T> => {
    const config = getConfig();
    let ackTimer: NodeJS.Timeout | null = null;
    if (!acked && config.narration && config.ackEnabled) {
      acked = true;
      ackTimer = setTimeout(() => void speak(acknowledgmentFor(raw)), ACK_AFTER_MS);
    }
    setThinking(true);
    try {
      return await work();
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
      setThinking(false);
    }
  };

  const context = buildContext();
  let intent = route(raw, context);
  let decision: BrainDecision | null = null;

  // 反射只想"建任务"时，先问一次调度模型：它可能只是问个问题，不该开任务
  if (intent.kind === "create_task") {
    decision = await think(() => brainDecision(raw, describeContext(context), ticket.signal));
    if (!isCurrentTurn(ticket.seq)) {
      return { messages: turn.messages, action: { kind: "none" }, spoken: null };
    }

    // 只是问一件事：直接答，不建会话（否则会掉进"这条指令需要浏览器"）
    if (decision?.action === "answer") {
      const text = decision.speech?.trim() || decision.question?.trim() || "这个我暂时答不上来。";
      say(turn, text);
      return { messages: turn.messages, action: { kind: "none" }, spoken: text };
    }

    if (decision && context.running) {
      if (decision.action === "status") intent = { kind: "status", sessionId: context.running.id };
      else if (decision.action === "cancel") intent = { kind: "cancel", sessionId: context.running.id };
      else if (decision.action === "promote") intent = { kind: "promote" };
      else if (decision.action === "queue" || decision.action === "steer") {
        intent = { kind: "queue", sessionId: context.running.id, text: raw };
      }
    }

    // 没有可用的调度模型，但这句明显是个问题：别装模作样开任务
    if (!decision && isQuestion(raw) && !looksActionable(raw)) {
      const text = "这个问题得靠模型来答，现在还没连上可用的调度模型——去设置 → 模型里配一个。";
      say(turn, text);
      return { messages: turn.messages, action: { kind: "none" }, spoken: text };
    }
  }

  switch (intent.kind) {
    case "approve": {
      const approval = currentApproval();
      if (!approval) {
        say(turn, "现在没有要确认的事。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      const resolved = answerById(approval.id, intent.resolution);
      const label =
        intent.resolution === "allow_once" ? "允许一次" : intent.resolution === "allow_scope" ? "以后都允许" : "拒绝";
      appendEvent(resolved.sessionId, "answered", `语音回答：${label}`, { resolution: intent.resolution });
      broadcast("sessions");
      broadcast("timeline");
      return { messages: turn.messages, action: { kind: "answer", approvalId: approval.id, resolution: intent.resolution }, spoken: null };
    }

    case "cancel": {
      const session = getSession(intent.sessionId);
      if (!session) {
        say(turn, "这个任务已经不在了。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      cancelAnyRun(session.id);
      cancelApprovalsForSession(session.id);
      if (!taskIsRunning(session.id)) {
        setSessionState(session.id, "aborted", { summary: "按你说的停了。" });
        appendEvent(session.id, "aborted", "按你说的停了。");
        say(turn, "好，停了。");
        broadcast("sessions");
      }
      return { messages: turn.messages, action: { kind: "cancelled", sessionId: session.id }, spoken: null };
    }

    case "retry": {
      const session = getSession(intent.sessionId);
      if (!session) {
        say(turn, "没找到要重试的任务。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      if (intent.mode === "restart") {
        const fresh = createSession({ title: session.title, prompt: session.prompt, runner: currentMode() === "pi" ? "pi" : "mock" });
        lastReferenced = fresh.id;
        launch(fresh.id);
        say(turn, `重开了一个：${fresh.title}。`);
        return { messages: turn.messages, action: { kind: "retried", sessionId: fresh.id, mode: "restart" }, spoken: null };
      }
      if (taskIsRunning(session.id)) {
        say(turn, "它还在跑，先等它结束。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      setSessionError(session.id, null);
      appendEvent(session.id, "note", "重试（保留上下文）");
      if (findRunningSession()) {
        enqueue(session.id, session.prompt, "queue");
        setSessionState(session.id, "queued");
        say(turn, "排上了，前面那个跑完就重试。");
        return { messages: turn.messages, action: { kind: "queued", sessionId: session.id, position: 1 }, spoken: null };
      }
      setSessionState(session.id, "queued");
      launch(session.id);
      say(turn, "好，再试一次。");
      return { messages: turn.messages, action: { kind: "retried", sessionId: session.id, mode: "continue" }, spoken: null };
    }

    case "resume": {
      const session = getSession(intent.sessionId);
      if (!session) {
        say(turn, "没找到要接着做的任务。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      if (findRunningSession()) {
        enqueue(session.id, "继续", "queue");
        setSessionState(session.id, "queued");
        say(turn, "排上了，一会儿接着做。");
        return { messages: turn.messages, action: { kind: "queued", sessionId: session.id, position: 1 }, spoken: null };
      }
      setSessionState(session.id, "queued");
      launch(session.id);
      say(turn, "接着做。");
      return { messages: turn.messages, action: { kind: "retried", sessionId: session.id, mode: "continue" }, spoken: null };
    }

    case "status": {
      const session = intent.sessionId ? getSession(intent.sessionId) : findRunningSession();
      if (!session) {
        const active = listActiveSessions();
        const content = active.length
          ? `现在有 ${active.length} 个任务在跑：${active.map((s) => s.title).join("、")}。`
          : "现在没有在跑的任务。";
        say(turn, content);
        return { messages: turn.messages, action: { kind: "status", sessionId: null }, spoken: content };
      }
      lastReferenced = session.id;
      const content = renderStatus({
        title: session.title,
        state: session.state,
        phase: session.status.phase,
        turn: session.status.turn,
        tool: session.status.tool,
        elapsedMs: session.status.elapsedMs,
        needs: session.status.needs,
        summary: session.status.summary,
        artifacts: maxArtifacts(session),
      });
      say(turn, content, { sessionId: session.id });
      return { messages: turn.messages, action: { kind: "status", sessionId: session.id }, spoken: content };
    }

    case "promote": {
      const queue = listQueue();
      if (queue.length === 0) {
        say(turn, "队列是空的。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      const target = queue[queue.length - 1];
      promoteQueued(target.id);
      const session = getSession(target.sessionId);
      lastReferenced = target.sessionId;
      say(turn, `把「${session?.title ?? target.text}」提到最前面了。`);
      return {
        messages: turn.messages,
        action: { kind: "promoted", sessionId: target.sessionId, position: 1 },
        spoken: null,
      };
    }

    case "config": {
      // 语音改配置（方案 3.11）：只做不需要审批的那几项
      if (intent.asrLanguage) {
        setConfig({ asrLanguage: intent.asrLanguage });
        const label = intent.asrLanguage === "en" ? "英文" : intent.asrLanguage === "zh" ? "中文" : "自动";
        const text = `好，识别语言切成${label}。`;
        say(turn, text);
        return { messages: turn.messages, action: { kind: "none" }, spoken: text };
      }
      if (typeof intent.speedDelta === "number") {
        const model = getBoundModel("tts");
        if (!model) {
          const text = "还没绑定语音合成模型，改不了语速。";
          say(turn, text);
          return { messages: turn.messages, action: { kind: "none" }, spoken: text };
        }
        const current = model.params.speed ?? 1;
        const next = Math.min(2, Math.max(0.5, Math.round((current + intent.speedDelta) * 10) / 10));
        updateModel({ ...model, params: { ...model.params, speed: next } });
        const text = `好，语速调到 ${next} 倍。`;
        say(turn, text);
        return { messages: turn.messages, action: { kind: "none" }, spoken: text };
      }
      return { messages: turn.messages, action: { kind: "none" }, spoken: null };
    }

    case "queue": {
      const session = getSession(intent.sessionId);
      if (!session) {
        say(turn, "当前会话不在了。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
      }
      if (isPiRunning(session.id) && steerPiRun(session.id, intent.text)) {
        say(turn, "插了一句，它这轮做完就接着说。");
        return { messages: turn.messages, action: { kind: "steered", sessionId: session.id }, spoken: null };
      }
      enqueue(session.id, intent.text, "steer");
      appendEvent(session.id, "note", `插话：${intent.text}`, { kind: "steer" });
      say(turn, "插了一句，它这轮做完就接着说。");
      return { messages: turn.messages, action: { kind: "steered", sessionId: session.id }, spoken: null };
    }

    case "help": {
      const content =
        "我会开独立会话去把事做完。你可以说：把下载目录的 pdf 挪到文档、帮我搜个东西、刚才那个做完了吗、停、重试、先做这个。";
      say(turn, content);
      return { messages: turn.messages, action: { kind: "none" }, spoken: content };
    }

    case "create_task": {
      const running = findRunningSession();
      const title = makeTitle(intent.text);
      const session = createSession({ title, prompt: intent.text, runner: currentMode() === "pi" ? "pi" : "mock" });
      attachMessageToSession(user.id, session.id);
      lastReferenced = session.id;

      if (running) {
        const item = enqueue(session.id, intent.text, "queue");
        setSessionState(session.id, "queued");
        appendEvent(session.id, "queued", `排队中 · 前面是「${running.title}」`);
        if (intent.preempt) promoteQueued(item.id);
        const position = intent.preempt ? 1 : item.position;
        const content = `排上了，第 ${position} 个。前面是「${running.title}」。`;
        say(turn, content, { sessionId: session.id });
        broadcast("queue");
        return { messages: turn.messages, action: { kind: "queued", sessionId: session.id, position }, spoken: content };
      }

      const scenario = pickScenario(intent.text);
      let finalTitle = title;
      // 上面已经问过调度模型了（包括"只是问问题"的情况），这里不再问第二次
      if (decision?.speech) scenario.narration = decision.speech;
      if (decision?.title) {
        finalTitle = decision.title;
        renameSession(session.id, finalTitle);
      }
      say(turn, scenario.narration, { sessionId: session.id });
      launch(session.id);
      return {
        messages: turn.messages,
        action: { kind: "task_created", sessionId: session.id, title: finalTitle, queued: false },
        spoken: scenario.narration,
      };
    }

    case "none":
    default:
      return { messages: turn.messages, action: { kind: "none" }, spoken: null };
  }
}

function describeContext(context: RouterContext): string {
  const parts: string[] = [];
  if (context.running) parts.push(`正在跑：${context.running.title}（${context.running.phase}）`);
  if (context.pendingApproval) parts.push("有一个等待确认的审批");
  if (context.queueCount) parts.push(`队列里有 ${context.queueCount} 条`);
  return parts.join("；") || "空闲";
}

/* ---------------------------------------------- UI 直接操作（点按钮） */

export function cancelTaskById(id: string): void {
  const session = getSession(id);
  if (!session) throw new AppError("not_found", { message: "这个任务已经不在了。" });
  if (!isActive(session.state) && session.state !== "paused") {
    throw new AppError("conflict", { message: "它已经结束了，不用取消。" });
  }
  cancelAnyRun(id);
  cancelApprovalsForSession(id);
  setSessionState(id, "aborted", { summary: "手动停止" });
  appendEvent(id, "aborted", "手动停止");
  appendMessage({ role: "assistant", content: "好，停了。", sessionId: id });
  broadcast("sessions");
  broadcast("timeline");
  pump();
}

export function retryTaskById(id: string, mode: "continue" | "restart"): void {
  const session = getSession(id);
  if (!session) throw new AppError("not_found", { message: "这个任务已经不在了。" });
  if (taskIsRunning(id)) throw new AppError("conflict", { message: "它还在跑。" });
  if (mode === "restart") {
    const fresh = createSession({ title: session.title, prompt: session.prompt, runner: currentMode() === "pi" ? "pi" : "mock" });
    lastReferenced = fresh.id;
    launch(fresh.id);
    return;
  }
  setSessionError(id, null);
  appendEvent(id, "note", "重试（保留上下文）");
  setSessionState(id, "queued");
  if (findRunningSession()) {
    enqueue(id, session.prompt, "queue");
    broadcast("queue");
    return;
  }
  launch(id);
}

export function resumeTaskById(id: string): void {
  const session = getSession(id);
  if (!session) throw new AppError("not_found", { message: "这个任务已经不在了。" });
  setSessionState(id, "queued");
  if (findRunningSession()) {
    enqueue(id, "继续", "queue");
    broadcast("queue");
    return;
  }
  launch(id);
}

export function referenceSession(id: string): void {
  lastReferenced = id;
}

export function newSessionId(): string {
  return newId("s");
}

export { findRunningSession, pump as restartPump };
