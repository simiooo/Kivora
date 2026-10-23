import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { buildFinish, buildTtsContinue, buildTtsStart, synthesizeViaWebSocket, transcribeViaWebSocket } from "./dashscope-ws.ts";

interface TestServer {
  url: string;
  close: () => Promise<void>;
  received: Array<Record<string, unknown>>;
  auth: string | undefined;
}

function startServer(onMessage: (socket: WebSocket, message: Record<string, unknown>, binary: boolean) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    const received: Array<Record<string, unknown>> = [];
    let auth: string | undefined;
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        get auth() {
          return auth;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.on("connection", (socket, request) => {
      auth = request.headers.authorization;
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          onMessage(socket, {}, true);
          return;
        }
        try {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          received.push(message);
          onMessage(socket, message, false);
        } catch {
          // ignore
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

describe("DashScope WebSocket 协议", () => {
  it("TTS：run-task → task-started → continue-task → finish-task → 音频", async () => {
    active = await startServer((socket, message) => {
      const header = message.header as { action?: string } | undefined;
      if (header?.action === "run-task") {
        socket.send(JSON.stringify({ header: { event: "task-started" } }));
        return;
      }
      if (header?.action === "continue-task") {
        socket.send(Buffer.from([1, 2, 3, 4]));
        return;
      }
      if (header?.action === "finish-task") {
        socket.send(JSON.stringify({ header: { event: "task-finished" } }));
      }
    });

    const result = await synthesizeViaWebSocket({
      url: active.url,
      apiKey: "test-key",
      model: "qwen-audio-3.1-tts-flash",
      text: "你好",
      voice: "longanhuan_v3.1",
    });

    expect(result.mime).toBe("audio/mpeg");
    expect([...result.audio]).toEqual([1, 2, 3, 4]);
    expect(active.auth).toBe("Bearer test-key");
    const actions = active.received.map((message) => (message.header as { action: string }).action);
    expect(actions).toEqual(["run-task", "continue-task", "finish-task"]);
    const start = active.received[0] as unknown as {
      payload: { model: string; parameters: { voice: string; format: string } };
    };
    expect(start.payload.model).toBe("qwen-audio-3.1-tts-flash");
    expect(start.payload.parameters.voice).toBe("longanhuan_v3.1");
    expect(start.payload.parameters.format).toBe("mp3");
  });

  it("ASR：二进制音频 + finish-task → result-generated 拼句子", async () => {
    let audioFrames = 0;
    active = await startServer((socket, message, binary) => {
      if (binary) {
        audioFrames += 1;
        return;
      }
      const header = message.header as { action?: string } | undefined;
      if (header?.action === "run-task") {
        socket.send(JSON.stringify({ header: { event: "task-started" } }));
        return;
      }
      if (header?.action === "finish-task") {
        socket.send(
          JSON.stringify({
            header: { event: "result-generated" },
            payload: { output: { sentence: { text: "把下载目录里的" } } },
          }),
        );
        socket.send(
          JSON.stringify({
            header: { event: "result-generated" },
            payload: { output: { sentence: { text: "pdf 挪过去" }, finished: true } },
          }),
        );
      }
    });

    const wav = new Uint8Array(20_000);
    const result = await transcribeViaWebSocket({
      url: active.url,
      apiKey: "k",
      model: "qwen-audio-3.1-asr-flash-message",
      audio: wav,
    });

    expect(result.text).toBe("把下载目录里的pdf 挪过去");
    expect(audioFrames).toBeGreaterThanOrEqual(2);
    const start = active.received[0] as unknown as { payload: { task: string; parameters: { format: string } } };
    expect(start.payload.task).toBe("asr");
    expect(start.payload.parameters.format).toBe("wav");
  });

  it("task-failed 会把错误带回来", async () => {
    active = await startServer((socket, message) => {
      const header = message.header as { action?: string } | undefined;
      if (header?.action === "run-task") {
        socket.send(
          JSON.stringify({
            header: { event: "task-failed", error_message: "Invalid API-key provided." },
          }),
        );
      }
    });

    await expect(
      synthesizeViaWebSocket({ url: active.url, apiKey: "bad", model: "m", text: "hi" }),
    ).rejects.toThrow(/Invalid API-key/);
  });

  it("握手 401 映射成 auth_failed，而不是「连不上」", async () => {
    const http = createServer();
    http.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 11\r\nConnection: close\r\n\r\nbad api key",
      );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
    const port = (http.address() as AddressInfo).port;
    await expect(
      synthesizeViaWebSocket({ url: `ws://127.0.0.1:${port}`, apiKey: "bad", model: "m", text: "hi" }),
    ).rejects.toMatchObject({ code: "auth_failed" });
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it("音色不属于模型（InvalidParameter / 411）翻译成人话", async () => {
    active = await startServer((socket, message) => {
      const header = message.header as { action?: string } | undefined;
      if (header?.action === "run-task") {
        socket.send(
          JSON.stringify({
            header: {
              event: "task-failed",
              error_code: "InvalidParameter",
              error_message: "[cosyvoice]Engine error [411]: TTS speak operation failed",
            },
          }),
        );
      }
    });

    await expect(
      synthesizeViaWebSocket({
        url: active.url,
        apiKey: "k",
        model: "qwen-audio-3.1-tts-flash",
        text: "好",
        voice: "Cherry",
      }),
    ).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("Cherry") as unknown as string });
  });

  it("语速映射到 rate，且被夹到 0.5–2", async () => {
    active = await startServer((socket, message) => {
      const header = message.header as { action?: string } | undefined;
      if (header?.action === "run-task") socket.send(JSON.stringify({ header: { event: "task-started" } }));
      else if (header?.action === "continue-task") socket.send(Buffer.from([1]));
      else if (header?.action === "finish-task") socket.send(JSON.stringify({ header: { event: "task-finished" } }));
    });

    await synthesizeViaWebSocket({ url: active.url, apiKey: "k", model: "m", text: "hi", speed: 9 });
    const start = active.received[0] as unknown as { payload: { parameters: { rate: number } } };
    expect(start.payload.parameters.rate).toBe(2);
  });

  it("消息构造带上 task_id 与 duplex", () => {
    const start = buildTtsStart("abc", "m", "v", "mp3", 24_000);
    expect(start.header).toEqual({ action: "run-task", task_id: "abc", streaming: "duplex" });
    const cont = buildTtsContinue("abc", "m", "hi");
    expect(cont.payload.input).toEqual({ text: "hi" });
    const finish = buildFinish("abc");
    expect(finish.header.action).toBe("finish-task");
  });
});
