import { describe, expect, it } from "vitest";
import { piBindingFor } from "./pi-config.ts";

describe("Kivora 模型 → Pi 的 provider", () => {
  it("DeepSeek 用 deepseek 前缀和 DEEPSEEK_API_KEY", () => {
    expect(piBindingFor({ baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-flash" })).toEqual({
      spec: "deepseek/deepseek-flash",
      envName: "DEEPSEEK_API_KEY",
    });
  });

  it("OpenAI 和 Anthropic 各自对应", () => {
    expect(piBindingFor({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-4.1-mini" })).toEqual({
      spec: "openai/gpt-4.1-mini",
      envName: "OPENAI_API_KEY",
    });
    expect(piBindingFor({ baseUrl: "https://api.anthropic.com/v1", modelId: "claude-sonnet-4-6" })).toEqual({
      spec: "anthropic/claude-sonnet-4-6",
      envName: "ANTHROPIC_API_KEY",
    });
  });

  it("不认识的域名不瞎猜（宁可让 Pi 报没模型）", () => {
    expect(piBindingFor({ baseUrl: "http://127.0.0.1:11434/v1", modelId: "qwen2.5" })).toBeNull();
    expect(piBindingFor({ baseUrl: "https://example.com/v1", modelId: "x" })).toBeNull();
  });

  it("模型 ID 不能带空格/引号之类的东西", () => {
    expect(piBindingFor({ baseUrl: "https://api.deepseek.com", modelId: "deep seek" })).toBeNull();
    expect(piBindingFor({ baseUrl: "https://api.deepseek.com", modelId: 'x" --yolo' })).toBeNull();
  });

  it("没有模型时返回 null", () => {
    expect(piBindingFor(null)).toBeNull();
  });
});
