import { app, BrowserWindow, globalShortcut } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../src/shared/ipc.ts";
import { closeStore, openStore, pruneOldData, recoverOrphanSessions } from "../src/main/store.ts";
import { dedupeModels, migrateDeepSeekModelIds, migrateLegacyVoiceSeeds, repairTtsVoices, seedModels } from "../src/main/repos/models.ts";
import { initSecrets } from "../src/main/secrets.ts";
import { getConfig, setConfig } from "../src/main/repos/config.ts";
import { initPi } from "../src/main/env.ts";
import {
  createMainWindow,
  createTray,
  destroyTray,
  focusMain,
  getMainWindow,
  getOverlayWindow,
  getPermissionWindow,
  hideOverlay,
  markQuitting,
  refreshPermissionWindow,
  showOverlay,
  updateTrayStatus,
} from "../src/main/windows.ts";
import { markListening, normalizeAccelerator, registerIpc } from "../src/main/ipc.ts";
import { setBroadcastHook } from "../src/main/bus.ts";
import { answerById, expireApprovals } from "../src/main/dispatcher/approval-bus.ts";
import { stopAllPiRuns } from "../src/main/dispatcher/pi-runner.ts";
import { appendMessage, countSessions, listActiveSessions, listSessions } from "../src/main/repos/sessions.ts";
import { formatHotkey } from "../src/shared/text.ts";
import { pendingApprovals } from "../src/main/repos/approvals.ts";
import { seedDemoData } from "../src/main/demo.ts";
import { MCP_PRESETS, saveServer } from "../src/main/mcp.ts";

const isShots = process.argv.includes("--shots") || process.env.KIVORA_SHOTS === "1";
const isFlow = process.argv.includes("--flow") || process.env.KIVORA_FLOW === "1";
const isSmoke = process.argv.includes("--smoke") || process.env.KIVORA_SMOKE === "1" || isShots;

let currentHotkey = "";

// 打包后没有控制台，留一条启动记录方便排查"点了没反应"
function bootLog(message: string): void {
  try {
    const file = path.join(app.getPath("temp"), "kivora-boot.log");
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 日志失败不影响启动
  }
}

bootLog(`boot v${app.getVersion()} packaged=${app.isPackaged} argv=${JSON.stringify(process.argv.slice(1))}`);
let hideTimer: NodeJS.Timeout | null = null;

if (isShots || isFlow || isSmoke) {
  const shotsDir = path.join(app.getPath("temp"), isFlow ? "kivora-flow" : "kivora-shots");
  fs.rmSync(shotsDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  app.setPath("userData", shotsDir);
}

function registerHotkey(accelerator: string): { ok: boolean; hotkey: string } {
  if (currentHotkey) globalShortcut.unregister(currentHotkey);
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send(IPC.hotkeyPressed);
      }
      markListening(true);
      showOverlay();
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        markListening(false);
        hideOverlay();
      }, 5000);
    });
  } catch (err) {
    console.warn("[kivora] hotkey register threw", err);
  }
  currentHotkey = ok ? accelerator : "";
  if (!ok) {
    console.warn(`[kivora] hotkey not registered: ${accelerator}`);
    // 注册失败时回退到默认热键，避免完全叫不醒
    if (accelerator !== "Control+Alt+K") {
      const fallback = registerHotkey("Control+Alt+K");
      if (fallback.ok) setConfig({ hotkey: fallback.hotkey });
    }
  }
  return { ok, hotkey: currentHotkey };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeMotion(
  win: BrowserWindow | null,
  timeoutMs = 1200,
): Promise<{ opacity: string; transform: string } | null> {
  if (!win || win.isDestroyed()) return null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const snapshot = (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector("#root > div"); if (!el) return null; const s = getComputedStyle(el); return { opacity: s.opacity, transform: s.transform }; })()`,
      )) as { opacity: string; transform: string } | null;
      if (snapshot) return snapshot;
    } catch {
      return null;
    }
    await wait(16);
  }
  return null;
}

/** 退场采样：轮询 400ms，记录过渡期间出现过的最低不透明度 */
async function probeExit(
  win: BrowserWindow | null,
  timeoutMs = 420,
  selector = "#root > div",
): Promise<{ minOpacity: number; frames: number } | null> {
  if (!win || win.isDestroyed()) return null;
  let minOpacity = 1;
  let frames = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const snapshot = (await win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return { opacity: Number(getComputedStyle(el).opacity) }; })()`,
      )) as { opacity: number } | null;
      if (snapshot) {
        frames += 1;
        minOpacity = Math.min(minOpacity, snapshot.opacity);
      }
    } catch {
      break;
    }
    await wait(16);
  }
  return { minOpacity: Number(minOpacity.toFixed(2)), frames };
}

