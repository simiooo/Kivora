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
import { answerById } from "./dispatcher/approval-bus.ts";
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
import { probeModel } from "./providers/probe.ts";
import { synthesizeSpeech, transcribeAudio } from "./voice.ts";
import { broadcast } from "./bus.ts";
import { focusMain, hideOverlay, refreshPermissionWindow, showOverlay } from "./windows.ts";
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

const modelDraftSchema = z.object({
  id: modelId.optional(),
  name: z.string().trim().min(1).max(60),
  provider: z.enum(["openai", "anthropic", "custom"]),
  capability: z.enum(["chat", "asr", "tts"]),
  baseUrl: httpUrl,
  modelId: z.string().trim().min(1).max(160),
  params: paramsSchema,
  headers: z.array(headerPair).max(12),
  apiKey: z.string().max(500).nullable().optional(),
});

const configPatchSchema = z.object({
  hotkey: z.string().trim().min(1).max(80).optional(),
  mockMode: z.boolean().optional(),
  onboardingDone: z.boolean().optional(),
  narration: z.boolean().optional(),
  ackEnabled: z.boolean().optional(),
  asrLanguage: z.enum(["zh", "en", "auto"]).optional(),
  permissionWindow: z.boolean().optional(),
  approvalTimeoutSec: z.number().int().min(10).max(300).optional(),
  g3Voice: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(90).optional(),
  launchAtLogin: z.boolean().optional(),
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

  handle(IPC.sessionDelete, (_event, raw) => {
    const id = parse(sessionId, raw);
    cancelRun(id);
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
    const result = await probeModel(model, getSecret(modelSecretName(id)), getConfig().mockMode);
    broadcast("models");
    return result;
  });

  handle(IPC.modelsTestAll, async () => {
    const models = listModels();
    const results = [];
    for (const model of models) {
      results.push(await probeModel(model, getSecret(modelSecretName(model.id)), getConfig().mockMode));
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
      mock: config.mockMode,
    };
  });

  handle(IPC.overlayAsk, () => {
    focusMain();
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"));
    if (win) win.webContents.send(IPC.hotkeyPressed);
    markListening(true);
    hideOverlay();
  });

  handle(IPC.overlayOpenMain, () => {
    focusMain();
    hideOverlay();
  });

  handle(IPC.overlayHide, () => hideOverlay());

  handle(IPC.windowOpenSettings, () => {
    focusMain();
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("index.html"));
    if (win) win.webContents.send(IPC.navigate, "/settings");
  });

  if (getConfig().onboardingDone) showOverlay();
}

const PRESETS: ModelPreset[] = [
  { label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", capability: "chat", modelId: "gpt-4.1-mini" },
  { label: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com/v1", capability: "chat", modelId: "deepseek-chat" },
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
    label: "硅基流动",
    provider: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    capability: "chat",
    modelId: "Qwen/Qwen2.5-72B-Instruct",
  },
  { label: "本地 Ollama", provider: "custom", baseUrl: "http://127.0.0.1:11434/v1", capability: "chat", modelId: "qwen2.5" },
  { label: "Whisper", provider: "openai", baseUrl: "https://api.openai.com/v1", capability: "asr", modelId: "whisper-1" },
  { label: "OpenAI TTS", provider: "openai", baseUrl: "https://api.openai.com/v1", capability: "tts", modelId: "tts-1" },
];

export function configDefaults(): AppConfig {
  return CONFIG_DEFAULTS;
}

export { appState };
