import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square, X } from "lucide-react";
import { bridge } from "../lib/bridge.ts";
import { Recorder, isSpeakingAudio, listMics, pcm16ToBase64, type MicDevice } from "../lib/audio.ts";
import { containsWakeWord } from "@shared/wake.ts";
import { concatFloat32 } from "@shared/wav.ts";
import { WakeGate } from "../lib/wake.ts";
import { cn } from "../lib/utils.ts";
import { useToast } from "./ui.tsx";

/** 从开口到判定"有没有叫名字"的窗口：太短名字还没说完，太长白等 */
const WAKE_WINDOW_MS = 1_600;

export function Composer({
  busy,
  runningTitle,
  queueCount,
  onOpenQueue,
  onSent,
  onListeningChange,
  autoStop,
  autoStopSilenceMs,
  handsFree,
  wakeRequired,
  wakeWord,
}: {
  busy: boolean;
  runningTitle: string | null;
  queueCount: number;
  onOpenQueue: () => void;
  onSent: () => void;
  onListeningChange?: (listening: boolean) => void;
  autoStop: boolean;
  autoStopSilenceMs: number;
  handsFree: boolean;
  wakeRequired: boolean;
  wakeWord: string;
}): React.JSX.Element {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [sending, setSending] = useState(false);
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [micId, setMicId] = useState<string>(() => window.localStorage.getItem("kivora.mic") ?? "");
  const recorder = useRef(new Recorder());
  const inputRef = useRef<HTMLInputElement>(null);
  const lastLevelAt = useRef(0);
  // 端点检测在音频回调里跑，回调引用最新的收尾函数
  const streamRef = useRef<string | null>(null);
  const wakeRef = useRef<{ active: boolean; armed: boolean; timer: number }>({ active: false, armed: false, timer: 0 });
  const stopRef = useRef<() => void>(() => undefined);
  const cancelRef = useRef<() => void>(() => undefined);

  /**
   * 电平既给主窗的波形，也上报给悬浮窗——悬浮窗是独立渲染进程，
   * 拿不到这里的 AudioContext。约 25 帧/秒足够顺滑，又不至于刷爆 IPC。
   */
  const reportLevel = useCallback((value: number) => {
    setLevel(value);
    const now = performance.now();
    if (now - lastLevelAt.current < 40) return;
    lastLevelAt.current = now;
    bridge.reportLevel(value);
  }, []);

  useEffect(() => {
    void listMics().then((devices) => {
      setMics(devices);
      if (!micId && devices[0]) setMicId(devices[0].id);
    });
    // 设备列表只在挂载时探一次；插拔由系统权限变化触发重新枚举成本太高
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || sending) return;
      setSending(true);
      setDraft("");
      try {
        await bridge.send(value);
        onSent();
      } catch (err) {
        toast.push({
          tone: "error",
          title: "这句没送出去",
          detail: err instanceof Error ? err.message : String(err),
        });
        setDraft(value);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [onSent, sending, toast],
  );

  const startRecording = useCallback(async () => {
    if (recorder.current.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.push({ tone: "error", title: "拿不到麦克风", detail: "在 Windows 设置里给 Kivora 麦克风权限。" });
      return;
    }
    setRecording(true);
    setLevel(0);
    setPartial("");
    // 识别模型是流式的就边说边传；不是、或者服务没起来，就退回"录完再传"
    const stream = await bridge.asrStreamStart().catch(() => ({ streaming: false as const }));
    streamRef.current = stream.streaming ? stream.id : null;
    // 唤醒词门只能建在流式识别上（先听一小段再决定要不要继续）
    if (wakeRequired && stream.streaming) {
      wakeRef.current = { active: true, armed: false, timer: 0 };
      wakeRef.current.timer = window.setTimeout(() => {
        if (!wakeRef.current.active || wakeRef.current.armed) return;
        wakeRef.current.active = false;
        recorder.current.cancel();
        const id = streamRef.current;
        streamRef.current = null;
        if (id) void bridge.asrStreamCancel(id).catch(() => undefined);
        setRecording(false);
        setLevel(0);
        bridge.reportLevel(0);
        bridge.reportVoice(false);
        toast.push({ tone: "info", title: `没听到「${wakeWord}」`, detail: "先说名字，再说要做什么。" });
      }, WAKE_WINDOW_MS);
    }
    const pending: Float32Array[] = [];
    let pendingSamples = 0;
    try {
      await recorder.current.start(micId || undefined, reportLevel, {
        // 说完自动结束：只开能量端点检测，不额外下载模型
        endpoint: autoStop ? { silenceMs: autoStopSilenceMs } : undefined,
        onEndpoint: (event) => {
          if (event.type === "speech-start") return;
          // 从音频回调里挪出来再收尾，避免在回调里拆录音链路
          window.setTimeout(() => {
            if (event.type === "speech-end") stopRef.current();
            else cancelRef.current();
          }, 0);
        },
        // 每 200ms 推一段 16k/16bit PCM（3200 个采样）
        onPcm: stream.streaming
          ? (samples) => {
              const id = streamRef.current;
              if (!id) return;
              pending.push(samples);
              pendingSamples += samples.length;
              if (pendingSamples < 3_200) return;
              const merged = concatFloat32(pending);
              pending.length = 0;
              pendingSamples = 0;
              void bridge.asrStreamChunk(id, pcm16ToBase64(merged)).catch(() => undefined);
            }
          : undefined,
      });
    } catch (err) {
      streamRef.current = null;
      setRecording(false);
      toast.push({
        tone: "error",
        title: "麦克风没打开",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [autoStop, autoStopSilenceMs, micId, reportLevel, toast, wakeRequired, wakeWord]);

  const stopRecording = useCallback(async () => {
    if (!recorder.current.active) {
      setRecording(false);
      return;
    }
    // 还没叫名字就结束了：整段丢掉，不发出去
    if (wakeRef.current.active) {
      window.clearTimeout(wakeRef.current.timer);
      const armed = wakeRef.current.armed;
      wakeRef.current.active = false;
      if (!armed) {
        const id = streamRef.current;
        streamRef.current = null;
        recorder.current.cancel();
        if (id) void bridge.asrStreamCancel(id).catch(() => undefined);
        setRecording(false);
        setLevel(0);
        bridge.reportLevel(0);
        toast.push({ tone: "info", title: `没听到「${wakeWord}」`, detail: "先说名字，再说要做什么。" });
        return;
      }
    }
    setRecording(false);
    setLevel(0);
    setPartial("");
    bridge.reportLevel(0);
    const streamId = streamRef.current;
    streamRef.current = null;
    try {
      // 流式：录音只用来关麦克风，文本由服务端已经收着的音频决定
      if (streamId) {
        recorder.current.cancel();
        const { text } = await bridge.asrStreamFinish(streamId);
        if (!text.trim()) {
          toast.push({ tone: "info", title: "没听清", detail: "再说一次，或者直接打字。" });
          return;
        }
        onSent();
        return;
      }
      const clip = await recorder.current.stop();
      const transcript = await bridge.transcribe(clip.base64, clip.mime);
      if (transcript.error) {
        toast.push({ tone: "error", title: "没听清", detail: transcript.error.message });
        return;
      }
      if (!transcript.text.trim()) {
        toast.push({ tone: "info", title: "这句是空的", detail: "再按一次热键重新说。" });
        return;
      }
      onSent();
    } catch (err) {
      toast.push({
        tone: "error",
        title: "识别失败",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [onSent, toast]);

  const cancelRecording = useCallback(() => {
    window.clearTimeout(wakeRef.current.timer);
    wakeRef.current = { active: false, armed: false, timer: 0 };
    const streamId = streamRef.current;
    streamRef.current = null;
    recorder.current.cancel();
    if (streamId) void bridge.asrStreamCancel(streamId).catch(() => undefined);
    setRecording(false);
    setLevel(0);
    bridge.reportLevel(0);
  }, []);

  // 流式识别的中间结果：一边显示"边说边出字"，一边给唤醒词门做判断
  useEffect(() => {
    return bridge.subscribe((event) => {
      if (event.kind !== "voice" || typeof event.partial !== "string") return;
      setPartial(event.partial);
      if (!wakeRequired || !wakeRef.current.active || wakeRef.current.armed) return;
      if (!containsWakeWord(event.partial, wakeWord)) return;
      wakeRef.current.armed = true;
      window.clearTimeout(wakeRef.current.timer);
    });
  }, [wakeRequired, wakeWord]);

  // 端点检测只拿到"事件"，具体收尾用最新的这两个函数
  useEffect(() => {
    stopRef.current = () => void stopRecording();
    cancelRef.current = () => {
      cancelRecording();
      toast.push({ tone: "info", title: "没听到声音", detail: "看看系统里的麦克风选对了没有。" });
    };
  }, [cancelRecording, stopRecording, toast]);

  useEffect(() => {
    // 热键是开关：按一下开始录，再按一下结束并发送（没有"按住"这回事，
    // 全局快捷键收不到松开事件）。开始之前先打断正在播报/思考的那一轮。
    const unsubscribe = bridge.onHotkey(() => {
      if (recorder.current.active) {
        void stopRecording();
        return;
      }
      void bridge.interrupt();
      void startRecording();
    });
    return unsubscribe;
  }, [startRecording, stopRecording]);

  useEffect(() => {
    onListeningChange?.(recording);
    // 主进程据此决定悬浮窗显不显示"在听"——只有真开着麦克风才算
    bridge.reportVoice(recording);
  }, [recording, onListeningChange]);

  // 组件卸载（切到设置页等）时把麦克风也关掉，别留一个"在听"的幽灵
  useEffect(() => {
    return () => {
      recorder.current.cancel();
      bridge.reportVoice(false);
      bridge.reportLevel(0);
    };
  }, []);

  // 悬浮窗点「停」：主进程转发过来，这里真的收尾
  useEffect(() => {
    return bridge.onStopVoice(() => {
      if (recorder.current.active) void stopRecording();
      else cancelRecording();
    });
  }, [cancelRecording, stopRecording]);

  // 免按键：麦克风常开只做"有人开口"的判断，检测到就自动开始录音
  const gateErrorShown = useRef(false);
  useEffect(() => {
    if (!handsFree || recording) return;
    const gate = new WakeGate({
      deviceId: micId || undefined,
      isSpeaking: isSpeakingAudio,
      onWake: () => void startRecording(),
    });
    void gate.start().catch((err) => {
      if (gateErrorShown.current) return;
      gateErrorShown.current = true;
      toast.push({
        tone: "error",
        title: "免按键没启动",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
    return () => gate.stop();
  }, [handsFree, micId, recording, startRecording, toast]);

  // 阅读器里「引用到输入框」
  useEffect(() => {
    const handler = (event: Event): void => {
      const text = (event as CustomEvent<string>).detail;
      setDraft(text);
      inputRef.current?.focus();
    };
    window.addEventListener("kivora:quote", handler);
    return () => window.removeEventListener("kivora:quote", handler);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Esc 有两种含义：正在录就取消这一句，否则打断正在播报/思考的那一轮
      if (recorder.current.active) cancelRecording();
      else void bridge.interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelRecording]);

  const placeholder = recording
    ? autoStop
      ? "在听……说完自动结束"
      : "在听……再按一次热键结束"
    : runningTitle
      ? "再说一句会排到队尾；说「先做这个」会插队"
      : "说一句，或者先打字";

  return (
    <footer className="shrink-0 border-t border-border/60 bg-background">
      <div className="mx-auto w-full max-w-[820px] px-8 py-4">
        {queueCount > 0 ? (
          <button
            type="button"
            onClick={onOpenQueue}
            className="mb-2 flex items-center gap-2 text-[12px] text-faint hover:text-foreground"
          >
            <span className="inline-block size-1.5 rounded-full bg-acorn" />
            待处理 {queueCount} 条
            <span className="text-acorn">看看</span>
          </button>
        ) : null}

        <div className="flex items-end gap-2">
          <div
            className={cn(
              "flex min-h-[52px] flex-1 items-center rounded-[22px] bg-muted px-4 transition-shadow",
              recording && "ring-1 ring-acorn/50",
            )}
          >
            {recording ? (
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Waveform level={level} />
                {partial ? (
                  <span className="min-w-0 flex-1 truncate text-[14px] text-foreground/80">{partial}</span>
                ) : null}
              </div>
            ) : (
              <input
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder={placeholder}
                className="h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-faint"
              />
            )}
            {draft.trim() && !recording ? (
              <button
                type="button"
                aria-label="发送"
                onClick={() => void send(draft)}
                className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground"
              >
                <ArrowUp className="size-4" />
              </button>
            ) : null}
          </div>

          <button
            type="button"
            aria-label={recording ? "停止" : "说话"}
            disabled={busy && !recording}
            onPointerDown={(event) => {
              event.preventDefault();
              void startRecording();
            }}
            onPointerUp={() => void stopRecording()}
            onPointerLeave={() => {
              if (recording) void stopRecording();
            }}
            onContextMenu={(event) => event.preventDefault()}
            className={cn(
              "grid size-[52px] shrink-0 place-items-center rounded-full transition-colors",
              recording
                ? "bg-acorn text-background"
                : "bg-secondary text-foreground hover:bg-surface-highest disabled:opacity-40",
            )}
          >
            {recording ? <Square className="size-4 fill-current" /> : <Mic className="size-4" />}
          </button>
        </div>

        <div className="mt-2 flex items-center gap-3 text-[11px] text-faint">
          <span>
            {autoStop ? "按热键或点麦克风说话，说完自动结束" : "按热键或点麦克风说话，再点一次结束"}
          </span>
          {mics.length > 1 ? (
            <label className="ml-auto flex items-center gap-1">
              <Mic className="size-3" />
              <select
                value={micId}
                onChange={(event) => {
                  setMicId(event.target.value);
                  window.localStorage.setItem("kivora.mic", event.target.value);
                }}
                className="max-w-[220px] truncate bg-transparent text-[11px] text-faint outline-none"
              >
                {mics.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {recording ? (
            <button type="button" onClick={cancelRecording} className="ml-auto flex items-center gap-1 hover:text-foreground">
              <X className="size-3" /> 取消
            </button>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

function Waveform({ level }: { level: number }): React.JSX.Element {
  const bars = 18;
  return (
    <div className="flex h-12 flex-1 items-center gap-[3px]">
      {Array.from({ length: bars }, (_, index) => {
        const center = Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2);
        const height = Math.max(4, Math.round((1 - center) * 26 * (0.35 + level)));
        return (
          <span
            key={index}
            className="w-[3px] rounded-full bg-acorn/80 transition-[height] duration-75"
            style={{ height }}
          />
        );
      })}
    </div>
  );
}
