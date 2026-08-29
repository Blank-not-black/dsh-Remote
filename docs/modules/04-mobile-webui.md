# 手机 WebUI / Android 前端模块

> 状态：现行主客户端
>
> 源码：`public/index.html`、`public/app.js`
>
> 运行环境：移动浏览器、Capacitor Android WebView、DSH 插件内嵌页面

## 1. 模块定位

手机端是远程操作入口，优先解决“现在是否正常、有没有待处理事项、能否继续工作”。它负责会话、文件、主页、统计、设置、通知和扫码连接，不负责替代网关的安全判断或 DSH 内部命令实现。

## 2. 代码结构

| 文件/区域 | 作用 |
| --- | --- |
| `index.html` | 五个主视图、设置子页、弹窗、文件/会话 DOM 和内置中英文本 |
| `app.js` 初始化/API | localStorage、Capacitor 能力、HTTP/WS RPC、连接恢复 |
| `app.js` 服务器区 | `servers-v2` 分组、测速、自动选优、扫码导入 |
| `app.js` 会话区 | 顶层会话、历史、实时事件、思考流、队列、目标和子代理 |
| `app.js` 文件区 | 工作区、预览、Range/分块上传、暂停/取消 |
| `app.js` 更新/公告/反馈区 | 版本比较、公告轮询、投票、反馈和隐私处理 |

## 3. 当前功能

- 服务器分组、备注、手动选择和自动测速选优；连接身份按服务器地址与 token 区分。
- 在设置中管理 DSH 已声明的模型提供方、API 密钥、API 地址/协议、模型目录、模型发现，以及每个自定义模型的思考深度档位和默认档位。
- 在设置的“功能测试”中运行 Android 原生 ASR 诊断，查看设备/识别服务、partial/final/error 回调、session 重建和可复制日志。
- 实时摄像头扫码、拍照/相册扫码、本地 `jsQR` 解码和系统 deep link 配对。
- 扫码导入 token 与全部 `server` 地址，旧单地址二维码兼容；同地址不同 token 不会互相覆盖。
- mux/host WebSocket 双通道，失败后降级为事件轮询，恢复后重连 WS。
- 会话列表、工作区筛选、创建/重命名/归档/停止、目标、子代理和队列消息。
- 历史消息、图片附件、实时回复、思考流、审批和提问响应。
- 文件浏览、文本/Markdown 预览、下载、分块上传、续传、暂停和取消。
- 首页运行状态、token 量/费用统计、公告/投票、反馈、主题、更新和通知设置。

## 4. 具体实现方式

`state.server` 为空时表示同源；`apiUrl()` 统一拼接请求地址。`servers-v2` 保存全部服务器及其 token，`serverCandidates()` 和 `serverLatency` 按地址+token 区分测速身份，`selectFastestServer()` 更新当前组的实际地址与 token。

模型配置页先并行读取 `llm.providers` 和 `settings.describe`，再用 `credentials.describe` 获取各凭据的配置状态。编辑器根据设置 namespace、路径和生效值构造表单；保存时用 `settings.mutate` 写入非秘密设置，用 `credentials.set/unset` 单独处理 API key。密钥输入框是 password，只在提交请求体中短暂存在，不进入 localStorage、URL 或页面缓存。模型发现结果需要用户选择后才加入目录。

每个模型条目都可以编辑 `reasoning.efforts`，每个档位包含稳定的 `id`、显示用 `name` 和可选 `description`，并可选择 `defaultEffort`。档位值校验为字母、数字、点、下划线、冒号和连字符，单模型最多 12 档；清空后恢复提供方默认行为。会话中的“思考深度”菜单直接读取当前模型的这些元数据，选择后调用既有 `session.selectModel`，实际第三方请求字段由 DSH 适配器处理。

