import { useEffect, useRef } from "react";
import { useBootstrap, useRoute } from "../lib/hooks.ts";
import { bridge } from "../lib/bridge.ts";
import { playClip, stopPlayback } from "../lib/audio.ts";
import { SpeechPlayer } from "../lib/speech-player.ts";
import { PcmPlayer } from "../lib/pcm-player.ts";
import { ToastProvider, Spinner } from "../components/ui.tsx";
import { TimelinePage } from "../pages/TimelinePage.tsx";
import { HistoryPage } from "../pages/HistoryPage.tsx";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { OnboardingPage } from "../pages/OnboardingPage.tsx";

export default function App(): React.JSX.Element {
  const { data, reload, patchConfig } = useBootstrap();
  const { route, navigate } = useRoute();

  // 播报队列：同一句分几段就按顺序播，新的一句抢占旧的一句
  const player = useRef(
    new SpeechPlayer(
      (chunk, onDone) => void playClip(chunk.audioBase64, chunk.mime, onDone),
      () => stopPlayback(60),
      () => bridge.speechDone(),
    ),
  );
  // 流式合成（边合成边播）：PCM 帧直接排在 WebAudio 时间轴上
  const pcm = useRef<PcmPlayer | null>(null);

  useEffect(() => {
    return bridge.subscribe((event) => {
      if (event.kind === "speech-stop") {
        player.current.clear();
        pcm.current?.stop();
        stopPlayback(60);
        return;
      }
      if (event.kind === "speech-pcm" && event.pcm && event.utteranceId) {
        if (!pcm.current) {
          pcm.current = new PcmPlayer({ sampleRate: event.sampleRate ?? 24_000, onIdle: () => bridge.speechDone() });
        }
        pcm.current.begin(event.utteranceId);
        player.current.clear();
        pcm.current.push(event.pcm);
        return;
      }
      if (event.kind === "speech" && event.speech?.audioBase64) {
        player.current.push({ ...event.speech, audioBase64: event.speech.audioBase64 });
      }
    });
  }, []);

  const section = route.split("/")[1] || "timeline";

  if (!data) {
    return (
      <div className="grid h-full place-items-center bg-background">
        <div className="flex items-center gap-3 text-[13px] text-faint">
          <Spinner /> 正在打开 Kivora…
        </div>
      </div>
    );
  }

  const content = (() => {
    if (!data.config.onboardingDone || route.startsWith("/onboarding")) {
      return (
        <OnboardingPage
          bootstrap={data}
          onFinish={async () => {
            await bridge.completeSetup();
            await reload();
            navigate("/");
          }}
          onSkip={async () => {
            await bridge.completeSetup();
            await reload();
            navigate("/");
          }}
        />
      );
    }
    if (route.startsWith("/settings")) {
      return <SettingsPage bootstrap={data} route={route} navigate={navigate} onConfig={patchConfig} />;
    }
    if (route.startsWith("/history")) {
      return <HistoryPage route={route} navigate={navigate} />;
    }
    return <TimelinePage bootstrap={data} navigate={navigate} />;
  })();

  return (
    <ToastProvider>
      <div key={section} className="motion-fade h-full">
        {content}
      </div>
    </ToastProvider>
  );
}
