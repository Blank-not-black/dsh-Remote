# 模块历史变更记录

> 从原模块整理的日期记录；当时的已验证、待验证和数量只适用于该次工作。现行模块见[索引](../modules/README.md)。


## 跨模块协议与数据契约

### 2026-08-26：自定义模型思考档位
- 需求：允许第三方自定义提供方的每个模型自行设置思考深度档位。
- 方案：复用 `reasoning.efforts` 模型元数据和 `session.selectModel.reasoningEffort`，不新增 RPC。
- 联动：手机模型配置、桌面模型菜单、网关透明转发和 DSH 提供方适配器。
- 验证：补充模型配置静态契约测试，并执行项目全量门禁。
- 未做：不在 Remote 网关层猜测或改写第三方 HTTP 请求参数。



## 独立网关模块

### 2026-08-26：透明转发模型级思考档位
- 需求：让自定义提供方的模型选择能够携带用户配置的思考档位。
- 方案：保持网关为 Bearer 鉴权后的 DSH RPC 透明代理，转发模型元数据和已有选择字段。
- 联动：不修改网关请求解析、日志和存储逻辑，由 DSH 适配器负责第三方参数映射。
- 验证：执行 `npm run sync-plugin`、`npm run check` 和 `git diff --check`。
- 未做：不新增网关端点、不记录 API key、不在网关中实现提供方适配器。


### 2026-09-03：DSH 接口兼容协商与可选诊断上传
- 需求：DSH 版本变化导致点号接口 404 时，客户端仍能创建会话和读取主机信息，并为问题分析保留证据。
- 方案：点号 RPC 404/405/501 后尝试对应 slash RPC；协议改变时重建 collector，并以有界、内存、脱敏日志生成 `/diagnostics` 快照。
- 后续：依据 DSH v0.1.2-alpha.2/alpha.4 的 RemoteError 与会话按需读取契约，兼容 `api-session/activity` 增量排序并记录稳定错误码。
- 联动：手机与桌面反馈表单增加默认未勾选的诊断上传选项；同步插件产物。
- 验证：网关子进程模拟点号 404/slash 成功，验证诊断和反馈链路；全量门禁待执行。
- 未做：不自动上传、不持久化诊断、不安装、提交或发布。


### 2026-09-19：HarmonyOS 链路修复与 `/handoff` 接续指针（PR #12 评审）
- 需求：评审发现 HarmonyOS lws 客户端周期断连（网关不回客户端 Ping）、events 长期 degraded（flavor 探测被毒化为 legacy）、子代理会话 follow 错误帧刷屏，并要求跨设备接续卡片。
- 方案：collector 侧新增 RFC6455 客户端 Ping→未掩码 Pong 应答（§4 WS 活性）；flavor 探测失败保持 unknown 不固化 legacy；modern mux 跳过 subagent 会话的 session/follow；新增单条记录端点 `/handoff`（GET/PUT/DELETE，Bearer，7 天过期）。
- 联动：`harmonyos/` RealtimeService 断连/降级恢复；HandoffState/HandoffCard 消费 `/handoff`（契约登记待 01-contracts.md）；同步 `packages/plugin/gateway.cjs`（cmp 一致）。
- 验证：真机 Pong 应答后断连消失（reason 75 收敛）；网关重启后 events ready/mux/host 全通；`npm run check` 189 pass / 0 fail。
- 未做：A/B 双服务器真机快速切换未跑（仅服务器语义层验证）；`/handoff` 正式契约条目待补 01-contracts.md。


