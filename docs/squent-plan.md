# squent 方案 v1.3（评审稿）

> 2026-10-22 · 关联 SIM-651 · 评审通过后按 §8 开工
> 一句话：**按住热键说一句话，squent 开一个独立会话，用 CUA 在你自己电脑上把事做完，再用一句话告诉你结果。**

**v1.2 变更**
1. 语音层自恢复：分级指数退避 + 熔断 + 幂等，降级时仍能"按字面干活"。
2. 审批统一收敛到**一条总线**：调度器、会话、会话里的子进程，所有审批都冒泡到调度器处理。
3. 调度器主动检索：按当前语境自己找会话、找历史；支持 FTS 搜索与歧义澄清。
4. 执行前先说一嘴：模型流式旁白（"我去查""正在弄"），缓存 ack 只做兜底。

**v1.3 变更**：新增 §6 消息时间线——以调度器层为主时间线，会话消息折叠在任务条后按需展开；补三种消息生产者与"过程不逐条总结"的成本取舍。

---

## 0. 决策摘要

| 维度 | 决定 |
|---|---|
| 产品 | Windows 桌面语音助手；热键说话，语音只做"听懂 → 派活 → 汇报" |
| 分工 | 语音层 = **带工具的 LLM Agent**（`pi-agent-core`，≤3 轮）；执行层 = 每任务一个 `pi --mode rpc` 子会话；CUA 只在子会话 |
| 语音链路 | 云端批量 ASR（≤30s）+ 云端 TTS；不做流式、实时、唤醒词 |
| 电脑操控 | **cua-driver**（Rust，MCP stdio，MIT）；浏览器 Playwright MCP；兜底 desktop-touch-mcp |
| 端点 | ASR / TTS / 调度 LLM / 任务模型四段**全部用户自配**，默认 OpenAI 兼容 |
| 权限 | **审批总线**：三源归一、语音/卡片双通道、超时默认拒绝、作用域授权 |
| 自恢复 | 分级退避（300ms 起、3 次、带抖动）+ 熔断 30s + 工具幂等 |
| 存储 | SQLite（WAL）在主进程；`safeStorage` 加密密钥；渲染进程只拿 IPC DTO |
| UI | Electron + React + Vite + Tailwind + **shadcn/ui** |
| 开源 | 仓库 `squent`，MIT，零遥测，BYO Key，便携 zip |
| 节奏 | 10 个工作日发 v0.1.0；D5 设 cua-driver 可用性闸门 |

---

## 1. 产品定义

### 1.1 三条黄金路径

**A. 浏览器**
> "帮我在京东搜机械键盘，按销量排。"
> 「好，我去搜。」→ 胶囊转圈 → 任务卡 → 「找到了，前三名是……」，可展开看截图。

**B. 桌面应用**
> "打开计算器，算一下 6 乘 7。"
> 「好，我算一下。」→ 计算器被打开并点击 → 「42。」

**C. 文件**
> "把下载目录里上周的 pdf 挪到文档/发票。"
> 「要移动 4 个文件，可以吗？」→ 「可以。」→ 「挪好了，4 个。」

### 1.2 不做什么（这一版）

IM、Office COM、IDE 专用适配、唤醒词、常驻监听、实时通话、流式 ASR、取景框、虚拟光标、多任务并发（>1 运行）、会话树 UI、计费、安装器、自动更新、遥测、i18n。

---

## 2. 系统设计

### 2.1 进程与模块

