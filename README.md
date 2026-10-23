# Kivora

<img src="docs/assets/icon/kivora-256.png" width="88" alt="Kivora" />

**Windows 上的常驻语音助手。按住热键说一句，它开一个独立会话把事做完，再用一句话告诉你结果。**

语音层只做调度：判断你的意思、把活派出去、把结果说回来。真正的操作在会话里跑，每一步都进事件流。

> 状态：**v0.1**。UI 全部按 [设计稿 v1](docs/design-v1.md) 落地；模型仓库、录音转写、审批总线、队列、历史都能用；
> 文件整理是真的会动文件（要你确认）；浏览器与桌面控制走 Pi 的 MCP 扩展；任务会话可以用内置执行器，也可以切到 `pi --mode rpc`。

![主时间线](docs/assets/design-01-timeline.png)

---

## 现在能做什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 按住热键说话 | ✅ | 录音 → ASR → 转写 → 进时间线；输错可以改文字重发 |
| 打字输入 | ✅ | 和语音同一条路，只是 `source` 不同 |
| 任务会话 | ✅ | 每件事一个会话，独立的事件流与状态投影 |
| 文件整理（真实） | ✅ | "把下载目录里上周的 pdf 挪到文档/发票"：扫描 → 审批 → 真搬。不覆盖、不删除 |
| 审批总线 | ✅ | 语音说「可以 / 以后都行 / 不行」，或点卡片、点浮窗；G1 30s / G2 60s 超时默认拒绝，G3 不开语音 |
| 排队 / 插话 / 提前 | ✅ | 队列上限 5，同一会话最多 2 条；说「先做这个」会插队 |
| 状态查询 | ✅ | "刚才那个做完了吗" → 说清第几轮、在干什么、多久 |
| 停止 / 重试 / 再试一次 | ✅ | "停"、"重试"；失败的会话可以保留上下文重试或重开 |
| 模型仓库 | ✅ | 增删改查、能力绑定、测试连接（真打端点）、自定义请求头、参数 |
| Key 存储 | ✅ | Windows 凭据管理器（DPAPI），只存遮码，不进配置和日志 |
| 语音合成 | ✅ | 端点直连；同一句缓存；播报抢占淡出 |
| 桌面悬浮 | ✅ | 透明浮窗：待处理 / 在跑 / 上次；点「说一句」回到主窗 |
| 托盘常驻 | ✅ | 关主窗收进托盘（可关），托盘菜单：打开 / 说一句 / 悬浮窗 / 退出；提示随任务状态变化 |
| 权限浮窗 | ✅ | 右下角、不抢焦点、倒计时、三个按钮语义固定 |
| 会话历史 | ✅ | 搜索、事件流、对话、导出 Markdown、删除 |
| 引导 | ✅ | 三步：连模型 / 麦克风与热键 / 完成 |
| 浏览器 / 桌面控制 | ✅ 走 Pi 的 MCP | 设置 → 扩展里一键加 cua-driver / Playwright MCP；pi 随应用发布，动作类工具会先问你 |
| Pi 会话执行 | ✅ 可选 | 设置里切「Pi 会话」后，任务走 `pi --mode rpc`；工具调用经 Kivora 权限扩展进审批总线；支持插话、排队、手动压缩 |

## 装上试

安装包在 `release/Kivora-0.1.0-x64.exe`（NSIS，约 110 MB；未签名，Windows 会提示"未知发布者"，
点「更多信息 → 仍要运行」即可）。装完从开始菜单或桌面打开，热键默认 `Ctrl+Alt+K`。

自己出安装包：

```bash
pnpm install
pnpm dist        # release/Kivora-<version>-x64.exe
pnpm dist:dir    # 只出免安装目录 release/win-unpacked/
```

安装包要求 Windows 10/11 x64；数据在 `%APPDATA%\kivora`，卸载不会删。

**不需要装全局 pi**：`@earendil-works/pi-coding-agent@1.4.0` 是项目依赖，随安装包发布，用应用自带的 Electron 当 Node 跑（asar 里也能读）。

> 本机排查小贴士：如果环境里设置了 `ELECTRON_RUN_AS_NODE=1`（有些 Node 工具链会设），
> 打包后的 exe 会以纯 Node 模式启动并报 `bad option`。`pnpm start` / `pnpm dev` 会自动清掉它。

## 跑起来

```bash
pnpm install

pnpm dev        # Vite + Electron，热重载
pnpm build      # dist/（三个窗口）+ dist-electron/（main、preload）
pnpm start      # 跑构建产物

pnpm typecheck  # tsc
pnpm test       # vitest：59 个用例（路由 / 文本规则 / 仓储 / 文件边界）
pnpm flow       # 不开窗，直接把调度器跑一遍（33 条断言：真实搬文件、超时、Pi 协议）
pnpm smoke      # 启动 → 截图 → 退出（CI 闸门）
pnpm shots      # 七个界面全截图到 artifacts/
```

首次启动会进引导。想先看东西，引导里点「跳过这一步」即可（默认演练模式，不会动真文件）。

## 架构

