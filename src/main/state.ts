import { app } from "electron";
import type { AppState } from "../shared/domain.ts";
import { storeInfo } from "./store.ts";
import { getConfig } from "./repos/config.ts";
import { getPiVersion, piAvailable } from "./env.ts";
import { secretsAvailable } from "./secrets.ts";

export function appState(): AppState {
  const info = storeInfo();
  const config = getConfig();
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? "",
    node: process.versions.node,
    dbPath: info.dbPath,
    schemaVersion: info.schemaVersion,
    hotkey: config.hotkey,
    hotkeyOk: Boolean(config.hotkey),
    secretsAvailable: secretsAvailable(),
    piAvailable: piAvailable(),
    piVersion: getPiVersion(),
    dataDir: app.getPath("userData"),
  };
}
