# HarmonyOS 原生 ArkUI 客户端模块

> 状态：功能面对齐 Android 并随网关版本迭代（当前 0.6.26 / versionCode 6269，2026-09-17 对齐网关 v0.6.26；真机验收基线 2026-09-15/16）。**2026-09-17 起支持平板分栏布局**（≥600vp 走桌面端 WebUI 同构的侧栏+内容区，手机布局不变），真机冒烟通过、聊天链路平板回归待做。
>
> 工程：`harmonyos/`
>
> 应用 ID：`com.dshremote.app`（与 Android 对齐）

## 1. 模块定位

HarmonyOS 客户端是 DSH Remote 的原生 ArkUI 实现。与 Android 版（Capacitor WebView 承载 `public/`）不同，本端用 ArkTS/ArkUI 直接实现手机端功能面：服务器连接、会话、实时消息、文件、统计、设置与通知，网络层直接复用网关 HTTP/WS/文件传输契约，不依赖 WebView。

## 2. 代码结构

| 文件/目录 | 作用 |
| --- | --- |
| `entry/src/main/ets/common/Constants.ets` | 存储 key、默认端口、APP_VERSION、客户端标记等常量 |
| `entry/src/main/ets/common/Logger.ets` | hilog 封装（LOG_DOMAIN 0xD004201） |
| `entry/src/main/ets/common/I18n.ets` | 双语文案：`I18n.t('中文', 'English')` 就地成对，语言取系统语言（启动时读一次，无应用内切换） |
| `entry/src/main/ets/common/Markdown.ets` | 零依赖 Markdown 解析器（与 Web 端 md.js 同规则，产出 `MdBlock[]`） |
| `entry/src/main/ets/models/` | ServerInfo / HealthInfo / SessionView / ChatMessage / FsEntry / StatsDay / Announcement / PendingItem / WorkspaceInfo / ModelInfo / UpdateInfo / RpcPayloads / Theme 数据模型与 JSON 转换 |
| `entry/src/main/ets/components/MarkdownView.ets` | Markdown ArkUI 渲染组件（代码块/表格/链接/图片，用户与助手气泡复用） |
| `entry/src/main/ets/services/StorageService.ets` | preferences 持久化、服务器列表、clientId |
| `entry/src/main/ets/services/GatewayApi.ets` | HTTP 客户端：health、DSH RPC、events.poll、stats、fs、feedback |
| `entry/src/main/ets/services/RealtimeService.ets` | mux/host 双 WS、指数退避重连、失败降级轮询、恢复重连 |
| `entry/src/main/ets/services/AppState.ets` | 全局状态（写 AppStorage 原语驱动 UI）：服务器、健康、会话、连接模式、配对导入 |
| `entry/src/main/ets/services/PairParser.ets` | `dshremote://pair` URI 解析（重复 server 参数、token 绑定全部地址去重） |
| `entry/src/main/ets/services/ScanService.ets` | Scan Kit 扫码（scanBarcode + 相册入口） |
| `entry/src/main/ets/services/NotificationService.ets` | 本地通知发布与授权请求 |
| `entry/src/main/ets/services/BackgroundService.ets` | 退后台长时任务 + 30s 增量轮询（详见 §6.5） |
| `entry/src/main/ets/services/PeakReminderService.ets` | 峰谷计费提醒：代理提醒（闹钟型，9/12/14/18 点），1700002 未授权时降级进程内定时器 |
| `entry/src/main/ets/services/FsUploadService.ets` | 分块上传（SHA-256、upload-probe 续传、422 清理） |
| `entry/src/main/ets/services/FileExporter.ets` | 系统「另存为」导出（DocumentViewPicker save 模式，无需存储权限） |
| `entry/src/main/ets/services/ImageDecoder.ets` | 消息内 base64 图片 → PixelMap |
| `entry/src/main/ets/services/AsrTestService.ets` | ASR 语音识别诊断（AudioCapturer 16k → speechRecognizer 引擎，事件日志页） |
| `entry/src/main/ets/common/Breakpoint.ets` | 宽屏断点（≥600vp）媒体查询监听 → AppStorage('uiWide')，双形态根容器开关 |
| `entry/src/main/ets/common/AppNav.ets` | 模式感知导航 helper：手机 router / 平板 NavPathStack 双模式分发（push/back/switchMain/openChat） |
| `entry/src/main/ets/common/SessionActions.ets` | 归档/删除确认弹窗（手机端与平板侧栏共用；删除入口隐藏，上游无 session.delete RPC） |
| `entry/src/main/ets/common/SessionListLogic.ets` | 会话列表纯逻辑（过滤/排序/分组），手机端与平板侧栏共用 |
| `entry/src/main/ets/common/UiFeedback.ets` | 轻提示/确认反馈收口（替代第三方 UI 库的 Toast/Dialog） |
| `entry/src/main/ets/components/SessionContextMenu.ets` | 会话长按上下文菜单（归档/置顶/重命名等操作入口） |
| `entry/src/main/ets/components/HandoffCard.ets` | 跨端接续卡片（"在 xx 设备上打开过"，点击跳转对应会话） |
| `entry/src/main/ets/models/HandoffState.ets` | 跨端接续指针模型（对应网关 `/handoff` 单条记录，契约见 01-contracts.md） |
| `entry/src/main/ets/pages/tablet/TabletIndex.ets` | 平板分栏根：Navigation Split（navBar=侧栏，navDestination=主视图/子页路由） |
| `entry/src/main/ets/pages/tablet/TabletSidebar.ets` | 平板侧栏（对齐桌面端 ds-sidebar）：品牌/新会话/会话列表/底部导航 |
| `entry/src/main/ets/pages/ChatView.ets` | 会话详情可内嵌组件（ChatPage 的核心拆分，手机 @Entry 壳与平板分栏复用） |
| `entry/src/main/ets/pages/` | Index（双形态根 + Tabs 导航 + 系统返回拦截）与主页/会话/聊天/文件/统计/公告/设置/服务器管理/反馈/ASR 测试页 |
| `entry/src/main/resources/base/media/ic_*.svg` | 图标资源（41 个，来自用户提供的 HarmonyOS 图标包择取；语义化命名，黑色单色 + mask 结构） |
| `build.cmd` | 本机构建便利脚本（封装 DevEco CLI 路径；**含个人路径，不入库**） |
| `usb-tunnel.cmd` | USB 反向隧道一键脚本（`hdc rport tcp:8787 tcp:8787`；见 §6.3.1） |

