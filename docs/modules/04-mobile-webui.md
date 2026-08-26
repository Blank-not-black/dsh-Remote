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

- 服务器分组、备注、手动选择和自动测速选优。
- 实时摄像头扫码、拍照/相册扫码、本地 `jsQR` 解码和系统 deep link 配对。
- 扫码导入 token 与全部 `server` 地址，旧单地址二维码兼容。
- mux/host WebSocket 双通道，失败后降级为事件轮询，恢复后重连 WS。
- 会话列表、工作区筛选、创建/重命名/归档/停止、目标、子代理和队列消息。
- 历史消息、图片附件、实时回复、思考流、审批和提问响应。
- 文件浏览、文本/Markdown 预览、下载、分块上传、续传、暂停和取消。
- 首页运行状态、统计、公告/投票、反馈、主题、更新和通知设置。

## 4. 具体实现方式

`state.server` 为空时表示同源；`apiUrl()` 统一拼接请求地址。`servers-v2` 保存全部服务器，`serverCandidates()` 决定测速范围，`selectFastestServer()` 仅更新当前组的实际连接地址。

`applyPairUrl()` 校验 `dshremote://pair`、token 和全部 `server` 参数，使用 `getAll()` 读取多地址，去重后逆序插入以保持二维码顺序，第一个作为当前连接。配对成功后保存 token/服务器、重绘并调用 `syncBgConfig()`。

实时连接按 `generation` 判断旧连接，mux/host 各自维护重试状态。连续失败时进入 poll mode；轮询用每通道 `since` 序号取增量事件，恢复检查通过后再开启 WS。客户端不发送应用层心跳，遵守 DSH downlink-only。

会话列表只展示顶层会话；内部子代理保留在数据层并在主会话卡片中折叠展示。历史和实时事件使用相同过滤规则，避免插件/目标来源的 user/message 被误显示为用户输入。

图片发送使用 DSH `session.prompt` 的 content 图片块；文件上传使用 4MB 分块和 SHA-256。Android 可用时通过 `NativeUpdate`、`NativeFile`、`NativeBackground` 处理安装更新、下载和后台轮询。

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
- 不把普通竖向滚动误判为拖拽；手势改动要保留正常滚动和边缘自动滚动。
- UI 不能把 token、设备密钥或联系方式写入公开反馈/日志。

## 8. 测试与验收

- `tests/user-flows.test.js`：文本、图片、实时、审批、提问、会话、文件和管理全链路。
- `tests/network-regression.test.js`：WS、轮询、服务器状态、扫码结构和交互回归。
- `tests/reasoning-ui.test.js`、`session-list-ui.test.js`、`workspace-files-ui.test.js`：会话显示和工作区。
- `tests/mobile-select-peak-reminder.test.js`：移动选择器和通知桥接逻辑。
- 普通浏览器无法替代 Android 相机、deep link、通知和后台服务真机验证。

## 9. 修改前检查清单

- 变化属于手机专属交互，还是跨端数据契约？
- 是否同步检查桌面端对应行为？
- 是否影响 localStorage、后台服务或重连状态？
- 是否覆盖无 token、同源、旧网关和网络恢复？
- 是否需要真机 RC，而不是只跑静态测试？

## 10. 未决事项

- 当前 `app.js` 仍是零构建单文件前端，未来可按功能拆文件，但必须先定义构建/同步边界，不能在未定方案时引入打包器。