```
┌────────────────────── Renderer（无 Node 权限）──────────────────────┐
│ React + shadcn/ui：录音/波形 · transcript · 任务卡 · 审批卡 · 设置    │
└───────────────────────────┬────────────────────────────────────────┘
                            │ IPC（typed DTO）
┌───────────────────────────▼────────────────────────────────────────┐
│ Main（Node 22）                                                     │
│  ├ VoiceAgent      pi-agent-core Agent：14 工具，≤3 轮               │
│  │                 ├ PromptAssembler（C0–C5，稳定前缀 1.2k）         │
│  │                 ├ ReflexRouter（确认/停/重试，零模型）             │
│  │                 └ Narrator（流式旁白，先出声再干活）               │
│  ├ SessionMgr      spawn/kill/queue/preempt + RPC 事件订阅           │
│  ├ StatusProjector 事件 → session_status                            │
│  ├ ApprovalBus     三源归一 → 排队 → 语音/卡片 → 回执               │
│  ├ RetryPolicy     退避 + 熔断 + 幂等（brain/asr/tts）               │
│  ├ Db              better-sqlite3（WAL）                            │
│  └ SecretStore     safeStorage(DPAPI) → 密文入库                     │
└───────────────────────────┬────────────────────────────────────────┘
                            │ JSONL RPC（一任务一进程）
┌───────────────────────────▼────────────────────────────────────────┐
│ pi --mode rpc --session <file>                                      │
│  ├ squent-guard 扩展：tool_call 拦截 → ctx.ui.confirm → 审批总线      │
│  ├ MCP: cua-driver / playwright                                     │
│  └ 内置 read/write/edit/bash/powershell                             │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 一次指令的时序

```
按住热键 ─► 录音 ─► 松开 ─► ASR（p50 600ms，失败退避重试）
                                │
                          ReflexRouter（命中即执行，<80ms）
                                │ 未命中
                                ▼
                 VoiceAgent（LLM，≤3 轮）
                   │ ① 先流出一句旁白「我去查」→ TTS 立刻播
                   │ ② tool_call：create_task / get_status / search_sessions …
                   │ ③ 工具结果 → 第 2 轮收尾成一句话
                   ▼
              SessionMgr ──► pi 子进程
                   │                │
                   │                ├─ 危险动作 → guard → extension_ui_request
                   │                │        └─► ApprovalBus → 播报 + 卡片
                   │                │              └─► 回执 → 工具继续/拒绝
                   │                │
                   └─ 事件 ──► StatusProjector ──► 卡片/状态
