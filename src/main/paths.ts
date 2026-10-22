import path from "node:path";
import { app } from "electron";

/** 打包后图标/扩展在 resources/，开发时在仓库里。 */
export function appIcon(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "docs", "assets", "icon", "kivora.ico");
}

/** 权限闸门扩展：让 pi 的工具调用走 Kivora 的审批总线 */
export function permissionExtensionPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "kivora-permission.ts")
    : path.join(app.getAppPath(), "resources", "kivora-permission.ts");
}
