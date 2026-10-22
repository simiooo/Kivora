import type { KivoraBridge } from "@shared/ipc.ts";

export const bridge: KivoraBridge = window.kivora;

export interface UiError {
  code: string;
  message: string;
  detail: string | null;
  retryable: boolean;
}

export function toUiError(err: unknown): UiError {
  if (err && typeof err === "object") {
    const candidate = err as { code?: unknown; message?: unknown; detail?: unknown; retryable?: unknown };
    return {
      code: typeof candidate.code === "string" ? candidate.code : "internal",
      message: typeof candidate.message === "string" ? candidate.message : "出了点问题。",
      detail: typeof candidate.detail === "string" ? candidate.detail : null,
      retryable: candidate.retryable === true,
    };
  }
  return { code: "internal", message: String(err), detail: null, retryable: true };
}

export function isUiError(err: unknown): err is UiError {
  return Boolean(err && typeof err === "object" && "code" in err && "message" in err);
}

/** 统一的"失败不做假动作"：返回 null 并把错误交给调用方展示 */
export async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: UiError }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: toUiError(err) };
  }
}
