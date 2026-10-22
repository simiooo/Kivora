import { ArrowRight, X } from "lucide-react";

/** 画板 11：影响全局的配置错误放在顶部 44px 横幅，给"去设置" */
export function Banner({
  text,
  actionLabel,
  onAction,
  onDismiss,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive-container px-5">
      <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-destructive">{text}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="flex shrink-0 items-center gap-1 text-[12px] text-destructive hover:underline"
        >
          {actionLabel}
          <ArrowRight className="size-3.5" />
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="忽略"
          onClick={onDismiss}
          className="grid size-6 shrink-0 place-items-center rounded-full text-destructive/70 hover:bg-destructive/10"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
