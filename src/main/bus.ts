import { BrowserWindow } from "electron";
import type { ChangeEvent, ChangeKind } from "../shared/ipc.ts";
import { IPC } from "../shared/ipc.ts";
import { synthesizeSpeech } from "./voice.ts";
import type { SpeechClip } from "../shared/domain.ts";
import { splitSpeech } from "./speech-chunks.ts";
import { PcmTtsSession } from "./providers/dashscope-tts-stream.ts";
import { getBoundModel } from "./repos/models.ts";
import { getSecret, modelSecretName } from "./secrets.ts";
import { getConfig } from "./repos/config.ts";
import { AppError, serializeError } from "../shared/errors.ts";

/** 所有窗口共享一条广播通道，渲染层收到后只重取自己关心的切片 */
let hook: ((kind: ChangeKind) => void) | null = null;

export function setBroadcastHook(fn: ((kind: ChangeKind) => void) | null): void {
  hook = fn;
}

export function broadcast(kind: ChangeKind, payload: Partial<ChangeEvent> = {}): void {
  const event: ChangeEvent = { kind, at: Date.now(), ...payload };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.changed, event);
  }
  hook?.(kind);
}

let speechSeq = 0;
let speaking = false;

/** 有音频正在播（含合成中的等待）：悬浮窗要显示"在说"，也要能被一句话打断 */
export function isSpeaking(): boolean {
  return speaking;
}

export function setSpeaking(value: boolean): void {
  if (speaking === value) return;
  speaking = value;
  broadcast("overlay");
}

/** 立刻停掉正在播的语音 */
export function stopSpeech(): void {
  if (!speaking) return;
  speaking = false;
  broadcast("speech-stop");
  broadcast("overlay");
}

/**
 * 流式合成：音频一帧一帧广播给渲染层排队播，第一帧回来就出声。
 * 起不来（没绑 DashScope 合成、没 Key、握手失败）就返回 null，
 * 调用方退回批式，别把话吞掉。
 */
async function speakStreaming(text: string, utteranceId: string): Promise<SpeechClip | null> {
  const model = getBoundModel("tts");
  if (!model || model.provider !== "dashscope") return null;
  const apiKey = getSecret(modelSecretName(model.id));
  if (!apiKey) return null;
  const sampleRate = 24_000;
  let seq = 0;
  let failure: AppError | null = null;
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  let session: PcmTtsSession;
  try {
    session = await PcmTtsSession.open(
      {
        url: model.baseUrl,
        apiKey,
        model: model.modelId,
        voice: model.params.voice,
        speed: model.params.speed,
        sampleRate,
      },
      {
        onChunk: (pcm) => {
          seq += 1;
          broadcast("speech-pcm", { pcm: Buffer.from(pcm).toString("base64"), utteranceId, seq, sampleRate });
        },
        onDone: () => settle(),
        onError: (error) => {
          failure = error;
          settle();
        },
      },
    );
  } catch (err) {
    console.warn("[kivora] streaming tts unavailable", err instanceof Error ? err.message : err);
    return null;
  }

  for (const part of splitSpeech(text)) session.push(part);
  session.finish();
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 20_000))]);

  const error = failure ? serializeError(failure) : null;
  return { ok: error === null, audioBase64: null, mime: "audio/pcm", cached: false, durationMs: 0, error };
}

/**
 * 说一句。失败不抛：TTS 不该阻断任务（3.10 降级）。
 *
 * 长文本拆成几句、按顺序合成并按顺序播：第一句合成完就出声，不用等整段。
 * 每段带同一个 utteranceId，渲染层据此"同一句排队、新的一句抢占"。
 * 开了"边合成边播"且绑的是 DashScope 合成时走流式，第一帧就出声。
 */
export async function speak(text: string): Promise<SpeechClip | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  speechSeq += 1;
  const utteranceId = `sp_${speechSeq}`;
  if (getConfig().streamSpeech) {
    const streamed = await speakStreaming(trimmed, utteranceId);
    if (streamed) {
      speaking = true;
      broadcast("overlay");
      return streamed;
    }
  }

  speaking = true;
  broadcast("overlay");

  const parts = splitSpeech(trimmed);
  let last: SpeechClip | null = null;

  for (const [index, part] of parts.entries()) {
    const clip = await synthesizeSpeech(part);
    if (!clip.ok || !clip.audioBase64) {
      console.warn("[kivora] speak skipped", clip.error?.code);
      break;
    }
    last = clip;
    broadcast("speech", {
      speech: {
        ...clip,
        id: `${utteranceId}:${index}`,
        utteranceId,
        chunkIndex: index,
        isLast: index === parts.length - 1,
      },
    });
  }

  if (!last) {
    speaking = false;
    broadcast("overlay");
  }
  return last;
}
