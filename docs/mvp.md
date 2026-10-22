# squent · MVP v0.4（开源验证版）

> **本文件已被 [squent-plan.md](./squent-plan.md)（v1.0 方案）收敛，保留作范围与选型背景。**

> 日期：2026-10-22 · 关联：SIM-648 / SIM-651 · 上游规划：[voice-agent-plan.md](./voice-agent-plan.md)
> 仓库：`squent`（新开，MIT）· 目标：验证"语音派活 + 子会话用 CUA 干活"的需求，并以开源形式获取反馈。
> v0.4 变更：仓库定名 squent；桌面 CUA 改用 **cua-driver**（npm 原生包，无 Python）；ASR / TTS / 调度 LLM / 任务模型全部**用户自配**；Playwright 只负责浏览器 DOM 场景。

---

## 0. 一句话与验收标准

**按住热键说一句话 → 它开一个独立会话，用 CUA 把事做完 → 一句话告诉你结果。**

验收只看三件事：
1. 三个场景连续跑通 10 次不崩（浏览器搜索、桌面应用操作、文件整理）。
2. 端到端 p50 ≤ 2.5s 听到第一句反馈，≤ 60s 拿到结果。
3. 外人在自己机器上按 README 能在 15 分钟内跑起来。

---

## 1. 范围

### 1.1 做

| 模块 | MVP 版本 | 说明 |
|---|---|---|
| 唤醒 | 全局热键（`Ctrl+Alt+Space`），按住说 | 不做唤醒词、不做常驻 |
| ASR | 云端批量（单句 ≤30s），**用户自配端点** | 不做流式 |
| 语音大脑 | **一次 LLM 调用**，输出 JSON 指令，**用户自配模型** | 不是 Pi 会话，不装工具 |
| 任务执行 | 每个任务一个 `pi --mode rpc` 子进程 | 复用完整内核 |
| 电脑操控 | **cua-driver**（MCP stdio，Rust 内核） | 不自研 CUA |
| 浏览器 | Playwright MCP（DOM）；登录态场景用 cua-driver 接管真实浏览器 | 不自研 |
| 文件/命令 | Pi 内置 `read/write/edit/bash/powershell` | 限定工作目录 |
| 即时反馈 | 3–5 条预生成 ack + 状态胶囊 + 任务卡 | 不做取景框、虚拟光标 |
| TTS | 云端整句合成，**用户自配端点** | 不做流式切分 |
| 权限 | cua-driver `bounded` 模式 + 工具白名单 + 危险动作确认 | 不做分级引擎 |
| 打包 | 便携 zip + 开发模式 | 不做安装器、不做自动更新 |

### 1.2 不做（明确砍掉）

- IM（微信/飞书/钉钉/Slack）——适配成本高、发送不可撤销
- Office COM、IDE 专用适配——先用通用 CUA 顶着
- 唤醒词、常驻模式、L3 实时通话（整条链路砍掉）
- 取景框、虚拟光标、聆听光环、多显示器处理
- 多任务并发（同时只跑 1 个，其余排队）
- 语音确认的随机校验词、G3 分级、审计面板、回滚
- 会话树 UI、分支/回溯、导出
- 成本面板、配额、计费
- i18n、主题、自更新、崩溃上报、遥测
- 沙箱/低权限 worker

砍掉的原则：**凡是不能在一个 demo 视频里被看见的，都不做。**

---

## 2. 架构（MVP）

```
┌──────────────── Electron 窗口 ────────────────┐
│ 热键 · 录音（MediaRecorder）· transcript 列表  │
│ 任务卡（状态/结果）· 设置（端点/Key/热键/目录） │
└───────────────┬───────────────────────────────┘
                │ IPC
┌───────────────▼───────────────────────────────┐
│ Main (Node)                                    │
│  · Recorder → ASR client（用户端点）            │
│  · Dispatcher（1 次 LLM，JSON 输出：intent）    │
│  · SessionManager（spawn / prompt / 事件映射）  │
│  · TTS client（用户端点）+ ack 片段库           │
└───────────────┬───────────────────────────────┘
                │ JSONL RPC（stdin/stdout）
┌───────────────▼───────────────────────────────┐
│ pi --mode rpc（每任务一个进程）                 │
│  ├─ MCP: cua-driver    （cua-driver mcp）       │
│  ├─ MCP: playwright    （npx @playwright/mcp）  │
│  └─ 内置工具：read/write/edit/bash/powershell   │
└────────────────────────────────────────────────┘
```

关键约束（来自产品原则）：
- **语音层不碰任何 CUA 工具**，它只会 `create / list / get / abort`。
- 子会话拥有全部工具与上下文；语音层只有 ~1.5k tokens。
- 子会话崩溃不影响主进程，卡片标红可重试。

