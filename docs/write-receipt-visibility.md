# 写回执在连接切换后的可见性修复

2026-11-09。依据：云端反馈收集器第 188/189 条（Android 0.8.6、公网中转、Windows 主机），以及对照 `v0.8.6` 源码的只读复核。本轮未发布、未部署、未在真机复测。

## 现象

发送消息后按钮长时间停在「提交中…」，最终以 `category=unknown` 结束，但界面没有任何成功、失败或未确认提示。诊断显示该次 `session.prompt` 等待了约 44.5 秒（`public/operations.js` 的持久回执路径），期间有 WebSocket 1006 断连与轮询降级，用户还尝试过切换公网入口。

## 确认的客户端缺陷

1. `safeRpc` 在连接身份（`state.server`/`state.token`）变化后直接 `return null`；即使错误是写入结果未确认（`operationPending`），也不提示。队列发送与插队发送都经过这条路径。
2. `DshOperations.pending()` 只返回当前连接的回执。切换连接后，旧连接下未确认的回执从“有操作结果待确认”横幅和回执面板中消失；回执仍留在 `localStorage`，但用户看不到。
3. 未确认结果原本只有 3.2 秒 toast 与首页横幅两个入口；身份切换后横幅被过滤、toast 被丢弃，二者同时失效。

`mux`/`host` 的 1006 重连本身不会改变 `connectionGeneration`（只在 `state.server`/`state.token` 赋值时变化），因此单纯断线重连不是静默丢弃的原因；一次身份切换（手动切入口、自动选最快入口或重新配对）才会触发。

## 修复

- `public/operations.js`：回执行记录连接来源（仅 origin，不含令牌）；`pending()` 跨连接保留 unknown 回执并标注“来自其他连接”；`check()` 对非当前连接返回空；`dismiss()` 在用户确认后可以结束跨连接回执跟踪。
- `public/app.js`：`safeRpc` 先处理 `operationPending`，身份切换后仍提示原连接与“结果未确认”；排队发送新增 `sendPrompt()`，同一连接下把未确认状态写入输入框上方的持久状态条（`#composer-send-status`），不再只靠 3.2 秒 toast；插队路径在上下文或连接变化时补 toast。
- `public/desktop/desktop.js`：镜像 `safeRpc` 行为，新增 `ds.sendUnconfirmedSwitched` 文案。
- `public/workflow.js`：回执面板对跨连接回执标注 origin、隐藏“查询结果”、保留“核对后结束跟踪”。
- `public/index.html`、`public/desktop/desktop.html`：新增中英文案。

## 行为边界

- 不自动重发；未确认回执仍只通过只读查询核对。
- 跨连接回执不能查询，因为回执范围按“上游地址 + 令牌”隔离；切回原连接后可查询。
- 结束跟踪仍需要用户确认；之后相同操作会成为新请求，可能重复已执行的动作。
- 旧网关、没有 `operations` 能力的主机保持原行为。
- 本修复不改变网关、DSH、模型或中转协议。

## 验证

| 检查 | 结果 |
| --- | --- |
| `node --test tests/composer-steer.test.js` | 8 通过 |
| receipt 定向用例（身份切换、跨连接回执） | 5 通过 |
| workflow-reliability 回执用例 | 3 通过 |
| `npm run check`（当前工作区，0.8.3 分支） | 1218 项：1198 通过、20 跳过、0 失败 |
| `npm run check`（dev `779c94b` + 本补丁 + 同步生成物） | 1262 项：1242 通过、20 跳过、0 失败 |

## 文件

产品代码：`public/operations.js`、`public/app.js`、`public/desktop/desktop.js`、`public/workflow.js`、`public/index.html`、`public/desktop/desktop.html`。
测试：`tests/receipt-errors.test.js`、`tests/composer-steer.test.js`。文档：本文、`docs/wiki/connection.md`、`docs/usage.md`。
