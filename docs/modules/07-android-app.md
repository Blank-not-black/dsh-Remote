# Android 原生壳与后台服务模块

> 状态：现行 Android 端
>
> 工程：`android/`
>
> 应用 ID：`com.dshremote.app`

## 1. 模块定位

Android 工程是 Capacitor WebView 壳。主要业务在 `public/`，原生层只提供 Android 无法由普通浏览器可靠完成的能力：系统下载/安装、状态栏 inset、后台轮询、通知、峰谷提醒、ASR 诊断和 deep link 承接。

## 2. 代码结构

| 文件 | 作用 |
| --- | --- |
| `MainActivity.java` | Capacitor Activity、WebView 配置、JS bridge 注册 |
| `RemotePollService.java` | App 退后台后的 mux/host 事件长轮询和通知 |
| `PeakReminderService.java` | 北京时间峰谷切换提醒前台服务 |
| `MainActivity.java` 内 `AsrTestBridge` | Android 系统 SpeechRecognizer 诊断、partial/final/error 回调和 session 重建 |
| `AndroidManifest.xml` | cleartext、deep link、service、FileProvider |
| `app/build.gradle` | 根 package 版本映射、versionCode、签名和依赖 |
| `capacitor.config.json` | Capacitor 应用配置 |

## 3. 当前功能

- 通过 `NativeUpdate` 下载 APK 并调起系统安装器。
- 通过 `NativeFile` 把网关文件下载到系统 Downloads/dsh-remote。
- 通过 `NativeBackground` 保存后台轮询配置、启动/停止后台服务。
- 通过 `startPeakReminder/stopPeakReminder` 管理峰谷提醒服务。
- 通过 `NativeAsrTest` 在设置页运行短时 ASR 诊断，收集设备信息、识别服务列表、partial/final/error、session 重建和恢复结果。
- 接收 `dshremote://pair?token=...&server=...` deep link，交给前端 `appUrlOpen`。
- 在 Android WebView 中允许局域网 HTTP 网关所需的 mixed content。

## 4. 具体实现方式

`MainActivity` 注册四个 JavaScript interface。文件下载优先使用 Android `DownloadManager`，更新下载写入 app external files 后通过 `FileProvider` 交给系统安装器；文件名会过滤系统危险字符。

`AsrTestBridge` 注册为 `NativeAsrTest`。它只在用户点击开始并完成麦克风授权后运行，使用系统默认 `SpeechRecognizer` 和 `zh-CN` free-form intent，开启 `EXTRA_PARTIAL_RESULTS` 并设置调用包名。每次结果或错误结束当前 session，释放并重建识别器，最多重建 12 次、总测试时长约 60 秒；事件通过 WebView 内存回调 `window.__dshAsrEvent(event)` 返回，不发往网关。报告额外记录 App 的 `RECORD_AUDIO` 授权、录音 AppOps 状态和全局麦克风静音状态；出现权限错误时可从页面打开 App 详情权限设置。Android 系统云端识别服务可能上传音频，前端在开始前显示确认提示。

小爱开发平台的官方接入要求鉴权 SDK、唤醒 SDK和小爱 SDK，并在控制台完成鉴权/技能配置。该路线面向正式的小爱语音平台接入，不能等同于调用系统默认 `SpeechRecognizer`，也不能仅通过 `com.xiaomi.mibrain.speech` 的包名或 Android 录音权限完成。除非另行获得平台授权并批准新增 SDK，当前 App 只保留系统 ASR 诊断，不集成小爱私有 SDK。

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
| `NativeAsrTest` | `startAsrTest()` / `stopAsrTest()` | 启停 Android 系统 ASR 诊断 |
| `NativeAsrTest` | `openAsrPermissionSettings()` | 打开 DSH Remote 的系统权限详情页 |
| `NativeAsrTest` | `openAsrEngineSettings()` | 优先打开小爱同学，回退到 Android 语音输入设置 |

后台配置至少包含 `enabled`、`intervalMin`、`base`、`token`、`clientId`、`notifyTaskDone`。token 只用于本地服务请求，不能进入通知文本和日志。ASR 桥只回传诊断元数据和识别回调摘要，不回传 token、API key、IMEI 或设备序列号。

