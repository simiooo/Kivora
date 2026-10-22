import type { KivoraBridge } from "@shared/ipc.ts";

declare global {
  interface Window {
    kivora: KivoraBridge;
  }
}

export {};
