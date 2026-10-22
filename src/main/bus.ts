import { BrowserWindow } from "electron";
import type { ChangeEvent, ChangeKind } from "../shared/ipc.ts";
import { IPC } from "../shared/ipc.ts";
import { synthesizeSpeech } from "./voice.ts";
import type { SpeechClip } from "../shared/domain.ts";

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

/** 说一句。失败不抛：TTS 不该阻断任务（3.10 降级） */
export async function speak(text: string): Promise<SpeechClip | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const clip = await synthesizeSpeech(trimmed);
  if (!clip.ok || !clip.audioBase64) {
    console.warn("[kivora] speak skipped", clip.error?.code);
    return clip;
  }
  speechSeq += 1;
  broadcast("speech", { speech: { ...clip, id: `sp_${speechSeq}` } });
  return clip;
}
