# 桌面 WebUI 模块

> 状态：现行客户端
>
> 源码：`public/desktop/desktop.html`、`public/desktop/desktop.js`、`public/desktop/desktop.css`、`public/desktop/i18n.js`

## 1. 模块定位

桌面端是持续工作的完整工作台。它使用宽屏空间展示会话列表、工作区、当前会话、文件、统计和上下文，不是把手机页面简单放大。

## 2. 代码结构

- `desktop.html`：桌面布局、设置页、弹窗和内置中英文本。
- `desktop.js`：独立桌面状态、服务器分组、WS/轮询、会话、文件、工作台、统计和设置。
- `desktop.css`：宽屏三段式布局、抽屉、列表和状态样式。
- `desktop/i18n.js`：桌面专用翻译资源/初始化。

桌面端通过网关根路径访问时由网关静态服务；同步脚本把整个 `public/desktop/` 复制到插件包。

## 3. 当前功能

- 左侧工作区/会话列表，中间当前工作内容，右侧上下文与设置抽屉。
- 与手机端共享 `servers-v2`、分组、token 和服务器测速语义。
- 会话历史、实时 mux/host、审批/提问、目标、子代理、队列和模型/推理设置。
- 文件列表、预览、下载、上传和工作台绑定目录。
- 统计抽屉、公告/更新/反馈、主题和网关能力显示。
- 工作区与工作区内会话的顺序保存和位置重排动效。

## 4. 具体实现方式

桌面端拥有独立 `state` 和函数实现，但遵守与手机端相同的协议：`apiUrl()`、WS ticket、generation、poll fallback、`servers-v2`、DSH RPC 和 `/fs` 接口都不能自行变形。

`isTopLevelSession()`、`workspaceForSession()` 和 `sortedSessions()` 保证主列表不混入子代理；工作区排序通过 `workbenchOrderV1` 按服务器作用域保存。实时事件只在当前 generation 有效时更新状态，避免旧连接覆盖新连接。

桌面端采用按需设置抽屉和右侧上下文，避免首页被统计卡片占满；统计/更新/反馈属于辅助层，不应抢占当前工作空间。

## 5. 制作目的

- 适配键盘、鼠标和宽屏持续操作。
- 给复杂会话和文件任务提供稳定上下文，而不牺牲手机端的轻量入口。
- 作为跨端契约的第二个实现，帮助尽早发现只改手机端造成的行为分叉。

## 6. 接口与数据契约

桌面端使用 [01-contracts.md](01-contracts.md) 中的 `servers-v2`、WS ticket、mux/host、DSH RPC、`/fs` 和 health capabilities，不创建桌面专用的协议版本。

## 7. 与手机端的关系

共享：协议、token、服务器列表、分组语义、DSH RPC、事件类型、文件 API、主题语义。

不共享：页面 DOM、布局、交互细节、翻译 key 前缀和部分状态渲染代码。跨端产品行为必须共享，屏幕排版不强行共享。

## 8. 边界与禁止事项

- 不把桌面端重构成手机端的横向 CSS 版本。
- 不修改 `packages/plugin/public/desktop/*`，只改根 `public/desktop/` 后同步。
- 不新增与手机端冲突的服务器持久化 key 或 RPC 字段。
- 修改服务器、WS、文件和会话逻辑时必须检查手机端是否需要同等修复。

## 9. 测试与验收

- `tests/network-regression.test.js`：桌面实时流、服务器、动效和排序。
- `tests/reasoning-ui.test.js`、`session-list-ui.test.js`：思考流和顶层会话。
- `tests/user-flows.test.js`：共享网关全链路。
- 真实 UI 检查要覆盖桌面宽屏、长标题、空工作区、错误态和右侧抽屉。

## 10. 修改前检查清单

- 是否改变共享协议或仅改变桌面排版？
- 手机端是否已经有相同需求或回归测试？
- 空状态、长文本、窄宽度和设置抽屉是否可用？
- 是否保持 `servers-v2` 和 workbench 作用域语义？
- 是否同步 `public/desktop/` 到插件包？

## 11. 未决事项

- 手机/桌面端的重复业务函数未来可以抽取共享纯函数，但当前零构建约束下应先设计源码加载和测试方式。
