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

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class Recorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private context: AudioContext | null = null;
  private raf = 0;
  private analyser: AnalyserNode | null = null;

  get active(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(deviceId: string | undefined, onLevel: (level: number) => void): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("这个环境拿不到麦克风。");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    this.stream = stream;
    const mimeType = pickMime();
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.startedAt = performance.now();
    this.recorder.start(120);

    try {
      this.context = new AudioContext();
      const source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
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
    } catch {
      // 没有 AudioContext 也能录，只是没有波形
    }
  }

  async stop(): Promise<Recording> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      this.cleanup();
      throw new Error("还没开始录音。");
    }
    const durationMs = performance.now() - this.startedAt;
    const mime = recorder.mimeType || "audio/webm";
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: mime }));
      recorder.stop();
    });
    this.cleanup();
    const buffer = await blob.arrayBuffer();
    return { base64: toBase64(buffer), mime, durationMs: Math.round(durationMs) };
  }

  cancel(): void {
    try {
      this.recorder?.stop();
    } catch {
      // 已经停了
    }
    this.cleanup();
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.analyser = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }
}
