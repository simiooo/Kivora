import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";

/**
 * 三个窗口三个入口：
 *   index.html      主窗（时间线 / 历史 / 设置 / 引导）
 *   overlay.html    桌面悬浮（透明）
 *   permission.html 权限浮窗（透明）
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        overlay: path.resolve(__dirname, "overlay.html"),
        permission: path.resolve(__dirname, "permission.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