“功能测试 → ASR 模型测试（小米手机）”只在 Android App 中启用，通过 `NativeAsrTest` 调用系统 `SpeechRecognizer`。测试默认运行约 60 秒，每个 `onResults/onError` 后销毁并重建识别 session，前端仅在内存中接收并格式化日志；日志可复制给开发者分析，不通过网关或 DSH RPC 上传。系统服务枚举、`isRecognitionAvailable`、`isOnDeviceRecognitionAvailable`、App 的录音权限/AppOps、全局麦克风静音状态、partial/final/error 回调和恢复次数都会进入报告。若系统服务返回 `ERROR_INSUFFICIENT_PERMISSIONS`，页面提供打开 App 权限设置的入口；这通常意味着 App 麦克风授权、系统隐私麦克风开关或小米语音服务自身授权仍未完成。

权限错误时，ASR 测试页同时提供 DSH Remote 应用权限和“语音引擎设置”入口。后者由原生桥优先尝试打开小爱同学，再回退到 Android 语音输入设置；因为小米系统语音引擎没有公开的授权 API，前端不伪造授权状态。

小米官方开发者接入说明要求开发者通过小爱开发平台配置鉴权，并获取鉴权 SDK、唤醒 SDK 和小爱 SDK。这是正式接入小爱语音平台的独立路线，不是给 `SpeechRecognizer` 增加一个 Android 权限，也不能通过设置页替第三方 App 解锁 `com.xiaomi.mibrain.speech`。在没有平台账号、鉴权材料和 SDK 授权前，会议模式不能把小爱系统服务当作稳定的通用 ASR 后端。

`applyPairUrl()` 校验 `dshremote://pair`、token 和全部 `server` 参数，使用 `getAll()` 读取多地址，去重后逆序插入以保持二维码顺序，第一个作为当前连接；同地址已有其他 token 时新增连接条目。配对成功后保存 token/服务器、重绘并调用 `syncBgConfig()`。公告投票优先经网关提交，网关无地址、网络失败或返回 401 时直连公网收集器托底；普通反馈不走该回退。

实时连接按 `generation` 判断旧连接，mux/host 各自维护重试状态。连续失败时进入 poll mode；轮询用每通道 `since` 序号取增量事件，恢复检查通过后再开启 WS。客户端不发送应用层心跳，遵守 DSH downlink-only。

首页 DSH 可达状态优先读取当前网关 `/health.upstreamReachable`，`host.describe` 只补充版本、目录和会话数。首次 RPC 失败会退避重试，并在双 WS 恢复后立即补查，不能把一次启动竞态固化成“DSH 离线”。

会话列表只展示顶层会话；内部子代理保留在数据层并在主会话卡片中折叠展示。历史和实时事件使用相同过滤规则，避免插件/目标来源的 user/message 被误显示为用户输入。

图片发送使用 DSH `session.prompt` 的 content 图片块；文件上传使用 4MB 分块和 SHA-256。Android 可用时通过 `NativeUpdate`、`NativeFile`、`NativeBackground` 处理安装更新、下载和后台轮询。

文件树路径函数同时识别 POSIX、Windows 盘符和 UNC 路径，按网关返回的分隔符拼接并把“上一级”限制在当前文件根/工作区内。网关声明多个允许根时，文件页工作区选择器同时提供这些根；切换服务器会清空旧主机的路径、根和工作区选择，避免把 Linux `/` 发给 Windows。

## 5. 制作目的

- 为手机提供低认知负担的 DSH 远程工作入口。
- 把网络波动、主机多地址和 DSH 重启变成用户可理解的状态。
- 在同一套 UI 中兼容独立网关、插件内嵌和 Android 原生能力。
- 用本地缓存、增量事件和续传减少移动网络成本。

## 6. 持久化重点

`token`、`servers-v2`、`notify`、`mobileEnterAction`、公告已读/历史/投票记录、`workbenchOrderV1`、会话历史缓存和 client ID。修改 key 时要考虑旧版本迁移、清理按钮和 Android 后台服务读取。

## 7. 边界与禁止事项

