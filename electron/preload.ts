import { contextBridge, ipcRenderer } from "electron";
import { IPC, type ChangeEvent, type KivoraBridge } from "../src/shared/ipc.ts";

/**
 * 所有跨进程调用从这里过：统一解包主进程的错误，渲染层拿到的
 * 永远是一个带 code / detail / retryable 的 Error。
 */

function decodeError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const marker = message.indexOf("KIVORA_ERR:");
  if (marker === -1) return err instanceof Error ? err : new Error(message);
  try {
    const payload = JSON.parse(message.slice(marker + "KIVORA_ERR:".length)) as {
      code: string;
      message: string;
      detail: string | null;
      retryable: boolean;
    };
    const error = new Error(payload.message) as Error & {
      code?: string;
      detail?: string | null;
      retryable?: boolean;
    };
    error.code = payload.code;
    error.detail = payload.detail;
    error.retryable = payload.retryable;
    return error;
  } catch {
    return new Error(message);
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    throw decodeError(err);
  }
}

const api: KivoraBridge = {
  bootstrap: () => invoke(IPC.bootstrap),
  subscribe: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ChangeEvent): void => cb(payload);
    ipcRenderer.on(IPC.changed, listener);
    return () => ipcRenderer.removeListener(IPC.changed, listener);
  },
  onNavigate: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, route: string): void => cb(route);
    ipcRenderer.on(IPC.navigate, listener);
    return () => ipcRenderer.removeListener(IPC.navigate, listener);
  },
  onHotkey: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on(IPC.hotkeyPressed, listener);
    return () => ipcRenderer.removeListener(IPC.hotkeyPressed, listener);
  },

  listTimeline: (limit) => invoke(IPC.timelineList, limit),
  listActiveTasks: () => invoke(IPC.tasksList),
  send: (text) => invoke(IPC.send, text),
  transcribe: (base64, mime, dispatch) => invoke(IPC.transcribe, base64, mime, dispatch),
  speak: (text) => invoke(IPC.speak, text),

  listSessions: (query) => invoke(IPC.sessionsList, query),
  getSession: (id) => invoke(IPC.sessionGet, id),
  cancelTask: (id) => invoke(IPC.sessionCancel, id),
  retryTask: (id, mode) => invoke(IPC.sessionRetry, id, mode),
  resumeTask: (id) => invoke(IPC.sessionResume, id),
  deleteSession: (id) => invoke(IPC.sessionDelete, id),
  compactTask: (id) => invoke(IPC.sessionCompact, id),

  listApprovals: () => invoke(IPC.approvalsList),
  answerApproval: (id, resolution) => invoke(IPC.approvalsAnswer, id, resolution),

  listQueue: () => invoke(IPC.queueList),
  cancelQueued: (id) => invoke(IPC.queueCancel, id),
  promoteQueued: (id) => invoke(IPC.queuePromote, id),
  clearQueue: () => invoke(IPC.queueClear),

  listModels: () => invoke(IPC.modelsList),
  saveModel: (draft) => invoke(IPC.modelsSave, draft),
  deleteModel: (id) => invoke(IPC.modelsDelete, id),
  testModel: (id) => invoke(IPC.modelsTest, id),
  testAllModels: () => invoke(IPC.modelsTestAll),
  listBindings: () => invoke(IPC.modelsBindings),
  bindModel: (module, modelId) => invoke(IPC.modelsBind, module, modelId),
  modelPresets: () => invoke(IPC.modelsPresets),

  listMcpServers: () => invoke(IPC.mcpList),
  saveMcpServer: (input, name) => invoke(IPC.mcpSave, input, name),
  deleteMcpServer: (name) => invoke(IPC.mcpDelete, name),
  mcpCapability: () => invoke(IPC.mcpCapability),
  mcpPresets: () => invoke(IPC.mcpPresets),
  testMcpServer: (name) => invoke(IPC.mcpTest, name),

  listGrants: () => invoke(IPC.grantsList),
  revokeGrants: (sessionId) => invoke(IPC.grantsRevoke, sessionId),
  openExternal: (url) => invoke(IPC.openExternal, url),

  getConfig: () => invoke(IPC.configGet),
  setConfig: (patch) => invoke(IPC.configSet, patch),
  setHotkey: (accelerator) => invoke(IPC.configHotkey, accelerator),

  completeSetup: () => invoke(IPC.setupComplete),

  getOverlayState: () => invoke(IPC.overlayState),
  overlayAsk: () => invoke(IPC.overlayAsk),
  overlayOpenMain: () => invoke(IPC.overlayOpenMain),
  overlayHide: () => invoke(IPC.overlayHide),
  openSettings: () => invoke(IPC.windowOpenSettings),
};

contextBridge.exposeInMainWorld("kivora", api);
