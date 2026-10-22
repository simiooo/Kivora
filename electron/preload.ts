import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../src/shared/ipc.ts";

const api = {
  getState: () => ipcRenderer.invoke(IPC.appState),
  listTimeline: (limit?: number) => ipcRenderer.invoke(IPC.timelineList, limit),
  send: (text: string) => ipcRenderer.invoke(IPC.timelineSend, text),
  getConfig: () => ipcRenderer.invoke(IPC.configGet),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke(IPC.configSet, patch),
  onHotkey: (cb: () => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.hotkeyPressed, handler);
    return () => {
      ipcRenderer.removeListener(IPC.hotkeyPressed, handler);
    };
  },
};

contextBridge.exposeInMainWorld("kivora", api);
