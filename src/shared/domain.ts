/**
 * Kivora 的领域模型。主进程与渲染进程共用同一份定义，
 * 保证 IPC 两侧不会各自漂移（所有输入在 IPC 边界用 zod 再校验一次）。
 */

export type Role = "user" | "assistant" | "system";

export type ModuleKey = "brain" | "asr" | "tts" | "task";

export const MODULE_LABELS: Record<ModuleKey, string> = {
  brain: "调度 LLM",
  asr: "语音识别",
  tts: "语音合成",
  task: "任务模型",
};

export const MODULE_CAPABILITY: Record<ModuleKey, Capability> = {
  brain: "chat",
  asr: "asr",
  tts: "tts",
  task: "chat",
};

/* ------------------------------------------------------------------ 消息 */

export interface Message {
  id: number;
  sessionId: string | null;
  role: Role;
  content: string;
  ts: number;
  /** 用户消息是打字还是说的；系统消息用于"系统事件"行 */
  source: "text" | "voice" | "system";
  /** 内联卡片的归属：审批请求会挂一条 assistant 消息 */
  approvalId: string | null;
  /** 失败行：错误码 + 是否可重试（画板 11 的行内错误） */
  error: { code: string; message: string; retryable: boolean } | null;
  /** 语音转写的置信度（0–1），低置信度提示"转写可能不准" */
  confidence: number | null;
}

/* ---------------------------------------------------------------- 会话 */

export type SessionState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_user"
  | "paused"
  | "done"
  | "failed"
  | "aborted";

/** 进度只用四值表达，不编百分比（3.7） */
export type SessionPhase = "thinking" | "acting" | "verifying" | "idle";

export interface SessionError {
  code: string;
  message: string;
  detail: string | null;
  retryable: boolean;
  at: number;
}

export interface SessionStatus {
  state: SessionState;
  turn: number;
  phase: SessionPhase;
  tool: string | null;
  lastToolOk: boolean | null;
  elapsedMs: number;
  needs: "confirm" | "clarify" | null;
  artifacts: string[];
  summary: string | null;
  updatedAt: number;
}

export interface Session {
  id: string;
  title: string;
  prompt: string;
  state: SessionState;
  priority: number;
  runner: "mock" | "pi";
  createdAt: number;
  updatedAt: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: SessionError | null;
  status: SessionStatus;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  seq: number;
  ts: number;
  type: SessionEventType;
  summary: string;
  payload: Record<string, unknown>;
}

export type SessionEventType =
  | "created"
  | "queued"
  | "started"
  | "turn"
  | "tool_start"
  | "tool_end"
  | "approval"
  | "approval_resolved"
  | "answered"
  | "done"
  | "failed"
  | "aborted"
  | "note";

export const ACTIVE_STATES: SessionState[] = [
  "queued",
  "starting",
  "running",
  "waiting_user",
  "paused",
];

export function isActive(state: SessionState): boolean {
  return ACTIVE_STATES.includes(state);
}

export const STATE_LABELS: Record<SessionState, string> = {
  queued: "排队中",
  starting: "准备中",
  running: "运行中",
  waiting_user: "等你确认",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  aborted: "已取消",
};

export const PHASE_LABELS: Record<SessionPhase, string> = {
  thinking: "在想",
  acting: "在操作",
  verifying: "在核对",
  idle: "空闲",
};

/* -------------------------------------------------------------- 队列 */

export type QueueKind = "queue" | "steer";

export interface QueueItem {
  id: string;
  sessionId: string;
  text: string;
  kind: QueueKind;
  position: number;
  enqueuedAt: number;
}

export const QUEUE_LIMIT = 5;

/* -------------------------------------------------------------- 审批 */

export type Risk = "G1" | "G2" | "G3";
export type ApprovalOption = "allow_once" | "allow_scope" | "deny";
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";
export type ApprovalResolution = ApprovalOption | "timeout" | "cancelled";

