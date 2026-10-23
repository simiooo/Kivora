import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Settings2, Sparkles } from "lucide-react";
import type { Bootstrap, Message, Session } from "@shared/ipc.ts";
import type { ApprovalResolution, SessionEvent } from "@shared/domain.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { useLiveData } from "../lib/hooks.ts";
import { formatHotkey } from "@shared/text.ts";
import { Chip, Dot, IconButton, useToast } from "../components/ui.tsx";
import { MessageRow, TaskStrip } from "../components/timeline.tsx";
import { Composer } from "../components/composer.tsx";
import { QueuePanel } from "../components/queue-panel.tsx";
import { Reader } from "../components/reader.tsx";
import { Banner } from "../components/banner.tsx";

const EXAMPLES = [
  "把下载目录里上周的 pdf 挪到文档/发票",
  "帮我在京东搜机械键盘，按销量排",
  "读一下未读消息",
  "刚才那个做完了吗",
];

export function TimelinePage({
  bootstrap,
  navigate,
}: {
  bootstrap: Bootstrap;
  navigate: (route: string) => void;
}): React.JSX.Element {
  const toast = useToast();
  const [listening, setListening] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [reader, setReader] = useState<{ text: string; title: string; ts: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const userScrolled = useRef(false);

  const messages = useLiveData<Message[]>(() => bridge.listTimeline(120), ["timeline"]);
  const tasks = useLiveData<Session[]>(() => bridge.listActiveTasks(), ["sessions"]);
  const approvals = useLiveData(() => bridge.listApprovals(), ["approvals"]);
  const queue = useLiveData(() => bridge.listQueue(), ["queue", "sessions"]);
  const models = useLiveData(() => bridge.listModels(), ["models"]);
  const bindings = useLiveData(() => bridge.listBindings(), ["models"]);

  const approvalMap = useMemo(() => {
    const map = new Map<string, NonNullable<typeof approvals.data>[number]>();
    for (const approval of approvals.data ?? []) map.set(approval.id, approval);
    return map;
  }, [approvals.data]);

  const running = useMemo(
    () => (tasks.data ?? []).find((task) => task.state === "running" || task.state === "starting") ?? null,
    [tasks.data],
  );
  const pendingCount = useMemo(
    () => (approvals.data ?? []).filter((approval) => approval.status === "pending").length,
    [approvals.data],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.data?.length]);

  const loadEvents = useCallback(async (sessionId: string) => {
    try {
      const detail = await bridge.getSession(sessionId);
      setEvents((prev) => ({ ...prev, [sessionId]: detail.events }));
    } catch (err) {
      toast.push({ tone: "error", title: "读不到过程日志", detail: toUiError(err).message });
    }
  }, [toast]);

  const answer = useCallback(
    async (id: string, resolution: ApprovalResolution) => {
      try {
        await bridge.answerApproval(id, resolution);
      } catch (err) {
        toast.push({ tone: "error", title: "审批没送出去", detail: toUiError(err).message });
      }
    },
    [toast],
  );

  const configIssue = useMemo(() => {
    if (!bootstrap.state.secretsAvailable) {
      return { text: "系统凭据服务不可用，API Key 现在只能以明文保存在本地数据库里。", action: "看设置" };
    }
    const list = bindings.data ?? [];
    const all = models.data ?? [];
    for (const module of ["brain", "asr", "tts", "task"] as const) {
      const binding = list.find((item) => item.module === module);
      if (!binding) return { text: `「${module}」还没有绑定模型，语音这一路会降级。`, action: "去设置" };
      const model = all.find((item) => item.id === binding.modelId);
      if (!model) return { text: `绑定的模型被删掉了，「${module}」需要重新选一个。`, action: "去设置" };
      if (!model.hasKey && model.provider !== "custom") {
        return { text: `「${model.name}」还没有 API Key，${module} 用不了。`, action: "去设置" };
      }
    }
    return null;
  }, [bindings.data, models.data, bootstrap.state.secretsAvailable]);

  const send = useCallback(
    async (text: string) => {
      try {
        await bridge.send(text);
      } catch (err) {
        toast.push({ tone: "error", title: "这句没送出去", detail: toUiError(err).message });
      }
    },
    [toast],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <header
        className="drag-region flex h-12 shrink-0 items-center gap-2.5 pr-[152px] pl-6"
        data-drag="1"
      >
        <Dot tone={listening ? "acorn" : running ? "acorn" : "faint"} pulse={listening || Boolean(running)} />
        <span className="text-[13px] font-medium tracking-tight">Kivora</span>
        <span className="text-[12px] text-faint">
          {listening ? "在听" : running ? `在想 · ${running.title}` : "待命"}
        </span>

        <div className="no-drag ml-auto flex items-center gap-2">
          <Chip tone="muted" className="font-mono">
            {formatHotkey(bootstrap.config.hotkey)}
          </Chip>
          {pendingCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                const first = (approvals.data ?? []).find((item) => item.status === "pending");
                if (first) {
                  document.getElementById(`approval-${first.id}`)?.scrollIntoView({ block: "center" });
                }
              }}
              className="rounded-full bg-acorn-container px-2 py-0.5 text-[11px] text-acorn"
            >
              {pendingCount} 个问题
            </button>
          ) : null}
          <IconButton label="会话记录" onClick={() => navigate("/history")}>
            <History className="size-4" />
          </IconButton>
          <IconButton label="设置" onClick={() => navigate("/settings")}>
            <Settings2 className="size-4" />
          </IconButton>
        </div>
      </header>

      {configIssue ? (
        <Banner text={configIssue.text} actionLabel={configIssue.action} onAction={() => navigate("/settings")} />
      ) : null}

      <main
        ref={scrollRef}
        onWheel={() => {
          userScrolled.current = true;
        }}
        onPointerDown={() => {
          userScrolled.current = true;
        }}
        onScroll={() => {
          const element = scrollRef.current;
          if (!element || !userScrolled.current) return;
          // 只有本来就贴着底部时才自动跟随，免得把人正在读的长文顶走
          nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[820px] px-8 pb-6 pt-1">
          {messages.loading && messages.data === null ? (
            <div className="py-20 text-center text-[12px] text-faint">正在读时间线…</div>
          ) : null}

          {(messages.data ?? []).map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              approval={message.approvalId ? approvalMap.get(message.approvalId) ?? null : null}
              onAnswer={answer}
              onExpand={(text) =>
                setReader({
                  text,
                  title: message.role === "user" ? "你说的" : "Kivora 的回复",
                  ts: message.ts,
                })
              }
              onRetryVoice={() => navigate("/")}
            />
          ))}

          {(messages.data ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <Sparkles className="mb-3 size-5 text-acorn" />
              <p className="text-[15px] text-foreground">
                按 {formatHotkey(bootstrap.config.hotkey)} 说一句话，我会开独立会话去做。
              </p>
              <p className="mt-1 text-[12px] text-faint">说完再按一次热键结束；语音层只负责调度和回话。</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => void send(example)}
                    className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {(tasks.data ?? []).length > 0 ? (
            <section className="mt-6 border-t border-border/50 pt-1">
              {(tasks.data ?? []).map((task) => (
                <TaskStrip
                  key={task.id}
                  session={task}
                  events={events[task.id] ?? []}
                  expanded={expanded === task.id}
                  onToggle={() => {
                    const next = expanded === task.id ? null : task.id;
                    setExpanded(next);
                    if (next && !events[task.id]) void loadEvents(task.id);
                  }}
                  onOpen={() => navigate(`/history/${task.id}`)}
                  onRetry={() => {
                    void bridge
                      .retryTask(task.id, "continue")
                      .then(() => toast.push({ tone: "info", title: `重试「${task.title}」` }))
                      .catch((err) => toast.push({ tone: "error", title: "重试失败", detail: toUiError(err).message }));
                  }}
                />
              ))}
            </section>
          ) : null}

          {(tasks.data ?? []).length === 0 && (messages.data ?? []).length > 0 ? (
            <p className="mt-8 text-[12px] text-faint">
              没有在跑的任务。{(approvals.data ?? []).some((item) => item.status === "pending") ? "有一个审批在等你。" : ""}
            </p>
          ) : null}
        </div>
      </main>

      <Composer
        busy={false}
        runningTitle={running?.title ?? null}
        queueCount={(queue.data ?? []).length}
        onOpenQueue={() => setQueueOpen(true)}
        onSent={() => undefined}
        onListeningChange={setListening}
      />

      <QueuePanel
        open={queueOpen}
        running={running}
        items={queue.data ?? []}
        onPromote={(id) => {
          void bridge.promoteQueued(id).catch((err) =>
            toast.push({ tone: "error", title: "提前失败", detail: toUiError(err).message }),
          );
        }}
        onCancel={(id) => {
          void bridge.cancelQueued(id).catch((err) =>
            toast.push({ tone: "error", title: "取消失败", detail: toUiError(err).message }),
          );
        }}
        onClearAll={() => {
          void bridge.clearQueue().catch((err) =>
            toast.push({ tone: "error", title: "清空失败", detail: toUiError(err).message }),
          );
        }}
        onClose={() => setQueueOpen(false)}
      />

      <Reader
        open={Boolean(reader)}
        text={reader?.text ?? ""}
        meta={{ title: reader?.title ?? "", ts: reader?.ts ?? Date.now(), source: "message" }}
        onClose={() => setReader(null)}
      />
    </div>
  );
}
