import { BrowserWindow } from "electron";
import type { ChangeEvent, ChangeKind } from "../shared/ipc.ts";
import { IPC } from "../shared/ipc.ts";
import { synthesizeSpeech } from "./voice.ts";
import type { SpeechClip } from "../shared/domain.ts";
import { splitSpeech } from "./speech-chunks.ts";

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
 * 说一句。失败不抛：TTS 不该阻断任务（3.10 降级）。
 *
 * 长文本拆成几句、按顺序合成并按顺序播：第一句合成完就出声，不用等整段。
 * 每段带同一个 utteranceId，渲染层据此"同一句排队、新的一句抢占"。
 */
export async function speak(text: string): Promise<SpeechClip | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  speaking = true;
  broadcast("overlay");

  speechSeq += 1;
  const utteranceId = `sp_${speechSeq}`;
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
