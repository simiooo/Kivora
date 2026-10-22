import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeStore, openStore, pruneOldData, recoverOrphanSessions } from "./store.ts";
import {
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  listActiveSessions,
  listSessionItems,
  listSessionMessages,
  listTimeline,
  patchStatus,
  setSessionState,
} from "./repos/sessions.ts";
import { enqueue, listQueue, promoteQueued, removeFromQueue, takeNextQueued } from "./repos/queue.ts";
import { addGrant, createApproval, expireStaleApprovals, getApproval, listGrants, resolveApproval } from "./repos/approvals.ts";
import { CONFIG_DEFAULTS, getConfig, setConfig } from "./repos/config.ts";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kivora-test-"));
  openStore(dir);
});

afterEach(() => {
  closeStore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("迁移与基础读写", () => {
  it("建库到 v2，config 有默认值", () => {
    expect(getConfig().hotkey).toBe(CONFIG_DEFAULTS.hotkey);
  });

  it("配置只接受已知键", () => {
    setConfig({ hotkey: "Control+Alt+K", nope: 1 } as never);
    expect(getConfig().hotkey).toBe("Control+Alt+K");
    expect("nope" in getConfig()).toBe(false);
  });

  it("消息按时间正序返回", () => {
    appendMessage({ role: "user", content: "第一句", ts: 1000 });
    appendMessage({ role: "assistant", content: "第二句", ts: 2000 });
    const timeline = listTimeline(10);
    expect(timeline.map((message) => message.content)).toEqual(["第一句", "第二句"]);
  });

  it("迁移是幂等的（重开后不重复建表）", () => {
    closeStore();
    const info = openStore(dir);
    expect(info.schemaVersion).toBe(2);
    expect(getConfig().hotkey).toBe(CONFIG_DEFAULTS.hotkey);
  });
});

describe("会话", () => {
  it("建会话带状态投影", () => {
    const session = createSession({ title: "整理发票", prompt: "挪 pdf", runner: "mock" });
    expect(session.state).toBe("queued");
    patchStatus(session.id, { state: "running", turn: 1, phase: "acting", tool: "读目录" });
    const refreshed = getSession(session.id);
    expect(refreshed?.status.tool).toBe("读目录");
    expect(refreshed?.status.turn).toBe(1);
  });

  it("活动会话只列没结束的", () => {
    const a = createSession({ title: "A", prompt: "a", runner: "mock", state: "running" });
    createSession({ title: "B", prompt: "b", runner: "mock", state: "done" });
    expect(listActiveSessions().map((session) => session.id)).toEqual([a.id]);
  });

  it("按标题、消息内容搜索", () => {
    const session = createSession({ title: "整理发票", prompt: "挪 pdf", runner: "mock" });
    appendMessage({ role: "assistant", content: "4 个文件已就位", sessionId: session.id });
    expect(listSessionItems("发票").length).toBe(1);
    expect(listSessionItems("就位").length).toBe(1);
    expect(listSessionItems("不存在的东西").length).toBe(0);
  });

  it("删除会话会带走消息、事件与排队", () => {
    const session = createSession({ title: "A", prompt: "a", runner: "mock" });
    appendMessage({ role: "user", content: "hi", sessionId: session.id });
    enqueue(session.id, "hi", "queue");
    deleteSession(session.id);
    expect(getSession(session.id)).toBeNull();
    expect(listSessionMessages(session.id)).toEqual([]);
    expect(listQueue()).toEqual([]);
  });

  it("孤儿会话在启动时标失败，不假装还在跑", () => {
    const session = createSession({ title: "跑到一半退出", prompt: "x", runner: "mock", state: "running" });
    expect(recoverOrphanSessions()).toBe(1);
    const recovered = getSession(session.id);
    expect(recovered?.state).toBe("failed");
    expect(recovered?.error?.retryable).toBe(true);
  });
});

describe("队列", () => {
  it("排到队尾，取队首先进先出", () => {
    const a = createSession({ title: "A", prompt: "a", runner: "mock", state: "queued" });
    const b = createSession({ title: "B", prompt: "b", runner: "mock", state: "queued" });
    enqueue(a.id, "a", "queue");
    enqueue(b.id, "b", "queue");
    expect(takeNextQueued()?.sessionId).toBe(a.id);
    expect(listQueue().length).toBe(1);
  });

  it("提前操作把队尾挪到队首", () => {
    const a = createSession({ title: "A", prompt: "a", runner: "mock" });
    const b = createSession({ title: "B", prompt: "b", runner: "mock" });
    const first = enqueue(a.id, "a", "queue");
    const second = enqueue(b.id, "b", "queue");
    promoteQueued(second.id);
    expect(listQueue()[0].id).toBe(second.id);
    expect(first.position).toBeLessThan(second.position);
  });

  it("同一会话最多 2 条，队列上限 5 条", () => {
    const a = createSession({ title: "A", prompt: "a", runner: "mock" });
    enqueue(a.id, "1", "queue");
    enqueue(a.id, "2", "queue");
    expect(() => enqueue(a.id, "3", "queue")).toThrowError(/2 条/);
    const b = createSession({ title: "B", prompt: "b", runner: "mock" });
    enqueue(b.id, "1", "queue");
    const c = createSession({ title: "C", prompt: "c", runner: "mock" });
    enqueue(c.id, "1", "queue");
    const d = createSession({ title: "D", prompt: "d", runner: "mock" });
    enqueue(d.id, "1", "queue");
    const e = createSession({ title: "E", prompt: "e", runner: "mock" });
    expect(() => enqueue(e.id, "1", "queue")).toThrowError(/最多 5 条/);
  });

  it("取消不存在的排队项会报错", () => {
    expect(() => removeFromQueue("q_00000000")).toThrowError(/不在了/);
  });
});

describe("审批", () => {
  it("创建后是 pending，解决后状态与回执一致", () => {
    const session = createSession({ title: "A", prompt: "a", runner: "mock" });
    const approval = createApproval({
      source: "session",
      sessionId: session.id,
      tool: "move_file",
      risk: "G2",
      title: "移动到 文档/发票",
      summary: "要移动 4 个文件，可以吗？",
      detail: ["a.pdf", "b.pdf"],
      speech: "要移动 4 个文件，可以吗？",
    });
    expect(approval.status).toBe("pending");
    expect(approval.expiresAt).not.toBeNull();
    const resolved = resolveApproval(approval.id, "allow_once");
    expect(resolved.status).toBe("allowed");
    expect(resolved.resolution).toBe("allow_once");
  });

  it("重复解决是幂等的", () => {
    const approval = createApproval({
      source: "session",
      sessionId: null,
      tool: "x",
      risk: "G1",
      title: "t",
      summary: "s",
      detail: [],
      speech: "s",
    });
    resolveApproval(approval.id, "deny");
    expect(resolveApproval(approval.id, "allow_once").status).toBe("denied");
  });

  it("G3 不自动超时", () => {
    const approval = createApproval({
      source: "session",
      sessionId: null,
      tool: "install",
      risk: "G3",
      title: "装软件",
      summary: "s",
      detail: [],
      speech: "s",
    });
    expect(approval.expiresAt).toBeNull();
    expect(approval.options).toEqual(["allow_once", "deny"]);
  });

  it("到期默认拒绝", () => {
    const approval = createApproval({
      source: "session",
      sessionId: null,
      tool: "x",
      risk: "G1",
      title: "t",
      summary: "s",
      detail: [],
      speech: "s",
      timeoutMs: 1,
    });
    const expired = expireStaleApprovals(Date.now() + 10);
    expect(expired.map((item) => item.id)).toContain(approval.id);
    expect(getApproval(approval.id)?.status).toBe("expired");
  });

  it("作用域授权写进 grants", () => {
    const session = createSession({ title: "A", prompt: "a", runner: "mock" });
    const approval = createApproval({
      source: "session",
      sessionId: session.id,
      tool: "move_file",
      risk: "G2",
      title: "t",
      summary: "s",
      detail: [],
      speech: "s",
      timeoutMs: null,
    });
    resolveApproval(approval.id, "allow_scope");
    expect(listGrants().some((grant) => grant.tool === "move_file")).toBe(true);
    addGrant({ sessionId: null, tool: "copy_file", scope: "any", value: "x", expiresAt: null });
    expect(listGrants().length).toBe(2);
  });
});

describe("保留策略", () => {
  it("清掉过期事件但不删消息", () => {
    const session = createSession({ title: "A", prompt: "a", runner: "mock" });
    appendMessage({ role: "user", content: "保留我", sessionId: session.id });
    setSessionState(session.id, "done");
    pruneOldData(1);
    expect(listSessionMessages(session.id).length).toBe(1);
  });
});
