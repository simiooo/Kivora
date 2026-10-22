# Kivora 设计注记（D0）

设计令牌直接复用栗记（Nuto）Web 的「极简」语言，来源：

- `squirrel_mem_web_ui/docs/DESIGN.md`
- `squirrel_mem_web_ui/src/styles.css`（`White & Acorn` 一节）

复用的部分：

| 维度 | 取值 | 来源 |
|---|---|---|
| 中性色 | `#262522` 墨 / `#ffffff` 底 / `#f4f3f0` muted / `#eae8e3` 分隔 | Nuto light |
| 深色底 | `#151615` 底 / `#20221f` 卡片 / `#f2f1ec` 墨 | Nuto dark |
| 强调色 | acorn `#76543e`（浅）/ `#d9b79a`（深），只表示"此刻" | Nuto |
| 语义色 | positive `#38654e`、destructive `#ae3e35` | Nuto |
| 圆角 | 8 / 12 / 18 / 22 / 32（SquirrelShape） | Nuto |
| 阴影 | 只有浮层有阴影（`shadow-float` / `shadow-dialog`） | Nuto |
| 字体 | 系统字体栈，不下载 web font；中文走 PingFang / 微软雅黑 | Nuto |
| 排版 | 严格左对齐；正文 15px / 行高 28px；标签 12px | Nuto |

Kivora 自己的差异（桌面常驻工具）：

- 默认深色（Nuto Web 默认浅色）。
- acorn 在这里表示"正在听 / 正在做"，状态点是它的唯一载体。
- 消息不做卡片、不加边框，只靠留白与时间戳分层 —— 沿用 Nuto"内容不着色"的规则。

待定（等 OpenPencil 设计稿）：

- 时间线是否保持单列 760px，还是贴合窗口宽度。
- 任务条（会话卡）的形状与折叠方式。
- 审批卡的位置：置顶粘性 vs 行内。
- 浅色模式是否作为默认。
- shadcn/ui 组件的具体用法（当前只有手写的两个基础件，待设计稿定稿后统一替换）。
