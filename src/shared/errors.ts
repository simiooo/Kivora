/**
 * 错误要有"下一步"（画板 11 的原则：不能只报"出错了"）。
 *
 * 约定：
 * - 主进程抛出 AppError，IPC 层序列化成 {code, message, detail, retryable}。
 * - 一个错误码对应一句人话 + 一个动作，渲染层只负责把动作画成按钮。
 */

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "unsupported"
  | "key_missing"
  | "auth_failed"
  | "rate_limited"
  | "timeout"
  | "unreachable"
  | "upstream_error"
  | "bad_response"
  | "no_model"
  | "asr_failed"
  | "tts_failed"
  | "storage_failed"
  | "cancelled"
  | "internal";

export interface SerializedError {
  code: ErrorCode;
  message: string;
  detail: string | null;
  retryable: boolean;
}

const MESSAGES: Record<ErrorCode, { message: string; retryable: boolean }> = {
  invalid_input: { message: "填写的内容不符合要求，检查一下再试。", retryable: false },
  not_found: { message: "这个对象不在了，可能已被删除。", retryable: false },
  conflict: { message: "和当前状态冲突，稍后再试。", retryable: false },
  unsupported: { message: "这个端点不支持这项操作。", retryable: false },
  key_missing: { message: "还没有填 API Key，去模型仓库补上。", retryable: false },
  auth_failed: { message: "API Key 无效或已过期，换一个。", retryable: false },
  rate_limited: { message: "请求太频繁了，等一会儿再试。", retryable: true },
  timeout: { message: "端点 20 秒没有响应，可能是网络或服务卡住了。", retryable: true },
  unreachable: { message: "连不上端点，检查地址和网络。", retryable: true },
  upstream_error: { message: "端点返回了错误，看原始错误排查。", retryable: true },
  bad_response: { message: "端点返回的内容读不懂，可能不是兼容接口。", retryable: false },
  no_model: { message: "这个功能模块还没绑定模型。", retryable: false },
  asr_failed: { message: "没听清，再说一次，或者直接打字。", retryable: true },
  tts_failed: { message: "这次没出声，不影响任务继续。", retryable: true },
  storage_failed: { message: "本地数据库写入失败，重启应用试试。", retryable: false },
  cancelled: { message: "已取消。", retryable: false },
  internal: { message: "出了点问题，重试一次；还不行就重启应用。", retryable: true },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | null;
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: { message?: string; detail?: string | null; retryable?: boolean } = {}) {
    const preset = MESSAGES[code] ?? MESSAGES.internal;
    super(options.message ?? preset.message);
    this.name = "AppError";
    this.code = code;
    this.detail = options.detail ?? null;
    this.retryable = options.retryable ?? preset.retryable;
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      detail: err.detail,
      retryable: err.retryable,
    };
  }
  if (err instanceof Error) {
    return { code: "internal", message: err.message, detail: err.stack ?? null, retryable: true };
  }
  return { code: "internal", message: String(err), detail: null, retryable: true };
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function errorFromStatus(status: number, body: string): AppError {
  const detail = body.slice(0, 1200);
  if (status === 401 || status === 403) return new AppError("auth_failed", { detail });
  if (status === 404) return new AppError("bad_response", { detail, message: "端点或模型不存在，核对 Base URL 和模型 ID。" });
  if (status === 429) return new AppError("rate_limited", { detail });
  if (status >= 500) return new AppError("upstream_error", { detail });
  return new AppError("upstream_error", { detail, message: `端点返回 ${status}。` });
}

/** 把 fetch 的网络错误归一化，避免把 "fetch failed" 直接抛给用户 */
export function errorFromNetwork(err: unknown): AppError {
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code ?? "";
  const detail = err instanceof Error ? `${err.message}${code ? ` (${code})` : ""}` : String(err);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new AppError("unreachable", { detail });
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return new AppError("unreachable", { detail });
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return new AppError("timeout", { detail });
  return new AppError("unreachable", { detail });
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}