## 3. 当前功能（已移植）

- 服务器列表增删改（URL / token / 备注 / 分组）、连接测试（`/health` + 延迟）、设为当前。
- 主页健康卡片：网关 ok、版本、upstreamOk、实时通道 mux/host 状态。
- 会话列表：`session.list` 拉取、下拉刷新、新建会话、会话卡片显示标题/运行状态/更新时间；**工作区分组折叠**（2026-09-16 新增：按 cwd 末段分组、组头显示会话数、收放带展开/收起动画，有运行中会话的组刷新后强制展开）。
- 会话详情：`session.history` 历史消息、实时事件追加（`session/event` 经 chatSink 回调）、`session.prompt` 发送、运行状态展示；消息内图片块经 `image.createImageSource` 解码 base64 为 PixelMap 渲染。
- 流式思考：`assistant/chunk` 的 `block-start/reasoning-delta/block-end` 聚合为「思考中…」气泡实时更新，`assistant/message` 或 `turn/end` 到达后由正式消息接管；**思考基线恢复**（2026-09-17 对齐网关 v0.6.26 新增）：`session/reasoning`（payload 携带 `partialReasoning` 聚合块数组）→ 直接替换本地 streamText，覆盖晚加入/重连/切后台回来时的流式进度重放（对齐 Web 端 `applyReasoningBaseline`）。
- 图片附件发送：输入栏「＋」经 `PhotoViewPicker` 选图（最多 3 张），fileIo 读取后 `Base64Helper` 编码为 `{type:'image', mediaType, data, name}` 块随 `session.prompt` 发送；附件可移除，发送后清空。
- 模型切换：`session.models` 加载分组/模型与当前模型，`session.selectModel` 切换（携带 `reasoningEffort` 默认档位），自定义 `reasoning.efforts` 档位选择，无自定义时兼容 low/high/max。
- 斜杠命令：输入 `/xxx` 时优先走 `POST /remote/api/command`（`{sessionId, line}`，网关 → 插件命令服务）；`executed:true` 视为已处理，`compact` 失败不回退文本发送，`export` 提示未移植后回退文本直接发送。
- 审批/提问：mux 通道 `approval/requested`、`question/requested` 进入待处理列表；审批允许/拒绝走 `/api/respond`（`outcome: allowed-once|rejected`），提问选择选项+补充说明后提交（`answer.answers[]`）。
- 本地通知：设置页「通知」开关持久化（`notify_enabled`）；审批/提问到达时 `notificationManager.publish` 基础文本通知，首次开启请求授权 `requestEnableNotification`。
- 扫码配对：服务器管理页「扫码配对」调系统 Scan Kit（`scanBarcode.startScanForResult`，`scanTypes: [ALL]` + 相册）；解析 `dshremote://pair` 的重复 `server` 参数，token 绑定全部地址去重导入并设为当前；CAMERA 为 user_grant 权限带 reason/usedScene。
- 主题：`models/Theme.ets` 定义四套色板（深空/落日/易北爱乐厅/草原孤塔），设置页 chips 切换并持久化 `theme` key；页面统一经 `pageBg()`/`accent()` helper 取主题色（新增颜色一律走主题，禁止硬编码品牌色）。
- 公告/投票：主页「公告」卡片 → 公告中心页（`GET /announcements.json` 公开拉取、过期过滤、未读标记、已读/投票记录持久化）；投票经 `POST /feedback`（Bearer，`{type:'poll', announcementId, pollId, optionId, appVersion}`），提交成功才记本地。
- 反馈：设置页「反馈」→ 反馈表单（类型/内容 ≤2000 字/联系方式/可选诊断开关），经 `POST /feedback`（Bearer，`{type, message, contact, appVersion, includeDiagnostics}`）。
- 后台轮询：`BackgroundService` 在 App 退后台且「通知+后台轮询」开关开启时，先申请**长时任务（continuous task）**，再每 30s 拉取 mux/host 增量事件（`/api/events.poll`），收到审批/提问即发本地通知；回到前台停止长时任务并交还原生实时链路。详见 §6.5。
- 检查更新：设置页「检查更新」读取当前服务器 `update.json`（公开接口，`hapUrl` 为预留直链字段），语义化版本比较后提示；侧载安装（不发布应用商店），下载安装由用户从发布页获取 HAP。
- 实时链路：mux/host WebSocket 双通道（downlink-only），任一通道连续失败 ≥3 次自动降级为 `/api/events.poll` 增量轮询，每 30s 尝试恢复 WS。
- 文件：目录浏览（`/fs/list`，多根切换、上级导航）、文本预览（`/fs/preview`）、下载到应用目录（`/fs/file` ArrayBuffer 落盘 fileIo）。
- 文件上传：`DocumentViewPicker` 选文件 → `cryptoFramework` 全量 SHA-256 → `/fs/upload-probe` 续传偏移 → 4MB 分块 `POST /fs/upload`（`offset/size/finish/sha256`）→ 校验 201 响应；坏分片 422 时 `/fs/upload-control` 清理。
- Token 统计：`/stats/summary?days=7` 七日总用量、每日柱状趋势（自绘 100px 高度比例）、今日四桶（input/cacheRead/cacheWrite/output）与峰/谷费用估算展示。
- **Markdown 渲染**（2026-09-15 新增）：`common/Markdown.ets`（解析器，零依赖）+ `components/MarkdownView.ets`（ArkUI 渲染组件）。支持围栏代码块（横向滚动 + 语言标记）、行内代码、#~### 标题、粗体/斜体、有序/无序列表、引用（左侧竖条）、GFM 表格（对齐方式 + 横向滚动）、`[文本](url)` 链接（点击经 `startAbility` 交给系统浏览器）。用户气泡与助手气泡复用同一组件，仅换色。
- **停止生成**（2026-09-15 新增）：会话详情页头部在 `running` 时显示红色「停止」按钮 → 二次确认 `AlertDialog` → `session.cancel {sessionId}`；失败信息回显到 `pendingNote`。
- **深链配对**（2026-09-15 新增）：`module.json5` 声明 `dshremote://pair` scheme，`EntryAbility.onCreate/onNewWant` 读 `want.uri` → `AppState.applyPairUri` → 与扫码配对同一条导入路径。
- **峰谷提醒**（2026-09-16 新增）：`PeakReminderService` 对齐 Android `PeakReminderService`。正路是**代理提醒**（`reminderAgentManager`，REMINDER_TYPE_ALARM，9/12/14/18 点四条，周末全天谷时仅保留周六日 9 点一条）；侧载应用拿不到开放能力授权（发布失败 1700002，提醒上限视为 0）时自动降级为进程内定时器兜底（应用活着时照常提醒，冻结期间无提醒，设置页注明限制）。设置页独立开关持久化。
- **双语界面**（2026-09-16 新增）：`common/I18n.ets`，`I18n.t('中文', 'English')` 就地成对文案，语言取系统语言（`i18n.System.getSystemLanguage`，启动读一次，zh 开头中文否则英文，无应用内切换）。全页面文案已覆盖。
- **文件「另存为」导出**（2026-09-16 新增）：文件页下载改为 `FileExporter.saveBytes` 走 DocumentViewPicker save 模式，系统弹出另存为，用户挑目录与文件名，返回 uri 自带读写授权，无需存储权限。
- **新建文件夹**（2026-09-16 新增）：文件页底部弹层输入目录名，`/fs/mkdir` 创建后刷新列表。
- **ASR 诊断页**（2026-09-16 新增）：设置页入口 → `AsrTestPage`。`AsrTestService` 用 AudioCapturer（16kHz/单声道/S16LE，640/1280 字节块喂 writeAudio）+ `speechRecognizer` 引擎做语音识别实测，记录 partial/final/error 计数与错误码（含 1002200008 ENGINE_DESTROYED 映射），供真机排查识别链路。
- **系统返回键分级**（2026-09-16 新增）：`Index.onBackPress` 拦截——文件页（Tab 3）先关预览面板（`filesPreviewVisible`）→ 再退上级目录（`filesPathHasParent` + `filesNavUpSeq` 信号，FilesPage @Watch 响应）；其他 Tab 先回主页；最后一级走系统默认退出。会话页返回链路同类处理。
- **v0.6.26 网关对齐**（2026-09-17）：
  - **思考基线**：处理网关新增的 `session/reasoning` mux 事件（`partialReasoning` 聚合块数组），晚加入/重连/切后台时恢复「思考中」气泡（见上）。
  - **文件页跨盘**：网关 Windows 默认根从 `~` 扩展为「用户目录 + C 盘外可用盘符」（`/fs/list` 的 `roots[]` 直接反映），鸿蒙端多根切换与上级导航逻辑本就按 `roots[]` 数据驱动，无需改动即自动获得跨盘浏览；`FS_WINDOWS_DEFAULT` 模式下网关拒绝 junction 逃逸，客户端无感。
  - **genui（dsh-ui 围栏）**：Web 端 0.6.26 起把 ```` ```dsh-ui ```` spec 渲染为图表/表格等组件。鸿蒙端**不移植解析器**（避免再造一套零依赖渲染），`MarkdownView` 将 `dsh-ui` 语言标记的代码块降级为源码展示（标注「DSH UI（源码）」），与 Web 端「无效/超预算 spec 保留源码」的兜底一致；后续需要时再评估。
  - **上传并发/提交语义**：网关修了上传 atomic commit（rename/link 而非先删后 rename）与 409 `upload-busy`/`conflict` 新错误码；鸿蒙端上传流程（probe → 分块 → 422 清理）契约不变，409 按失败处理并提示重试。
- **平板分栏布局**（2026-09-17，布局跟随桌面端 WebUI `public/desktop/desktop.html`）：
  - **双形态根容器**：`Index.ets` 按 `AppStorage('uiWide')` 分支——手机（<600vp）保持原 Tabs 悬浮胶囊布局零改动；平板（≥600vp）渲染 `TabletIndex` 的 Navigation 分栏（`NavigationMode.Split`）。断点由 `common/Breakpoint.ets` 监听媒体查询 `(min-width: 600vp)` 写入，阈值与官方 NavigationMode.Auto 一致（240+360）；**注册时机坑**：几何类媒体特征在窗口布局完成前求值恒 false、且挂在 loadContent 前的 UIContext 上收不到 change，故 Index.aboutToAppear 用页面自身 UIContext 重注册 + display 宽度/密度兜底求值（MatePad Pro 实测初值 false 的坑）。
  - **导航双模式**：`common/AppNav.ets` 收口全部路由——手机走 `router.*`，平板走 `TabletIndex` 注册的 `NavPathStack`。主视图（主页/文件/统计/设置）空栈 push、非空 `replacePathByName`（栈内恒一个主视图）；子页面（公告/反馈/ASR/服务器管理）push 叠加逐层 pop；**会话详情必须 `clear(false)+push` 强制新建实例**——同名 NavDestination replace 会复用组件实例，ChatView 的 chatSink/projectionSink 在 aboutToDisappear 才注销，复用实例会新旧会话串流。
  - **页面拆分**：`ChatPage` → 可内嵌 `ChatView`（@Prop sessionId + @Watch attachSession，返回键拦截改 `handleBack()` 供 NavDestination onBackPressed 调）+ @Entry 薄壳；四个子页面（Announcements/Feedback/AsrTest/ServerSettings）同样 `XxxView`（@Component export）+ @Entry 薄壳双形态。ArkTS 约束：路由参数用显式 `NavParams` 类（禁 untyped obj literals / 计算属性名）；`NavPathStack` 是全局声明无需 import；`getParamByName` 返回值先 `as Array<Object>` 再逐个 as NavParams。
  - **侧栏**：`TabletSidebar` 对齐桌面端 ds-sidebar（品牌 + 新会话 + 会话平铺列表 + 底部 nav 四项），navBarWidth 300（可拖 240–360）、minContentWidth 400；设计规格参照 `D:\harmony资源包\手机折叠屏平板-SKETCH.zip`（平板抽屉/TitleBar 画板）。
  - **真机冒烟**（MatePad Pro，2026-09-17）：分栏渲染、侧栏高亮联动、设置 → 服务器管理叠加 → 返回逐层回退全通过，无 crash。待办：侧栏会话列表实际数据联调、主页总览双列 grid、ChatView 聊天主链路平板回归、手机端全量回归。

### 3.1 Markdown 渲染与 Web 端 md.js 的关系

解析规则与 `public/md.js` 完全一致（块切分、表格识别、行内优先级），但产出结构化 `MdBlock[]` 而非 HTML 字符串，由 ArkUI 组件树渲染。

**两处有意的行为差异**（均为修正 md.js 的缺陷，已在代码注释与验证脚本中标注）：

1. **围栏代码块剥离首行语言标记**：md.js 的 `split('```')` 会把 ```` ```ts ```` 中的 `ts` 留在代码正文里；本实现识别并剥离，作为代码块的语言标签展示。
2. **行内代码内容受保护**：md.js 是「先替换代码、再替换粗体/斜体」的链式替换，正则会在已生成的 `<code>` 标签内继续匹配，导致 ```` `credentials.*` ```` 这类内容里的 `*` 被吃掉。本实现按「代码 > 粗体 > 斜体 > 链接」顺序扫描，代码内容不参与后续解析；粗体/斜体内部则递归解析（保留其中的行内代码与链接）。

