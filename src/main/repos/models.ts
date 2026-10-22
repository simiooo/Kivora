import { db, tx } from "../store.ts";
import type {
  Binding,
  Capability,
  ModelDraft,
  ModelParams,
  ModelRecord,
  ModuleKey,
  ProviderKind,
  TestStatus,
} from "../../shared/domain.ts";
import { DEFAULT_PARAMS, MODULE_CAPABILITY } from "../../shared/domain.ts";
import { AppError } from "../../shared/errors.ts";
import { deleteSecret, hasSecret, modelSecretName, putSecret } from "../secrets.ts";
import { maskKey } from "../../shared/text.ts";
import { newId } from "../../shared/domain.ts";

interface ModelRow {
  id: string;
  name: string;
  provider: string;
  capability: string;
  base_url: string;
  model_id: string;
  params: string;
  headers: string;
  key_hint: string | null;
  test_status: string;
  test_latency_ms: number | null;
  tested_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseParams(raw: string): ModelParams {
  try {
    const parsed = JSON.parse(raw) as Partial<ModelParams>;
    return { ...DEFAULT_PARAMS, ...parsed };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

function toRecord(row: ModelRow): ModelRecord {
  let headers: ModelRecord["headers"] = [];
  try {
    headers = JSON.parse(row.headers) as ModelRecord["headers"];
  } catch {
    headers = [];
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as ProviderKind,
    capability: row.capability as Capability,
    baseUrl: row.base_url,
    modelId: row.model_id,
    params: parseParams(row.params),
    headers: Array.isArray(headers) ? headers : [],
    keyHint: row.key_hint,
    hasKey: hasSecret(modelSecretName(row.id)),
    testStatus: row.test_status as TestStatus,
    testLatencyMs: row.test_latency_ms,
    testedAt: row.tested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listModels(): ModelRecord[] {
  const rows = db()
    .prepare("SELECT * FROM models ORDER BY created_at ASC")
    .all() as unknown as ModelRow[];
  return rows.map(toRecord);
}

export function getModel(id: string): ModelRecord | null {
  const row = db().prepare("SELECT * FROM models WHERE id = ?").get(id) as unknown as ModelRow | undefined;
  return row ? toRecord(row) : null;
}

export function countModels(): number {
  return (db().prepare("SELECT COUNT(*) AS n FROM models").get() as { n: number }).n;
}

export function createModel(draft: ModelDraft): ModelRecord {
  const id = newId("m");
  const now = Date.now();
  tx(() => {
    db()
      .prepare(
        `INSERT INTO models (id, name, provider, capability, base_url, model_id, params, headers, key_hint, test_status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        draft.name,
        draft.provider,
        draft.capability,
        draft.baseUrl,
        draft.modelId,
        JSON.stringify(draft.params),
        JSON.stringify(draft.headers),
        draft.apiKey ? maskKey(draft.apiKey) : null,
        "untested",
        now,
        now,
      );
    if (draft.apiKey) putSecret(modelSecretName(id), draft.apiKey);
  });
  const created = getModel(id);
  if (!created) throw new AppError("internal");
  return created;
}

export function updateModel(draft: ModelDraft & { id: string }): ModelRecord {
  const current = getModel(draft.id);
  if (!current) throw new AppError("not_found", { message: "这个模型已经不在了。" });
  const now = Date.now();
  const keyHint = draft.apiKey === null ? null : draft.apiKey ? maskKey(draft.apiKey) : current.keyHint;
  tx(() => {
    db()
      .prepare(
        `UPDATE models SET name = ?, provider = ?, capability = ?, base_url = ?, model_id = ?,
           params = ?, headers = ?, key_hint = ?, test_status = ?, tested_at = NULL, test_latency_ms = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        draft.name,
        draft.provider,
        draft.capability,
        draft.baseUrl,
        draft.modelId,
        JSON.stringify(draft.params),
        JSON.stringify(draft.headers),
        keyHint,
        draft.capability === current.capability ? "untested" : "untested",
        now,
        draft.id,
      );
    if (draft.apiKey === null) deleteSecret(modelSecretName(draft.id));
    else if (draft.apiKey) putSecret(modelSecretName(draft.id), draft.apiKey);
  });
  const next = getModel(draft.id);
  if (!next) throw new AppError("internal");
  return next;
}

export function deleteModel(id: string): void {
  const used = listBindings().filter((binding) => binding.modelId === id);
  if (used.length > 0) {
    throw new AppError("conflict", {
      message: `还有模块绑着它（${used.map((b) => b.module).join("、")}），先改绑定再删。`,
    });
  }
  tx(() => {
    deleteSecret(modelSecretName(id));
    db().prepare("DELETE FROM models WHERE id = ?").run(id);
  });
}

export function setTestResult(id: string, status: TestStatus, latencyMs: number | null): void {
  db()
    .prepare("UPDATE models SET test_status = ?, test_latency_ms = ?, tested_at = ?, updated_at = ? WHERE id = ?")
    .run(status, latencyMs, Date.now(), Date.now(), id);
}

/* ------------------------------------------------------------ 绑定 */

export function listBindings(): Binding[] {
  const rows = db().prepare("SELECT module, model_id FROM bindings").all() as Array<{
    module: string;
    model_id: string;
  }>;
  return rows.map((row) => ({ module: row.module as ModuleKey, modelId: row.model_id }));
}

export function getBoundModel(module: ModuleKey): ModelRecord | null {
  const row = db().prepare("SELECT model_id FROM bindings WHERE module = ?").get(module) as
    | { model_id: string }
    | undefined;
  if (!row) return null;
  return getModel(row.model_id);
}

export function bindModel(module: ModuleKey, modelId: string | null): Binding[] {
  const capability = MODULE_CAPABILITY[module];
  if (!modelId) {
    db().prepare("DELETE FROM bindings WHERE module = ?").run(module);
    return listBindings();
  }
  const model = getModel(modelId);
  if (!model) throw new AppError("not_found", { message: "这个模型已经不在了。" });
  if (model.capability !== capability) {
    throw new AppError("conflict", {
      message: `${model.name} 是 ${model.capability} 模型，绑不到这个模块。`,
    });
  }
  db()
    .prepare(
      "INSERT INTO bindings (module, model_id) VALUES (?,?) ON CONFLICT(module) DO UPDATE SET model_id = excluded.model_id",
    )
    .run(module, modelId);
  return listBindings();
}

/* ------------------------------------------------------------ 种子 */

export function seedModels(): void {
  if (countModels() > 0) return;
  const seeds: Array<Omit<ModelDraft, "apiKey">> = [
    {
      name: "gpt-4.1-mini",
      provider: "openai",
      capability: "chat",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4.1-mini",
      params: { ...DEFAULT_PARAMS },
      headers: [],
    },
    {
      name: "whisper-1",
      provider: "openai",
      capability: "asr",
      baseUrl: "https://api.openai.com/v1",
      modelId: "whisper-1",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null },
      headers: [],
    },
    {
      name: "tts-1",
      provider: "openai",
      capability: "tts",
      baseUrl: "https://api.openai.com/v1",
      modelId: "tts-1",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null, voice: "alloy", speed: 1 },
      headers: [],
    },
    {
      name: "claude-sonnet-4-6",
      provider: "anthropic",
      capability: "chat",
      baseUrl: "https://api.anthropic.com/v1",
      modelId: "claude-sonnet-4-6",
      params: { ...DEFAULT_PARAMS, maxTokens: 8192 },
      headers: [],
    },
    {
      name: "本地 Qwen",
      provider: "custom",
      capability: "chat",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "Qwen2.5-72B",
      params: { ...DEFAULT_PARAMS },
      headers: [],
    },
  ];
  const ids: string[] = [];
  for (const seed of seeds) {
    const created = createModel(seed);
    ids.push(created.id);
  }
  bindModel("brain", ids[0]);
  bindModel("asr", ids[1]);
  bindModel("tts", ids[2]);
  bindModel("task", ids[3]);
}
