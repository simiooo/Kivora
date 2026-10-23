import { describe, expect, it } from "vitest";
import { defaultVoiceFor, isKnownVoice, voiceHintFor, voicesForModel } from "./voice-catalog.ts";

describe("音色清单", () => {
  it("qwen-audio-3.1-tts-flash 有默认音色和候选列表", () => {
    expect(defaultVoiceFor("qwen-audio-3.1-tts-flash")).toBe("longanhuan_v3.1");
    expect(voicesForModel("qwen-audio-3.1-tts-flash")?.length).toBeGreaterThan(10);
    expect(voiceHintFor("qwen-audio-3.1-tts-flash")).toContain("InvalidParameter");
  });

  it("同族的 plus 也用这套音色", () => {
    expect(defaultVoiceFor("qwen-audio-3.1-tts-plus")).toBe("longanhuan_v3.1");
  });

  it("别的模型的音色会被判为不认识（411 的根因）", () => {
    expect(isKnownVoice("qwen-audio-3.1-tts-flash", "Cherry")).toBe(false);
    expect(isKnownVoice("qwen-audio-3.1-tts-flash", "longanhuan_v3.1")).toBe(true);
  });

  it("不认识的模型不判断、也不给默认值", () => {
    expect(isKnownVoice("some-other-tts", "anything")).toBeNull();
    expect(defaultVoiceFor("some-other-tts")).toBeNull();
    expect(voiceHintFor("some-other-tts")).toBeNull();
    expect(voicesForModel("some-other-tts")).toBeNull();
  });
});
