# 手机连接入口与首次使用提示

0.8.1 起，Remote 的首次连接、重新配对和排障入口收敛到 DSH 左侧导航的「更多 → 手机连接（DSH Remote）」。

## 用户流程

1. 插件首次在当前客户端加载时，在右下角显示一张非模态提示卡，写明永久入口位置。它不抢焦点，不自动打开浏览器。
2. 点击「开始连接」后，在浏览器打开完整控制台的「设备与访问」，继续使用现有的准备电脑、安装 App、扫码连接三步引导。
3. 点击「稍后」或成功发起浏览器打开请求后，在当前客户端 localStorage 记录“已经知道入口”。以后启动不再弹卡片，需要时从「更多」进入。
4. 请求失败时保留提示和「重试打开」，不写入已知入口标记。已手动关闭过提示的用户仍可从「更多」重试。

该标记表示用户已经看过入口，不表示手机配对成功。下载 APK、打开浏览器均不会被计为连接成功；配对向导仍以实际 App/Web 客户端在线为证据。首次加载也包含入口迁移后的首次升级，已有用户会看到一次位置提示。清理浏览器存储会重新显示；存储被禁用时只能在本次加载中关闭，后续加载可能再次显示。

## 实现与认证

- 新宿主使用 `sidebar.panellist.actions` 菜单扩展，原左下角入口不显示。缺少该扩展点的旧宿主保留底部「手机连接」按钮，并显示对应的入口说明；没有新建会话右侧栏标签、悬浮球或嵌入 iframe。
- Web 端在用户点击时同步打开同源 `/remote/admin/#remote/devices`，沿用现有浏览器登录态。
- Desktop 端按需 POST `/remote/admin/api/browser-launch`。接口要求专用请求头、无查询参数，并显式调用宿主 `connection.authorizeIndex()` 验证签名 Cookie；DSH 插件前缀本身不会代为鉴权。
- 启动地址仅从实际监听服务构造，限定本机 loopback HTTP(S)、根路径和固定落点，不接受 Host 头或参数指定目的地。使用宿主的 `authenticatedUrl()`，不传 Remote 网关令牌。
- 系统浏览器通过 DSH 根页面兑换登录 Cookie，宿主清除查询凭据后，Remote 的固定 hash 标记将页面导向配对页。响应使用 `no-store`、`no-referrer`；不在 localStorage、日志或提示卡保存认证 URL。
- 正常加载与展开菜单均不读取会话目录、不创建 Agent、不轮询 Remote 状态。卸载中止尚未完成的启动请求，旧响应不能继续打开浏览器。

`noopener` 浏览器与 Electron 均可能在成功交接时返回 null，不能据此报告打开失败；浏览器拦截弹窗时可允许弹窗并从「更多」重试。Desktop 系统浏览器接管逻辑已核对实际 rc.3 Electron 源码，未在日常安装中部署新插件验证操作系统弹窗。

## Better Sidebar 兼容结论

Remote 不再占据右侧栏，亦不修改宿主布局或第三方编辑器 DOM，因此无需给 Better Sidebar 单独增加布局适配。先前工作台中的 Git、文件、任务和终端入口一并撤下，由各自原有入口使用。本轮没有将该插件整体搬到手机端；手机 Git 只读摘要如有实际需求，应另行限定授权和输出范围。

## 验证

基线：实际安装中校验提取的 DSH `0.2.1-rc.3`，可选第三方 `dsh-better-sidebar@0.28.0`，全部使用临时 HOME/profile。

- 全量 `npm run check`：1036 项，1016 通过、20 按环境条件跳过，0 失败。跳过不作为实际宿主验收。
- 入口、旧宿主回退、提示记忆、失败重试、重复点击合并、卸载取消、固定落点等专项与既有回归 42 项通过；认证修正后的入口和插件 HTTP 专项 7 项通过，已包含最终全量检查。
- 浏览器实测：「更多」中出现菜单项；正常页面无 Remote 页脚按钮、iframe 或原生会话标签。关闭提示并刷新后不再出现；点击菜单新标签页直接进入三步配对向导。
- 无 Cookie 的全新浏览器上下文访问启动接口返回 401。由宿主启动 URL 登录后返回 200，最终地址为 `/remote/admin/#remote/devices` 且无查询凭据，能显示配对向导。
- 真实 Desktop rc.3 源码确认：主窗口把 HTTP(S) `window.open` 交给 `shell.openExternal`。本轮通过模拟覆盖 Desktop 发起请求、校验返回地址和 null 返回值；没有在日常 Desktop 安装候选包。
- `npm run sync-plugin`、语法检查及 `git diff --check` 通过。未新增依赖、未改发布形态。

设计自检 8/10：可发现性、错误恢复、入口映射、行为约束各 2 分；外部浏览器交接没有完成回执，反馈项保留 0 分。该评分用于实现审查，不代替新用户可用性研究或实际连接验收。

日志、截图与本地插件候选快照位于 `dist/more-entry-20261025/`。本轮没有提交、部署、发布或新增手机真机验证。候选快照包含当前工作区其他既有改动，不能将整包都归为此次入口修改；先前 `native-sidebar-20261024` 候选包已被本方案取代。

## 改动文件清单

| 文件 | 内容 |
| --- | --- |
| `packages/plugin/client.js` | 更多菜单、首次提示、浏览器启动、旧宿主入口回退；移除侧栏工作台和抽屉 |
| `packages/plugin/index.mjs` | 固定浏览器落点与显式宿主认证接口 |
| `public/plugin.js` | 移除工作台联动，保留页面本身的可见性轮询控制及既有运行状态改动 |
| `public/plugin.html`、`public/remote-ui.css`、`scripts/sync-plugin.mjs` | 撤回上一轮工作台结构、样式与脚本同步项，保留其他工作区改动 |
| `public/plugin-workspace.js`、`tests/native-sidebar.test.js` | 撤下上一轮未提交新增文件，生成副本由同步脚本清除 |
| `tests/more-entry.test.js`（新增） | 首次提示、菜单导航、认证交接、失效响应与兼容回退 |
| `tests/plugin-runtime.test.js` | HTTP 方法、显式点击标记、签名 Cookie、固定地址及失败边界 |
| `tests/plugin-client-compat.test.js`、`tests/doctor-entry.test.js` | 保留平台兼容，更新已撤下的 iframe 桥接断言 |
| `packages/plugin/public/`、内置知识库副本 | 由同步脚本生成 |
| `packages/plugin/package.json` | 更新入口描述，不改版本或依赖 |
| 本文、文档首页、安装指南、根及插件 README、Doctor 说明 | 新入口路径及验证边界 |

工作区并行改动另行保留，不提交、不重置。
