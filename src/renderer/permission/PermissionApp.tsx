import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { Approval, ApprovalResolution } from "@shared/domain.ts";
import { displayPath } from "@shared/text.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { cn } from "../lib/utils.ts";
import { usePresence } from "../lib/presence.ts";

void (async (): Promise<void> => {
  document.documentElement.classList.add("overlay-window");
})();

/** 画板 09：语音与 GUI 同权，三个按钮固定语义，30 秒倒计时 */
export function PermissionApp(): React.JSX.Element | null {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await bridge.listApprovals();
      setApproval(list.find((item) => item.status === "pending") ?? null);
    } catch {
      // 窗口刚起来时主进程可能还没登记完
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = bridge.subscribe((event) => {
      if (event.kind === "approvals" || event.kind === "sessions") void load();
    });
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [load]);

  const answer = async (resolution: ApprovalResolution): Promise<void> => {
    if (!approval || busy) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.answerApproval(approval.id, resolution);
      setApproval(null);
    } catch (err) {
      setError(toUiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const { mounted, closing } = usePresence(Boolean(approval));

  // 退场时 approval 已经变空，但动画还要用上一张卡的内容
  const lastApproval = useRef<Approval | null>(null);
  if (approval) lastApproval.current = approval;
  const card = approval ?? lastApproval.current;
  if (!card || !mounted) return null;

  const remaining = card.expiresAt ? Math.max(0, Math.ceil((card.expiresAt - now) / 1000)) : null;
  const total = card.expiresAt ? card.expiresAt - card.createdAt : null;
  const ratio = total && card.expiresAt ? Math.max(0, Math.min(1, (card.expiresAt - now) / total)) : null;
  const shown = card.detail.slice(0, 3);
  const hidden = card.detail.length - shown.length;

  return (
    <div className={cn("p-3", closing ? "motion-exit-pop" : "motion-pop")}>
      <section
        key={card.id}
        className={cn("motion-fade flex flex-col rounded-[20px] border border-white/6 bg-card p-5 shadow-float")}
      >
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-acorn" />
          <span className="text-[12px] text-faint">
            {card.risk === "G3" ? "需要你手动确认" : "需要确认"}
          </span>
          {card.risk === "G3" ? (
            <span className="flex items-center gap-1 rounded-full bg-destructive-container px-2 py-0.5 text-[11px] text-destructive">
              <ShieldAlert className="size-3" /> 高危
            </span>
          ) : null}
          {remaining !== null ? (
            <span className="ml-auto tabular-nums text-[12px] text-faint">{remaining}s</span>
          ) : null}
        </div>

        {ratio !== null ? (
          <div className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-border">
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", remaining !== null && remaining <= 10 ? "bg-destructive" : "bg-acorn")}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
        ) : null}

        <h2 className="mt-3 text-[18px] font-medium leading-7">{card.title}</h2>
        {card.sessionTitle ? (
          <p className="mt-0.5 text-[12px] text-faint">来自「{card.sessionTitle}」</p>
        ) : null}

        <div className="mt-2 max-h-[110px] overflow-y-auto text-[12px] leading-6 text-muted-foreground">
          {shown.map((item) => (
            <div key={item} className="truncate">
              {displayPath(item, 52)}
            </div>
          ))}
          {hidden > 0 ? <div className="text-acorn">还有 {hidden} 项（共 {card.detail.length} 项）</div> : null}
        </div>

        {error ? <p className="mt-2 text-[11px] text-destructive">{error}</p> : null}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer("allow_once")}
            className="h-9 rounded-[12px] bg-primary px-4 text-[13px] font-medium text-primary-foreground disabled:opacity-50"
          >
            允许一次
          </button>
          {card.options.includes("allow_scope") ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void answer("allow_scope")}
              className="h-9 rounded-[12px] bg-secondary px-3.5 text-[13px] text-secondary-foreground hover:bg-surface-highest disabled:opacity-50"
            >
              本次会话都允许
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer("deny")}
            className="h-9 rounded-[12px] bg-secondary px-3.5 text-[13px] text-secondary-foreground hover:bg-surface-highest disabled:opacity-50"
          >
            拒绝
          </button>
          <span className="ml-auto text-[11px] text-faint">说「可以」或「不行」也行</span>
        </div>
      </section>
    </div>
  );
}