async function capture(win: BrowserWindow | null, file: string): Promise<void> {
  if (!win || win.isDestroyed()) {
    console.warn(`[kivora] shot skipped ${file}: no window`);
    return;
  }
  try {
    const image = await win.webContents.capturePage();
    const outDir = path.join(process.cwd(), "artifacts");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, file), image.toPNG());
    console.log(`[kivora] shot ${file}`);
  } catch (err) {
    // 透明窗口在部分显卡驱动上会抛 UnknownVizError，截图失败不该拖住应用
    console.warn(`[kivora] shot failed ${file}:`, err instanceof Error ? err.message : err);
  }
}

async function loadRoute(win: BrowserWindow, route: string): Promise<void> {
  const html = path.join(__dirname, "..", "dist", "index.html");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await win.loadFile(html, route ? { hash: `#${route}` } : undefined);
      return;
    } catch (err) {
      // 上一次 load 还没结束就切路由会得到 ERR_ABORTED(-3)，等一拍重试
      if (attempt === 2) throw err;
      await wait(250);
    }
  }
}

async function runShots(): Promise<void> {
  setConfig({ onboardingDone: true, mockMode: true });
  // 截图用的 pi 配置写到临时目录，别碰用户真实的 ~/.pi
  process.env.KIVORA_PI_HOME = path.join(app.getPath("userData"), "pi-home");
  saveServer(MCP_PRESETS.find((preset) => preset.key === "playwright")!.server);
  seedDemoData();
  const win = createMainWindow();
  await wait(900);

  const invoice = listSessions({ limit: 20 }).find((session) => session.title === "整理发票");
  const routes: Array<[string, string]> = [
    ["", "shot-01-timeline.png"],
    ["/settings", "shot-02-settings.png"],
    ["/settings/models", "shot-03-models.png"],
    [invoice ? `/history/${invoice.id}` : "/history", "shot-04-history.png"],
    ["/onboarding", "shot-05-onboarding.png"],
    ["/settings/extensions", "shot-11-extensions.png"],
  ];
  for (const [route, file] of routes) {
    await loadRoute(win, route);
    await wait(800);
    await capture(win, file);
  }

  // 引导页第 3 步（完成态）：连点两次「下一步」
  await loadRoute(win, "/onboarding");
  await wait(600);
  for (let i = 0; i < 2; i += 1) {
    await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent && x.textContent.trim() === "下一步"); if (b) { b.click(); return true; } return false; })()`,
    );
    await wait(420);
  }
  await capture(win, "shot-12-onboarding-done.png");

  // 拖拽区是否真的落到了 CSS 上（Electron 只认 -webkit-app-region）
  const dragRegion = await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector("[data-drag='1']"); if (!el) return null; const s = getComputedStyle(el); return s.getPropertyValue("-webkit-app-region") || s.webkitAppRegion || null; })()`,
  );
  console.log(`[kivora] drag region=${JSON.stringify(dragRegion)}`);

  // 阅读器的退场：点开再关，采样过渡期间的不透明度
  await loadRoute(win, "");
  await wait(600);
  const readerOpened = await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent && x.textContent.includes("展开全文")); if (b) { b.click(); return true; } return false; })()`,
  );
  await wait(320);
  const readerClosed = await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent && x.textContent.trim() === "关闭"); if (b) { b.click(); return true; } return false; })()`,
  );
  const readerExit = await probeExit(win, 420, "[data-reader]");
  console.log(`[kivora] motion reader exit=${JSON.stringify({ readerOpened, readerClosed, ...readerExit })}`);
  await wait(220);

  // 长文阅读器（点「展开全文」，画板 14）
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.includes('展开全文')); if (b) b.click(); return Boolean(b); })()`,
  );
  await wait(500);
  await capture(win, "shot-08-reader.png");
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '关闭'); if (b) b.click(); return true; })()`,
  );
  await wait(300);

  // 队列面板（点「待处理」，画板 07）
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.includes('待处理')); if (b) b.click(); return Boolean(b); })()`,
  );
  await wait(400);
  await capture(win, "shot-09-queue.png");

  // 模型详情（点 TTS 那一行，画板 13；顺便看音色候选）
  await loadRoute(win, "/settings/models");
  await wait(700);
  await win.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.includes('qwen-audio-3.1-tts-flash')); if (b) b.click(); return Boolean(b); })()`,
  );
  await wait(500);
  await capture(win, "shot-10-model-editor.png");

  await loadRoute(win, "");
  await wait(600);
  markListening(true);
  showOverlay();
  await wait(50);
  const overlayEarly = await probeMotion(getOverlayWindow());
  await wait(360);
  const overlayLate = await probeMotion(getOverlayWindow());
  console.log(`[kivora] motion overlay early=${JSON.stringify(overlayEarly)} late=${JSON.stringify(overlayLate)}`);
  await capture(getOverlayWindow(), "shot-06-overlay.png");
  markListening(false);
  const overlayExit = await probeExit(getOverlayWindow());
  console.log(`[kivora] motion overlay exit=${JSON.stringify(overlayExit)}`);
  await wait(120);

  refreshPermissionWindow();
  await wait(50);
  const permissionEarly = await probeMotion(getPermissionWindow());
  await wait(360);
  const permissionLate = await probeMotion(getPermissionWindow());
  console.log(`[kivora] motion permission early=${JSON.stringify(permissionEarly)} late=${JSON.stringify(permissionLate)}`);
  await capture(getPermissionWindow(), "shot-07-permission.png");
  // 退场：把演示审批拒掉，权限窗应该淡出再隐藏
  const demoApproval = pendingApprovals()[0];
  if (demoApproval) {
    answerById(demoApproval.id, "deny");
    const permissionExit = await probeExit(getPermissionWindow());
    console.log(`[kivora] motion permission exit=${JSON.stringify(permissionExit)}`);
  }

  if (isSmoke) app.quit();
}

