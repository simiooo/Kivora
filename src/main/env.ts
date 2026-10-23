import fs from "node:fs";
import path from "node:path";

/**
 * Pi 随应用发布：`@earendil-works/pi-coding-agent` 装在自己的依赖里，
 * 不依赖用户机器上的全局 pi。这样版本、MCP 支持、RPC 协议都是确定的。
 *
 * KIVORA_PI_BIN 只是给测试/特殊环境留的覆盖口子。
 */

let piVersion: string | null = null;
let piCli: string | null = null;
let appRoot = "";

function bundledPackageJson(root: string): string {
  return path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
}

export function bundledPiCli(root: string): string {
  return path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
}

/** 主进程启动时调一次：读随包发布的 pi 版本，顺便确认 CLI 在不在 */
export function initPi(root: string): void {
  appRoot = root;
  try {
    const pkg = JSON.parse(fs.readFileSync(bundledPackageJson(root), "utf8")) as { version?: string };
    piVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    piVersion = null;
  }
  const cli = bundledPiCli(root);
  piCli = fs.existsSync(cli) ? cli : null;
  if (process.env.KIVORA_PI_BIN) {
    console.log(`[kivora] pi override ${process.env.KIVORA_PI_BIN}`);
  } else {
    console.log(`[kivora] pi bundled ${piVersion ?? "missing"} cli=${piCli ? "ok" : "missing"}`);
  }
}

export function getPiVersion(): string | null {
  return piVersion;
}

/** 要执行的 CLI 路径：测试覆盖优先，否则用内置的 */
export function piCliPath(): string | null {
  if (process.env.KIVORA_PI_BIN) return process.env.KIVORA_PI_BIN;
  if (piCli) return piCli;
  return piVersion ? bundledPiCli(appRoot) : null;
}

/** .cmd 之类的覆盖入口需要 shell 才能起 */
export function piUsesShell(): boolean {
  const bin = process.env.KIVORA_PI_BIN;
  return Boolean(bin && /\.(cmd|bat)$/i.test(bin));
}

export function piAvailable(): boolean {
  return Boolean(process.env.KIVORA_PI_BIN) || piCli !== null;
}

/* ------------------------------------------------------------ 演练模式 */

/**
 * 演练模式（mock）不是产品功能，是开发自检用的开关：
 *   KIVORA_MOCK=1 pnpm dev
 * 打开后转写返回内置句子、合成返回提示音、任务按脚本走、测试连接只做本地模拟。
 *
 * 它**不进配置、不进 IPC、不进 UI** —— 用户既看不到也切不了，
 * 正式安装包里没有环境变量就是纯真实链路。
 */
let selfCheckMock: boolean | null = null;

function envMock(): boolean {
  const raw = process.env.KIVORA_MOCK?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function mockMode(): boolean {
  return selfCheckMock ?? envMock();
}

/** 只给 `--flow` 这类进程内自检用；应用层（IPC / 渲染层）碰不到这个函数。传 null 恢复读环境变量 */
export function setMockModeForSelfCheck(value: boolean | null): void {
  selfCheckMock = value;
}

export function logMockMode(): void {
  if (mockMode()) console.log("[kivora] mock mode (KIVORA_MOCK) — 不发真实请求");
}
