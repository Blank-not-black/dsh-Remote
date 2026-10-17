# 0.8.0-rc.3 用户反馈修复与本地实装

2026-10-17，针对 Android 0.8.0-rc.2 试测反馈。中途用户要求版本号须经明确同意，版本清单与分发 APK 曾回到 `0.8.0-rc.2`；同日晚用户要求「峰谷提醒以后走 dsh-cost-meter 插件，然后构建 rc.3 版本本地实装」，版本号随后授权更新为 `0.8.0-rc.3`，已完成构建与本机实装，见[本机实装](#本机实装)。`dist/rc-0.8.0-rc.3/`、`dist/rc-0.8.0-rc.4/` 是带 `WITHDRAWN.txt` 的历史候选，不代表当前交付；当前子代理独立页面说明见[子代理查看](subagent-viewing.md)。

| 反馈 | 处理与验证边界 |
| --- | --- |
| 输入区偏高 | 手机单行输入最小高度从 58px 降至 40px，保留多行扩展和全屏编辑。 |
| 最新公告消失 | 保留新界面未读公告弹窗修复，已有弹窗、已读记录和版本提醒优先级均有回归覆盖。 |
| 管理控制台 404 | 网关同时接受 `/admin`、`/admin/` 和 `/admin.html`；隔离 HTTP 测试读取页面、脚本和样式。手机管理入口同时沿用插件前缀处理。 |
| 操作确认不显示审批 | 入口改为「审批与操作回执」，共用实时待办列表；允许、拒绝和提问继续走原控制器。提问打开前关闭回执对话框，避免遮挡。 |
| 设置二级菜单返回退出 | Android 返回键先处理全屏输入、选择器、抽屉和对话框，再返回设置上一级或首页。原生回调通过隔离测试执行，仍需 Android 真机手势验收。 |
| 无法打开子代理 | 手机和桌面子代理名称可点击，保留父会话信息，列表刷新未包含子代理时仍能返回父会话；子代理不参与空会话自动归档。 |
| 无法读取中转状态 | 使用管理中转端点并兼容手机插件前缀，未连接时不读取；按网络模式延长读取等待。区分令牌、版本、响应格式、超时和连接失败；失败读取退避，保留此前成功状态。尚无该用户失败时的响应或日志，不能据此断言其具体网络原因。 |
| 200 MB 大文件慢 | 已定位试测中转每路 100 KiB/s 文件限速，200 MB 理论约 33～34 分钟。当前没有调整云端限速或部署；产品说明补充该限制和直连选择。 |

测试仅使用临时 HOME/USERPROFILE/文件根、固定测试令牌和模拟上游，不接触真实用户目录或模型。浏览器验证也使用隔离模拟主机，不能代替真实中转、DSH 子代理协议或 Android 实机验收。

## 峰谷提醒改由 dsh-cost-meter 管理

- 能力核对：本机 `dsh-cost-meter 1.8.17` 已提供峰谷提醒，可配置提前量、提醒类型、弹窗位置与系统通知；提醒由 DSH 页面触发，没有手机离线后台提醒。
- Remote 侧：设置页移除独立开关，改为指向插件的说明（根 `public/index.html`，同步副本在 `packages/plugin/public/`）；删除前台计时与调度，`restorePeakReminders()` 只删除旧开关 `peakRemind`、取消旧通知计划 8801–8804 并停止旧前台服务（`public/app.js`）。
- Android 侧：`MainActivity.onCreate` 启动即停止旧服务；`startPeakReminder()` 保留为旧缓存页面的兼容空实现（返回 `false`）；`PeakReminderService` 改为立即 `stopSelf()` 的墓碑类，`onStartCommand` 返回 `START_NOT_STICKY`，避免升级后系统重启旧服务继续计时。
- 不自动修改插件的提醒偏好；鸿蒙客户端仍使用自己的代理提醒，未纳入本次迁移（它不经过 DSH 页面）。
- 回归：`tests/mobile-select-peak-reminder.test.js` 断言设置页没有旧开关、源码不再调度、迁移函数删除旧键并取消旧通知，并覆盖有无原生桥接两种情况。

## 验证与产物

- `npm run check`：**571 项，563 通过、8 跳过、0 失败**；`git diff --check` 通过（Git 的 CRLF 提示不算失败）。
- APK `apk/dsh-remote.apk`：SHA-256 `1b2608f2df920f68fea4995157390c057b75d3f63a8b4f64b7dcbde569f6adee`；`aapt dump badging` 显示 `versionName=0.8.0.rc.3`、`versionCode=8003`。APK 内 `assets/public/app.js` 与 `assets/public/index.html` 和仓库根 `public/` 逐字节一致，确认构建包含迁移后的前端。
- `public/update.json` 的 `sha256` 与 APK 一致；`package.json`、`package-lock.json`、`packages/plugin/package.json`、`public/version.json` 均为 `0.8.0-rc.3`。
- 产物目录 `dist/rc3-2026-10-17/`：`dsh-remote-plugin-0.8.0-rc.3.tgz`（SHA-256 `9cc06aac50c998cd8d472de777e2423e3cc63b1219d25d6e8bf20ac1189d5116`）、`build-app-final.log`、`check-final.log`、`publish.log`、`install.cjs`、`verify-live.cjs`、`before.json`、`installed.json`、`live-verification.json`。
- 历史候选（18:06 前构建并撤回）：`npm run check` 545 项、537 通过、8 跳过；APK SHA-256 `51bd616a04c9b270bc9dcb3e5f2a9fcacacc81b7b1f79eb290f6eafe20fd7fdd`，TGZ `42f3ad99105607dd54031814b49986da337509054a8c8bec088fa644fca7d4a8`；产物在 `dist/rc-0.8.0-rc.3/`、`dist/rc-0.8.0-rc.4/`，带 `WITHDRAWN.txt`。

## 本机实装

- 备份：活动 profile `C:\Users\blank\.dsh\profiles\desktop` 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml` 和已装插件复制到 `dist/rc3-2026-10-17/backup/`，原插件版本与哈希写入 `before.json`（原插件版本 `0.8.0-rc.2`）。
- 安装：先停止已核验归属的 DSH Desktop 进程，再 `pnpm remove` + `pnpm add file:D:/dsh-remote/dist/rc3-2026-10-17/dsh-remote-plugin-0.8.0-rc.3.tgz`，随后重启 Desktop。`installed.json` 记录已装 72 个文件与插件包逐字节一致，其余依赖与配置未变。
- 在线复核（`live-verification.json`，2026-10-17 18:36 重新执行）：健康接口 `version=0.8.0-rc.3`，上游 `upstreamOk=true`，mux/host 双通道已连接；12 个前端资源与仓库逐字节一致，gzip 与 ETag 304 正常；下发 APK 哈希与应用一致；`dsh-cost-meter 1.8.17` 已启用并处于 `active`；云端中转恢复 `online` 并上报 `0.8.0-rc.3`。
- 未提交、未推送、未对外发布；没有连接 Android 设备，APK 未装到手机，通知与返回手势仍待真机验收。

## 改动文件清单

- 网关：`gateway.js`，同步副本 `packages/plugin/gateway.cjs`。
- 前端：`public/app.js`、`public/index.html`、`public/desktop/desktop.js`、`public/desktop/desktop.html`、`public/workflow.js`、`public/workflow.css`、`public/history.js`、`public/network.js`、`public/extensions.js`、`public/relay-settings.js`、`public/announcements.json`、`public/update.json`、`public/version.json`，以及新增的 `public/activity.js`、`public/subagents.js`、`public/subagents.css`。
- Android：`android/app/src/main/java/com/dshremote/app/MainActivity.java`、同目录 `PeakReminderService.java`。
- 版本：`package.json`、`package-lock.json`、`packages/plugin/package.json`。
- 测试：`tests/mobile-select-peak-reminder.test.js`、`tests/tester-feedback-ui.test.js`、`tests/relay-settings.test.js`、`tests/user-flows.test.js`、`tests/connection-isolation.test.js`、`tests/announcement-poll-ui.test.js`、`tests/apk-progress.test.js`、`tests/subagents-ui.test.js`、`tests/activity-ui.test.js`、`tests/dsh-021-compat.test.js` 等。
- 文档：`docs/usage.md`、`docs/modules/07-android-app.md`、`docs/subagent-viewing.md`、`docs/dsh-0.2.1-adaptation.md`、`AGENTS.md`、本文件。
- 插件同步：上述前端、公告、版本、更新清单、`gateway.cjs` 与 `packages/plugin/apk/dsh-remote.apk` 均由 `npm run sync-plugin` 生成。