```

目标：松手 400ms 内有声音；2.5s 内听到第一句有意义的话。

---

## 3. 语音调度层

### 3.1 形态

`pi-agent-core` 的 `Agent`（不是 `AgentSession`）：工具循环、事件流、`beforeToolCall`、`finishTurn` 都有，但不带文件工具与 TUI。

两个入口，同一套工具：
- `onUserUtterance(text)`：用户说话。
- `onEvent(event)`：审批到达、任务失败/完成这类**主动事件**（见 §3.12），触发一次"通报型"运行。

限制：每轮 ≤3 次模型调用；用户话超时 4s；事件话超时 3s；事件触发的运行每 60s 最多 3 次（防话痨）。

### 3.2 Prompt 组装

| 层 | 内容 | 预算 | 缓存 |
|---|---|---|---|
| C0 身份 | 角色、说话风格、工具纪律、旁白规则、拒答边界 | 470 | 前缀 |
| C1 工具 | 14 个工具的精简 schema | 800 | 前缀 |
| C2 用户 | 称呼、语言、时区、应用别名、默认工作目录 | 120 | 前缀 |
| C3 卡片 | 活跃会话 ≤6：`id 标题 状态 年龄 是否等你` | 210 | 尾部 |
| C4 近况 | 最近 3 轮语音 + 上次指代的会话 id | 120 | 尾部 |
| C5 当下 | transcript + 前台窗口标题 + 时间 | 80 | 尾部 |

C0 关键几句：

> 你是 squent 的语音调度器。只做四件事：建任务、查状态、改任务、答闲话。
> 说话要能直接念出来：一句 ≤25 字，不用列表、不念代码、不念完整路径。
> **每次调用工具前，先流出一句 ≤10 字的旁白**，如"我去查""我先看看""正在弄"；同一轮最多两句。
> 指代不清就先 `search_sessions`，两个候选以上就问用户一句。

### 3.3 工具契约（14 个）

| 工具 | 入参 | 返回 |
|---|---|---|
| `create_task` | `prompt, title?, priority?` | `{id, state}` |
| `list_sessions` | `scope: active\|recent, limit≤6` | `{items:[{id,title,state,age_s,needs}]}` |
| `search_sessions` | `query, limit≤3` | `{items:[{id,title,state,score}]}`（FTS5） |
| `get_status` | `id?` | `{state,turn,phase,tool,elapsed_s,needs?,error?,artifacts?}` |
| `get_detail` | `id` | 上述 + `{plan[],recent[≤5],stats{tools,tokens}}` |
| `get_history` | `id, query?, limit≤5` | `{events:[{ts,type,summary}]}` |
| `send_message` | `id, text, mode: queue\|steer` | `{accepted, position}` |
| `cancel_task` | `id` | `{ok}` |
| `retry_task` | `id, mode: continue\|restart` | `{state}` |
| `resume_task` | `id` | `{state}` |
| `compact_task` | `id` | `{before, after}` |
| `reorder_queue` | `id, to: front\|back` | `{position}` |
| `answer_pending` | `id, answer: yes\|no\|scope` | `{resolved}` |
| `config` | `op: get\|set, keys/patch` | `{applied, needs_restart?, redacted}` |

返回一律 ≤120 tokens，超了截断；每个工具配一个口语化渲染函数，模型只读 JSON，说出口的是我们渲染的句子。

### 3.4 主动检索：怎么"自己去找"

指代消解按优先级，**先猜后问**：

| 用户说 | 解析 |
|---|---|
| 带 id / 卡片里的标题 | 直接用 |
| "它/那个/刚才那个/继续" | `C4.last_referenced_session` |
| "上次那个发票的""前几天那个" | `search_sessions(query)`，取 top-3 |
| "都在干嘛/有几个任务" | `list_sessions(active)` + 汇总 |
| 仍不唯一 | 问一句：「是整理发票那个，还是搜键盘那个？」（各 ≤10 字） |

- 只有 top1 分数明显高于 top2（阈值可调）才直接采用；否则必须问。
- 命中已归档会话 → `get_history` 读摘要与关键事件，必要时 `resume_task`。
- 每次成功指代都写回 `C4.last_referenced_session`，下一轮继续可指。

### 3.5 任务分配

反射路由先跑（零模型）：

| 条件 | 动作 |
|---|---|
| 有 `needs=confirm` 且说"确认/可以/好" | `answer_pending(yes)` |
| 同上但说"不行/取消" | `answer_pending(no)` |
| "停/别做了/算了" + 有运行中 | `cancel_task` |
| "重试/再来一次" + 最近失败 | `retry_task(continue)` |
| 其他 | 交 LLM |

LLM 判定表（写进 C0）：新建 → `create_task`；指代 → `list_sessions`/`search_sessions`；追加 → `send_message(queue)`；打断 → `send_message(steer)`；抢占 → `reorder_queue(front)`；查状态 → `get_status`；续做 → `resume_task`；压缩 → `compact_task`。

### 3.6 排队、插话、抢占

| 动作 | 语义 | 实现 |
|---|---|---|
| 排队 | 当前 run 结束后执行 | Pi `follow_up` |
| 插话 | 当前 assistant turn 之后插入，不打断工具 | Pi `steer` |
| 抢占 | 让出 CPU 给更急的任务 | `abort` → 标 `paused` → 插队 → 空闲自动 `prompt("继续")` |

- 抢占**只在 `thinking/verifying` 阶段生效**；`acting` 阶段改为排序等待，避免半成品。
- 队列上限 5；同一会话最多 2 条待执行指令。

### 3.7 状态投影

```
RPC 事件 ─► StatusProjector ─► session_status（一会话一行）
  turn_start            running, turn++, phase=thinking
  tool_execution_start  phase=acting, tool=<name>
  tool_execution_end    last_tool_ok, artifacts 追加
  extension_ui_request  waiting_user, needs=<confirm|clarify>
  agent_settled         done, summary=最后一段文本（≤200 字）
  exit/err              failed, error=<code>