**验证方法**（脚本为临时文件，验证后已删除）：把 `Markdown.ets` 严格 1:1 镜像为 JS，用**真实会话历史**中的 16 段助手文本（19818 字，含 6 表格 / 4 代码围栏 / 6 列表 / 6 标题）与 `md.js` 对比：

| 检查项 | 结果 |
| --- | --- |
| ① 块类型序列 | 16/16 一致 |
| ② 纯文本内容（去空白） | 12/16 一致 |
| ④ 归一化后（补回语言行 + 忽略 `*` 与反引号） | **16/16 一致** |

② 与 ④ 的差额恰好等于上述两处有意差异，无其它偏差。归一化脚本见本节描述，可复现。

## 4. 契约映射（与 [01-contracts.md](01-contracts.md) 对齐）

| 能力 | 端点 | 说明 |
| --- | --- | --- |
| 健康 | `GET /health` | `ok / version / upstreamOk / events.mux / events.host` |
| RPC | `POST /api/{method}` | body `{type:'client-request', rpcId, method, payload}`，Bearer 头；响应取 `result.value` |
| 应答 | `POST /api/respond` | `{type:'client-response', rpcId, result:{ok:true,value}}`（审批/提问） |
| 实时 | `ws(s)://host/api/events.{mux\|host}?token=…&client=app&clientId=…` | 只下行，客户端不发送应用层心跳 |
| 轮询 | `GET /api/events.poll?kind=…&since=…&wait=25000` | `truncated/latestSeq` 处理游标重置 |
| 文件 | `/fs/list /fs/preview /fs/upload-probe /fs/upload-control /fs/upload` | Bearer 保护，分块+续传（移植中） |
| 统计 | `GET /stats/summary?days=7` | 四桶 token 与费用 |

