import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import type { SessionDetail, SessionListItem } from "@shared/ipc.ts";
import { STATE_LABELS } from "@shared/domain.ts";
import { dayBucket, formatDuration, formatTime, formatFullTime, tailEllipsis } from "@shared/text.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { useLiveData } from "../lib/hooks.ts";
import { cn } from "../lib/utils.ts";
import { Button, Chip, Dot, Empty, IconButton, Spinner, useToast } from "../components/ui.tsx";
import { FailureCard } from "../components/timeline.tsx";

const STATE_TONE = {
  done: "positive",
  failed: "danger",
  aborted: "danger",
  running: "acorn",
  starting: "acorn",
  waiting_user: "acorn",
  paused: "neutral",
  queued: "neutral",
} as const;

export function HistoryPage({
  route,
  navigate,
}: {
  route: string;
  navigate: (route: string) => void;
}): React.JSX.Element {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedId = route.split("/")[2] ?? null;

  const sessions = useLiveData<SessionListItem[]>(() => bridge.listSessions(query.trim() || undefined), [
    "sessions",
    "timeline",
  ], { key: query });

  const detail = useLiveData<SessionDetail | null>(
    async () => (selectedId ? bridge.getSession(selectedId) : null),
    ["sessions", "timeline", "approvals"],
    { enabled: Boolean(selectedId), key: selectedId ?? "" },
  );

  useEffect(() => {
    if (!selectedId && sessions.data && sessions.data.length > 0) {
      navigate(`/history/${sessions.data[0].id}`);
    }
  }, [navigate, selectedId, sessions.data]);

  const groups = useMemo(() => {
    const buckets = new Map<string, SessionListItem[]>();
    for (const session of sessions.data ?? []) {
      const key = dayBucket(session.updatedAt);
      const list = buckets.get(key) ?? [];
      list.push(session);
      buckets.set(key, list);
    }
    return [...buckets.entries()];
  }, [sessions.data]);

  const remove = useCallback(async () => {
    if (!selectedId) return;
    try {
      await bridge.deleteSession(selectedId);
      toast.push({ tone: "info", title: "已删除" });
      navigate("/history");
    } catch (err) {
      toast.push({ tone: "error", title: "删除失败", detail: toUiError(err).message });
    } finally {
      setConfirmDelete(false);
    }
  }, [navigate, selectedId, toast]);

  const exportSession = useCallback(() => {
    if (!detail.data) return;
    const { session, events, messages } = detail.data;
    const lines = [
      `# ${session.title}`,
      `id: ${session.id}`,
      `状态: ${STATE_LABELS[session.state]}`,
      `时长: ${formatDuration(session.status.elapsedMs)}`,
      "",
      "## 事件",
      ...events.map((event) => `${formatTime(event.ts)}  ${event.summary}`),
      "",
      "## 对话",
      ...messages.map((message) => `${message.role === "user" ? "你" : "Kivora"}: ${message.content}`),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kivora-${session.id}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [detail.data]);

  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border/60">
        <header
          className="flex h-12 items-center gap-2 pr-4 pl-6"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <span className="size-2 rounded-full bg-acorn" />
          <span className="text-[13px] font-medium">Kivora</span>
          <div className="ml-auto" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <IconButton label="新建会话" onClick={() => navigate("/")}>
              <Plus className="size-4" />
            </IconButton>
          </div>
        </header>

        <div className="px-4 pb-3">
          <div className="flex h-9 items-center gap-2 rounded-[12px] bg-muted px-3">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话、消息…"
              className="h-full w-full bg-transparent text-[12px] outline-none placeholder:text-faint"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          {sessions.loading && !sessions.data ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : null}
          {groups.map(([label, items]) => (
            <div key={label} className="mb-3">
              <div className="px-2 py-1.5 text-[11px] text-faint">{label}</div>
              {items.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => navigate(`/history/${session.id}`)}
                  className={cn(
                    "mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-[12px] px-3 py-2.5 text-left transition-colors",
                    selectedId === session.id ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {tailEllipsis(session.title, 14)}
                    </span>
                    <Dot tone={STATE_TONE[session.state]} />
                  </div>
                  <span className="text-[11px] text-faint">
                    {session.state === "running"
                      ? `运行中 · 第 ${Math.max(1, session.turn)} 轮`
                      : session.state === "queued"
                        ? "排队中 · 等前一个结束"
                        : session.state === "failed"
                          ? `${formatTime(session.updatedAt)} · 失败`
                          : `${formatTime(session.updatedAt)} · ${formatDuration(session.elapsedMs)}${
                              session.artifactCount ? ` · ${session.artifactCount} 个文件` : ""
                            }`}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {(sessions.data ?? []).length === 0 && !sessions.loading ? (
            <Empty title="还没有会话" hint="说一句话就会开一个。" />
          ) : null}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-10 pb-16 pt-4">
          {!selectedId ? (
            <Empty title="从左边选一个会话" hint="每个会话都有完整的事件流和对话。" />
          ) : detail.loading && !detail.data ? (
            <div className="flex justify-center py-20">
              <Spinner />
            </div>
          ) : !detail.data ? (
            <Empty title="这个会话不在了" hint="可能已经被删除。" action={<Button variant="secondary" onClick={() => navigate("/history")}>返回列表</Button>} />
          ) : (
            <SessionView
              detail={detail.data}
              onRetry={(mode) => {
                void bridge
                  .retryTask(detail.data!.session.id, mode)
                  .then(() => toast.push({ tone: "info", title: "重试已开始" }))
                  .catch((err) => toast.push({ tone: "error", title: "重试失败", detail: toUiError(err).message }));
              }}
              onResume={() => {
                void bridge
                  .resumeTask(detail.data!.session.id)
                  .then(() => toast.push({ tone: "info", title: "已开始接着做" }))
                  .catch((err) => toast.push({ tone: "error", title: "续做失败", detail: toUiError(err).message }));
              }}
              onCompact={() => {
                void bridge
                  .compactTask(detail.data!.session.id)
                  .then((result) => toast.push({ tone: "success", title: `压缩完成：${result.before} → ${result.after} tokens` }))
                  .catch((err) => toast.push({ tone: "error", title: "压缩失败", detail: toUiError(err).message }));
              }}
              onExport={exportSession}
              onDelete={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
              confirmDelete={confirmDelete}
              onBack={() => navigate("/")}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function SessionView({
  detail,
  onRetry,
  onResume,
  onExport,
  onCompact,
  onDelete,
  confirmDelete,
  onBack,
}: {
  detail: SessionDetail;
  onRetry: (mode: "continue" | "restart") => void;
  onResume: () => void;
  onExport: () => void;
  onCompact: () => void;
  onDelete: () => void;
  confirmDelete: boolean;
  onBack: () => void;
}): React.JSX.Element {
  const { session, events, messages } = detail;
  const active = ["running", "starting", "waiting_user", "queued", "paused"].includes(session.state);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <IconButton label="返回" onClick={onBack} className="-ml-2">
          <ArrowLeft className="size-4" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold tracking-tight">{session.title}</h1>
        <Chip tone={STATE_TONE[session.state]}>{STATE_LABELS[session.state]}</Chip>
      </div>
      <p className="mb-5 pl-8 text-[12px] text-faint">
        {session.id} · {session.runner === "pi" ? "Pi 会话" : "内置执行器"} · {formatFullTime(session.createdAt)} ·{" "}
        {formatDuration(session.status.elapsedMs)}
        {session.status.artifacts.length ? ` · ${session.status.artifacts.length} 个文件` : ""}
        {session.tokensIn + session.tokensOut > 0
          ? ` · ${((session.tokensIn + session.tokensOut) / 1000).toFixed(1)}k tokens`
          : ""}
      </p>

      {session.error ? (
        <FailureCard
          session={session}
          onRetry={() => onRetry("continue")}
          onAlternative={() => onRetry("restart")}
          onLogs={() => {
            document.getElementById("session-error-detail")?.scrollIntoView({ block: "center" });
          }}
        />
      ) : null}

      <section className="mt-5">
        <h2 className="mb-2 text-[12px] font-medium text-faint">事件</h2>
        <div className="border-t border-border/50">
          {events.map((event) => (
            <div key={event.id} className="flex items-baseline gap-4 border-b border-border/40 py-2">
              <span className="w-11 shrink-0 font-mono text-[11px] tabular-nums text-faint/70">
                {formatTime(event.ts)}
              </span>
              <span
                className={cn(
                  "text-[13px]",
                  event.type === "failed"
                    ? "text-destructive"
                    : event.type === "done"
                      ? "text-positive"
                      : "text-muted-foreground",
                )}
              >
                {event.summary}
              </span>
            </div>
          ))}
          {events.length === 0 ? <p className="py-3 text-[12px] text-faint">还没有事件。</p> : null}
        </div>
      </section>

      {session.error?.detail ? (
        <section id="session-error-detail" className="mt-4 rounded-[12px] bg-sunken px-4 py-3">
          <p className="mb-1 text-[11px] text-faint">原始错误</p>
          <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">
            {session.error.detail}
          </pre>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-2 text-[12px] font-medium text-faint">对话</h2>
        {messages.length === 0 ? (
          <p className="py-3 text-[12px] text-faint">这个会话没有对话，只有事件。</p>
        ) : (
          messages.map((message) => (
            <article key={message.id} className="py-2.5">
              <div className="mb-1 flex items-baseline gap-2">
                <span className={cn("text-[12px] font-medium", message.role === "user" ? "text-faint" : "text-acorn")}>
                  {message.role === "user" ? "你" : "Kivora"}
                </span>
                <span className="text-[11px] tabular-nums text-faint/70">{formatTime(message.ts)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-[15px] leading-7">{message.content}</p>
            </article>
          ))
        )}
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
        {active ? (
          <Button variant="secondary" size="sm" onClick={onResume}>
            继续
          </Button>
        ) : session.state === "done" ? (
          <Button variant="secondary" size="sm" onClick={() => onRetry("restart")}>
            <RotateCcw className="size-3.5" /> 再做一次
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => onRetry("continue")}>
            <RotateCcw className="size-3.5" /> 重试
          </Button>
        )}
        {session.runner === "pi" && active ? (
          <Button variant="secondary" size="sm" onClick={onCompact}>
            压缩
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onClick={onExport}>
          <Download className="size-3.5" /> 导出
        </Button>
        <Button
          variant={confirmDelete ? "danger" : "ghost"}
          size="sm"
          onClick={onDelete}
          className="ml-auto"
        >
          <Trash2 className="size-3.5" /> {confirmDelete ? "再点一次确认删除" : "删除"}
        </Button>
      </div>
    </div>
  );
}
