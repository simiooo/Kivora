import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { ModelRecord, ModuleKey } from "@shared/domain.ts";
import { MODULE_CAPABILITY, MODULE_LABELS, PROVIDER_LABELS } from "@shared/domain.ts";
import type { ModelPreset } from "@shared/ipc.ts";
import { bridge, toUiError } from "../lib/bridge.ts";
import { useLiveData } from "../lib/hooks.ts";
import { cn } from "../lib/utils.ts";
import { Button, Chip, Spinner, useToast } from "./ui.tsx";
import { InlineSelect, ModelEditor } from "./model-editor.tsx";

const MODULES: ModuleKey[] = ["brain", "asr", "tts", "task"];

export function ModelsPanel(): React.JSX.Element {
  const toast = useToast();
  const models = useLiveData<ModelRecord[]>(() => bridge.listModels(), ["models"]);
  const bindings = useLiveData(() => bridge.listBindings(), ["models"]);
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ModelRecord | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);

  useEffect(() => {
    void bridge.modelPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const list = models.data ?? [];
  const bindingMap = useMemo(() => {
    const map = new Map<ModuleKey, string>();
    for (const binding of bindings.data ?? []) map.set(binding.module, binding.modelId);
    return map;
  }, [bindings.data]);

  const test = async (model: ModelRecord): Promise<void> => {
    setTestingId(model.id);
    try {
      const result = await bridge.testModel(model.id);
      toast.push({
        tone: result.ok ? "success" : "error",
        title: result.ok ? `「${model.name}」通了` : `「${model.name}」连不上`,
        detail: result.ok ? `延迟 ${result.latencyMs}ms${result.simulated ? "（模拟）" : ""}` : (result.error?.message ?? ""),
      });
    } catch (err) {
      toast.push({ tone: "error", title: "测试失败", detail: toUiError(err).message });
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold tracking-tight">模型仓库</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">功能模块统一从这里挑模型，换模型不动代码。</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
        >
          <Plus className="size-3.5" /> 添加模型
        </Button>
      </div>

      <div className="mb-2 flex items-center gap-3 px-4 text-[11px] text-faint">
        <span>名称</span>
        <span>提供方</span>
        <span>模型 ID</span>
        <span className="ml-auto">状态</span>
      </div>

      <div className="space-y-2">
        {list.map((model) => (
          <button
            key={model.id}
            type="button"
            onClick={() => {
              setEditing(model);
              setEditorOpen(true);
            }}
            className="flex w-full items-center gap-4 rounded-[14px] bg-card px-4 py-4 text-left transition-colors hover:bg-muted/70"
          >
            <span className="min-w-0 truncate text-[14px] font-medium text-foreground">{model.name}</span>
            <Chip tone="neutral">{PROVIDER_LABELS[model.provider]}</Chip>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-faint">{model.modelId}</span>
            <span className="flex shrink-0 items-center gap-3">
              {testingId === model.id ? (
                <Spinner className="size-3.5" />
              ) : model.testStatus === "ok" ? (
                <span className="text-[12px] text-positive">已测通</span>
              ) : model.testStatus === "failed" ? (
                <span className="text-[12px] text-destructive">连接失败</span>
              ) : (
                <span className="text-[12px] text-faint">未测</span>
              )}
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  void test(model);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.stopPropagation();
                    void test(model);
                  }
                }}
                className="rounded-[8px] px-2 py-1 text-[12px] text-faint hover:bg-muted hover:text-foreground"
              >
                测试
              </span>
              <span className="text-[12px] text-faint">编辑</span>
            </span>
          </button>
        ))}
        {list.length === 0 ? <p className="px-4 py-6 text-[12px] text-faint">还没有模型。</p> : null}
      </div>

      <div className="mt-8">
        <div className="mb-3 text-[12px] font-medium text-faint">功能模块绑定</div>
        <div className="space-y-2">
          {MODULES.map((module) => {
            const capability = MODULE_CAPABILITY[module];
            const options = list
              .filter((model) => model.capability === capability)
              .map((model) => ({ value: model.id, label: model.name }));
            const current = bindingMap.get(module) ?? "";
            return (
              <div key={module} className="flex items-center gap-4 rounded-[14px] bg-card px-4 py-3.5">
                <span className="text-[13px] text-foreground">{MODULE_LABELS[module]}</span>
                <span className="text-[11px] text-faint">
                  {capability === "chat" ? "对话" : capability === "asr" ? "识别" : "合成"}
                </span>
                <div className="ml-auto">
                  <InlineSelect
                    value={current}
                    placeholder="未绑定"
                    options={options}
                    onChange={(value) => {
                      void bridge
                        .bindModel(module, value || null)
                        .then(() => toast.push({ tone: "success", title: `${MODULE_LABELS[module]}已更新` }))
                        .catch((err) =>
                          toast.push({ tone: "error", title: "绑定失败", detail: toUiError(err).message }),
                        );
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={testingAll || list.length === 0}
          onClick={() => {
            setTestingAll(true);
            void bridge
              .testAllModels()
              .then((results) => {
                const failed = results.filter((result) => !result.ok).length;
                toast.push({
                  tone: failed ? "error" : "success",
                  title: failed ? `${failed} 个连不上` : "全部测试通过",
                  detail: `${results.length} 个模型${failed ? "，看列表里的红色状态" : ""}`,
                });
              })
              .catch((err) => toast.push({ tone: "error", title: "测试失败", detail: toUiError(err).message }))
              .finally(() => setTestingAll(false));
          }}
        >
          <RefreshCw className={cn("size-3.5", testingAll && "animate-spin")} />
          {testingAll ? "测试中…" : "测试全部"}
        </Button>
        <span className="text-[11px] text-faint">改动只影响新开的会话，正在跑的不受影响。</span>
      </div>

      <ModelEditor
        open={editorOpen}
        model={editing}
        presets={presets}
        onClose={() => setEditorOpen(false)}
        onSaved={(record) => {
          setEditing(record);
        }}
      />
    </div>
  );
}
