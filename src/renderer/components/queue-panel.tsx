import { X } from "lucide-react";
import type { QueueItem, Session } from "@shared/domain.ts";
import { tailEllipsis } from "@shared/text.ts";
import { Button, Chip, IconButton, Spinner } from "./ui.tsx";
import { cn } from "../lib/utils.ts";
import { usePresence } from "../lib/presence.ts";

/** 画板 07：插话 / 排队 / 执行中三态，可提前或取消 */
export function QueuePanel({
  open,
  running,
  items,
  onPromote,
  onCancel,
  onClearAll,
  onClose,
}: {
  open: boolean;
  running: Session | null;
  items: QueueItem[];
  onPromote: (id: string) => void;
  onCancel: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const { mounted, closing } = usePresence(open);
  if (!mounted) return null;
  const total = items.length + (running ? 1 : 0);

  return (
    <div
      className={cn(
        "fixed right-6 bottom-[132px] z-40 w-[440px] max-w-[calc(100vw-32px)] rounded-[18px] border border-border bg-card p-4 shadow-float",
        closing ? "motion-exit-pop" : "motion-pop",
      )}
    >
      <div className="mb-3 flex items-center">
        <h3 className="text-[15px] font-medium">待处理 {total}</h3>
        <div className="ml-auto flex items-center gap-2">
          {items.length > 0 ? (
            <button type="button" onClick={onClearAll} className="text-[12px] text-faint hover:text-foreground">
              全部取消
            </button>
          ) : null}
          <IconButton label="收起" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="space-y-1.5">
        {running ? (
          <Row
            chip={<Chip tone="positive">执行中</Chip>}
            text={running.title}
            trailing={<Spinner className="size-3.5 text-faint" />}
          />
        ) : null}
        {items.map((item) => (
          <Row
            key={item.id}
            chip={
              item.kind === "steer" ? <Chip tone="acorn">插话</Chip> : <Chip tone="neutral">排队</Chip>
            }
            text={tailEllipsis(item.text, 26)}
            trailing={
              <span className="flex items-center gap-1">
                {item.kind === "queue" ? (
                  <button
                    type="button"
                    onClick={() => onPromote(item.id)}
                    className="rounded-[8px] px-2 py-1 text-[11px] text-faint hover:bg-muted hover:text-foreground"
                  >
                    提前
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="取消这一条"
                  onClick={() => onCancel(item.id)}
                  className="grid size-6 place-items-center rounded-full text-faint hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            }
          />
        ))}
        {total === 0 ? <p className="py-6 text-center text-[12px] text-faint">队列是空的。</p> : null}
      </div>

      <p className="mt-3 text-[11px] leading-5 text-faint">
        再说一句会排到队尾；说「先做这个」会插队。任务最多排 5 条。
      </p>
    </div>
  );
}

function Row({
  chip,
  text,
  trailing,
}: {
  chip: React.ReactNode;
  text: string;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex items-center gap-3 rounded-[12px] bg-sunken px-3 py-2.5")}>
      <span className="w-[52px] shrink-0">{chip}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{text}</span>
      {trailing}
    </div>
  );
}

export function QueueBadge({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <Button variant="secondary" size="sm" className="h-7 rounded-full px-2.5 text-[11px]" onClick={onClick}>
      待处理 {count}
    </Button>
  );
}
