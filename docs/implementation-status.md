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
| **一轮最多两段语音** | squent 3.9 | `collect().spoken` 计数，`say()` 与 ack 共用预算，超了就只留文字不出声 | 代码 + 日志 `speech budget reached` |
| **上下文分层（5 层）** | squent 2.3 | `dispatcher/brain-context.ts`：偏好 / 最近说过 / 上次任务 / 当前 / 队列；稳定规则留在 system 里吃前缀缓存，时钟等易变信息不进去 | brain-context.test（6 条：空态、在跑、截断、时间感、偏好、无时钟） |
| **brain 熔断后的降级提示** | squent 3.10 | 判别真的失败（不是被打断）且还没播过 ack 时，说一句"我脑子暂时连不上，先按字面做。" | 代码（`diagnostics.failed`） |
| **任务 >8s 补一句"还在弄"，只一次** | squent 3.9 | `runner.ts` `announceIfSlow()` | 手动 |
| **打断：停播报 + 取消那次判断** | voice 1.2 / 2.2 | `turn-state.ts` `interruptTurn()`；`bus.stopSpeech()`；快捷键与 Esc 触发 | 手动 |
| **"在想"状态** | 本次补充 | `turn-state.setThinking()` + `OverlayState.thinking` + 悬浮窗三颗点 | shots |
| **说完自动结束（端点检测）** | voice 2.2（本地 VAD） | `renderer/lib/vad.ts` + `audio.ts` 32ms 子帧 | vad.test（10 条） |
| **免按键（本地 VAD 触发录音）** | voice 1.2 常驻模式 | `renderer/lib/wake.ts` + 设置开关 | 手动（无自动化） |
| 免按键 30 分钟无交互自动退回 | voice 1.2 | `electron/main.ts` 定时检查 `idleMs()` | 手动 |
| 淡出抢占（新语音抢旧语音） | squent 3.9 | `playClip` → `stopPlayback(60)` 音量渐降 | 手动 |
| 分级退避 / 熔断 / 错误归一化 | squent 3.10 | `providers/http.ts` | 单测 + flow |
| 幂等：只重试单次 provider 请求 | squent 3.10 | 同上 | 代码结构 |
| **只听不记** | voice 1.2 | `privateMode`：原话不落库，只留"（只说了一句，没记下来）"占位；动作与结果照常记录 | 设置开关、flow 断言 |
| **内置做不了 → 自动转 Pi** | squent 5.2 / CUA | `runner.startTask()`：`autoEscalate` 且装了 Pi 且解析不出文件任务时直接走 Pi 会话，事件里留「转给 Pi」 | flow（接不了的指令走 Pi 失败） |
| **Pi 凭据桥接** | squent 5.4 | `pi-config.ts` 按 baseUrl 域名把绑定的任务模型映射成 Pi 的 `provider/model`，Key 从 DPAPI 取出来只经环境变量传（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`），不落盘 | pi-config.test；手动验证：假 Key 下 Pi 收到 DeepSeek 的 401，说明 provider 与模型名都对 |
| **语音改配置（§3.11 子集）** | squent 3.11 | 反射路由 `config`：切识别语言（中/英/自动）、语速 ±0.1；热键/目录/Key 仍只走设置页 | router.test |
| **流式识别（边说边出字）** | voice 2.2 / squent 3.9 | `providers/dashscope-stream.ts`（`AsrStream`：run-task → 推 PCM → `sentence_end` 定稿）；录音每 200ms 推一段；悬浮窗实时显示中间结果。**默认仍是批式**：只有识别模型名以 `-streaming` 结尾才走这条路（模型编辑器预设里有「Qwen 流式识别」），起不来会自动退回批式 | dashscope-stream.test（3 条） |

## 二、设计有、还没做的（明确缺口）

| 设计项 | 出处 | 现状 | 为什么先不做 / 下一步 |
|---|---|---|---|
| **唤醒词门（可选，文字级）** | voice 1.2 | 免按键 + 绑定流式识别时，可说「小栗」再下指令：`shared/wake.ts` 判断中间结果里有没有名字，1.6 秒内没出现就整段丢掉（不派发、不落库）；打开后设置里写清"这 1.5 秒会经过识别服务"。默认关闭 | wake.test（6 条：句首/句中/大小写/去称呼/空词） |
| **本地声学唤醒词** | voice 1.2 | 现在是文字级唤醒门（见上），开口那 1.6 秒仍会经过识别服务 | 真正的本地唤醒要声学模型（Porcupine 商业 key / openWakeWord ONNX + 训练），需要产品决策与授权 |
| **Cost Router（按任务时长选 ack 级别）** | voice 0 / 1.2 | A0–A3 四段响应阶梯都在；缺"选级别"的路由 | 只有一条通道时没有可路由的选项，等接实时通道再做 |
| **6 层上下文栈** | voice 2.3 | 实到 5 层（偏好 / 最近说过 / 上次任务 / 当前 / 队列），没有"长期记忆" | 产品还没有记忆库，宁缺毋滥；前缀缓存靠"稳定 system + 易变信息在尾部"已经吃到 |
| **L2/L3 实时通道 ≤3%** | voice 0 | 未接入实时 ASR；TTS 整段合成 | 属于成本口径；流式识别已覆盖"边说边出字"的体感 |
| **取景框 / 虚拟光标 / 4 类轻提示** | voice 0 / 1 | 未做（overlay 只有常驻卡片） | 要等 Pi + MCP 的桌面控制先稳定 |

## 三、怎么避免再次脱节

1. 新增交互前先在上表加一行（设计项 + 出处），实现完再改成"已落地"，附验证方式。
2. `pnpm flow` 与 `pnpm shots` 是唯一能自动发现"写了没接上"的地方：
   新交互至少要在这里留下一条断言或一张截图。
3. 只在设置里加开关、但没有任何路径读它的配置项，视为未实现（上一版 `ackEnabled` 就是这样躺了两周）。
