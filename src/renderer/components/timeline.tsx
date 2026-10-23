import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, RotateCcw, ShieldAlert, Wrench } from "lucide-react";
import type { Approval, ApprovalResolution, Message, Session, SessionEvent } from "@shared/domain.ts";
import { STATE_LABELS } from "@shared/domain.ts";
import {
  countChars,
  displayPath,
  formatDuration,
  formatTime,
  foldOutput,
  tailEllipsis,
} from "@shared/text.ts";
import { cn } from "../lib/utils.ts";
import { useNow } from "../lib/hooks.ts";
import { Button, Chip, Dot } from "./ui.tsx";

/* ------------------------------------------------------------ 长文 */

const LONG_THRESHOLD = 260;

export function isLongText(text: string): boolean {
  return countChars(text) > LONG_THRESHOLD || text.split("\n").length > 6;
}

export function LongText({
  text,
  onExpand,
}: {
  text: string;
  onExpand: (text: string) => void;
}): React.JSX.Element {
  const long = isLongText(text);
  return (
    <div>
      <p className={cn("whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground", long && "line-clamp-6")}>
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => onExpand(text)}
          className="mt-1.5 text-[12px] text-faint underline-offset-4 hover:text-foreground hover:underline"
        >
          展开全文（约 {countChars(text).toLocaleString()} 字）
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ 消息 */

export function MessageRow({
  message,
  approval,
  onAnswer,
  onExpand,
  onRetryVoice,
}: {
  message: Message;
  approval: Approval | null;
  onAnswer: (id: string, resolution: ApprovalResolution) => void;
  onExpand: (text: string) => void;
  onRetryVoice: () => void;
}): React.JSX.Element {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const lowConfidence = message.confidence !== null && message.confidence < 0.7;

  return (
    <article className="py-3 motion-rise">
      <div className="mb-1 flex items-baseline gap-2">
        <span className={cn("text-[12px] font-medium", isUser ? "text-faint" : "text-acorn")}>
          {isUser ? "你" : isSystem ? "系统" : "Kivora"}
        </span>
        <span className="text-[11px] tabular-nums text-faint/70">{formatTime(message.ts)}</span>
        {message.source === "voice" && isUser ? <Chip tone="muted" className="h-4 px-1 text-[10px]">语音</Chip> : null}
      </div>

      {isSystem ? (
        <p className="text-[13px] leading-6 text-faint">{message.content}</p>
      ) : (
        <LongText text={message.content} onExpand={onExpand} />
      )}

      {lowConfidence ? (
        <p className="mt-1 text-[11px] text-faint">转写可能不准，点一下这里可以改。</p>
      ) : null}

      {message.error ? (
        <div className="mt-2 flex items-center gap-3 rounded-[12px] bg-sunken px-3 py-2">
          <Dot tone="danger" />
          <span className="text-[12px] text-muted-foreground">{message.error.message}</span>
          <button
            type="button"
            onClick={onRetryVoice}
            className="ml-auto text-[12px] text-acorn hover:underline"
          >
            按热键重说
          </button>
        </div>
      ) : null}

      {approval ? (
        <ApprovalCard approval={approval} onAnswer={onAnswer} />
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------------ 审批卡 */

export function ApprovalCard({
  approval,
  onAnswer,
}: {
  approval: Approval;
  onAnswer: (id: string, resolution: ApprovalResolution) => void;
}): React.JSX.Element {
  const now = useNow(1000);
  const [expanded, setExpanded] = useState(false);
  const pending = approval.status === "pending";
  const remaining =
    pending && approval.expiresAt ? Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)) : null;

  const shown = expanded ? approval.detail : approval.detail.slice(0, 3);
  const hidden = approval.detail.length - shown.length;

  return (
    <section
      id={`approval-${approval.id}`}
      className="motion-pop mt-3 max-w-[680px] rounded-[18px] border border-border bg-sunken px-5 py-4"
    >
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-faint">{approval.risk === "G3" ? "需要你手动确认" : "需要确认"}</span>
        {approval.risk === "G3" ? (
          <Chip tone="danger">
            <ShieldAlert className="size-3" /> 高危
          </Chip>
        ) : null}
        {remaining !== null ? (
          <span className="ml-auto text-[11px] tabular-nums text-faint">{remaining}s 后默认拒绝</span>
        ) : null}
      </div>

      <h3 className="mt-1 text-[15px] font-medium text-foreground">{approval.title}</h3>

      {approval.detail.length > 0 ? (
        <div className="mt-2 text-[12px] leading-6 text-muted-foreground">
          {shown.map((item) => (
            <span key={item} className="mr-2 inline-block max-w-full align-top">
              {displayPath(item, 46)}
            </span>
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              className="text-acorn hover:underline"
              onClick={() => setExpanded(true)}
            >
              还有 {hidden} 项（共 {approval.detail.length} 项）
            </button>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => onAnswer(approval.id, "allow_once")}>
            允许
          </Button>
          {approval.options.includes("allow_scope") ? (
            <Button variant="secondary" size="sm" onClick={() => onAnswer(approval.id, "allow_scope")}>
              以后都行
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => onAnswer(approval.id, "deny")}>
            拒绝
          </Button>
          <span className="ml-2 text-[11px] text-faint">也可以直接说「可以」或「不行」</span>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-[12px]">
          <Dot tone={approval.status === "allowed" ? "positive" : "danger"} />
          <span className="text-muted-foreground">
            {approval.status === "allowed"
              ? approval.resolution === "allow_scope"
                ? "已允许，以后这类都不再问"
                : "已允许"
              : approval.status === "expired"
                ? "超时未处理，已按拒绝执行"
                : approval.status === "cancelled"
                  ? "已取消"
                  : "已拒绝"}
          </span>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ 任务条 */

function sessionSubtitle(session: Session): string {
  const parts: string[] = [STATE_LABELS[session.state]];
  if (session.state === "running") {
    parts.push(`第 ${Math.max(1, session.status.turn)} 轮`);
    if (session.status.tool) parts.push(session.status.tool);
  } else if (session.state === "queued") {
    parts.push("等前面结束");
  } else {
    parts.push(formatDuration(session.status.elapsedMs));
    if (session.status.artifacts.length) parts.push(`${session.status.artifacts.length} 个文件`);
  }
  return parts.join(" · ");
}

export function TaskStrip({
  session,
  events,
  expanded,
  onToggle,
  onOpen,
  onRetry,
}: {
  session: Session;
  events: SessionEvent[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const failed = session.state === "failed" || session.state === "aborted";
  const tone = failed ? "danger" : session.state === "done" ? "positive" : "acorn";
  return (
    <div className="motion-fade border-t border-border/50 py-2.5 first:border-t-0">
      <div className="flex items-center gap-2.5">
        <Dot tone={tone} pulse={session.state === "running" || session.state === "starting"} />
        <span className="font-mono text-[11px] text-faint/80">{session.id.slice(0, 4)}</span>
        <button type="button" onClick={onOpen} className="truncate text-[13px] text-foreground hover:underline">
          {session.title}
        </button>
        <span className={cn("truncate text-[12px]", failed ? "text-destructive" : "text-faint")}>
          {failed && session.error ? `失败 · ${tailEllipsis(session.error.message, 22)}` : sessionSubtitle(session)}
        </span>
        {failed ? (
          <Button variant="secondary" size="sm" className="ml-2 h-7" onClick={onRetry}>
            <RotateCcw className="size-3" /> 重试
          </Button>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-faint hover:text-foreground"
        >
          查看过程
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>

      {expanded ? (
        <div className="mt-2 ml-4 border-l border-border/70 pl-3">
          {events.length === 0 ? (
            <p className="py-1 text-[12px] text-faint">还没有事件。</p>
          ) : (
            events.slice(-10).map((event) => (
              <div key={event.id} className="flex items-baseline gap-3 py-1">
                <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-faint/70">
                  {formatTime(event.ts)}
                </span>
                <span
                  className={cn(
                    "text-[12px]",
                    event.type === "failed" ? "text-destructive" : event.type === "done" ? "text-positive" : "text-muted-foreground",
                  )}
                >
                  {event.summary}
                </span>
              </div>
            ))
          )}
          <button
            type="button"
            onClick={onOpen}
            className="mt-1 flex items-center gap-1 text-[11px] text-acorn hover:underline"
          >
            在会话页看全部 <ChevronRight className="size-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ 失败卡 */

export function FailureCard({
  session,
  onRetry,
  onAlternative,
  onLogs,
}: {
  session: Session;
  onRetry: () => void;
  onAlternative: () => void;
  onLogs: () => void;
}): React.JSX.Element {
  const error = session.error;
  return (
    <section className="mt-3 max-w-[680px] rounded-[18px] border border-border bg-sunken px-5 py-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-destructive" />
        <h3 className="text-[14px] font-medium text-foreground">
          {tailEllipsis(error?.message ?? "任务失败", 36)}
        </h3>
        <span className="text-[11px] text-faint">{formatDuration(session.status.elapsedMs)}</span>
      </div>
      {error?.detail ? (
        <p className="mt-2 line-clamp-2 text-[12px] leading-6 text-muted-foreground">{error.detail}</p>
      ) : (
        <p className="mt-2 text-[12px] text-muted-foreground">原因还没拿到，可以重试一次看看。</p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={onRetry}>
          再试一次
        </Button>
        <Button variant="secondary" size="sm" onClick={onAlternative}>
          <Wrench className="size-3.5" /> 换个方法
        </Button>
        <Button variant="ghost" size="sm" onClick={onLogs}>
          看日志
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ 工具输出 */

export function ToolOutput({ value }: { value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const folded = useMemo(() => foldOutput(value, 8, 2000), [value]);

  return (
    <div className="relative mt-2 rounded-[12px] bg-sunken px-3 py-2">
      <pre className="max-h-[220px] overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">
        {folded.text}
      </pre>
      <div className="mt-1 flex items-center gap-3">
        {folded.truncated ? <span className="text-[11px] text-faint">已折叠，首尾保留</span> : null}
        <button
          type="button"
          className="ml-auto flex items-center gap-1 text-[11px] text-faint hover:text-foreground"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          <Copy className="size-3" /> {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}
