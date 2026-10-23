import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Check, Info, Loader2, X } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { usePresence } from "../lib/presence.ts";

/* ------------------------------------------------------------ 按钮 */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:brightness-95",
  secondary: "bg-secondary text-secondary-foreground hover:bg-surface-highest",
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  danger: "text-destructive hover:bg-destructive-container",
  outline: "border border-border text-foreground hover:bg-muted",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-8 px-3 text-[12px]" : "h-9 px-4 text-[13px]",
        BUTTON_STYLES[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  className,
  children,
  label,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------ 表单 */

export function Input({
  className,
  invalid,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }): React.JSX.Element {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-[12px] bg-input px-4 text-[14px] text-foreground outline-none transition-colors placeholder:text-faint focus:bg-muted",
        invalid && "ring-1 ring-destructive/70",
        className,
      )}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-[12px] bg-input px-4 py-3 text-[14px] leading-6 text-foreground outline-none placeholder:text-faint focus:bg-muted",
        className,
      )}
      {...rest}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  action,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  action?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
      {error ? <p className="mt-1.5 text-[11px] leading-5 text-destructive">{error}</p> : null}
      {hint ? <p className="mt-1.5 text-[11px] leading-5 text-faint">{hint}</p> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-acorn" : "bg-surface-highest",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-background transition-transform",
          checked ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-6 border-b border-border/60 py-4 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-foreground">{title}</div>
        {description ? <p className="mt-1 text-[12px] leading-5 text-faint">{description}</p> : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

/* ------------------------------------------------------------ 标签 */

type Tone = "neutral" | "acorn" | "positive" | "danger" | "muted" | "faint";

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  acorn: "bg-acorn-container text-acorn",
  positive: "bg-positive-container text-positive",
  danger: "bg-destructive-container text-destructive",
  muted: "text-faint",
  faint: "text-faint",
};

export function Chip({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[11px] font-medium",
        TONE_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = "faint", pulse }: { tone?: Tone; pulse?: boolean }): React.JSX.Element {
  const color =
    tone === "acorn"
      ? "bg-acorn"
      : tone === "positive"
        ? "bg-positive"
        : tone === "danger"
          ? "bg-destructive"
          : "bg-hairline-strong";
  return (
    <span className="relative grid size-2 place-items-center">
      {pulse ? <span className={cn("absolute size-2 animate-ping rounded-full opacity-40", color)} /> : null}
      <span className={cn("size-2 rounded-full", color)} />
    </span>
  );
}

/* ------------------------------------------------------------ 反馈 */

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <Loader2 className={cn("size-4 animate-spin text-faint", className)} />;
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-[14px] text-muted-foreground">{title}</p>
      {hint ? <p className="max-w-[320px] text-[12px] leading-5 text-faint">{hint}</p> : null}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------ Toast */

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  title: string;
  detail?: string;
}

interface ToastContextValue {
  push: (toast: Omit<Toast, "id">) => void;
}

const ToastContext = createContext<ToastContextValue>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leaving, setLeaving] = useState<number[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setLeaving((prev) => (prev.includes(id) ? prev : [...prev, id]));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
      setLeaving((prev) => prev.filter((item) => item !== id));
    }, 140);
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((prev) => [...prev.slice(-2), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), toast.tone === "error" ? 6000 : 3200);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex flex-col items-center gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex w-[420px] max-w-[calc(100vw-48px)] items-start gap-3 rounded-[14px] border border-border bg-card px-4 py-3 shadow-float",
              leaving.includes(toast.id) ? "motion-exit-pop" : "motion-pop",
            )}
          >
            <span className="mt-0.5">
              {toast.tone === "error" ? (
                <AlertTriangle className="size-4 text-destructive" />
              ) : toast.tone === "success" ? (
                <Check className="size-4 text-positive" />
              ) : (
                <Info className="size-4 text-muted-foreground" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-[13px]", toast.tone === "error" ? "text-destructive" : "text-foreground")}>
                {toast.title}
              </p>
              {toast.detail ? (
                <p className="mt-0.5 break-words text-[11px] leading-5 text-faint line-clamp-3">{toast.detail}</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

/* ------------------------------------------------------------ 面板 */

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  footer,
  width = 520,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  width?: number;
  children: ReactNode;
}): React.JSX.Element | null {
  const { mounted, closing } = usePresence(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-end bg-black/40",
        closing ? "motion-exit-fade" : "motion-fade",
      )}
      onMouseDown={closing ? undefined : onClose}
    >
      <section
        style={{ width }}
        className={cn(
          "flex h-full max-w-[92vw] flex-col rounded-l-[22px] bg-card shadow-dialog",
          closing ? "motion-exit-sheet" : "motion-sheet",
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-4 px-6 pt-5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-foreground">{title}</h2>
            {subtitle ? <div className="mt-1 text-[12px] text-faint">{subtitle}</div> : null}
          </div>
          <IconButton label="关闭" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer ? <footer className="shrink-0 border-t border-border/70 px-6 py-4">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{children}</kbd>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="mb-2 text-[12px] font-medium text-faint">{children}</div>;
}
