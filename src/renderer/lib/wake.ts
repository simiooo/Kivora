import { Endpointer, boostLevel } from "./vad.ts";

/**
 * 免按键：麦克风常开，只做"有没有人在说话"的判断，不录音、不发送。
 *
 * 为什么用同一套能量 VAD 而不是唤醒词模型：唤醒词要模型和训练数据，
 * 这里的目标只是"你开口，我就开始听"，误触发由后面的确认逻辑兜底
 * （说错可以立刻说「停」，或者干脆按 Esc）。真正省事的是不需要按任何键。
 *
 * 三个约束：
 * - 自己播报时不听（否则扬声器会把 TTS 当成人声触发自己）；
 * - 播完后再静默 600ms 才恢复，避免尾音触发；
 * - 触发后立刻关掉这条流，交给真正的录音，别让两路麦克风打架。
 */
export interface WakeGateOptions {
  deviceId?: string;
  /** 阈值比正式录音更严一点，减少环境音误触 */
  startLevel?: number;
  /** 持续说话多久才算"真的在说" */
  confirmMs?: number;
  /** 自己播报结束后多久恢复监听 */
  resumeDelayMs?: number;
  onWake: () => void;
  onError?: (message: string) => void;
  isSpeaking?: () => boolean;
}

export class WakeGate {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
  private running = false;
  private options: Required<Omit<WakeGateOptions, "onError" | "isSpeaking" | "deviceId">> &
    Pick<WakeGateOptions, "onError" | "isSpeaking" | "deviceId">;
  private lastSpeechAt = 0;

  constructor(options: WakeGateOptions) {
    this.options = {
      startLevel: 0.085,
      confirmMs: 320,
      resumeDelayMs: 600,
      ...options,
    };
  }

  get active(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("这个环境拿不到麦克风。");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const context = new AudioContext({ sampleRate: 16_000 });
    await context.resume().catch(() => undefined);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    this.stream = stream;
    this.context = context;
    this.source = source;
    this.analyser = analyser;
    this.running = true;
    this.lastSpeechAt = 0;

    const vad = new Endpointer({
      startLevel: this.options.startLevel,
      silenceMs: 400,
      minSpeechMs: this.options.confirmMs,
      noSpeechMs: 60 * 60 * 1_000, // 常开，不需要"没声音就放弃"
      maxUtteranceMs: 60 * 60 * 1_000,
    });
    const data = new Uint8Array(analyser.fftSize);

    const tick = (): void => {
      if (!this.running || !this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      const level = boostLevel(Math.sqrt(sum / data.length));
      const now = performance.now();
      if (this.options.isSpeaking?.()) {
        // 自己在说话：既不检测，也不累计
        this.lastSpeechAt = now;
        this.raf = requestAnimationFrame(tick);
        return;
      }
      if (now - this.lastSpeechAt < this.options.resumeDelayMs) {
        this.raf = requestAnimationFrame(tick);
        return;
      }
      const event = vad.push(level, now);
      if (event?.type === "speech-start") {
        this.lastSpeechAt = now;
        this.stop();
        this.options.onWake();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.analyser?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => undefined);
    this.analyser = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}
