import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bootstrap, ChangeKind } from "@shared/ipc.ts";
import { bridge } from "./bridge.ts";

/** 启动数据：应用状态 + 配置，全局只取一次 */
export function useBootstrap(): {
  data: Bootstrap | null;
  error: string | null;
  reload: () => Promise<void>;
  patchConfig: (patch: Partial<Bootstrap["config"]>) => Promise<void>;
  setData: React.Dispatch<React.SetStateAction<Bootstrap | null>>;
} {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await bridge.bootstrap();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchConfig = useCallback(async (patch: Partial<Bootstrap["config"]>) => {
    const config = await bridge.setConfig(patch);
    setData((prev) => (prev ? { ...prev, config } : prev));
  }, []);

  return { data, error, reload, patchConfig, setData };
}

/**
 * 主进程广播"哪块变了"，这里只重取匹配的切片。
 * 合并 80ms 内的多次通知，避免一次任务推进触发十几次请求。
 */
export function useLiveData<T>(
  loader: () => Promise<T>,
  kinds: ChangeKind[],
  options: { enabled?: boolean; key?: string } = {},
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const kindsKey = kinds.join(",");
  const enabled = options.enabled !== false;
  const key = options.key ?? "";
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    loader()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // loader 每次渲染都是新函数，用电信号的 key + kinds + tick 当依赖，避免死循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindsKey, tick, enabled, key]);

  useEffect(() => {
    if (!enabled) return;
    const watch = new Set(kindsKey.split(","));
    const unsubscribe = bridge.subscribe((event) => {
      if (!watch.has(event.kind)) return;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setTick((value) => value + 1), 80);
    });
    return () => {
      unsubscribe();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [kindsKey, enabled]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, loading, error, reload };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 路由：hash 驱动（#/settings/models），主进程也能直接指定落地页 */
export function useRoute(): { route: string; navigate: (next: string) => void } {
  const read = useCallback(() => {
    const raw = window.location.hash.replace(/^#/, "");
    return raw || "/";
  }, []);
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onHash = (): void => setRoute(read());
    window.addEventListener("hashchange", onHash);
    const unsubscribe = bridge.onNavigate((next) => {
      window.location.hash = next.startsWith("/") ? next : `/${next}`;
    });
    return () => {
      window.removeEventListener("hashchange", onHash);
      unsubscribe();
    };
  }, [read]);

  const navigate = useCallback((next: string) => {
    window.location.hash = next.startsWith("/") ? next : `/${next}`;
    setRoute(next);
  }, []);

  return { route, navigate };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = (): void => setMatches(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);
  return matches;
}

export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useMemo(() => ((...args: never[]) => ref.current(...args)) as T, []);
}