### 4.1 逐字段实测契约（2026-09 对 v0.6.24 网关抓包核对）

客户端解析必须以真机抓到的结构为准，不得凭直觉假设"数组/顶层字段"。已实测：

| RPC / 端点 | `result.value` 顶层 | 关键字段路径 |
| --- | --- | --- |
| `session.list` | `{ items: [ … ] }`（**对象，不是数组**） | 项：`sessionId / updatedAt / running / blank / cwd / parentSessionId? / origin? / projections` |
| `session.list` 标题 | — | **标题在 `projections.values.title`，顶层没有 `title`**；`projections.values.sessionListMetadata.lastPromptAt` 为最近提示时间 |
| `session.list` 顶层过滤 | — | `!parentSessionId && origin !== 'subagent'`（同 `public/app.js` 的 `isTopLevelSession`）；实测 103 条中仅 65 条为顶层 |
| `session.list` 状态 | — | **没有 `status` 字段**；运行态只看 `running` |
| `session.history` | `{ events: [ { event } ], hasMore, projections }` | `events[].event.type ∈ {user/message, assistant/message, step/*, tool/*, turn/*, …}` |
| `user/message` | — | `data.role / data.content[].{type:text,text}`（**没有 `data.message`**） |
| `assistant/message` | — | `data.message.content[]`，块类型仅 4 种：`reasoning` / `text` / `tool-call` / `image` |
| `session.prompt` | — | `{ sessionId, mode:'queue', content:[{type:'text',text} \| {type:'image',mediaType,data,name}] }` |
| `session.selectModel` | `{ selected }` | `{ sessionId, provider, model, reasoningEffort? }` |
| `/health` | — | `events.mux` / `events.host` 是**对象** `{connected,lastEventAt,reconnects,…}`，不是布尔；`readiness.eventsOk = mux.connected && host.connected` |
| `/stats/summary` | `{ ok, days[] }` | 日项 `{date, total:{input,cacheRead,cacheWrite,output,cost}, peak:{cost}, off:{cost}}` |
| `/fs/list` | `{ path, entries[], roots, platform, separator }` | 条目 `{name,path,type,size,mtimeMs}`，`type ∈ {dir,file}` |

