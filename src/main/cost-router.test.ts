import { beforeEach, describe, expect, it } from "vitest";
import {
  REALTIME_BUDGET,
  canUseRealtime,
  channelStats,
  chooseAsrChannel,
  noteTurn,
  resetChannelStats,
} from "./cost-router.ts";

beforeEach(() => resetChannelStats());

describe("成本路由", () => {
  it("没有流式模型就走批次", () => {
    expect(chooseAsrChannel({ streamingReady: false, conversational: true })).toMatchObject({ channel: "batch" });
  });

  it("单次指令走批次，持续对话才走流式", () => {
    expect(chooseAsrChannel({ streamingReady: true, conversational: false }).channel).toBe("batch");
    expect(chooseAsrChannel({ streamingReady: true, conversational: true }).channel).toBe("realtime");
  });

  it("分档统计能算实时占比", () => {
    noteTurn("a0");
    noteTurn("a0");
    noteTurn("a1");
    noteTurn("l3");
    const stats = channelStats();
    expect(stats.total).toBe(4);
    expect(stats.a0).toBe(2);
    expect(stats.realtimeRatio).toBeCloseTo(0.25, 5);
  });

  it("样本少时不拦实时通道（不然前几轮全禁）", () => {
    noteTurn("l3");
    expect(canUseRealtime()).toBe(true);
  });

  it("样本够了就按 3% 硬挡", () => {
    for (let index = 0; index < 20; index++) noteTurn("a2");
    expect(canUseRealtime()).toBe(true);
    for (let index = 0; index < 5; index++) noteTurn("l3"); // 5/25 = 20%
    expect(canUseRealtime()).toBe(false);
    expect(channelStats().realtimeAllowed).toBe(false);
    expect(REALTIME_BUDGET).toBe(0.03);
  });
});
