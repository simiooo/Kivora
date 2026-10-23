import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppError } from "../shared/errors.ts";
import { getPiVersion, piAvailable } from "./env.ts";
import type { McpCapability, McpPreset, McpServerInput, McpServerView } from "../shared/domain.ts";

/**
 * CUA / 浏览器这类能力不自己造：Pi 自带 MCP 扩展（1.4.0+），
 * 它读 `~/.pi/agent/mcp.json`（用户级）和 `.pi/mcp.json`（项目级）。
 *
 * Kivora 只负责：把用户在设置里配的服务器写进用户级文件里，
 * 并且只碰 `kivora-` 开头的条目，用户自己配的服务器原样保留。
 */

const PREFIX = "kivora-";

interface McpFileShape {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function piHome(): string {
  return process.env.KIVORA_PI_HOME || path.join(os.homedir(), ".pi");
}

export function mcpFilePath(): string {
  return path.join(piHome(), "agent", "mcp.json");
}

function readFile(): McpFileShape {
  const file = mcpFilePath();
  if (!fs.existsSync(file)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as McpFileShape;
    if (!parsed || typeof parsed !== "object") return { mcpServers: {} };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") parsed.mcpServers = {};
    return parsed;
  } catch (err) {
    throw new AppError("storage_failed", {
      message: "读不了 Pi 的 MCP 配置，可能是 JSON 坏了。",
      detail: err instanceof Error ? err.message : String(err),
      retryable: false,
    });
  }
}

function writeFile(data: McpFileShape): void {
  const file = mcpFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeName(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!cleaned) throw new AppError("invalid_input", { message: "服务器名字不能为空。" });
  return cleaned.startsWith(PREFIX) ? cleaned : `${PREFIX}${cleaned}`;
}

function toInput(name: string, raw: Record<string, unknown>): McpServerInput {
  return {
    name,
    command: typeof raw.command === "string" ? raw.command : "",
    args: Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : [],
    env: raw.env && typeof raw.env === "object" ? (raw.env as Record<string, string>) : {},
    enabled: raw.enabled !== false,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

export function listServers(): McpServerView[] {
  const data = readFile();
  const servers = data.mcpServers ?? {};
  return Object.entries(servers)
    .map(([name, raw]) => ({
      ...toInput(name, raw as Record<string, unknown>),
      managed: name.startsWith(PREFIX),
      available: null,
    }))
    .sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name));
}

export function saveServer(input: McpServerInput, rawName?: string): McpServerView[] {
  const name = normalizeName(input.name);
  if (!input.command.trim()) {
    throw new AppError("invalid_input", { message: "得给它一个启动命令（比如 npx）。" });
  }
  if (input.args.length > 20) {
    throw new AppError("invalid_input", { message: "参数太多了。" });
  }
  const data = readFile();
  data.mcpServers = data.mcpServers ?? {};

  // 改名：旧条目先摘掉
  if (rawName && rawName !== name && rawName.startsWith(PREFIX)) {
    delete data.mcpServers[rawName];
  }

  data.mcpServers[name] = {
    command: input.command.trim(),
    args: input.args,
    ...(Object.keys(input.env).length > 0 ? { env: input.env } : {}),
    ...(input.enabled === false ? { enabled: false } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
  writeFile(data);
  return listServers();
}

export function removeServer(name: string): McpServerView[] {
  if (!name.startsWith(PREFIX)) {
    throw new AppError("conflict", {
      message: "这条不是 Kivora 写的，去 ~/.pi/agent/mcp.json 手动改。",
    });
  }
  const data = readFile();
  if (data.mcpServers?.[name]) {
    delete data.mcpServers[name];
    writeFile(data);
  }
  return listServers();
}

/** MCP 是 pi 1.4.0 起内置的；Kivora 随包带的就是 1.4.0，所以正常always true */
export function mcpCapability(): McpCapability {
  const version = getPiVersion();
  const file = mcpFilePath();
  if (!piAvailable()) {
    return {
      pi: null,
      available: false,
      reason: "内置 pi 缺失，MCP 不可用。重装 Kivora 或设置 KIVORA_PI_BIN。",
      file,
    };
  }
  const numeric = (version ?? "0.0.0").split(".").map((part) => Number(part) || 0);
  const atLeast = numeric[0] > 1 || (numeric[0] === 1 && (numeric[1] ?? 0) >= 4);
  return {
    pi: version,
    available: atLeast,
    reason: atLeast
      ? `内置 pi ${version ?? ""} 自带 MCP，配好的服务器会在任务会话里自动加载。`
      : `内置 pi ${version ?? ""} 太旧，没有 MCP。`,
    file,
  };
}

export function managedServerCount(): number {
  return listServers().filter((server) => server.managed && server.enabled).length;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    key: "cua",
    label: "桌面控制（cua-driver）",
    hint: "启动 / 点击 / 输入 / 读状态；bounded 模式把动作限制在清单里。",
    server: {
      name: "cua",
      command: "cua-driver",
      args: ["mcp"],
      env: { CUA_DRIVER_PERMISSION_MODE: "bounded" },
      enabled: true,
      description: "Control the Windows desktop: windows, clicks, typing, screenshots.",
    },
  },
  {
    key: "playwright",
    label: "浏览器（Playwright MCP）",
    hint: "官方 MCP 服务器，走 Chromium；搜索、点链接、读页面。",
    server: {
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: {},
      enabled: true,
      description: "Drive a real browser: navigate, click, type, read pages.",
    },
  },
];
