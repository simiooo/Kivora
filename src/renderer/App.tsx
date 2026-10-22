import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Settings2, X } from "lucide-react";
import type { AppConfig, AppState, TimelineMessage } from "@shared/ipc.ts";
import { cn, formatTime } from "./lib/utils.ts";

const MOCK_UTTERANCES = [
  "把下载目录里上周的 pdf 挪到文档/发票",
  "打开计算器，算一下 6 乘 7",
  "帮我在京东搜机械键盘，按销量排",
  "刚才那个做完了吗",
];

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mockIndex = useRef(0);

  const refresh = useCallback(async () => {
    const [s, c, m] = await Promise.all([
      window.kivora.getState(),
      window.kivora.getConfig(),
      window.kivora.listTimeline(80),
    ]);
    setState(s);
    setConfig(c);
    setMessages(m);
  }, []);

  useEffect(() => {
    void refresh();
    return window.kivora.onHotkey(() => {
      setListening(true);
      inputRef.current?.focus();
      window.setTimeout(() => setListening(false), 2400);
    });
  }, [refresh]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || busy) return;
      setBusy(true);
      setDraft("");
      try {
        const result = await window.kivora.send(value);
        setMessages((prev) => [...prev, result.user, result.assistant]);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const pushToTalk = useCallback(() => {
    const utterance = MOCK_UTTERANCES[mockIndex.current % MOCK_UTTERANCES.length];
    mockIndex.current += 1;
    setListening(true);
    window.setTimeout(() => {
      setListening(false);
      void send(utterance);
    }, 520);
  }, [send]);

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-12 shrink-0 items-center gap-3 pr-36 pl-5"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span
          className={cn(
            "size-2 rounded-full transition-colors",
            listening ? "bg-acorn" : busy ? "bg-acorn/50" : "bg-hairline-strong",
          )}
        />
        <span className="text-[13px] font-medium tracking-tight">Kivora</span>
        <span className="text-[12px] text-faint">
          {listening ? "在听" : busy ? "在想" : "待命"}
        </span>
        <div className="ml-auto flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {state?.mock ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">mock</span>
          ) : null}
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {state?.hotkey?.replace("CommandOrControl", "Ctrl") ?? "—"}
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="设置"
          >
            <Settings2 className="size-4" />
          </button>
        </div>
      </header>

      <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-8 pb-10 pt-2">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </div>
      </main>

      <footer className="shrink-0 border-t border-border/70 bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[760px] items-center gap-2 px-8 py-4">
          <div className="flex h-11 flex-1 items-center rounded-[18px] bg-muted px-4">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              placeholder={listening ? "在听……（D0 是 mock 转写）" : "说一句，或者先打字"}
              className="h-full w-full bg-transparent text-[14px] outline-none placeholder:text-faint"
            />
          </div>
          <button
            type="button"
            onClick={pushToTalk}
            disabled={busy}
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-full transition-colors",
              listening ? "bg-acorn text-background" : "bg-secondary text-foreground hover:bg-surface-highest",
              busy && "opacity-50",
            )}
            aria-label="按住说话"
          >
            <Mic className="size-4" />
          </button>
        </div>
      </footer>

      {settingsOpen && config ? (
        <SettingsPanel
          config={config}
          onClose={() => setSettingsOpen(false)}
          onSave={async (patch) => {
            const next = await window.kivora.setConfig(patch);
            setConfig(next);
            setState((prev) => (prev ? { ...prev, hotkey: next.hotkey, mock: next.mockMode } : prev));
          }}
        />
      ) : null}
    </div>
  );
}

function MessageRow({ message }: { message: TimelineMessage }): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <article className="group py-3">
      <div className="mb-1 flex items-baseline gap-2">
        <span className={cn("text-[12px] font-medium", isUser ? "text-faint" : "text-acorn")}>
          {isUser ? "你" : message.role === "system" ? "系统" : "Kivora"}
        </span>
        <span className="text-[11px] tabular-nums text-faint/70">{formatTime(message.ts)}</span>
      </div>
      <p className={cn("text-[15px] leading-7", isUser ? "text-foreground/90" : "text-foreground")}>
        {message.content}
      </p>
    </article>
  );
}

function SettingsPanel({
  config,
  onClose,
  onSave,
}: {
  config: AppConfig;
  onClose: () => void;
  onSave: (patch: Partial<AppConfig>) => Promise<void>;
}): React.JSX.Element {
  const [hotkey, setHotkey] = useState(config.hotkey);
  const [mockMode, setMockMode] = useState(config.mockMode);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <section
        className="h-full w-[380px] overflow-y-auto rounded-l-[22px] bg-card p-6 shadow-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-center">
          <h2 className="text-[15px] font-medium">设置</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        <Field label="热键">
          <input
            value={hotkey}
            onChange={(e) => setHotkey(e.target.value)}
            className="h-9 w-full rounded-[12px] bg-input px-3 font-mono text-[12px] outline-none"
          />
        </Field>

        <Field label="当前端点" hint="四段端点全部由你配置，Kivora 不代收代付。">
          <ul className="space-y-1 text-[12px] text-muted-foreground">
            <li>brain · {config.brainModel}</li>
            <li>asr · {config.asrModel}</li>
            <li>tts · {config.ttsModel} / {config.ttsVoice}</li>
            <li>task · {config.taskModel}</li>
          </ul>
        </Field>

        <label className="mt-6 flex items-center gap-3 text-[13px]">
          <input
            type="checkbox"
            checked={mockMode}
            onChange={(e) => setMockMode(e.target.checked)}
            className="size-4 accent-[var(--acorn)]"
          />
          mock 模式（不发真实请求）
        </label>

        <button
          type="button"
          onClick={() => void onSave({ hotkey, mockMode }).then(onClose)}
          className="mt-8 h-10 w-full rounded-[12px] bg-primary text-[13px] font-medium text-primary-foreground"
        >
          保存
        </button>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-5">
      <div className="mb-2 text-[12px] font-medium text-muted-foreground">{label}</div>
      {children}
      {hint ? <p className="mt-2 text-[11px] leading-5 text-faint">{hint}</p> : null}
    </div>
  );
}