app.whenReady().then(async () => {
  app.setAppUserModelId("dev.kivora.app");
  const dataDir = path.join(app.getPath("userData"), "data");
  const info = openStore(dataDir);
  console.log(`[kivora] store ${info.dbPath} schema v${info.schemaVersion}`);

  initPi(app.getAppPath());
  await initSecrets();
  const recovered = recoverOrphanSessions();
  if (recovered) console.warn(`[kivora] marked ${recovered} orphaned sessions as failed`);
  seedModels();
  try {
    migrateLegacyVoiceSeeds();
  } catch (err) {
    console.error("[kivora] voice seed migration failed", err);
  }
  try {
    migrateDeepSeekModelIds();
  } catch (err) {
    console.error("[kivora] deepseek id migration failed", err);
  }
  try {
    repairTtsVoices();
  } catch (err) {
    console.error("[kivora] tts voice repair failed", err);
  }
  try {
    dedupeModels();
  } catch (err) {
    console.error("[kivora] model dedupe failed", err);
  }
  pruneOldData(getConfig().retentionDays);

  if (countSessions() === 0 && !isSmoke) {
    appendMessage({
      role: "assistant",
      content: `我是 Kivora。按 ${formatHotkey(getConfig().hotkey)} 说一句话，我会开独立会话去把事做完。现在跑的是演练模式。`,
    });
  }

  // 无窗口跑一遍调度器（CI / 本地验收用），不创建任何窗口
  if (isFlow) {
    process.env.KIVORA_MOCK_SPEED = process.env.KIVORA_MOCK_SPEED ?? "12";
    try {
      const { runFlow } = await import("../src/main/flow.ts");
      app.exit(await runFlow());
    } catch (err) {
      console.error("[kivora] flow failed", err);
      app.exit(1);
    }
    return;
  }

  // 冒烟：打开主窗截一张图就退出（CI 的"能渲染"闸门）
  if (isSmoke && !isShots) {
    setBroadcastHook((kind) => {
      if (kind === "approvals") refreshPermissionWindow();
    });
    registerIpc({ applyHotkey: (accelerator) => registerHotkey(accelerator) });
    setConfig({ onboardingDone: true, mockMode: true });
    seedDemoData();
    const win = createMainWindow();
    await wait(1400);
    await capture(win, "smoke.png");
    app.exit(0);
    return;
  }

  let trayTimer: NodeJS.Timeout | null = null;
  setBroadcastHook((kind) => {
    if (kind === "approvals") refreshPermissionWindow();
    if (kind === "sessions" || kind === "approvals" || kind === "queue") {
      if (trayTimer) clearTimeout(trayTimer);
      trayTimer = setTimeout(() => {
        const active = listActiveSessions().length;
        const pending = pendingApprovals().length;
        updateTrayStatus(pending ? `${pending} 个待确认` : active ? `${active} 个任务在跑` : "待命");
      }, 400);
    }
  });

  registerIpc({
    applyHotkey: (accelerator) => {
      const result = registerHotkey(accelerator);
      return result;
    },
  });

  const hotkey = normalizeAccelerator(getConfig().hotkey);
  app.setLoginItemSettings({ openAtLogin: getConfig().launchAtLogin });
  registerHotkey(hotkey);
  createMainWindow();
  createTray();

  if (getConfig().onboardingDone) showOverlay();

  setInterval(() => {
    const expired = expireApprovals();
    if (expired.length) {
      console.log(`[kivora] ${expired.length} approvals expired (default deny)`);
      refreshPermissionWindow();
    }
  }, 3000);

  if (isShots) {
    try {
      await runShots();
    } catch (err) {
      console.error("[kivora] shots failed", err);
    } finally {
      app.exit(0);
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMain());
}

app.on("window-all-closed", () => {
  // 常驻模式：主窗只是收进托盘，不退出
  if (process.platform !== "darwin" && !getConfig().closeToTray) app.quit();
});

app.on("before-quit", () => {
  markQuitting();
});

app.on("will-quit", () => {
  stopAllPiRuns();
  globalShortcut.unregisterAll();
  destroyTray();
  closeStore();
});
