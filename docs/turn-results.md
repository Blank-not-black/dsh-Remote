# 回合结果栏（2026-10-18）

手机/App 和桌面 Web 在 `turn/end` 后显示同一套结果栏。版本保持 `0.8.0-rc.3`，本轮不部署、不提交、不发布。

- **复制结果**：复制该回合最后一条含文本的助手回复，保留原始 Markdown，不混入思考、工具参数或工具输出。无文本时禁用复制。
- **从此处分支**：调用 DSH `session.fork({sessionId, atSeq})`，`atSeq` 是所选回合的 `turn/end` 序号（包含该事件）。成功后打开新会话，不发送提示词。原会话和其后续回合保留。子代理只读记录、待迁移会话和不支持操作回执的旧网关不提供分支按钮。
- **用量**：累计回合内每条 `assistant/message.data.usage`；优先使用上游 `totalTokens`，否则相加互不重叠的输入、输出、缓存读取和缓存写入。思考 token 已包含在输出内，不重复加。点击可展开精确计数。无用量时显示 `—`；起点未加载或部分调用未报告用量时标注「已知用量」，不以会话总量代替。
- **时间戳**：显示回合结束事件的本地日期/时间，`time[datetime]` 保留原始绝对时间；源时间缺失显示「时间未知」，不以当前时间补造。

`turn/start` / `turn/end` 从实时与分页历史保留到原有有界缓存，作为隐藏元数据使用。结果栏按结束序号派生，不修改原始历史；分页、上翻阅读和用量展开状态复用 `HistoryView`。旧缓存可能没有回合边界，在线历史校验后才出现结果栏。

分支接入既有操作回执：首次只发一次 POST，重复点击与重连查询已有回执，不自动重放状态未知的写入。连接、会话或历史对象已切换时，迟到结果不能打开旧主机分支。分支已成功但会话列表刷新失败时仍可打开返回的新会话。

## 文件

- 新增共享模块 `public/turn-results.js`。
- 两端接入：`public/app.js`、`public/index.html`、`public/desktop/desktop.js`、`public/desktop/desktop.html`、共享 `public/workflow.css`。
- 回执与分发：`public/operations.js`、`gateway.js`、`scripts/sync-plugin.mjs`、`package.json` 的语法检查命令。插件对应副本由 `npm run sync-plugin` 生成。
- 测试：新增 `tests/turn-results.test.js`；更新 `tests/installed-dsh.test.js`、`tests/workflow-reliability.test.js`、`tests/fixtures/realistic-stack.cjs`。`tests/hosts-layout.test.js` 收紧旧断言的扫描范围，避免把后续结果栏的换行规则误认为主机分组规则。
- 文档：本文件、`docs/usage.md`。

## 验证边界

真实安装的 DSH `0.2.1-rc.1` 在临时 HOME/USERPROFILE/DSH_HOME/文件根启动，测试插件写入两个已结束回合；核对第一个回合的结果、用量和精确分支，子会话不含后续提问。没有调用模型或操作用户 profile。

浏览器使用隔离模拟上游与固定测试令牌，检查 390px、320px 手机布局及 1280px 桌面布局，实际点击复制后粘贴确认 Markdown，展开用量明细，创建并打开模拟分支；窄屏无横向溢出。截图在 `dist/turn-results-2026-10-18/`。这不代表 Android 真机安装或系统剪贴板/手势验收。

本地测试 APK 独立保存在该目录，保留 RC3 的 `versionName=0.8.0.rc.3` / `versionCode=8003`，不替换已发布 APK 或更新清单；同版本覆盖安装需用户在设备上验证。

最终 `npm run check`：609 项，601 通过、8 跳过、0 失败；`git diff --check` 通过。初次全量中独立插件 worker 用例曾间歇失败，专项重跑 19 项和最终全量均通过，没有改动插件管理后端。日志分别为 `check.log`、`plugin-center-retry.log`、`check-final.log`。

本地 APK 已通过 `apksigner verify`；`aapt dump badging` 确认 `versionName=0.8.0.rc.3`、`versionCode=8003`。新模块、两端脚本/HTML、回执脚本和共享样式在 APK 内与当前源码逐字节一致，报告见同目录 `artifact-verification.json`。APK SHA-256：`053d5f323b435f4dfe7edbe09214cc4cdf829ea3d3ffa7b6a62182aceeaaf03a`。

## 分支列表可见性修复

随后反馈发现 `isTopLevelSession()` 把所有带 `parentSessionId` 的会话排除，普通分支因此无法从列表重新打开。DSH `SessionSummary.origin` 的子代理标记为 `'subagent'`，普通分支可以只有 `parentSessionId` 而没有 `origin`；父会话关系不能用于判断子代理。

两端改为只排除 `origin === 'subagent'`，保留原有 blank、归档和工作区筛选。手机主列表、桌面侧栏、工作区树与统计共用这一判定，已有普通分支重新读取列表后也能显示。新分支创建成功而列表尚未包含它或刷新失败时，同时补入 `state.byId` 和 `state.sessions`，立即重绘列表；连接切换后的旧响应仍不落入新列表。

本次增量文件：`public/app.js`、`public/desktop/desktop.js`、对应插件同步副本、`tests/session-list-ui.test.js`、`tests/turn-results.test.js`、`tests/installed-dsh.test.js`、本文。

验证：专项 20 项通过，包含真实 DSH 创建分支后使用两端筛选器检查该分支可见而子代理不可见。全量 610 项，602 通过、8 跳过、0 失败。隔离浏览器确认手机与桌面列表显示普通分支并可重新打开。记录、截图及重建的测试 APK 在 `dist/turn-results-2026-10-18/branch-visibility/`；此目录的 APK 包含后续修复，替代上一层测试 APK 用于本地试测，不替换已发布版本。新 APK SHA-256：`bc054202080aa5bb876c99bae20229be9fbb4e18a4ad28ef7d85a15251ef2aa6`，签名与内嵌源码比对通过，仍为 RC3 / 8003。未部署、未提交、未发布，未在 Android 真机安装。
