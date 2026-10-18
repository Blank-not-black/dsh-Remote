# 插件规则峰谷通知与 issue #18

本次延续公告表单、团队页与会话结果栏的未提交改动。没有安装到设备、改动正式 APK/更新清单、发布公告、提交或推送。

## Android 峰谷提醒恢复

用户明确要求：费用插件确定峰谷时间，Remote 在手机上发通知。rc.3 停用整个提醒服务不符合这一要求，现恢复 Android 接收和通知。主机 `dsh-cost-meter` 仍是规则来源，不恢复旧的固定时段。

入口为「更多 → 通知与后台 → 峰谷计费提醒」。手机本地开关与主机插件提醒开关都需开启，系统需允许通知。提醒读取 `peakWindows`（UTC 小时窗口）、`peakHolidays`（北京日期）、`peakEffectiveAt`、`peakEnabled`、`peakAlertEnabled`、`peakAlertAhead`、`peakAlertTarget`。不会修改费用插件设置；`peakAlertWebNotify` 是 DSH 页面的浏览器通知开关，不控制 Android 的本地通知开关。

认证只读接口 `GET /remote/api/insights/peak-reminders` 生成未来 7 天的实际峰谷变化点；周末、节假日和提前量参与计算，没有实际变化的整点不通知。仅返回时间表、来源和状态，不返回原始 config、密钥、账单或提供方设置。异常或旧版字段不兼容时显示不可用，不假设固定时间。

Android `PeakReminderService` 独立于 WebView，每 5 分钟同步时间表，每 30 秒检查已缓存的变化点。网络短暂不可用时使用有效期内的缓存，过期停止提醒；成功发出后记录变化点，服务重启不重复发送。晚到最多补发 30 分钟内的提醒。关闭开关、清理连接、切换服务器或凭据会停用/清除旧来源时间表，迟到 HTTP 响应不会跨连接写入。通知包含北京时间和 `dsh-cost-meter` 来源。

后台断连反馈经用户补充：设置省电无限制后恢复。因此没有把 rc.3 的服务代码差异直接定为根因。另补强已启用后台轮询/峰谷接收器在 Activity 前台进入和暂停前恢复，显示后台轮询运行/启动失败状态，并处理 Android 15 dataSync 超时避免崩溃。不会自动开启用户关闭的后台功能，也不申请省电豁免权限。Doze、厂商限制和系统前台服务时限仍需真机验证，不能承诺永久连接。

参考：[费用插件源码](https://github.com/Han-1413141/dsh-cost-meter)、[Android dataSync 服务时限](https://developer.android.com/develop/background-work/services/fgs/timeout)、[Doze 行为](https://developer.android.com/training/monitoring-device-state/doze-standby)。

## issue #18

读取了新 [issue #18](https://github.com/Blank-not-black/dsh-Remote/issues/18) 及评论（无评论）。报告环境为 Remote 0.7.6，问题包括上游 v2→v3 迁移拒绝 `source.kind`、单会话观察失败、历史计数非零但显示空白。

- 当前适配器原有 `formatStatus: migration-required` 防激活逻辑继续保留；新增对历史页/投影返回的 unclassified-source 错误统一转换为可操作的迁移提示。
- 已知会话的 follow/job 流失败只关闭相应流并隔离 60 秒；不把单会话错误变成所有会话的全局错误。其他会话的 follow、工作区和事件仍可继续。全局 control 观察错误若明确指向已知会话，会关闭故障 control 流并保留独立会话流。
- 手机和桌面共享历史渲染器在本页有记录但无可显示行时，显示说明和有效重试按钮；不会继续留白。

Remote 没有改动 DSH 的迁移包、用户原始日志或把 `fallback` 改写成 `user`。上游迁移器的类型域错误仍需由 DSH 修复；本次提供隔离和可诊断恢复，不声称已修好上游原始数据。

## 验证与产物

- 最近一次 `npm run check`：633 项，623 通过、10 跳过、0 失败。独立进程测试在部分全量运行中曾间歇失败，保留了失败诊断；后续全量通过，额外连续 20 次单项复测通过，尚未据此断言间歇失败的根因已消除。
- 可选实际组件检查：12 项通过、0 跳过。包含临时 HOME 启动 DSH 0.2.1-rc.1、挂载发布版 AgentTeams 0.1.24-rc.1 并经认证网关读取，以及将峰谷变化点与发布版 cost-meter 1.8.36 的计价函数逐项比对。最新 cost-meter 完整挂载因隔离环境缺其 Acorn 运行时依赖未完成；没有为此安装新依赖。
- Android JVM 测试执行实际 `PeakReminderPolicy`，验证提前量、补发边界、重启去重和过期停用。后台状态与启动失败的前端逻辑、连接切换迟到响应、桥接鉴权/参数/只读规则均有测试。
- 手机/桌面浏览器已检查公告填写、校验、翻页、提交，团队工作区/归档/任务/成员跳转，消息发送、新建会话、文件导航、审批允许与问题回答；强制拒绝 WebSocket 后确认长轮询接管，未出现原生计时器绑定异常。
- Debug APK 构建、签名和内嵌资源逐字节比对通过。Android 真机系统通知、灭屏、厂商省电策略、六小时服务限额与用户原始损坏会话尚未现场验证。

最新测试包：`dist/forms-teams-2026-10-18/dsh-remote-0.8.0-rc.3-forms-teams-peak-fixes.apk`。versionCode `8003`，versionName `0.8.0.rc.3`。SHA-256：`925aeaca88eabc0f393376b456e5aae4cb8d453b9b56946393814be34a1464b6`。峰谷接口需要本次配套的主机 Remote 插件源码；旧主机不会因只装 APK 自动获得该接口。

## 追加改动文件

`android/app/src/main/java/com/dshremote/app/{MainActivity,RemotePollService,PeakReminderService,PeakReminderPolicy}.java`，`packages/plugin/peak-reminders.mjs`，`packages/plugin/index.mjs`、`packages/plugin/package.json`、`scripts/sync-standalone.mjs`，`gateway.js`，`public/{app,history}.js`、`public/index.html`、`public/desktop/desktop.js`，及同步生成的插件副本。

测试追加/调整：`tests/{android-background,peak-reminders,mobile-select-peak-reminder,history-ui,dsh-021-compat,insights-bridge,installed-dsh,plugin-center}.test.js`、`tests/fixtures/insights-data.cjs`。文档更新本文件、`usage.md`、`modules/07-android-app.md`。公告与团队清单见 [announcement-forms-and-teams.md](announcement-forms-and-teams.md)，之前的结果栏与分支清单见 [turn-results.md](turn-results.md)。
