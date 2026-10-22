import { AppError, errorFromNetwork, errorFromStatus, isRetryableStatus, serializeError } from "../../shared/errors.ts";

/**
 * 所有出网请求都在这一层：超时、重试、熔断、错误归一化。
 * 重试只发生在"单次 provider 请求"这一层，绝不重放整个 agent turn（3.10）。
 */

export type Channel = "brain" | "asr" | "tts";

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  maxDelayMs: number;
  budgetMs: number;
}

export const RETRY_POLICY: Record<Channel, RetryPolicy> = {
  brain: { attempts: 3, baseMs: 300, maxDelayMs: 2000, budgetMs: 6000 },
  asr: { attempts: 3, baseMs: 500, maxDelayMs: 3000, budgetMs: 12000 },
  tts: { attempts: 2, baseMs: 300, maxDelayMs: 1000, budgetMs: 4000 },
};

const REQUEST_TIMEOUT_MS = 20_000;

interface BreakerState {
  failures: number;
  openedAt: number | null;
  lastFailureAt: number;
}

const breakers = new Map<string, BreakerState>();
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_OPEN_MS = 30_000;

function breakerKey(channel: Channel, host: string): string {
  return `${channel}:${host}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function breakerSnapshot(): Array<{ key: string; open: boolean }> {
  const now = Date.now();
  return [...breakers.entries()].map(([key, state]) => ({
    key,
    open: state.openedAt !== null && now - state.openedAt < BREAKER_OPEN_MS,
  }));
}

function checkBreaker(channel: Channel, url: string): void {
  const key = breakerKey(channel, hostOf(url));
  const state = breakers.get(key);
  if (!state || state.openedAt === null) return;
  if (Date.now() - state.openedAt < BREAKER_OPEN_MS) {
    throw new AppError("unreachable", {
      message: process.env.KIVORA_TEST ? "熔断打开" : "这个端点刚刚连续失败，先歇 30 秒再试。",
      retryable: false,
    });
  }
  // 半开：放一次探测过去
  state.openedAt = null;
  state.failures = 0;
}

function recordFailure(channel: Channel, url: string): void {
  const key = breakerKey(channel, hostOf(url));
  const now = Date.now();
  const state = breakers.get(key) ?? { failures: 0, openedAt: null, lastFailureAt: 0 };
  if (now - state.lastFailureAt > BREAKER_WINDOW_MS) state.failures = 0;
  state.failures += 1;
  state.lastFailureAt = now;
  if (state.failures >= BREAKER_THRESHOLD && state.openedAt === null) state.openedAt = now;
  breakers.set(key, state);
}

function recordSuccess(channel: Channel, url: string): void {
  breakers.delete(breakerKey(channel, hostOf(url)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数退避 + ±20% 抖动，预算内才继续 */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const raw = Math.min(policy.maxDelayMs, policy.baseMs * 2 ** (attempt - 1));
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

export interface RequestOptions {
  channel: Channel;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 返回原始 Response，由调用方决定怎么读（音频、JSON） */
  expect?: "json" | "audio" | "text";
}

export interface RawResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  arrayBuffer: ArrayBuffer;
  text: string;
  json: <T>() => T;
}

async function once(options: RequestOptions, attempt: number): Promise<RawResponse> {
  checkBreaker(options.channel, options.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(options.url, {
      method: options.method ?? "POST",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(arrayBuffer);
    if (!response.ok) {
      const err = errorFromStatus(response.status, text);
      // 4xx 不是"端点挂了"，不该记熔断
      if (response.status >= 500 || response.status === 429) recordFailure(options.channel, options.url);
      throw Object.assign(err, { retryable: isRetryableStatus(response.status), status: response.status });
    }
    recordSuccess(options.channel, options.url);
    console.log(`[kivora] ${options.channel} ${options.method ?? "POST"} ${hostOf(options.url)} ← ${response.status} (try ${attempt})`);
    return {
      status: response.status,
      ok: true,
      headers: response.headers,
      arrayBuffer,
      text,
      json: <T,>() => JSON.parse(text) as T,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      recordFailure(options.channel, options.url);
      throw new AppError("timeout", { detail: `${options.channel} 请求被取消或超时` });
    }
    const normalized = errorFromNetwork(err);
    recordFailure(options.channel, options.url);
    throw normalized;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function request(options: RequestOptions): Promise<RawResponse> {
  const policy = RETRY_POLICY[options.channel];
  const startedAt = Date.now();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await once(options, attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AppError ? err.retryable : true;
      const elapsed = Date.now() - startedAt;
      const delay = backoffDelay(policy, attempt);
      if (!retryable || attempt === policy.attempts || elapsed + delay > policy.budgetMs) break;
      if (options.signal?.aborted) break;
      console.warn(`[kivora] ${options.channel} retry ${attempt + 1}/${policy.attempts} in ${delay}ms`, serializeError(err).code);
      await sleep(delay);
    }
  }
  throw lastError instanceof AppError ? lastError : new AppError("internal", { detail: String(lastError) });
}
