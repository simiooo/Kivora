import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelRecord } from "../../shared/domain.ts";
import { DEFAULT_PARAMS } from "../../shared/domain.ts";
import { chatCompletion } from "./llm.ts";

let server: Server | null = null;

function start(body: unknown): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
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
    name: "测试",
    provider: "openai",
    capability: "chat",
    baseUrl,
    modelId: "deepseek-flash",
    params: { ...DEFAULT_PARAMS },
    headers: [],
    hasKey: true,
    keyHint: "sk-…abcd",
    testStatus: "untested",
    testedAt: null,
    testLatencyMs: null,
    createdAt: 0,
    updatedAt: 0,
  } as ModelRecord;
}

describe("chatCompletion", () => {
  it("空正文默认算失败（防止把不是对话接口的端点当成能用）", async () => {
    const baseUrl = await start({ choices: [{ message: { content: "" } }] });
    await expect(chatCompletion(model(baseUrl), "k", [{ role: "user", content: "ping" }])).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("allowEmpty 时空正文放行——思考模型在小 max_tokens 下就是这样", async () => {
    const baseUrl = await start({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 3, completion_tokens: 0 } });
    const result = await chatCompletion(model(baseUrl), "k", [{ role: "user", content: "ping" }], {
      maxTokens: 16,
      allowEmpty: true,
    });
    expect(result.text).toBe("");
  });

  it("正常返回时把正文和用量解出来", async () => {
    const baseUrl = await start({
      choices: [{ message: { content: "pong" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const result = await chatCompletion(model(baseUrl), "k", [{ role: "user", content: "ping" }]);
    expect(result.text).toBe("pong");
    expect(result.usage).toEqual({ input: 5, output: 2 });
  });
});
