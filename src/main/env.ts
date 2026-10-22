import { exec } from "node:child_process";

/**
 * 启动时探一次 Pi CLI 在不在：在的话日后可以把任务会话直接交给
 * `pi --mode rpc` 跑（5.1）；不在就用内置执行器，并让设置页如实显示。
 */

let piVersion: string | null = null;
let checked = false;

export function detectPi(): Promise<void> {
  if (checked) return Promise.resolve();
  checked = true;
  return new Promise((resolve) => {
    exec("pi --version", { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        piVersion = null;
      } else {
        const match = stdout.trim().match(/\d+\.\d+\.\d+/);
        piVersion = match ? match[0] : stdout.trim().slice(0, 20) || null;
      }
      console.log(`[kivora] pi ${piVersion ?? "not found"}`);
      resolve();
    });
  });
}

export function getPiVersion(): string | null {
  return piVersion;
}

export function piAvailable(): boolean {
  return piVersion !== null;
}

export function nodeVersion(): string {
  return process.versions.node;
}

export function electronVersion(): string {
  return process.versions.electron ?? "";
}
