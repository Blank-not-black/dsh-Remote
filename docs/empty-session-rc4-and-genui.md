# RC.4 空会话清理与 GenUI 评估

## 空会话修复

此前手机端只删除本地列表记录，没有更新 DSH 的持久状态。新版在返回、切换会话或离开会话页面时重新读取历史，确认没有内容后调用 DSH `workspace.archiveSession`，待服务端确认后刷新列表。桌面端也增加相同行为。

DSH 当前公开接口没有永久删除会话的方法，因此本次采用持久归档，空会话不再回到普通列表，仍可在归档列表找到。未直接删除磁盘日志，也未批量操作用户现有会话。

刚创建的 DSH 会话包含 `permission/preset`、`sandbox/mode`、`approval/policy` 三类初始化事件，不能用原始事件数组长度判断是否有对话。此次仅忽略这三类事件；任何其他事件、分页未读完、实时思考、正在运行、待发送、队列、文字草稿或图片附件都会阻止清理。读取失败或归档失败保留会话，不再仅本地隐藏。归档是可恢复操作；客户端检查与归档 RPC 不是跨设备原子事务。

文件：`public/app.js`、`public/desktop/desktop.js`、`tests/session-list-ui.test.js`、`tests/empty-session-cleanup.test.js`、`tests/installed-dsh.test.js`，版本元数据与生成的插件副本/APK。

验证：176 项检查，172 通过、4 项平台相关跳过；真实 DSH 隔离测试直接执行两端清理函数，再重新读取上游工作区，确认归档状态保留。RC.4 APK 构建成功，本机插件已更新，HTTP 服务代码与源码一致、APK 下载哈希一致。手机真机尚未验证。代码未提交，未外部发布。

## GenUI 评估

当前 Remote 手机界面使用自身 Markdown 渲染器，没有启动 DSH 的 GenUI client half。`dsh-ui` 代码块不会自动成为图表；HTML 文件可以查看源码，但没有 HTML 渲染预览。

[dsh-genui 上游说明](https://github.com/omdsh-dev/dsh-genui)明确要求主机激活浏览器模块并提供 slots 与 sessions 服务；支持结构化 dsh-ui 组件、图表、表单和交互回传。因此安装主机插件不等于 Remote 自动兼容，不能仅复制脚本。其 React/Mermaid/Three 等依赖也与本仓库零新增依赖约束存在冲突。

建议适配，优先级：只读 HTML 隔离预览与常用图表 > 完整交互 GenUI。前者可解决手机验收报告和页面成果的需求；HTML 应在隔离 iframe 中预览，不能访问 App 原生桥或令牌，初版不运行脚本。dsh-ui 可评估按受支持的结构化子集以原生 SVG/DOM 渲染，并明确标出未支持组件。完整交互组件、持久面板和回传模型另行设计，避免宣称完全兼容。此次只评估，未实施 GenUI/HTML 预览。
