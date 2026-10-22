# Kivora 设计稿 v1

八块画板，1280×800（04 为 980×540，06/07 为小尺寸浮层）。源文件 `docs/assets/kivora-design-v1.fig`，改稿在 OpenPencil 里改，重新导出即可。

| # | 画板 | 说明 |
|---|---|---|
| 01 | 主时间线 | 默认态：消息、审批卡、任务条、输入区 |
| 02 | 运行中 | 旁白「我去搜」、任务条展开成过程日志、麦克风变 acorn |
| 03 | 设置抽屉 | 380 宽，热键 / 四段端点预览 / mock 开关 |
| 04 | Onboarding | 三步中的第 2 步：麦克风与热键，含试音条 |
| 05 | 会话历史 | 左列表右详情：事件流 + 对话摘要 + 操作 |
| 06 | 桌面悬浮 | 常驻胶囊 + 最近上下文卡（前台窗口 / 选中 / 上次任务） |
| 07 | 未处理队列 | 插话 / 排队 / 执行中三种状态，可提前或取消 |
| 08 | 设置页面 | 左侧导航 + 四段端点卡片 + 测试/保存 |

![01 主时间线](assets/design-01-timeline.png)
![02 运行中](assets/design-02-running.png)
![03 设置抽屉](assets/design-03-settings.png)
![04 Onboarding](assets/design-04-onboarding.png)
![05 会话历史](assets/design-05-history.png)
![06 桌面悬浮](assets/design-06-overlay.png)
![07 未处理队列](assets/design-07-queue.png)
![08 设置页面](assets/design-08-settings.png)

## 视觉规则（摘自 DESIGN-NOTES.md）

- 底色 `#151615`，卡片 `#20221F`，下沉面 `#191B18`，控件 `#292C28`。
- 墨 `#F2F1EC`，次级 `#BDBBB3`，弱 `#9A978F`，更弱 `#6F6B64`。
- acorn `#D9B79A` 只表示"正在听 / 正在做"；成功 `#A6C9B4`；危险 `#FFA69C`。
- 圆角 8 / 10 / 12 / 14 / 18 / 22；只有浮层有阴影。
- 内容列 760，严格左对齐；消息不做气泡、不加边框。

## 实现映射

| 画板 | 前端位置 |
|---|---|
| 01 / 02 | `src/renderer/App.tsx` 时间线 + `components/task-strip.tsx`（待建） |
| 03 / 08 | `components/settings-sheet.tsx`、`pages/settings`（待建） |
| 04 | `pages/onboarding`（待建） |
| 05 | `pages/history`（待建） |
| 06 | 独立 BrowserWindow（透明、置顶、点击透传） |
| 07 | `components/queue-panel.tsx`（待建） |
