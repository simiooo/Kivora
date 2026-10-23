/**
 * 说完自动结束（endpointing）——不依赖任何模型，只看音量包络。
 *
 * 为什么先做能量检测而不是上 VAD 模型（Silero 之类）：
 * - 能量检测零依赖、零下载、每个子帧只要一次 RMS，16k 单声道足够；
 * - 语音助手的场景是"人对着麦克风说话"，环境音稳定，自适应底噪就能覆盖；
 * - 模型方案要额外 1–2 MB wasm + 推理，收益主要在嘈杂环境（电视/多人），
 *   真要上可以以后只换这一个文件，接口不变。
 *
 * 状态机：
 *   静音 ──连续 N 帧超过"进入阈值"──▶ 说话中 ──连续 silenceMs 低于"退出阈值"──▶ 结束
 *                     │                                  │
 *                     └── 一直没声音 → no-speech          └── 超过 maxUtteranceMs → 强制结束
 *
 * 两个阈值（滞回）是关键：进入要高，退出要低，否则词与词之间的换气会把一句话切碎；
 * 底噪用慢速滑动平均跟踪，安静房间和空调房都能用同一套默认值。
 */

export interface EndpointOptions {
  /** 静音多久算说完 */
  silenceMs: number;
  /** 这么短的"声音"当作咳嗽/碰麦，不算一句话 */
  minSpeechMs: number;
  /** 一句话最多录多久，防止一直开着麦 */
  maxUtteranceMs: number;
  /** 从开始录到彻底没声音的上限：超了就当没说话，不调识别 */
  noSpeechMs: number;
  /** 进入说话的阈值（会跟底噪取大值） */
  startLevel: number;
  /** 退出说话的阈值（滞回） */
  endLevel: number;
  /** 底噪的下限，避免绝对安静时阈值降到 0 */
  noiseFloorMin: number;
  /** 底噪跟踪速度，越小越稳 */
  noiseAdaptRate: number;
  /** 连续几帧超阈值才算开始（约 2 × 32ms） */
  framesToStart: number;
}

export const DEFAULT_ENDPOINT: EndpointOptions = {
  silenceMs: 800,
  minSpeechMs: 200,
  maxUtteranceMs: 30_000,
  noSpeechMs: 6_000,
  startLevel: 0.075,
  endLevel: 0.04,
  noiseFloorMin: 0.006,
  noiseAdaptRate: 0.06,
  framesToStart: 2,
};

export type EndpointEvent =
  | { type: "speech-start"; at: number }
  | { type: "speech-end"; reason: "silence" | "max-length"; at: number; speechMs: number }
  | { type: "no-speech"; at: number };

export interface EndpointOptionsInput extends Partial<EndpointOptions> {}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class Endpointer {
  readonly options: EndpointOptions;
  private state: "idle" | "speech" = "idle";
  private noiseFloor: number;
  private beganAt = 0;
  private startedAt = 0;
  private lastLoudAt = 0;
  private loudFrames = 0;
  private previous: number | null = null;

  constructor(input: EndpointOptionsInput = {}) {
    this.options = {
      ...DEFAULT_ENDPOINT,
      ...input,
      silenceMs: clamp(input.silenceMs ?? DEFAULT_ENDPOINT.silenceMs, 200, 5_000),
    };
    this.noiseFloor = this.options.noiseFloorMin;
  }

  /** 当前底噪估计，调试/测试用 */
  get noise(): number {
    return this.noiseFloor;
  }

  /** 现在是否处在"听到人说话"的状态 */
  get speaking(): boolean {
    return this.state === "speech";
  }

  /** 喂一帧电平（0–1）和它的时间戳（毫秒，同一个时基） */
  push(level: number, now: number): EndpointEvent | null {
    const value = Number.isFinite(level) ? clamp(level, 0, 1) : 0;
    if (this.beganAt === 0) this.beganAt = now;

    // 底噪只跟着"安静帧"走，否则说话声会把阈值抬上去
    const quiet = value < this.noiseFloor * 1.8;
    if (quiet) {
      this.noiseFloor = clamp(
        this.noiseFloor + (value - this.noiseFloor) * this.options.noiseAdaptRate,
        this.options.noiseFloorMin,
        0.2,
      );
    }
    const startThreshold = Math.max(this.options.startLevel, this.noiseFloor * 2.5);
    const endThreshold = Math.max(this.options.endLevel, this.noiseFloor * 1.6);

    if (this.state === "idle") {
      if (value >= startThreshold) this.loudFrames += 1;
      else this.loudFrames = 0;

      if (this.loudFrames >= this.options.framesToStart) {
        this.state = "speech";
        // 把这几帧也算进这句话，别把开头的字吃掉
        const step = this.previous === null ? 0 : now - this.previous;
        this.startedAt = Math.max(this.beganAt, now - step * (this.loudFrames - 1));
        this.lastLoudAt = now;
        this.previous = now;
        return { type: "speech-start", at: this.startedAt };
      }

      this.previous = now;
      if (now - this.beganAt >= this.options.noSpeechMs) {
        this.state = "idle";
        this.beganAt = now;
        return { type: "no-speech", at: now };
      }
      return null;
    }

    // speech
    if (value >= endThreshold) this.lastLoudAt = now;
    this.previous = now;

    if (now - this.startedAt >= this.options.maxUtteranceMs) {
      this.state = "idle";
      const speechMs = now - this.startedAt;
      this.reset(now);
      return { type: "speech-end", reason: "max-length", at: now, speechMs };
    }

    if (now - this.lastLoudAt >= this.options.silenceMs) {
      // 说话时长要用"最后一次有声"算，别把尾巴上的静音也算进去
      const speechMs = this.lastLoudAt - this.startedAt;
      this.state = "idle";
      this.reset(now);
      // 太短：当作咳嗽/碰麦，重新等下一句，不结束
      if (speechMs < this.options.minSpeechMs) return null;
      return { type: "speech-end", reason: "silence", at: now, speechMs };
    }

    return null;
  }

  private reset(now: number): void {
    this.beganAt = now;
    this.startedAt = 0;
    this.lastLoudAt = 0;
    this.loudFrames = 0;
    this.previous = now;
  }
}

/** 一段 PCM 的 RMS，和录音里 onLevel 用的是同一个量纲 */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] as number;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)));
}

/** 语音电平通常比 RMS 小得多，探针/显示用的放大倍数 */
export function boostLevel(value: number, factor = 3.2): number {
  return Math.min(1, value * factor);
}
