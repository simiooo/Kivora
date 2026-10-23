import { useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { acceleratorFromKey, describeModifiers } from "@shared/hotkey.ts";
import { formatHotkey } from "@shared/text.ts";
import { cn } from "../lib/utils.ts";

/**
 * 热键捕获框：点一下聚焦，直接按组合键，松开就填进去。
 * 不弹对话框、不需要手打 "Ctrl+Alt+K" 这种字符串。
 */
export function HotkeyInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (accelerator: string) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [held, setHeld] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const stop = (): void => {
    setCapturing(false);
    setHeld("");
    ref.current?.blur();
  };

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label="唤醒热键，点击后按下组合键"
      tabIndex={disabled ? -1 : 0}
      data-hotkey-input="1"
      onClick={() => {
        if (disabled) return;
        setCapturing(true);
        ref.current?.focus();
      }}
      onFocus={() => {
        if (!disabled) setCapturing(true);
      }}
      onBlur={stop}
      onKeyDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.stopPropagation();

        if (event.key === "Escape") {
          stop();
          return;
        }

        setHeld(describeModifiers(event));
        const accelerator = acceleratorFromKey({
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        });
        if (accelerator) {
          onChange(accelerator);
          setCapturing(false);
          setHeld("");
          ref.current?.blur();
        }
      }}
      className={cn(
        "flex h-11 w-full cursor-text items-center gap-2 rounded-[12px] px-4 text-[14px] outline-none transition-colors",
        capturing ? "bg-muted ring-1 ring-acorn/60" : "bg-input hover:bg-muted/70",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Keyboard className={cn("size-3.5 shrink-0", capturing ? "text-acorn" : "text-faint")} />
      {capturing ? (
        <span className={cn("font-mono text-[13px]", held ? "text-foreground" : "text-faint")}>
          {held ? `${held} + …` : "按下组合键…（Esc 取消）"}
        </span>
      ) : (
        <span className="font-mono text-[13px] text-foreground">{formatHotkey(value)}</span>
      )}
      {!capturing ? (
        <span className="ml-auto text-[11px] text-faint">点一下，然后按组合键</span>
      ) : null}
    </div>
  );
}
