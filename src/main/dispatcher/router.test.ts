import { describe, expect, it } from "vitest";
import { renderStatus, route, type RouterContext } from "./router.ts";

const idle: RouterContext = {
  pendingApproval: null,
  running: null,
  lastFailed: null,
  lastPaused: null,
  lastReferenced: null,
  queueCount: 0,
};

const running: RouterContext = {
  ...idle,
  running: { id: "s_aaaa1111", state: "running", title: "搜索机械键盘", phase: "acting" },
};

const waiting: RouterContext = {
  ...running,
  pendingApproval: { id: "ap_aaaa1111", risk: "G2" },
};

describe("反射路由", () => {
  it("没有在跑的任务时，一句话就是建任务", () => {
    expect(route("把下载目录里上周的 pdf 挪到文档/发票", idle)).toMatchObject({ kind: "create_task" });
  });

  it("说「可以」= 允许一次", () => {
    expect(route("可以", waiting)).toEqual({ kind: "approve", resolution: "allow_once" });
  });

  it("说「以后都行」= 作用域允许", () => {
    expect(route("以后都行", waiting)).toEqual({ kind: "approve", resolution: "allow_scope" });
  });

  it("说「不行」= 拒绝", () => {
    expect(route("不行", waiting)).toEqual({ kind: "approve", resolution: "deny" });
  });

  it("G3 不走语音，仍按建任务/查询处理", () => {
    const g3: RouterContext = { ...running, pendingApproval: { id: "ap_bbbb2222", risk: "G3" } };
    expect(route("可以", g3).kind).not.toBe("approve");
  });

  it("「可以帮我把…」不会被当成同意", () => {
    expect(route("可以帮我把文件夹打开", waiting).kind).not.toBe("approve");
  });

  it("说「停」= 取消当前任务", () => {
    expect(route("停", running)).toEqual({ kind: "cancel", sessionId: "s_aaaa1111" });
  });

  it("「停一下」不会误伤（不是精确取消词）", () => {
    expect(route("停在哪儿了", running).kind).toBe("status");
  });

  it("查进度不建任务", () => {
    expect(route("刚才那个做完了吗", running).kind).toBe("status");
  });

  it("没有在跑时查进度也能答", () => {
    expect(route("怎么样了", idle).kind).toBe("status");
  });

  it("「先做这个」= 插队", () => {
    expect(route("先做这个", running).kind).toBe("promote");
  });

  it("「先帮我搜一下」不是插队", () => {
    expect(route("先帮我搜一下机械键盘", idle)).toMatchObject({ kind: "create_task" });
  });

  it("失败后有「重试」", () => {
    const failed: RouterContext = { ...idle, lastFailed: { id: "s_cccc3333" } };
    expect(route("重试", failed)).toEqual({ kind: "retry", sessionId: "s_cccc3333", mode: "continue" });
  });

  it("空话什么都不做", () => {
    expect(route("   ", idle)).toEqual({ kind: "none" });
  });

  it("语音改配置：识别语言", () => {
    expect(route("切成英文识别", idle)).toEqual({ kind: "config", asrLanguage: "en" });
    expect(route("用中文识别", idle)).toEqual({ kind: "config", asrLanguage: "zh" });
    expect(route("识别语言改成自动", idle)).toEqual({ kind: "config", asrLanguage: "auto" });
  });

  it("语音改配置：语速", () => {
    expect(route("语速快一点", idle)).toEqual({ kind: "config", speedDelta: 0.1 });
    expect(route("语速慢一点", idle)).toEqual({ kind: "config", speedDelta: -0.1 });
  });

  it("改配置的话不会被当成任务去执行", () => {
    expect(route("切成英文识别", idle).kind).not.toBe("create_task");
    expect(route("语速快一点", running).kind).toBe("config");
  });
});

describe("状态口语化", () => {
  it("说清第几轮、在干什么、多久", () => {
    const text = renderStatus({
      title: "搜索机械键盘",
      state: "running",
      phase: "acting",
      turn: 3,
      tool: "输入并排序",
      elapsedMs: 12_000,
      needs: null,
      summary: null,
      artifacts: [],
    });
    expect(text).toContain("搜索机械键盘");
    expect(text).toContain("第 3 轮");
    expect(text).toContain("12 秒");
  });

  it("完成的会话直接给结论", () => {
    const text = renderStatus({
      title: "整理发票",
      state: "done",
      phase: "idle",
      turn: 2,
      tool: null,
      elapsedMs: 32_000,
      needs: null,
      summary: "挪好了，4 个。",
      artifacts: [],
    });
    expect(text).toContain("挪好了");
  });

  it("等确认时说明卡在审批", () => {
    const text = renderStatus({
      title: "整理第二批发票",
      state: "waiting_user",
      phase: "acting",
      turn: 1,
      tool: "move_file",
      elapsedMs: 5_000,
      needs: "confirm",
      summary: null,
      artifacts: [],
    });
    expect(text).toContain("等你");
  });
});
