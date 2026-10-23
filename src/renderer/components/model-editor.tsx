import { useEffect, useMemo, useState } from "react";
import { Check, FlaskConical, Plus, X } from "lucide-react";
import type { Capability, HeaderPair, ModelDraft, ModelRecord, ProviderKind } from "@shared/domain.ts";
import { DEFAULT_PARAMS } from "@shared/domain.ts";
import type { ModelPreset } from "@shared/ipc.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { formatTime } from "@shared/text.ts";
import { Button, Field, IconButton, Input, Sheet, useToast } from "./ui.tsx";
import { cn } from "../lib/utils.ts";

interface EditorState {
  name: string;
  provider: ProviderKind;
  capability: Capability;
  baseUrl: string;
  modelId: string;
  temperature: string;
  maxTokens: string;
  topP: string;
  voice: string;
  speed: string;
  headers: HeaderPair[];
  apiKey: string;
  keyTouched: boolean;
}

function fromModel(model: ModelRecord | null, presets: ModelPreset[]): EditorState {
  const params = model?.params ?? DEFAULT_PARAMS;
  return {
    name: model?.name ?? "",
    provider: model?.provider ?? presets[0]?.provider ?? "openai",
    capability: model?.capability ?? presets[0]?.capability ?? "chat",
    baseUrl: model?.baseUrl ?? presets[0]?.baseUrl ?? "https://api.openai.com/v1",
    modelId: model?.modelId ?? "",
    temperature: params.temperature === null ? "" : String(params.temperature),
    maxTokens: params.maxTokens === null ? "" : String(params.maxTokens),
    topP: params.topP === null ? "" : String(params.topP),
    voice: params.voice ?? "alloy",
    speed: params.speed === null ? "" : String(params.speed),
    headers: model?.headers ?? [],
    apiKey: "",
    keyTouched: false,
  };
}

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ModelEditor({
  open,
  model,
  presets,
  onClose,
  onSaved,
}: {
  open: boolean;
  model: ModelRecord | null;
  presets: ModelPreset[];
  onClose: () => void;
  onSaved: (model: ModelRecord) => void;
}): React.JSX.Element | null {
  const toast = useToast();
  const [state, setState] = useState<EditorState>(() => fromModel(model, presets));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<ModelRecord | null>(model);

  useEffect(() => {
    if (!open) return;
    setState(fromModel(model, presets));
    setSaved(model);
    setError(null);
    setTestResult(null);
  }, [open, model, presets]);

  const update = (patch: Partial<EditorState>): void => setState((prev) => ({ ...prev, ...patch }));

  const buildDraft = (): ModelDraft | null => {
    if (!state.name.trim()) {
      setError("给它起个名字。");
      return null;
    }
    if (!/^(https?|wss?):\/\/[^\s]+$/i.test(state.baseUrl.trim())) {
      setError("地址要以 http:// / https:// / wss:// 开头。");
      return null;
    }
    if (!state.modelId.trim()) {
      setError("模型 ID 不能空着。");
      return null;
    }
    const badHeader = state.headers.find(
      (header) => !header.name.trim() || !/^[A-Za-z0-9_.-]+$/.test(header.name.trim()),
    );
    if (badHeader) {
      setError("请求头名字只能有字母、数字、- _ .");
      return null;
    }
    setError(null);
    return {
      id: model?.id,
      name: state.name.trim(),
      provider: state.provider,
      capability: state.capability,
      baseUrl: state.baseUrl.trim().replace(/\/+$/, ""),
      modelId: state.modelId.trim(),
      params: {
        temperature: state.capability === "chat" ? parseNumber(state.temperature) : null,
        maxTokens: state.capability === "chat" ? parseNumber(state.maxTokens) : null,
        topP: state.capability === "chat" ? parseNumber(state.topP) : null,
        voice: state.capability === "tts" ? state.voice.trim() || null : null,
        speed: state.capability === "tts" ? parseNumber(state.speed) : null,
      },
      headers: state.headers
        .filter((header) => header.name.trim())
        .map((header) => ({ name: header.name.trim(), value: header.value })),
      apiKey: state.keyTouched ? (state.apiKey.trim() ? state.apiKey.trim() : null) : undefined,
    };
  };

  const save = async (): Promise<ModelRecord | null> => {
    const draft = buildDraft();
    if (!draft) return null;
    setSaving(true);
    try {
      const record = await bridge.saveModel(draft);
      setSaved(record);
      onSaved(record);
      toast.push({ tone: "success", title: `已保存「${record.name}」` });
      return record;
    } catch (err) {
      const ui = toUiError(err);
      setError(ui.detail ?? ui.message);
      toast.push({ tone: "error", title: "没保存上", detail: ui.message });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    let target = saved;
    if (!target) {
      target = await save();
      if (!target) return;
    } else {
      const draft = buildDraft();
      if (!draft) return;
      // 先落盘再测，避免"测的是旧配置"
      try {
        target = await bridge.saveModel(draft);
        setSaved(target);
        onSaved(target);
      } catch (err) {
        setError(toUiError(err).message);
        return;
      }
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await bridge.testModel(target.id);
      setTestResult({
        ok: result.ok,
        text: result.ok
          ? `${result.simulated ? "模拟通过" : "通过"} · 延迟 ${result.latencyMs}ms`
          : `${result.error?.message ?? "连接失败"}`,
      });
      toast.push({
        tone: result.ok ? "success" : "error",
        title: result.ok ? "连接正常" : "连接失败",
        detail: result.ok ? `延迟 ${result.latencyMs}ms` : result.error?.message,
      });
    } catch (err) {
      setTestResult({ ok: false, text: toUiError(err).message });
    } finally {
      setTesting(false);
    }
  };

  const lastTest = useMemo(() => {
    if (testResult) return testResult.text;
    if (!saved?.testedAt) return "还没测过";
    return `${formatTime(saved.testedAt)} · ${saved.testStatus === "ok" ? "通过" : "失败"}${
      saved.testLatencyMs ? `（${saved.testLatencyMs}ms）` : ""
    }`;
  }, [saved, testResult]);

  if (!open) return null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={560}
      title={model ? "编辑模型" : "添加模型"}
      subtitle={lastTest}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void test()} disabled={testing || saving}>
            <FlaskConical className={cn("size-3.5", testing && "animate-pulse")} />
            {testing ? "测试中…" : "测试连接"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={() => {
                void save().then((record) => {
                  if (record) onClose();
                });
              }}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      }
    >
      {presets.length > 0 && !model ? (
        <div className="mb-5">
          <div className="mb-2 text-[12px] text-muted-foreground">从预设开始</div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() =>
                  update({
                    provider: preset.provider,
                    capability: preset.capability,
                    baseUrl: preset.baseUrl,
                    modelId: preset.modelId,
                    name: preset.modelId,
                  })
                }
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Field label="名称">
        <Input value={state.name} onChange={(event) => update({ name: event.target.value })} placeholder="gpt-4.1-mini" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="提供方">
          <Select
            value={state.provider}
            onChange={(value) =>
              update({
                provider: value as ProviderKind,
                ...(value === "dashscope" && state.capability === "chat" ? { capability: "asr" as const } : {}),
              })
            }
            options={[
              { value: "openai", label: "OpenAI 兼容" },
              { value: "dashscope", label: "DashScope WebSocket（语音）" },
              { value: "anthropic", label: "Anthropic 兼容" },
              { value: "custom", label: "自建 / 本地" },
            ]}
          />
        </Field>
        <Field label="用途">
          <Select
            value={state.capability}
            onChange={(value) => update({ capability: value as Capability })}
            options={[
              ...(state.provider === "dashscope" ? [] : [{ value: "chat", label: "对话" }]),
              { value: "asr", label: "语音识别" },
              { value: "tts", label: "语音合成" },
            ]}
          />
        </Field>
      </div>

      <Field label="Base URL" hint="留到 /v1 这一级，Kivora 自己拼 /chat/completions 这类路径。">
        <Input
          value={state.baseUrl}
          onChange={(event) => update({ baseUrl: event.target.value })}
          placeholder="https://api.openai.com/v1"
          spellCheck={false}
        />
      </Field>

      <Field label="模型 ID">
        <Input
          value={state.modelId}
          onChange={(event) => update({ modelId: event.target.value })}
          placeholder="gpt-4.1-mini"
          spellCheck={false}
        />
      </Field>

      <Field
        label="API Key"
        hint="存在 Windows 凭据管理器里，不写配置文件，也不进日志。"
        action={
          saved?.hasKey ? (
            <button
              type="button"
              className="text-[11px] text-faint hover:text-destructive"
              onClick={() => {
                update({ apiKey: "", keyTouched: true });
                toast.push({ tone: "info", title: "保存后会清掉这个 Key" });
              }}
            >
              清除
            </button>
          ) : null
        }
      >
        <div className="relative">
          <Input
            type="password"
            value={state.apiKey}
            onChange={(event) => update({ apiKey: event.target.value, keyTouched: true })}
            placeholder={saved?.keyHint ?? "sk-…"}
            spellCheck={false}
            autoComplete="off"
          />
          {saved?.hasKey && !state.apiKey ? (
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] text-faint">
              已保存
            </span>
          ) : null}
        </div>
      </Field>

      {state.capability === "chat" ? (
        <Field label="参数" hint="留空就用端点默认值。">
          <div className="grid grid-cols-3 gap-2">
            <LabeledInput label="temperature" value={state.temperature} onChange={(value) => update({ temperature: value })} />
            <LabeledInput label="max tokens" value={state.maxTokens} onChange={(value) => update({ maxTokens: value })} />
            <LabeledInput label="top_p" value={state.topP} onChange={(value) => update({ topP: value })} />
          </div>
        </Field>
      ) : null}

      {state.capability === "tts" ? (
        <Field label="语音参数">
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput label="音色" value={state.voice} onChange={(value) => update({ voice: value })} />
            <LabeledInput label="语速" value={state.speed} onChange={(value) => update({ speed: value })} />
          </div>
        </Field>
      ) : null}

      {state.capability === "asr" ? (
        <p className="mb-5 rounded-[12px] bg-sunken px-4 py-3 text-[12px] leading-5 text-faint">
          识别语言在「语音」页统一设置，不在这里配。
        </p>
      ) : null}

      <Field
        label="自定义请求头"
        action={
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-faint hover:text-foreground"
            onClick={() => update({ headers: [...state.headers, { name: "", value: "" }] })}
          >
            <Plus className="size-3" /> 添加一行
          </button>
        }
      >
        <div className="space-y-2">
          {state.headers.map((header, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={header.name}
                placeholder="X-Org"
                className="h-9 font-mono text-[12px]"
                onChange={(event) => {
                  const next = [...state.headers];
                  next[index] = { ...next[index], name: event.target.value };
                  update({ headers: next });
                }}
              />
              <Input
                value={header.value}
                placeholder="kivora"
                className="h-9 text-[12px]"
                onChange={(event) => {
                  const next = [...state.headers];
                  next[index] = { ...next[index], value: event.target.value };
                  update({ headers: next });
                }}
              />
              <IconButton
                label="删掉这一行"
                onClick={() => update({ headers: state.headers.filter((_, i) => i !== index) })}
              >
                <X className="size-3.5" />
              </IconButton>
            </div>
          ))}
          {state.headers.length === 0 ? (
            <p className="text-[11px] text-faint">没有自定义头。有些代理需要 X-Org 或 api-key 之类的头。</p>
          ) : null}
        </div>
      </Field>

      {error ? (
        <p className="mb-2 rounded-[10px] bg-destructive-container px-3 py-2 text-[12px] leading-5 text-destructive">
          {error}
        </p>
      ) : null}

      {testResult ? (
        <p className={cn("text-[12px]", testResult.ok ? "text-positive" : "text-destructive")}>
          {testResult.ok ? <Check className="mr-1 inline size-3" /> : null}
          {testResult.text}
        </p>
      ) : null}
    </Sheet>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-faint">{label}</span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 font-mono text-[12px]"
        inputMode="decimal"
      />
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}): React.JSX.Element {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full appearance-none rounded-[12px] bg-input px-4 pr-9 text-[14px] text-foreground outline-none focus:bg-muted"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-card">
            {option.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-faint">▾</span>
    </div>
  );
}

/** 供绑定下拉复用 */
export function InlineSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="max-w-[260px] bg-transparent text-right text-[13px] text-foreground outline-none"
    >
      <option value="" className="bg-card text-faint">
        {placeholder}
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-card">
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 试听/清除之类的小工具按钮，保持视觉统一 */
export function TinyButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-[8px] px-2 py-1 text-[11px] text-faint hover:bg-muted hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}
