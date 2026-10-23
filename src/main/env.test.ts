import { afterEach, describe, expect, it } from "vitest";
import { mockMode, setMockModeForSelfCheck } from "./env.ts";

const original = process.env.KIVORA_MOCK;

afterEach(() => {
  setMockModeForSelfCheck(null);
  if (original === undefined) delete process.env.KIVORA_MOCK;
  else process.env.KIVORA_MOCK = original;
});

describe("演练模式只看环境变量", () => {
  it("没设就是关", () => {
    delete process.env.KIVORA_MOCK;
    expect(mockMode()).toBe(false);
  });

  it("KIVORA_MOCK=1 / true / yes 都算开", () => {
    for (const value of ["1", "true", "TRUE", " yes "]) {
      process.env.KIVORA_MOCK = value;
      expect(mockMode()).toBe(true);
    }
  });

  it("别的值都不算开", () => {
    for (const value of ["0", "false", "", "off"]) {
      process.env.KIVORA_MOCK = value;
      expect(mockMode()).toBe(false);
    }
  });

  it("自检覆盖优先于环境变量，并且能恢复", () => {
    delete process.env.KIVORA_MOCK;
    setMockModeForSelfCheck(true);
    expect(mockMode()).toBe(true);
    setMockModeForSelfCheck(false);
    expect(mockMode()).toBe(false);
    setMockModeForSelfCheck(null);
    process.env.KIVORA_MOCK = "1";
    expect(mockMode()).toBe(true);
  });
});
