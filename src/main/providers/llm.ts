import type { ModelRecord } from "../../shared/domain.ts";
import { AppError } from "../../shared/errors.ts";
import { request } from "./http.ts";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  latencyMs: number;
}

export function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

export function authHeaders(model: ModelRecord, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (model.provider === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  for (const header of model.headers) {
    const name = header.name.trim();
    if (!name) continue;
    headers[name.toLowerCase()] = header.value;
  }
  return headers;
}

function parseAnthropic(json: unknown): { text: string; toolCalls: ToolCall[]; usage: { input: number; output: number } } {
  const body = json as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (body.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const toolCalls = (body.content ?? [])
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id ?? `tool_${Math.random().toString(36).slice(2, 8)}`,
      name: block.name ?? "",
      arguments: JSON.stringify(block.input ?? {}),
    }));
  return {
    text,
    toolCalls,
    usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
  };
}

function parseOpenAi(json: unknown): { text: string; toolCalls: ToolCall[]; usage: { input: number; output: number } } {
  const body = json as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = body.choices?.[0]?.message;
  return {
    text: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    usage: {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
    },
  };
}

export async function chatCompletion(
  model: ModelRecord,
  apiKey: string | null,
  turns: ChatTurn[],
  options: { tools?: ToolDef[]; signal?: AbortSignal; maxTokens?: number; temperature?: number; allowEmpty?: boolean } = {},
): Promise<ChatResult> {
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(model, apiKey),
  };

  if (model.provider === "anthropic") {
    const system = turns.filter((turn) => turn.role === "system").map((turn) => turn.content).join("\n\n");
    const body: Record<string, unknown> = {
      model: model.modelId,
      max_tokens: options.maxTokens ?? model.params.maxTokens ?? 1024,
      messages: turns
        .filter((turn) => turn.role !== "system")
        .map((turn) => ({ role: turn.role, content: turn.content })),
    };
    if (system) body.system = system;
    if (typeof options.temperature === "number") body.temperature = options.temperature;
    else if (typeof model.params.temperature === "number") body.temperature = model.params.temperature;
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    const response = await request({
      channel: "brain",
      url: joinUrl(model.baseUrl, "/messages"),
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const parsed = parseAnthropic(response.json<unknown>());
    return { ...parsed, latencyMs: Date.now() - startedAt };
  }

  const body: Record<string, unknown> = {
    model: model.modelId,
    messages: turns,
    stream: false,
  };
  const maxTokens = options.maxTokens ?? model.params.maxTokens;
  if (maxTokens) body.max_tokens = maxTokens;
  const temperature = options.temperature ?? model.params.temperature;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof model.params.topP === "number") body.top_p = model.params.topP;
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = "auto";
  }

  const response = await request({
    channel: "brain",
    url: joinUrl(model.baseUrl, "/chat/completions"),
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const parsed = parseOpenAi(response.json<unknown>());
  if (!parsed.text && parsed.toolCalls.length === 0 && !options.allowEmpty) {
    throw new AppError("bad_response", { message: "模型没返回内容，可能不是兼容接口。" });
  }
  return { ...parsed, latencyMs: Date.now() - startedAt };
}
