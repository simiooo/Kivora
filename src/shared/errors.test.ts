import { describe, expect, it } from "vitest";
import { errorFromStatus, serializeError } from "./errors.ts";

describe("上游错误翻译", () => {
  it("400 会把上游那句话带进 message", () => {
    const err = errorFromStatus(400, '{"error":{"message":"Model Not Exist"}}');
    expect(err.message).toBe("端点返回 400：Model Not Exist");
    expect(err.detail).toContain("Model Not Exist");
  });

  it("不是 JSON 时退回纯文本", () => {
    const err = errorFromStatus(400, "  bad request\n  details  ");
    expect(err.message).toBe("端点返回 400：bad request details");
  });

  it("401 仍然是鉴权错误，不掺上游原文", () => {
    const err = errorFromStatus(401, '{"error":{"message":"Invalid key"}}');
    expect(serializeError(err).code).toBe("auth_failed");
    expect(err.message).toContain("API Key");
  });
});
