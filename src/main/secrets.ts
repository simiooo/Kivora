import { safeStorage } from "electron";
import { db } from "./store.ts";

/**
 * Key 永远不进配置文件、不进日志（画板 13）。
 * Windows 上走 DPAPI（safeStorage）；万一系统凭据服务不可用，
 * 退化成带标记的明文并让 UI 明确告警，而不是假装安全。
 */

const PLAIN_PREFIX = "plain:";

let cachedAvailability: boolean | null = null;

/** 启动时问一次（Electron 45 起推荐异步接口），之后同步读缓存 */
export async function initSecrets(): Promise<void> {
  try {
    const api = safeStorage as unknown as { isAsyncEncryptionAvailable?: () => Promise<boolean> };
    cachedAvailability = api.isAsyncEncryptionAvailable
      ? await api.isAsyncEncryptionAvailable()
      : safeStorage.isEncryptionAvailable();
  } catch {
    cachedAvailability = false;
  }
  console.log(`[kivora] secrets ${cachedAvailability ? "encrypted (DPAPI)" : "UNAVAILABLE"}`);
}

export function secretsAvailable(): boolean {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function putSecret(name: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    deleteSecret(name);
    return;
  }
  const ciphertext = secretsAvailable()
    ? safeStorage.encryptString(trimmed).toString("base64")
    : `${PLAIN_PREFIX}${Buffer.from(trimmed, "utf8").toString("base64")}`;
  db()
    .prepare(
      "INSERT INTO secrets (name, ciphertext, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
    )
    .run(name, ciphertext, Date.now());
}

export function getSecret(name: string): string | null {
  const row = db().prepare("SELECT ciphertext FROM secrets WHERE name = ?").get(name) as
    | { ciphertext: string }
    | undefined;
  if (!row) return null;
  if (row.ciphertext.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(row.ciphertext.slice(PLAIN_PREFIX.length), "base64").toString("utf8");
  }
  try {
    return safeStorage.decryptString(Buffer.from(row.ciphertext, "base64"));
  } catch (err) {
    console.warn(`[kivora] cannot decrypt secret ${name}`, err);
    return null;
  }
}

export function hasSecret(name: string): boolean {
  const row = db().prepare("SELECT 1 AS ok FROM secrets WHERE name = ?").get(name);
  return Boolean(row);
}

export function deleteSecret(name: string): void {
  db().prepare("DELETE FROM secrets WHERE name = ?").run(name);
}

export function modelSecretName(modelId: string): string {
  return `model:${modelId}`;
}
