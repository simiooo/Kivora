import { describe, expect, it } from "vitest";
import { decodePcm16, pcm16ToFloat } from "./pcm-player.ts";

/** 把 Int16 小端样本编成 base64 */
function encode(samples: number[]): string {
  const bytes = new Uint8Array(samples.length * 2);
  samples.forEach((value, index) => {
    const clamped = Math.max(-32768, Math.min(32767, value));
    bytes[index * 2] = clamped & 0xff;
    bytes[index * 2 + 1] = (clamped >> 8) & 0xff;
  });
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("PCM 播放数据", () => {
  it("小端解码正确", () => {
    expect([...decodePcm16(encode([0, 1, -1, 256, -256]))]).toEqual([0, 1, -1, 256, -256]);
  });

  it("转成 -1..1 的浮点", () => {
    const floats = pcm16ToFloat(new Int16Array([32767, -32768, 0]));
    expect(floats[0]).toBeCloseTo(1, 4);
    expect(floats[1]).toBeCloseTo(-1, 4);
    expect(floats[2]).toBe(0);
  });

  it("长度是字节数的一半", () => {
    expect(decodePcm16(encode([1, 2, 3, 4])).length).toBe(4);
  });
});
