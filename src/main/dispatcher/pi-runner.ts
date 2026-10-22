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
import { getPiVersion } from "../env.ts";

/**
 * Pi 会话执行器。
 *
 * 用 `pi -p --mode json` 跑一个真实任务会话：事件是 NDJSON（见 pi docs/json.md），
 * 任务文本走 stdin（既避免 Windows 命令行转义地狱，也避免把长文本塞进 argv）。
 *
 * 注意：Pi 的工具有自己的权限模型，审批总线管不到它——所以这是显式开关，
 * 默认关闭，设置里写清楚风险。
 */

export interface PiRunHooks {
  onFinish(sessionId: string): void;
}

interface RunningPi {
  child: ChildProcess;
  cancelled: boolean;
  killTimer: NodeJS.Timeout | null;
}

const runs = new Map<string, RunningPi>();

export function isPiRunning(sessionId: string): boolean {
  return runs.has(sessionId);
}

export function cancelPiRun(sessionId: string): void {
  const run = runs.get(sessionId);
  if (!run) return;
  run.cancelled = true;
  try {
    run.child.kill();
  } catch {
    // 已经退了
  }
  run.killTimer = setTimeout(() => {
    try {
      run.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 3000);
}

export function piRunCount(): number {
  return runs.size;
}

function quoteWin(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** 只允许安全的 model id 直接进命令行 */
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

function piCommand(): string {
  return process.env.KIVORA_PI_BIN || "pi";
}

export function buildTaskPrompt(session: Session): string {
  const lines = [
    "你是 Kivora 派出去的任务会话。用户刚才说：",
    `"""${session.prompt}"""`,
    "",
    "请把这件事做完。要求：",
    "1. 能直接做就直接做，做完再说话。",
    "2. 不要问用户问题（用户不在这个会话里）；不确定就用最保守的做法。",
    "3. 结束时用一句不超过 25 个汉字的中文说结论，例如「挪好了，4 个。」。",
    "4. 不要输出 markdown 代码块，不要解释过程。",
  ];
  return lines.join("\n");
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

export function startPiRun(session: Session, hooks: PiRunHooks): void {
  setSessionState(session.id, "running");
  appendEvent(session.id, "started", `Pi 会话 · ${getPiVersion() ?? "unknown"}`, {});
  patchStatus(session.id, { state: "running", phase: "thinking", turn: 1 });
  broadcast("sessions");

  const sessionDir = path.join(os.homedir(), ".kivora", "pi-sessions");
  fs.mkdirSync(sessionDir, { recursive: true });

  const modelSpec = safeModelSpec();
  const args = ["-p", "--mode", "json", "--session-dir", sessionDir, "--name", session.title.slice(0, 40)];
  if (modelSpec) args.push("--model", modelSpec);

  const command = [piCommand(), ...args].map(quoteWin).join(" ");
  console.log(`[kivora] pi spawn: ${command}`);

  let child: ChildProcess;
  try {
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
      cwd: os.homedir(),
      env: piEnv(),
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    failPi(session.id, "internal", "启动不了 Pi 会话。", err instanceof Error ? err.message : String(err), false);
    hooks.onFinish(session.id);
    return;
  }

  const run: RunningPi = { child, cancelled: false, killTimer: null };
  runs.set(session.id, run);

  let buffer = "";
  let stderr = "";
  let lastText = "";
  let toolCount = 0;
  let turn = 1;
  const artifacts: string[] = [];

  const handleEvent = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      if (trimmed) console.log(`[pi] ${trimmed.slice(0, 200)}`);
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "turn_start") {
      turn += 1;
      appendEvent(session.id, "turn", `第 ${turn} 轮`, { turn });
      patchStatus(session.id, { phase: "thinking", turn });
      broadcast("sessions");
      return;
    }
    if (type === "tool_execution_start") {
      toolCount += 1;
      const toolName = String(event.toolName ?? "tool");
      const summary = summarizeTool(toolName, event.args);
      appendEvent(session.id, "tool_start", summary, { tool: toolName });
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
    if (type === "message_end" || type === "turn_end") {
      const message = event.message ?? (Array.isArray(event.messages) ? event.messages.at(-1) : null);
      const text = messageText(message).trim();
      if (text) lastText = text;
      return;
    }
    if (type === "agent_end") {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const text = messageText(messages[i]).trim();
        if (text) {
          lastText = text;
          break;
        }
      }
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      handleEvent(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  child.on("error", (err) => {
    console.error("[kivora] pi spawn error", err);
    failPi(session.id, "unreachable", "Pi 启动失败。", err.message, false);
    runs.delete(session.id);
    hooks.onFinish(session.id);
  });

  child.on("close", (code) => {
    if (run.killTimer) clearTimeout(run.killTimer);
    runs.delete(session.id);

    if (run.cancelled) {
      appendEvent(session.id, "aborted", "按你说的停了。");
      setSessionState(session.id, "aborted", { summary: "按你说的停了。" });
      appendMessage({ role: "assistant", content: "按你说的停了。", sessionId: session.id });
      broadcast("sessions");
      broadcast("timeline");
      hooks.onFinish(session.id);
      return;
    }

    const detail = stderr.trim().split("\n").slice(-6).join("\n") || null;
    if (code !== 0) {
      const message = /api key|login|auth/i.test(stderr)
        ? "Pi 没有可用的模型凭据（或 Key 被拒）。"
        : `Pi 会话退出（exit ${code ?? "?"}）。`;
      failPi(session.id, "upstream_error", message, detail, false);
      hooks.onFinish(session.id);
      return;
    }

    const summary = lastText || (toolCount > 0 ? "做完了。" : "跑完了，没有输出。");
    appendEvent(session.id, "done", summary, { tools: toolCount });
    setSessionState(session.id, "done", { summary });
    patchStatus(session.id, { phase: "idle", tool: null, summary, artifacts });
    appendMessage({ role: "assistant", content: summary, sessionId: session.id });
    broadcast("sessions");
    broadcast("timeline");
    if (getConfig().narration) void speak(summary);
    hooks.onFinish(session.id);
  });

  // 任务文本走 stdin：避开命令行转义，也支持长文本
  child.stdin?.write(buildTaskPrompt(session));
  child.stdin?.end();
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
