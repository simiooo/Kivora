import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeTarget,
  isInside,
  parseFileTask,
  resolveTarget,
  scanFiles,
  transferFiles,
  type Roots,
} from "./files.ts";

let home = "";
let roots: Roots;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kivora-files-"));
  roots = {
    downloads: path.join(home, "Downloads"),
    documents: path.join(home, "Documents"),
    desktop: path.join(home, "Desktop"),
  };
  fs.mkdirSync(roots.downloads, { recursive: true });
  fs.mkdirSync(roots.documents, { recursive: true });
  fs.mkdirSync(roots.desktop, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function touch(dir: string, name: string, mtimeDaysAgo = 1): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, "x");
  const when = Date.now() - mtimeDaysAgo * 86_400_000;
  fs.utimesSync(full, new Date(when), new Date(when));
  return full;
}

describe("路径边界", () => {
  it("isInside 认子目录、拒邻近目录", () => {
    expect(isInside(roots.downloads, path.join(roots.downloads, "a"))).toBe(true);
    expect(isInside(roots.downloads, path.join(home, "Downloads2"))).toBe(false);
    expect(isInside(roots.downloads, home)).toBe(false);
  });

  it("拒绝跳出允许的根", () => {
    expect(() => resolveTarget("文档/../../Windows", roots)).toThrowError(/只能整理/);
  });

  it("把口语目录映射成真实路径", () => {
    expect(resolveTarget("文档/发票", roots)).toBe(path.join(roots.documents, "发票"));
    expect(resolveTarget("下载/发票", roots)).toBe(path.join(roots.downloads, "发票"));
    expect(resolveTarget("桌面", roots)).toBe(roots.desktop);
  });

  it("目标等于源目录时不算任务", () => {
    expect(parseFileTask("把下载目录里上周的 pdf 挪到下载", roots)).toBeNull();
  });
});

describe("解析指令", () => {
  it("认得出「把下载目录里上周的 pdf 挪到文档/发票」", () => {
    const task = parseFileTask("把下载目录里上周的 pdf 挪到文档/发票", roots);
    expect(task).not.toBeNull();
    expect(task?.sourceRoot).toBe("downloads");
    expect(task?.targetDir).toBe(path.join(roots.documents, "发票"));
    expect(task?.extensions).toEqual([".pdf"]);
    expect(task?.sinceDays).toBe(7);
    expect(task?.action).toBe("move");
  });

  it("认得出「复制」和「今天」", () => {
    const task = parseFileTask("把下载目录里今天的图片复制到桌面/截图", roots);
    expect(task?.action).toBe("copy");
    expect(task?.sinceDays).toBe(1);
    expect(task?.extensions).toContain(".png");
  });

  it("不是文件操作的指令不认领", () => {
    expect(parseFileTask("帮我在京东搜机械键盘", roots)).toBeNull();
    expect(parseFileTask("把下载目录里的东西挪到 C:/Windows", roots)).toBeNull();
  });
});

describe("扫描与搬运", () => {
  it("只挑指定类型和时间范围内的文件", () => {
    touch(roots.downloads, "old.pdf", 40);
    touch(roots.downloads, "new.pdf", 1);
    touch(roots.downloads, "note.txt", 1);
    const task = parseFileTask("把下载目录里上周的 pdf 挪到文档/发票", roots)!;
    const files = scanFiles(task);
    expect(files.map((file) => file.name)).toEqual(["new.pdf"]);
  });

  it("真的把文件搬过去", () => {
    touch(roots.downloads, "a.pdf", 1);
    touch(roots.downloads, "b.pdf", 1);
    const task = parseFileTask("把下载目录里上周的 pdf 挪到文档/发票", roots)!;
    const files = scanFiles(task);
    const result = transferFiles(files, task.targetDir, "move");
    expect(result.moved.sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(fs.existsSync(path.join(task.targetDir, "a.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(roots.downloads, "a.pdf"))).toBe(false);
  });

  it("不覆盖同名文件，跳过并说明原因", () => {
    touch(roots.downloads, "a.pdf", 1);
    fs.mkdirSync(path.join(roots.documents, "发票"), { recursive: true });
    fs.writeFileSync(path.join(roots.documents, "发票", "a.pdf"), "existing");
    const task = parseFileTask("把下载目录里上周的 pdf 挪到文档/发票", roots)!;
    const result = transferFiles(scanFiles(task), task.targetDir, "move");
    expect(result.moved).toEqual([]);
    expect(result.skipped[0].reason).toContain("同名");
    expect(fs.readFileSync(path.join(roots.documents, "发票", "a.pdf"), "utf8")).toBe("existing");
  });

  it("源目录不存在时说人话", () => {
    fs.rmSync(roots.downloads, { recursive: true, force: true });
    const task = parseFileTask("把下载目录里上周的 pdf 挪到文档/发票", roots)!;
    expect(() => scanFiles(task)).toThrowError(/找不到/);
  });

  it("目标展示成口语路径", () => {
    expect(describeTarget(path.join(roots.documents, "发票"), roots)).toBe("文档/发票");
    expect(describeTarget(roots.desktop, roots)).toBe("桌面");
  });
});