**已修复的契约偏差**（均为真机"会话加载不出来"的直接原因）：

1. `SessionView.fromRpcValue` 曾把 `result.value` 当裸数组 `for...of` 迭代 → 对象不可迭代抛异常被 `catch` 吞掉 → 列表恒为空。现兼容 `{items:[]}` 与裸数组两种形态。
2. 标题只读顶层 `title`（实际为 `undefined`）→ 全部显示"新会话"。现回退到 `projections.values.title`。
3. `status` 字段不存在 → 状态行空白。现由 `running / blank` 推导。
4. 未过滤子代理会话 → 列表中混入大量 `origin:'subagent'` 会话。现与 Web 端一致只显示顶层。
5. `HealthInfo` 把 `events.mux` 当布尔读 → 实时指示灯恒为断开。现读 `mux.connected`（并兼容旧版布尔网关）。

## 5. 与 Android 壳能力对照

| Android 能力 | HarmonyOS 对应 | 状态 |
| --- | --- | --- |
| 系统更新下载/安装 | 应用市场更新或 `appUpdater`（待定） | 未做（检查+提示已有，安装走发布页侧载） |
| 后台轮询前台服务 | `@ohos.backgroundTaskManager` 长时任务（continuous task） | ✅ 已做（场景归类见 §6.5） |
| 峰谷提醒 | 代理提醒 `reminderAgentManager`（1700002 时降级进程内定时器） | ✅ 已做（见 §3 峰谷提醒） |
| 拍照/相册图片 | `PhotoViewPicker` 相册 + `cameraPicker` 拍照发图 | ✅ 已做（相册 2026-09-15、拍照 2026-09-16） |
| 扫码配对 | `@ohos.multimedia.scanBarcode`（Scan Kit） | ✅ 已做（2026-09-15） |
| ASR 诊断 | `speechRecognizer` + `AudioCapturer`（AsrTestPage） | ✅ 已做（2026-09-16，诊断用途） |
| 文件导出到系统目录 | `DocumentViewPicker` save 模式「另存为」 | ✅ 已做（2026-09-16） |
| deep link 配对 | `dshremote://pair` scheme + `want.uri` 路由 | 已做 |

## 6. 移植阶段

1. ✅ 工程建立与基础层（Constants/Logger/Models/Storage/GatewayApi）
2. ✅ 实时链路（双 WS + 降级轮询）与全局状态
3. ✅ 导航骨架与服务器管理
4. ✅ 会话列表 → 会话详情（历史/实时消息/输入/审批/提问/模型切换/思考档位/斜杠命令；export 导出未做）
5. ✅ 文件浏览/预览/下载（另存为）/分块上传/断点续传/新建文件夹
6. ✅ 统计图表、主题、双语、公告/投票、反馈表单
7. ✅ 本地通知、扫码配对、深链配对、后台轮询、检查更新
8. ✅ 峰谷提醒（代理提醒+降级）、拍照发图、ASR 诊断、系统返回键分级（2026-09-16）

## 6.1 平台限制与遗留

- 应用内更新为「检查 + 提示」：鸿蒙消费设备不支持普通应用静默安装 HAP，侧载需用户在发布页下载后手动安装（签名一致）。
- 会话导出（`/export`）按需扩展。
- 峰谷提醒降级限制：未获代理提醒授权时，应用被冻结/退出期间无法提醒（进程内定时器只在应用存活时有效），设置页已注明。

## 6.2 UI 组件库与图标

- **设计基准**：鸿蒙 7（API 26.0.0）设计风格与动效规范与本项目落点，见 [../harmonyos-design-reference.md](../harmonyos-design-reference.md)。
- **组件**：仅用系统 ArkUI 组件（`Toggle` / `Button` / 自绘空态等），运行时零第三方依赖——曾短暂引入的 `@ibestservices/ibest-ui-v2` 已移除（项目硬性约束：不引第三方库）。
  - 设置页开关 = 系统 `Toggle`（`selectedColor` 走主题强调色）；聊天发送 = 系统 `Button`（sending 置灰由 `enabled` + `opacity` 表达）。
  - 会话空态自绘（对齐 FilesPage 空目录样式）；`EntryAbility` 不再做组件库初始化。
- **图标**：`entry/src/main/resources/base/media/ic_*.svg`（41 个，取自用户提供的 HarmonyOS 图标包，语义化命名，黑色单色 + mask 结构）。
  - 用法：`Image($r('app.media.ic_xxx')).width(20).height(20).fillColor(主题色)`；`fillColor` 覆盖 SVG 填充实现主题着色。
  - 新增图标优先择取包内 `ic_public_*` 系列并按语义重命名；资源名必须小写字母/数字/下划线，不得保留 UUID 或空格。

## 6.3 真机联调网络（校园网 / 客户端隔离）

实测环境：电脑 `10.150.7.26/16`（`usywireless`，网络类别 Public），手机 `10.150.7.14/16`。

| 检查项 | 结果 | 结论 |
| --- | --- | --- |
| 电脑 `curl http://10.150.7.26:8787/health` | 200 | 网关监听 `0.0.0.0` 正常，不是绑定问题 |
| 手机 `ping 10.150.7.26` | 100% 丢包 | 手机到电脑不通 |
| 电脑 `ping 10.150.7.14` | 100% 丢包 | 反向也不通 |
| 手机 `/proc/net/arp` 中电脑条目 | `flags 0x0`（incomplete） | 手机的 ARP 请求得不到应答 → **二层被隔离** |
| `frp-box.com:12198` | 无响应（`curl` code 000） | 内网穿透未运行 |

