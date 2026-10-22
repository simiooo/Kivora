import { spawn } from "node:child_process";
import http from "node:http";
import { context } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

const mainCtx = await context({
  ...shared,
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
});
const preloadCtx = await context({
  ...shared,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
});
await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

const children = [];
const run = (cmd, args, env = {}) => {
  const child = spawn(cmd, args, { stdio: "inherit", shell: true, env: { ...process.env, ...env } });
  children.push(child);
  return child;
};

const vite = run("pnpm", ["exec", "vite"]);
children.push(vite);

const waitForServer = (url, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });

await waitForServer("http://localhost:5173");
const electron = run("node", ["scripts/launch.mjs"], { VITE_DEV_SERVER_URL: "http://localhost:5173" });

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
electron.on("exit", shutdown);
