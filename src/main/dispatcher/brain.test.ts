import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelRecord } from "../../shared/domain.ts";
import { DEFAULT_PARAMS } from "../../shared/domain.ts";
import { classify } from "./brain.ts";

let server: Server | null = null;
let lastBody = "";

/** 假端点：按顺序返回预设回复，同时记下我们发过去的 prompt */
function start(replies: string[]): Promise<string> {
  return new Promise((resolve) => {
    let index = 0;
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        lastBody = raw;
        const reply = replies[Math.min(index, replies.length - 1)] ?? "";
        index += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function model(baseUrl: string): ModelRecord {
  return {
    id: "m1",
    name: "brain",
    provider: "openai",
    capability: "chat",
    baseUrl,
    modelId: "deepseek-flash",
    params: { ...DEFAULT_PARAMS },
    headers: [],
    hasKey: true,
    keyHint: "sk-…",
    testStatus: "untested",
    testedAt: null,
    testLatencyMs: null,
    createdAt: 0,
    updatedAt: 0,
  } as ModelRecord;
}

describe("调度模型判别", () => {
  it("answer：问句直接给答案，不变成任务", async () => {
    const baseUrl = await start(['{"action":"answer","speech":"今天是 10 月 24 日，星期六。"}']);
    const decision = await classify(model(baseUrl), "k", "今天星期几？", "空闲");
    expect(decision?.action).toBe("answer");
    expect(decision?.speech).toContain("星期六");
  });

  it("create_task：带标题和旁白", async () => {
    const baseUrl = await start(['{"action":"create_task","title":"整理发票","speech":"好，我去整理。"}']);
    const decision = await classify(model(baseUrl), "k", "把下载目录里的发票挪到文档", "空闲");
    expect(decision?.action).toBe("create_task");
    expect(decision?.title).toBe("整理发票");
  });

  it("把当前时间一起发给模型（否则它不知道今天几号）", async () => {
    const baseUrl = await start(['{"action":"answer","speech":"好的"}']);
    await classify(model(baseUrl), "k", "今天星期几？", "空闲");
    expect(lastBody).toContain("现在是");
  });

  it("不认识的 action 直接判无效，交回反射路由", async () => {
    const baseUrl = await start(['{"action":"launch_rocket"}']);
    expect(await classify(model(baseUrl), "k", "随便说点什么", "空闲")).toBeNull();
  });

  it("模型返回废话（不是 JSON）也判无效", async () => {
    const baseUrl = await start(["我觉得可以。"]);
    expect(await classify(model(baseUrl), "k", "你好", "空闲")).toBeNull();
  });
});
