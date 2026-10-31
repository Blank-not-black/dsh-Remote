# DSH 兼容性与验证边界

[文档首页](README.md) · [协议契约](modules/01-contracts.md)

## 适配策略

Remote 按探测到的接口与 `/health` 能力选择路径，不仅凭 DSH 版本字符串分支。版本标签用于说明已知适配场景，不能据此承诺某个未来版本或全部功能兼容。

| 上游形态 | 当前适配 |
| --- | --- |
| 旧 dot RPC 与 `events.mux/host` | 保留代理和双采集流路径 |
| generated slash RPC 与 `remote.mux` | 转换已知 RPC envelope，拆回客户端 mux/host 契约，读取主机 Cookie |
| DSH 0.1.5 历史/事件 | cursorless 思考快照、重试/结束、通用附件显示、V3 历史与统计游标 |
| DSH 0.2 队列/任务变更 | 归档回执、Inbox queue、job roster、持久投影中的子代理兼容路径 |

未知/失败的 flavor 探测保留 `unknown` 并重试；不能因为登录 Cookie 尚未就绪就永久认定 legacy。新接口失败只对已有、明确的适配表尝试回退，不发明 RPC。

客户端实时连接是下行流，应用层不发心跳；网关使用 RFC6455 Ping/Pong。`/health` 可响应不等于上游已认证或 mux/host 就绪。

## 回归与真实 DSH

`tests/dsh-015-compat.test.js`、`dsh-020-compat.test.js` 等包含本地回归。V3 Zstandard 断言依赖运行时原生 zstd，缺少时会跳过；Node 版本和上游格式能力需同时核对。

真实安装版测试需显式设置 `DSH_TEST_CLI_ROOT`，会在临时 HOME/profile 启动实际 DSH，再经 Remote 网关验证。费用插件测试另需 `DSH_TEST_INSIGHTS_ROOT`；Desktop 管理测试需同一安装的 `DSH_TEST_DESKTOP_EXE/DSH_TEST_DESKTOP_CLI`。没有设置时的跳过不算真实 DSH 已验收。

`.github/workflows/compat.yml` 使用 npm 当前发布的 Remote 与最新 DSH 做安装/挂载检查，覆盖 `/remote/version.json` 可访问；它不等于当前 checkout、全部 RPC、付费模型对话或所有客户端已通过。

## 能力与平台限制

- 网关 `protocol.version` 当前为 1；各 capability 使用独立数值，`dshLifecycle` 按实际服务/启动配置动态计算。
- 旧网关没有 capability 字段时走兼容路径；新字段缺失不能直接拒绝所有连接。
- 独立设备密钥只授权明确控制路由；主机 DSH Cookie 与客户端 Remote token 分属不同认证边界。
- Windows Desktop 生命周期控制是实验能力，需要完整实例证据；服务不存在与服务权限错误不能混为一谈。
- Android 背景、安装与相机依赖系统权限和厂商限制；HarmonyOS 侧载提醒/长时任务及四套主题独立于 WebUI。
- 图像输入依赖模型与 DSH 路由；`dsh-ui` 是[只读子集](dsh-ui-support.md)，不是完整上游插件浏览器运行时。

## 历史证据

[2026-11-01 三端与兼容性检查](maintenance-2026-11-01.md)记录本轮真实环境、已发布插件包隔离验证和 Linux 限制。任务看板 schema 7 与团队原生路由缺失诊断属于本轮开发变更，尚未发布；当前线上版本不能据此宣称已具备。

[DSH 0.1.5 适配报告](dsh-0.1.5-compatibility.md)和[历史索引](archive/README.md)保留当时的版本、测试、构建与实装结果。此前文档核对仅涉及源码；新的 profile、发布包和 Linux 结果以各次独立验收记录为准，Android/HarmonyOS 真机状态没有由旧报告自动确认。
