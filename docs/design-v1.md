# Kivora 设计稿 v1

十三块画板。源文件 `docs/assets/kivora-design-v1.fig`，改稿在 OpenPencil 里改，重新导出即可（**只导 PNG，按 id 小范围导**）。

| # | 画板 | 说明 |
|---|---|---|
| 01 | 主时间线 | 默认态：消息、审批卡、任务条、输入区 |
| 02 | 运行中 | 旁白「我去搜」、任务条展开成过程日志、麦克风变 acorn |
| 03 | 设置抽屉 | 380 宽速设：热键 / 端点预览 / mock 开关 |
| 04 | Onboarding | 三步中的第 2 步：麦克风与热键，含试音条 |
| 05 | 会话历史 | 左列表右详情：事件流 + 对话摘要 + 操作 |
| 06 | 桌面悬浮 | 常驻胶囊 + 最近上下文（待处理 / 前台 / 选中 / 上次） |
| 07 | 未处理队列 | 插话 / 排队 / 执行中三态，可提前或取消 |
| 08 | 设置页面 | 左导航 + 四段端点卡片 + 测试/保存 |
| 09 | 悬浮权限 | 权限冒泡到调度器时的浮窗：语音 + GUI 双通道、倒计时 |
| 10 | 长文与折叠 | 长正文、思考块、工具输出、长审批列表的折叠规则 |
| 11 | 错误状态 | 端点错误横幅、ASR 失败行、任务失败条、失败卡片 |
| 12 | 模型仓库 | 模型列表 + 测试状态 + 功能模块绑定 |
| 13 | 模型详情 | Base URL / Model ID / Key、参数、自定义请求头 |

![01 主时间线](assets/design-01-timeline.png)
![02 运行中](assets/design-02-running.png)
![03 设置抽屉](assets/design-03-settings.png)
![04 Onboarding](assets/design-04-onboarding.png)
![05 会话历史](assets/design-05-history.png)
![06 桌面悬浮](assets/design-06-overlay.png)
![07 未处理队列](assets/design-07-queue.png)
![08 设置页面](assets/design-08-settings.png)
![09 悬浮权限](assets/design-09-permission.png)
![10 长文与折叠](assets/design-10-longtext.png)
![11 错误状态](assets/design-11-errors.png)
![12 模型仓库](assets/design-12-models.png)
![13 模型详情](assets/design-13-model-detail.png)

## 长文与折叠规则（10）

| 对象 | 折叠阈值 | 展开方式 | 截断提示 |
|---|---|---|---|
| 正文 | 6 行 | 「展开全文（约 N 字）」 | 保留首段，不截半句 |
| 思考 | 默认折叠 | 「思考 8s · 1,240 字 展开」 | 只露第一行 |
| 工具输出 | 8 行 / 2k 字符 | 「12.4k 字符 · 展开」 | 首尾各留几行，中间省略 |
| 审批列表 | 3 项 | 「还有 N 项 · 查看全部」 | 保留目标路径 |
| 会话标题 | 1 行 | 悬浮显示全名 | 省略号 |

## 错误状态规则（11）

四层，从外到内：

1. **横幅**：影响全局的配置错误（Key 无效、端点不可达）——顶部 44px，可点「去设置」。
2. **行内**：单次输入失败（没听清）——紧贴那条消息，给"重说"。
3. **任务条**：任务失败——红点 + 「失败 · 原因」+ 「重试」。
4. **卡片**：需要解释的失败——标题 + 原因 + 三个动作（再试/换方法/看日志）。

原则：错误必须给出**下一步动作**，不能只报"出错了"。

## 权限浮窗（09）

- 语音与 GUI 同权：说「可以 / 不行」，或点三个按钮。
- 三个选项固定语义：允许一次 / 本次会话都允许（写 grants）/ 拒绝。
- 30 秒倒计时，超时默认拒绝；危险级不提供"以后都行"。
- 浮窗出现在屏幕右下，不抢焦点，与主窗时间线里的审批卡同源。

## 实现映射

| 画板 | 前端位置 |
|---|---|
| 01 / 02 / 10 / 11 | `src/renderer/App.tsx` 时间线，`components/message.tsx`、`task-strip.tsx`、`error-*` |
| 03 / 08 / 12 / 13 | `pages/settings`、`components/model-repo.tsx`、`model-editor.tsx` |
| 04 | `pages/onboarding` |
| 05 | `pages/history` |
| 06 / 09 | 独立 BrowserWindow（transparent + alwaysOnTop + click-through 区） |
| 07 | `components/queue-panel.tsx` |