结论：校园 WiFi 存在**客户端隔离（AP isolation / 端口隔离）**，手机与电脑虽然同网段、ARP 表里互相"看得见"，但客户端之间无法建立连接。**这类网络下必须走内网穿透**（或下面的 USB 隧道），改 App 代码无用。

同时确认：Windows 防火墙的 Public 配置为 `Enabled=False`（活动网络正是 Public），因此**本机无需为 8787 加入站规则**。若网络类别被改成专用/域，才需要：

```powershell
New-NetFirewallRule -DisplayName "DSH Remote 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Any
```

### 6.3.1 USB 反向隧道（无需穿透，最稳的联调方式）

穿透不可用、或不想把网关暴露到公网时，用 hdc 把手机的回环端口反向接到电脑：

```bash
hdc rport tcp:8787 tcp:8787          # 手机 127.0.0.1:8787 -> 电脑 127.0.0.1:8787
hdc fport ls                         # 确认列表里有 "tcp:8787 tcp:8787 [Reverse]"
hdc shell "netstat -an | grep 8787"  # 手机上应看到 127.0.0.1:8787 LISTEN
```

然后在 App 的「服务器管理 → 新增服务器」里填地址 `127.0.0.1:8787` + 网关 token，即可在校园网/隔离网下正常联调。
注意：`hdc rport` 会随 USB 断开或 hdc server 重启而失效，每次重插需要重新执行。

### 6.3.2 让配对二维码带上隧道地址

管理页的配对二维码只包含「主机 IP 地址」列表里启用的地址。要让它带上 `127.0.0.1:8787`：

1. 打开 `http://127.0.0.1:3080/remote/admin/`（插件内嵌管理页，走 DSH 登录态，**不需要 Remote token**）；独立网关模式则是 `http://127.0.0.1:8787/admin`（需要 token）。
2. 在「主机 IP 地址」区域用「添加」填入 `127.0.0.1` 并勾选启用。
3. 点显示配对二维码 → 手机「服务器管理 → 扫码配对」扫描即可一次性导入地址与 token。

### 6.3.3 真机排障：读 App 的配置与日志

```bash
# 读 App 实际保存的服务器与 token（能读，不能写，SELinux 限制）
hdc shell "cat /data/app/el2/100/base/com.dshremote.app/haps/entry/preferences/dsh_remote"

# 读 App 日志（Logger 统一走 hilog，域名 D004201，标签 DSHRemote）
hdc shell "hilog -x" | grep -i "DSHRemote\|会话加载\|网关不可达"
```

`Constants.LOG_DOMAIN` **必须非 0**：早期取 `0x0000`，hilog 会直接丢弃这些日志，导致真机上完全抓不到线索。

## 6.4 真机验收记录（2026-09-15，HarmonyOS 真机，USB 反向隧道）

首轮真机联调走 USB 反向隧道（`hdc rport tcp:8787 tcp:8787`），App 服务器 `http://127.0.0.1:8787`。

**实测通过**：

| 项 | 结果 |
| --- | --- |
| 会话列表 | 65 条顶层会话正常渲染：标题（来自 `projections.values.title`）、工作区名（cwd 末段）、状态（运行中/空闲/空白会话）、相对时间（8 分钟前 / 18:56 / 13:15）全部正确，按 `updatedAt` 倒序，子代理已过滤 |
| 会话详情 | 历史消息完整加载；`reasoning` 渲染为「思考过程」折叠块（默认 3 行 + 展开）；`tool-call` 渲染为工具摘要行 |
| 实时链路 | `stream open mux` / `stream open host` 双通道握手成功 |
| 统计 | `/stats/summary` 正常，页面显示「近 7 日 Token 总量」 |
| 深链配对 | `aa start -U 'dshremote://pair?...'` → 日志 `pair deep link imported=1`，服务器切换为 `http://127.0.0.1:8787`（零点击配置） |

**修复的真机暴露问题**：

1. **「实时已连接」是假的**：`RealtimeService.start()` 在 socket 创建前就 `setMode('ws')`，连接全失败也显示已连接，误导排查。现改为 `start()` 置 `connecting`，仅 `open` 回调置 `ws`，并用 `openedKinds` 集合跟踪；两个通道都掉线时回落 `connecting`（日志 `all streams down, back to connecting`）。`AppState.onModeChanged` 同步补齐 `connecting/error/idle` 文案。
2. **`Logger.warn('stream error ' + err.message)` 打出 `undefined`**：`error` 回调里 `err` 可能为空，改为判定后再取值。
3. **`EntryAbility` 自己的 hilog 用 `DOMAIN = 0x0000`**（日志被丢弃），改为 `Constants.LOG_DOMAIN`。

**待查（非阻塞）**：隧道下 WS 约 **60 秒**被断开一次（日志 `stream error mux undefined` → `stream close mux code=0` → 2 秒后自动重连）。网关侧心跳是 Ping 30s / Pong 超时 90s（`startWsClientHeartbeat`，收到任何 data 都算活跃），按此不应在 60s 断开；怀疑是 `hdc rport` 隧道的空闲/寿命限制，需在局域网或内网穿透下复测确认。

## 6.5 后台常驻：长时任务（continuous task）

对应 Android 的 `RemotePollService`（前台服务 + `FOREGROUND_SERVICE_DATA_SYNC`）。HarmonyOS **没有前台服务等价机制**，只能用长时任务。

**配置**（已进包验证，见 `entry/build/.../entry-default-signed.hap` 内 `module.json`）：

```json5
// module.json5
"requestPermissions": [{ "name": "ohos.permission.KEEP_BACKGROUND_RUNNING" }],
"abilities": [{ "name": "EntryAbility", "backgroundModes": ["dataTransfer"] }]
```

**实现**（`services/BackgroundService.ets`）：

