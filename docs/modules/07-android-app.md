# Android 壳与后台服务模块

> 源码核对：2026-10-17，仓库 0.8.0-rc.3。应用 ID：`com.dshremote.app`。
>
> [模块索引](README.md) · [使用与平台差异](../usage.md)

## 1. 模块定位

Capacitor WebView 承载根 `public/`，系统层负责下载、安装、inset、后台轮询、通知和 deep link；峰谷提醒使用主机 `dsh-cost-meter` 的规则，由 Android 接收器发送通知。功能测试页保留导航，Android 的 ASR 页面、SpeechRecognizer 桥和麦克风权限已移除；鸿蒙的诊断是独立实现。

## 2. 代码结构

| 文件 | 作用 |
| --- | --- |
| `android/app/src/main/java/com/dshremote/app/MainActivity.java` | WebView、UpdateBridge、BackgroundBridge |
| 同目录 `RemotePollService.java` | 双通道事件轮询、后台通知、gzip 解码 |
| 同目录 `TaskNotifications.java`、`TaskReminderPolicy.java` | 前后台共享任务状态、独立结果渠道、按会话/轮次去重和通知跳转 |
| 同目录 `LanDiscovery.java`、`LanPairCrypto.java` | 用户触发的 Wi-Fi 搜索、限时配对；纯系统/JDK 加密，generation 丢弃晚到结果 |
| 同目录 `PeakReminderService.java`、`PeakReminderPolicy.java` | 从主机更新峰谷通知时间表，后台发送、去重、限时补发和过期停用 |
| `android/app/src/main/AndroidManifest.xml` | 网络、相机/通知、安装、服务和 deep link |
| `android/app/build.gradle`、`android/variables.gradle` | 版本、SDK、现有依赖和侧载签名 |
| 根 `capacitor.config.json` | Web 资源入口 |

## 3. 当前功能

- 相机/相册由已有 Capacitor 能力提供，配对 deep link 交给 WebUI。
- 系统 Downloads 文件下载，APK 进度/速度、SHA-256 校验与安装器。
- 后台轮询与任务完成通知；峰谷时间在 DSH「设置 → 费用 → 峰谷计价」配置（`dsh-cost-meter`），手机本地开关决定是否发送 Android 通知，升级清理旧固定通知计划。
- Android 最低 SDK 24，compile/target SDK 36，构建使用 JDK 21。

## 4. 具体实现方式

MainActivity 注册三个 JS 对象：`NativeUpdate`、`NativeFile` 复用 UpdateBridge，`NativeBackground` 使用 BackgroundBridge，不再注册 NativeAsrTest。新版下载校验与安装复用同一文件；旧壳通过兼容方法处理，不能假定都有完整进度。

0.8.2-rc.1 新增 `NativeLan`，仅在「连接 → 搜索电脑」启动约 6 秒 Wi-Fi IPv4 广播；不长期搜索、不逐个探测 IP，关闭/退后台销毁搜索。配对码是电脑主动开放时生成的一次性随机码；先验证电脑的 HMAC 证明，再以 ECDH/AES-GCM 解密设备凭据，独立密钥由现有服务器列表保存。网络访问增加系统 `ACCESS_NETWORK_STATE` 权限，没有新增第三方依赖。完整协议见 [跨模块契约](01-contracts.md)。

任务结果渠道为 `dsh_remote_task_results`，首次创建为高重要性；不会修改后台常驻渠道或覆盖用户系统设置。`TaskReminderPolicy` 追踪已观察运行与终态，清除目标不提醒、初始空闲和回放只建状态；成功投递后才写入已提醒标记，失败可重试。失败/目标完成可升级同一轮通知，多个会话及新轮次不会互相覆盖。任务结果沿用审批通知的凭据指纹与会话跳转，Intent 不含访问令牌。前台事件与双通道后台轮询共享有界持久化状态；旧网关没有 epoch 时用独立 seeded 标记，避免一直当成首次回放。服务时限与 Doze 限制不变。

0.8.2-rc.2 修正跨通道乱序：只由全局 `host/session-status` 建立、结束运行周期，不再把晚到的 `turn/start/end` 或 `agent/status` 再计为一轮。会话日志中的目标完成仅补充已知活动周期，执行失败可升级已知周期结果；没有可关联周期时不凭日志新建周期。旧 RC 的已计数周期首次接入 host 状态时保守承接，避免升级补发。网关为 host 状态/错误帧附加 `remoteEventId`（epoch、通道、序号），WS 与 poll 共用，Android 保存有界处理回执，系统拒绝投递时不消费回执；旧网关缺少该字段时退回周期状态判定，不把上游 `rpcId` 当作通用事件 ID。

