import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Play, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { Bootstrap } from "@shared/ipc.ts";
import type { AppConfig, Grant, McpCapability, McpPreset, McpServerView } from "@shared/domain.ts";
import { displayPath, formatHotkey, formatRelative, formatTime } from "@shared/text.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { useLiveData } from "../lib/hooks.ts";
import { cn } from "../lib/utils.ts";
import { Button, Chip, Dot, Empty, Field, Input, SectionLabel, ToggleRow, useToast } from "../components/ui.tsx";
import { ModelsPanel } from "../components/models-panel.tsx";

const NAV: Array<{ label: string; route: string; key: string }> = [
  { label: "通用", route: "/settings", key: "general" },
  { label: "模型", route: "/settings/models", key: "models" },
  { label: "语音", route: "/settings/voice", key: "voice" },
  { label: "扩展", route: "/settings/extensions", key: "extensions" },
  { label: "权限", route: "/settings/permissions", key: "permissions" },
  { label: "关于", route: "/settings/about", key: "about" },
];

function sectionOf(route: string): string {
  const tail = route.replace(/^\/settings\/?/, "").split("/")[0];
  return tail || "general";
}

export function SettingsPage({
  bootstrap,
  route,
  navigate,
  onConfig,
}: {
  bootstrap: Bootstrap;
  route: string;
  navigate: (route: string) => void;
  onConfig: (patch: Partial<AppConfig>) => Promise<void>;
}): React.JSX.Element {
  const active = sectionOf(route);

  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border/60">
        <header
          className="flex h-12 items-center gap-2 px-6"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          <span className="size-2 rounded-full bg-acorn" />
          <span className="text-[13px] font-medium">Kivora</span>
        </header>

        <nav className="px-3">
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.route)}
              className={cn(
                "mb-0.5 flex w-full items-center rounded-[12px] px-3.5 py-2.5 text-left text-[13px] transition-colors",
                active === item.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-auto p-4">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => navigate("/")}>
            回到时间线
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-10 pb-16 pt-8">
          {active === "models" ? <ModelsPanel /> : null}
          {active === "general" ? <GeneralSection bootstrap={bootstrap} onConfig={onConfig} /> : null}
          {active === "voice" ? <VoiceSection bootstrap={bootstrap} onConfig={onConfig} /> : null}
          {active === "extensions" ? <ExtensionsSection /> : null}
          {active === "permissions" ? <PermissionsSection bootstrap={bootstrap} onConfig={onConfig} /> : null}
          {active === "about" ? <AboutSection bootstrap={bootstrap} /> : null}
          {!["models", "general", "voice", "extensions", "permissions", "about"].includes(active) ? (
            <Empty title="没有这一页" hint="从左边选一个设置项。" />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-4 rounded-[16px] bg-card px-5 py-2">{children}</div>;
}

function Segmented({
  active,
  disabled,
  onClick,
  label,
  detail,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  detail: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-[140px] flex-col items-start rounded-[12px] px-3.5 py-2 text-left transition-colors",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground",
        disabled && "opacity-40",
      )}
    >
      <span className="text-[13px] font-medium">{label}</span>
      <span className={cn("mt-0.5 text-[11px]", active ? "text-primary-foreground/70" : "text-faint")}>{detail}</span>
    </button>
  );
}

/* ------------------------------------------------------------- 通用 */

function GeneralSection({
  bootstrap,
  onConfig,
}: {
  bootstrap: Bootstrap;
  onConfig: (patch: Partial<AppConfig>) => Promise<void>;
}): React.JSX.Element {
  const toast = useToast();
  const [hotkey, setHotkey] = useState(bootstrap.config.hotkey);
  const [retention, setRetention] = useState(String(bootstrap.config.retentionDays));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHotkey(bootstrap.config.hotkey);
    setRetention(String(bootstrap.config.retentionDays));
  }, [bootstrap.config.hotkey, bootstrap.config.retentionDays]);

  const patch = useCallback(
    async (next: Partial<AppConfig>) => {
      try {
        await onConfig(next);
      } catch (err) {
        toast.push({ tone: "error", title: "没保存上", detail: toUiError(err).message });
      }
    },
    [onConfig, toast],
  );

  return (
    <div>
      <SectionHeader title="通用" subtitle="怎么叫醒它、在哪儿存东西。" />

      <Field
        label="唤醒热键"
        hint="冲突时会提示换一个。改完立刻生效，不用重启。"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void bridge
                .setHotkey(hotkey.trim())
                .then((result) => {
                  toast.push({ tone: "success", title: `热键改成 ${formatHotkey(result.hotkey)}` });
                })
                .catch((err) => toast.push({ tone: "error", title: "热键没改成", detail: toUiError(err).message }));
            }}
          >
            应用
          </Button>
        }
      >
        <Input
          value={formatHotkey(hotkey)}
          onChange={(event) => setHotkey(event.target.value)}
          className="font-mono text-[13px]"
          spellCheck={false}
        />
      </Field>

      <Field
        label="任务执行器"
        hint={
          bootstrap.config.taskRuntime === "pi"
            ? "Pi 会话有自己的文件与命令工具，审批总线管不到它。只在自己信任的机器上开。"
            : "内置执行器只做文件整理，所有动作都走审批。"
        }
      >
        <div className="flex gap-2">
          <Segmented
            active={bootstrap.config.taskRuntime === "builtin"}
            onClick={() => void patch({ taskRuntime: "builtin" })}
            label="内置"
            detail="文件整理，走审批"
          />
          <Segmented
            active={bootstrap.config.taskRuntime === "pi"}
            disabled={!bootstrap.state.piAvailable}
            onClick={() => void patch({ taskRuntime: "pi" })}
            label="Pi 会话"
            detail={
              bootstrap.state.piAvailable
                ? `pi ${bootstrap.state.piVersion ?? ""} · 未接入审批`
                : "没检测到 pi"
            }
          />
        </div>
      </Field>

      <Card>
        <ToggleRow
          title="演练模式"
          description="不发真实请求：转写用内置句子，语音只播提示音，任务按脚本走。关掉后文件整理会真的动文件，每一步都要你确认。"
          checked={bootstrap.config.mockMode}
          onChange={(value) => void patch({ mockMode: value })}
        />
        <ToggleRow
          title="先出声"
          description="模型一有文字就先播第一句；没有旁白时用缓存短句顶上。关掉就只在结束时说话。"
          checked={bootstrap.config.narration}
          onChange={(value) => void patch({ narration: value })}
        />
        <ToggleRow
          title="缓存应答"
          description="「好」「我看一下」这类固定短句只合成一次，之后复用。"
          checked={bootstrap.config.ackEnabled}
          onChange={(value) => void patch({ ackEnabled: value })}
        />
        <ToggleRow
          title="审批浮窗"
          description="有审批时在右下角弹浮窗，语音和 GUI 都能答。关掉只在主窗时间线里出卡片。"
          checked={bootstrap.config.permissionWindow}
          onChange={(value) => void patch({ permissionWindow: value })}
        />
        <ToggleRow
          title="开机自启"
          description="登录 Windows 后自动常驻。"
          checked={bootstrap.config.launchAtLogin}
          onChange={(value) => void patch({ launchAtLogin: value })}
        />
      </Card>

      <Field label="本地保留" hint="事件和审计只留这么多天，消息不删。">
        <div className="flex items-center gap-3">
          <Input
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            onBlur={() => {
              const value = Number(retention);
              if (!Number.isFinite(value) || value < 1 || value > 90) {
                toast.push({ tone: "error", title: "保留天数要在 1 到 90 之间" });
                setRetention(String(bootstrap.config.retentionDays));
                return;
              }
              if (value !== bootstrap.config.retentionDays) void patch({ retentionDays: Math.round(value) });
            }}
            className="w-24 text-center font-mono"
            inputMode="numeric"
          />
          <span className="text-[12px] text-faint">天</span>
        </div>
      </Field>

      <Field label="数据库">
        <div className="flex items-center gap-2 rounded-[12px] bg-sunken px-3 py-2.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {displayPath(bootstrap.state.dbPath, 64)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(bootstrap.state.dbPath);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------- 语音 */

