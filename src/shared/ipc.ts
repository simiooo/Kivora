import type {
  AppConfig,
  AppState,
  Approval,
  ApprovalResolution,
  Binding,
  Bootstrap,
  Grant,
  Message,
  ModelDraft,
  McpCapability,
  McpPreset,
  McpServerInput,
  McpServerView,
  ModelRecord,
  ModuleKey,
  OverlayState,
  QueueItem,
  Session,
  SessionDetail,
  SessionListItem,
  SpeechClip,
  TestResult,
  Transcript,
  TurnResult,
} from "./domain.ts";

export type {
  AppConfig,
  AppState,
  Approval,
  ApprovalResolution,
  Binding,
  Bootstrap,
  Grant,
  Message,
  ModelDraft,
  McpCapability,
  McpPreset,
  McpServerInput,
  McpServerView,
  ModelRecord,
  ModuleKey,
  OverlayState,
  QueueItem,
  Session,
  SessionDetail,
  SessionListItem,
  SpeechClip,
  TestResult,
  Transcript,
  TurnResult,
};

/** 主进程向渲染进程广播"哪块数据变了"，渲染层据此重取对应切片 */
export type ChangeKind =
  | "timeline"
  | "sessions"
  | "queue"
  | "approvals"
  | "models"
  | "config"
  | "overlay"
  | "voice"
  | "speech"
  | "speech-stop"
  | "hotkey";

export interface ChangeEvent {
  kind: ChangeKind;
  at: number;
  /** speech 事件带内容 */
  speech?: SpeechClip & { id: string };
  /** voice 事件带实时电平（0–1），悬浮窗的波纹照着它画 */
  level?: number;
  /** voice 事件的流式识别中间结果（边说边出字） */
  partial?: string;
}

export const IPC = {
  bootstrap: "kivora:bootstrap",
  timelineList: "kivora:timeline:list",
  tasksList: "kivora:timeline:tasks",
  send: "kivora:timeline:send",
  transcribe: "kivora:voice:transcribe",
  asrStreamStart: "kivora:voice:stream-start",
  asrStreamChunk: "kivora:voice:stream-chunk",
  asrStreamFinish: "kivora:voice:stream-finish",
  asrStreamCancel: "kivora:voice:stream-cancel",
  speak: "kivora:voice:speak",

  sessionsList: "kivora:sessions:list",
  sessionGet: "kivora:sessions:get",
  sessionCancel: "kivora:sessions:cancel",
  sessionRetry: "kivora:sessions:retry",
  sessionResume: "kivora:sessions:resume",
  sessionDelete: "kivora:sessions:delete",
  sessionCompact: "kivora:sessions:compact",

  approvalsList: "kivora:approvals:list",
  approvalsAnswer: "kivora:approvals:answer",

  queueList: "kivora:queue:list",
  queueCancel: "kivora:queue:cancel",
  queuePromote: "kivora:queue:promote",
  queueClear: "kivora:queue:clear",

  modelsList: "kivora:models:list",
  modelsSave: "kivora:models:save",
  modelsDelete: "kivora:models:delete",
  modelsTest: "kivora:models:test",
  modelsTestAll: "kivora:models:test-all",
  modelsBindings: "kivora:models:bindings",
  modelsBind: "kivora:models:bind",
  modelsPresets: "kivora:models:presets",
  mcpList: "kivora:mcp:list",
  mcpSave: "kivora:mcp:save",
  mcpDelete: "kivora:mcp:delete",
  mcpCapability: "kivora:mcp:capability",
  mcpPresets: "kivora:mcp:presets",
  mcpTest: "kivora:mcp:test",
  grantsList: "kivora:grants:list",
  grantsRevoke: "kivora:grants:revoke",
  openExternal: "kivora:shell:open",

  configGet: "kivora:config:get",
  configSet: "kivora:config:set",
  configHotkey: "kivora:config:hotkey",

  setupComplete: "kivora:setup:complete",
  overlayState: "kivora:overlay:state",
  overlayAsk: "kivora:overlay:ask",
  overlayOpenMain: "kivora:overlay:open-main",
  overlayHide: "kivora:overlay:hide",
  overlayStopVoice: "kivora:overlay:stop-voice",
  overlayResize: "kivora:overlay:resize",
  voiceState: "kivora:voice:state",
  voiceLevel: "kivora:voice:level",
  voiceStop: "kivora:voice:stop",
  voiceWake: "kivora:voice:wake",
  speechDone: "kivora:speech:done",
  interrupt: "kivora:turn:interrupt",
  windowOpenSettings: "kivora:window:open-settings",

  changed: "kivora:changed",
  hotkeyPressed: "kivora:hotkey",
  navigate: "kivora:navigate",
} as const;

