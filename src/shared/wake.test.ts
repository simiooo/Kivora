import { describe, expect, it } from "vitest";
import { containsWakeWord, withoutWakeWord } from "./wake.ts";

describe("唤醒词", () => {
  it("句首、句中、带标点都算叫了名字", () => {
    expect(containsWakeWord("小栗，把发票挪过去", "小栗")).toBe(true);
    expect(containsWakeWord("小 栗 把发票挪过去", "小栗")).toBe(true);
    expect(containsWakeWord("那个，小栗，帮我看下", "小栗")).toBe(true);
    expect(containsWakeWord("小栗你好", "小栗")).toBe(true);
  });

  it("没叫就是没叫（别把「小李」误判成「小栗」）", () => {
    expect(containsWakeWord("小李，把发票挪过去", "小栗")).toBe(false);
    expect(containsWakeWord("把发票挪过去", "小栗")).toBe(false);
  });

  it("英文唤醒词不区分大小写", () => {
    expect(containsWakeWord("Hey Kivora, open it", "kivora")).toBe(true);
  });

  it("去掉称呼只留指令", () => {
    expect(withoutWakeWord("小栗，把发票挪过去", "小栗")).toBe("把发票挪过去");
    expect(withoutWakeWord("Hey Kivora open it", "kivora")).toBe("open it");
    expect(withoutWakeWord("小 栗 : 停", "小栗")).toBe("停");
  });

  it("只有称呼时原样返回，不要变成空指令", () => {
    expect(withoutWakeWord("小栗", "小栗")).toBe("小栗");
  });

  it("空唤醒词不匹配任何东西", () => {
    expect(containsWakeWord("随便说点什么", "  ")).toBe(false);
    expect(withoutWakeWord("随便说点什么", "")).toBe("随便说点什么");
  });
});
