import path from "node:path";
import { app } from "electron";

/** 打包后图标在 resources/，开发时在 docs/assets/icon/。 */
export function appIcon(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "docs", "assets", "icon", "kivora.ico");
}
