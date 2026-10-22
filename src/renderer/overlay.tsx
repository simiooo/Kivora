import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayApp } from "./overlay/OverlayApp.tsx";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>,
);
