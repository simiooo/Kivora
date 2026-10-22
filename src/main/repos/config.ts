import { db, tx } from "../store.ts";
import type { AppConfig } from "../../shared/domain.ts";

export const CONFIG_DEFAULTS: AppConfig = {
  hotkey: "CommandOrControl+Alt+Space",
  mockMode: true,
  onboardingDone: false,
  narration: true,
  ackEnabled: true,
  asrLanguage: "zh",
  permissionWindow: true,
  approvalTimeoutSec: 45,
  g3Voice: false,
  retentionDays: 7,
  launchAtLogin: false,
  mediaRoots: [],
};

/** 只允许这些键落库，防止渲染层顺手塞进任意字段 */
const CONFIG_KEYS = new Set<keyof AppConfig>(Object.keys(CONFIG_DEFAULTS) as Array<keyof AppConfig>);

export function getConfig(): AppConfig {
  const rows = db().prepare("SELECT key, value FROM config").all() as Array<{ key: string; value: string }>;
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    if (!CONFIG_KEYS.has(row.key as keyof AppConfig)) continue;
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // 坏行忽略，回落默认值
    }
  }
  return { ...CONFIG_DEFAULTS, ...stored } as AppConfig;
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const now = Date.now();
  tx(() => {
    const stmt = db().prepare(
      "INSERT INTO config (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    );
    for (const [key, value] of Object.entries(patch)) {
      if (!CONFIG_KEYS.has(key as keyof AppConfig)) continue;
      stmt.run(key, JSON.stringify(value), now);
    }
  });
  return getConfig();
}