- 不直接编辑 `packages/plugin/public/app.js` 或 `index.html`。
- 不在前端发明 DSH RPC；以 DSH Web 可见行为和 [01-contracts.md](01-contracts.md) 为准。
- 不用 `state.server` 空值判断网关离线；同源页面必须正常工作。
- API key 只能经过 DSH credentials RPC 写入/清除，不能落到 WebView 存储或客户端自定义配置文件。
- 不把普通竖向滚动误判为拖拽；手势改动要保留正常滚动和边缘自动滚动。
- UI 不能把 token、设备密钥或联系方式写入公开反馈/日志。
- ASR 测试日志不得包含 API key、token、设备唯一标识或原始录音；测试本身可能由系统云端 ASR 处理音频，启动前必须提示用户。
- ASR 出现权限错误时，先在系统设置允许 DSH Remote 使用麦克风，打开全局麦克风开关并完成小米/系统语音服务的首次授权，再重新测试；日志中的 `recordAudioPermission`、`recordAudioAppOp` 和 `microphoneMuted` 用于区分三类问题。
- 不把小爱开发平台 SDK 接入误写成普通 Android 系统 ASR 适配；如果未来正式接入，必须单独评估平台鉴权、SDK 引入、凭据保存、云端费用和小米平台审核，并先获得项目对新增运行时依赖的明确许可。

## 8. 测试与验收

- `tests/user-flows.test.js`：文本、图片、实时、审批、提问、会话、文件和管理全链路。
- `tests/network-regression.test.js`：WS、轮询、服务器状态、扫码结构和交互回归。
- `tests/reasoning-ui.test.js`、`session-list-ui.test.js`、`workspace-files-ui.test.js`：会话显示和工作区。
- `tests/mobile-select-peak-reminder.test.js`：移动选择器和通知桥接逻辑。
- 普通浏览器无法替代 Android 相机、deep link、通知和后台服务真机验证。

### 2026-08-27：Android ASR 功能测试
- 需求：在 App 内验证小米/系统云端 SpeechRecognizer 的实际回调和 session 恢复表现。
- 方案：增加“功能测试”设置页和 `NativeAsrTest` 原生桥，前端展示并复制本地诊断日志。
- 联动：Android Manifest 增加录音权限和 RecognitionService 查询声明；不新增 DSH RPC 或第三方依赖。
- 验证：补充 ASR UI/原生桥静态契约测试，并构建 APK 检查 Java 编译。
- 未做：尚未在当前回合使用真实小米设备执行测试；结果需要用户安装后回传日志。

### 2026-08-27：小米 ASR 权限错误诊断
- 真实日志：`recognitionAvailable=true`、`onDeviceAvailable=false`，识别服务为 `com.xiaomi.mibrain.speech`，但首个 session 在 25ms 返回 `ERROR_INSUFFICIENT_PERMISSIONS`。
- 结论：小米云端 ASR 路径已经被调用，但本次不能证明 ASR 可用；失败发生在麦克风/系统语音服务授权阶段，而不是文件转写能力阶段。
- 改进：报告增加 App 录音权限、录音 AppOps 和全局麦克风静音状态；权限错误时显示系统权限设置按钮，并显式携带调用包名后再启动识别。
- 新边界：小爱官方 SDK 的鉴权 SDK、唤醒 SDK、小爱 SDK 与系统 `SpeechRecognizer` 是两条不同接入路线；当前不在 Android App 中私自引入或模拟官方 SDK。

### 2026-08-26：自定义模型思考档位编辑
- 需求：在自定义提供方的模型配置中编辑思考深度档位。
- 方案：模型目录条目增加档位值、显示名称、说明和默认档位编辑器，保存到模型 `reasoning` 元数据。
- 联动：会话菜单复用已有 `reasoningEffort` 选择；桌面端消费同一模型元数据；插件静态资源由同步脚本生成。
- 验证：新增 `tests/model-settings.test.js` 契约断言，并执行全量 `npm run check`。
- 未做：未进行 Android 真机 UI 操作；第三方请求字段仍由 DSH 适配器解释。

## 9. 修改前检查清单

- 变化属于手机专属交互，还是跨端数据契约？
- 是否同步检查桌面端对应行为？
- 是否影响 localStorage、后台服务或重连状态？
- 是否覆盖无 token、同源、旧网关和网络恢复？
- 是否需要真机 RC，而不是只跑静态测试？

## 10. 未决事项

- 当前 `app.js` 仍是零构建单文件前端，未来可按功能拆文件，但必须先定义构建/同步边界，不能在未定方案时引入打包器。
