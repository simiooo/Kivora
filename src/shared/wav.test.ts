import { describe, expect, it } from "vitest";
import { concatFloat32, encodeWav } from "./wav.ts";

describe("WAV 编码", () => {
  it("写对 RIFF 头与长度", () => {
    const samples = new Float32Array(160); // 10ms @16k
    const wav = encodeWav(samples, 16_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const text = (offset: number, length: number): string =>
      String.fromCharCode(...wav.slice(offset, offset + length));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(320);
    expect(wav.byteLength).toBe(44 + 320);
  });

  it("裁剪超范围样本", () => {
    const wav = encodeWav(new Float32Array([2, -2]), 16_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });

  it("拼接多段", () => {
    const merged = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
    expect([...merged]).toEqual([1, 2, 3]);
  });
});