### 2026-09-20：真机 A/B 服务器切换与大文件哈希/续传验收（PR #12 后续测试）
- 需求：上游合并 rc.3 后点名补三项真机验证——大文件不同分块及最终 SHA-256、中断续传、双服务器快速切换。
- 方案：不改代码，纯测试轮。真机 PLA-AL10（Mate 70 Pro+）通过深链 `dshremote://pair?token=..&server=..` 配对服务器 A（USB `hdc rport` 反向隧道 127.0.0.1:8787）与服务器 B（樱花内网穿透 HTTPS 隧道），在服务器管理页「设为当前」执行切换序列。
- 测试与结果：
  - 服务器 A 配对后主页实时已连接、网关正常；切换到 B（自签证书，鸿蒙系统 CA 校验拒绝）后 WS 失败自动降级轮询并显示「网关不可达」，不崩溃；切回 A 后实时连接自动恢复，WS 重连成功。
  - 快速切换序列（B→A→B→A）中「当前」标记与「已切换」提示始终一致，无状态错乱；偶发切换点击未生效（UI 忙碌期吞点击），重试即恢复，未出现状态撕裂。
  - 10MiB 随机文件按 4MiB+4MiB+2MiB 三块上传（curl 走 `/fs/upload` 协议模拟客户端分块），落盘 SHA-256 与源文件一致。
  - 中断续传：上传 1 块后中断，重新 `probe` 返回 `partialSize=4194304` 从断点续传剩余两块，finish 后 SHA-256 与源文件一致。
  - 跨 session 隔离：换新 session probe 返回 `partialSize=0`，不误读其他上传的分片。
  - 自动化回归：扩展 13 场景 Ping 组帧矩阵 + handoff 非字符串字段防御测试，`npm run check` 190 pass / 0 fail / 6 skipped。
- 联动：同步 `packages/plugin/gateway.cjs`（cmp 一致）；文档补充本次测试记录。
- 未做：鸿蒙端 DocumentViewPicker 人工选文件的完整 UI 上传（picker 目录真机自动化不可达，协议层已由 curl 等价覆盖，留用户最终验证）；心跳挂机 5-10 分钟回归未跑；测试产物（测试文件、截图）已清理，全部改动未提交。


### 2026-09-21：手机发图接入视觉辅助插件

- Remote 独立客户端不会执行 DSH Web 的 `conversation.sendSession` 插件钩子。网关现在仅在上游返回 `session/attachment-invalid` 且 `details.reason=MODEL_DOES_NOT_SUPPORT_IMAGES`（消息接收前的校验拒绝）时尝试附件桥接；成功、超时和其他错误均不触发重发。
- 对接 `xiaoyuink/dsh-image-vision` 的 `/api/dsh-image-vision/config` 和 `/attach` 契约，源码核对版本为 `a445f8437a9e1cdddaf4ded34b5d863bd1785b0d`。插件启用时将内联图片存入其附件服务，并将返回的同源 Markdown 图片引用交给模型。工具是否执行仍由模型及插件配置决定。
- 使用已配置的 DSH 上游地址与会话 Cookie，不硬编码端口，不向其他主机上传；不依赖插件仅反映默认模型的 `current-model-vision` 接口。原消息的会话、requestId、queue/steer 模式及其他内容块保持不变，只重发一次。
- 未安装、未启用或附件上传失败时明确报错，不提交缺图消息；多图中途失败可能留下已存储的附件，但不会提交部分消息。旧版本或其他同名视觉插件不保证具有相同接口。
- 验证：`tests/vision-bridge.test.js` 使用本地 HTTP 上游覆盖新旧 RPC、直接视觉输入、明确拒绝后的多图转换、身份和模式保留、插件缺失/关闭及第二张图上传失败。实际 VLM 调用和手机真机链路仍待验证。



## 手机 WebUI / Android 前端模块

### 2026-08-27：Android ASR 功能测试
- 需求：在 App 内验证小米/系统云端 SpeechRecognizer 的实际回调和 session 恢复表现。
- 方案：增加“功能测试”设置页和 `NativeAsrTest` 原生桥，前端展示并复制本地诊断日志。
- 联动：Android Manifest 增加录音权限和 RecognitionService 查询声明；不新增 DSH RPC 或第三方依赖。
- 验证：补充 ASR UI/原生桥静态契约测试，并构建 APK 检查 Java 编译。
- 未做：尚未在当前回合使用真实小米设备执行测试；结果需要用户安装后回传日志。


### 2026-09-03：可选兼容性诊断反馈
- 需求：帮助定位不同 DSH 版本的接口不兼容。
- 方案：反馈弹窗增加默认未勾选的诊断上传选项和明确的最小化数据说明。
- 联动：提交给网关的 `includeDiagnostics` 与桌面端保持一致。
- 验证：静态跨端 UI 契约测试与网关反馈全链路待执行。
- 未做：不把 ASR 本地日志或任何对话内容并入该快照。


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


### 2026-09-20：可选长按插队发送（issue #14）

