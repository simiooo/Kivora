import { BrowserWindow, app, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { IPC, type ModelPreset } from "../shared/ipc.ts";
import type { AppConfig, ApprovalResolution, ModuleKey, OverlayState } from "../shared/domain.ts";
import { AppError, serializeError } from "../shared/errors.ts";
import { appState } from "./state.ts";
import { CONFIG_DEFAULTS, getConfig, setConfig } from "./repos/config.ts";
import {
  handleUtterance,
  cancelTaskById,
  retryTaskById,
  resumeTaskById,
} from "./dispatcher/index.ts";
import { cancelRun } from "./dispatcher/runner.ts";
import { cancelPiRun, compactPiSession } from "./dispatcher/pi-runner.ts";
import {
  deleteSession,
  getSession,
  listActiveSessions,
  listEvents,
  listSessionItems,
  listSessionMessages,
  listTimeline,
  setSessionState,
  appendEvent,
} from "./repos/sessions.ts";
import { clearQueue, listQueue, promoteQueued, removeFromQueue } from "./repos/queue.ts";
import { answerById, cancelApprovalsForSession } from "./dispatcher/approval-bus.ts";
import { listApprovals, listGrants, pendingApprovals, pendingForSession, revokeGrants } from "./repos/approvals.ts";
import {
  bindModel,
  createModel,
  deleteModel,
  getModel,
  listBindings,
  listModels,
  updateModel,
} from "./repos/models.ts";
import { getSecret, modelSecretName } from "./secrets.ts";
import { listServers, mcpCapability, MCP_PRESETS, removeServer, saveServer } from "./mcp.ts";
import { assertProbeable, probeMcpServer } from "./mcp-client.ts";
import { probeModel } from "./providers/probe.ts";
import { AsrStream, isStreamingAsrModel } from "./providers/dashscope-stream.ts";
import { mockMode } from "./env.ts";
import { getBoundModel } from "./repos/models.ts";
import { newId } from "../shared/domain.ts";
import { synthesizeSpeech, transcribeAudio } from "./voice.ts";
import { broadcast, isSpeaking, setSpeaking } from "./bus.ts";
import { interruptTurn, isThinking } from "./turn-state.ts";
import { focusMain, hideOverlay, refreshPermissionWindow, resizeOverlay } from "./windows.ts";
import { findRunningSession } from "./repos/sessions.ts";

const sessionId = z.string().regex(/^s_[0-9a-f]{8}$/, "会话 id 不合法");
const approvalId = z.string().regex(/^ap_[0-9a-f]{8}$/, "审批 id 不合法");
const modelId = z.string().regex(/^m_[0-9a-f]{8}$/, "模型 id 不合法");
const queueId = z.string().regex(/^q_[0-9a-f]{8}$/, "排队 id 不合法");

const resolutionSchema = z.enum(["allow_once", "allow_scope", "deny"]);

const headerPair = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "请求头名字只能有字母、数字、- _ ."),
  value: z.string().max(600),
});

const paramsSchema = z.object({
  temperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.number().int().min(1).max(200_000).nullable(),
  topP: z.number().min(0).max(1).nullable(),
  voice: z.string().max(64).nullable(),
  speed: z.number().min(0.5).max(2).nullable(),
});

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), "Base URL 要以 http:// 或 https:// 开头");

const modelUrl = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => /^(https?|wss?):\/\/[^\s]+$/i.test(value), "地址要以 http(s):// 或 ws(s):// 开头");

const modelDraftSchema = z.object({
  id: modelId.optional(),
  name: z.string().trim().min(1).max(60),
  provider: z.enum(["openai", "anthropic", "dashscope", "custom"]),
  capability: z.enum(["chat", "asr", "tts"]),
  baseUrl: modelUrl,
  modelId: z.string().trim().min(1).max(160),
  params: paramsSchema,
  headers: z.array(headerPair).max(12),
  apiKey: z.string().max(500).nullable().optional(),
});

const mcpServerSchema = z.object({
  name: z.string().trim().min(1).max(40),
  command: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(300)).max(20),
  env: z.record(z.string().max(80), z.string().max(500)),
  enabled: z.boolean(),
  description: z.string().max(200).optional(),
});

