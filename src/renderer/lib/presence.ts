import { useEffect, useState } from "react";

/**
 * 给浮层用的"存在感"：open=false 时先播退场动画，动画结束再卸载。
 * 退场时长必须和 CSS 里的 --motion-fast 对齐（120ms），这里留一点余量。
 */
export function usePresence(open: boolean, exitMs = 140): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted, closing };
}
