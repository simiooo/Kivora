import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "../../shared/domain.ts";
import { appendEvent, appendMessage, patchStatus, setSessionError, setSessionState } from "../repos/sessions.ts";
import { broadcast, speak } from "../bus.ts";
import { getConfig } from "../repos/config.ts";
import { getBoundModel } from "../repos/models.ts";
import { getSecret, modelSecretName } from "../secrets.ts";
import { permissionExtensionPath } from "../paths.ts";
import { getPiVersion, piCliPath, piUsesShell } from "../env.ts";
import { managedServerCount, mcpCapability } from "../mcp.ts";
import { awaitApproval, cancelApprovalsForSession, openApproval } from "./approval-bus.ts";

/**
 * Pi 任务执行器（RPC 模式）。
 *
 * 为什么用 RPC 而不是 `-p --mode json`：RPC 能双向通信——
 * - pi 里的扩展问「这条命令能跑吗」→ 我们弹审批卡 → 把回答写回去（权限控制）
 * - 运行中插话/排队 → steer / follow_up
 * - 手动压缩上下文 → compact
 *
 * 协议：stdin 一行一个命令，stdout 一行一个事件（严格 LF 分帧，不用 readline）。
 */

export interface PiRunHooks {
  onFinish(sessionId: string): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PiRun {
  child: ChildProcess;
  sessionId: string;
  cancelled: boolean;
  settled: boolean;
  killTimer: NodeJS.Timeout | null;
  buffer: string;
  stderr: string;
  lastText: string;
  turn: number;
  toolCount: number;
  queueCount: number;
  pending: Map<string, PendingRequest>;
  seq: number;
  idleTimer: NodeJS.Timeout | null;
}

const runs = new Map<string, PiRun>();

export function isPiRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

export function piRunCount(): number {
  return runs.size;
}

function quoteWin(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function safeModelSpec(): string | null {
  const model = getBoundModel("task");
  if (!model) return null;
  if (model.provider !== "openai" && model.provider !== "anthropic") return null;
  if (!/^[A-Za-z0-9._:/-]+$/.test(model.modelId)) return null;
  return `${model.provider}/${model.modelId}`;
}

function piEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  const model = getBoundModel("task");
  if (model) {
    const key = getSecret(modelSecretName(model.id));
    if (key) {
      if (model.provider === "anthropic") env.ANTHROPIC_API_KEY = key;
      else env.OPENAI_API_KEY = key;
    }
  }
  return env;
}

export function buildTaskPrompt(session: Session): string {
  return [
    "你是 Kivora 派出去的任务会话。用户刚才说：",
    `"""${session.prompt}"""`,
    "",
    "请把这件事做完。要求：",
    "1. 能直接做就直接做，做完再说话。",
    "2. 不要问用户问题（用户不在这个会话里）；不确定就用最保守的做法。",
    "3. 结束时用一句不超过 25 个汉字的中文说结论，例如「挪好了，4 个。」。",
    "4. 不要输出 markdown 代码块，不要解释过程。",
  ].join("\n");
}

function summarizeTool(toolName: string, args: unknown): string {
  const LABELS: Record<string, string> = {
    bash: "执行命令",
    read: "读文件",
    read_file: "读文件",
    write: "写文件",
    edit: "改文件",
    list: "列目录",
    ls: "列目录",
    grep: "搜内容",
    glob: "找文件",
  };
  const label = LABELS[toolName] ?? toolName;
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hint =
    (typeof record.command === "string" && record.command) ||
    (typeof record.path === "string" && record.path) ||
    (typeof record.file_path === "string" && record.file_path) ||
    (typeof record.pattern === "string" && record.pattern) ||
    "";
  const clean = hint.replace(/\s+/g, " ").trim();
  return clean ? `${label} · ${clean.slice(0, 48)}` : label;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/* ------------------------------------------------------------- 通信 */

function writeLine(run: PiRun, payload: Record<string, unknown>): void {
  try {
    run.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.warn("[kivora] pi stdin write failed", err);
  }
}

export function steerPiRun(sessionId: string, text: string): boolean {
  const run = runs.get(sessionId);
  if (!run || run.settled) return false;
  writeLine(run, { type: "steer", message: text });
  appendEvent(sessionId, "note", `插话：${text}`, { via: "pi.steer" });
  return true;
}

export function followUpPiRun(sessionId: string, text: string): boolean {
  const run = runs.get(sessionId);
  if (!run || run.settled) return false;
  writeLine(run, { type: "follow_up", message: text });
  appendEvent(sessionId, "note", `排队：${text}`, { via: "pi.follow_up" });
  return true;
}

function request(run: PiRun, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  const id = `kivora-${++run.seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      run.pending.delete(id);
      reject(new Error("pi 没有在超时内回应"));
    }, timeoutMs);
    run.pending.set(id, { resolve, reject, timer });
    writeLine(run, { ...payload, id });
  });
}

/** 手动压缩：返回前后 token 估算 */
export async function compactPiSession(sessionId: string): Promise<{ before: number; after: number } | null> {
  const run = runs.get(sessionId);
  if (!run || run.settled) return null;
  const data = (await request(run, { type: "compact" }, 180_000)) as
    | { tokensBefore?: number; estimatedTokensAfter?: number }
    | undefined;
  const before = Number(data?.tokensBefore ?? 0);
  const after = Number(data?.estimatedTokensAfter ?? 0);
  appendEvent(sessionId, "note", `压缩上下文：${before} → ${after} tokens`, { before, after });
  return { before, after };
}

/* ------------------------------------------------------------- 审批 */

const RISK_WORDS = /删除|格式化|安装|卸载|支付|转账|密码|凭据|注册表|delete|format|install|uninstall|payment|registry/i;

async function handleUiRequest(run: PiRun, event: Record<string, unknown>): Promise<void> {
  const id = String(event.id ?? "");
  const method = String(event.method ?? "");
  if (!id) return;

  if (method !== "confirm") {
    // select / input / editor：v1 不接，直接取消（扩展会当作"没同意"）
    writeLine(run, { type: "extension_ui_response", id, cancelled: true });
    return;
  }

  const title = String(event.title ?? "任务会话想执行一个操作");
  const message = String(event.message ?? "");
  const risk = RISK_WORDS.test(`${title} ${message}`) ? "G3" : "G2";

  appendEvent(run.sessionId, "approval", `Pi 请求确认 · ${title.slice(0, 40)}`, { risk });
  const approval = openApproval({
    source: "session",
    sessionId: run.sessionId,
    tool: "pi.tool_call",
    risk,
    title: title.slice(0, 80),
    summary: message.slice(0, 240),
    detail: message ? [message.slice(0, 300)] : [],
    speech: risk === "G3" ? "任务会话要做一件危险的事，需要你点一下。" : "任务会话要执行一个操作，可以吗？",
    question: message.slice(0, 240) || title.slice(0, 80),
  });

  const resolution = await awaitApproval(approval.id);
  const confirmed = resolution === "allow_once" || resolution === "allow_scope";
  writeLine(run, { type: "extension_ui_response", id, confirmed });
  appendEvent(run.sessionId, "approval_resolved", `${confirmed ? "允许" : "拒绝"} · ${title.slice(0, 40)}`, {
    resolution,
  });
}

/* ------------------------------------------------------------- 生命周期 */

export function startPiRun(session: Session, hooks: PiRunHooks): void {
  setSessionState(session.id, "running");
  appendEvent(session.id, "started", `Pi RPC 会话 · ${getPiVersion() ?? "unknown"}`, {});

  const mcpCount = managedServerCount();
  if (mcpCount > 0) {
    const capability = mcpCapability();
    appendEvent(
      session.id,
      "note",
      capability.available
        ? `已加载 ${mcpCount} 个 MCP 服务器`
        : `配了 ${mcpCount} 个 MCP 服务器，但这个 pi 版本还不支持（更新到 1.4.0+）`,
      { mcp: mcpCount, available: capability.available },
    );
  }
  patchStatus(session.id, { state: "running", phase: "thinking", turn: 1 });
  broadcast("sessions");

  const sessionDir = path.join(os.homedir(), ".kivora", "pi-sessions");
  fs.mkdirSync(sessionDir, { recursive: true });

  const modelSpec = safeModelSpec();
  const args = ["--mode", "rpc", "--session-dir", sessionDir, "--name", session.title.slice(0, 40)];
  if (modelSpec) args.push("--model", modelSpec);
  const extension = permissionExtensionPath();
  if (fs.existsSync(extension)) args.push("--extension", extension);

  const cli = piCliPath();
  if (!cli) {
    failPi(session.id, "no_model", "找不到内置的 pi。", "打包时没有带上 @earendil-works/pi-coding-agent。", false);
    hooks.onFinish(session.id);
    return;
  }

  let child: ChildProcess;
  try {
    if (piUsesShell()) {
      // 测试/特殊环境：KIVORA_PI_BIN 指向 .cmd，需要 shell
      const command = [cli, ...args].map(quoteWin).join(" ");
      console.log(`[kivora] pi rpc (override): ${command}`);
      child = spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
        cwd: os.homedir(),
        env: piEnv(),
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      // 正常路径：用应用自带的 Electron 当 Node 跑内置 pi，
      // 不依赖用户机器上的 node 或全局 pi
      console.log(`[kivora] pi rpc (bundled): ${cli}`);
      child = spawn(process.execPath, [cli, ...args], {
        cwd: os.homedir(),
        env: { ...piEnv(), ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch (err) {
    failPi(session.id, "internal", "启动不了 Pi 会话。", err instanceof Error ? err.message : String(err), false);
    hooks.onFinish(session.id);
    return;
  }

  const run: PiRun = {
    child,
    sessionId: session.id,
    cancelled: false,
    settled: false,
    killTimer: null,
    buffer: "",
    stderr: "",
    lastText: "",
    turn: 1,
    toolCount: 0,
    queueCount: 0,
    pending: new Map(),
    seq: 0,
    idleTimer: null,
  };
  runs.set(session.id, run);

  const resetIdle = (): void => {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => {
      appendEvent(session.id, "note", "15 分钟没有动静，先停了。");
      cancelPiRun(session.id);
    }, 15 * 60_000);
  };
  resetIdle();

  const finish = (state: "done" | "failed" | "aborted", summary: string, detail?: string | null): void => {
    if (run.settled) return;
    run.settled = true;
    if (run.idleTimer) clearTimeout(run.idleTimer);
    if (run.killTimer) clearTimeout(run.killTimer);
    for (const item of run.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("会话已结束"));
    }
    run.pending.clear();
    cancelApprovalsForSession(session.id);
    runs.delete(session.id);

    if (state === "failed") {
      failPi(session.id, "upstream_error", summary, detail ?? null, false);
    } else {
      appendEvent(session.id, state, summary, { tools: run.toolCount });
      setSessionState(session.id, state, { summary });
      patchStatus(session.id, { phase: "idle", tool: null, summary, needs: null });
      appendMessage({ role: "assistant", content: summary, sessionId: session.id });
      if (state === "done" && getConfig().narration) void speak(summary);
      broadcast("sessions");
      broadcast("timeline");
    }
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    child.kill();
    hooks.onFinish(session.id);
  };

  const handleEvent = (raw: string): void => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type ?? "");
    resetIdle();

    if (type === "response") {
      const id = String(event.id ?? "");
      const waiter = run.pending.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        run.pending.delete(id);
        if (event.success === false) waiter.reject(new Error(String(event.error ?? "pi 命令失败")));
        else waiter.resolve(event.data);
      }
      return;
    }

    if (type === "turn_start") {
      run.turn += 1;
      appendEvent(session.id, "turn", `第 ${run.turn} 轮`, { turn: run.turn });
      patchStatus(session.id, { phase: "thinking", turn: run.turn });
      broadcast("sessions");
      return;
    }

    if (type === "tool_execution_start") {
      run.toolCount += 1;
      const toolName = String(event.toolName ?? "tool");
      appendEvent(session.id, "tool_start", summarizeTool(toolName, event.args), { tool: toolName });
      patchStatus(session.id, { phase: "acting", tool: summarizeTool(toolName, {}), lastToolOk: null });
      broadcast("sessions");
      return;
    }

    if (type === "tool_execution_end") {
      const toolName = String(event.toolName ?? "tool");
      const ok = event.isError !== true;
      appendEvent(session.id, "tool_end", `${summarizeTool(toolName, {})}${ok ? "完成" : "失败"}`, { ok });
      patchStatus(session.id, { phase: "thinking", lastToolOk: ok });
      broadcast("sessions");
      return;
    }

    if (type === "message_end") {
      const message = event.message as { role?: string } | undefined;
      const text = messageText(message).trim();
      if (text && message?.role === "assistant") run.lastText = text;
      return;
    }

    if (type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const followUps = Array.isArray(event.followUp) ? event.followUp.length : 0;
      const total = steering + followUps;
      if (total !== run.queueCount) {
        run.queueCount = total;
        appendEvent(session.id, "note", total ? `Pi 队列里还有 ${total} 条` : "Pi 队列已清空", { total });
      }
      return;
    }

    if (type === "compaction_start") {
      appendEvent(session.id, "note", "正在压缩上下文…");
      patchStatus(session.id, { phase: "verifying" });
      return;
    }

    if (type === "compaction_end") {
      const before = Number(event.tokensBefore ?? 0);
      const after = Number(event.estimatedTokensAfter ?? 0);
      appendEvent(session.id, "note", before ? `上下文压缩：${before} → ${after} tokens` : "上下文压缩完成");
      patchStatus(session.id, { phase: "thinking" });
      return;
    }

    if (type === "auto_retry_start" || type === "auto_retry_end") {
      appendEvent(session.id, "note", type === "auto_retry_start" ? "模型请求失败，pi 正在重试" : "重试结束");
      return;
    }

    if (type === "extension_error") {
      appendEvent(session.id, "note", `扩展报错：${String(event.message ?? "").slice(0, 80)}`);
      return;
    }

    if (type === "extension_ui_request") {
      void handleUiRequest(run, event).catch((err) => {
        console.warn("[kivora] pi ui request failed", err);
      });
      return;
    }

    if (type === "agent_end" || type === "agent_settled") {
      if (type === "agent_end") {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const text = messageText(messages[i]).trim();
          if (text) {
            run.lastText = text;
            break;
          }
        }
        return;
      }
      const summary = run.lastText || (run.toolCount > 0 ? "做完了。" : "跑完了，没有输出。");
      finish(run.cancelled ? "aborted" : "done", summary);
      return;
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    run.buffer += chunk.toString("utf8");
    let index = run.buffer.indexOf("\n");
    while (index >= 0) {
      const line = run.buffer.slice(0, index).replace(/\r$/, "");
      run.buffer = run.buffer.slice(index + 1);
      if (line.trim()) handleEvent(line);
      index = run.buffer.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    run.stderr += chunk.toString("utf8");
    if (run.stderr.length > 8000) run.stderr = run.stderr.slice(-8000);
  });

  child.on("error", (err) => {
    console.error("[kivora] pi rpc spawn error", err);
    finish("failed", "Pi 启动失败。", err.message);
  });

  child.on("close", (code) => {
    if (run.settled) return;
    if (run.cancelled) {
      finish("aborted", "按你说的停了。");
      return;
    }
    const detail = run.stderr.trim().split("\n").slice(-6).join("\n") || null;
    const message = /api key|login|auth/i.test(run.stderr)
      ? "Pi 没有可用的模型凭据（或 Key 被拒）。"
      : `Pi 会话退出（exit ${code ?? "?"}）。`;
    finish("failed", message, detail);
  });

  // 发任务：RPC 模式的任务文本走 prompt 命令，不走 argv
  void request(run, { type: "prompt", message: buildTaskPrompt(session) }, 60_000).catch((err: Error) => {
    finish("failed", "Pi 没接下这个任务。", err.message);
  });
}

export function cancelPiRun(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run) return;
  run.cancelled = true;
  writeLine(run, { type: "abort" });
  run.killTimer = setTimeout(() => {
    try {
      run.child.kill();
    } catch {
      // ignore
    }
  }, 3000);
}

function failPi(sessionId: string, code: string, message: string, detail: string | null, retryable: boolean): void {
  const error = { code, message, detail, retryable, at: Date.now() };
  setSessionError(sessionId, error);
  appendEvent(sessionId, "failed", message, { code });
  appendMessage({ role: "assistant", content: message, sessionId, error });
  patchStatus(sessionId, { phase: "idle", tool: null, needs: null });
  setSessionState(sessionId, "failed", { summary: message });
  broadcast("sessions");
  broadcast("timeline");
}