function VoiceSection({
  bootstrap,
  onConfig,
}: {
  bootstrap: Bootstrap;
  onConfig: (patch: Partial<AppConfig>) => Promise<void>;
}): React.JSX.Element {
  const toast = useToast();
  const models = useLiveData(() => bridge.listModels(), ["models"]);
  const bindings = useLiveData(() => bridge.listBindings(), ["models"]);
  const [playing, setPlaying] = useState(false);

  const asrModel = useMemo(() => {
    const binding = (bindings.data ?? []).find((item) => item.module === "asr");
    return (models.data ?? []).find((model) => model.id === binding?.modelId) ?? null;
  }, [bindings.data, models.data]);

  const ttsModel = useMemo(() => {
    const binding = (bindings.data ?? []).find((item) => item.module === "tts");
    return (models.data ?? []).find((model) => model.id === binding?.modelId) ?? null;
  }, [bindings.data, models.data]);

  return (
    <div>
      <SectionHeader title="语音" subtitle="识别和合成的具体参数；模型本身在「模型」页里配。" />

      <Field label="识别语言" hint="自动会多花一点时间，但中英混说更准。">
        <div className="flex gap-2">
          {(
            [
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
              { value: "auto", label: "自动" },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                void onConfig({ asrLanguage: option.value }).catch((err) =>
                  toast.push({ tone: "error", title: "没保存上", detail: toUiError(err).message }),
                );
              }}
              className={cn(
                "h-9 rounded-[10px] px-3 text-[12px] transition-colors",
                bootstrap.config.asrLanguage === option.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>

      <Card>
        <div className="flex items-center gap-3 border-b border-border/60 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px]">识别模型</div>
            <p className="mt-1 text-[12px] text-faint">
              {asrModel ? `${asrModel.name} · ${asrModel.baseUrl}` : "还没绑定"}
            </p>
          </div>
          <Chip tone={asrModel?.hasKey ? "positive" : "neutral"}>{asrModel?.hasKey ? "有 Key" : "缺 Key"}</Chip>
        </div>

        <div className="flex items-center gap-3 border-b border-border/60 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px]">合成模型</div>
            <p className="mt-1 text-[12px] text-faint">
              {ttsModel
                ? `${ttsModel.name} · ${ttsModel.params.voice ?? "默认音色"} · ${ttsModel.params.speed ?? 1}x`
                : "还没绑定"}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={playing}
            onClick={() => {
              setPlaying(true);
              void bridge
                .speak("我是 Kivora，这样说话。")
                .then((clip) => {
                  if (!clip.ok || !clip.audioBase64) {
                    toast.push({ tone: "error", title: "没合成出来", detail: clip.error?.message });
                    return;
                  }
                  const audio = new Audio(`data:${clip.mime};base64,${clip.audioBase64}`);
                  void audio.play().catch(() => undefined);
                })
                .catch((err) => toast.push({ tone: "error", title: "试听失败", detail: toUiError(err).message }))
                .finally(() => setPlaying(false));
            }}
          >
            <Play className="size-3.5" /> 试听
          </Button>
        </div>

        <div className="py-4 text-[11px] leading-5 text-faint">
          {bootstrap.config.mockMode
            ? "mock 模式下不会真的合成，只会播一段提示音。"
            : "音色和语速在模型详情里改（语音合成类模型的那两个参数）。"}
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- 扩展 */

function ExtensionsSection(): React.JSX.Element {
  const toast = useToast();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [cap, setCap] = useState<McpCapability | null>(null);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void Promise.all([bridge.listMcpServers(), bridge.mcpCapability(), bridge.mcpPresets()])
      .then(([list, capability, presetList]) => {
        setServers(list);
        setCap(capability);
        setPresets(presetList);
      })
      .catch((err) => toast.push({ tone: "error", title: "读不到扩展配置", detail: toUiError(err).message }));
    // 只在进这一页时读一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (action: () => Promise<McpServerView[]>, okTitle: string): Promise<void> => {
    try {
      setServers(await action());
      toast.push({ tone: "success", title: okTitle, detail: "Pi 任务会话启动时会自动加载这些服务器。" });
    } catch (err) {
      toast.push({ tone: "error", title: "没保存上", detail: toUiError(err).message });
    }
  };

  const addPreset = (preset: McpPreset): void => {
    const exists = servers.find((server) => server.name === `kivora-${preset.server.name}`);
    void apply(
      () => bridge.saveMcpServer(preset.server, exists?.name),
      exists ? `已更新「${preset.label}」` : `已添加「${preset.label}」`,
    );
  };

  const addCustom = (): void => {
    const parsedArgs = args
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    void apply(
      () =>
        bridge.saveMcpServer({
          name: name.trim() || "custom",
          command: command.trim(),
          args: parsedArgs,
          env: {},
          enabled: true,
        }),
      "已保存自定义服务器",
    ).then(() => {
      setName("");
      setArgs("");
    });
  };

  const remove = (serverName: string): void => {
    void apply(() => bridge.deleteMcpServer(serverName), "已删除");
  };

  return (
    <div>
      <SectionHeader
        title="扩展能力"
        subtitle="CUA 和浏览器不自己造：交给 Pi 的 MCP 扩展，Kivora 只负责写配置。"
      />

      <div className="mb-4 rounded-[16px] bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-1.5">
            <Dot tone={cap?.available ? "positive" : "danger"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-foreground">
              {cap ? (cap.available ? "Pi 支持 MCP" : "Pi 还不支持 MCP") : "正在检查…"}
            </div>
            <p className="mt-1 text-[12px] leading-5 text-faint">{cap?.reason}</p>
            {cap ? (
              <p className="mt-1 truncate font-mono text-[11px] text-faint">{displayPath(cap.file, 64)}</p>
            ) : null}
          </div>
          {cap && !cap.available ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText("pi update self");
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "已复制" : "复制更新命令"}
            </Button>
          ) : null}
        </div>
      </div>

      <SectionLabel>已配置的服务器</SectionLabel>
      <div className="space-y-2">
        {servers.map((server) => (
          <div key={server.name} className="rounded-[12px] bg-card px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-foreground">{server.name}</span>
              <Chip tone={server.managed ? "neutral" : "muted"}>{server.managed ? "Kivora 写的" : "别处配的"}</Chip>
              <span className="text-[11px] text-faint">{server.enabled ? "启用" : "已停用"}</span>
              {server.managed ? (
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => remove(server.name)}>
                  删除
                </Button>
              ) : (
                <span className="ml-auto text-[11px] text-faint">不在 Kivora 里改</span>
              )}
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-faint">
              {server.command} {server.args.join(" ")}
            </p>
            {server.description ? (
              <p className="mt-0.5 truncate text-[11px] text-faint">{server.description}</p>
            ) : null}
          </div>
        ))}
        {servers.length === 0 ? (
          <p className="rounded-[12px] bg-card px-4 py-5 text-[12px] text-faint">
            还没有服务器。加一个桌面控制或浏览器，Pi 会话就能用它们。
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {presets.map((preset) => (
          <Button key={preset.key} variant="secondary" size="sm" onClick={() => addPreset(preset)}>
            <Plus className="size-3.5" /> {preset.label}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-faint">
        {presets.map((preset) => `${preset.label}：${preset.hint}`).join("；")}
      </p>

      <div className="mt-6">
        <SectionLabel>自定义 stdio 服务器</SectionLabel>
        <div className="grid grid-cols-[120px_1fr_auto] gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="名字" className="h-9 text-[12px]" />
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="命令"
              className="h-9 font-mono text-[12px]"
            />
            <Input
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="参数，空格分隔"
              className="h-9 font-mono text-[12px]"
            />
          </div>
          <Button variant="primary" size="sm" onClick={addCustom} disabled={!command.trim()}>
            添加
          </Button>
        </div>
      </div>

      <p className="mt-6 rounded-[12px] bg-sunken px-4 py-3 text-[11px] leading-5 text-faint">
        MCP 工具也在 pi 的工具循环里：点击、输入、打开这类动作会经 Kivora 的权限扩展先问你，读页面和截图不问。cua-driver 另有 bounded 模式兜底。
        浏览器只用来读页面时风险较低。真正需要"动手"的操作，建议还是走内置执行器的审批。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- 权限 */
function PermissionsSection({
  bootstrap,
  onConfig,
}: {
  bootstrap: Bootstrap;
  onConfig: (patch: Partial<AppConfig>) => Promise<void>;
}): React.JSX.Element {
  const toast = useToast();
  const grants = useLiveData<Grant[]>(() => bridge.listGrants(), ["approvals"]);
  const [timeout, setTimeoutValue] = useState(String(bootstrap.config.approvalTimeoutSec));

  useEffect(() => {
    setTimeoutValue(String(bootstrap.config.approvalTimeoutSec));
  }, [bootstrap.config.approvalTimeoutSec]);

  return (
    <div>
      <SectionHeader title="权限" subtitle="哪些事必须停下来问你，问多久。" />

      <Card>
        <ToggleRow
          title="审批浮窗"
          description="不抢焦点、出现在右下角；和主窗里的卡片是同一条总线。"
          checked={bootstrap.config.permissionWindow}
          onChange={(value) => {
            void onConfig({ permissionWindow: value }).catch((err) =>
              toast.push({ tone: "error", title: "没保存上", detail: toUiError(err).message }),
            );
          }}
        />
        <ToggleRow
          title="危险操作也走语音"
          description="装软件、UAC、支付、凭据这类（G3）默认只能手动点，打开后语音也能答——不建议。"
          checked={bootstrap.config.g3Voice}
          onChange={(value) => {
            void onConfig({ g3Voice: value }).catch((err) =>
              toast.push({ tone: "error", title: "没保存上", detail: toUiError(err).message }),
            );
          }}
        />
      </Card>

      <Field
        label="多久没回答算拒绝"
        hint="G1 最多 30 秒、G2 最多 60 秒，G3 永不自动超时。"
      >
        <div className="flex items-center gap-3">
          <Input
            value={timeout}
            onChange={(event) => setTimeoutValue(event.target.value)}
            onBlur={() => {
              const value = Number(timeout);
              if (!Number.isFinite(value) || value < 10 || value > 300) {
                toast.push({ tone: "error", title: "超时要在 10 到 300 秒之间" });
                setTimeoutValue(String(bootstrap.config.approvalTimeoutSec));
                return;
              }
              if (value !== bootstrap.config.approvalTimeoutSec) {
                void onConfig({ approvalTimeoutSec: Math.round(value) });
              }
            }}
            className="w-24 text-center font-mono"
            inputMode="numeric"
          />
          <span className="text-[12px] text-faint">秒</span>
        </div>
      </Field>

      <div className="mb-2 mt-8 flex items-center">
        <span className="text-[12px] font-medium text-faint">已记住的授权</span>
        {(grants.data ?? []).length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              void bridge
                .revokeGrants()
                .then(() => toast.push({ tone: "info", title: "全部吊销了" }))
                .catch((err) => toast.push({ tone: "error", title: "吊销失败", detail: toUiError(err).message }));
            }}
          >
            <Trash2 className="size-3.5" /> 全部吊销
          </Button>
        ) : null}
      </div>

      <div className="space-y-2">
        {(grants.data ?? []).map((grant) => (
          <div key={grant.id} className="flex items-center gap-3 rounded-[12px] bg-card px-4 py-3">
            <ShieldCheck className="size-4 shrink-0 text-positive" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-foreground">{grant.tool}</div>
              <p className="truncate text-[11px] text-faint">
                {grant.scope === "any" ? "这一类操作" : grant.scope} · {grant.value}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-faint">
              {grant.expiresAt ? `${formatTime(grant.expiresAt)} 到期` : formatRelative(grant.createdAt)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void bridge
                  .revokeGrants(grant.sessionId ?? undefined)
                  .then(() => toast.push({ tone: "info", title: "已吊销" }))
                  .catch((err) => toast.push({ tone: "error", title: "吊销失败", detail: toUiError(err).message }));
              }}
            >
              吊销
            </Button>
          </div>
        ))}
        {(grants.data ?? []).length === 0 ? (
          <p className="rounded-[12px] bg-card px-4 py-5 text-[12px] text-faint">
            还没有记住任何授权。选「以后都行」时会写一条，会话结束就失效。
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 关于 */

function AboutSection({ bootstrap }: { bootstrap: Bootstrap }): React.JSX.Element {
  const rows: Array<[string, string]> = [
    ["版本", `${bootstrap.state.version}（schema v${bootstrap.state.schemaVersion}）`],
    ["Electron", bootstrap.state.electron],
    ["Node", bootstrap.state.node],
    ["Pi 内核", bootstrap.state.piAvailable ? `已安装 ${bootstrap.state.piVersion ?? ""}` : "未检测到（任务用内置执行器）"],
    [
      "任务执行器",
      bootstrap.config.mockMode
        ? "演练模式（不发真实请求）"
        : bootstrap.config.taskRuntime === "pi"
          ? "Pi 会话"
          : "内置（文件整理）",
    ],
    ["凭据", bootstrap.state.secretsAvailable ? "Windows 凭据管理器（DPAPI）" : "不可用，Key 以明文存本地"],
    ["数据库", displayPath(bootstrap.state.dbPath, 56)],
    ["数据目录", displayPath(bootstrap.state.dataDir, 56)],
  ];

  return (
    <div>
      <SectionHeader title="关于" subtitle="这一版能做什么、跑在什么上面。" />
      <div className="mb-6 rounded-[16px] bg-card px-5 py-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center gap-4 border-b border-border/50 py-3 last:border-b-0">
            <span className="w-20 shrink-0 text-[12px] text-faint">{label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{value}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void bridge.openExternal("https://github.com/simiooo/Kivora")}
        >
          <ExternalLink className="size-3.5" /> 仓库
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void bridge.openExternal("https://opensource.org/license/mit")}>
          MIT 许可
        </Button>
      </div>

      <p className="mt-6 text-[11px] leading-5 text-faint">
        语音层只做调度：它判断你的意思、把活派给独立会话、把结果说回来。真正的操作在会话里做，
        每一步都进事件流，随时能查「卡在哪一步」。
      </p>
    </div>
  );
}