后台补拉先合并 baseline 与本批新增帧，处理全部 resolved 后再决定 requested 的提醒；前台降级轮询也先把本批 resolved 送入系统桥，避免已经处理的审批/提问短暂响铃。真正的实时 requested 仍及时提醒，不延时等待未来的 resolved。审批测试使用实际 `notify` 结果：权限预检查后系统拒绝投递也返回 false，成功提交仍不等于用户实际看到、听到通知。

RemotePollService 的 SharedPreferences 为 `dsh_remote_bg`；mux/host 独立轮询，保存 seq，401 达阈值后标记失效并停止。网络恢复补查，接受 gzip。Doze/厂商后台限制会延迟，前台服务不能保证无限保活。

`PeakReminderService` 每 5 分钟读取认证只读接口 `/remote/api/insights/peak-reminders`，每 30 秒检查有效缓存中的变化点，不再写死 9/12/14/18 点。旧通知 8801–8804 在启动时取消，当前通知使用独立渠道。接收器重启不重复发出已成功通知的变化点，断网时仅用有效期内缓存，晚到最多补发 30 分钟。具体接口、限制和验收见[峰谷通知与 issue #18](../peak-reminders-and-issue18.md)。鸿蒙端仍是自己的代理提醒实现。云端公告与投票不是该服务的职责。

## 5. 制作目的

复用 WebUI 业务，同时通过系统能力完成手机权限、安装及后台工作；浏览器不伪装具备 Android 桥。

## 6. 接口与数据契约

| JS 对象 | 方法 |
| --- | --- |
| `NativeUpdate` | `getInsets()`、`getDownloadStatus()`、`downloadAndInstall(url)`、`downloadVerifiedAndInstall(url,expectedHash)` |
| `NativeFile` | `downloadToDownloads(url,name,token)`、`exportDiagnostics(json)`、`getDiagnosticExportStatus()` |
| `NativeBackground` | `saveBackgroundConfig(json)`、`getBackgroundConfig()`、`savePeakReminderConfig(json)`、`getPeakReminderConfig()`；旧 `startPeakReminder()` 仅恢复已有插件规则配置，`stopPeakReminder()` 停止提醒 |
| `NativeBackground` 任务提醒 | `handleTaskEvent(base,token,json,replay)`、`testNotification(kind)`；配置读回包含系统通知、审批渠道及任务渠道是否启用 |
| `NativeLan` | `search()`、`getState()`、`pair(hostId,code)`、`takePairResult()`、`cancel()` |

后台配置包含启用、间隔、base、token、clientId 与任务完成通知设置。凭证只用于本地请求，不进入通知/日志。桥接存在性必须先检查；下载状态回调按生产实现处理，不以旧方法推断新壳能力。

版本从根 package 读取；RC versionName 连字符转点。versionCode 的独立发布计数与签名策略见[构建发布](../release.md)。目前使用仓库侧载 debug 签名，不能表述成商店正式签名。

## 7. 边界与禁止事项

不新增第三方库；保留已有 Capacitor/AndroidX 边界。不开启任意网页调用 Native bridge 的路径。文件通过系统能力处理，更新不绕过系统安装器。不能把浏览器测试当作相机、后台或安装真机通过。

## 8. 测试与验收

`tests/apk-progress.test.js` 验证下载与桥契约，`asr-test-ui.test.js` 验证 Android ASR 已移除，`mobile-select-peak-reminder.test.js`、`peak-reminders.test.js`、`android-background.test.js` 验证插件规则、手机开关、旧通知清理、发送边界与后台状态。构建见[开发指南](../development.md)，真机单独检查扫码、权限、通知、深链、安装/升级、后台与弱网。

新增 `tests/lan-pairing.test.js` 的 loopback UDP、完整网关鉴权/撤销与实际 Node↔Java 加密互通，`lan-discovery-ui.test.js` 的搜索/取消/凭据消费，`pending-notifications.test.js` 的实际 Java 通知策略与 OS fakes。以上不代表真机 Wi-Fi、ROM 通知、息屏或覆盖安装已通过，须单独验收；浏览器与鸿蒙未新增发现入口。

## 9. 修改前检查清单

- 是否必须系统桥，还是已有 Web 功能即可？
- 是否改变桥 JSON、后台 preference、通知或版本映射？
- 是否覆盖新版/旧壳、拒绝权限、下载损坏与网络中断？
- 是否同步根 Web 资源并记录 APK/真机验证范围？

## 10. 未决事项

后台可靠性取决于 Android 和 ROM。versionCode 已改为独立发布计数，同版本重建不递增、新版本发布加一；计数校验、旧码过渡及真机升级验收见[构建发布](../release.md)。
