import type WebSocket from "ws";
import { AppError } from "../../shared/errors.ts";
import { connectWs, handshakeError } from "./dashscope-ws.ts";

/**
 * 流式合成（边合成边播）：TTS 的音频一帧一帧回来，不等整段。
 *
 * 和批式的区别只在"什么时候把音频交出去"：
 *   run-task（format=pcm）→ 收到 task-started → 逐段 continue-task 发文本
 *   → 二进制 PCM 一回来就交给播放器 → 文本发完 finish-task
 *
 * 选 pcm 而不是 mp3：mp3 的帧边界不好切，边播边拼容易出爆音；
 * pcm 只要知道采样率就能直接塞进 AudioBuffer 排队播放。
 */

export interface PcmTtsOptions {
  url: string;
  apiKey: string;
  model: string;
  voice?: string | null;
  sampleRate?: number;
  speed?: number | null;
  timeoutMs?: number;
}

export interface PcmTtsHandlers {
  onChunk: (pcm: Uint8Array) => void;
  onDone: () => void;
  onError: (error: AppError) => void;
}

const DEFAULT_SAMPLE_RATE = 24_000;

export class PcmTtsSession {
  private readonly socket: WebSocket;
  private readonly close: () => void;
  private readonly taskId: string;
  private readonly handlers: PcmTtsHandlers;
  private started = false;
  private finished = false;

  private constructor(socket: WebSocket, close: () => void, taskId: string, handlers: PcmTtsHandlers) {
    this.socket = socket;
    this.close = close;
    this.taskId = taskId;
    this.handlers = handlers;
  }

  static async open(options: PcmTtsOptions, handlers: PcmTtsHandlers): Promise<PcmTtsSession> {
    const taskId = randomTaskId();
    const { socket, close } = await connectWs(options.url, options.apiKey, options.timeoutMs ?? 15_000);
    const session = new PcmTtsSession(socket, close, taskId, handlers);
    await session.start(options);
    return session;
  }

  private start(options: PcmTtsOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new AppError("timeout", { message: "语音合成没有响应。" }));
      }, options.timeoutMs ?? 15_000);

      this.socket.on("message", (data, isBinary) => {
        if (isBinary) {
          if (this.finished) return;
          this.handlers.onChunk(Buffer.from(data as Buffer));
          return;
        }
        let frame: { header?: { event?: string; error_message?: string } } | null = null;
        try {
          frame = JSON.parse(data.toString()) as { header?: { event?: string; error_message?: string } };
        } catch {
          return;
        }
        const event = frame.header?.event;
        if (event === "task-started" && !settled) {
          settled = true;
          this.started = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (event === "task-failed") {
          const error = new AppError("upstream_error", {
            message: frame.header?.error_message ?? "语音合成失败",
            detail: JSON.stringify(frame.header ?? {}),
          });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
          this.fail(error);
          return;
        }
        if (event === "task-finished") {
          this.finished = true;
          this.handlers.onDone();
          this.close();
        }
      });
      this.socket.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new AppError("unreachable", { message: "语音合成连接中断。" }));
          return;
        }
        if (!this.finished) {
          this.finished = true;
          this.handlers.onDone();
        }
      });
      this.socket.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const status = /Unexpected server response:\s*(\d{3})/i.exec(message);
        const error = status
          ? handshakeError(Number(status[1]), message)
          : new AppError("unreachable", { message: "连不上语音合成服务。", detail: message });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        this.fail(error);
      });

      const rate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
      this.socket.send(
        JSON.stringify({
          header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
          payload: {
            model: options.model,
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            input: {},
            parameters: {
              voice: options.voice || "longanhuan_v3.1",
              volume: 50,
              text_type: "PlainText",
              sample_rate: rate,
              rate: typeof options.speed === "number" ? options.speed : 1,
              format: "pcm",
              pitch: 1,
              seed: 0,
              type: 0,
            },
          },
        }),
      );
    });
  }

  /** 发一段文本；可以分多次发，服务端会按顺序合成 */
  push(text: string): void {
    if (!this.started || this.finished || !text.trim()) return;
    this.socket.send(
      JSON.stringify({
        header: { action: "continue-task", task_id: this.taskId, streaming: "duplex" },
        payload: { input: { text } },
      }),
    );
  }

  /** 文本发完了，等服务端把剩下的音频吐完 */
  finish(): void {
    if (!this.started || this.finished) return;
    this.socket.send(
      JSON.stringify({ header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" }, payload: { input: {} } }),
    );
  }

  cancel(): void {
    this.finished = true;
    this.close();
  }

  private fail(error: AppError): void {
    if (this.finished) return;
    this.finished = true;
    this.handlers.onError(error);
    this.close();
  }
}

function randomTaskId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