| 步骤 | API |
| --- | --- |
| 申请 | `wantAgent.getWantAgent({wants:[EntryAbility], actionType: START_ABILITY, …})` → `backgroundTaskManager.startBackgroundRunning(ctx, ['dataTransfer'], agent)` |
| 保活 | 每 `CONTINUOUS_REFRESH_MS`（5 分钟）`updateBackgroundRunning(ctx, ['dataTransfer'])` |
| 释放 | `backgroundTaskManager.stopBackgroundRunning(ctx)` |
| 诊断 | `on('continuousTaskCancel' / 'continuousTaskSuspend' / 'continuousTaskActive')` 全部打日志 |

**平台约束（必须知道）**：

1. **长时任务是场景白名单制**：枚举只有 `DATA_TRANSFER` / `AUDIO_PLAYBACK` / `AUDIO_RECORDING` / `LOCATION` / `BLUETOOTH_INTERACTION` / `MULTI_DEVICE_CONNECTION` / `VOIP` / `TASK_KEEPING`（仅 PC/2in1）/ `AV_PLAYBACK_AND_RECORD` / `SPECIAL_SCENARIO_PROCESSING` / `NEARLINK`。**没有"纯事件轮询"这一档**，本应用取语义最接近的 `dataTransfer`。
2. **`DATA_TRANSFER` 有硬性保活要求**：超过约 10 分钟不更新进度，系统会以 `SYSTEM_CANCEL_DATA_TRANSFER_LOW_SPEED` 取消该任务 → 因此有 `refreshContinuous()`。
3. 本应用为**侧载分发（不发布应用商店）**，场景归类不涉及商店审核；若将来上架需重新评估（`VOIP`/`TASK_KEEPING` 等场景会被驳回）。
4. 申请失败**不阻塞功能**：`isContinuous()` 返回 false 时退化为普通 `setInterval`，并把这个结果落盘（`KEY_CONTINUOUS_STATE`），设置页「后台轮询」一行会显示「长时任务已获批（绿色）/ 未获批可能被挂起（灰色）」。

**其他对齐 Android 的后台行为**：

- **登录失效自停**：轮询连续 3 次 401 → 置 `KEY_LOGIN_EXPIRED` 并停止轮询；设置页红字提示重新扫码配对；重新保存/配对服务器时清除该标记。
- **任务完成通知**：`agent/status(running=false)`、`host/session-status(running=false)`、`host/agent-error` → `notifyTaskDone`（对应 Android 的 `notify_task_done`）。

## 7. 边界与禁止事项

- 不复制 WebUI 逻辑到鸿蒙端之外的地方；WebUI 仍是现行主客户端，契约变更需同步检查两端。
- 不新增运行时依赖：鸿蒙端全部使用系统 ArkUI 组件与系统 SDK，不引第三方库（`@ibestservices/ibest-ui-v2` 例外已撤销并移除）；其它端维持零依赖。
- 不在鸿蒙端发明 DSH RPC；以 [01-contracts.md](01-contracts.md) 和 DSH Web 可见行为为准。
- token/API key 只存 preferences 与请求头，不写入日志、通知或反馈。
- 编译验证由 DevEco Studio 执行；未真机验证不宣称能力已完成。

## 8. 命令行构建（DevEco CLI 已验证）

DevEco Studio 安装目录下自带工具链（`tools/hvigor/bin/hvigorw.bat`、`jbr/bin`、`sdk`），以下 `%DEVECO%` 按本机安装路径代入：

```bat
set DEVECO=<DevEco Studio 安装目录>
set PATH=%DEVECO%\jbr\bin;%DEVECO%\tools\node;%PATH%
set DEVECO_SDK_HOME=%DEVECO%\sdk
cd /d <工程根>/harmonyos
%DEVECO%\tools\hvigor\bin\hvigorw.bat assembleHap --mode module -p module=entry@default -p product=default
```

- `local.properties` 需含 `sdk.dir=<DevEco Studio 安装目录>/sdk/default`（该文件在 `.gitignore`，各人本机自建）。
- 仓库不携带 `build.cmd`（个人便利脚本）；需要时可按上述命令自行封装。
- 产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`（入库工程 `signingConfigs` 为空；真机安装需先按 §9 配置签名）。

## 9. 签名与真机安装

### 9.1 DevEco 自动签名（推荐）

1. DevEco Studio 打开 `harmonyos/` 工程，登录华为开发者账号；
2. `File → Project Structure → Signing Configs`，勾选 **Automatically generate signature**；
3. DevEco 会生成调试证书并写回 `build-profile.json5` 的 `app.signingConfigs`；
4. 点击 `Run` 或执行 `Build → Build Hap(s)/App(s)`，产物为已签名 HAP。

> **入库纪律**：DevEco 写回的 `signingConfigs` 含本机用户名路径、证书路径与（加密的）密钥口令，属个人信息。**提交前清空 `signingConfigs` 为 `[]` 并去掉 products 对它的引用**，每个开发者本地用自动签名重新生成。

### 9.2 手动签名物料

`build-profile.json5` → `app.signingConfigs` 追加：

```json5
{
  "name": "default",
  "type": "HarmonyOS",
  "material": {
    "storeFile": "signing/dshremote.p12",
    "storePassword": "<加密后的密码>",
    "keyAlias": "dshremote",
    "keyPassword": "<加密后的密码>",
    "signAlg": "SHA256withECDSA",
    "profile": "signing/dshremote.p7b",
    "certpath": "signing/dshremote.cer"
  }
}
```

物料由 `Build → Generate Key and CSR` 与 AGC 控制台申请调试/发布证书后获得；签名不一致会导致安装被拒。

### 9.3 hdc 安装与启动

```bash
hdc list targets                                   # 确认设备已连接（需开发者模式 + USB 调试）
hdc install entry/build/default/outputs/default/entry-default-signed.hap
hdc shell aa start -a EntryAbility -b com.dshremote.app
hdc shell hilog | grep DSHRemote                   # 查看运行日志
hdc uninstall com.dshremote.app
```

### 9.4 真机验收清单

| 项 | 验证方式 |
| --- | --- |
| 启动与主题 | 冷启动进入主页，四套主题切换后重启仍保留 |
| 服务器连接 | 手动填写 `http://<局域网IP>:8787` + 令牌，主页显示网关/上游/mux/host 状态 |
| 扫码配对 | 网关管理页二维码 → 「扫码配对」应导入全部地址并连接 |
| 会话 | 列表可下拉刷新、新建；进入详情能加载历史并实时收到新消息 |
| 审批/提问 | 桌面触发工具审批 → 手机通知 + 聊天页「待处理」可允许/拒绝、回答提问 |
| 模型/档位 | 「模型」面板可切换模型与思考档位，下一次回复按新模型执行 |
| 文件 | 目录浏览、文本预览、另存为导出；上传（分块+续传）、新建文件夹后主机可见 |
| 图片 | 相册选图或拍照发送后，会话中显示发送的图片；收到图片消息可渲染 |
| 峰谷提醒 | 开启后到提醒时段（9/12/14/18 点）收到通知；设置页显示代理提醒获批/降级状态 |
| 统计/公告 | 统计页显示 7 日柱状与今日费用；公告中心可查看并投票 |
| 系统返回 | 文件页：先关预览面板 → 再退上级目录；其他 Tab 先回主页；主页最后一级退出 |
| 弱网恢复 | 断开 Wi‑Fi 数秒后恢复：先降级轮询，随后回到实时通道 |

