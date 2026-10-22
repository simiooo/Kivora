import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
});

await build({
  ...shared,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
});
