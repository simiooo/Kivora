import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const env = { ...process.env };
// Some environments export this globally; it turns Electron into plain Node
// and makes `require("electron")` return a path instead of the runtime API.
delete env.ELECTRON_RUN_AS_NODE;

const args = [".", ...process.argv.slice(2)];
const child = spawn(electronPath, args, { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