export interface Approval {
  id: string;
  source: "scheduler" | "session" | "child";
  sessionId: string | null;
  sessionTitle: string | null;
  tool: string;
  risk: Risk;
  summary: string;
  title: string;
  detail: string[];
  options: ApprovalOption[];
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number | null;
  resolution: ApprovalResolution | null;
  resolvedAt: number | null;
  /** 说出口的那句（≤20 字） */
  speech: string;
}

/** G1 30s / G2 60s；G3 不自动超时（4.3） */
export function approvalTimeoutMs(risk: Risk): number | null {
  if (risk === "G1") return 30_000;
  if (risk === "G2") return 60_000;
  return null;
}

/**
 * 用户设置里的"多久没回答算拒绝"不能突破风险等级的天花板：
 * 填 300 秒也不会让 G2 等过 60 秒。
 */
export function effectiveApprovalTimeoutMs(risk: Risk, userSeconds: number): number | null {
  const cap = approvalTimeoutMs(risk);
  if (cap === null) return null;
  const wanted = Math.max(10, Math.min(300, Math.round(userSeconds))) * 1000;
  return Math.min(cap, wanted);
}

export interface Grant {
  id: string;
  sessionId: string | null;
  tool: string;
  scope: "path" | "domain" | "command_prefix" | "any";
  value: string;
  expiresAt: number | null;
  createdAt: number;
}

/* -------------------------------------------------------------- 模型 */

export type Capability = "chat" | "asr" | "tts";
export type ProviderKind = "openai" | "anthropic" | "dashscope" | "custom";

export const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "对话",
  asr: "语音识别",
  tts: "语音合成",
};

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic 兼容",
  dashscope: "DashScope WebSocket",
  custom: "自建",
};

export interface HeaderPair {
  name: string;
  value: string;
}

export interface ModelParams {
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  /** ASR / TTS 用不到前三个时，把音色、语速放这里 */
  voice: string | null;
  speed: number | null;
}

export const DEFAULT_PARAMS: ModelParams = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: null,
  voice: null,
  speed: null,
};

export type TestStatus = "untested" | "ok" | "failed";