> 真机行为（相机、通知、后台限制）不能由静态构建结果替代，必须逐项记录。

## 10. 测试与验收

- 「功能完成」判定：DevEco Studio 同步成功、无 ArkTS 编译错误；真机/模拟器可连接本地网关完成服务器配对与主页/会话查看。
- 动画/过渡/观感类改动（如会话页收放动画）：验证分工为「构建 + `hdc install -r` 装机 → 用户自行真机体验」，不逐帧截图验证（2026-09-16 约定）；功能性行为（开关回退、数据正确性）仍逐项真机验证。
- 后续每个阶段在 DevEco 中人工验证，不依赖静态声明。

## 10.1 未决事项

- **删除会话入口隐藏**：`SessionActions.confirmDelete` 链路已就绪，但 DSH 上游无 `session.delete` RPC（Blank-not-black/dsh-Remote#11），长按菜单中的删除入口暂不显示；上游提供后把确认弹窗挂回菜单即可。
- **跨端接续 `/handoff` 契约登记**：`HandoffState`/`HandoffCard` 消费网关 `/handoff`（GET/PUT/DELETE，7 天过期，clientId 排除自己写入），网关侧为本次工作区新增；正式提交前需在 01-contracts.md 完成登记。

## 11. 入库与隐私清理指引（提交前必读）

`harmonyos/` 面向上游开源仓（MIT），以下文件含个人信息或机器绑定信息，**`git add` 前必须处理**：

| 文件 | 泄露内容 | 处理方式 |
| --- | --- | --- |
| `build-profile.json5` | `signingConfigs` 内的用户名路径（`C:\Users\<你>\.ohos\...`）、证书 `.cer/.p7b/.p12` 路径、加密的 key/store 口令 | 清空为 `"signingConfigs": []`，并删掉 products 里的 `"signingConfig": "default"` 引用；各人本地用 DevEco 自动签名重新生成（§9.1） |
| `build.cmd` | 本机 DevEco 安装路径与工程绝对路径 | 不提交（加 .gitignore 或直接不入库；构建命令见 §8） |
| `local.properties` | `sdk.dir` 本机路径 | 已在 `harmonyos/.gitignore`，确认 git 忽略生效即可 |
| `usb-tunnel.cmd` | 本机 hdc 绝对路径（无密钥） | 可提交前把 hdc 路径改为提示用户编辑，或暂不提交 |

源码（`.ets`、`AppScope`、`resources`）已核查：无硬编码 token/IP/邮箱/手机号/用户名；`ServerSettingsPage` 中的 `192.168.1.10:8787` 是输入框占位示例，属正常文档性质。token 运行时只存设备 preferences，不进仓库。
## 12. 变更记录

### 2026-09-19：移除第三方 UI 库，回归系统组件与零依赖
- 需求：PR #12 评审（原作者）指出 `@ibestservices/ibest-ui-v2` 违反仓库零依赖硬约束，要求移除并清理 manifest/锁文件；同步修复评审的 P1 大文件上传 offset 损坏与三个 P2 竞态。
- 方案：`IBestSwitch`→系统 `Toggle`（selectedColor 走 Theme 令牌）、`IBestButton`→系统 `Button`（sending 用 enabled+opacity）、`IBestEmpty`→自绘空态（对齐 FilesPage）、`EntryAbility` 删除 `IBestInit`/`IBestSetUIBaseStyle`；`oh-package.json5` dependencies 清空，锁文件经 ohpm install 重生成（0 处 ibest）。并发竞态统一解法：异步操作发起前捕获 generation/socket 实例，响应回来先验身份再处理（`RealtimeService.ownsStream()`）；上传 session 在首次 probe 前确定性派生（djb2 目录+文件名）。
- 联动：根 AGENTS.md 硬性约束 1 补鸿蒙条款并记教训；新增目录内守则 `harmonyos/AGENTS.md` 与 `harmonyos/README.md`；网关侧改动（客户端 Ping→Pong 应答、flavor 探测失败保持 unknown、subagent 会话跳过 follow、/handoff 端点）见 02-gateway.md 变更记录。
- 验证：8MiB 前后分块异构文件端到端 SHA-256 一致（0a2da451…）；续传探测命中 4MiB 分片、offset-mismatch 409；断线重连/Pong 心跳真机通过；`npm run check` 189/0；UI 走查（Toggle 交互、深色切换、发送链路 turn/start→user/message→turn/end）真机通过。
- 未做：A/B 双服务器真机快速切换（仅服务器语义层验证）；删除会话入口待上游 RPC（见 §10.1 未决事项）。
