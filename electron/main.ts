import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC, type AppConfig } from "../src/shared/ipc.ts";
import { appendMessage, getConfig, listTimeline, openStore, setConfig, storeInfo } from "../src/main/store.ts";
import { mockDispatch } from "../src/main/mock.ts";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

let win: BrowserWindow | null = null;
let currentHotkey = "";

function createWindow(): void {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#151615",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#151615", symbolColor: "#bdbbb3", height: 40 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  win.webContents.on("console-message", (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[kivora] did-fail-load ${code} ${desc} ${url}`);
  });

  if (process.argv.includes("--smoke")) {
    win.webContents.once("did-finish-load", async () => {
      console.log("[kivora] smoke: renderer loaded");
      await new Promise((r) => setTimeout(r, 700));
      try {
        const image = await win?.webContents.capturePage();
        const outDir = path.join(process.cwd(), "artifacts");
        fs.mkdirSync(outDir, { recursive: true });
        if (image) fs.writeFileSync(path.join(outDir, "smoke.png"), image.toPNG());
        console.log("[kivora] smoke: screenshot saved");
      } catch (err) {
        console.error("[kivora] smoke: screenshot failed", err);
      }
      app.quit();
    });
  }

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  win.on("closed", () => {
    win = null;
  });
}

function registerHotkey(accelerator: string): void {
  if (currentHotkey) globalShortcut.unregister(currentHotkey);
  const ok = globalShortcut.register(accelerator, () => {
    win?.webContents.send(IPC.hotkeyPressed);
    win?.show();
    win?.focus();
  });
  currentHotkey = ok ? accelerator : "";
  if (!ok) console.warn(`[kivora] hotkey not registered: ${accelerator}`);
}

function registerIpc(): void {
  ipcMain.handle(IPC.appState, () => {
    const info = storeInfo();
    const cfg = getConfig();
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      dbPath: info.dbPath,
      schemaVersion: info.schemaVersion,
      hotkey: cfg.hotkey,
      mock: cfg.mockMode,
    };
  });

  ipcMain.handle(IPC.timelineList, (_event, limit?: number) => listTimeline(limit ?? 50));

  ipcMain.handle(IPC.timelineSend, async (_event, text: string) => {
    const cfg = getConfig();
    const user = appendMessage("user", text);
    await new Promise((r) => setTimeout(r, 180));
    const reply = mockDispatch(text, cfg);
    const assistant = appendMessage("assistant", reply);
    return { user, assistant };
  });

  ipcMain.handle(IPC.configGet, () => getConfig());

  ipcMain.handle(IPC.configSet, (_event, patch: Partial<AppConfig>) => {
    const next = setConfig(patch);
    if (patch.hotkey && patch.hotkey !== currentHotkey) registerHotkey(patch.hotkey);
    return next;
  });
}

app.whenReady().then(() => {
  const dataDir = path.join(app.getPath("userData"), "data");
  const info = openStore(dataDir);
  console.log(`[kivora] store ${info.dbPath} schema v${info.schemaVersion}`);
  registerIpc();
  createWindow();
  registerHotkey(getConfig().hotkey);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
