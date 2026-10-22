import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppError } from "../../shared/errors.ts";

/**
 * 真正能执行的一条路：文件整理。
 *
 * 硬边界（不是提示，是拒绝）：
 * - 只碰 下载 / 文档 / 桌面 三个根目录及其子目录；
 * - 不覆盖同名文件，不删除任何东西；
 * - 一次最多 200 个文件。
 */

export type RootName = "downloads" | "documents" | "desktop";

const ROOT_LABELS: Record<RootName, string> = {
  downloads: "下载",
  documents: "文档",
  desktop: "桌面",
};

export interface Roots {
  downloads: string;
  documents: string;
  desktop: string;
}

export function homeRoots(): Roots {
  // KIVORA_HOME 只给测试/演练用：把"家"指到一个临时目录，避免碰真文件
  const home = process.env.KIVORA_HOME || os.homedir();
  return {
    downloads: path.join(home, "Downloads"),
    documents: path.join(home, "Documents"),
    desktop: path.join(home, "Desktop"),
  };
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 把用户说的目录名映射到真实路径，并保证在允许的根里 */
export function resolveTarget(raw: string, roots: Roots = homeRoots()): string {
  const cleaned = raw
    .trim()
    .replace(/^[「"'“]|[」"'”]$/g, "")
    .replace(/[。！!？?]+$/, "")
    .replace(/\\/g, "/");
  if (!cleaned) throw new AppError("invalid_input", { message: "没说清要放到哪儿。" });

  // 绝对路径：必须在允许的根里，否则直接拒绝（不许往 C:\Windows 之类的地方写）
  const absolute = /^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith("/");
  if (absolute) {
    const resolved = path.resolve(cleaned);
    for (const root of Object.values(roots)) {
      if (isInside(root, resolved)) return resolved;
    }
    throw new AppError("invalid_input", { message: "只能整理 下载 / 文档 / 桌面 里面的东西。" });
  }

  const parts = cleaned.split("/").filter(Boolean);
  const head = parts[0] ?? "";
  let root: RootName = "documents";
  if (/下载|downloads?/i.test(head)) root = "downloads";
  else if (/桌面|desktop/i.test(head)) root = "desktop";
  else if (/文档|documents?/i.test(head)) root = "documents";

  const rest = /下载|downloads?|桌面|desktop|文档|documents?/i.test(head) ? parts.slice(1) : parts;
  const rootPath = roots[root];
  const target = path.resolve(rootPath, ...rest);
  if (!isInside(rootPath, target)) {
    throw new AppError("invalid_input", { message: `只能整理 ${ROOT_LABELS[root]} 目录里面的东西。` });
  }
  return target;
}

export interface ParsedFileTask {
  action: "move" | "copy";
  sourceRoot: RootName;
  sourceDir: string;
  targetDir: string;
  extensions: string[];
  sinceDays: number;
  /** 给 UI 看的一句话 */
  label: string;
}

const EXT_GROUPS: Array<{ match: RegExp; extensions: string[]; label: string }> = [
  { match: /pdf/i, extensions: [".pdf"], label: "pdf" },
  { match: /图片|照片|截图|截屏|png|jpg/i, extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif"], label: "图片" },
  { match: /表格|excel|xlsx?|csv/i, extensions: [".xlsx", ".xls", ".csv"], label: "表格" },
  { match: /word|docx?|文档文件/i, extensions: [".doc", ".docx"], label: "Word" },
  { match: /压缩包|zip|rar/i, extensions: [".zip", ".rar", ".7z"], label: "压缩包" },
];

export function parseFileTask(utterance: string, roots: Roots = homeRoots()): ParsedFileTask | null {
  const text = utterance.trim();
  if (!/挪|移动|移到|整理|归档|放到|复制|拷到|拷到/.test(text)) return null;

  const targetMatch = text.match(/(?:挪到|移动到|移到|整理到|归档到|放到|复制到|拷到)\s*([^，。！？,.!?]+)/);
  if (!targetMatch) return null;
  let targetDir: string;
  try {
    targetDir = resolveTarget(targetMatch[1], roots);
  } catch {
    return null;
  }

  let sourceRoot: RootName = "downloads";
  if (/桌面|desktop/i.test(text)) sourceRoot = "desktop";
  else if (/下载|downloads?/i.test(text)) sourceRoot = "downloads";
  else if (/文档|documents?/i.test(text) && !/挪到|移动到|放到/.test(text.split(/下载|桌面/i)[0] ?? "")) {
    sourceRoot = "documents";
  }

  const group = EXT_GROUPS.find((item) => item.match.test(text));
  const extensions = group?.extensions ?? [".pdf"];
  const label = group?.label ?? "pdf";

  // 源目录和目标目录是同一个地方，等于什么都没做
  if (path.resolve(targetDir) === path.resolve(roots[sourceRoot])) return null;

  let sinceDays = 7;
  if (/今天/.test(text)) sinceDays = 1;
  else if (/昨天/.test(text)) sinceDays = 2;
  else if (/上周|最近一周|这一周/.test(text)) sinceDays = 7;
  else if (/本月|这个月/.test(text)) sinceDays = 30;
  else if (/上个月/.test(text)) sinceDays = 60;

  const action: "move" | "copy" = /复制|拷到/.test(text) ? "copy" : "move";
  return {
    action,
    sourceRoot,
    sourceDir: roots[sourceRoot],
    targetDir,
    extensions,
    sinceDays,
    label,
  };
}

export interface ScannedFile {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

const MAX_FILES = 200;

export function scanFiles(task: ParsedFileTask, now = Date.now()): ScannedFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(task.sourceDir, { withFileTypes: true });
  } catch (err) {
    throw new AppError("not_found", {
      message: `找不到 ${ROOT_LABELS[task.sourceRoot]} 目录：${task.sourceDir}`,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const cutoff = now - task.sinceDays * 86_400_000;
  const files: ScannedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!task.extensions.includes(extension)) continue;
    const full = path.join(task.sourceDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff) continue;
    files.push({ name: entry.name, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return files.slice(0, MAX_FILES);
}

export interface TransferResult {
  moved: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** 不覆盖、不删除：同名就跳过并报告 */
export function transferFiles(
  files: ScannedFile[],
  targetDir: string,
  action: "move" | "copy",
): TransferResult {
  fs.mkdirSync(targetDir, { recursive: true });
  const moved: string[] = [];
  const skipped: TransferResult["skipped"] = [];
  for (const file of files) {
    const destination = path.join(targetDir, file.name);
    if (fs.existsSync(destination)) {
      skipped.push({ name: file.name, reason: "目标里已经有同名文件" });
      continue;
    }
    try {
      if (action === "copy") {
        fs.copyFileSync(file.path, destination);
      } else {
        try {
          fs.renameSync(file.path, destination);
        } catch {
          // 跨盘 rename 会 EXDEV，退化成复制 + 删除源文件
          fs.copyFileSync(file.path, destination);
          fs.unlinkSync(file.path);
        }
      }
      moved.push(file.name);
    } catch (err) {
      skipped.push({ name: file.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { moved, skipped };
}

export function describeTarget(targetDir: string, roots: Roots = homeRoots()): string {
  for (const [name, root] of Object.entries(roots) as Array<[RootName, string]>) {
    if (isInside(root, targetDir)) {
      const rest = path.relative(root, targetDir).split(path.sep).join("/");
      return rest ? `${ROOT_LABELS[name]}/${rest}` : ROOT_LABELS[name];
    }
  }
  return targetDir;
}
