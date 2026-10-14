# 手机 WebUI / Android 前端模块

> 源码核对：2026-10-12，仓库 0.7.4；源码能力与历史验收分开说明。[文档首页](../README.md)。

> 状态：现行主客户端
>
> 源码：`public/index.html`、`public/app.js`
>
> 运行环境：移动浏览器、Capacitor Android WebView、DSH 插件内嵌页面

## 1. 模块定位

手机端是远程操作入口，优先解决“现在是否正常、有没有待处理事项、能否继续工作”。它负责会话、文件、主页、插件管理、设置、通知和扫码连接，不负责替代网关的安全判断或 DSH 内部命令实现。

## 2. 代码结构

| 文件/区域 | 作用 |
| --- | --- |
| `index.html` | 五个主视图、设置子页、弹窗、文件/会话 DOM 和内置中英文本 |
| `app.js` 初始化/API | localStorage、Capacitor 能力、HTTP/WS RPC、连接恢复 |
| `app.js` 服务器区 | `servers-v2` 分组、测速、自动选优、扫码导入 |
| `app.js` 会话区 | 顶层会话、历史、实时事件、思考流、队列、目标和子代理 |
| `app.js` 文件区 | 工作区、预览、Range/分块上传、暂停/取消 |
| `plugin-center.js/css` | 独立插件管理页、安装详情、配置启停、运行状态与操作记录；桌面复用为独立页面 |
| `app.js` 更新/公告/反馈区 | 版本比较、公告轮询、投票、反馈和隐私处理 |

## 3. 当前功能

- 会话、文件、主页、插件、设置五个主页面。
- 服务器分组、多地址扫码、手动选择、自动测速，按地址与 token 隔离连接。
- 会话/历史/思考流、审批/提问、模型与思考档位、目标、子代理与队列。
- 相机/相册图片附件；可选长按插队，失败保留草稿。
- DSH 提供方、凭据状态、模型目录、发现与自定义 reasoning 元数据编辑。
- 文件多根、预览、下载、分块/续传/暂停/取消及 SHA-256。
- 插件中心、只读洞察、主题、公告/投票、反馈与更新。
- 弱网模式、本地历史缓存与窗口化渲染；Android 系统桥按存在性使用。

## 4. 具体实现方式

`state.server` 为空时表示同源；`apiUrl()` 统一拼接请求地址。`servers-v2` 保存全部服务器及其 token，`serverCandidates()` 和 `serverLatency` 按地址+token 区分测速身份，`selectFastestServer()` 更新当前组的实际地址与 token。

连接地址或令牌的任何变化都会递增连接代数，清空旧会话/历史/文件状态并关闭旧插件操作界面。列表读取还校验请求序号，防止同一连接上旧请求覆盖新结果。创建工作区在每个异步步骤后校验原连接，切换后停止后续创建操作。离线会话与聊天记录按地址和令牌的 SHA-256 分区；无法归属的 V1 缓存不再读取。

插件管理绑定当前主机 profile，包名和明确版本在服务端校验。配置修改后提示重启 DSH，不自动重启；安装、更新和卸载任务在主机执行，关闭页面后可继续查询。不能确认 profile/CLI 时仅查看状态，核心插件通过主机维护流程管理。

模型配置页先并行读取 `llm.providers` 和 `settings.describe`，再用 `credentials.describe` 获取各凭据的配置状态。编辑器根据设置 namespace、路径和生效值构造表单；保存时用 `settings.mutate` 写入非秘密设置，用 `credentials.set/unset` 单独处理 API key。密钥输入框是 password，只在提交请求体中短暂存在，不进入 localStorage、URL 或页面缓存。模型发现结果需要用户选择后才加入目录。

每个模型条目都可以编辑 `reasoning.efforts`，每个档位包含稳定的 `id`、显示用 `name` 和可选 `description`，并可选择 `defaultEffort`。档位值校验为字母、数字、点、下划线、冒号和连字符，单模型最多 12 档；清空后恢复提供方默认行为。会话中的“思考深度”菜单直接读取当前模型的这些元数据，选择后调用既有 `session.selectModel`，实际第三方请求字段由 DSH 适配器处理。

