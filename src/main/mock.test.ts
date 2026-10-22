import { describe, expect, it } from "vitest";
import { mockDispatch } from "./mock.ts";
import type { AppConfig } from "../shared/ipc.ts";

const cfg = { brainModel: "test-model" } as AppConfig;

describe("mockDispatch", () => {
  it("stops on cancel", () => {
    expect(mockDispatch("算了", cfg)).toContain("停");
  });

  it("reports progress for status questions", () => {
    expect(mockDispatch("那个做完了吗", cfg)).toContain("盯着");
  });

  it("greets", () => {
    expect(mockDispatch("你好", cfg)).toBe("在。你说。");
  });

  it("echoes the task and names the brain model", () => {
    const reply = mockDispatch("打开计算器算 6 乘 7", cfg);
    expect(reply).toContain("打开计算器算 6 乘 7");
    expect(reply).toContain("test-model");
  });
});
