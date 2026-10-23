import type WebSocket from "ws";
import { AppError } from "../../shared/errors.ts";
import { connectWs, handshakeError } from "./dashscope-ws.ts";

/**
 * 流式识别（边说边出字）。
 *
 * 和批式（`asr-flash-message`，录完整段再上传）共用同一个端点与鉴权，
 * 区别只在于：音频一边采一边推二进制，服务端用 VAD 断句，
 * `result-generated` 里带 `sentence.sentence_end`：
 *   - false：这一句的中间结果（会改，不能直接拼）
 *   - true ：这句定了，用 `sentence_id` 覆盖该句文本
 *
 * 默认不用它：只有绑定的识别模型是 `*-streaming` 时才走这条路
 * （模型名见 DashScope 文档 `qwen-audio-3.1-asr-flash-streaming`）。
 */

interface StreamFrame {
  header?: { event?: string; error_message?: string; error_code?: string };
  payload?: {
    output?: {
      sentence?: { text?: string; sentence_end?: boolean; sentence_id?: number | string };
    };
  };
}

export interface AsrStreamOptions {
  url: string;
  apiKey: string;
  model: string;
  sampleRate?: number;
  /** 握手 + 启动超时 */
  timeoutMs?: number;
  onPartial?: (text: string) => void;
}

const DEFAULT_SAMPLE_RATE = 16_000;

export class AsrStream {
  private readonly socket: WebSocket;
  private readonly close: () => void;
  private readonly taskId: string;
  private readonly finals = new Map<string, string>();
  private partial = "";
  private settled = false;
  private readonly onPartial: ((text: string) => void) | undefined;
  private finishResolver: ((text: string) => void) | null = null;
  private finishRejecter: ((error: AppError) => void) | null = null;

  private constructor(
    socket: WebSocket,
    close: () => void,
    taskId: string,
    onPartial: ((text: string) => void) | undefined,
  ) {
    this.socket = socket;
    this.close = close;
    this.taskId = taskId;
    this.onPartial = onPartial;
  }

  /** 建连 + run-task，等到 task-started 才返回，避免音频发早了被丢 */
  static async start(options: AsrStreamOptions): Promise<AsrStream> {
    const taskId = randomTaskId();
    const { socket, close } = await connectWs(options.url, options.apiKey, options.timeoutMs ?? 15_000);
    const stream = new AsrStream(socket, close, taskId, options.onPartial);
    try {
      await stream.begin(options.model, options.sampleRate ?? DEFAULT_SAMPLE_RATE, options.timeoutMs ?? 15_000);
      return stream;
    } catch (err) {
      close();
      throw err;
    }
  }

  private begin(model: string, sampleRate: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (started) return;
        reject(new AppError("timeout", { message: "语音识别没有响应。" }));
      }, timeoutMs);

      const settleStart = (error?: AppError): void => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      this.socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const frame = parseFrame(data);
        const event = frame?.header?.event;
        if (event === "task-started") return settleStart();
        if (event === "task-failed") {
          const error = new AppError("upstream_error", {
            message: frame?.header?.error_message ?? "语音识别失败",
            detail: JSON.stringify(frame?.header ?? {}),
          });
          settleStart(error);
          this.fail(error);
          return;
        }
        if (event === "result-generated" && frame) {
          this.consume(frame);
          return;
        }
        if (event === "task-finished") {
          this.finishResolver?.(this.text());
          this.settle();
        }
      });
      this.socket.on("close", () => {
        settleStart(new AppError("unreachable", { message: "语音识别连接中断。" }));
        this.finishResolver?.(this.text());
        this.settle();
      });
      this.socket.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const status = /Unexpected server response:\s*(\d{3})/i.exec(message);
        const error = status
          ? handshakeError(Number(status[1]), message)
          : new AppError("unreachable", { message: "连不上语音识别服务。", detail: message });
        settleStart(error);
        this.fail(error);
      });

      this.socket.send(
        JSON.stringify({
          header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
          payload: {
            model,
            task_group: "audio",
            task: "asr",
            function: "recognition",
            input: {},
            parameters: {
              format: "pcm",
              sample_rate: sampleRate,
              intermediate_result_enabled: true,
            },
          },
        }),
      );
    });
  }

  private consume(frame: StreamFrame): void {
    const sentence = frame.payload?.output?.sentence;
    if (!sentence?.text) return;
    const key = String(sentence.sentence_id ?? "0");
    if (sentence.sentence_end) {
      this.finals.set(key, sentence.text);
      this.partial = "";
      this.onPartial?.(this.text());
      return;
    }
    this.partial = sentence.text;
    this.onPartial?.(this.text());
  }

  private text(): string {
    return `${[...this.finals.values()].join("")}${this.partial}`.trim();
  }

  /** 推一段 16k 单声道 PCM */
  push(pcm: Uint8Array): void {
    if (this.settled) return;
    this.socket.send(pcm);
  }

  /** 结束并拿最终文本 */
  finish(timeoutMs = 15_000): Promise<{ text: string }> {
    if (this.settled) return Promise.resolve({ text: this.text() });
    return new Promise((resolve, reject) => {
      this.finishResolver = (text) => resolve({ text });
      this.finishRejecter = reject;
      const timer = setTimeout(() => {
        this.fail(new AppError("timeout", { message: "语音识别没有给出结果。" }));
        this.close();
      }, timeoutMs);
      // 清掉定时器：正常结束时 settle 会把结果交出去
      const originalResolve = this.finishResolver;
      this.finishResolver = (text) => {
        clearTimeout(timer);
        originalResolve(text);
      };
      this.socket.send(
        JSON.stringify({ header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" }, payload: { input: {} } }),
      );
    });
  }

  cancel(): void {
    this.settled = true;
    this.close();
  }

  private fail(error: AppError): void {
    this.finishRejecter?.(error);
    this.settle();
  }

  private settle(): void {
    this.settled = true;
    this.close();
  }
}

function parseFrame(raw: unknown): StreamFrame | null {
  try {
    return JSON.parse(String(raw)) as StreamFrame;
  } catch {
    return null;
  }
}

function randomTaskId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 绑定的模型是不是流式识别（模型名以 -streaming 结尾，或者显式带 realtime） */
export function isStreamingAsrModel(modelId: string): boolean {
  return /-streaming$|-realtime-|-realtime$/i.test(modelId.trim());
}
