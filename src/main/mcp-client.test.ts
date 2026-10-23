import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeMcpServer } from "./mcp-client.ts";

let dir = "";
let serverScript = "";

const FAKE_SERVER = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "fake-mcp", version: "1.0.0" },
    }});
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "browser_click", description: "click an element" },
      { name: "browser_read", description: "read the page" },
    ]}});
  }
});
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kivora-mcp-probe-"));
  serverScript = path.join(dir, "fake-mcp.js");
  fs.writeFileSync(serverScript, FAKE_SERVER, "utf8");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP 连接测试", () => {
  it("握手成功时返回工具列表", async () => {
    const result = await probeMcpServer({
      name: "fake",
      command: process.execPath,
      args: [serverScript],
      env: {},
      enabled: true,
    });
    expect(result.ok).toBe(true);
    expect(result.serverName).toBe("fake-mcp");
    expect(result.tools.map((tool) => tool.name)).toEqual(["browser_click", "browser_read"]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("命令不存在时给出可读错误", async () => {
    const result = await probeMcpServer({
      name: "missing",
      command: "definitely-not-a-real-command-xyz",
      args: [],
      env: {},
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unreachable");
  }, 30_000);

  it("服务器启动就退出时报告退出码", async () => {
    const crashing = path.join(dir, "crash.js");
    fs.writeFileSync(crashing, "process.exit(3);", "utf8");
    const result = await probeMcpServer({
      name: "crash",
      command: process.execPath,
      args: [crashing],
      env: {},
      enabled: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("退出");
  }, 30_000);

  it("没有启动命令直接拒绝", async () => {
    const result = await probeMcpServer({ name: "empty", command: "  ", args: [], env: {}, enabled: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_input");
  });
});
