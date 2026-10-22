# rc.8 Android“发送失败 / 结果未确认”诊断

后续：2026-10-22 已实现收据分类、脱敏诊断及前端提示修复；与新建对话错误提示一并验证，见 [修复与验证记录](receipt-and-session-error-fixes.md)。以下保留最初诊断时的证据和边界。

2026-10-21。针对线上第 105 条反馈（北京时间 22:54:56）。本轮仅诊断和隔离复现，没有修改产品源码、重启真实主机、重发原消息、提交或部署。

## 结论与证据边界

确认存在收据诊断信息丢失、视觉桥准备失败误判为未知、前端把未知结果统一加“发送失败”前缀三个问题。反馈现场究竟触发哪一条路径，目前无法唯一判断；其所在主机属于其他用户，未获得该机器的原始日志、操作编号和会话历史。没有将本机或此前已配对 Linux 笔记本的健康状态当作现场证据。

本机 Windows 对应时段未找到匹配收据；已配对 Linux 笔记本的运行时长、重连次数与报告不同，用户明确确认来自其他主机。没有进一步读取该笔记本的会话或凭据。

与 `v0.8.0-rc.8` 标签逐段比对：网关 `executeOperation`、modern/视觉桥收据分支、前端操作收据控制器、手机 `safeRpc` 与当前工作区完全一致。因此以下复现对应反馈版本中的实际代码路径。

## 1. 9.66 秒不能归因于前端 90 秒等待上限

反馈的服务端收据从 `2026-10-21T14:39:11.826Z` 到 `14:39:21.484Z`，耗时约 9.66 秒，已经写成 `unknown / result-unconfirmed`。

`public/operations.js:80` 在收到 `phase=unknown` 时立即抛出结果未确认错误；90 秒是等待 running 收据的另一条兜底。隔离执行实际前端控制器，POST 直接返回 unknown 时，1 毫秒内结束，未等待 90 秒，也未重发 POST。因此本次证据指向网关提前结束收据执行；无法仅靠 9.66 秒推断它经历了 HTTP 500、连接超时或视觉桥失败。

## 2. 多种上游异常被折叠成同一条无原因收据

`gateway.js:3028` 与 `3065` 将部分 5xx、缺少 result 的响应抛成 `upstream-uncertain`；`executeOperation` 的 catch（`gateway.js:6066`）丢弃错误对象，只写入 `unknown / result-unconfirmed`。`operationSnapshot` 也没有上游状态码、请求阶段或错误类别。

通过回环 HTTP 服务执行实际网关适配器及收据执行器，以下不同原因全部产生相同收据：

| 受控上游行为 | 收据结果 | 提交次数 |
| --- | --- | --- |
| HTTP 500，含错误 JSON | unknown / result-unconfirmed | 1 |
| HTTP 200，正文不是 JSON | unknown / result-unconfirmed | 1 |
| 收到请求后关闭 socket | unknown / result-unconfirmed | 1 |

这些情况可能已经产生上游写入，保持 unknown、防止自动重发的原则正确。问题在于原因被吞掉，事后无法区分。`/health` 的根路径 HTTP 200 只证明检查时可达，不证明失败的 `session/prompt` 调用成功。mux/host 的累计重连次数与事件闲置时长也不能单独建立此次发送失败的因果关系。

## 3. 视觉桥准备失败的确存在误判

受控复现使用以下前提：DSH 已明确返回 `session/attachment-invalid`，且 reason 为 `MODEL_DOES_NOT_SUPPORT_IMAGES`，表示首次图片消息未被接纳。之后分别模拟：

- 视觉插件 `/config` 返回 404；
- 视觉插件处于 disabled；
- `/attach` 返回不符合约束的引用。

三种场景都只有一次 prompt 调用，且该次已明确被拒绝，没有向 DSH 再提交转换后的消息。然而 strictReceipt 路径在 `gateway.js:3034` 直接抛错，最终写成 unknown。非 strict 路径相同条件则返回 `image-vision-failed`，差异已复现。

此处应该将“明确拒绝后的视觉准备失败”作为已拒绝，保留可读错误。若已经开始再次提交转换后的消息，之后返回 500 或 socket 丢失，则仍必须保持 unknown。复现也覆盖了这两个再次提交后异常的对照场景，分别观察到 2 次 prompt 调用，未发生额外重试。

反馈未说明失败消息是否携带图片。因此该问题是已确认的产品缺陷，还不能认定是第 105 条反馈的现场根因。

## 4. 前端措辞把“不确定”表现成“确定失败”

`public/operations.js:43` 的错误已经提示核对会话后再决定是否重发，并携带 `operationPending=true`。手机 `safeRpc`（`public/app.js:605`）不区分这个标记，统一追加“发送失败”前缀。桌面也有同类处理。

实际业务拒绝虽能成为 rejected，`operationResult` 又将不同错误的 message 统一改成“主机拒绝了操作，请核对会话和当前配置。”，只保留错误码。这也是模型、会话等明确拒绝原因难以展示的另一处信息损失；隔离的 `session/agent-busy` 对照已验证。

安全的用户提示应明确“发送结果未确认，消息可能已写入，请先核对会话”，保留草稿与只读查询回执。不能自动再次 POST，也不能把所有 unknown 改成 accepted 或 rejected。

## 建议的修复范围

1. 收据与本机诊断记录保留经过白名单限制的 method、stage、HTTP 状态、错误类别和耗时；不记录正文、图片、token、Cookie、完整 URL、用户路径或任意上游错误文本。
2. 分开视觉准备与再次提交两个阶段：明确拒绝后准备失败返回 rejected；开始再次提交后不确定的结果继续保持 unknown。
3. 手机与桌面对 `operationPending` 使用独立措辞，避免“发送失败”前缀；明确拒绝通过安全的错误码映射给出可操作说明。
4. 给 strictReceipt 的图片准备失败和再次提交失败分别补行为测试，保留单次写入、未知结果不重发的约束。

## 验证与产物

- 诊断脚本执行实际网关函数，启动零依赖回环 HTTP 假上游；10 个服务端场景与 1 个前端 unknown 场景均按预期复现。
- `node --test tests/workflow-reliability.test.js tests/vision-bridge.test.js`：24 通过、0 失败、0 跳过。
- 现有视觉桥测试调用非 strict 的适配器；现有收据测试覆盖 5xx，却未覆盖图片准备失败。这解释了该误判为何未被已有测试捕获。当前测试通过不等于上述缺陷已经修复。
- 所有模拟 prompt 均只发往本机临时端口；未调用模型。测试结束关闭回环监听并清理隔离测试资源。

原始证据保留在 `dist/receipt-diagnosis-2026-10-21/`：`reproduce.cjs`、`reproduction.log`、`reproduction-results.json`、`source-verification.json`、`existing-tests.log`。本轮仅新增本文及 dist 忽略目录中的诊断产物，未改已有源码改动。

进一步确认现场需要反馈者提供：操作编号、失败消息是否含图片，以及同一时刻的脱敏上游请求错误或可核对的会话记录。现有收据没有保存这些诊断字段，无法仅凭旧收据补回已丢失的错误原因。
