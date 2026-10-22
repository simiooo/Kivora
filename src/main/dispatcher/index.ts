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
import { broadcast, speak } from "../bus.ts";
import { getConfig } from "../repos/config.ts";
import { getBoundModel } from "../repos/models.ts";
import { classify } from "./brain.ts";
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

function launch(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) return;
  setSessionState(sessionId, "starting");
  setSessionError(sessionId, null);
  appendEvent(sessionId, "queued", `开始执行：${session.title}`);
  broadcast("sessions");
  startTask(session, { onFinish: () => pump() }, getConfig().mockMode ? "mock" : "real");
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

async function brainDecision(text: string, context: string): Promise<{ action: string; title?: string; speech?: string } | null> {
  const config = getConfig();
  if (config.mockMode) return null;
  const model = getBoundModel("brain");
  if (!model) return null;
  const key = getSecret(modelSecretName(model.id));
  if (!key && model.provider !== "custom") return null;
  return classify(model, key, text, context);
}

export async function handleUtterance(
  text: string,
  options: { source?: "voice" | "text"; confidence?: number | null } = {},
): Promise<TurnResult> {
  const raw = text.trim();
  const turn = collect();
  if (!raw) {
    return { messages: [], action: { kind: "none" }, spoken: null };
  }

  const user = appendMessage({
    role: "user",
    content: raw,
    source: options.source ?? "text",
    confidence: options.confidence ?? null,
  });
  turn.push(user);

  const context = buildContext();
  let intent = route(raw, context);

  // 反射没命中"建任务"之外的动作时，给 brain 一次机会（4s 超时，失败就按字面做）
  if (intent.kind === "create_task" && context.running) {
    const decision = await brainDecision(raw, describeContext(context));
    if (decision) {
      if (decision.action === "status") intent = { kind: "status", sessionId: context.running.id };
      else if (decision.action === "cancel") intent = { kind: "cancel", sessionId: context.running.id };
      else if (decision.action === "promote") intent = { kind: "promote" };
      else if (decision.action === "queue" || decision.action === "steer") {
        intent = { kind: "queue", sessionId: context.running.id, text: raw };
      }
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
      cancelRun(session.id);
      cancelApprovalsForSession(session.id);
      if (!isRunning(session.id)) {
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
        const fresh = createSession({ title: session.title, prompt: session.prompt, runner: "mock" });
        lastReferenced = fresh.id;
        launch(fresh.id);
        say(turn, `重开了一个：${fresh.title}。`);
        return { messages: turn.messages, action: { kind: "retried", sessionId: fresh.id, mode: "restart" }, spoken: null };
      }
      if (isRunning(session.id)) {
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

    case "queue": {
      const session = getSession(intent.sessionId);
      if (!session) {
        say(turn, "当前会话不在了。");
        return { messages: turn.messages, action: { kind: "none" }, spoken: null };
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
      const session = createSession({ title, prompt: intent.text, runner: "mock" });
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
      if (!getConfig().mockMode) {
        const decision = await brainDecision(intent.text, "没有正在跑的任务");
        if (decision?.speech) scenario.narration = decision.speech;
        if (decision?.title) {
          finalTitle = decision.title;
          renameSession(session.id, finalTitle);
        }
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
  cancelRun(id);
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
  if (isRunning(id)) throw new AppError("conflict", { message: "它还在跑。" });
  if (mode === "restart") {
    const fresh = createSession({ title: session.title, prompt: session.prompt, runner: "mock" });
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