const configPatchSchema = z.object({
  hotkey: z.string().trim().min(1).max(80).optional(),
  onboardingDone: z.boolean().optional(),
  taskRuntime: z.enum(["builtin", "pi"]).optional(),
  narration: z.boolean().optional(),
  ackEnabled: z.boolean().optional(),
  autoStop: z.boolean().optional(),
  autoStopSilenceMs: z.number().int().min(300).max(3000).optional(),
  handsFree: z.boolean().optional(),
  privateMode: z.boolean().optional(),
  autoEscalate: z.boolean().optional(),
  asrLanguage: z.enum(["zh", "en", "auto"]).optional(),
  permissionWindow: z.boolean().optional(),
  approvalTimeoutSec: z.number().int().min(10).max(300).optional(),
  g3Voice: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  launchAtLogin: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  mediaRoots: z.array(z.string().max(300)).max(10).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "参数"}: ${issue.message}`).join("；");
    throw new AppError("invalid_input", { detail });
  }
  return result.data;
}

/** 用户手写的热键要归一化：Electron 只认 Control，不认 Ctrl */
export function normalizeAccelerator(input: string): string {
  return input
    .replace(/\bctrl\b/gi, "Control")
    .replace(/\bcmd\b/gi, "Command")
    .replace(/⌘/g, "Command")
    .replace(/\s+/g, "")
    .replace(/\+{2,}/g, "+");
}

function encodeError(err: unknown): Error {
  return new Error(`KIVORA_ERR:${JSON.stringify(serializeError(err))}`);
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      console.error(`[kivora] ipc ${channel} failed:`, err instanceof Error ? err.message : err);
      throw encodeError(err);
    }
  });
}

let listening = false;

export function markListening(value: boolean): void {
  listening = value;
  broadcast("overlay");
}

export interface IpcDeps {
  applyHotkey(accelerator: string): { ok: boolean; hotkey: string };
}

export function registerIpc(deps: IpcDeps): void {
  handle(IPC.bootstrap, () => ({ state: appState(), config: getConfig() }));

  /* --------------------------------------------------------- 时间线 */

  handle(IPC.timelineList, (_event, limit) => listTimeline(typeof limit === "number" ? limit : 80));
  handle(IPC.tasksList, () => listActiveSessions());

  handle(IPC.send, async (_event, raw) => {
    const text = parse(z.string().trim().min(1).max(2000), raw);
    const result = await handleUtterance(text, { source: "text" });
    broadcast("timeline");
    broadcast("queue");
    return result;
  });

  handle(IPC.transcribe, async (_event, rawBase64, rawMime, rawDispatch) => {
    const base64 = parse(z.string().min(1).max(30_000_000), rawBase64);
    const mime = parse(z.string().max(120), rawMime);
    const dispatch = rawDispatch !== false;
    const bytes = Buffer.from(base64, "base64");
    const transcript = await transcribeAudio(new Uint8Array(bytes), mime || "audio/webm");
    if (dispatch && transcript.text) {
      await handleUtterance(transcript.text, { source: "voice", confidence: transcript.confidence });
      broadcast("timeline");
    }
    return transcript;
  });

  handle(IPC.speak, async (_event, raw) => {
    const text = parse(z.string().trim().min(1).max(600), raw);
    return synthesizeSpeech(text);
  });

  /* ------------------------------------------------- 流式识别（边说边出字） */

  const streams = new Map<string, AsrStream>();

  handle(IPC.asrStreamStart, async () => {
    const model = getBoundModel("asr");
    if (!model || model.provider !== "dashscope" || !isStreamingAsrModel(model.modelId)) {
      return { streaming: false as const };
    }
    const key = getSecret(modelSecretName(model.id));
    if (!key) return { streaming: false as const };
    try {
      const stream = await AsrStream.start({
        url: model.baseUrl,
        apiKey: key,
        model: model.modelId,
        onPartial: (text) => broadcast("voice", { partial: text }),
      });
      const id = newId("asr");
      streams.set(id, stream);
      return { streaming: true as const, id };
    } catch (err) {
      // 流式起不来就退回批式，别让用户因为这功能听不见
      console.warn("[kivora] asr stream failed, fallback to batch", err instanceof Error ? err.message : err);
      return { streaming: false as const };
    }
  });

  handle(IPC.asrStreamChunk, (_event, rawId, rawBase64) => {
    const id = parse(z.string().max(40), rawId);
    const base64 = parse(z.string().max(4_000_000), rawBase64);
    streams.get(id)?.push(new Uint8Array(Buffer.from(base64, "base64")));
  });

  handle(IPC.asrStreamFinish, async (_event, rawId) => {
    const id = parse(z.string().max(40), rawId);
    const stream = streams.get(id);
    if (!stream) return { text: "" };
    streams.delete(id);
    const { text } = await stream.finish();
    broadcast("voice", { partial: "" });
    if (text.trim()) {
      await handleUtterance(text, { source: "voice" });
      broadcast("timeline");
    }
    return { text };
  });

  handle(IPC.asrStreamCancel, (_event, rawId) => {
    const id = parse(z.string().max(40), rawId);
    streams.get(id)?.cancel();
    streams.delete(id);
    broadcast("voice", { partial: "" });
  });

  /* ----------------------------------------------------------- 会话 */

  handle(IPC.sessionsList, (_event, query) =>
    listSessionItems(typeof query === "string" && query.trim() ? query : undefined),
  );

  handle(IPC.sessionGet, (_event, raw) => {
    const id = parse(sessionId, raw);
    const session = getSession(id);
    if (!session) throw new AppError("not_found", { message: "这个会话已经不在了。" });
    return {
      session,
      events: listEvents(id, 200),
      messages: listSessionMessages(id),
      approval: pendingForSession(id),
    };
  });

  handle(IPC.sessionCancel, (_event, raw) => {
    cancelTaskById(parse(sessionId, raw));
    refreshPermissionWindow();
  });

  handle(IPC.sessionRetry, (_event, rawId, rawMode) => {
    const mode = parse(z.enum(["continue", "restart"]), rawMode);
    retryTaskById(parse(sessionId, rawId), mode);
  });

  handle(IPC.sessionResume, (_event, raw) => resumeTaskById(parse(sessionId, raw)));

  handle(IPC.sessionCompact, async (_event, raw) => {
    const id = parse(sessionId, raw);
    const result = await compactPiSession(id);
    if (!result) throw new AppError("conflict", { message: "只有正在跑的 Pi 会话能压缩。" });
    broadcast("sessions");
    return result;
  });

  handle(IPC.sessionDelete, (_event, raw) => {
    const id = parse(sessionId, raw);
    cancelRun(id);
    cancelPiRun(id);
    // 删会话前先把它挂着的审批结掉，否则等答案的会话会一直挂着
    cancelApprovalsForSession(id);
    deleteSession(id);
    broadcast("sessions");
    broadcast("timeline");
  });

  /* ----------------------------------------------------------- 审批 */

  handle(IPC.approvalsList, () => listApprovals());

  handle(IPC.approvalsAnswer, (_event, rawId, rawResolution) => {
    const id = parse(approvalId, rawId);
    const resolution = parse(resolutionSchema, rawResolution) as ApprovalResolution;
    const approval = answerById(id, resolution);
    refreshPermissionWindow();
    return approval;
  });

  /* ----------------------------------------------------------- 队列 */

  handle(IPC.queueList, () => listQueue());

  handle(IPC.queueCancel, (_event, raw) => {
    const id = parse(queueId, raw);
    const row = listQueue().find((item) => item.id === id);
    removeFromQueue(id);
    if (row) {
      const session = getSession(row.sessionId);
      if (session && (session.state === "queued" || session.state === "paused")) {
        cancelRun(session.id);
        cancelPiRun(session.id);
        setSessionState(session.id, "aborted", { summary: "取消了排队" });
        appendEvent(session.id, "aborted", "取消了排队");
      }
    }
    broadcast("queue");
    broadcast("sessions");
  });

  handle(IPC.queuePromote, (_event, raw) => {
    promoteQueued(parse(queueId, raw));
    broadcast("queue");
  });

  handle(IPC.queueClear, () => {
    const rows = listQueue();
    clearQueue();
    for (const row of rows) {
      const session = getSession(row.sessionId);
      if (session && session.state === "queued") {
        setSessionState(session.id, "aborted", { summary: "全部取消" });
        appendEvent(session.id, "aborted", "全部取消");
      }
    }
    broadcast("queue");
    broadcast("sessions");
  });

  /* ----------------------------------------------------------- 模型 */

  handle(IPC.modelsList, () => listModels());
  handle(IPC.modelsBindings, () => listBindings());

  handle(IPC.modelsSave, (_event, raw) => {
    const draft = parse(modelDraftSchema, raw);
    const saved = draft.id ? updateModel({ ...draft, id: draft.id }) : createModel(draft);
    broadcast("models");
    broadcast("config");
    return saved;
  });

  handle(IPC.modelsDelete, (_event, raw) => {
    deleteModel(parse(modelId, raw));
    broadcast("models");
  });

  handle(IPC.modelsTest, async (_event, raw) => {
    const id = parse(modelId, raw);
    const model = getModel(id);
    if (!model) throw new AppError("not_found", { message: "这个模型已经不在了。" });
    const result = await probeModel(model, getSecret(modelSecretName(id)), mockMode());
    broadcast("models");
    return result;
  });

  handle(IPC.modelsTestAll, async () => {
    const models = listModels();
    const results = [];
    for (const model of models) {
      results.push(await probeModel(model, getSecret(modelSecretName(model.id)), mockMode()));
    }
    broadcast("models");
    return results;
  });

  handle(IPC.modelsBind, (_event, rawModule, rawModel) => {
    const module = parse(z.enum(["brain", "asr", "tts", "task"]), rawModule) as ModuleKey;
    const target = rawModel === null ? null : parse(modelId, rawModel);
    const bindings = bindModel(module, target);
    broadcast("models");
    return bindings;
  });

  handle(IPC.modelsPresets, (): ModelPreset[] => PRESETS);

  /* ------------------------------------------------------------- MCP */

  handle(IPC.mcpList, () => listServers());

  handle(IPC.mcpSave, (_event, raw, rawName) => {
    const input = parse(mcpServerSchema, raw);
    const previous = typeof rawName === "string" && rawName ? rawName : undefined;
    const next = saveServer(input, previous);
    broadcast("config");
    return next;
  });

  handle(IPC.mcpDelete, (_event, raw) => {
    const next = removeServer(parse(z.string().min(1).max(60), raw));
    broadcast("config");
    return next;
  });

  handle(IPC.mcpTest, async (_event, raw) => {
    const name = parse(z.string().min(1).max(60), raw);
    const server = listServers().find((item) => item.name === name);
    return probeMcpServer(assertProbeable(server));
  });

  handle(IPC.mcpCapability, () => mcpCapability());
  handle(IPC.mcpPresets, () => MCP_PRESETS);

  /* --------------------------------------------------------- 授权 */

  handle(IPC.grantsList, () => listGrants());

  handle(IPC.grantsRevoke, (_event, raw) => {
    const id = typeof raw === "string" && raw ? parse(sessionId, raw) : undefined;
    revokeGrants(id);
    broadcast("approvals");
  });

  handle(IPC.openExternal, async (_event, raw) => {
    const url = parse(httpUrl, raw);
    await shell.openExternal(url);
  });

  /* ----------------------------------------------------------- 配置 */

  handle(IPC.configGet, () => getConfig());

  handle(IPC.configSet, (_event, raw) => {
    const patch = parse(configPatchSchema, raw) as Partial<AppConfig>;
    const next = setConfig(patch);
    if (typeof patch.launchAtLogin === "boolean") {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    broadcast("config");
    return next;
  });

  handle(IPC.configHotkey, (_event, raw) => {
    const accelerator = normalizeAccelerator(parse(z.string().trim().min(1).max(80), raw));
    const applied = deps.applyHotkey(accelerator);
    if (!applied.ok) {
      throw new AppError("invalid_input", { message: "这个热键被别的程序占用了，换一个。" });
    }
    setConfig({ hotkey: applied.hotkey });
    broadcast("config");
    return { ok: true, hotkey: applied.hotkey, state: appState() };
  });

  handle(IPC.setupComplete, () => {
    const next = setConfig({ onboardingDone: true });
    broadcast("config");
    return next;
  });

  /* --------------------------------------------------------- 悬浮窗 */

  handle(IPC.overlayState, (): OverlayState => {
    const config = getConfig();
    const last = listSessionItems(undefined, 1)[0] ?? null;
    const running = findRunningSession();
    return {
      listening,
      pendingApproval: pendingApprovals()[0] ?? null,
      queuedCount: listQueue().length,
      foreground: running ? running.title : null,
      foregroundDetail: running ? `${running.status.turn} 轮 · ${running.status.tool ?? "在想"}` : null,
      selectedCount: null,
      lastRun: last ? { title: last.title, state: last.state, ageMs: Date.now() - last.updatedAt } : null,
      hotkey: config.hotkey,
      autoStop: config.autoStop,
      thinking: isThinking(),
      speaking: isSpeaking(),
      handsFree: config.handsFree,
    };
  });

  handle(IPC.interrupt, () => interruptTurn());

  ipcMain.on(IPC.speechDone, () => setSpeaking(false));

  handle(IPC.overlayAsk, () => {
    focusMain();
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"));
    // 录音状态由主窗自己上报（真打开麦克风才叫"在听"），悬浮窗不再收起来
    if (win) win.webContents.send(IPC.hotkeyPressed);
  });

  handle(IPC.overlayOpenMain, () => {
    focusMain();
  });

  handle(IPC.overlayHide, () => hideOverlay());

  handle(IPC.overlayStopVoice, () => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"));
    if (win) win.webContents.send(IPC.voiceStop);
  });

  handle(IPC.overlayResize, (_event, raw) => {
    const height = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    if (height > 0) resizeOverlay(height);
  });

  handle(IPC.windowOpenSettings, () => {
    focusMain();
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"));
    if (win) win.webContents.send(IPC.navigate, "/settings");
  });

  // 悬浮窗由热键/托盘打开，常驻后由用户收起——启动时不自动出现

  // 主窗上报的录音状态与电平：前者决定"在听"，后者喂悬浮窗的波纹
  ipcMain.on(IPC.voiceState, (_event, value: unknown) => {
    markListening(value === true);
  });
  ipcMain.on(IPC.voiceLevel, (_event, value: unknown) => {
    const level = typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    broadcast("voice", { level });
  });
}

const PRESETS: ModelPreset[] = [
  { label: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com/v1", capability: "chat", modelId: "deepseek-flash" },
  { label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", capability: "chat", modelId: "gpt-4.1-mini" },
  {
    label: "Anthropic",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    capability: "chat",
    modelId: "claude-sonnet-4-6",
  },
  {
    label: "阿里百炼",
    provider: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    capability: "chat",
    modelId: "qwen-plus",
  },
  {
    // 流式识别（边说边出字）：绑到这个模型，说话时就走 asrStream* 这条路
    label: "Qwen 流式识别",
    provider: "dashscope",
    baseUrl: "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference",
    capability: "asr",
    modelId: "qwen-audio-3.1-asr-flash-streaming",
  },
  {
    label: "硅基流动",
    provider: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    capability: "chat",
    modelId: "Qwen/Qwen2.5-72B-Instruct",
  },
  { label: "本地 Ollama", provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", capability: "chat", modelId: "qwen2.5" },
  // 语音：Qwen Audio 3.1 系列（阿里百炼 OpenAI 兼容端点）
  {
    label: "Qwen ASR（短音频）",
    provider: "dashscope",
    baseUrl: "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference",
    capability: "asr",
    modelId: "qwen-audio-3.1-asr-flash-message",
  },
  {
    label: "Qwen ASR（长文件）",
    provider: "dashscope",
    baseUrl: "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference",
    capability: "asr",
    modelId: "qwen-audio-3.1-asr-flash-filetrans",
  },
  {
    label: "Qwen TTS（低延迟）",
    provider: "dashscope",
    baseUrl: "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference",
    capability: "tts",
    modelId: "qwen-audio-3.1-tts-flash",
  },
  {
    label: "Qwen TTS Next",
    provider: "dashscope",
    baseUrl: "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference",
    capability: "tts",
    modelId: "qwen-audio-3.1-tts-next",
  },
  {
    label: "Qwen 实时语音",
    provider: "dashscope",
    baseUrl: "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference",
    capability: "asr",
    modelId: "qwen-audio-3.1-realtime-plus",
  },
  { label: "Whisper", provider: "openai", baseUrl: "https://api.openai.com/v1", capability: "asr", modelId: "whisper-1" },
  { label: "OpenAI TTS", provider: "openai", baseUrl: "https://api.openai.com/v1", capability: "tts", modelId: "tts-1" },
];

export function configDefaults(): AppConfig {
  return CONFIG_DEFAULTS;
}

export { appState };
