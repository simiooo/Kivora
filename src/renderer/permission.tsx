import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PermissionApp } from "./permission/PermissionApp.tsx";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <PermissionApp />
  </StrictMode>,
);