```

状态机：`queued → starting → running ⇄ waiting_user → done | failed | aborted`，另有 `paused`。
`phase` 只用四值，不编百分比；进度用"第几轮 + 时长 + 当前工具"表达。

### 3.8 续做 / 重试 / 压缩

- **续做**：`pi --mode rpc --session <会话文件>` + `prompt("继续")`。
- **重试**：`continue`（带失败原因换方法，保留上下文）/ `restart`（新会话，干净重来）。
- **自动重试**：仅工具/MCP 瞬时错误，退避 5s 重试 1 次；权限拒绝与模型错误不自动重试。
- **压缩**：自动走 Pi compaction；手动 `compact_task` 调 RPC `compact`，返回前后 token。

### 3.9 先出声：旁白与 ack

| 时机 | 说什么 | 来源 |
|---|---|---|
| 模型 400ms 内流出文字 | 直接播第一句 | 模型旁白（首选） |
| 400ms 无文字 | 播缓存片段（"好""我看一下"） | ack 库 |
| 任务 >8s | 补一句"还在弄"，仅一次 | ack 库 |
| 需要审批 | 旁白直接变成问题 | 审批总线 |
| 完成 | 结论 ≤25 字 | 模型 |

规则：一轮最多两段语音（旁白 + 结论/进度）；播报不叠加，新语音抢占时旧的淡出 120ms。**旁白默认开启，设置里可一键关闭**（关闭后只用缓存 ack）。

### 3.10 自恢复（v1.2 新增）

**分级退避**（每条链路独立）：

| 链路 | 次数 | 基数 | 倍数 | 抖动 | 上限/次 | 总预算 |
|---|---|---|---|---|---|---|
| brain（调度 LLM） | 3 | 300ms | 2 | ±20% | 2s | 6s |
| asr | 3 | 500ms | 2 | ±20% | 3s | 12s |
| tts | 2 | 300ms | 2 | ±20% | 1s | 4s |

- 可重试：连接重置、DNS、超时、408/425/429/5xx。不可重试：400/401/403/404、内容策略拒绝。
- 429 优先服从 `Retry-After`；若 >10s 直接降级，不干等。
- **熔断**：同一端点 60s 内 5 次失败 → 打开 30s → 半开探测一次。
- **重试可见**：只在第一次重试时播一句"网络有点卡，我再试一下"，之后静默。
- **降级**：brain 熔断 → 反射路由 + 字面建任务 + 播"我脑子暂时连不上，先按字面做"；asr 熔断 → 提示手动输入（设置里可开文本框）；tts 熔断 → 只出卡片不出声。

**幂等（关键）**：重试只发生在**单次 provider 请求**这一层，不重放整个 agent turn。已经执行过的工具不会再执行；有副作用的工具调用写 `op_log(op_id = hash(session+tool+args))`，重复请求直接返回上次结果。

### 3.11 语音改配置

| 可改 | 例子 | 限制 |
|---|---|---|
| TTS 音色/语速 | "换个男声" | 立即生效 |
| ASR 语言 | "切英文识别" | 立即生效 |
| 调度/任务模型 | "干活用强一点的" | 立即生效 / 只影响新会话 |
| 工作目录 | "换到 D 盘 work" | **走审批**，影响新会话 |
| 热键 | "改成 Ctrl+Shift+空格" | **走审批**，校验冲突 |
| Key / baseUrl | — | **禁止语音修改**，只走设置页 |

---

## 4. 审批总线（v1.2 重写）

### 4.1 三个来源，一条总线

| 来源 | 典型场景 | 冒泡方式 |
|---|---|---|
| **调度器** | 改工作目录、改热键、访问密钥 | 直接写 `approvals` |
| **会话** | 会话要执行 G2 工具（删除/提交/发送） | `squent-guard` 在 `tool_call` 拦截 → `ctx.ui.confirm()` → RPC `extension_ui_request` → 总线 |
| **子进程** | 会话里的 bash/MCP 需要更高权限 | guard 按"命令前缀/路径/域名"识别 → 总线；无法识别的系统级弹窗（UAC）不由我们代点 |

`ctx.ui.confirm` 在 RPC 模式下会**阻塞工具调用**直到客户端回执，这正是"冒泡"的通道；它自带 `timeout`，超时按默认值（拒绝）自解，不会把会话挂死。

### 4.2 归一化结构

```json
{
  "id": "ap_12",
  "source": "session",
  "session_id": "s_7f",
  "tool": "mcp__cua__click",
  "risk": "G2",
  "summary": "删除 4 个文件",
  "detail": ["发票-0912.pdf", "发票-0913.pdf", "..."],
  "options": ["allow_once", "allow_scope", "deny"],
  "default": "deny",
  "expires_at": 1750000000,
  "speech": "要删掉 4 个文件，可以吗？"
}
```

### 4.3 流程

```
到达 ─► 入 approvals(pending) ─► 卡片 + 角标
      ─► 若无正在进行的审批 → VoiceAgent.onEvent() 起一轮
      ─► 播报 speech（≤20 字）+ 卡片显示 detail
