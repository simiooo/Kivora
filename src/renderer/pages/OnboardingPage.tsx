import { useEffect, useRef, useState } from "react";
import { Check, Mic, PlugZap } from "lucide-react";
import type { Bootstrap } from "@shared/ipc.ts";
import type { AppConfig, ModelRecord } from "@shared/domain.ts";
import { formatHotkey } from "@shared/text.ts";
import { DEFAULT_PARAMS } from "@shared/domain.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { Recorder, listMics, type MicDevice } from "../lib/audio.ts";
import { cn } from "../lib/utils.ts";
import { Button, Chip, Field, Input, Spinner, Switch, useToast } from "../components/ui.tsx";

const STEPS = [
  { title: "连接模型", hint: "至少配一个能说话的模型，否则它只能按字面做事。" },
  { title: "麦克风与热键", hint: "选一个麦克风，确认热键。这决定你以后怎么叫它。" },
  { title: "完成", hint: "随时可以跳过，之后在设置里改。" },
];

export function OnboardingPage({
  bootstrap,
  onConfig,
  onFinish,
  onSkip,
}: {
  bootstrap: Bootstrap;
  onConfig: (patch: Partial<AppConfig>) => Promise<void>;
  onFinish: () => Promise<void>;
  onSkip: () => Promise<void>;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [bound, setBound] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 引导页没有自己的标题栏，留一条整宽的拖拽带 */}
      <div className="drag-region h-11 w-full shrink-0" data-drag="1" />
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-border/60 px-8 pb-8">
        <div className="mb-10 flex items-center gap-2">
          <span className="size-2 rounded-full bg-acorn" />
          <span className="text-[13px] font-medium">Kivora</span>
        </div>
        <p className="mb-6 text-[12px] text-faint">第 {step + 1} 步，共 {STEPS.length} 步</p>
        <ol className="space-y-3">
          {STEPS.map((item, index) => (
            <li key={item.title} className="flex items-center gap-3">
              <span
                className={cn(
                  "grid size-6 place-items-center rounded-full text-[11px]",
                  index < step
                    ? "bg-positive-container text-positive"
                    : index === step
                      ? "bg-acorn text-background"
                      : "bg-muted text-faint",
                )}
              >
                {index < step ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className={cn("text-[14px]", index === step ? "text-foreground" : "text-muted-foreground")}>
                {item.title}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-auto text-[11px] leading-5 text-faint">随时可以跳过，之后在设置里改。</p>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] px-10 py-10">
          <h1 className="text-[26px] font-semibold tracking-tight">{STEPS[step].title}</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">{STEPS[step].hint}</p>

          <div className="mt-8">
            {step === 0 ? (
              <ConnectStep
                model={model}
                onModel={(next, isBound) => {
                  setModel(next);
                  setBound(isBound);
                }}
              />
            ) : null}
            {step === 1 ? (
              <MicStep
                hotkey={bootstrap.config.hotkey}
                onHotkey={(value) =>
                  bridge
                    .setHotkey(value)
                    .then(() => undefined)
                    .catch((err) => {
                      throw err;
                    })
                }
              />
            ) : null}
            {step === 2 ? <DoneStep model={model} bound={bound} bootstrap={bootstrap} onConfig={onConfig} /> : null}
          </div>

          <div className="mt-10 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                if (step < STEPS.length - 1) setStep((value) => value + 1);
                else void onSkip();
              }}
              className="text-[12px] text-faint hover:text-foreground"
            >
              跳过这一步
            </button>
            <div className="ml-auto flex items-center gap-2">
              {step > 0 ? (
                <Button variant="ghost" onClick={() => setStep((value) => value - 1)}>
                  上一步
                </Button>
              ) : null}
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  if (step < STEPS.length - 1) {
                    setStep((value) => value + 1);
                    return;
                  }
                  setBusy(true);
                  void onFinish().finally(() => setBusy(false));
                }}
              >
                {step === STEPS.length - 1 ? "开始使用" : "下一步"}
              </Button>
            </div>
          </div>
        </div>
      </main>
      </div>
    </div>
  );
}

