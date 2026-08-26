# Android 原生壳与后台服务模块

> 状态：现行 Android 端
>
> 工程：`android/`
>
> 应用 ID：`com.dshremote.app`

## 1. 模块定位

Android 工程是 Capacitor WebView 壳。主要业务在 `public/`，原生层只提供 Android 无法由普通浏览器可靠完成的能力：系统下载/安装、状态栏 inset、后台轮询、通知、峰谷提醒和 deep link 承接。

## 2. 代码结构

| 文件 | 作用 |
| --- | --- |
| `MainActivity.java` | Capacitor Activity、WebView 配置、JS bridge 注册 |
| `RemotePollService.java` | App 退后台后的 mux/host 事件长轮询和通知 |
| `PeakReminderService.java` | 北京时间峰谷切换提醒前台服务 |
| `AndroidManifest.xml` | cleartext、deep link、service、FileProvider |
| `app/build.gradle` | 根 package 版本映射、versionCode、签名和依赖 |
| `capacitor.config.json` | Capacitor 应用配置 |

## 3. 当前功能

- 通过 `NativeUpdate` 下载 APK 并调起系统安装器。
- 通过 `NativeFile` 把网关文件下载到系统 Downloads/dsh-remote。
- 通过 `NativeBackground` 保存后台轮询配置、启动/停止后台服务。
- 通过 `startPeakReminder/stopPeakReminder` 管理峰谷提醒服务。
- 接收 `dshremote://pair?token=...&server=...` deep link，交给前端 `appUrlOpen`。
- 在 Android WebView 中允许局域网 HTTP 网关所需的 mixed content。

## 4. 具体实现方式

`MainActivity` 注册三个 JavaScript interface。文件下载优先使用 Android `DownloadManager`，更新下载写入 app external files 后通过 `FileProvider` 交给系统安装器；文件名会过滤系统危险字符。

`RemotePollService` 使用前台服务、HandlerThread 和固定线程池同时轮询 mux/host。配置保存在 `SharedPreferences dsh_remote_bg`，每个通道保存 seq；收到 401 多次后标记登录过期并停止。网络恢复时立即触发一次轮询，Doze 延迟属于 Android 平台限制。

`PeakReminderService` 每 30 秒检查北京时间，工作日处理 9/12/14/18 点切换，周末只在 09:00 提醒一次。通知先同步写入当日占位，发送失败再回滚，避免服务重启产生重复通知。

Gradle 从根 `package.json` 读取版本；正式版 versionName 使用 `0.6.15`，RC 的连字符转为点。versionCode 保证 RC 与正式版本单调，并使用仓库内 debug keystore 便于侧载覆盖升级。

## 5. 制作目的

- 让 WebUI 能在 Android 上获得相机、通知、下载、安装和后台服务能力。
- 在 MIUI/HyperOS 等后台限制环境中，用前台服务提高轮询/提醒可靠性。
- 让 App 更新和文件下载走系统能力，避免前端自行处理 Android 文件权限。

## 6. JS Bridge 契约

| 对象 | 方法 | 用途 |
| --- | --- | --- |
| `NativeUpdate` | `getInsets()` | 返回 `{top,bottom}` dp |
| `NativeUpdate` | `downloadAndInstall(url)` | 下载并调起 APK 安装 |
| `NativeFile` | `downloadToDownloads(url,name,token)` | 带 Bearer 下载文件 |
| `NativeBackground` | `saveBackgroundConfig(json)` | 保存并启停轮询 |
| `NativeBackground` | `getBackgroundConfig()` | 读取轮询状态 |
| `NativeBackground` | `startPeakReminder()` / `stopPeakReminder()` | 启停峰谷提醒 |

后台配置至少包含 `enabled`、`intervalMin`、`base`、`token`、`clientId`、`notifyTaskDone`。token 只用于本地服务请求，不能进入通知文本和日志。

## 7. 边界与禁止事项

- 不把 Android 原生能力复制到 WebUI；WebUI 应先检查 bridge 是否存在，再提供浏览器回退。
- 不用浏览器测试结果声称相机权限、deep link、通知或后台轮询已真机通过。
- 不引第三方 Android 运行时库；已有 Capacitor/系统 API 边界保持不变。
- 不在更新下载中绕过 FileProvider 或系统安装器。
- 修改前台服务后必须考虑通知权限、进程重启、网络变化和 Doze。

## 8. 测试与验收

- `tests/mobile-select-peak-reminder.test.js`：前端原生选择器和峰谷提醒契约。
- `tests/user-flows.test.js`：Web 侧文件/消息全链路。
- `npm run build-app`：需要 JDK 21；完成后按项目约定停止 Gradle。
- 真机 RC：相机实时扫码、系统相机 deep link、后台轮询、通知和 APK 更新必须单独记录。

## 9. 修改前检查清单

- 需求能否由 WebUI 完成，还是确需原生桥？
- 是否会改变 bridge JSON、SharedPreferences key 或 notification 行为？
- Android 版本、权限、Doze 和厂商后台限制是否覆盖？
- 是否需要构建 APK；未构建不能宣称 App 已更新？
- 是否需要真机验收而不是仅自动测试？

## 10. 未决事项

- 当前使用前台服务实现后台能力，未来若改用系统调度器，必须重新验证国产 ROM 的可靠性和用户可见通知成本。