### 2.1 Dispatcher 的输出契约

```json
{
  "intent": "task | status | stop | chat",
  "prompt": "打开计算器算一下 6 乘 7",
  "session_id": "s_3f2a",
  "ack": "好，我算一下"
}
```

- 一次调用，`temperature 0`，JSON schema 强约束，超时 3s。
- `chat` 分支（寒暄/问句）直接回一句话，不建会话。
- 指令含"它/那个/继续"时，把最近 3 条卡片塞进 prompt 尾部做指代消解。

### 2.2 子会话配置

`<appData>/sessions/<id>/.pi/mcp.json`：

```json
{
  "mcpServers": {
    "cua":        { "command": "cua-driver", "args": ["mcp"] },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```

启动参数：

```
pi --mode rpc --no-session=false \
   --tools "read,write,edit,bash,powershell,mcp__cua__*,mcp__playwright__*"
```

环境变量（子进程）：

```
CUA_DRIVER_PERMISSION_MODE=bounded
CUA_DRIVER_CAPABILITY_MANIFEST_FILE=%APPDATA%\squent\cua-manifest.json
```

### 2.3 全部端点由用户配置（BYO）

一个 `config.json`，四段端点，默认 OpenAI 兼容，允许自定义 header 与路径：

```json
{
  "asr":  { "baseUrl": "https://api.openai.com/v1", "apiKey": "", "model": "whisper-1" },
  "tts":  { "baseUrl": "https://api.openai.com/v1", "apiKey": "", "model": "tts-1", "voice": "alloy" },
  "brain": { "baseUrl": "https://api.openai.com/v1", "apiKey": "", "model": "gpt-4.1-mini" },
  "task":  { "baseUrl": "https://api.openai.com/v1", "apiKey": "", "model": "claude-sonnet-4-6" }
}
```

- 密钥存 Windows Credential Manager，不写盘、不进日志。
- `task` 段最终写成 Pi 的 `models.json`，因此天然支持任意 provider（OpenAI / Azure / OpenRouter / 自建 vLLM / Ollama）。
- 不做"官方代付"，开源版零账号、零遥测。

---

## 3. 关键选型与理由

| 选项 | 选择 | 理由 |
|---|---|---|
| CUA 实现 | **cua-driver**（trycua/cua，30.6k★，MIT） | Rust 内核 + npm 原生包（win32-x64/arm64）；MCP 与 SDK 双形态；自带 `bounded` 权限模式与 manifest；有 agent cursor、后台投递（不抢焦点） |
| 浏览器 | Playwright MCP（38k★，Apache-2.0） | 无障碍树而非像素，确定性高、省 token |
| 登录态浏览器 | cua-driver 接管真实 Chromium profile | 解决"Playwright 用的是自己的浏览器、没有你的登录态" |
| 兜底 | desktop-touch-mcp（npx，TS + Rust 引擎） | 零安装，cua-driver 在 Windows 上翻车时顶上 |
| 壳 | Electron | 与 Pi 同栈，Node 直接跑 SDK/RPC |
| 录音 | 渲染进程 `MediaRecorder` | 零原生依赖 |
| 会话控制 | Pi RPC 子进程 | 进程隔离、可单杀；接口面已覆盖调度需求 |

**为什么用 cua-driver 而不是 Windows-MCP**：后者要 Python 3.14 + uv，直接违反"不接受 Python"；cua-driver 是 npm 可选依赖里的原生 `.node`，`npm i` 即得，且权限模型比我们自己写更完整。

**为什么不用 Cua Spaces / Lume**：那是给 agent 开虚拟机（macOS/Linux），我们要的是"在用户自己的 Windows 桌面上干活"，只用 Driver 这一层。

**必须警惕的三件事**：
1. **Windows 不是它的主战场**。文档里 macOS 的笔墨明显更多，Windows 有独立 `WINDOWS.md` 和 CI（`run-rust-e2e.ps1 -RequireGui`），但成熟度要实测。→ D5 先做半天 spike，跑不通立刻换 desktop-touch-mcp。
2. **版本 0.37，API 会变**。它们已经删过一次 TS 的 MCP facade。→ 钉版本，所有调用收在一层 `DesktopDriver` 适配器后面。
3. **别装 perception 扩展**。默认 Driver 是 MIT，但可选的 `cua-perception` 里 OmniParser 是 AGPL-3.0，开源分发会踩许可证。

---

## 4. 权限（MVP 版）

四层收敛，从外到内：

1. **cua-driver `bounded`**：只允许 manifest 里列出的工具与资源，进程启动时固定，改不了。
2. **工具开关**：不装 perception；`--tools` 只放必要项；Pi 工作目录限定在用户选的目录。
3. **危险动作确认**：命中"删除/覆盖/发送/提交/支付"时暂停，语音问"要执行删除，确认吗"，回"确认"继续。
4. **可见性**：cua-driver 的操作是后台投递，但我们要在状态胶囊里显示"正在操作：记事本"。

