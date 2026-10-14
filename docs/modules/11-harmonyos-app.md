# HarmonyOS ArkUI 客户端模块

> 源码核对：2026-10-12。根项目 0.7.4；本工程 manifest 为 0.6.26 / 6269。
>
> [模块索引](README.md) · [目录守则](../../harmonyos/AGENTS.md) · [自构建与签名](../harmonyos-self-build.md)

## 1. 模块定位

`com.dshremote.app` 使用系统 ArkTS/ArkUI 与 SDK，侧载分发。提供手机和宽屏布局及主要远程会话能力；各端功能存在明确差异，不宣称全面对齐 Android。原长篇模块中的日期记录和技术演进保留在[开发历史](../archive/harmonyos-development-history.md)。

## 2. 代码结构

以下路径相对于 `harmonyos/entry/src/main/ets/`：

| 区域 | 作用 |
| --- | --- |
| `entryability/EntryAbility.ets` | 启动、深链、系统主题与生命周期 |
| `pages/Index.ets`、`pages/tablet/` | 手机根页、宽屏 Navigation、侧栏 |
| `pages/ChatPage.ets`、`components/` | 会话内容、Markdown、接续卡与共享视图 |
| `pages/PluginCenterPage.ets` | 插件管理及连接上下文控制 |
| `pages/ServerSettingsPage.ets` | 服务器、配对与测试 |
| `pages/AnnouncementsPage.ets`、`FeedbackPage.ets`、`AsrTestPage.ets` | 公告、反馈、鸿蒙 ASR 诊断 |
| `services/GatewayApi.ets`、`RealtimeService.ets` | HTTP/RPC、WS 与增量轮询 |
| `services/AppState.ets`、`StorageService.ets`、`PairParser.ets` | 状态、preferences、重复 server 参数 |
| `services/FsUploadService.ets`、`FileExporter.ets`、`ImageDecoder.ets` | 文件分块/续传、另存为、图片 |
| `services/BackgroundService.ets`、`NotificationService.ets`、`PeakReminderService.ets` | 长时任务、通知与提醒 |
| `services/AsrTestService.ets`、`LiveViewService.ets` | 系统诊断与实时视图服务，设备权限另验 |
| `common/AppNav.ets`、`Breakpoint.ets`、`SessionActions.ets`、`SessionListLogic.ets` | 导航、宽屏、会话操作和纯逻辑 |
| `common/I18n.ets`、`Markdown.ets`、`models/Theme.ets` | 双语、解析和主题令牌 |
| `entryformability/`、`widget/`、`entrybackupability/` | 卡片与备份扩展 |

页面注册以 `resources/base/profile/main_pages.json` 为准。源码含组合视图、注册页面及扩展服务，不再用“11 页面 + 13 服务”的固定计数代表完整工程。

## 3. 当前功能

服务器分组与多地址扫码、主页健康、会话/历史/实时思考、模型档位、图片、审批/提问、目标与停止生成、长按插队、文件多根/预览/上传/另存为、插件中心、公告/投票/反馈、通知、后台、峰谷提醒与系统 ASR 诊断。

当前五个主入口为会话、文件、主页、插件、设置；统计保留主页简要用量。宽屏在约 600vp 断点进入分栏。系统语言启动时选择中文/英文，主题使用自身四套色板。

## 4. 具体实现方式

AppStorage 原语与页面状态驱动渲染。连接变化递增 `connectionGeneration`，上下文包含服务器 id/规范化地址/令牌和代数；异步成功、失败、finally、确认与手势均核对归属。ArkUI Watch 与真实生命周期派发必须真机验证。

手机使用 router，宽屏使用 NavPathStack；会话切换按现有导航策略创建正确实例并注销旧 sink。断点在布局后用页面 UIContext 注册。动态 Builder 数据需保持渲染依赖，不能按值传入后假定自动更新。

文件上传走系统 SHA-256、probe、4MiB 分块和 finish 校验；offset 由服务端回执驱动，422 清理，409 显示失败。另存为由系统 DocumentViewPicker 获得 URI 授权。

后台尝试 dataTransfer 长时任务，失败退化为进程内计时；系统冻结/取消会限制可靠性。代理提醒拒绝（历史出现 1700002）时回退进程内提醒，应用冻结期间不保证触发。不能把维持状态条当作系统无限保活授权。

## 5. 制作目的

提供鸿蒙系统 UI、文件选择/导出、通知和设备能力，同时复用 Remote 网关契约；不复制第三方 Web/React 渲染运行时。

## 6. 接口与数据契约

遵守[跨端协议](01-contracts.md)：dot RPC 由网关适配、mux/host 下行、短时 ticket/旧兼容路径、多 server 配对、文件根与分块、feedback、插件中心。前端不上送应用层心跳。

`/handoff` 仅保存单条 `sessionId/title/device/clientId/at` 指针，7 天过期，排除自身 clientId；不传会话正文。旧网关端点缺失时静默降级。

图片块为 `type:image` 及媒体类型/base64/名称；理解能力取决于模型。长按插队 `mode:steer` 接受不代表工具已中断，迟到响应不清空新草稿。不发明上游删除 RPC。

## 7. 边界与禁止事项

- 系统 ArkUI/SDK，零新增第三方运行时依赖；允许现有官方测试 devDependencies。
- API key 不进入日志或反馈，配对 token 保持设备 preferences 与请求使用边界。
- 本机签名配置/证书不入库，`signingConfigs` 保持空。
- `dsh-ui` 降级源码；不宣称 Web GenUI、安全 HTML 预览、上下文与费用洞察或 Web 本地历史缓存已移植。
- 删除会话入口仍受上游能力约束，不能把归档当永久删除。
- 根 release 不构建 HAP，不自动同步该工程版本。

## 8. 测试与验收

`tests/harmonyos-context.test.js` 在 Node 中擦除类型、执行生产控制器方法，验证请求/手势上下文；不验证 ArkUI Watch、系统路由与权限。构建与签名步骤统一在[自构建指南](../harmonyos-self-build.md)。

最新关于页源码改动没有在本轮构建/真机验证；2026-10-02/03 及更早构建与实机记录见历史。后续需要重测手机/平板布局、A→B→A、改令牌、重试确认、后台、通知、相机/ASR权限、大文件与深色。

## 9. 修改前检查清单

先读目录守则；确认系统 API/最低设备能力、数据归属、路由实例和资源索引；媒体增删后清理工程内 intermediates 重建。报告源码、构建、签名、安装、真机结果和未覆盖项。

## 10. 未决事项

- 会话洞察、Web 历史缓存与 GenUI 未移植。
- 长按插队繁忙判定的排队维度和队列单条 steer UI 尚未对齐。
- 侧载代理提醒、后台长时任务和新 API 设备兼容需逐机验证。
- 工程版本与根项目分离，未来 HAP 发布策略需另行定义。
