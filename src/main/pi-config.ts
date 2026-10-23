import type { ModelRecord } from "../shared/domain.ts";

/**
 * Kivora 的模型 → Pi 那边的 provider/model + 环境变量。
 *
 * Pi 有自己的 provider 表（deepseek / openai / anthropic …），凭据从环境变量读。
 * Kivora 的模型仓库是按"OpenAI 兼容端点 + Key"存的，所以这里按 baseUrl 的域名
 * 反推 Pi 的 provider：别把 DeepSeek 的 Key 塞进 OPENAI_API_KEY，否则 Pi 会拿它
 * 去请求 api.openai.com，然后报一个跟真实原因无关的错。
 *
 * 不认识的域名返回 null：不注入凭据，也不指定模型，让 Pi 自己如实说没模型可用。
 */
export interface PiBinding {
  /** 传给 `pi --model` 的写法，如 deepseek/deepseek-flash */
  spec: string;
  /** 凭据环境变量名，如 DEEPSEEK_API_KEY */
  envName: string;
}

const HOSTS: Array<{ host: RegExp; prefix: string; envName: string }> = [
  { host: /(^|\.)deepseek\.com$/i, prefix: "deepseek", envName: "DEEPSEEK_API_KEY" },
  { host: /(^|\.)openai\.com$/i, prefix: "openai", envName: "OPENAI_API_KEY" },
  { host: /(^|\.)anthropic\.com$/i, prefix: "anthropic", envName: "ANTHROPIC_API_KEY" },
];

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** 模型 ID 得能安全地放进命令行参数里 */
function safeModelId(modelId: string): string | null {
  return /^[A-Za-z0-9._:/-]+$/.test(modelId) ? modelId : null;
}

export function piBindingFor(model: Pick<ModelRecord, "baseUrl" | "modelId"> | null): PiBinding | null {
  if (!model) return null;
  const host = hostOf(model.baseUrl);
  const match = HOSTS.find((entry) => entry.host.test(host));
  const modelId = safeModelId(model.modelId);
  if (!match || !modelId) return null;
  return { spec: `${match.prefix}/${modelId}`, envName: match.envName };
}
