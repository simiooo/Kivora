import { useRef, useState } from "react";
import { Check, Copy, Quote } from "lucide-react";
import { countChars, formatFullTime } from "@shared/text.ts";
import { Button } from "./ui.tsx";
import { cn } from "../lib/utils.ts";
import { usePresence } from "../lib/presence.ts";

/** 画板 14：正文"展开全文"之后的归宿 */
export function Reader({
  open,
  text,
  meta,
  onClose,
}: {
  open: boolean;
  text: string;
  meta: { title: string; ts: number; source: "message" | "event" };
  onClose: () => void;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const { mounted, closing } = usePresence(open);

  // 退场时父组件已经把内容置空，但动画还得显示上一段
  const last = useRef({ text, meta });
  if (open) last.current = { text, meta };
  const content = open ? { text, meta } : last.current;
  if (!mounted) return null;

  const quote = (): void => {
    window.dispatchEvent(new CustomEvent("kivora:quote", { detail: content.text }));
    onClose();
  };

  return (
    <div
      className={cn("fixed inset-0 z-50 flex justify-center bg-black/50 px-6 py-8", closing ? "motion-exit-fade" : "motion-fade")}
      onMouseDown={closing ? undefined : onClose}
    >
      <section
        data-reader="1"
        className={cn(
          "flex h-full w-full max-w-[720px] flex-col rounded-[22px] border border-border bg-card shadow-dialog",
          closing ? "motion-exit-pop" : "motion-pop",
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-border/60 px-7 py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-foreground">{content.meta.title}</h2>
            <p className="mt-1 text-[12px] text-faint">
              {formatFullTime(content.meta.ts)} · 约 {countChars(content.text).toLocaleString()} 字
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[10px] px-2 py-1 text-[12px] text-faint hover:bg-muted hover:text-foreground"
          >
            关闭
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="whitespace-pre-wrap break-words text-[15px] leading-8 text-foreground">{content.text}</div>
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 px-7 py-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(content.text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "已复制" : "复制"}
          </Button>
          <Button variant="ghost" size="sm" onClick={quote}>
            <Quote className="size-3.5" /> 引用到输入框
          </Button>
          <span className="ml-auto text-[11px] text-faint">Esc 关闭</span>
        </footer>
      </section>
    </div>
  );
}
