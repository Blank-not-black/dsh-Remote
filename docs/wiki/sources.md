# 源码、契约与验证依据

[首页](README.md)

下表是本库结论的本地检索入口。源码仓库中按这些相对路径阅读；插件安装包中网关名为 `gateway.cjs`，不携带整个测试目录。找不到文件时标注缺失，不搜索用户无关目录。

| 范围 | 实现位置 | 主要回归/专题 |
| --- | --- | --- |
| 网关 health、鉴权、文件、WS、supervisor | `gateway.js`；包内 `gateway.cjs` | `tests/gateway.test.js`、`tests/crash-recovery.test.js`、`tests/supervisor-endpoint.test.js` |
| 插件启动、端口、上游 Cookie | `packages/plugin/index.mjs` | `tests/plugin-autostart.test.js`、`tests/restart-connectivity.test.js`、`docs/configuration.md` |
| 会话迁移和按需订阅 | `gateway.js` 的 `translateModernRpc`、`handleModernStreamFailure`、现代 collector | `tests/dsh-021-compat.test.js`、`tests/session-observation.test.js`、`tests/session-observation-installed.test.js` |
| 历史、错误归属、发送回执 | `public/history.js`、`public/app.js`、`public/desktop/desktop.js`、`public/operations.js` | `tests/history-ui.test.js`、`tests/history-load-recovery.test.js`、`tests/receipt-errors.test.js` |
| 插件清单与事务 | `packages/plugin/plugin-center.mjs`、`plugin-transaction.mjs`、`market.mjs`，`public/plugin-center.js` | `tests/plugin-center.test.js`、`tests/plugin-center-ui.test.js`、`tests/plugin-transaction.test.js`、`docs/plugin-center.md` |
| 文件与上传 | `gateway.js`、`public/app.js`、`public/chat-files.js` | `tests/windows-files.test.js`、`tests/windows-gateway.test.js`、`tests/upload-ui.test.js` |
| 模型、权限、审批、子代理 | `public/permission-presets.js`、`approval-records.js`、`subagents.js`，网关协议适配 | `tests/permission-presets-ui.test.js`、`tests/approval-records-ui.test.js`、`docs/subagent-viewing.md` |
| Android 后台与峰谷 | `android/app/src/main/java/com/dshremote/app/`，`packages/plugin/peak-reminders.mjs` | `tests/android-background.test.js`、`tests/peak-reminders.test.js`、`docs/peak-reminders-and-issue18.md` |
| 诊断入口与本地日志 | `public/doctor.js`、`diagnostics.js`，`packages/plugin/doctor-target.mjs`、`doctor-skill.mjs` | `tests/doctor.test.js`、`tests/doctor-entry.test.js`、`tests/client-diagnostics.test.js` |
| 版本、构建与分发 | `scripts/android-version.mjs`、`scripts/release.mjs`、`scripts/sync-plugin.mjs` | `tests/android-version.test.js`、`tests/release.test.js`、`docs/release.md` |

## 如何判断证据强度

1. 文档说明设计与操作方法；源码说明该快照的实现；测试说明具体断言通过。
2. 真实 DSH 联调需确认安装版本、隔离环境和覆盖路径，不能套用到所有 DSH 版本。
3. 运行实例、真实渲染与原设备操作才能证明对应用户路径；构建成功或模拟数据截图不能替代。
4. 分发还需核对 GitHub 资产、精确 npm 版本/tag/tarball 与实际安装；Gitee 单独核验。

本库未声称包含个人配置或完整故障样本。历史证据在仓库 `docs/archive/` 及各 RC 报告中保留原日期，不能当作实时状态。
