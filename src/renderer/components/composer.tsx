import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square, X } from "lucide-react";
import { bridge } from "../lib/bridge.ts";
import { Recorder, listMics, type MicDevice } from "../lib/audio.ts";
import { cn } from "../lib/utils.ts";
import { useToast } from "./ui.tsx";

export function Composer({
  busy,
  runningTitle,
  queueCount,
  onOpenQueue,
  onSent,
  onListeningChange,
}: {
  busy: boolean;
  runningTitle: string | null;
  queueCount: number;
  onOpenQueue: () => void;
  onSent: () => void;
  onListeningChange?: (listening: boolean) => void;
}): React.JSX.Element {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [sending, setSending] = useState(false);
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [micId, setMicId] = useState<string>(() => window.localStorage.getItem("kivora.mic") ?? "");
  const recorder = useRef(new Recorder());
  const inputRef = useRef<HTMLInputElement>(null);

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
    try {
      await recorder.current.start(micId || undefined, setLevel);
    } catch (err) {
      setRecording(false);
      toast.push({
        tone: "error",
        title: "麦克风没打开",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [micId, toast]);

  const stopRecording = useCallback(async () => {
    if (!recorder.current.active) {
      setRecording(false);
      return;
    }
    setRecording(false);
    try {
      const clip = await recorder.current.stop();
      const transcript = await bridge.transcribe(clip.base64, clip.mime);
      if (transcript.error) {
        toast.push({ tone: "error", title: "没听清", detail: transcript.error.message });
        return;
      }
      if (!transcript.text.trim()) {
        toast.push({ tone: "info", title: "这句是空的", detail: "按住热键，把话说完再松手。" });
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
    recorder.current.cancel();
    setRecording(false);
    setLevel(0);
  }, []);

  useEffect(() => {
    const unsubscribe = bridge.onHotkey(() => {
      void startRecording();
    });
    return unsubscribe;
  }, [startRecording]);

  useEffect(() => {
    onListeningChange?.(recording);
  }, [recording, onListeningChange]);

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
      if (event.key === "Escape" && recorder.current.active) cancelRecording();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelRecording]);

  const placeholder = recording
    ? "在听……说完松手"
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
              <Waveform level={level} />
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
            aria-label={recording ? "停止" : "按住说话"}
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
          <span>按住麦克风说话，或直接打字</span>
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
