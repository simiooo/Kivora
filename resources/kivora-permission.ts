/**
 * Kivora 的权限闸门（pi 扩展）。
 *
 * 它挂在 pi 的 `tool_call` 钩子上：危险命令、家目录外写入、动作类 MCP 工具\n * 都先 `ctx.ui.confirm()`，
 * 在 RPC 模式下这会变成一条 `extension_ui_request`，由 Kivora 弹审批卡、
 * 等用户回答，再把 `extension_ui_response` 发回来。
 *
 * 也就是说：任务会话里 pi 自己的工具，从此也走同一条审批总线。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";

const DESTRUCTIVE = [
  /(^|\s)rm\s+(-[a-z]*\s+)*[^\s]/i,
  /(^|\s)del\s+/i,
  /(^|\s)rd\s+/i,
  /(^|\s)rmdir\s+/i,
  /format\s+[a-z]:/i,
  /diskpart/i,
  /bcdedit/i,
  /reg\s+(add|delete)/i,
  /shutdown|restart-computer/i,
  /git\s+push\s+.*--force/i,
  /npm\s+publish/i,
  /\|\s*(sh|bash|powershell|pwsh)\b/i,
  /curl\s+.*\|\s*/i,
  /Invoke-Expression|iex\s/i,
];

const WRITE_TOOLS = new Set(["write", "edit", "write_file", "edit_file", "patch"]);
const TIME_SENSITIVE = /删除|格式化|安装|卸载|支付|转账|密码|凭据|delete|format|install|uninstall|payment/i;
/** MCP 工具里会"动手"的那些（读页面、截图不用问） */
const ACTION_MCP = /__([a-z_]*(click|type|press|key|drag|scroll|launch|close|kill|open)[a-z_]*)$/i;

function isDestructive(command: string): boolean {
  return DESTRUCTIVE.some((pattern) => pattern.test(command));
}

function outsideHome(target: string): boolean {
  if (!target) return false;
  const resolved = path.resolve(target.replace(/^~(?=$|[\\/])/, os.homedir()));
  const home = path.resolve(os.homedir());
  const relative = path.relative(home, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function riskyFilePath(input: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "target"]) {
    const value = input[key];
    if (typeof value === "string" && value && outsideHome(value)) return value;
  }
  return null;
}

export default function kivoraPermission(pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!ctx?.hasUI) return;

    const toolName = String(event?.toolName ?? "");
    const input = (event?.input ?? {}) as Record<string, unknown>;

    // 1) MCP 工具（cua / playwright）：读类的放行，动作类的问一下
    if (toolName.startsWith("mcp__")) {
      if (!ACTION_MCP.test(toolName)) return;
      const ok = await ctx.ui.confirm(`Kivora：${toolName}`, JSON.stringify(input).slice(0, 240));
      if (!ok) return { block: true, reason: "用户在 Kivora 里拒绝了这次操作" };
      return;
    }

    // 2) bash：危险命令必须问
    if (toolName === "bash" || toolName === "shell") {
      const command = String(input.command ?? "");
      if (!isDestructive(command)) return;
      const ok = await ctx.ui.confirm(
        "Kivora：这条命令有风险",
        command.length > 240 ? `${command.slice(0, 240)}…` : command,
      );
      if (!ok) return { block: true, reason: "用户在 Kivora 里拒绝了这条命令" };
      return;
    }

    // 3) 写文件：家目录以外要问
    if (WRITE_TOOLS.has(toolName)) {
      const target = riskyFilePath(input);
      if (!target) return;
      const ok = await ctx.ui.confirm("Kivora：要写家目录以外的地方", `${toolName} → ${target}`);
      if (!ok) return { block: true, reason: "用户在 Kivora 里拒绝了这次写入" };
    }
  });
}

export { TIME_SENSITIVE };
