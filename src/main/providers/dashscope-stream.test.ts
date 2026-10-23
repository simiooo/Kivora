import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { AsrStream, isStreamingAsrModel } from "./dashscope-stream.ts";

interface TestServer {
  url: string;
  close: () => Promise<void>;
  received: Array<Record<string, unknown>>;
  audio: number[];
}

function startServer(onMessage: (socket: WebSocket, message: Record<string, unknown>) => void): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    const received: Array<Record<string, unknown>> = [];
    const audio: number[] = [];
    server.on("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        audio,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
    server.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          audio.push(Buffer.from(data as Buffer).length);
          return;
        }
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(message);
        onMessage(socket, message);
      });
    });
  });
}

let active: TestServer | null = null;

afterEach(async () => {
  await active?.close();
  active = null;
});

describe("流式识别", () => {
  it("中间结果会更新，句末结果定稿后拼起来", async () => {
    active = await startServer((socket, message) => {
      const action = (message.header as { action?: string }).action;
      if (action === "run-task") {
        socket.send(JSON.stringify({ header: { event: "task-started" } }));
        return;
      }
      if (action === "finish-task") {
        socket.send(
          JSON.stringify({
            header: { event: "result-generated" },
            payload: { output: { sentence: { sentence_id: 1, text: "把下载目录里的", sentence_end: false } } },
          }),
        );
        socket.send(
          JSON.stringify({
            header: { event: "result-generated" },
            payload: { output: { sentence: { sentence_id: 1, text: "把下载目录里的 pdf 挪过去", sentence_end: true } } },
          }),
        );
        socket.send(
          JSON.stringify({
            header: { event: "result-generated" },
            payload: { output: { sentence: { sentence_id: 2, text: "可以吗", sentence_end: true } } },
          }),
        );
        socket.send(JSON.stringify({ header: { event: "task-finished" } }));
      }
    });

    const partials: string[] = [];
    const stream = await AsrStream.start({
      url: active.url,
      apiKey: "k",
      model: "qwen-audio-3.1-asr-flash-streaming",
      onPartial: (text) => partials.push(text),
    });
    stream.push(new Uint8Array(6400));
    stream.push(new Uint8Array(6400));
    const { text } = await stream.finish();

    expect(text).toBe("把下载目录里的 pdf 挪过去可以吗");
    expect(active.audio.every((bytes) => bytes === 6400)).toBe(true);
    const start = active.received[0] as unknown as {
      payload: { model: string; parameters: { format: string; sample_rate: number } };
    };
    expect(start.payload.model).toBe("qwen-audio-3.1-asr-flash-streaming");
    expect(start.payload.parameters.format).toBe("pcm");
    expect(start.payload.parameters.sample_rate).toBe(16000);
    // 中间结果出现过，最终结果覆盖了同一句
    expect(partials.some((item) => item.includes("把下载目录里的"))).toBe(true);
  });

  it("task-failed 会把原因带回来", async () => {
    active = await startServer((socket, message) => {
      const action = (message.header as { action?: string }).action;
      if (action === "run-task") {
        socket.send(JSON.stringify({ header: { event: "task-failed", error_message: "quota exceeded" } }));
      }
    });

    await expect(AsrStream.start({ url: active.url, apiKey: "k", model: "m-streaming" })).rejects.toMatchObject({
      code: "upstream_error",
    });
  });

  it("能认出哪些模型是流式的", () => {
    expect(isStreamingAsrModel("qwen-audio-3.1-asr-flash-streaming")).toBe(true);
    expect(isStreamingAsrModel("qwen-audio-3.1-realtime-plus")).toBe(true);
    expect(isStreamingAsrModel("qwen-audio-3.1-asr-flash-message")).toBe(false);
  });
});