```
┌─ Renderer（React 19 + Tailwind v4）──────────────────────────────┐
│  index.html      时间线 / 历史 / 设置 / 引导                      │
│  overlay.html    桌面悬浮（透明、不抢焦点）                       │
│  permission.html 权限浮窗（透明、置顶）                           │
│  只能通过 window.kivora（contextBridge）说话，没有 Node 权限      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ IPC（invoke + 一条 changed 广播）
┌──────────────────────────▼──────────────────────────────────────┐
│ Main（Electron 45 / Node 24）                                    │
│  store.ts          node:sqlite + WAL + 迁移（失败拒绝启动）       │
│  repos/*           会话 / 事件 / 队列 / 审批 / 模型 / 配置        │
│  providers/http.ts 超时、指数退避、熔断、错误归一化               │
│  providers/*       OpenAI 兼容 chat/ASR/TTS、Anthropic、DashScope WS 语音 │
│  voice.ts          转写与合成（mock 可切、合成缓存）              │
│  dispatcher/       反射路由 → brain → 会话/队列/审批              │
│  tasks/files.ts    真正能执行的那条路 + 硬边界                    │
│  dispatcher/pi-runner.ts  pi -p --mode json 会话（可选执行器）     │
│  windows.ts        三个窗口                                       │
└──────────────────────────────────────────────────────────────────┘
```

几条硬规则：

- 渲染进程**不经手**持久化和密钥，只拿 DTO。
- 存储用 Node 内置 `node:sqlite`，**没有原生模块**，不用 electron-rebuild。
- 所有出网请求过同一层：20s 超时、按链路退避（brain 3×/asr 3×/tts 2×）、60s 内 5 次失败熔断 30s。
- **重试只发生在单次 provider 请求这一层**，不重放整个 agent turn。
- 任务结束、审批结果、配置变更都写库并广播，UI 只重取对应切片。

## 数据放在哪

```
%APPDATA%\kivora\data\kivora.db   # 会话、消息、事件、队列、审批、模型、配置
Windows 凭据管理器（DPAPI）        # API Key，只存密文
```

事件与审计按设置里的天数清理（默认 7 天），消息不自动删。\n\n默认模型栈：调度/任务 `deepseek-chat`（`https://api.deepseek.com/v1`），识别 `qwen-audio-3.1-asr-flash-message`、合成 `qwen-audio-3.1-tts-flash`（默认 Base URL 指向一家 OpenAI 兼容的音频端点，换厂商只改 Base URL/Key/模型 ID）。语音这两条走 **WebSocket**（DashScope 协议：`run-task` → 二进制/`continue-task` → `finish-task`，事件 `task-started/result-generated/task-finished/task-failed`），不是 OpenAI 的 `/audio/*` HTTP 接口；录音直接采 16k 单声道 WAV 再发过去。长文件转写用 `...-filetrans`、下一代合成用 `...-tts-next`、流式用 `...-realtime-plus`。

## 已知边界（说清楚，不假装）

1. **CUA / 浏览器需要你自己装服务器**：Kivora 只写 `~/.pi/agent/mcp.json`，`cua-driver` 和 `@playwright/mcp` 得装在机器上；没装的话 pi 会报连接失败。
2. **Pi 执行器是可选开关**：默认走内置执行器；切到 Pi 会话后，危险 bash、家目录外写入、动作类 MCP 工具会先问，但这是启发式规则，不是沙箱。
3. **安装包未签名**：会触发 SmartScreen，需要手动放行；自动更新没做。
4. **真端点没连过**：没有 Key，所以 ASR/TTS/chat 的真实链路只做了代码与错误路径，未做端到端压测。
5. **G3 一律手动**：装软件、UAC、支付、凭据只出卡片，不开语音（设置里可以强开，不建议）。

## CUA / 浏览器 / 权限：都借 Pi 的插件，不自己造

三条都是 Pi 已经有的扩展点，Kivora 只做接线：

| 能力 | Pi 那边是什么 | Kivora 做什么 |
|---|---|---|
| 桌面控制、浏览器 | **MCP 扩展**（随包的 pi 1.4.0 自带），读 `~/.pi/agent/mcp.json` | 设置 → 扩展：一键加 `cua-driver` / `@playwright/mcp`；只写 `kivora-` 前缀的条目；每行有「测试」按钮，真握手并列出工具数 |
| 权限控制 | **扩展的 `tool_call` 钩子** + `ctx.ui.confirm()` | 内置 `resources/kivora-permission.ts`：危险 bash、家目录外写入、动作类 MCP 工具先问；在 RPC 模式里变成审批卡，回答写回 `extension_ui_response` |
| 会话压缩 | **RPC `compact`** / 自动压缩 | 历史页「压缩」按钮（仅 Pi 会话）；`compaction_start/end` 事件进事件流 |
| 消息队列 | **RPC `steer` / `follow_up`**，事件 `queue_update` | 说「插一句」→ `steer` 进正在跑的 Pi 会话；任务级排队仍在 Kivora 自己的队列里 |

也就是说：**不要自己写 Playwright 抽取**。我试过直接驱动京东页面，DOM 与反爬让"通用抽取"不可靠；交给 `@playwright/mcp`，由模型按页面自己决定点哪里，才是可持续的路子。

## 设计稿

十四块画板在 [docs/design-v1.md](docs/design-v1.md)，源文件 `docs/assets/kivora-design-v1.fig`。长文折叠、错误状态、权限浮窗的规则也写在那份文档里。

## 路线

| 阶段 | 内容 |
|---|---|
| v0.1 ✅ | UI 全量、模型仓库、录音转写、审批总线、队列、历史、真实文件整理、Pi 执行器（可选）、NSIS 安装包 |
| v0.2 | MCP 扩展市场（更多服务器）、CUA 动作清单与作用域授权、Pi 工具白名单 |
| v0.3 | 作用域授权全生命周期、成本面板、自动更新 |
| v1.0 | 三场景 10 连跑验收、代码签名 |

## 许可

MIT。早期版本没有沙箱，别在有重要文件的机器上无人值守地跑。
