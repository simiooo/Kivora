import WebSocket from "ws";
import { AppError } from "../../shared/errors.ts";

/**
 * DashScope 的语音接口走 WebSocket，不是 OpenAI 那套 HTTP：
 *   wss://.../api-ws/v1/inference
 *   鉴权：Authorization: Bearer <key>
 *   协议：run-task → (task-started) → binary/continue-task → finish-task
 *   事件：task-started / result-generated / task-finished / task-failed
 *
 * 协议细节来自官方 Python SDK（dashscope 2.0.1）的
 * audio/tts_v2/speech_synthesizer.py 与 audio/asr/recognition.py。
 */

const DEFAULT_TTS_VOICE = "longanhuan_v3.1";
const DEFAULT_TTS_SAMPLE_RATE = 24_000;
const DEFAULT_ASR_SAMPLE_RATE = 16_000;

export interface TaskEnvelope {
  header: { action: string; task_id: string; streaming: string };
  payload: Record<string, unknown>;
}

export function buildTtsStart(
  taskId: string,
  model: string,
  voice: string,
  format: string,
  sampleRate: number,
  rate = 1,
): TaskEnvelope {
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      model,
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      input: {},
      parameters: {
        voice,
        volume: 50,
        text_type: "PlainText",
        sample_rate: sampleRate,
        rate,
        format,
        pitch: 1.0,
        seed: 0,
        type: 0,
      },
    },
  };
}

export function buildTtsContinue(taskId: string, model: string, text: string): TaskEnvelope {
  return {
    header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
    payload: {
      model,
      task_group: "audio",
      task: "tts",
      function: "SpeechSynthesizer",
      input: { text },
    },
  };
}

export function buildAsrStart(
  taskId: string,
  model: string,
  format: string,
  sampleRate: number,
): TaskEnvelope {
  return {
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      model,
      task_group: "audio",
      task: "asr",
      function: "recognition",
      input: {},
      parameters: { format, sample_rate: sampleRate },
    },
  };
}

export function buildFinish(taskId: string): TaskEnvelope {
  return {
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} },
  };
}

function taskId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ConnectResult {
  socket: WebSocket;
  close: () => void;
}

export function handshakeError(status: number, body: string): AppError {
  const detail = body.slice(0, 600) || `HTTP ${status}`;
  if (status === 401 || status === 403) return new AppError("auth_failed", { detail });
  if (status === 429) return new AppError("rate_limited", { detail });
  if (status >= 500) return new AppError("upstream_error", { message: `语音服务返回 ${status}。`, detail });
  return new AppError("bad_response", { message: `语音服务拒绝了连接（HTTP ${status}）。`, detail });
}
export function connectWs(url: string, apiKey: string, timeoutMs: number): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: timeoutMs,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      reject(new AppError("timeout", { message: "语音服务连接超时。" }));
    }, timeoutMs);

    socket.once("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ socket, close: () => socket.terminate() });
    });
    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      // ws 对非 101 的握手有时直接抛 error，而不是 unexpected-response
      const statusMatch = /Unexpected server response:\s*(\d{3})/i.exec(message);
      reject(
        statusMatch
          ? handshakeError(Number(statusMatch[1]), message)
          : new AppError("unreachable", { message: "连不上语音服务。", detail: message }),
      );
    });
    // 服务端拒绝握手（401 之类）不会走 open/error，而是 unexpected-response
    socket.once("unexpected-response", (_request, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      response.on("data", (data) => chunks.push(Buffer.from(data as Buffer)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 600);
        const appError = handshakeError(status, body);
        try {
          socket.terminate();
        } catch {
          // ignore
        }
        reject(appError);
      });
    });
  });
}

interface EventFrame {
  header?: { event?: string; error_message?: string; error_code?: string };
  payload?: {
    output?: {
      sentence?: { text?: string; heartbeat?: boolean };
      finished?: boolean;
    };
  };
}

function parseFrame(raw: WebSocket.RawData): EventFrame | null {
  try {
    return JSON.parse(raw.toString()) as EventFrame;
  } catch {
    return null;
  }
}

function describeFailure(frame: EventFrame): string {
  return frame.header?.error_message ?? frame.header?.error_code ?? "语音任务失败";
}

/**
 * 官方文档里写明：音色必须属于当前模型，跨模型混用时服务返回
 * `InvalidParameter`，形如 `[cosyvoice]Engine error [411]: TTS speak operation failed`。
 * 这个报错本身完全看不出问题是音色，所以这里翻译成人话，并把原始报文留在 detail。
 */
function ttsFailure(frame: EventFrame, model: string, voice: string): AppError {
  const raw = describeFailure(frame);
  const code = frame.header?.error_code ?? "";
  const looksLikeVoice = /\[(411|418)\]/.test(raw) || /voice/i.test(raw);
  if (looksLikeVoice || code === "InvalidParameter") {
    return new AppError("invalid_input", {
      message: `音色「${voice}」不属于模型「${model}」，音色不能跨模型混用。换一个这个模型自己的音色再试。`,
      detail: raw,
    });
  }
  return new AppError("upstream_error", { message: raw, detail: JSON.stringify(frame.header ?? {}) });
}

