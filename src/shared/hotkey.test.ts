import { describe, expect, it } from "vitest";
import { acceleratorFromKey, describeModifiers } from "./hotkey.ts";

const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe("热键捕获", () => {
  it("Ctrl+Alt+K", () => {
    expect(acceleratorFromKey({ ...base, ctrlKey: true, altKey: true, code: "KeyK" })).toBe("Control+Alt+K");
  });

  it("只有字母不算", () => {
    expect(acceleratorFromKey({ ...base, code: "KeyK" })).toBeNull();
  });

  it("只有 Shift + 字母不算（等于大写）", () => {
    expect(acceleratorFromKey({ ...base, shiftKey: true, code: "KeyK" })).toBeNull();
  });

  it("单独的 F 键可以", () => {
    expect(acceleratorFromKey({ ...base, code: "F9" })).toBe("F9");
  });

  it("修饰键 + 空格", () => {
    expect(acceleratorFromKey({ ...base, ctrlKey: true, code: "Space" })).toBe("Control+Space");
  });

  it("方向键映射成 Electron 的名字", () => {
    expect(acceleratorFromKey({ ...base, ctrlKey: true, code: "ArrowUp" })).toBe("Control+Up");
  });

  it("数字与符号", () => {
    expect(acceleratorFromKey({ ...base, altKey: true, code: "Digit1" })).toBe("Alt+1");
    expect(acceleratorFromKey({ ...base, altKey: true, code: "Semicolon" })).toBe("Alt+;");
  });

  it("Mac 的 Command", () => {
    expect(acceleratorFromKey({ ...base, metaKey: true, code: "KeyJ" })).toBe("Command+J");
  });

  it("未知键返回 null", () => {
    expect(acceleratorFromKey({ ...base, ctrlKey: true, code: "Unidentified" })).toBeNull();
  });

  it("提示文字", () => {
    expect(describeModifiers({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe("Ctrl + Alt");
  });
});
