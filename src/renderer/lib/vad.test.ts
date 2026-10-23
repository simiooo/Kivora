import { describe, expect, it } from "vitest";
import { Endpointer, rms, type EndpointEvent, type EndpointOptionsInput } from "./vad.ts";

/** 按 32ms 一帧喂电平，返回所有事件（带时间） */
function feed(levels: number[], options: EndpointOptionsInput = {}): Array<EndpointEvent & { frame: number }> {
  const vad = new Endpointer(options);
  const events: Array<EndpointEvent & { frame: number }> = [];
  levels.forEach((level, index) => {
    const event = vad.push(level, index * 32);
    if (event) events.push({ ...event, frame: index });
  });
  return events;
}

function frames(level: number, count: number): number[] {
  return Array.from({ length: count }, () => level);
}

describe("说完自动结束", () => {
  it("说 0.5 秒再安静 0.8 秒 → 判定说完", () => {
    const levels = [...frames(0.01, 10), ...frames(0.3, 16), ...frames(0.01, 40)];
    const events = feed(levels);
    expect(events.map((event) => event.type)).toEqual(["speech-start", "speech-end"]);
    const end = events[1];
    expect(end.type === "speech-end" && end.reason).toBe("silence");
    expect(end.type === "speech-end" && end.speechMs).toBeGreaterThanOrEqual(200);
  });

  it("中间换气 0.2 秒不会把一句话切碎", () => {
    const levels = [
      ...frames(0.01, 5),
      ...frames(0.3, 12),
      ...frames(0.01, 6), // 换气 ~190ms
      ...frames(0.3, 12),
      ...frames(0.01, 40),
    ];
    const events = feed(levels, { silenceMs: 800 });
    expect(events.filter((event) => event.type === "speech-end")).toHaveLength(1);
  });

  it("咳嗽一下（不到 minSpeechMs）不算一句话", () => {
    const levels = [...frames(0.01, 5), ...frames(0.3, 4), ...frames(0.01, 40)];
    const events = feed(levels, { minSpeechMs: 300 });
    expect(events.some((event) => event.type === "speech-end")).toBe(false);
  });

  it("一直没声音 → no-speech，不去调识别", () => {
    const events = feed(frames(0.008, 250), { noSpeechMs: 6000 });
    expect(events[0]?.type).toBe("no-speech");
    expect(events.some((event) => event.type === "speech-end")).toBe(false);
  });

  it("话太长会被强制结束", () => {
    const events = feed(frames(0.3, 400), { maxUtteranceMs: 2000 });
    const end = events.find((event) => event.type === "speech-end");
    expect(end && "reason" in end ? end.reason : null).toBe("max-length");
  });

  it("安静房间里的小声音不会被当成说话", () => {
    // 底噪 0.02 的房间，0.03 的风扇声一直响
    const events = feed(frames(0.03, 200), { noSpeechMs: 6000 });
    expect(events.some((event) => event.type === "speech-start")).toBe(false);
  });

  it("底噪抬起来后，说话阈值也跟着抬", () => {
    const noise = frames(0.05, 100); // 底噪稳定在 0.05 左右
    const speech = frames(0.2, 20);
    const events = feed([...noise, ...speech, ...frames(0.04, 40)], { noiseFloorMin: 0.006 });
    expect(events.find((event) => event.type === "speech-start")?.frame).toBeGreaterThanOrEqual(100);
  });

  it("自适应底噪不会把语音本身吃进去", () => {
    const vad = new Endpointer();
    for (let i = 0; i < 200; i++) vad.push(0.3, i * 32); // 一直在说话
    expect(vad.noise).toBeLessThan(0.05);
  });
});

describe("rms", () => {
  it("全零是 0，满幅接近 1", () => {
    expect(rms(new Float32Array(64))).toBe(0);
    expect(rms(new Float32Array(64).fill(1))).toBeCloseTo(1, 5);
  });

  it("抵消的正弦波给出稳定的中间值", () => {
    const samples = new Float32Array(64).map((_, index) => Math.sin((index / 64) * Math.PI * 2));
    expect(rms(samples)).toBeGreaterThan(0.5);
    expect(rms(samples)).toBeLessThan(0.8);
  });
});