export interface ModelRecord {
  id: string;
  name: string;
  provider: ProviderKind;
  capability: Capability;
  baseUrl: string;
  modelId: string;
  params: ModelParams;
  headers: HeaderPair[];
  /** 只存掩码，真 Key 在 secrets 表里由 safeStorage 加密 */
  keyHint: string | null;
  hasKey: boolean;
  testStatus: TestStatus;
  testLatencyMs: number | null;
  testedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Binding {
  module: ModuleKey;
  modelId: string;
}

export interface TestResult {
  modelId: string;
  ok: boolean;
  latencyMs: number;
  error: { code: string; message: string; detail: string | null } | null;
  at: number;
}

/** 模型输入的公共形状（主进程用 zod 再校验） */
export interface ModelDraft {
  id?: string;
  name: string;
  provider: ProviderKind;
  capability: Capability;
  baseUrl: string;
  modelId: string;
  params: ModelParams;
  headers: HeaderPair[];
  /** 空字符串表示不改 Key；null 表示清空 */
  apiKey?: string | null;
}

/* -------------------------------------------------------------- 配置 */

export type AsrLanguage = "zh" | "en" | "auto";

/** 任务执行器：内置（文件整理）/ Pi 会话（pi -p --mode json） */
export type TaskRuntime = "builtin" | "pi";

export interface AppConfig {
  hotkey: string;
  onboardingDone: boolean;
  taskRuntime: TaskRuntime;
  /** 旁白：模型文本先出口（3.9） */
  narration: boolean;
  /** 缓存 ack 片段 */
  ackEnabled: boolean;
  /** 说完自动结束录音（能量包络端点检测，不依赖模型） */
  autoStop: boolean;
  /** 静音多久算说完 */
  autoStopSilenceMs: number;
  asrLanguage: AsrLanguage;
  /** 浮窗（画板 09） */
  permissionWindow: boolean;
  /** 审批超时默认拒绝的秒数，G1/G2 各自有上限，这里只做用户可调 */
  approvalTimeoutSec: number;
  /** G3 从不走语音 */
  g3Voice: boolean;
  /** 时间线保留天数（事件清理） */
  retentionDays: number;
  launchAtLogin: boolean;
  /** 关主窗时收进托盘，而不是退出 */
  closeToTray: boolean;
  mediaRoots: string[];
}

/* ------------------------------------------------------------ 应用状态 */

export interface AppState {
  version: string;
  electron: string;
  node: string;
  dbPath: string;
  schemaVersion: number;
  hotkey: string;
  hotkeyOk: boolean;
  secretsAvailable: boolean;
  piAvailable: boolean;
  piVersion: string | null;
  dataDir: string;
}

export interface Bootstrap {
  state: AppState;
  config: AppConfig;
}

/* --------------------------------------------------------- 语音/转写 */

export interface Transcript {
  text: string;
  /** 0–1；mock 与部分端点不给 */
  confidence: number | null;
  /** 实际耗时 */
  durationMs: number;
  provider: "mock" | "openai";
  error: { code: string; message: string; retryable: boolean } | null;
}

export interface SpeechClip {
  ok: boolean;
  /** base64，audio/wav 或 mp3；mock 时是提示音 */
  audioBase64: string | null;
  mime: string;
  cached: boolean;
  durationMs: number;
  error: { code: string; message: string; retryable: boolean } | null;
}

/* ------------------------------------------------------------ 时间线结果 */

export interface TurnResult {
  messages: Message[];
  /** 调度器这一轮做了什么，便于 UI 立刻更新 */
  action: DispatcherAction;
  spoken: string | null;
}

export type DispatcherAction =
  | { kind: "none" }
  | { kind: "task_created"; sessionId: string; title: string; queued: boolean }
  | { kind: "status"; sessionId: string | null }
  | { kind: "cancelled"; sessionId: string }
  | { kind: "retried"; sessionId: string; mode: "continue" | "restart" }
  | { kind: "answer"; approvalId: string; resolution: ApprovalResolution }
  | { kind: "queued"; sessionId: string; position: number }
  | { kind: "promoted"; sessionId: string; position: number }
  | { kind: "steered"; sessionId: string }
  | { kind: "clarify"; question: string }
  | { kind: "config"; applied: string[] };

/* ------------------------------------------------------- 会话列表视图 */

export interface SessionListItem {
  id: string;
  title: string;
  state: SessionState;
  summary: string | null;
  updatedAt: number;
  createdAt: number;
  turn: number;
  tool: string | null;
  artifactCount: number;
  elapsedMs: number;
  error: SessionError | null;
}

export interface SessionDetail {
  session: Session;
  events: SessionEvent[];
  messages: Message[];
  approval: Approval | null;
}

/* ------------------------------------------------------------ 悬浮卡 */

/** CUA / 浏览器这类能力走 Pi 的 MCP 扩展，Kivora 只管理配置 */
export interface McpServerInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  description?: string;
}

export interface McpServerView extends McpServerInput {
  /** 是不是 Kivora 写进去的（只有这些允许从 UI 删） */
  managed: boolean;
  available: boolean | null;
}

export interface McpCapability {
  pi: string | null;
  available: boolean;
  reason: string;
  file: string;
}

export interface McpPreset {
  key: string;
  label: string;
  hint: string;
  server: McpServerInput;
}

export interface OverlayState {
  listening: boolean;
  pendingApproval: Approval | null;
  queuedCount: number;
  foreground: string | null;
  foregroundDetail: string | null;
  selectedCount: number | null;
  lastRun: { title: string; state: SessionState; ageMs: number } | null;
  hotkey: string;
  /** 说完自动结束开着时，悬浮窗的提示文案要跟着变 */
  autoStop: boolean;
}

/* --------------------------------------------------------------- 杂项 */

export function newId(prefix: string): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export function roleLabel(role: Role): string {
  if (role === "user") return "你";
  if (role === "system") return "系统";
  return "Kivora";
}
