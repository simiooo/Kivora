/**
 * PCM 播放器：服务端一帧一帧回来的 16bit PCM，在这里排成连续的一段播。
 *
 * 关键点是"排队"而不是"每次新建":
 *   - 每帧算出 duration，用 AudioBufferSourceNode 在上一个的结束时间开始
 *   - 新的一句进来就全停、游标归零
 *   - 中断（点「停」/ 说话打断）也走同一个 stop
 *
 * 这样听起来是一整句，而不是一帧一帧的碎片。
 */


/** base64 → Int16Array（服务端给的是 little-endian） */
export function decodePcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const count = Math.floor(bytes.length / 2);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index++) {
    const low = bytes[index * 2] as number;
    const high = bytes[index * 2 + 1] as number;
    samples[index] = (high << 8) | low;
  }
  return samples;
}

/** Int16 → Float32（-1..1） */
export function pcm16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index] as number;
    out[index] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return out;
}

export interface PcmPlayerOptions {
  sampleRate: number;
  onIdle?: () => void;
  createContext?: () => AudioContext;
}

export class PcmPlayer {
  private context: AudioContext | null = null;
  private cursor = 0;
  private sources: AudioBufferSourceNode[] = [];
  private utterance: string | null = null;
  private readonly sampleRate: number;
  private readonly createContext: () => AudioContext;

  constructor(private readonly options: PcmPlayerOptions) {
    this.sampleRate = options.sampleRate;
    this.createContext = options.createContext ?? (() => new AudioContext({ sampleRate: options.sampleRate }));
  }

  get currentUtterance(): string | null {
    return this.utterance;
  }

  /** 新的一句：停掉旧的，游标归零 */
  begin(utteranceId: string): void {
    if (this.utterance === utteranceId) return;
    this.stopAll();
    this.utterance = utteranceId;
    this.cursor = 0;
  }

  push(base64: string): void {
    const samples = decodePcm16(base64);
    if (samples.length === 0) return;
    const context = this.ensureContext();
    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    const channel = pcm16ToFloat(samples);
    buffer.copyToChannel(new Float32Array(channel), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.01, this.cursor);
    source.start(startAt);
    this.cursor = startAt + buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      this.sources = this.sources.filter((item) => item !== source);
      if (this.sources.length === 0) {
        this.cursor = 0;
        this.utterance = null;
        this.options.onIdle?.();
      }
    };
  }

  stop(): void {
    this.stopAll();
    this.utterance = null;
    this.cursor = 0;
  }

  private stopAll(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // 已经停了
      }
    }
    this.sources = [];
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = this.createContext();
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
    return this.context;
  }
}

