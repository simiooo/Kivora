import { describe, expect, it } from "vitest";
import { buildBrainContext, type BrainContextInput } from "./brain-context.ts";

const base: BrainContextInput = {
  running: null,
  pendingApproval: false,
  queueCount: 0,
  lastRun: null,
  recentUtterances: [],
  preferences: { asrLanguage: "zh", narration: true },
};

describe("调度上下文分层", () => {
  it("空闲时不瞎编内容", () => {
    const text = buildBrainContext(base);
    expect(text).toContain("当前：空闲");
    expect(text).not.toContain("上次任务");
    expect(text).not.toContain("队列");
  });

  it("在跑、审批、队列都要说清楚", () => {
    const text = buildBrainContext({
      ...base,
      running: { title: "搜索机械键盘", phase: "acting" },
      pendingApproval: true,
      queueCount: 2,
    });
    expect(text).toContain("正在跑「搜索机械键盘」");
    expect(text).toContain("审批");
    expect(text).toContain("队列：2 条");
  });

  it("最近说过的话剪短，别把上下文撑爆", () => {
    const long = "把".repeat(80);
    const text = buildBrainContext({ ...base, recentUtterances: [long, "第二句", "第三句", "第四句"] });
    expect(text).toContain("最近说过：");
    expect(text).toContain("第二句");
    // 最多 3 句
    expect(text).not.toContain("第四句");
    // 长句被截断
    expect(text).toContain("…");
  });

  it("上次任务带状态和时间感", () => {
    const text = buildBrainContext({
      ...base,
      lastRun: { title: "整理发票", state: "done", ageMs: 3 * 60_000 },
    });
    expect(text).toContain("上次任务：整理发票");
    expect(text).toContain("做完了");
    expect(text).toContain("3 分钟前");
  });

  it("偏好层跟着设置走", () => {
    const text = buildBrainContext({ ...base, preferences: { asrLanguage: "en", narration: false } });
    expect(text).toContain("主要说英文");
    expect(text).toContain("不要主动出声");
  });

  it("不含时钟（否则每轮都变，前缀缓存就废了）", () => {
    const text = buildBrainContext(base);
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
  });
});