function ConnectStep({
  model,
  onModel,
}: {
  model: ModelRecord | null;
  onModel: (model: ModelRecord, bound: boolean) => void;
}): React.JSX.Element {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [modelId, setModelId] = useState("deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const connect = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    try {
      const saved = await bridge.saveModel({
        // 重复点「测试连接」不应该堆出一堆同名模型
        id: model?.id,
        name: modelId.trim() || "主模型",
        provider: "openai",
        capability: "chat",
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        modelId: modelId.trim(),
        params: { ...DEFAULT_PARAMS },
        headers: [],
        apiKey: apiKey.trim() || undefined,
      });
      const testResult = await bridge.testModel(saved.id);
      const real = testResult.ok && !testResult.simulated;
      setResult({
        ok: real,
        text: real
          ? `连接正常 · ${testResult.latencyMs}ms`
          : testResult.ok
            ? "模拟通过：没填 Key，不会真的发请求，所以也不会绑上去"
            : (testResult.error?.message ?? "连接失败"),
      });
      if (real) {
        // 真连上了才绑定：调度和任务共用这个模型，否则任务会话还在用种子模型
        await bridge.bindModel("brain", saved.id);
        await bridge.bindModel("task", saved.id);
        onModel(saved, true);
        toast.push({ tone: "success", title: "模型接上了", detail: "已绑定调度 LLM 和任务模型" });
      } else if (testResult.ok) {
        // 只是保存，不动绑定；等填了 Key 再连
        onModel(saved, false);
      }
    } catch (err) {
      const ui = toUiError(err);
      setResult({ ok: false, text: ui.detail ?? ui.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <Field label="Base URL" hint="OpenAI 兼容端点，留到 /v1 这一级。">
        <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
      </Field>
      <Field label="模型 ID">
        <Input value={modelId} onChange={(event) => setModelId(event.target.value)} spellCheck={false} />
      </Field>
      <Field label="API Key" hint="存在 Windows 凭据管理器里，不写配置文件。">
        <Input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-…"
          autoComplete="off"
        />
      </Field>

      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => void connect()} disabled={testing}>
          {testing ? <Spinner className="size-3.5" /> : <PlugZap className="size-3.5" />}
          {testing ? "测试中…" : "测试连接"}
        </Button>
        {model ? <Chip tone="positive">已接上 {model.name}</Chip> : null}
      </div>

      {result ? (
        <p className={cn("mt-3 text-[12px]", result.ok ? "text-positive" : "text-destructive")}>{result.text}</p>
      ) : null}

      <p className="mt-8 text-[11px] leading-5 text-faint">
        先跳过也行：mock 模式会把整条流程走通，只是不真的发请求。
      </p>
    </div>
  );
}

function MicStep({
  hotkey,
  onHotkey,
}: {
  hotkey: string;
  onHotkey: (value: string) => Promise<void>;
}): React.JSX.Element {
  const toast = useToast();
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [micId, setMicId] = useState("");
  const [accelerator, setAccelerator] = useState(hotkey);
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef(new Recorder());
  const [level, setLevel] = useState(0);

  useEffect(() => {
    void listMics().then((devices) => {
      setMics(devices);
      if (devices[0]) setMicId(devices[0].id);
    });
  }, []);

  const audition = async (): Promise<void> => {
    if (recording) {
      setRecording(false);
      try {
        const clip = await recorder.current.stop();
        const result = await bridge.transcribe(clip.base64, clip.mime, false);
        if (result.error) {
          setError(result.error.message);
          setTranscript(null);
          return;
        }
        setTranscript(result.text || "（没听到内容）");
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    try {
      setError(null);
      setTranscript(null);
      setRecording(true);
      await recorder.current.start(micId || undefined, setLevel);
      window.setTimeout(() => {
        if (recorder.current.active) void audition();
      }, 3000);
    } catch (err) {
      setRecording(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <Field label="麦克风">
        <select
          value={micId}
          onChange={(event) => setMicId(event.target.value)}
          className="h-11 w-full appearance-none rounded-[12px] bg-input px-4 text-[14px] text-foreground outline-none"
        >
          {mics.length === 0 ? <option value="">没有找到麦克风</option> : null}
          {mics.map((device) => (
            <option key={device.id} value={device.id} className="bg-card">
              {device.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="唤醒热键" hint="冲突时会提示换一个。">
        <div className="flex gap-2">
          <Input
            value={formatHotkey(accelerator)}
            onChange={(event) => setAccelerator(event.target.value)}
            className="font-mono text-[13px]"
            spellCheck={false}
          />
          <Button
            variant="secondary"
            onClick={() => {
              void onHotkey(accelerator.trim())
                .then(() => toast.push({ tone: "success", title: "热键换了" }))
                .catch((err) => toast.push({ tone: "error", title: "热键没改成", detail: toUiError(err).message }));
            }}
          >
            应用
          </Button>
        </div>
      </Field>

      <Field label="试一句" hint="录三秒，能听到就算通了。">
        <div className="rounded-[16px] bg-card px-4 py-5">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => void audition()}
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-full transition-colors",
                recording ? "bg-acorn text-background" : "bg-secondary text-foreground hover:bg-surface-highest",
              )}
              aria-label={recording ? "停止" : "开始试音"}
            >
              <Mic className="size-4" />
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: 12 }, (_, index) => (
                <span
                  key={index}
                  className="w-[3px] rounded-full bg-acorn/80"
                  style={{ height: Math.max(4, Math.round((0.3 + level) * 22 * (1 - Math.abs(index - 5.5) / 7))) }}
                />
              ))}
            </div>
            <span className="text-[12px] text-faint">
              {recording ? "在录……" : transcript ? `听到：「${transcript}」` : "按住说一句，能听到就算通了"}
            </span>
          </div>
          {error ? <p className="mt-3 text-[12px] text-destructive">{error}</p> : null}
        </div>
      </Field>

      <p className="rounded-[12px] bg-sunken px-4 py-3 text-[11px] leading-5 text-faint">
        热键冲突时会提示你换一个；麦克风权限在 Windows 设置里给。
      </p>
    </div>
  );
}

function DoneStep({
  model,
  bound,
  bootstrap,
  onConfig,
}: {
  model: ModelRecord | null;
  bound: boolean;
  bootstrap: Bootstrap;
  onConfig: (patch: Partial<AppConfig>) => Promise<void>;
}): React.JSX.Element {
  const mock = bootstrap.config.mockMode;
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null);

  useEffect(() => {
    void Promise.all([bridge.listModels(), bridge.listBindings()])
      .then(([models, bindings]) => {
        const hasKey = (module: "asr" | "tts"): boolean => {
          const binding = bindings.find((item) => item.module === module);
          const bound = models.find((item) => item.id === binding?.modelId);
          return Boolean(bound?.hasKey);
        };
        setVoiceReady(hasKey("asr") && hasKey("tts"));
      })
      .catch(() => setVoiceReady(false));
  }, []);

  return (
    <div className="space-y-2">
      <Row label="模型" value={model ? `${model.name} · ${model.modelId}` : "还没连"} />
      <Row
        label="绑定"
        value={bound ? "调度 LLM + 任务模型" : model ? "还没绑定（没真正连上）" : "沿用模型仓库里的默认绑定"}
      />
      <Row label="热键" value={formatHotkey(bootstrap.config.hotkey)} />
      <Row label="审批" value={bootstrap.config.permissionWindow ? "浮窗 + 语音都能答" : "只在主窗里出卡片"} />

      <div className="mt-4 rounded-[12px] bg-card px-4 py-3">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-foreground">用真实模型</div>
            <p className="mt-1 text-[12px] leading-5 text-faint">
              {mock
                ? voiceReady === false
                  ? "语音识别 / 合成还没配 Key：现在只能留在演练模式，去设置 → 模型里补上再回来打开。"
                  : "现在还是演练模式：转写用内置句子、任务按脚本走，模型只在「测试连接」时用过。打开后才会真的发请求。"
                : "已经在用真实端点。识别和合成也要有 Key，否则语音这一路会报错——在设置 → 模型里配。"}
            </p>
          </div>
          <Switch
            checked={!mock}
            label="用真实模型"
            disabled={voiceReady === false && mock}
            onChange={(value) => void onConfig({ mockMode: !value })}
          />
        </div>
      </div>

      <p className="pt-4 text-[12px] leading-6 text-muted-foreground">
        按热键说一句就行。说「刚才那个做完了吗」能查进度，说「停」能停，说「先做这个」会插队。
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-[12px] bg-card px-4 py-3">
      <span className="w-16 shrink-0 text-[12px] text-faint">{label}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{value}</span>
    </div>
  );
}
