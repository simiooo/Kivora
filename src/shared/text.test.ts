import { describe, expect, it } from "vitest";
import {
  displayPath,
  foldOutput,
  formatDuration,
  formatHotkey,
  maskKey,
  middleEllipsis,
  tailEllipsis,
} from "../shared/text.ts";

describe("省略号规则", () => {
  it("散文用尾部省略", () => {
    expect(tailEllipsis("把下载目录里上周的 pdf 挪到文档/发票", 10)).toBe("把下载目录里上周的…");
    expect(tailEllipsis("短句", 10)).toBe("短句");
  });

  it("路径用中间省略，保住文件名", () => {
    const path = "C:\\Users\\qq651\\Downloads\\2026-03\\发票-0912.pdf";
    const result = middleEllipsis(path, 30);
    expect(result).toContain("…");
    expect(result.endsWith("发票-0912.pdf")).toBe(true);
    expect(result.startsWith("C:\\User")).toBe(true);
  });

  it("短字符串不动", () => {
    expect(middleEllipsis("abc", 10)).toBe("abc");
  });

  it("max 太小时只留省略号", () => {
    expect(middleEllipsis("abcdef", 3)).toBe("…");
  });

  it("displayPath 统一分隔符", () => {
    expect(displayPath("C:/Users/qq/Downloads/a.pdf", 20)).toContain("\\");
  });
});

describe("Key 掩码", () => {
  it("保留头尾", () => {
    expect(maskKey("sk-1234567890abcdef")).toBe("sk-••••••cdef");
  });
  it("太短就全遮", () => {
    expect(maskKey("short")).toBe("•••••");
  });
});

describe("折叠", () => {
  it("按行折叠", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const folded = foldOutput(text, 8, 2000);
    expect(folded.truncated).toBe(true);
    expect(folded.text.length).toBeLessThan(text.length);
  });

  it("短输出不折叠", () => {
    expect(foldOutput("ok", 8, 2000)).toEqual({ text: "ok", truncated: false });
  });
});

describe("格式化", () => {
  it("时长", () => {
    expect(formatDuration(8_000)).toBe("8s");
    expect(formatDuration(80_000)).toBe("1m20s");
    expect(formatDuration(3_600_000)).toBe("1h0m");
  });

  it("热键", () => {
    expect(formatHotkey("CommandOrControl+Alt+Space")).toBe("Ctrl+Alt+Space");
  });
});
