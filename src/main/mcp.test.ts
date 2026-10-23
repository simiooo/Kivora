import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listServers, mcpCapability, mcpFilePath, MCP_PRESETS, removeServer, saveServer } from "./mcp.ts";

let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kivora-mcp-"));
  process.env.KIVORA_PI_HOME = home;
});

afterEach(() => {
  delete process.env.KIVORA_PI_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(servers: Record<string, unknown>): void {
  const file = mcpFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("MCP 配置", () => {
  it("默认写到 ~/.pi/agent/mcp.json（这里用 KIVORA_PI_HOME 指走）", () => {
    expect(mcpFilePath()).toBe(path.join(home, "agent", "mcp.json"));
  });

  it("加服务器时自动加 kivora- 前缀", () => {
    saveServer({ name: "playwright", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {}, enabled: true });
    const list = listServers();
    expect(list.map((server) => server.name)).toEqual(["kivora-playwright"]);
    expect(list[0].managed).toBe(true);
  });

  it("不动用户自己配的服务器", () => {
    writeConfig({ mine: { command: "uvx", args: ["my-mcp"] } });
    saveServer({ name: "cua", command: "cua-driver", args: ["mcp"], env: {}, enabled: true });
    const file = JSON.parse(fs.readFileSync(mcpFilePath(), "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(file.mcpServers.mine.command).toBe("uvx");
    expect(file.mcpServers["kivora-cua"].command).toBe("cua-driver");
  });

  it("停用写成 enabled:false，而不是删掉", () => {
    saveServer({ name: "cua", command: "cua-driver", args: ["mcp"], env: {}, enabled: false });
    const file = JSON.parse(fs.readFileSync(mcpFilePath(), "utf8")) as {
      mcpServers: Record<string, { enabled?: boolean }>;
    };
    expect(file.mcpServers["kivora-cua"].enabled).toBe(false);
    expect(listServers()[0].enabled).toBe(false);
  });

  it("改名会摘掉旧条目", () => {
    saveServer({ name: "cua", command: "cua-driver", args: [], env: {}, enabled: true });
    saveServer({ name: "cua2", command: "cua-driver", args: [], env: {}, enabled: true }, "kivora-cua");
    expect(listServers().map((server) => server.name)).toEqual(["kivora-cua2"]);
  });

  it("删不掉别人写的条目", () => {
    writeConfig({ mine: { command: "uvx", args: [] } });
    expect(() => removeServer("mine")).toThrowError(/不是 Kivora 写的/);
  });

  it("删自己的条目", () => {
    saveServer({ name: "cua", command: "cua-driver", args: [], env: {}, enabled: true });
    expect(removeServer("kivora-cua")).toEqual([]);
  });

  it("缺 command 直接拒绝", () => {
    expect(() =>
      saveServer({ name: "x", command: "   ", args: [], env: {}, enabled: true }),
    ).toThrowError(/启动命令/);
  });

  it("预设覆盖 CUA 与浏览器", () => {
    expect(MCP_PRESETS.map((preset) => preset.key)).toEqual(["cua", "playwright"]);
    expect(MCP_PRESETS[0].server.env.CUA_DRIVER_PERMISSION_MODE).toBe("bounded");
  });
});

describe("MCP 能力判断", () => {
  it("没有内置 pi 时不假装支持", () => {
    const capability = mcpCapability();
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain("pi");
  });
});