export interface TtsRequest {
  url: string;
  apiKey: string;
  model: string;
  text: string;
  voice?: string | null;
  /** 语速 0.5–2.0，映射到协议里的 rate */
  speed?: number | null;
  format?: "mp3" | "wav" | "pcm" | "opus";
  sampleRate?: number;
  timeoutMs?: number;
}

export async function synthesizeViaWebSocket(request: TtsRequest): Promise<{ audio: Uint8Array; mime: string; latencyMs: number }> {
  const startedAt = Date.now();
  const id = taskId();
  const format = request.format ?? "mp3";
  const sampleRate = request.sampleRate ?? DEFAULT_TTS_SAMPLE_RATE;
  const voice = request.voice || DEFAULT_TTS_VOICE;
  const speed = typeof request.speed === "number" && Number.isFinite(request.speed) ? Math.min(2, Math.max(0.5, request.speed)) : 1;
  const { socket, close } = await connectWs(request.url, request.apiKey, request.timeoutMs ?? 20_000);

  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let started = false;

    const finish = (error?: AppError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      if (error) {
        reject(error);
        return;
      }
      if (chunks.length === 0) {
        reject(new AppError("bad_response", { message: "语音服务没有返回音频。" }));
        return;
      }
      resolve({ audio: new Uint8Array(Buffer.concat(chunks)), mime: format === "mp3" ? "audio/mpeg" : `audio/${format}`, latencyMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => finish(new AppError("timeout", { message: "语音合成超时。" })), request.timeoutMs ?? 20_000);

    const send = (envelope: TaskEnvelope): void => {
      socket.send(JSON.stringify(envelope));
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        chunks.push(Buffer.from(data as Buffer));
        return;
      }
      const frame = parseFrame(data);
      const event = frame?.header?.event;
      if (event === "task-started" && !started) {
        started = true;
        send(buildTtsContinue(id, request.model, request.text));
        send(buildFinish(id));
        return;
      }
      if (event === "task-failed") {
        finish(ttsFailure(frame as EventFrame, request.model, voice));
        return;
      }
      if (event === "task-finished") finish();
    });

    socket.on("close", () => finish());
    socket.on("error", (err) => finish(new AppError("unreachable", { message: "语音服务连接中断。", detail: err instanceof Error ? err.message : String(err) })));

    send(buildTtsStart(id, request.model, voice, format, sampleRate, speed));
  });
}

export interface AsrRequest {
  url: string;
  apiKey: string;
  model: string;
  /** 16k 单声道 PCM WAV */
  audio: Uint8Array;
  format?: "wav" | "pcm" | "mp3";
  sampleRate?: number;
  timeoutMs?: number;
}

export async function transcribeViaWebSocket(request: AsrRequest): Promise<{ text: string; latencyMs: number }> {
  const startedAt = Date.now();
  const id = taskId();
  const sampleRate = request.sampleRate ?? DEFAULT_ASR_SAMPLE_RATE;
  const { socket, close } = await connectWs(request.url, request.apiKey, request.timeoutMs ?? 40_000);

  return await new Promise((resolve, reject) => {
    const sentences: string[] = [];
    let settled = false;

    const finish = (error?: AppError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      if (error) {
        reject(error);
        return;
      }
      resolve({ text: sentences.join("").trim(), latencyMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => finish(new AppError("timeout", { message: "语音识别超时。" })), request.timeoutMs ?? 40_000);

    const send = (envelope: TaskEnvelope): void => {
      socket.send(JSON.stringify(envelope));
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parseFrame(data);
      const event = frame?.header?.event;

      if (event === "task-started") {
        // 二进制输入：原样把音频按帧发过去，最后 finish-task
        const chunkSize = 8 * 1024;
        for (let offset = 0; offset < request.audio.length; offset += chunkSize) {
          socket.send(request.audio.subarray(offset, offset + chunkSize));
        }
        send(buildFinish(id));
        return;
      }
      if (event === "task-failed") {
        finish(new AppError("upstream_error", { message: describeFailure(frame as EventFrame), detail: JSON.stringify(frame?.header ?? {}) }));
        return;
      }
      if (event === "result-generated") {
        const sentence = frame?.payload?.output?.sentence;
        if (sentence?.heartbeat) return;
        if (typeof sentence?.text === "string" && sentence.text) sentences.push(sentence.text);
        if (frame?.payload?.output?.finished) finish();
        return;
      }
      if (event === "task-finished") finish();
    });

    socket.on("close", () => finish());
    socket.on("error", (err) => finish(new AppError("unreachable", { message: "语音服务连接中断。", detail: err instanceof Error ? err.message : String(err) })));

    send(buildAsrStart(id, request.model, request.format ?? "wav", sampleRate));
  });
}
