import { exec } from "node:child_process";

/**
 * 启动时探一次 Pi CLI：版本、以及有没有 MCP 扩展（--help 里有 `mcp` 命令）。
 * 探测结果只用于 UI 展示与能力判断，不阻断启动。
 */

let piVersion: string | null = null;
let piHelp: string | null = null;
let checked = false;

function run(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(command, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(String(stdout));
    });
  });
}

export async function detectPi(): Promise<void> {
  if (checked) return;
  checked = true;
  const bin = process.env.KIVORA_PI_BIN || "pi";
  const versionOut = await run(`"${bin}" --version`);
  if (versionOut) {
    const match = versionOut.trim().match(/\d+\.\d+\.\d+/);
    piVersion = match ? match[0] : versionOut.trim().slice(0, 20) || null;
  }
  if (piVersion) {
    piHelp = await run(`"${bin}" --help`);
  }
  console.log(`[kivora] pi ${piVersion ?? "not found"} mcp=${piHelp ? /^\s+mcp\b/m.test(piHelp) : "?"}`);
}

export function getPiVersion(): string | null {
  return piVersion;
}

export function getPiHelp(): string | null {
  return piHelp;
}

export function piAvailable(): boolean {
  // KIVORA_PI_BIN 是给测试/自定义安装路径留的口子
  return Boolean(process.env.KIVORA_PI_BIN) || piVersion !== null;
}

export function nodeVersion(): string {
  return process.versions.node;
}

export function electronVersion(): string {
  return process.versions.electron ?? "";
}
