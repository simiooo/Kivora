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
import { defaultVoiceFor, isKnownVoice } from "../../shared/voice-catalog.ts";
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


function assertProviderFits(provider: ProviderKind, capability: Capability, baseUrl: string): void {
  if (provider === "dashscope" && capability === "chat") {
    throw new AppError("conflict", {
      message: "DashScope 这个连接只用于语音（识别/合成）；对话请用 OpenAI / Anthropic 兼容端点。",
    });
  }
  if (provider === "anthropic" && capability !== "chat") {
    throw new AppError("conflict", { message: "Anthropic 只支持对话模型。" });
  }
  if (/^wss?:/i.test(baseUrl) && provider !== "dashscope") {
    throw new AppError("conflict", {
      message: "这是 WebSocket 地址，提供方要选「DashScope WebSocket」。",
    });
  }
  if (/^https?:/i.test(baseUrl) && provider === "dashscope") {
    throw new AppError("conflict", {
      message: "DashScope WebSocket 的地址要以 wss:// 开头。",
    });
  }
}
export function createModel(draft: ModelDraft): ModelRecord {
  assertProviderFits(draft.provider, draft.capability, draft.baseUrl);
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
  assertProviderFits(draft.provider, draft.capability, draft.baseUrl);
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

const DASHSCOPE_WS = "wss://cn-beijing.maas.qianwenaiapi.com/api-ws/v1/inference";
/** 音色跟模型绑定，默认值从清单里取，别在这儿写第二个来源 */
const QWEN_VOICE = defaultVoiceFor("qwen-audio-3.1-tts-flash") ?? "longanhuan_v3.1";

/** 同一 (提供方/能力/地址/模型 ID) 只留一条：优先留被绑定的、有 Key 的、最早的那条。 */
export function dedupeModels(): number {
  const groups = db()
    .prepare(
      "SELECT provider, capability, base_url, model_id, COUNT(*) AS n FROM models GROUP BY provider, capability, base_url, model_id HAVING n > 1",
    )
    .all() as Array<{ provider: string; capability: string; base_url: string; model_id: string }>;
  let removed = 0;
  for (const group of groups) {
    const rows = db()
      .prepare(
        "SELECT id FROM models WHERE provider = ? AND capability = ? AND base_url = ? AND model_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(group.provider, group.capability, group.base_url, group.model_id) as Array<{ id: string }>;
    const isBound = (id: string): boolean => Boolean(db().prepare("SELECT 1 AS ok FROM bindings WHERE model_id = ?").get(id));
    const keep = rows.find((row) => isBound(row.id)) ?? rows.find((row) => hasSecret(modelSecretName(row.id))) ?? rows[0];
    for (const row of rows) {
      if (row.id === keep.id) continue;
      // 被绑定的绝不能删；其余即使有 Key 也删（它们配置完全相同，属于重复条目）
      if (isBound(row.id)) continue;
      deleteSecret(modelSecretName(row.id));
      db().prepare("DELETE FROM models WHERE id = ?").run(row.id);
      removed += 1;
    }
  }
  if (removed > 0) console.log(`[kivora] removed ${removed} duplicate models`);
  return removed;
}
/**
 * DeepSeek 的模型 ID 跟版本号不是一回事：官方 API 只认 `deepseek-flash`（现在由
 * DeepSeek-V4.1-Flash-1017 提供服务）和 `deepseek-v4-pro`。填 `deepseek-v4.1-flash`
 * 这类"版本号当 ID"的写法会直接 400。这里把历史写法统一纠正，
 * 顺手把 `api.deepseek.com`（无 /v1）补成 /v1，好跟种子合并成一条。
 */
const DEEPSEEK_ID_FIXES: Array<{ from: string[]; to: string; name: string }> = [
  { from: ["deepseek-chat", "deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"], to: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
  { from: ["deepseek-reasoner"], to: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
];

export function migrateDeepSeekModelIds(): number {
  const now = Date.now();
  let renamed = 0;
  for (const fix of DEEPSEEK_ID_FIXES) {
    for (const from of fix.from) {
      const result = db()
        .prepare("UPDATE models SET model_id = ?, name = ?, updated_at = ? WHERE model_id = ?")
        .run(fix.to, fix.name, now, from);
      renamed += Number(result.changes);
    }
  }
  // https://api.deepseek.com 和 .../v1 都通，但统一成 /v1 才能跟种子合并成一条
  const normalized = db()
    .prepare("UPDATE models SET base_url = 'https://api.deepseek.com/v1', updated_at = ? WHERE base_url IN ('https://api.deepseek.com', 'https://api.deepseek.com/')")
    .run(now);
  const total = renamed + Number(normalized.changes);
  if (total > 0) {
    console.log(`[kivora] deepseek ids migrated: renamed=${renamed} normalized=${normalized.changes}`);
  }
  return total;
}

/**
 * 音色不能用别的模型的：老版本引导页把音色写死成 `Cherry`，撞上 qwen-audio-3.1-tts-*
 * 就会被服务以 InvalidParameter / 411 拒掉。这里把「不属于本模型、且我们有清单」的音色
 * 换回该模型的默认音色；未知模型不动。
 */
export function repairTtsVoices(): number {
  const rows = db()
    .prepare("SELECT id, model_id, params FROM models WHERE capability = 'tts'")
    .all() as Array<{ id: string; model_id: string; params: string }>;
  let repaired = 0;
  const now = Date.now();
  for (const row of rows) {
    const fallback = defaultVoiceFor(row.model_id);
    if (!fallback) continue;
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(row.params) as Record<string, unknown>;
    } catch {
      continue;
    }
    const voice = typeof params.voice === "string" ? params.voice.trim() : "";
    if (isKnownVoice(row.model_id, voice)) continue;
    db()
      .prepare("UPDATE models SET params = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ ...params, voice: fallback }), now, row.id);
    console.log(`[kivora] voice fixed for ${row.model_id}: "${voice || "(empty)"}" → ${fallback}`);
    repaired += 1;
  }
  return repaired;
}
/** 上一版把 Qwen 语音默认成了 HTTP 兼容端点；这里把这两条纠正成 WebSocket。 */
export function migrateLegacyVoiceSeeds(): number {
  const rows = db()
    .prepare(
      "SELECT id, model_id FROM models WHERE (provider = 'openai' AND base_url = 'https://dashscope.aliyuncs.com/compatible-mode/v1' AND model_id LIKE 'qwen-audio-3.1-%') OR (provider = 'openai' AND base_url LIKE 'wss://%')",
    )
    .all() as Array<{ id: string; model_id: string }>;
  if (rows.length === 0) return 0;
  const now = Date.now();
  for (const row of rows) {
    db()
      .prepare("UPDATE models SET provider = 'dashscope', base_url = ?, test_status = 'untested', tested_at = NULL, test_latency_ms = NULL, updated_at = ? WHERE id = ?")
      .run(DASHSCOPE_WS, now, row.id);
  }
  console.log(`[kivora] migrated ${rows.length} Qwen voice models to WebSocket`);
  return rows.length;
}

/**
 * 默认栈：调度/任务用 DeepSeek，识别/合成用 Qwen Audio 3.1。
 * 语音这组里：
 * - asr-flash-message 面向"一句话一条消息"的短音频，正好是我们按次上传的 clip
 * - tts-flash 是低延迟合成，首响优先
 * - filetrans 是长音频文件、realtime-plus 是流式、tts-next 是下一代，留作预设不设默认
 */
export function seedModels(): void {
  if (countModels() > 0) return;
  const seeds: Array<Omit<ModelDraft, "apiKey">> = [
    {
      name: "DeepSeek V4.1 Flash",
      provider: "openai",
      capability: "chat",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-flash",
      params: { ...DEFAULT_PARAMS },
      headers: [],
    },
    {
      name: "Qwen ASR",
      provider: "dashscope",
      capability: "asr",
      baseUrl: DASHSCOPE_WS,
      modelId: "qwen-audio-3.1-asr-flash-message",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null },
      headers: [],
    },
    {
      name: "Qwen TTS",
      provider: "dashscope",
      capability: "tts",
      baseUrl: DASHSCOPE_WS,
      modelId: "qwen-audio-3.1-tts-flash",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null, voice: QWEN_VOICE, speed: 1 },
      headers: [],
    },
    {
      name: "Qwen 文件转写",
      provider: "dashscope",
      capability: "asr",
      baseUrl: DASHSCOPE_WS,
      modelId: "qwen-audio-3.1-asr-flash-filetrans",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null },
      headers: [],
    },
    {
      name: "Qwen TTS Next",
      provider: "dashscope",
      capability: "tts",
      baseUrl: DASHSCOPE_WS,
      modelId: "qwen-audio-3.1-tts-next",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null, voice: QWEN_VOICE, speed: 1 },
      headers: [],
    },
    {
      name: "Qwen 实时语音",
      provider: "dashscope",
      capability: "asr",
      baseUrl: DASHSCOPE_WS,
      modelId: "qwen-audio-3.1-realtime-plus",
      params: { ...DEFAULT_PARAMS, temperature: null, maxTokens: null },
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
  bindModel("task", ids[0]);
}
