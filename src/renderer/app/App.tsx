import { useEffect } from "react";
import { useBootstrap, useRoute } from "../lib/hooks.ts";
import { bridge } from "../lib/bridge.ts";
import { playClip } from "../lib/audio.ts";
import { ToastProvider, Spinner } from "../components/ui.tsx";
import { TimelinePage } from "../pages/TimelinePage.tsx";
import { HistoryPage } from "../pages/HistoryPage.tsx";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { OnboardingPage } from "../pages/OnboardingPage.tsx";

export default function App(): React.JSX.Element {
  const { data, reload, patchConfig } = useBootstrap();
  const { route, navigate } = useRoute();

  // 语音播报：主进程把音频推过来，这里统一播（新语音抢占旧语音）
  useEffect(() => {
    return bridge.subscribe((event) => {
      if (event.kind === "speech" && event.speech?.audioBase64) {
        void playClip(event.speech.audioBase64, event.speech.mime);
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
