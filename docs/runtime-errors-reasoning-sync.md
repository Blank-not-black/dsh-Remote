# Remote 运行错误、思考过程与会话补同步核查

核查日期：2026-10-20。依据：用户反馈、当前源码、本机 DSH 0.2.1-rc.1 协议定义与隔离实例。没有调用模型、修改真实 profile、部署或发布。

## 已确认的缺口与修复

- DSH 的供应商失败可记录为 `turn/end.data.reason = { kind: 'error', error: { message, code, status } }`。Remote 原先隐藏所有回合结束标记，且桌面 Remote 未处理 `host/agent-error`。现在持久历史显示失败原因与提供的错误码/HTTP 状态；只有主机事件的错误也会按会话保留到下一次运行，切换连接时清空。错误与已存在的用量操作栏可以同时显示，成功回合仍不增加状态行。
- DSH 的失败尝试会把已输出的思考记录在 `assistant/attempt.data.stream`。Remote 原先清除实时思考后过滤掉整个尝试。现在恢复压缩 `reasoning-chunks` 与原始 reasoning 分片，保留可展开的思考及该次请求的错误，不把失败尝试伪造成成功回复。
- 自动弱网模式及“弱网精简”设置会隐藏实时思考。此设置保留，现在有明确的隐藏原因提示；已完成历史中的思考不受该设置影响。供应商没有提供思考时不生成内容。
- 原先回前台/定时修复侧重 WebSocket 是否 OPEN；仍然连接但漏收回复时，缺少历史核对。现在当前会话的活动、停止、回合结束、回前台可触发补拉，并在前台每 15 秒检查是否需要核对历史。活动信号合并并限制频率；历史正在读取时延后重试，避免丢掉补同步信号。切换会话、历史对象、服务器或令牌后，旧任务失效。保留原有阅读位置和展开状态逻辑。

这些是可复现的缺口，不能据此断言所有历史反馈均由同一个原因导致。手机真机与用户原始供应商超时尚未复现。

## 本次改动文件

- `public/activity.js`：共享错误格式化、失败尝试思考恢复、弱网隐藏说明。
- `public/app.js`、`public/desktop/desktop.js`：错误处理、历史展示、补同步调度。
- `public/workflow.css`：共享错误卡片样式。
- `tests/session-runtime-ui.test.js`：错误展示、思考恢复、信号合并、连接/会话隔离、前台核对。
- `tests/history-load-recovery.test.js`：正在翻页时收到完成信号，随后补拉最新回复，无须退出重进。
- `tests/stream-weak.test.js`：保留弱网精简并显示说明。
- `tests/installed-dsh.test.js`：隔离 DSH 中构造持久失败/思考记录，经真实 Remote 历史接口核验，不调用模型。
- `public/build.json`，以及以上四份前端资源和 build.json 对应的 `packages/plugin/public/` 副本：由 `npm run sync-plugin` 生成，逐份内容一致性核验通过。

## 验证与边界

- 相关七组测试：76 项通过。
- 浏览器样例：错误码/HTTP 状态、可展开思考、弱网说明正常显示。样例用于渲染核查，不代表手机实装验收。
- 隔离的真实 DSH 0.2.1-rc.1：失败回合、失败尝试思考经 Remote API 的相关断言通过；该集成测试末尾因当前 `update.json` 缺少 APK SHA256 字段而失败，不能称整项通过。
- 最终 `npm run check`：761 项中 745 通过、2 失败、14 跳过。两项失败均为前一轮已存在的 `tests/crash-recovery.test.js` legacy supervisor 测试，报 `SUPERVISOR_IDENTITY_UNAVAILABLE`，不属于本次前端改动范围。
- `git diff --check` 通过；没有提交、部署或构建新的安装包。

后续本地 rc.6 构建与部署见 [rc.6 记录](rc-0.8.0-rc.6.md)：允许 Windows 进程身份查询后全量门禁为 747 通过、14 跳过、0 失败；重新构建生成 APK 哈希后，真实 DSH 隔离集成测试也通过。以上较早的未部署/失败描述保留为当时核查快照。