export interface KivoraBridge {
  /** 应用启动一次性拉取 */
  bootstrap(): Promise<Bootstrap>;
  subscribe(cb: (event: ChangeEvent) => void): () => void;
  onNavigate(cb: (route: string) => void): () => void;
  onHotkey(cb: () => void): () => void;

  listTimeline(limit?: number): Promise<Message[]>;
  listActiveTasks(): Promise<Session[]>;
  send(text: string): Promise<TurnResult>;
  transcribe(base64: string, mime: string, dispatch?: boolean): Promise<Transcript>;
  /** 流式识别：绑定的识别模型支持时返回 { streaming: true, id }，否则让调用方退回批式 */
  asrStreamStart(): Promise<{ streaming: false } | { streaming: true; id: string }>;
  asrStreamChunk(id: string, base64: string): Promise<void>;
  asrStreamFinish(id: string): Promise<{ text: string }>;
  asrStreamCancel(id: string): Promise<void>;
  speak(text: string): Promise<SpeechClip>;

  listSessions(query?: string): Promise<SessionListItem[]>;
  getSession(id: string): Promise<SessionDetail>;
  cancelTask(id: string): Promise<void>;
  retryTask(id: string, mode: "continue" | "restart"): Promise<void>;
  resumeTask(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  compactTask(id: string): Promise<{ before: number; after: number }>;

  listApprovals(): Promise<Approval[]>;
  answerApproval(id: string, resolution: ApprovalResolution): Promise<Approval>;

  listQueue(): Promise<QueueItem[]>;
  cancelQueued(id: string): Promise<void>;
  promoteQueued(id: string): Promise<void>;
  clearQueue(): Promise<void>;

  listModels(): Promise<ModelRecord[]>;
  saveModel(draft: ModelDraft): Promise<ModelRecord>;
  deleteModel(id: string): Promise<void>;
  testModel(id: string): Promise<TestResult>;
  testAllModels(): Promise<TestResult[]>;
  listBindings(): Promise<Binding[]>;
  bindModel(module: ModuleKey, modelId: string | null): Promise<Binding[]>;
  modelPresets(): Promise<ModelPreset[]>;

  listMcpServers(): Promise<McpServerView[]>;
  saveMcpServer(input: McpServerInput, name?: string): Promise<McpServerView[]>;
  deleteMcpServer(name: string): Promise<McpServerView[]>;
  mcpCapability(): Promise<McpCapability>;
  mcpPresets(): Promise<McpPreset[]>;
  testMcpServer(name: string): Promise<McpProbeResult>;

  listGrants(): Promise<Grant[]>;
  revokeGrants(sessionId?: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  setHotkey(accelerator: string): Promise<{ ok: boolean; hotkey: string; state: AppState }>;

  completeSetup(): Promise<AppConfig>;

  getOverlayState(): Promise<OverlayState>;
  overlayAsk(): Promise<void>;
  overlayOpenMain(): Promise<void>;
  overlayHide(): Promise<void>;
  /** 悬浮窗点「停」：让主窗结束录音 */
  overlayStopVoice(): Promise<void>;
  /** 悬浮窗按内容高度调整窗口，避免透明窗口挡住底下的点击 */
  overlayResize(height: number): Promise<void>;
  openSettings(): Promise<void>;

  /** 主窗上报录音状态——"在听"只跟着真实录音走，不靠猜 */
  reportVoice(active: boolean): void;
  /** 主窗上报实时电平（0–1），悬浮窗照着画波纹 */
  reportLevel(level: number): void;
  /** 唤醒词门的状态：悬浮窗据此显示"等你叫名字" */
  reportWake(required: boolean, armed: boolean): void;
  /** 主进程让主窗停下来（来自悬浮窗或后续的快捷键） */
  onStopVoice(cb: () => void): () => void;
  /** 播报放完了，主进程据此把"在说"关掉 */
  speechDone(): void;
  /** 打断：停播报 + 取消正在等的那次判断；返回是否真的打断了什么 */
  interrupt(): Promise<boolean>;
}

export interface McpProbeResult {
  ok: boolean;
  serverName: string;
  serverVersion: string;
  tools: Array<{ name: string; description: string }>;
  latencyMs: number;
  error: { code: string; message: string; detail: string | null } | null;
}

export interface ModelPreset {
  label: string;
  provider: "openai" | "anthropic" | "dashscope" | "custom";
  baseUrl: string;
  capability: "chat" | "asr" | "tts";
  modelId: string;
}