- 设置 → 通用新增默认关闭的长按插队开关；开启后，繁忙时单击/回车使用所选默认方式，长按 450ms 松开使用另一种方式，移动取消。空闲时正常发送。
- 新消息直接通过 `session.prompt` 的 `mode: 'steer'` 提交；不先排队再改队列，不自动重试或静默回退。斜杠命令不能通过插队发送。
- 提交中持续提示尚未确认，3 秒未返回时提示仍在等待；`accepted: true` 仅表示 DSH 接受请求，不代表当前工具已中断。网络异常时说明可能已送达，保留草稿并提示先核对会话。
- 防止长按后的合成 click 重复发送；响应按服务器和会话隔离，避免迟到响应清空后来编辑的草稿。
- 验证：`tests/composer-steer.test.js` 覆盖开关、手势取消、重复提交、迟到响应、超时及切换服务器。Android 真机交互和真实工具中断时机仍需 RC 验收。

- 变化属于手机专属交互，还是跨端数据契约？
- 是否同步检查桌面端对应行为？
- 是否影响 localStorage、后台服务或重连状态？
- 是否覆盖无 token、同源、旧网关和网络恢复？
- 是否需要真机 RC，而不是只跑静态测试？



## 桌面 WebUI 模块

### 2026-08-26：消费自定义模型思考档位
- 需求：桌面端与手机端使用一致的模型级思考档位。
- 方案：桌面端继续读取 `session.models` 的 `reasoning.efforts`，不复制手机模型配置编辑器。
- 联动：共享 01-contracts 中的模型元数据和 `session.selectModel.reasoningEffort`。
- 验证：保留现有桌面思考菜单静态测试，随全量门禁执行。
- 未做：本次未修改桌面布局或独立设置页。


### 2026-09-03：可选兼容性诊断反馈
- 需求：让桌面用户也能在报告 DSH 接口问题时提交可分析的证据。
- 方案：反馈弹窗加入默认未选中的诊断选项及隐私说明，提交既有反馈端点。
- 联动：共享手机端、网关的 `includeDiagnostics` 契约。
- 验证：静态跨端 UI 契约测试待执行。
- 未做：不自动上传、不在浏览器保存诊断。



## 测试与真实场景 QA 模块

### 2026-08-26：模型级思考档位测试
- 需求：覆盖自定义模型思考档位的编辑、保存和选择契约。
- 方案：在模型设置静态测试中检查档位字段、增删动作、默认值和校验逻辑。
- 联动：同步检查手机源文件与插件产物，桌面端继续由推理菜单测试覆盖。
- 验证：`tests/model-settings.test.js` 新增档位契约断言，随后执行全量测试。
- 未做：没有把静态测试当作第三方真实 API 或 Android 真机验证。


### 2026-08-27：Android ASR 诊断测试
- 需求：让用户在小米手机上执行一次真实系统 ASR 测试并把日志回传。
- 方案：静态检查 `NativeAsrTest` bridge、Manifest 权限/queries、页面按钮、事件回调和报告复制。
- 联动：Android 编译验证原生 Java；真机验证回调、网络依赖、session 重建和麦克风释放。
- 验证：本地静态测试通过后运行 `npm run build-app`；用户日志作为真实小米能力证据。
- 未做：不通过测试夹具伪造系统 ASR 回调，不上传测试日志。


### 2026-08-27：小米 ASR 权限错误回归
- 真实设备报告出现 `ERROR_INSUFFICIENT_PERMISSIONS` 后，补充 AppOps/全局麦克风状态采集、系统权限设置跳转和 `EXTRA_CALLING_PACKAGE` 契约检查。
- 补充小米语音引擎设置入口契约；不把“已找到 `com.xiaomi.mibrain.speech`”误判为“用户已完成小米隐私授权”。
- 结论更新：小爱官方鉴权 SDK、唤醒 SDK 和小爱 SDK 需要另行平台配置；系统 `SpeechRecognizer` 的真机测试不能替代正式 SDK 接入验收。
- 真机复测顺序：系统设置允许 DSH Remote 麦克风 → 打开全局麦克风 → 完成小米/系统语音服务首次授权 → 回到功能测试重新运行并复制完整日志。



## Android 原生壳与后台服务模块

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

