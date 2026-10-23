import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Mic, Square, X } from "lucide-react";
import type { OverlayState } from "@shared/domain.ts";
import { STATE_LABELS } from "@shared/domain.ts";
import { formatHotkey, formatRelative, tailEllipsis } from "@shared/text.ts";
import { bridge } from "../lib/bridge.ts";
import { cn } from "../lib/utils.ts";

void (async (): Promise<void> => {
  document.documentElement.classList.add("overlay-window");
})();

/**
 * 桌面悬浮窗：一个常驻的小 HUD。
 *
 * 三条规则：
 * - 热键只是"把它叫出来"，之后它一直在，直到用户收起（× / Esc / 托盘）。
 * - 头部的状态是唯一的说法（在听 / 在想 / 待命），按钮只说"现在能做什么"，
 *   录音时按钮变成「停」，不再出现"在听"和"说一句"并列的矛盾。
 * - 波纹跟着主窗上报的真实电平走，不是装饰动画。
 */
export function OverlayApp(): React.JSX.Element | null {
  const [state, setState] = useState<OverlayState | null>(null);
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef(0);

  const load = useCallback(async () => {
    try {
      setState(await bridge.getOverlayState());
    } catch {
      // 主进程还没准备好时静默
    }
  }, []);

  useEffect(() => {
    void load();
    return bridge.subscribe((event) => {
      if (event.kind === "voice") {
        setLevel(event.level ?? 0);
        if (typeof event.partial === "string") setPartial(event.partial);
        return;
      }
      if (["overlay", "approvals", "sessions", "queue", "config"].includes(event.kind)) void load();
    });
  }, [load]);

  // 窗口贴内容走：透明区域是实打实挡住底下点击的，别让它白白占一块
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const report = (): void => {
      const rect = el.getBoundingClientRect().height;
      const height = Math.ceil(Math.max(rect, el.scrollHeight)) + 24;
      if (Math.abs(height - lastHeight.current) < 2) return;
      lastHeight.current = height;
      void bridge.overlayResize(height);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [Boolean(state)]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void bridge.overlayHide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state) return null;

  const listening = state.listening;
  const thinking = state.thinking;
  const speaking = state.speaking;
  const pending = state.pendingApproval;
  const running = state.foreground;
  // 状态优先级：在听 > 在想 > 在说 > 在跑 > 待命
  const status = listening ? "在听" : thinking ? "在想" : speaking ? "在说" : running ? "在忙" : "待命";
  const busy = listening || thinking || speaking;
  const empty = !pending && state.queuedCount === 0 && !running && !state.lastRun;

  return (
    <div className="motion-pop flex h-full flex-col justify-end p-3">
      {/* shrink-0：窗口先短后长时卡片不能跟着被压扁，否则量到的永远是窗口高度 */}
      <div ref={cardRef} className="shrink-0 overflow-hidden rounded-[18px] border border-white/5 bg-card shadow-float">
        <div className="drag-region flex items-center gap-2 px-5 pt-4 pb-3" data-drag="1">
          <span className="relative grid size-2 place-items-center">
            <span className={cn("size-2 rounded-full", busy || running ? "bg-acorn" : "bg-faint")} />
            {busy || running ? (
              <span className="absolute size-2 animate-ping rounded-full bg-acorn opacity-40" />
            ) : null}
          </span>
          <span className="text-[15px] font-medium">Kivora</span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px]",
              listening ? "bg-acorn/15 text-acorn" : busy || running ? "bg-acorn/10 text-acorn/90" : "bg-muted text-faint",
            )}
          >
            {status}
          </span>
          {state.handsFree && !listening ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-faint">免按键</span>
          ) : null}
          <span className="ml-auto font-mono text-[11px] text-faint">{formatHotkey(state.hotkey)}</span>
          <button
            type="button"
            aria-label="收起"
            onClick={() => void bridge.overlayHide()}
            className="no-drag -mr-1 grid size-6 place-items-center rounded-full text-faint hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {listening ? (
          <div className="px-5 pb-4">
            <Bars level={level} />
            {state.wakeRequired && !state.wakeArmed ? (
              <p className="mt-2 text-[12px] leading-5 text-acorn">
                叫一句「{state.wakeWord}」再说是要做什么
              </p>
            ) : (
              <>
                {partial ? (
                  <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-foreground/80">{partial}</p>
                ) : null}
                <p className="mt-2 text-[11px] text-faint">
                  {state.autoStop ? "说完会自动结束；不想发就点「停」" : "说完点「停」，或按 Esc 取消这一句"}
                </p>
              </>
            )}
          </div>
        ) : null}

        {thinking || speaking ? (
          <div className="flex items-center gap-3 px-5 pb-4">
            <ThinkingDots />
            <p className="min-w-0 flex-1 text-[12px] text-faint">
              {thinking ? "我在捋你的意思，马上就好。" : "我在说，随时可以打断。"}
            </p>
            <button
              type="button"
              onClick={() => void bridge.interrupt()}
              className="no-drag h-7 shrink-0 rounded-[9px] bg-muted px-2.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              打断
            </button>
          </div>
        ) : null}

        <div className="px-5 pb-1">
          <div className="mb-1 text-[11px] text-faint">最近</div>
          <div key={pending?.id ?? (state.queuedCount ? "queued" : "idle")} className="motion-fade space-y-0.5">
            {pending ? <Row label="待处理" value={`1 条待确认 · ${tailEllipsis(pending.title, 10)}`} accent /> : null}
            {!pending && state.queuedCount > 0 ? <Row label="待处理" value={`${state.queuedCount} 条排队`} accent /> : null}
            {running ? (
              <Row label="在跑" value={tailEllipsis(running, 18)} detail={state.foregroundDetail ?? undefined} accent />
            ) : null}
            {state.selectedCount !== null ? <Row label="选中" value={`${state.selectedCount} 个文件`} /> : null}
            {state.lastRun ? (
              <Row
                label="上次"
                value={`${tailEllipsis(state.lastRun.title, 12)} · ${STATE_LABELS[state.lastRun.state]}`}
              />
            ) : null}
            {empty ? <p className="py-2 text-[12px] text-faint">还没有在跑的事。</p> : null}
          </div>
        </div>

        <div className="no-drag flex items-center gap-2 px-5 pt-3 pb-4">
          {listening ? (
            <button
              type="button"
              onClick={() => void bridge.overlayStopVoice()}
              className="flex h-9 items-center gap-1.5 rounded-[12px] bg-acorn px-3.5 text-[13px] font-medium text-background"
            >
              <Square className="size-3 fill-current" /> 停
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void bridge.overlayAsk()}
              className="flex h-9 items-center gap-1.5 rounded-[12px] bg-primary px-3.5 text-[13px] font-medium text-primary-foreground"
            >
              <Mic className="size-3.5" /> 说一句
            </button>
          )}
          <button
            type="button"
            onClick={() => void bridge.overlayOpenMain()}
            className="flex h-9 items-center gap-1.5 rounded-[12px] bg-secondary px-3.5 text-[13px] text-secondary-foreground hover:bg-surface-highest"
          >
            <ArrowUpRight className="size-3.5" /> 打开主窗
          </button>
          <span className="ml-auto text-[11px] text-faint">
            {state.lastRun ? formatRelative(Date.now() - state.lastRun.ageMs) : "刚刚"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 三颗跳动的点：表示"在想"，比转圈更安静 */
function ThinkingDots(): React.JSX.Element {
  return (
    <span className="flex items-end gap-1" aria-hidden>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 rounded-full bg-acorn/80"
          style={{ animation: `pulse-dot 1s ease-in-out ${index * 0.15}s infinite` }}
        />
      ))}
    </span>
  );
}

/** 16 根条，中间的更高；高度完全由实时电平决定，说话才会跳 */
function Bars({ level }: { level: number }): React.JSX.Element {
  const bars = 16;
  return (
    <div className="flex h-10 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }, (_, index) => {
        const center = 1 - Math.abs(index - (bars - 1) / 2) / ((bars - 1) / 2);
        const weight = 0.32 + center * 0.68;
        const height = Math.max(3, Math.round((3 + level * 34) * weight));
        return (
          <span
            key={index}
            className="w-[3px] rounded-full bg-acorn/85 transition-[height] duration-75 ease-out"
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

function Row({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail?: string;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-14 shrink-0 text-[13px] text-faint">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate text-[14px]", accent ? "text-acorn" : "text-foreground")}>
        {value}
      </span>
      {detail ? <span className="shrink-0 text-[11px] text-faint">{detail}</span> : null}
    </div>
  );
}
