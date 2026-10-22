export type Role = "user" | "assistant" | "system";

export interface TimelineMessage {
  id: number;
  sessionId: string | null;
  role: Role;
  content: string;
  ts: number;
}

export interface AppState {
  version: string;
  electron: string;
  node: string;
  dbPath: string;
  schemaVersion: number;
  hotkey: string;
  mock: boolean;
}

export interface AppConfig {
  hotkey: string;
  mockMode: boolean;
  asrBaseUrl: string;
  asrModel: string;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  brainBaseUrl: string;
  brainModel: string;
  taskBaseUrl: string;
  taskModel: string;
}

export interface SendResult {
  user: TimelineMessage;
  assistant: TimelineMessage;
}

export const IPC = {
  appState: "app:state",
  timelineList: "timeline:list",
  timelineSend: "timeline:send",
  configGet: "config:get",
  configSet: "config:set",
  hotkeyPressed: "hotkey:pressed",
} as const;

export interface KivoraBridge {
  getState(): Promise<AppState>;
  listTimeline(limit?: number): Promise<TimelineMessage[]>;
  send(text: string): Promise<SendResult>;
  getConfig(): Promise<AppConfig>;
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
  onHotkey(cb: () => void): () => void;
}
