# 收据与新建对话错误提示修复

2026-10-22。工作区源码与本地验证 APK 已完成；未实装、未提交、未推送或发布。

## 新建对话时出现 Auto 恢复错误

用户截图原文为 `resume failed for session ...: Error: permission: cannot restore preset "auto" without its active integration`。核对实际安装的 DSH 0.2.1-rc.2 源码，这来自权限服务恢复已有 `permission/preset=auto` 记录时找不到其当前有效集成，随后被会话控制器包装成 resume failed。它不是 `session.create` 的参数校验错误。

在临时 HOME/DSH_HOME 中创建一条仅含 Auto 权限事实的冷会话，未加载 Auto 集成。真实 DSH 的显式恢复精确复现了截图错误；另一个新会话仍能成功创建和读取历史，没有模型调用。

同时复现出 Remote 的两处问题：

- 已发布 rc.8 网关会主动观察冷会话，导致仅启动或刷新目录也尝试获取其写句柄、恢复 Agent。用原发布标签的网关执行同一隔离用例，观察到 1 次冷会话写打开，触发回归断言。当前工作区已有的 #21 修复将订阅限制为已激活会话及当前有效兴趣，220 个冷会话的启动和历史读取均为 0 次写打开。
- 手机与桌面 `onHostFrame` 对所有会话的 `host/agent-error` 都弹 toast。实际向旧会话注入截图同类错误时，当前新会话也会提示失败。现改为保留每个会话的错误状态和历史，只为当前会话弹提示。当前会话真正发生错误时仍显示，回归与页面操作均已验证。

用户截图中的完整会话 ID 不在本机 Windows 的目录里，尚未取得截图所在主机的事件记录，因此不能据此证明那条错误一定来自另一个旧会话。本次修复针对已复现的冷会话恢复和错误归属链路。Auto 权限及审批配置保持原样；如果用户主动恢复的会话确实缺少 Auto 集成，DSH 的恢复错误仍应保留，并需在该主机恢复相应集成。

## 发送收据与诊断

针对线上第 105 条反馈，修复最初[诊断报告](receipt-result-unconfirmed-diagnosis.md)确认的问题：

- DSH 明确拒绝图片后，视觉准备失败返回 `rejected / image-vision-failed`，提供缺失插件、未启用或通用图片处理提示。再次提交转换后的消息时发生网络异常或 5xx，继续保持 unknown，避免把可能已执行的写入当作明确失败。
- 未知收据记录白名单诊断：失败阶段、HTTP 状态（可获得时）、网络/超时/上游 HTTP/响应结构等类别及耗时。数据随收据落盘、鉴权返回，也写入兼容诊断和 `[operation]` 日志。没有保存请求正文、图片、任意上游错误原文、token、Cookie 或路径。
- 响应缺少布尔型 `result.ok` 时判为未知，不能伪装成明确拒绝。常见明确拒绝通过固定错误码映射给出可操作说明。
- 手机和桌面识别 `operationPending`，不再给未知结果追加“发送失败”前缀；提示操作可能已生效，应先核对会话。草稿与既有收据机制保留，重试相同意图仍只查询收据。

原反馈的具体上游触发原因尚未唯一确认；旧版未保存的错误无法事后补回。新增诊断便于在下一次发生时区分原因，不能据此宣称其他主机的偶发上游异常已经消失。

## 验证

| 检查 | 结果 |
| --- | --- |
| 最终 `npm run check` | 903 项：885 通过、18 跳过、0 失败 |
| 收据、视觉桥、错误归属及既有写操作专项 | 54 通过、0 失败 |
| 显式启用的真实 DSH rc.2 联调 | 2 通过；含 220 个冷会话、Auto 精确错误及独立新会话成功 |
| 原发布 rc.8 对照 | 冷会话写打开数 1，预期失败；作为修复前证据单独保留 |
| 真网关收据持久化和重启 | 两类失败均保留诊断；重复 POST、进程重启后再次 POST 也不重复转发上游 |
| 手机网页 | 新建对话成功；旧会话错误不串入，当前错误仍保留；未知发送保留草稿，再次点击后上游 prompt 调用仍为 1 |
| Android 构建 | BUILD SUCCESSFUL；10 个关键前端资源与当前源码哈希一致 |
| 同步与差异 | 网关、手机、桌面与 operations 的插件副本同步；`git diff --check` 通过 |

浏览器联调用合成上游与隔离网关；真实 DSH 联调用临时 profile。没有改真实用户的权限、会话或插件配置，没有向原反馈者的消息重试。Android 真机和 Linux 实机未在本轮重测。

## 本轮文件与产物

产品代码：`gateway.js`、`public/app.js`、`public/desktop/desktop.js`、`public/operations.js`。此前未提交的 #21 冷会话观察修复保留，并用 Auto 夹具补强了真实回归。

测试：新增 `tests/receipt-errors.test.js`；更新 `tests/vision-bridge.test.js`、`tests/session-runtime-ui.test.js`、`tests/session-observation-installed.test.js`、`tests/fixtures/realistic-stack.cjs`。文档：本文、原诊断报告的后续状态、`docs/modules/10-tests-qa.md`。`npm run sync-plugin` 生成对应插件副本和 build.json；既有其他改动保留。

验证包：`dist/receipt-and-session-fix-2026-10-21/dsh-remote-0.8.0-rc.8-receipt-session-validation.apk`。

SHA-256：`1589812fb9475745978d991bb2f019e7248aef6d6b75558ef0b8eaa948e24a41`。

该包保持本地 rc.8 验证版本，未替换公开 `update.json` 或原分发 APK，也未安装到当前用户主机。原始日志、APK 包内资源核对、浏览器截图均在同一 dist 目录。`before.log`、`session-error-before.log` 和 `published-rc8-auto-before.log` 是预期失败的修复前证据；最终门禁日志为 `check-final.log`、`targeted-final.log`、`installed-dsh-final.log`。
