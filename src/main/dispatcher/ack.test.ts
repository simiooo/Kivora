import { beforeEach, describe, expect, it } from "vitest";
import { ackKindOf, acknowledgmentFor, isQuestion, looksActionable, resetAckCursor, stripWakeName } from "./ack.ts";

beforeEach(() => resetAckCursor());

describe("接话的意图粗分", () => {
  it("问句", () => {
    expect(ackKindOf("刚才那个做完了吗？")).toBe("question");
    expect(ackKindOf("为什么没挪过去")).toBe("question");
    expect(ackKindOf("下载目录里还有什么")).toBe("question");
  });

  it("动作请求", () => {
    expect(ackKindOf("把下载目录里上周的 pdf 挪到文档/发票")).toBe("task");
    expect(ackKindOf("帮我在京东搜机械键盘")).toBe("task");
    expect(ackKindOf("整理一下发票")).toBe("task");
  });

  it("剩下的一律当没听明白", () => {
    expect(ackKindOf("那个")).toBe("unclear");
    expect(ackKindOf("嗯")).toBe("unclear");
  });

  it("能区分「只是在问」和「要动手」", () => {
    expect(isQuestion("今天星期几？")).toBe(true);
    expect(looksActionable("今天星期几？")).toBe(false);

    expect(isQuestion("把下载目录的 pdf 挪走")).toBe(false);
    expect(looksActionable("把下载目录的 pdf 挪走")).toBe(true);

    // 带问号但确实要动手：两边都成立，判成任务优先级更高
    expect(isQuestion("能不能把这些发票挪到文档？")).toBe(true);
    expect(looksActionable("能不能把这些发票挪到文档？")).toBe(true);
  });
});

describe("接话短语", () => {
  it("按意图给不同的话", () => {
    expect(acknowledgmentFor("把发票挪过去")).toMatch(/捋一捋|理一下|安排/);
    expect(acknowledgmentFor("做完了吗？")).toMatch(/看一下|查一下/);
    expect(acknowledgmentFor("嗯")).toBe("嗯，我想想。");
  });

  it("同样的意图会轮换说法，但都在同一组里", () => {
    const first = acknowledgmentFor("整理发票");
    const second = acknowledgmentFor("整理发票");
    expect(first).not.toBe(second);
    expect([first, second].every((phrase) => /捋一捋|理一下|安排/.test(phrase))).toBe(true);
  });

  it("短语都很短，适合先出声", () => {
    for (const text of ["整理发票", "做完了吗", "嗯"]) {
      expect(acknowledgmentFor(text).length).toBeLessThanOrEqual(10);
    }
  });
});

describe("叫名字", () => {
  it("开头的称呼会被去掉，指令本身不变", () => {
    expect(stripWakeName("小栗，今天星期几？")).toBe("今天星期几？");
    expect(stripWakeName("小栗 把发票挪过去")).toBe("把发票挪过去");
    expect(stripWakeName("Kivora: 停")).toBe("停");
  });

  it("没叫名字就原样返回", () => {
    expect(stripWakeName("把发票挪过去")).toBe("把发票挪过去");
  });

  it("整句只有称呼时退回原文，别变成空指令", () => {
    expect(stripWakeName("小栗")).toBe("小栗");
  });
});
