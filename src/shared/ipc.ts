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
  | "speech"
  | "hotkey";

export interface ChangeEvent {
  kind: ChangeKind;
  at: number;
  /** speech 事件带内容 */
  speech?: SpeechClip & { id: string };
}

export const IPC = {
  bootstrap: "kivora:bootstrap",
  timelineList: "kivora:timeline:list",
  tasksList: "kivora:timeline:tasks",
  send: "kivora:timeline:send",
  transcribe: "kivora:voice:transcribe",
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
  openSettings(): Promise<void>;
}

export interface ModelPreset {
  label: string;
  provider: "openai" | "anthropic" | "custom";
  baseUrl: string;
  capability: "chat" | "asr" | "tts";
  modelId: string;
}
