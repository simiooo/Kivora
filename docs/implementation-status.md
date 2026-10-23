# 设计与实现的对账表

> 用途：设计文档写过的东西，代码里到底有没有。每改一次交互就来这里对一遍，
> 别再出现"方案里写了、实现里没有、靠用户发现"的情况。
>
> 设计出处：`docs/voice-agent-plan.md`（v0.2 终局）、`docs/squent-plan.md`（v1.3 执行方案）、
> `docs/design-v1.md`（14 张画板）。
> 更新：2026-10-24

## 一、已经落地的

| 设计项 | 出处 | 实现 | 验证 |
|---|---|---|---|
| 语音层只调度，任务在独立会话跑 | squent 2.2 / 3.1 | `dispatcher/index.ts` `handleUtterance` → `createSession` → `runner` | flow 1–3 |
| **问答通路：不是每句都开任务** | squent 3.1（"判别"） | `brain.ts` 新增 `answer` 动作；`dispatcher` 在 `create_task` 之前先判别，问句直接回话、不建会话、不进执行器。模型提示词里带当前日期 | ack.test（问题/动作区分）、手动 |
| 反射路由优先，模型只做判别 | squent 3.1 | `dispatcher/router.ts`（零模型） | router.test |
| 排队 / 插话 / 抢占 | squent 3.6 | `repos/queue.ts` + `pump()` | flow 6–8 |
| 审批总线（会话 / Pi / 权限三来源） | squent 4 | `dispatcher/approval-bus.ts`、`resources/kivora-permission.ts` | flow |
| 状态投影 + 事件流 | squent 3.7 | `repos/sessions.ts` `patchStatus/appendEvent`、`SessionStrip` | flow、shots |
| 先出声：旁白 | squent 3.9 | `say()` → `bus.speak()`，`narration` 开关 | 手动 |
| **先出声：400ms 没结果才播 ack** | squent 3.9 / voice 1.2(A1) | `dispatcher/index.ts` `think()`：400ms 定时器 + `ack.ts` 意图短语 | ack.test（短语与意图） |
| **任务 >8s 补一句"还在弄"，只一次** | squent 3.9 | `runner.ts` `announceIfSlow()` | 手动 |
| **打断：停播报 + 取消那次判断** | voice 1.2 / 2.2 | `turn-state.ts` `interruptTurn()`；`bus.stopSpeech()`；快捷键与 Esc 触发 | 手动 |
| **"在想"状态** | 本次补充 | `turn-state.setThinking()` + `OverlayState.thinking` + 悬浮窗三颗点 | shots |
| **说完自动结束（端点检测）** | voice 2.2（本地 VAD） | `renderer/lib/vad.ts` + `audio.ts` 32ms 子帧 | vad.test（10 条） |
| **免按键（本地 VAD 触发录音）** | voice 1.2 常驻模式 | `renderer/lib/wake.ts` + 设置开关 | 手动（无自动化） |
| 免按键 30 分钟无交互自动退回 | voice 1.2 | `electron/main.ts` 定时检查 `idleMs()` | 手动 |
| 淡出抢占（新语音抢旧语音） | squent 3.9 | `playClip` → `stopPlayback(60)` 音量渐降 | 手动 |
| 分级退避 / 熔断 / 错误归一化 | squent 3.10 | `providers/http.ts` | 单测 + flow |
| 幂等：只重试单次 provider 请求 | squent 3.10 | 同上 | 代码结构 |

## 二、设计有、还没做的（明确缺口）

| 设计项 | 出处 | 现状 | 建议 |
|---|---|---|---|
| **唤醒词"小栗"** | voice 1.2 | 只做了 VAD 触发，没有唤醒词：开口就进，不需要叫名字 | 需要本地小模型（Porcupine / openWakeWord）；或先接受"VAD 即唤醒"，写进已知边界 |
| **ASR partial 预判** | voice 2.2 / squent 3.9 | 现在是"录完整段 WAV 再上传"，没有流式 partial | DashScope 有实时识别通道（`realtime-plus`）；要接就得改成流式 + 预判，属于下一阶段 |
| **A0–A3 响应阶梯 / Cost Router** | voice 0 / 1.2 | 固定一套模型栈（brain + task + asr + tts），没有按任务时长选 ack 级别 | 先保留单栈；等有多种模型再谈 |
| **6 层上下文栈 + 稳定前缀 ≥80% 命中** | voice 2.3 | brain 只带一句 `describeContext()`；Pi 会话自带上下文 | 影响的是成本不是功能，优先级低 |
| **L2/L3 实时通道 ≤3%** | voice 0 | 未接入实时 ASR；TTS 是整段合成 | 同上，属于成本优化 |
| **"只听不记"（不写 transcript）** | voice 1.2 | 没有：转录都会写库 | 加一个 `privateMode` 开关，写库前丢弃文本 |
| **执行器覆盖面** | squent 1.1（三条黄金路径） | 内置执行器只认文件整理；搜索/读消息要靠 Pi 会话。没配 Pi 时其它指令只能如实失败 | 失败文案已改成"说明现在能做什么"，覆盖面靠 Pi + MCP 补齐 |
| **语音改配置（§3.11）** | squent 3.11 | 没有：说"换个男声"不会改配置 | 反射路由加几条：音色/语言/热键，热键走审批 |
| **取景框 / 虚拟光标 / 4 类轻提示** | voice 0 / 1 | 未做（overlay 只有胶囊 + 卡片） | 需要 MCP/桌面控制先到位 |

## 三、怎么避免再次脱节

1. 新增交互前先在上表加一行（设计项 + 出处），实现完再改成"已落地"，附验证方式。
2. `pnpm flow` 与 `pnpm shots` 是唯一能自动发现"写了没接上"的地方：
   新交互至少要在这里留下一条断言或一张截图。
3. 只在设置里加开关、但没有任何路径读它的配置项，视为未实现（上一版 `ackEnabled` 就是这样躺了两周）。