用户 ─► 语音"可以" → answer_pending → 总线回执 allow_once
      ─► 语音"以后都行" → allow_scope → 写 grants（工具+作用域+会话）
      ─► 语音"不行" → deny
      ─► 点卡片 → 同一总线
      ─► 15s 无响应 → 复问一次（仅一次）
      ─► G1 30s / G2 60s 无响应 → 默认 deny，播"我先不动了"
      ─► G3 不自动超时：只出卡片，等人来点（可能人不在）
```

### 4.4 作用域授权（减少打断）

选 `allow_scope` 时写一行 `grants`：`{session_id, tool, scope: path|domain|command_prefix, value, expires_at}`。之后同作用域自动放行，不再问。作用域随会话结束失效，可在设置里一键吊销。

### 4.5 语音侧纪律

- 同一时刻**只问一个**审批；其余排队、只出卡片。
- 模糊回答（"嗯…""再说"）不算同意，必须追问"可以，还是不行？"
- 审批播报永不叠加旁白；问完等回答，不做别的播报。
- G3（装软件/UAC/支付/凭据）**永不走语音**，只显示卡片并要求手动点击。

---

## 5. 执行层

### 5.1 会话生命周期

`create → spawn pi --mode rpc --session-dir <dir> → prompt → 事件投影 → done → 24h 归档`；抢占 `abort` → `paused`；`abort` 3s 不退则 `SIGKILL`。

### 5.2 CUA 接入

```json
{ "mcpServers": {
    "cua":        { "command": "cua-driver", "args": ["mcp"] },
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } } }
```

`CUA_DRIVER_PERMISSION_MODE=bounded` + manifest 由设置页开关生成。D5 闸门不过 → 切 `desktop-touch-mcp`。

### 5.3 权限硬边界

1. cua-driver `bounded`（硬）。
2. Pi `--tools` 白名单。
3. 审批总线（软，但覆盖所有已知风险动作）。

### 5.4 端点（BYO）

```json
{ "asr": {...}, "tts": {...}, "brain": {...}, "task": {...} }
```

`task` 段转写成 Pi `models.json`；不代收代付、不内置 Key。

---

## 6. 界面与消息时间线

### 6.1 一条时间线，两种粒度

主界面是**一条全局时间线**，不是每个会话一个聊天窗。五种行：

```
[你]      把下载目录里上周的 pdf 挪到文档/发票
[squent]  要移动 4 个文件，可以吗？      [允许] [以后都行] [拒绝]
[你]      可以
[squent]  挪好了，4 个。                 → 打开文件夹
────────────────────────────────────────────────────────
[任务 s_7f] 整理发票 · 完成 · 8s · 4 个文件            查看过程 ⌄
[任务 s_81] 搜索机械键盘 · 运行中 · 第2轮 · 点第3个按钮  查看过程 ⌄
```

- **语音气泡 = 实际播报的那句话**，一字不差。
- **任务条常显"当前在干什么"**（来自投影表的 `turn` + `tool`），不展开也看得见。
- **"查看过程"是只读日志**：工具名、参数摘要、截图缩略、diff，可复制可导出；不是聊天框，不能在这里对话。
- 审批卡置顶粘性，处理完才落回时间线。
- 输入框保留：ASR 失败时的降级入口，也是键盘用户的无障碍通道。

### 6.2 为什么以调度器层为主（而不是直接显示会话消息）

1. **一个心智模型**：用户在跟 squent 说话，不是同时跟 5 个 agent 说话。会话消息一进来，叙述就分叉了。
2. **说的和写的一致**：气泡文案就是 TTS 文案，不会出现"听到一句、看到另一句"的信任裂缝。
3. **体积与隐私**：会话消息里是完整路径、参数、截图、token；调度器消息是已经为"说出口"净化过的。
4. **失败可读**：会话报 `MCP tool returned 500`，用户需要的是"它没打开那个窗口"。
5. **上下文可复用**：≤25 字的气泡能低成本回灌 C4；会话消息不行。

### 6.3 但会话层不能藏起来

只显示调度器层，用户会怀疑"它背着我干了什么"。所以三条硬规则：
- 任务条**永远**显示当前工具与轮次（不展开也可见）。
- 失败时**自动展开**最后 3 条事件。
- 每个任务都可导出完整过程日志（JSONL），链接到会话目录。

### 6.4 三种消息生产者

| 行 | 生产者 | 成本 |
|---|---|---|
| 用户气泡 | ASR 结果（可点"重说"重录） | 已有 |
| squent 气泡 | VoiceAgent 流式文本（即播报那句） | 已有 |
| 任务条 | 确定性模板（状态机 → 文案），**不用模型** | 0 |
| 过程日志 | `session_events` 直读 | 0 |
| 里程碑总结 | 任务结束/失败时模型一句话（可关） | 1 次小调用 |

关键取舍：**过程不逐条总结**。每条工具调用都生成一句人话 = 每条都要一次模型调用，成本与延迟都不允许；只有里程碑（完成、失败、待审批）走模型。

### 6.5 时间线不进上下文

时间线是给人看的，不进 C0–C5。C4 仍只保留最近 3 轮；更早的历史靠 `search_sessions`（FTS 覆盖 `messages`）按需检索。**滚动不等于上下文**——这是"语音层上下文要短"这条原则在 UI 上的延伸。

---

## 7. 存储与工程

### 7.1 SQLite（主进程独占）

```sql
sessions(id PK, title, prompt, cwd, state, priority, pi_session_file,
         created_at, updated_at, tokens_in, tokens_out, cost_usd, last_error);
