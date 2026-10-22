# Security

Kivora is **alpha**. It runs on your own Windows machine with your user's permissions.

## What it does by default

- No telemetry, no account, no bundled API keys.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`; it has no filesystem, database or secret access.
- All persistence goes through the main process into `%APPDATA%\kivora\data\kivora.db` (SQLite, WAL).
- Model endpoints (ASR / TTS / brain / task) are yours; Kivora does not proxy or bill them.

## Boundaries you should know about

- There is **no sandbox** yet. Task sessions are planned to run as `pi --mode rpc` child processes with a restricted tool allowlist and `cua-driver`'s `bounded` permission mode plus a capability manifest.
- Voice confirmations for risky actions are a UX safety net, not a security boundary. The hard boundary is the tool allowlist and the driver manifest.
- Do not run Kivora on a machine with files you cannot afford to lose until the permission work (D7) lands.

## Reporting

Open a private security advisory on GitHub, or email the maintainer listed on the repository profile. Please do not file public issues for vulnerabilities.
