# Android 壳与后台服务模块

> 源码核对：2026-10-12，仓库 0.7.4。应用 ID：`com.dshremote.app`。
>
> [模块索引](README.md) · [使用与平台差异](../usage.md)

## 1. 模块定位

Capacitor WebView 承载根 `public/`，系统层负责下载、安装、inset、后台轮询、通知、峰谷提醒和 deep link。功能测试页保留导航，Android 的 ASR 页面、SpeechRecognizer 桥和麦克风权限已移除；鸿蒙的诊断是独立实现。

## 2. 代码结构

| 文件 | 作用 |
| --- | --- |
| `android/app/src/main/java/com/dshremote/app/MainActivity.java` | WebView、UpdateBridge、BackgroundBridge |
| 同目录 `RemotePollService.java` | 双通道事件轮询、后台通知、gzip 解码 |
| 同目录 `PeakReminderService.java` | 北京时间峰谷提醒 |
| `android/app/src/main/AndroidManifest.xml` | 网络、相机/通知、安装、服务和 deep link |
| `android/app/build.gradle`、`android/variables.gradle` | 版本、SDK、现有依赖和侧载签名 |
| 根 `capacitor.config.json` | Web 资源入口 |

## 3. 当前功能

- 相机/相册由已有 Capacitor 能力提供，配对 deep link 交给 WebUI。
- 系统 Downloads 文件下载，APK 进度/速度、SHA-256 校验与安装器。
- 后台轮询与任务完成通知；峰谷提醒独立开关。
- Android 最低 SDK 24，compile/target SDK 36，构建使用 JDK 21。

## 4. 具体实现方式

MainActivity 注册三个 JS 对象：`NativeUpdate`、`NativeFile` 复用 UpdateBridge，`NativeBackground` 使用 BackgroundBridge，不再注册 NativeAsrTest。新版下载校验与安装复用同一文件；旧壳通过兼容方法处理，不能假定都有完整进度。

RemotePollService 的 SharedPreferences 为 `dsh_remote_bg`；mux/host 独立轮询，保存 seq，401 达阈值后标记失效并停止。网络恢复补查，接受 gzip。Doze/厂商后台限制会延迟，前台服务不能保证无限保活。

峰谷服务每 30 秒检查北京时间，工作日 9/12/14/18 点，周末 9 点；占位防重复，通知失败回滚。云端公告与投票不是该服务的职责。

## 5. 制作目的

复用 WebUI 业务，同时通过系统能力完成手机权限、安装及后台工作；浏览器不伪装具备 Android 桥。

## 6. 接口与数据契约

| JS 对象 | 方法 |
| --- | --- |
| `NativeUpdate` | `getInsets()`、`getDownloadStatus()`、`downloadAndInstall(url)`、`downloadVerifiedAndInstall(url,expectedHash)` |
| `NativeFile` | `downloadToDownloads(url,name,token)` |
| `NativeBackground` | `saveBackgroundConfig(json)`、`getBackgroundConfig()`、`startPeakReminder()`、`stopPeakReminder()` |

后台配置包含启用、间隔、base、token、clientId 与任务完成通知设置。凭证只用于本地请求，不进入通知/日志。桥接存在性必须先检查；下载状态回调按生产实现处理，不以旧方法推断新壳能力。

版本从根 package 读取；RC versionName 连字符转点。versionCode 的 RC 槽限制与签名策略见[构建发布](../release.md)。目前使用仓库侧载 debug 签名，不能表述成商店正式签名。

## 7. 边界与禁止事项

不新增第三方库；保留已有 Capacitor/AndroidX 边界。不开启任意网页调用 Native bridge 的路径。文件通过系统能力处理，更新不绕过系统安装器。不能把浏览器测试当作相机、后台或安装真机通过。

## 8. 测试与验收

`tests/apk-progress.test.js` 验证下载与桥契约，`asr-test-ui.test.js` 验证 Android ASR 已移除，`mobile-select-peak-reminder.test.js` 验证提醒。构建见[开发指南](../development.md)，真机单独检查扫码、权限、通知、深链、安装/升级、后台与弱网。

## 9. 修改前检查清单

- 是否必须系统桥，还是已有 Web 功能即可？
- 是否改变桥 JSON、后台 preference、通知或版本映射？
- 是否覆盖新版/旧壳、拒绝权限、下载损坏与网络中断？
- 是否同步根 Web 资源并记录 APK/真机验证范围？

## 10. 未决事项

后台可靠性取决于 Android 和 ROM。RC 次数超过当前版本槽时的 versionCode 升级策略仍需实现层处理；本轮文档不修改公式。