MVP 明确不做：随机校验词、G3 仅点击、审计、回滚。README 写清"alpha，别在有重要文件的机器上跑"。

---

## 5. 10 天构建计划

| 天 | 交付 | 验收 |
|---|---|---|
| D1 | Electron 壳 + 全局热键 + 录音 + 波形 | 按键能录到音频 |
| D2 | ASR 客户端（BYO 端点）+ transcript + 错误态 | 说一句出字，p50 < 800ms |
| D3 | Dispatcher（JSON 契约）+ 会话管理器（spawn/事件） | 说"打开记事本"能建会话 |
| D4 | Pi RPC 事件映射到 UI + TTS 播放 | 能听到结果播报 |
| D5 | **cua-driver spike（半天）** + 接入：读桌面状态、点击、输入、启动应用 | 计算器 6×7=42 端到端 |
| D6 | Playwright MCP 接入 + 登录态托管（cua 接管 profile） | 浏览器搜索场景端到端 |
| D7 | ack 片段 + 状态胶囊 + 任务卡 + 失败重试 | 首响 < 1s |
| D8 | 设置页（四段端点/热键/目录）+ 首次运行依赖检查 | 新机器 15 分钟跑起来 |
| D9 | 第三个场景（文件整理）+ 稳定性压测 10 连跑 | 10/10 通过 |
| D10 | README + demo GIF + 打包 zip + 发布 | 仓库公开 |

依赖检查覆盖：Node ≥ 22、`cua-driver` 是否在 PATH（没有则引导执行官方 `install.ps1`）、`npx` 可用、四段端点连通性。

---

## 6. 开源发布清单

- 仓库 `squent`，MIT；无遥测；BYO 端点与 Key（存 Credential Manager）。
- README：30 秒 demo GIF、"能做什么/不能做什么"、15 分钟上手、架构一页图、Roadmap。
- `SECURITY.md`：alpha、无沙箱、`bounded` 白名单、危险动作需确认、perception 扩展未启用。
- `CONTRIBUTING.md` + `good first issue`：每个应用适配器都是独立 issue，用来收集需求。
- 发布渠道：GitHub + HN / Reddit r/LocalLLaMA / 即刻 / V2EX；中文优先。
- 版本策略：v0.1.0 起步，两周一个小版本。

---

## 7. 怎么判断"需求成立"

| 指标 | 4 周目标 | 含义 |
|---|---|---|
| Star | ≥ 500 | 有注意力 |
| 外部用户完成首个任务 | ≥ 30 | 装得上、跑得通 |
| 7 日留存（再次打开） | ≥ 20% | 不是只玩一次 |
| 应用适配请求（issue） | ≥ 20 条，且集中在 3 个应用 | 下一版做什么有答案 |
| "它做错了/删了东西" 类 issue | ≤ 3 | 权限设计没崩 |

如果 4 周后 Star 高但留存低 → 是 demo 好玩、不是需求；如果留存高但请求集中在 IM → 该补 IM；如果没人提 CUA、都在问"能不能接我自己的模型" → 价值在调度层不在操控层。

---

## 8. 已知坑

| 坑 | 影响 | 处理 |
|---|---|---|
| cua-driver 在 Windows 上的成熟度未知 | 核心功能不可用 | D5 半天 spike；不过就换 desktop-touch-mcp |
| cua-driver 0.37 API 变动 | 升级炸 | 钉版本 + `DesktopDriver` 适配器隔离 |
| perception 扩展是 AGPL | 开源分发风险 | 不安装、不打包、README 注明 |
| `npx` / `cua-driver` 首次冷启动 30–60s | 首任务超时 | 启动时预热，卡片显示"正在准备工具" |
| Playwright 独立 Chromium 没有你的登录态 | 场景受限 | 持久化 profile；登录态场景改由 cua-driver 接管 |
| CUA 单步 0.2–0.5s，10 步任务 5s+ | 体感慢 | ack + 进度卡片；只在开始/结束说话 |
| 模型点错位置 | 误操作 | `bounded` 白名单 + 危险动作确认 + 不默认开 PowerShell |

---

## 9. 和 v0.2 规划的关系

v0.2 是终局形态（常驻、四级语音、权限分级、取景框）。MVP 是它的一条**最窄可行路径**：
- 保留：语音调度 + 子会话 + 即时反馈 + CUA。
- 推迟：常驻/唤醒词、实时通话、分级权限、桌面视觉层、多任务并发、IM/Office 适配。

M0 之后按 §7 的数据决定加哪一块，而不是按规划顺序。
