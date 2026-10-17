# 工具与思考折叠分组（2026-10-17）

版本保持 `0.8.0-rc.3`；本轮只改对话渲染，未改网关。改动未提交，补丁包按同版本重新构建。

## 问题

手机端每条工具调用、每段思考都占一行（最小 44px + 间距）。真实会话里一个回合可能有几十次调用和几十段思考，两条消息之间能拉到上千像素；`showTools` 只能整体隐藏工具行，不能按回合折叠。DSH 0.2.1 还会在 assistant 消息内容里重复携带 `tool-call` 块，这些内联行同样占高度。

## 改动

- `public/activity.js` 重写 `group()`：
  - 以**人类用户消息**为回合边界（系统注入的 user 事件不算）；
  - 把该回合的独立 `tool/call|tool/result` 条目、assistant 消息内的 `reasoning|thinking` 块合并成一个派生条目，消息只保留正文；
  - 只有推理、没有正文的消息在提取后被丢弃；单条且无推理的回合保持原样；输入数组不改写，缓存/导出仍是原始事件。
- 两端渲染（`public/app.js`、`public/desktop/desktop.js`）：
  - 新增 `activityGroupHtml()`，输出默认收起的 `<details class="chat-activity-group">`，摘要 `工具与思考 · N 项`；运行中显示「运行中」，任一条错误时摘要用警告色；展开后工具行与思考行都按原样呈现，`data-activity-key` 保留展开状态；
  - 运行态取自会话当前回合（`session.running`），且只作用于最后一个分组：不再用「有未配对的工具调用」推断，避免中断或结果缺失把已结束回合永久标成运行中，也避免模型在两次工具之间思考时指示忽隐忽现。
  - 当历史里存在独立的 `tool/call` 事件时，消息里重复的 `tool-call` 块不再渲染（`suppressBlockTools`），避免同一调用出现两次；只有内联块的老版本仍按原样显示；
  - 空消息（只剩被折叠内容）返回空字符串。
- `public/history.js`：`render()` 跳过空 HTML 的条目，避免被折叠的消息留下空白间距。
- `public/workflow.css`：
  - 分组不使用卡片边框和底色，靠 10px 缩进表示归属；摘要行 36px、chevron，hover 才出现浅底；
  - 运行光效：6px 圆点加 8px 光晕 + 扩散环动画（`activity-ring`），运行中只提亮摘要文字与光点，不加边框或色块；`prefers-reduced-motion` 下关闭动画；
  - 保持简洁，没有新增布局或额外图标。
  - 运行光效：6px 圆点加 7px 光晕 + 扩散环动画（`activity-ring`），运行中的分组整行浅色高亮并加强调色描边；`prefers-reduced-motion` 下关闭动画；
  - 保持简洁，没有新增布局或额外图标。

## 验证

- `npm run check`：**598 项，590 通过、8 跳过、0 失败**。
  - `tests/activity-ui.test.js`：回合内工具合并、消息内推理提取（正文保留、源事件不变）、纯推理消息丢弃、用户消息开启新回合。
  - `tests/activity-group-ui.test.js`：两端调用 `group()`、`is-running`、重复内联工具块抑制、空条目跳过、中英文案与光效 CSS。
  - `tests/history-ui.test.js` 35 项通过，滚动、分页、展开状态与缓存行为未回退。
- 真实会话只读核对（本机网关 + 当前会话）：

| 指标 | 结果 |
| --- | --- |
| 折叠分组 | 2 个（46 项、89 项） |
| 独立过程行 | 0（原先 200+ 行） |
| 渲染条目 | 3（用户消息 + 两个分组） |
| 展开 | 默认收起，摘要显示「工具与思考 · N 项」与「运行中」 |

截图：`dist/stream-2026-10-17/live-group.png`（真实会话）、`mobile-group-collapsed.png`、`mobile-group-open.png`（隔离夹具）。

边界：折叠只影响显示，缓存、导出和事件本身不变；展开状态按分组首条 seq 记忆；非常旧的 DSH 若只有内联工具块、没有独立事件，仍按原来的内联行显示；未在真机验收动画帧率。

## 文件

- `public/activity.js`、`public/app.js`、`public/desktop/desktop.js`、`public/history.js`、`public/workflow.css`、`public/index.html`、`public/desktop/desktop.html`。
- `tests/activity-ui.test.js`、`tests/activity-group-ui.test.js`、`docs/usage.md`、本文件。
- 插件副本由 `npm run sync-plugin` 生成；APK 与 `update.json` 按同版本补丁重新构建。