session_events(id PK, session_id, seq, ts, type, payload);
session_status(session_id PK, state, turn, phase, tool, last_tool_ok,
               elapsed_ms, needs, artifacts, summary, updated_at);
messages(id PK, session_id, role, content, ts);
queue(id PK, session_id, position, enqueued_at);
approvals(id PK, source, session_id, tool, risk, summary, detail,
          options, status, created_at, resolved_at, resolution);
grants(id PK, session_id, tool, scope, value, expires_at);
op_log(op_id PK, session_id, tool, result, created_at);
config(key PK, value, updated_at);
secrets(name PK, ciphertext, updated_at);
acks(id PK, text, voice, path, created_at);
audit(id PK, ts, actor, action, detail);
schema_migrations(version PK, applied_at);
```

WAL；事件保留 7 天；启动把孤儿 `running` 标 `failed(orphaned)`；迁移失败拒绝启动。

### 7.2 工程

Electron + React 19 + Vite + TS + Tailwind v4 + shadcn/ui（16 个组件）+ better-sqlite3 + zod。
脚本：`pnpm dev / check / test / dist`；CI 在 `windows-latest`；`check-deps.mjs` 查 Node/`cua-driver`/`npx`。
MIT；不打包 AGPL 的 `cua-perception`。

---

## 8. 10 天计划

| 天 | 交付 | 验收 |
|---|---|---|
| D0 | 仓库骨架、CI、SQLite 迁移、shadcn | `pnpm dev` 出窗，CI 绿 |
| D1 | 热键 + 录音 + 消息时间线骨架 + 设置抽屉 | 能录能回放；气泡与任务条能渲染 |
| D2 | ASR + transcript + messages | 说一句出字并落库，p50 < 800ms |
| D3 | VoiceAgent（Agent + 14 工具 + C0–C5 + 反射 + 旁白） | 四类话正确走工具；旁白先于工具出声 |
| D4 | SessionMgr + 投影 + 队列/抢占 + 检索（FTS） | 松手 400ms 有声；"上次那个"能找对 |
| **D5** | **cua-driver spike + 接入** | **闸门：启动/读状态/点击/输入/校验 5 项过 4 项** |
| D6 | Playwright + 登录态 profile | 场景 A 端到端 |
| D7 | **审批总线**（guard + 回执 + 作用域）+ 重试/续做 | 场景 C 的审批、拒绝、允许作用域全通 |
| D8 | 打包 + 首次运行引导 + README | 干净机器 15 分钟跑起来 |
| D9 | 三场景各 10 连跑 + 熔断/降级演练 | 通过率 ≥ 9/10 |
| D10 | demo GIF + 发布 v0.1.0 | 仓库公开、Release 可下载 |

D5 不过 → 切 desktop-touch-mcp，D6–D10 顺延 1 天。

---

## 9. 验收

| 项 | 标准 |
|---|---|
| 三场景 | 各 10 次，成功 ≥9 |
| 首响 | 松手→有声 p50 ≤400ms，p95 ≤800ms |
| 旁白 | 工具调用前有语音的比例 ≥90%，且不叠加 |
| 状态 | 10 次查询里 9 次能答出"卡在哪一步" |
| 检索 | "上次那个……" 10 次里 8 次找对，错误时必追问 |
| 审批 | 三源各 5 次，冒泡率 100%，超时默认拒绝生效 |
| 自恢复 | 注入 500/429/断网，6s 内降级且不产生重复任务 |
| 队列 | 排队/插话/抢占/恢复各 5 次无状态错乱 |
| 时间线 | 气泡与播报一字不差；任务条实时反映当前工具；过程日志可导出 |
| 干净机器 | 15 分钟内完成安装 + 配置 + 首任务 |

---

## 10. 风险与回退

| 风险 | 信号 | 回退 |
|---|---|---|
| 审批播报与旁白打架 | 用户听不清 | 审批优先级最高，独占播报 |
| 审批风暴（一次批量删除触发 N 个） | 连续追问 | 同类合并成一条（"要删 12 个文件"） |
| 重试造成重复任务 | 队列出现重复 | `op_log` 幂等 + 任务 prompt 去重 |
| 旁白变成话痨 | 用户抱怨 | 每轮 ≤2 段，可全局关 |
| cua-driver 不稳 | D5 <4/5 | 切 desktop-touch-mcp |
| 抢占留半成品 | 文件改一半 | `acting` 阶段禁止抢占 |
| 状态投影漏事件 | 卡片卡住 | 5s 对账 + settled 强刷 |

---

## 11. 开工前需要你点头的四件事

1. **GitHub 仓库归属**：个人号还是 org？名字 `squent`。
2. **允许跑 cua-driver 官方安装脚本**（D5）。
3. **测试端点**：没有则 D2–D4 用 mock。
4. **品牌**：`squent` 是暂定代号还是正式名？
