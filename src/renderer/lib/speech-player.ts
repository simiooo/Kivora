/**
 * 播报队列：同一句（utteranceId 相同）的几段按顺序播，新的一句抢占旧的。
 *
 * 拆句之后，主进程会连着推好几段音频；渲染层不能收到一段就打断上一段，
 * 否则句子会被切成碎片。这里用"同一句排队、新一句抢占"的规则：
 * 新的一句进来 → 立刻停掉旧的、清空队列、从第一段开始。
 *
 * 播放动作由外部注入（真实实现是 <audio>），这样排队逻辑可以单测。
 */

export interface SpeechChunk {
  id: string;
  audioBase64: string;
  mime: string;
  utteranceId?: string;
  chunkIndex?: number;
}

export type PlayFn = (chunk: SpeechChunk, onDone: () => void) => void;

export class SpeechPlayer {
  private queue: SpeechChunk[] = [];
  private playing: SpeechChunk | null = null;
  private utterance: string | null = null;
  private stalled = false;

  constructor(
    private readonly play: PlayFn,
    private readonly stop: () => void,
    private readonly onIdle?: () => void,
  ) {}

  get currentUtterance(): string | null {
    return this.utterance;
  }

  get pending(): number {
    return this.queue.length;
  }

  push(chunk: SpeechChunk): void {
    const utterance = chunk.utteranceId ?? chunk.id;
    if (utterance !== this.utterance) {
      // 新的一句：抢占（什么都没在播时不用白调一次 stop）
      if (this.playing || this.queue.length > 0) this.stop();
      this.queue = [];
      this.playing = null;
      this.utterance = utterance;
      this.queue.push(chunk);
      this.pump();
      return;
    }
    this.queue.push(chunk);
    this.pump();
  }

  clear(): void {
    this.stop();
    this.queue = [];
    this.playing = null;
    this.utterance = null;
  }

  private pump(): void {
    if (this.playing || this.stalled) return;
    const next = this.queue.shift();
    if (!next) {
      this.onIdle?.();
      return;
    }
    this.playing = next;
    this.play(next, () => {
      this.playing = null;
      this.pump();
    });
  }

  /** 播放器被浏览器拦住（自动播放策略）时，别把队列卡死 */
  markStalled(): void {
    this.stalled = true;
    this.queue = [];
    this.playing = null;
  }
}
