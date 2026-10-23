import { spawn } from "node:child_process";
import type { McpServerInput } from "../shared/domain.ts";
import { AppError } from "../shared/errors.ts";

/**
 * 最小的 MCP stdio 客户端：只做一件事——把服务器拉起来，
 * 完成 initialize / tools/list，回答"这个服务器到底能不能用、有几个工具"。
 *
 * 不做工具调用（那由 pi 在任务会话里做），所以这里没有长期连接。
 */

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpProbeResult {
  ok: boolean;
  serverName: string;
  serverVersion: string;
  tools: McpToolInfo[];
  latencyMs: number;
  error: { code: string; message: string; detail: string | null } | null;
}

const PROTOCOL_VERSION = "2024-11-05";
const HANDSHAKE_TIMEOUT_MS = 20_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function probeMcpServer(server: McpServerInput): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const fail = (code: string, message: string, detail: string | null = null): McpProbeResult => ({
    ok: false,
    serverName: server.name,
    serverVersion: "",
    tools: [],
    latencyMs: Date.now() - startedAt,
    error: { code, message, detail },
  });

  if (!server.command.trim()) return fail("invalid_input", "这条服务器没有启动命令。");

  let child;
  try {
    child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return fail("unreachable", "启动不了这个服务器。", toErrorMessage(err));
  }

  const pending = new Map<number, Pending>();
  let seq = 0;
  let buffer = "";
  let stderr = "";
  let settled = false;

  const cleanup = (): void => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("连接已关闭"));
    }
    pending.clear();
    try {
      child?.stdin?.end();
    } catch {
      // ignore
    }
    try {
      child?.kill();
    } catch {
      // ignore
    }
  };

  return await new Promise<McpProbeResult>((resolve) => {
    const finish = (result: McpProbeResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(fail("timeout", "服务器 20 秒内没有完成握手。", stderr.slice(-800) || null));
    }, HANDSHAKE_TIMEOUT_MS);

    const send = (payload: Record<string, unknown>): void => {
      try {
        child?.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // 进程已经没了，下面的 close 会收尾
      }
    };

    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = ++seq;
      return new Promise((res, rej) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} 超时`));
        }, HANDSHAKE_TIMEOUT_MS);
        pending.set(id, { resolve: res, reject: rej, timer: timeout });
        send({ jsonrpc: "2.0", id, method, params });
      });
    };

    const onMessage = (raw: string): void => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = typeof message.id === "number" ? message.id : null;
      if (id === null) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const error = message.error as { message?: string; code?: number };
        waiter.reject(new Error(error.message ?? `JSON-RPC ${error.code ?? "error"}`));
      } else {
        waiter.resolve(message.result);
      }
    };

    child?.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "").trim();
        buffer = buffer.slice(index + 1);
        if (line) onMessage(line);
        index = buffer.indexOf("\n");
      }
    });

    child?.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child?.on("error", (err) => {
      clearTimeout(timer);
      finish(fail("unreachable", "启动不了这个服务器。", toErrorMessage(err)));
    });

    child?.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      finish(
        fail(
          "unreachable",
          `服务器提前退出（exit ${code ?? "?"}）。`,
          stderr.trim().split("\n").slice(-5).join("\n") || null,
        ),
      );
    });

    void (async () => {
      try {
        const init = (await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "kivora", version: "0.1.0" },
        })) as { serverInfo?: { name?: string; version?: string } };

        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

        const listed = (await request("tools/list", {})) as {
          tools?: Array<{ name?: string; description?: string }>;
        };
        const tools = (listed.tools ?? []).map((tool) => ({
          name: String(tool.name ?? ""),
          description: String(tool.description ?? ""),
        }));

        clearTimeout(timer);
        finish({
          ok: true,
          serverName: init.serverInfo?.name ?? server.name,
          serverVersion: init.serverInfo?.version ?? "",
          tools,
          latencyMs: Date.now() - startedAt,
          error: null,
        });
      } catch (err) {
        clearTimeout(timer);
        finish(fail("bad_response", "握手失败。", `${toErrorMessage(err)}${stderr ? `\n${stderr.slice(-600)}` : ""}`));
      }
    })();
  });
}

export function assertProbeable(server: McpServerInput | undefined): McpServerInput {
  if (!server) throw new AppError("not_found", { message: "这个服务器不在配置里。" });
  return server;
}