## 7. 边界与禁止事项

- 不把 Android 原生能力复制到 WebUI；WebUI 应先检查 bridge 是否存在，再提供浏览器回退。
- 不用浏览器测试结果声称相机权限、deep link、通知或后台轮询已真机通过。
- 不引第三方 Android 运行时库；已有 Capacitor/系统 API 边界保持不变。
- 不在更新下载中绕过 FileProvider 或系统安装器。
- 修改前台服务后必须考虑通知权限、进程重启、网络变化和 Doze。
- ASR 测试不是完整会议录音：`SpeechRecognizer` 独占麦克风，不与自建 `AudioRecord` 并行；真实会议录音需要另行设计。
- `ERROR_INSUFFICIENT_PERMISSIONS` 不能直接归因于“没有识别服务”：还要检查 App 录音权限、AppOps、全局麦克风开关以及厂商语音服务的首次授权。
- `com.xiaomi.mibrain.speech` 没有稳定的公开授权 Activity；应用只能打开小爱同学/系统语音输入设置，不能替用户接受小米隐私授权。
- 正式小爱 SDK 接入需要平台鉴权材料和专用 SDK；不能把系统 `SpeechRecognizer` 测试失败通过隐藏权限、反射或模拟用户授权的方式绕过。

## 8. 测试与验收

- `tests/mobile-select-peak-reminder.test.js`：前端原生选择器和峰谷提醒契约。
- `tests/user-flows.test.js`：Web 侧文件/消息全链路。
- `npm run build-app`：需要 JDK 21；完成后按项目约定停止 Gradle。
- 真机 RC：相机实时扫码、系统相机 deep link、后台轮询、通知和 APK 更新必须单独记录。
- ASR 真机：小米/Redmi 上验证云端识别、partial/final、单次 session 时长、自动重建、麦克风释放和错误恢复，并把 App 内复制的日志作为验收记录。

## 9. 修改前检查清单

- 需求能否由 WebUI 完成，还是确需原生桥？
- 是否会改变 bridge JSON、SharedPreferences key 或 notification 行为？
- Android 版本、权限、Doze 和厂商后台限制是否覆盖？
- 是否需要构建 APK；未构建不能宣称 App 已更新？
- 是否需要真机验收而不是仅自动测试？
- 原生 ASR 测试是否明确提示云端音频处理和麦克风占用？

## 10. 未决事项

- 当前使用前台服务实现后台能力，未来若改用系统调度器，必须重新验证国产 ROM 的可靠性和用户可见通知成本。

### 2026-08-27：Android ASR 诊断桥
- 需求：为小米手机厂商 ASR 模式提供可复制的实际测试日志。
- 方案：在 `MainActivity` 增加 `NativeAsrTest`，只用 Android 系统 `SpeechRecognizer`，按 session 结束重建并回调 WebView。
- 联动：`public/index.html/app.js/styles.css` 增加功能测试页；Manifest 增加 `RECORD_AUDIO` 和识别服务查询声明。
- 验证：静态契约测试通过，JDK 21 下 APK 编译通过；真实小米设备日志仍由用户回传。
- 未做：不实现完整会议录音、音频文件注入、多发言人识别或离线模型。

### 2026-08-27：小米 ASR 权限错误诊断
- 真实小米 Android 16 日志在 `listening` 后 25ms 收到 `ERROR_INSUFFICIENT_PERMISSIONS`；服务可发现但未获准访问麦克风。
- `AsrTestBridge` 增加权限设置入口和 `recordAudioPermission`、`recordAudioAppOp`、`microphoneMuted` 元数据，便于下一次日志区分 Android App 权限、隐私开关和小米语音服务授权。
- 由于小米系统未提供稳定的第三方授权 API，页面新增“语音引擎设置”按钮：优先启动 `com.miui.voiceassist`，失败时打开 `Settings.ACTION_VOICE_INPUT_SETTINGS`。
- 根据用户回传的小爱官方提示，补充记录：鉴权 SDK、唤醒 SDK、小爱 SDK 属于另一条需平台配置的正式接入路线，当前不作为系统 ASR 测试的修复方案。
