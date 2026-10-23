import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { PcmTtsSession } from "./dashscope-tts-stream.ts";

interface TestServer {
  url: string;
  close: () => Promise<void>;
  actions: string[];
}

function startServer(onText: (socket: WebSocket) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    const actions: string[] = [];
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        actions,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString()) as { header?: { action?: string } };
        const action = message.header?.action ?? "";
        actions.push(action);
        if (action === "run-task") {
          socket.send(JSON.stringify({ header: { event: "task-started" } }));
        }
        if (action === "continue-task") {
          // 两帧 PCM，模拟"边合成边吐"
          socket.send(Buffer.from([1, 2, 3, 4]));
          socket.send(Buffer.from([5, 6]));
        }
        if (action === "finish-task") {
          onText(socket);
          socket.send(JSON.stringify({ header: { event: "task-finished" } }));
        }
      });
    });
  });
}

let active: TestServer | null = null;

afterEach(async () => {
  await active?.close();
  active = null;
});

describe("流式合成", () => {
  it("文本发完前就能收到 PCM，最后才 done", async () => {
    active = await startServer(() => undefined);
    const chunks: number[][] = [];
    let done = false;
    const session = await PcmTtsSession.open(
      { url: active.url, apiKey: "k", model: "qwen-audio-3.1-tts-flash", voice: "longanhuan_v3.1" },
      { onChunk: (pcm) => chunks.push([...pcm]), onDone: () => (done = true), onError: () => undefined },
    );
    session.push("第一句。");
    session.push("第二句。");
    session.finish();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toEqual([1, 2, 3, 4]);
    expect(done).toBe(true);
    expect(active.actions).toEqual(["run-task", "continue-task", "continue-task", "finish-task"]);
  });

  it("run-task 里带 pcm 格式和采样率", async () => {
    let payload: Record<string, unknown> | null = null;
    active = await new Promise((resolve) => {
      const server = new WebSocketServer({ port: 0 });
      server.on("listening", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ url: `ws://127.0.0.1:${port}`, actions: [], close: () => new Promise((done) => server.close(() => done())) });
      });
      server.on("connection", (socket) => {
        socket.on("message", (data, isBinary) => {
          if (isBinary) return;
          const message = JSON.parse(data.toString()) as { header?: { action?: string }; payload?: Record<string, unknown> };
          if (message.header?.action === "run-task") {
            payload = message.payload ?? null;
            socket.send(JSON.stringify({ header: { event: "task-started" } }));
          }
        });
      });
    });
    const session = await PcmTtsSession.open(
      { url: (active as TestServer).url, apiKey: "k", model: "m", sampleRate: 16_000 },
      { onChunk: () => undefined, onDone: () => undefined, onError: () => undefined },
    );
    const parameters = (payload as { parameters?: { format?: string; sample_rate?: number } } | null)?.parameters;
    expect(parameters?.format).toBe("pcm");
    expect(parameters?.sample_rate).toBe(16_000);
    session.cancel();
  });

  it("task-failed 会报错，不会假装播完", async () => {
    active = await new Promise((resolve) => {
      const server = new WebSocketServer({ port: 0 });
      server.on("listening", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ url: `ws://127.0.0.1:${port}`, actions: [], close: () => new Promise((done) => server.close(() => done())) });
      });
      server.on("connection", (socket) => {
        socket.on("message", () => {
          socket.send(JSON.stringify({ header: { event: "task-failed", error_message: "[411] bad voice" } }));
        });
      });
    });
    const errors: string[] = [];
    await expect(
      PcmTtsSession.open(
        { url: (active as TestServer).url, apiKey: "k", model: "m" },
        { onChunk: () => undefined, onDone: () => undefined, onError: (err) => errors.push(err.message) },
      ),
    ).rejects.toMatchObject({ code: "upstream_error" });
    expect(errors[0]).toContain("411");
  });
});
