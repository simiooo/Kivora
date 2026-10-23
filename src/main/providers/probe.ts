import type { ModelRecord, TestResult } from "../../shared/domain.ts";
import { AppError, serializeError } from "../../shared/errors.ts";
import { chatCompletion } from "./llm.ts";
import { silentWav, synthesize, transcribe } from "./audio.ts";
import { synthesizeViaWebSocket, transcribeViaWebSocket } from "./dashscope-ws.ts";
import { setTestResult } from "../repos/models.ts";

/**
 * 测试连接 = 真的打一次端点，而不是 ping 域名：
 * - chat：一次 1 token 的补全
 * - asr：0.4 秒静音，几乎不花钱
 * - tts：合成一个"好"，验证能返回音频字节
 * DashScope 的语音走 WebSocket，用同一套"静音 / 一个好"做探测。
 */
export async function probeModel(model: ModelRecord, apiKey: string | null, mockMode: boolean): Promise<TestResult> {
  const at = Date.now();
  if (mockMode && !apiKey) {
    const latency = 180 + Math.round(Math.random() * 160);
    setTestResult(model.id, "ok", latency);
    return { modelId: model.id, ok: true, latencyMs: latency, error: null, at, simulated: true };
  }

  const startedAt = Date.now();
  try {
    if (!apiKey && model.provider !== "custom") {
      throw new AppError("key_missing", { message: "这个模型还没有填 API Key。" });
    }
    if (model.capability === "chat") {
      await chatCompletion(model, apiKey, [{ role: "user", content: "ping" }], { maxTokens: 1, temperature: 0 });
    } else if (model.provider === "dashscope") {
      if (model.capability === "asr") {
        await transcribeViaWebSocket({
          url: model.baseUrl,
          apiKey: apiKey ?? "",
          model: model.modelId,
          audio: silentWav(0.4),
        });
      } else {
        await synthesizeViaWebSocket({
          url: model.baseUrl,
          apiKey: apiKey ?? "",
          model: model.modelId,
          text: "好",
          voice: model.params.voice,
        });
      }
    } else if (model.capability === "asr") {
      await transcribe(model, apiKey, silentWav(0.4), "audio/wav", "en");
    } else {
      await synthesize(model, apiKey, "好");
    }
    const latencyMs = Date.now() - startedAt;
    setTestResult(model.id, "ok", latencyMs);
    return { modelId: model.id, ok: true, latencyMs, error: null, at, simulated: false };
  } catch (err) {
    const serialized = serializeError(err);
    const latencyMs = Date.now() - startedAt;
    setTestResult(model.id, "failed", latencyMs);
    return {
      modelId: model.id,
      ok: false,
      latencyMs,
      error: { code: serialized.code, message: serialized.message, detail: serialized.detail },
      at,
      simulated: false,
    };
  }
}
