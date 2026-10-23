import { describe, expect, it } from "vitest";
import { splitSpeech } from "./speech-chunks.ts";

describe("播报拆句", () => {
  it("短句不拆", () => {
    expect(splitSpeech("好，我去整理。")).toEqual(["好，我去整理。"]);
    expect(splitSpeech("   ")).toEqual([]);
  });

  it("长文本按句末切开，顺序不变", () => {
    const text = "按销量排下来，前 12 个是这些（价格是页面标价，没算券）：Keychron K8 Pro 87 键 699 元。狼蛛 F87 Pro 87 键 299 元。达尔优 A98 Pro 98 键 499 元。";
    const chunks = splitSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("最多四段，多出来的并进最后一段", () => {
    const text = "第一句在这里啊。第二句也在这里。第三句还在这里。第四句仍然在。第五句继续在。第六句结束了。";
    const chunks = splitSpeech(text);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks.join("")).toBe(text);
  });

  it("没有句末标点但很长：原样返回（别硬切）", () => {
    const text = "这是一个没有任何句末标点但是非常非常长的句子用来测试不要硬切";
    expect(splitSpeech(text)).toEqual([text]);
  });

  it("换行也算断句", () => {
    const text = "第一行内容比较长一点啊，这里再多写几个字凑够长度\n第二行内容同样比较长一点，也再多写几个字凑够长度";
    expect(splitSpeech(text).length).toBeGreaterThan(1);
  });
});
