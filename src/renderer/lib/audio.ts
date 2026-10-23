import { concatFloat32, encodeWav } from "@shared/wav.ts";
/** 播放与录音：全部走 Web API，主进程只管把字节算出来 */

let audioEl: HTMLAudioElement | null = null;
let objectUrl: string | null = null;

export function stopPlayback(fadeMs = 120): void {
  if (!audioEl) return;
  const el = audioEl;
  audioEl = null;
  const start = Number(el.volume);
  const steps = Math.max(1, Math.round(fadeMs / 20));
  let step = 0;
  const timer = window.setInterval(() => {
    step += 1;
    el.volume = Math.max(0, start * (1 - step / steps));
    if (step >= steps) {
      window.clearInterval(timer);
      el.pause();
      el.src = "";
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    }
  }, 20);
}

export async function playClip(base64: string, mime: string): Promise<void> {
  stopPlayback(60);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  const el = new Audio(objectUrl);
  el.volume = 1;
  audioEl = el;
  try {
    await el.play();
  } catch {
    // 自动播放被拦时静默失败：语音不是关键路径
  }
}

export interface MicDevice {
  id: string;
  label: string;
}

export async function listMics(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `麦克风 ${index + 1}`,
      }));
  } catch {
    return [];
  }
}

export interface Recording {
  base64: string;
  mime: string;
  durationMs: number;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 录音：直接采 PCM 再封 WAV。
 * 为什么不用 MediaRecorder：DashScope 的识别要 16k 单声道 WAV，
 * 浏览器只能录 webm/opus，转码又得带 ffmpeg。AudioContext 指定 16k 采样，
 * 采完自己写 WAV 头最省事，也顺带给 Whisper 这类端点用。
 */
export class Recorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private raf = 0;

  get active(): boolean {
    return this.processor !== null;
  }

  async start(deviceId: string | undefined, onLevel: (level: number) => void): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("这个环境拿不到麦克风。");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.stream = stream;

    const context = new AudioContext({ sampleRate: 16_000 });
    this.context = context;
    await context.resume().catch(() => undefined);

    const source = context.createMediaStreamSource(stream);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    const processor = context.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    this.chunks = [];
    processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(channel));
    };

    // 需要一个输出节点才会持续回调；接一个静音增益，避免把麦克风回放到扬声器
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);

    this.startedAt = performance.now();

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = (): void => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const centered = (value - 128) / 128;
        sum += centered * centered;
      }
      onLevel(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async stop(): Promise<Recording> {
    if (!this.processor || !this.context) {
      this.cleanup();
      throw new Error("还没开始录音。");
    }
    const durationMs = performance.now() - this.startedAt;
    const sampleRate = this.context.sampleRate;
    const samples = concatFloat32(this.chunks);
    this.cleanup();
    const wav = encodeWav(samples, sampleRate);
    return { base64: toBase64(wav), mime: "audio/wav", durationMs: Math.round(durationMs) };
  }

  cancel(): void {
    this.cleanup();
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.processor?.disconnect();
    this.analyser?.disconnect();
    this.processor = null;
    this.analyser = null;
    this.chunks = [];
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}