import type { ModelRecord } from "../../shared/domain.ts";
import { AppError } from "../../shared/errors.ts";
import { authHeaders, joinUrl } from "./llm.ts";
import { request } from "./http.ts";

export interface TranscriptionResult {
  text: string;
  latencyMs: number;
}

export async function transcribe(
  model: ModelRecord,
  apiKey: string | null,
  audio: Uint8Array,
  mime: string,
  language: string,
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const form = new FormData();
  form.set("model", model.modelId);
  form.set("response_format", "json");
  const extension = mime.includes("wav") ? "wav" : mime.includes("mp4") ? "mp4" : "webm";
  form.set("file", new Blob([audio as unknown as BlobPart], { type: mime }), `clip.${extension}`);
  if (language === "zh" || language === "en") form.set("language", language);

  const headers = authHeaders(model, apiKey);
  delete headers["content-type"];

  const response = await request({
    channel: "asr",
    url: joinUrl(model.baseUrl, "/audio/transcriptions"),
    headers,
    body: form,
    signal,
    timeoutMs: 30_000,
  });
  const body = response.json<{ text?: string }>();
  if (typeof body.text !== "string") {
    throw new AppError("bad_response", { message: "识别接口没返回 text 字段，核对一下端点。" });
  }
  return { text: body.text.trim(), latencyMs: Date.now() - startedAt };
}

export interface SynthesisResult {
  audio: Uint8Array;
  mime: string;
  latencyMs: number;
}

export async function synthesize(
  model: ModelRecord,
  apiKey: string | null,
  text: string,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: model.modelId,
    input: text,
    response_format: "mp3",
  };
  if (model.params.voice) body.voice = model.params.voice;
  if (typeof model.params.speed === "number") body.speed = model.params.speed;

  const response = await request({
    channel: "tts",
    url: joinUrl(model.baseUrl, "/audio/speech"),
    headers: { "content-type": "application/json", ...authHeaders(model, apiKey) },
    body: JSON.stringify(body),
    signal,
    timeoutMs: 15_000,
  });
  if (response.arrayBuffer.byteLength === 0) {
    throw new AppError("bad_response", { message: "合成接口返回了空音频。" });
  }
  return { audio: new Uint8Array(response.arrayBuffer), mime: "audio/mpeg", latencyMs: Date.now() - startedAt };
}

/* ------------------------------------------------------------ 音频工具 */

/** 16kHz 单声道 16bit PCM WAV */
export function pcmToWav(samples: Float32Array, sampleRate = 16_000): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 0x7fff), true);
  }
  return new Uint8Array(buffer);
}

/** 0.4s 静音，用来做一次真实但几乎零成本的 ASR 探测 */
export function silentWav(seconds = 0.4): Uint8Array {
  return pcmToWav(new Float32Array(Math.round(16_000 * seconds)));
}

/** mock 模式下的提示音：两声短促的轻响，比"假装有人说话"诚实 */
export function mockTone(): Uint8Array {
  const sampleRate = 22_050;
  const duration = 0.34;
  const total = Math.round(sampleRate * duration);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.02) * Math.max(0, 1 - (t - 0.08) / 0.2);
    const first = t < 0.11 ? Math.sin(2 * Math.PI * 660 * t) * 0.18 : 0;
    const second = t > 0.15 && t < 0.3 ? Math.sin(2 * Math.PI * 880 * (t - 0.15)) * 0.16 : 0;
    samples[i] = (first + second) * Math.max(0, envelope);
  }
  return pcmToWav(samples, sampleRate);
}
