import type { SpeechClip, Transcript } from "../shared/domain.ts";
import { AppError, serializeError } from "../shared/errors.ts";
import { getConfig } from "./repos/config.ts";
import { mockMode } from "./env.ts";
import { getBoundModel } from "./repos/models.ts";
import { getSecret, modelSecretName } from "./secrets.ts";
import { mockTone, synthesize, transcribe } from "./providers/audio.ts";
import { synthesizeViaWebSocket, transcribeViaWebSocket } from "./providers/dashscope-ws.ts";

/** D1 的 mock 转写：轮着来，覆盖三条黄金路径 + 状态查询 + 审批回答 */
export const MOCK_UTTERANCES = [
  "把下载目录里上周的 pdf 挪到文档/发票",
  "帮我在京东搜机械键盘，按销量排",
  "刚才那个做完了吗",
  "读一下未读消息",
  "可以",
  "重新整理一次发票",
];

let mockIndex = 0;

export function nextMockUtterance(): string {
  const text = MOCK_UTTERANCES[mockIndex % MOCK_UTTERANCES.length];
  mockIndex += 1;
  return text;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export async function transcribeAudio(audio: Uint8Array, mime: string): Promise<Transcript> {
  const config = getConfig();
  const startedAt = Date.now();

  if (audio.byteLength < 1200) {
    return {
      text: "",
      confidence: null,
      durationMs: Date.now() - startedAt,
      provider: "mock",
      error: { code: "asr_failed", message: "这段太短了，按住多说两个字。", retryable: true },
    };
  }

  if (mockMode()) {
    await new Promise((resolve) => setTimeout(resolve, 220));
    return {
      text: nextMockUtterance(),
      confidence: 0.92,
      durationMs: Date.now() - startedAt,
      provider: "mock",
      error: null,
    };
  }

  const model = getBoundModel("asr");
  if (!model) {
    return {
      text: "",
      confidence: null,
      durationMs: Date.now() - startedAt,
      provider: "openai",
      error: { code: "no_model", message: "还没绑定语音识别模型，去设置里绑一个。", retryable: false },
    };
  }

  try {
    const apiKey = getSecret(modelSecretName(model.id));
    const sampleRate = (() => {
      try {
        return new DataView(audio.buffer, audio.byteOffset, audio.byteLength).getUint32(24, true) || 16_000;
      } catch {
        return 16_000;
      }
    })();
    const result =
      model.provider === "dashscope"
        ? await transcribeViaWebSocket({
            url: model.baseUrl,
            apiKey: apiKey ?? "",
            model: model.modelId,
            audio,
            sampleRate,
            format: mime.includes("wav") ? "wav" : "mp3",
          })
        : await transcribe(model, apiKey, audio, mime, config.asrLanguage);
    return {
      text: result.text,
      confidence: null,
      durationMs: Date.now() - startedAt,
      provider: "openai",
      error: null,
    };
  } catch (err) {
    const serialized = serializeError(err);
    return {
      text: "",
      confidence: null,
      durationMs: Date.now() - startedAt,
      provider: "openai",
      error: { code: serialized.code, message: serialized.message, retryable: serialized.retryable },
    };
  }
}

/** 缓存：同一句话不重复合成（3.9 的 ack 库思路） */
const speechCache = new Map<string, { base64: string; mime: string }>();
const SPEECH_CACHE_LIMIT = 40;

export async function synthesizeSpeech(text: string): Promise<SpeechClip> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, audioBase64: null, mime: "audio/wav", cached: false, durationMs: 0, error: null };
  }

  if (mockMode()) {
    const key = `mock:${trimmed}`;
    const cached = speechCache.get(key);
    if (cached) {
      return { ok: true, audioBase64: cached.base64, mime: cached.mime, cached: true, durationMs: 0, error: null };
    }
    const startedAt = Date.now();
    const base64 = toBase64(mockTone());
    speechCache.set(key, { base64, mime: "audio/wav" });
    return {
      ok: true,
      audioBase64: base64,
      mime: "audio/wav",
      cached: false,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  }

  const model = getBoundModel("tts");
  if (!model) {
    return {
      ok: false,
      audioBase64: null,
      mime: "audio/mpeg",
      cached: false,
      durationMs: 0,
      error: { code: "no_model", message: "还没绑定语音合成模型。", retryable: false },
    };
  }

  const cacheKey = `${model.id}:${trimmed}`;
  const hit = speechCache.get(cacheKey);
  if (hit) {
    return { ok: true, audioBase64: hit.base64, mime: hit.mime, cached: true, durationMs: 0, error: null };
  }

  try {
    const apiKey = getSecret(modelSecretName(model.id));
    const result =
      model.provider === "dashscope"
        ? await synthesizeViaWebSocket({
            url: model.baseUrl,
            apiKey: apiKey ?? "",
            model: model.modelId,
            text: trimmed,
            voice: model.params.voice,
            speed: model.params.speed,
          })
        : await synthesize(model, apiKey, trimmed);
    const base64 = toBase64(result.audio);
    if (speechCache.size >= SPEECH_CACHE_LIMIT) {
      const oldest = speechCache.keys().next().value;
      if (oldest) speechCache.delete(oldest);
    }
    speechCache.set(cacheKey, { base64, mime: result.mime });
    return { ok: true, audioBase64: base64, mime: result.mime, cached: false, durationMs: result.latencyMs, error: null };
  } catch (err) {
    const serialized = serializeError(err);
    console.warn("[kivora] tts failed", serialized.code, serialized.message);
    return {
      ok: false,
      audioBase64: null,
      mime: "audio/mpeg",
      cached: false,
      durationMs: 0,
      error: serialized as SpeechClip["error"],
    };
  }
}

export function clearSpeechCache(): void {
  speechCache.clear();
}

/** 给设置页"试听"用：直接拿一句固定的短句 */
export async function previewVoice(text = "我是 Kivora，这样说话。"): Promise<SpeechClip> {
  return synthesizeSpeech(text);
}

export function requireModel(module: "asr" | "tts" | "brain" | "task") {
  const model = getBoundModel(module);
  if (!model) throw new AppError("no_model", { message: `还没给「${module}」绑定模型。` });
  return model;
}