`applyPairUrl()` 校验 `dshremote://pair`、token 和全部 `server` 参数，使用 `getAll()` 读取多地址，去重后逆序插入以保持二维码顺序，第一个作为当前连接；同地址已有其他 token 时新增连接条目。配对成功后保存 token/服务器、重绘并调用 `syncBgConfig()`。公告投票优先经网关提交，网关无地址、网络失败或返回 401 时直连公网收集器托底；普通反馈不走该回退。

实时连接按 `generation` 判断旧连接，mux/host 各自维护重试状态。连续失败时进入 poll mode；轮询用每通道 `since` 序号取增量事件，恢复检查通过后再开启 WS。客户端不发送应用层心跳，遵守 DSH downlink-only。

首页 DSH 可达状态优先读取当前网关 `/health.upstreamReachable`，`host.describe` 只补充版本、目录和会话数。首次 RPC 失败会退避重试，并在双 WS 恢复后立即补查，不能把一次启动竞态固化成“DSH 离线”。

反馈弹窗的“附带兼容性诊断日志”默认不选；用户主动选择后只传 `includeDiagnostics: true`，由网关在提交瞬间生成脱敏快照。客户端不读取、不拼接 token、Cookie、会话内容或本机文件路径到反馈。

会话列表只展示顶层会话；内部子代理保留在数据层并在主会话卡片中折叠展示。历史和实时事件使用相同过滤规则，避免插件/目标来源的 user/message 被误显示为用户输入。

图片发送使用 DSH `session.prompt` 的 content 图片块；文件上传使用 4MB 分块和 SHA-256。Android 可用时通过 `NativeUpdate`、`NativeFile`、`NativeBackground` 处理安装更新、下载和后台轮询。

文件树路径函数同时识别 POSIX、Windows 盘符和 UNC 路径，按网关返回的分隔符拼接并把“上一级”限制在当前文件根/工作区内。网关声明多个允许根时，文件页工作区选择器同时提供这些根；切换服务器会清空旧主机的路径、根和工作区选择，避免把 Linux `/` 发给 Windows。

功能测试页保留标题、导航与返回，Android ASR 页面/桥已移除；旧记录中的 ASR 仅用于历史追溯。

共享 history.js 提供 180 条渲染窗口、分页、IndexedDB 与受限 localStorage 缓存，连接身份分区。network.js 决定 weak/normal/auto 超时与历史页大小，mux/host 由 PollLoop 分别长轮询。发送/队列/目标/模型凭据保存各自捕获原会话与连接；失败保留草稿，旧 finally 不解锁新请求。见[客户端使用](../usage.md)。

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

## 8. 测试与验收

- `tests/user-flows.test.js`：文本、图片、实时、审批、提问、会话、文件和管理全链路。
- `tests/network-regression.test.js`：WS、轮询、服务器状态、扫码结构和交互回归。
- `tests/reasoning-ui.test.js`、`session-list-ui.test.js`、`workspace-files-ui.test.js`：会话显示和工作区。
- `tests/mobile-select-peak-reminder.test.js`：移动选择器和通知桥接逻辑。
- 普通浏览器无法替代 Android 相机、deep link、通知和后台服务真机验证。

## 9. 修改前检查清单

- 是手机交互还是跨端契约？是否检查桌面对应行为？
- 是否影响服务器身份、缓存迁移、后台配置和旧请求归属？
- 同源、旧网关、无 token、网络恢复和拒绝权限是否合理？
- 是否同步根 public 与插件产物，并区分自动测试/真机证据？

## 10. 未决事项

- 当前 `app.js` 仍是零构建单文件前端，未来可按功能拆文件，但必须先定义构建/同步边界，不能在未定方案时引入打包器。

历史变更见[模块历史记录](../archive/module-changes.md)。
