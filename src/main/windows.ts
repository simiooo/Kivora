import { BrowserWindow, app, screen } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc.ts";
import { pendingApprovals } from "./repos/approvals.ts";
import { getConfig } from "./repos/config.ts";

/**
 * 三个窗口：
 * - main：时间线 / 历史 / 设置（一个 React 应用，内部路由）
 * - overlay：桌面常驻胶囊 + 最近上下文（画板 06）
 * - permission：权限浮窗（画板 09），只用来看和点，不抢焦点
 */

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const preloadFile = path.join(__dirname, "preload.cjs");

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let permissionWindow: BrowserWindow | null = null;

function rendererFile(name: string): string {
  return path.join(__dirname, "..", "dist", name);
}

function load(win: BrowserWindow, html: string, route = ""): void {
  if (devServerUrl) {
    const url = new URL(html, devServerUrl);
    if (route) url.hash = `#${route}`;
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(rendererFile(html), route ? { hash: `#${route}` } : undefined);
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null;
}

export function getPermissionWindow(): BrowserWindow | null {
  return permissionWindow && !permissionWindow.isDestroyed() ? permissionWindow : null;
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#151615",
    icon: path.join(app.getAppPath(), "docs", "assets", "icon", "kivora.ico"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#151615", symbolColor: "#6f6b64", height: 44 },
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(`[renderer] ${event.message}`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[kivora] did-fail-load ${code} ${desc} ${url}`);
  });
  load(mainWindow, "index.html");
  return mainWindow;
}

function ensureOverlay(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const display = screen.getPrimaryDisplay().workArea;
  const width = 440;
  const height = 360;
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: display.x + display.width - width - 20,
    y: display.y + display.height - height - 20,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
  load(overlayWindow, "overlay.html");
  return overlayWindow;
}

export function showOverlay(): void {
  const win = ensureOverlay();
  if (win.isVisible()) {
    win.webContents.send(IPC.changed, { kind: "overlay", at: Date.now() });
    return;
  }
  win.showInactive();
  win.webContents.send(IPC.changed, { kind: "overlay", at: Date.now() });
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

export function overlayIsVisible(): boolean {
  return Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
}

export function recreateWindows(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  if (permissionWindow && !permissionWindow.isDestroyed()) {
    permissionWindow.destroy();
    permissionWindow = null;
  }
}

function ensurePermission(): BrowserWindow {
  if (permissionWindow && !permissionWindow.isDestroyed()) return permissionWindow;
  const display = screen.getPrimaryDisplay().workArea;
  const width = 560;
  const height = 330;
  permissionWindow = new BrowserWindow({
    width,
    height,
    x: display.x + display.width - width - 20,
    y: display.y + display.height - height - 20,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  permissionWindow.setAlwaysOnTop(true, "screen-saver");
  permissionWindow.on("closed", () => {
    permissionWindow = null;
  });
  load(permissionWindow, "permission.html");
  return permissionWindow;
}

/** 审批出现/消失时同步浮窗，和主窗里的卡片同源 */
export function refreshPermissionWindow(): void {
  const config = getConfig();
  const pending = pendingApprovals();
  if (!config.permissionWindow || pending.length === 0) {
    if (permissionWindow && !permissionWindow.isDestroyed()) permissionWindow.hide();
    return;
  }
  const win = ensurePermission();
  win.webContents.send(IPC.changed, { kind: "approvals", at: Date.now() });
  if (!win.isVisible()) win.showInactive();
}

export function focusMain(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function broadcastToOverlay(payload: unknown): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(IPC.changed, payload);
  }
}
