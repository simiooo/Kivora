import { BrowserWindow, Menu, Tray, app, nativeImage, screen } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc.ts";
import { pendingApprovals } from "./repos/approvals.ts";
import { getConfig } from "./repos/config.ts";
import { appIcon } from "./paths.ts";

/**
 * 三个窗口 + 一个托盘：
 * - main：时间线 / 历史 / 设置（一个 React 应用，内部路由）
 * - overlay：桌面常驻胶囊 + 最近上下文（画板 06）
 * - permission：权限浮窗（画板 09），只用来看和点，不抢焦点
 * - tray：常驻入口；关主窗不退出（可在设置里关掉）
 */

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const preloadFile = path.join(__dirname, "preload.cjs");

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let permissionWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let trayStatus = "待命";

function rendererFile(name: string): string {
  return path.join(__dirname, "..", "dist", name);
}

/**
 * 主窗的入场/离场：Electron 没有窗口级动画，用 setOpacity 做 120–160ms 淡入淡出。
 * 透明窗口（悬浮/权限）不走这里，它们在渲染层用 CSS 动画。
 */
function fadeOpacity(win: BrowserWindow, from: number, to: number, ms = 150): Promise<void> {
  return new Promise((resolve) => {
    try {
      win.setOpacity(from);
    } catch {
      resolve();
      return;
    }
    const steps = Math.max(1, Math.round(ms / 16));
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      const value = from + ((to - from) * step) / steps;
      try {
        win.setOpacity(Math.min(1, Math.max(0, value)));
      } catch {
        // 窗口已经没了
      }
      if (step >= steps) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
}

function showWithFade(win: BrowserWindow): void {
  try {
    win.setOpacity(0);
  } catch {
    // 有些环境不支持透明度，直接显示
  }
  win.show();
  win.focus();
  void fadeOpacity(win, 0, 1, 160);
}

function hideWithFade(win: BrowserWindow): void {
  if (!win.isVisible()) return;
  void fadeOpacity(win, win.getOpacity(), 0, 120).then(() => {
    win.hide();
    try {
      win.setOpacity(1);
    } catch {
      // ignore
    }
  });
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
    icon: appIcon(),
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

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) showWithFade(mainWindow);
  });
  mainWindow.on("close", (event) => {
    // 关主窗 = 收进托盘，而不是退出；真的退出走托盘菜单或 app.quit()
    if (!quitting && getConfig().closeToTray) {
      event.preventDefault();
      if (mainWindow) hideWithFade(mainWindow);
    }
  });
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

const OVERLAY_WIDTH = 440;
const OVERLAY_MARGIN = 20;

/**
 * 渲染层量完卡片高度后调这里：窗口贴着实内容走，别留一大片透明区域
 * ——透明区域照样挡住底下的点击。底部锚定，缩放时卡片不会跳。
 */
export function resizeOverlay(height: number): void {
  const win = getOverlayWindow();
  if (!win) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds).workArea;
  const nextHeight = Math.min(560, Math.max(140, Math.round(height)));
  const bottom = bounds.y + bounds.height;
  if (bounds.height === nextHeight && bounds.width === OVERLAY_WIDTH) return;
  win.setBounds({
    x: display.x + display.width - OVERLAY_WIDTH - OVERLAY_MARGIN,
    y: Math.max(display.y, bottom - nextHeight),
    width: OVERLAY_WIDTH,
    height: nextHeight,
  });
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
    if (permissionWindow && !permissionWindow.isDestroyed()) {
      // 留 220ms 给渲染层的退场动画；期间如果又来一条新审批就不藏了
      setTimeout(() => {
        if (pendingApprovals().length === 0 && permissionWindow && !permissionWindow.isDestroyed()) {
          permissionWindow.hide();
        }
      }, 220);
    }
    return;
  }
  const win = ensurePermission();
  win.webContents.send(IPC.changed, { kind: "approvals", at: Date.now() });
  if (!win.isVisible()) win.showInactive();
}

export function focusMain(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) showWithFade(win);
  win.focus();
}

/* ------------------------------------------------------------- 托盘 */

export function isQuitting(): boolean {
  return quitting;
}

export function markQuitting(): void {
  quitting = true;
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Kivora · ${trayStatus}`, enabled: false },
      { type: "separator" },
      { label: "打开主窗", click: () => focusMain() },
      {
        label: "说一句",
        click: () => {
          focusMain();
          mainWindow?.webContents.send(IPC.hotkeyPressed);
        },
      },
      { label: overlayIsVisible() ? "收起悬浮窗" : "显示悬浮窗", click: () => (overlayIsVisible() ? hideOverlay() : showOverlay()) },
      { type: "separator" },
      {
        label: "退出 Kivora",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

export function createTray(): void {
  if (tray) return;
  const image = nativeImage.createFromPath(appIcon());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Kivora · 待命");
  tray.on("double-click", () => focusMain());
  tray.on("click", () => rebuildTrayMenu());
  rebuildTrayMenu();
}

export function updateTrayStatus(status: string): void {
  trayStatus = status;
  if (!tray) return;
  tray.setToolTip(`Kivora · ${status}`);
  rebuildTrayMenu();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

export function broadcastToOverlay(payload: unknown): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(IPC.changed, payload);
  }
}
