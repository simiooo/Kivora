import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Mic } from "lucide-react";
import type { OverlayState } from "@shared/domain.ts";
import { STATE_LABELS } from "@shared/domain.ts";
import { formatHotkey, formatRelative, tailEllipsis } from "@shared/text.ts";
import { bridge } from "../lib/bridge.ts";
import { cn } from "../lib/utils.ts";

void (async (): Promise<void> => {
  document.documentElement.classList.add("overlay-window");
})();

export function OverlayApp(): React.JSX.Element | null {
  const [state, setState] = useState<OverlayState | null>(null);
  const [visible, setVisible] = useState(true);

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
      if (["overlay", "approvals", "sessions", "queue"].includes(event.kind)) void load();
    });
  }, [load]);

  const pending = state?.pendingApproval ?? null;
  const active = Boolean(state?.listening || pending || (state?.queuedCount ?? 0) > 0 || state?.foreground);

  useEffect(() => {
    if (!state) return;
    if (!active) {
      setVisible(false);
      void bridge.overlayHide();
    } else {
      setVisible(true);
    }
  }, [active, state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") void bridge.overlayHide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state || !visible) return null;

  return (
    <div className="flex h-full flex-col justify-end gap-3 p-3">
      {state.listening ? (
        <div className="flex h-14 shrink-0 items-center gap-3 rounded-full bg-[#1b1d1a] px-5 shadow-float">
          <span className="size-2 rounded-full bg-acorn" />
          <span className="text-[17px] font-medium text-foreground">在听</span>
          <div className="flex items-end gap-[3px]">
            {[0, 1, 2, 3, 4].map((index) => (
              <span
                key={index}
                className={cn("w-[3px] rounded-full bg-acorn/80", index % 2 === 0 ? "h-4" : "h-6")}
                style={{ animation: `wave 1.1s ease-in-out ${index * 0.09}s infinite` }}
              />
            ))}
          </div>
          <span className="ml-auto font-mono text-[12px] text-faint">
            {formatHotkey(state.hotkey)}
          </span>
        </div>
      ) : null}

      <div className="shrink-0 rounded-[18px] border border-white/5 bg-card p-5 shadow-float">
        <div className="mb-3 flex items-center gap-2">
          <span className="size-2 rounded-full bg-acorn" />
          <span className="text-[15px] font-medium">Kivora</span>
          <span className="ml-auto text-[11px] text-faint">
            {state.lastRun ? formatRelative(Date.now() - state.lastRun.ageMs) : "刚刚"}
          </span>
        </div>

        <div className="mb-1 text-[11px] text-faint">最近</div>
        <div className="space-y-0.5">
          {pending ? (
            <Row label="待处理" value={`1 条待确认 · ${tailEllipsis(pending.title, 10)}`} accent />
          ) : state.queuedCount > 0 ? (
            <Row label="待处理" value={`${state.queuedCount} 条排队`} accent />
          ) : null}
          {state.foreground ? (
            <Row label="在跑" value={tailEllipsis(state.foreground, 18)} detail={state.foregroundDetail ?? undefined} accent />
          ) : null}
          {state.selectedCount !== null ? <Row label="选中" value={`${state.selectedCount} 个文件`} /> : null}
          {state.lastRun ? (
            <Row
              label="上次"
              value={`${tailEllipsis(state.lastRun.title, 12)} · ${STATE_LABELS[state.lastRun.state]}`}
            />
          ) : null}
          {!pending && state.queuedCount === 0 && !state.foreground && !state.lastRun ? (
            <p className="py-2 text-[12px] text-faint">还没有在跑的事。</p>
          ) : null}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void bridge.overlayAsk()}
            className="flex h-9 items-center gap-1.5 rounded-[12px] bg-primary px-3.5 text-[13px] font-medium text-primary-foreground"
          >
            <Mic className="size-3.5" /> 说一句
          </button>
          <button
            type="button"
            onClick={() => void bridge.overlayOpenMain()}
            className="flex h-9 items-center gap-1.5 rounded-[12px] bg-secondary px-3.5 text-[13px] text-secondary-foreground hover:bg-surface-highest"
          >
            <ArrowUpRight className="size-3.5" /> 打开主窗
          </button>
        </div>
      </div>
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
