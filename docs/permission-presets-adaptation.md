# 权限模式（Auto review 等自动审批类插件）适配（2026-10-22）

本轮回答“能不能给 auto 审批类插件做个适配”，并把第一阶段做完：Remote 不再内置固定预设，改为按主机目录渲染；Auto review 出现在可选列表时带 EXP 标记与风险确认。登记基线与证据采集时间：2026-10-22，本机 `0.8.0-rc.9` 源码树、DSH Desktop profile。

## 查到的能力

| 能力 | 载体 | 本机状态 | 与 Remote 的关系 |
| --- | --- | --- | --- |
| 权限预设（沙箱 + 审批捆绑、进程级目录、`/permission` 命令） | 内建 `@deepseek-ai/dsh-permission-presets` | 已装载，`permissionPresets/catalog` 可读 | 本轮接入的唯一数据来源 |
| Auto review（逐调用审查：低风险直接放行、拒绝时转人手审批） | 官方实验包 `@deepseek-ai/dsh-experimental-auto-review` | profile `bundles` 已列，但**默认关闭**，所以目录里暂时没有 `auto` | 启用后自动出现在 Remote 列表；本期不代用户开启 |
| 审批策略与待审批 | 内建 `@deepseek-ai/dsh-user-approval` | 已装载 | Remote 原有“审批与操作回执”继续负责，本轮未改 |
| 改动审查（差异保留/回退） | 社区 `dsh-diff-approval` 0.34.0 | 未安装 | 通道为 `trusted-host` 且读写同一处理器，需要另立权限阶段，本轮不接 |
| 市场目录检索“auto 审批”类插件 | `awesome-dsh-plugin.com/plugins.json`、npm registry | 本机网络不可达（curl 与 Invoke-WebRequest 均 SSL/000） | 只按本机可核验的实现判断，没有把不可访问的目录当作结论 |

结论：**能做，而且不需要新增依赖**。真正缺的不是“再造一个自动审批”，而是让 Remote 读到主机已有的预设目录与 Auto 的安全门。

## 实测证据

1. 直连 DSH（`POST /api/permissionPresets/catalog`，带本机上游 Cookie；以下为省略部分内容的节选，不是完整 JSON）：

   ```text
   {"options":[{"value":"read-only","name":"read-only"},{"value":"workspace-write","name":"workspace-write"},{"value":"danger-full-access","name":"danger-full-access"}],
    "defaultOptions":[...同上...],"defaultPreset":"workspace-write"}
   ```

   目录里没有 `auto`，与“Auto review 随 DSH 附带但默认关闭”一致；配置预设没有配 `name`/`description`，所以主机回的是裸键名。
2. 同一请求走改造前的 `0.8.0-rc.9` 网关（`POST /api/permissionPresets.catalog`）返回 **404**：该 method 不在 `ADAPTIVE_RPC_METHODS`，现代协议下没有转换分支，回退到旧路由必然失败。
3. 命令桥探测（`POST /remote/api/command`，发一条未知命令读 `debug.commandNames`）得到 `["compact","export","feedback","goal","permission","plan"]`：`/permission <preset>` 本来就能用，缺的是发现入口、当前值标注与风险确认。
4. 会话投影已有当前值：`projections.values.permissions.currentValue = "workspace-write"`，无需新增状态通道。

## 本轮改动

| 文件 | 改动 |
| --- | --- |
| `gateway.js`、`packages/plugin/gateway.cjs` | `ADAPTIVE_RPC_METHODS` 增加 `permissionPresets.catalog`；`translateModernRpc` 增加转换分支；新增 `modernPermissionCatalog` 白名单重写（只保留 `value/name/description`，值域 `^[a-z][a-z0-9-]{0,63}$`、名称 80 字、说明 400 字、最多 20 条，`custom` 从可选列表剔除） |
| `public/permission-presets.js`（新） | 主机目录渲染：`auto` 用客户端本地文案与 `EXP` 角标；`auto`/`danger-full-access` 先出风险确认（勾选后才能启用）；`custom` 等推导值只标当前不可点；按连接缓存 15s、换主机重读、迟到响应按序号丢弃；主机不可用时回退三种沙箱模式并说明原因 |
| `public/index.html`、`public/app.js`、`public/styles.css` | 手机端把权限模式作为“输入指令”下方一组常显行（不再藏在 `/permission` 子菜单里），删掉写死的三个 `data-perm`；打开指令菜单即按主机目录刷新；新增 `perm.*` 文案 17 键 × 中英 |
| `public/approval-records.js`（新） | 审批记录：从会话审计事件（`approval/asked`+`approval/decided`）、实时审批帧与 Auto review 最终拒绝（`tool/result` 里的 `Auto review rejected tool "…"`）收集；解析“沙箱升权/自动审查转人工/自动审查拒绝”三类内容、结果徽标、结果原因、相对时间；有界 40 条、HTML 转义、可序列化恢复 |
| `public/index.html`、`public/app.js`、`public/styles.css`、`public/workflow.js` | 手机端从“更多 → 审批与操作回执”显示记录，历史里把 `approval/asked` 渲染成可展开记录行；按主机持久化到 `localStorage`（`dshApprovalRecordsV1:<server>`），新增 `approval.*` 文案 22 键 × 中英 |
| `public/desktop/desktop.html`、`desktop.js`、`desktop.css` | 桌面端在同一“指令”菜单里常显权限模式行与确认卡片；从“更多 → 审批与操作回执”显示记录；历史行同样展开记录；17+22 键文案 |
| `scripts/sync-plugin.mjs` | 同步清单加入 `permission-presets.js`、`approval-records.js` |
| `tests/permission-presets-ui.test.js`（新） | 9 项：目录渲染与当前项、Auto 文案/角标/确认门、取消、立即切换与失败提示、`custom` 只读、无目录回退、行过滤与截断、连接缓存与竞态、手机/桌面接线 |
| `tests/approval-records-ui.test.js`（新） | 7 项：审计事件合成记录、Auto review 转人工识别、最终拒绝单独记录、实时帧结算、有界/排序/持久化/容错、HTML 转义与相对时间、手机/桌面接线 |
| `tests/dsh-021-compat.test.js` | 增加网关转换用例：endpoint、空参数、行过滤与截断、空响应 |

同步：`packages/plugin/public/*` 与 `packages/plugin/gateway.cjs` 已与 `public/`、`gateway.js` 逐字一致（`git diff --no-index` 全部 identical）。

## 审批记录（第二轮）

用户要求“留出审批记录，对审批内容、给出结果的原因进行简要介绍”。数据来自主机自己写入会话日志的审计事件，Remote 不额外请求模型，也不改主机数据。

- **审批内容**：`approval/asked` 的 `data.toolName` + `data.reason`。原因文本按三类解释：
  - `escalate sandbox to <mode>: …` → 沙箱升权，显示目标模式与原因；
  - `Auto review denied tool "…": …` → 自动审查转人工，显示审查器给出的原始理由；兼容旧转人工文本，但最终拒绝仍依据工具结果判断；
  - 其他 → 普通工具审批，原样显示主机原因。
- **结果**：`approval/decided` 的 `data.outcome`（`allowed-once` / `rejected` / `cancelled` / `unavailable`）或实时帧 `approval/resolved`；未结算显示“待处理”。
- **结果原因**：按结果给出固定解释（你允许了一次／你拒绝且工具未执行／回合结束或请求撤回／无应答者按拒绝处理／等待决定），Auto review 最终拒绝单独说明“风险过高且会话禁止人工放行”。
- **展示位置**：总览“审批记录”面板（最近 8 条，含会话名与相对时间）；会话历史里对应 `approval/asked` 位置渲染可展开记录行，结果到达后徽标自动变成允许/拒绝。
- **来源与边界**：只记录需要人参与的审批与 Auto review 最终拒绝；**Auto review 自动放行的调用本身不写日志，因此没有逐调用记录**（该包明确不持久化 reviewer 的风险、prompt 与原始响应）。记录按主机持久化在客户端 `localStorage`，上限 40 条，换主机读取各自记录。

## 行为与安全边界

- 不写死预设名与主机标签：列表、名称、说明都来自主机；主机没提供目录就回退三种沙箱模式并显式说明，不假装成功。
- 切换只走主机已注册命令 `/permission <value>`，不新增写接口，也不透传任意 RPC。
- `auto` 与 `danger-full-access` 必须勾选风险确认才会下发，与 DSH Web 的确认门槛对齐；文案说明“不使用沙箱、逐调用审查、可能误放行/误拒绝、额外消耗 token”。
- `custom` 是主机推导状态，只显示为“当前”，不可选择。
- 只影响当前会话，不修改主机默认预设（`defaultOptions`/`defaultPreset` 本期只透传未使用）。

## 未做与后续

- **目录变更通知未接入**：网关不转发主机 `permission-presets/catalog-changed` 通知，目前靠“每次打开菜单重新读取 + 15s 缓存”。若要在插件启停时实时刷新，需要在网关增加通知通道转发。
- **新建会话默认预设**：`defaultOptions`/`defaultPreset` 已透传，但新建对话界面还没有默认权限选择。
- **HarmonyOS 原生端**未适配（ArkTS 侧没有权限模式入口）。
- **Auto review 拒绝/失败结果**已有专用记录行与总览记录（见上节）；失败（reviewer 技术错误）仍只按工具错误展示，未单列记录。
- **社区 auto 审批类插件**（`dsh-diff-approval` 等）未评估安装，通道权限模型不同，需要单独设计。

## 验证与限制

### 2026-10-22 仿真复核后的修复

- 只有符合最终拒绝格式的工具结果才生成自动拒绝记录，普通成功、其他工具错误与审查器技术错误不再误记；记录 ID 包含会话，避免跨会话调用 ID 碰撞。
- 审批决定可以先于申请到达，按审批 ID 合并并保留分页、重载和实时重放后的结果；缺少申请详情时暂不展示。清除全部本地数据同时取消审批缓存的延迟写回。
- 手机和桌面均从“更多 → 审批与操作回执”读取审批记录，关闭后恢复原容器，实时待办继续使用同一个列表。
- 异步命令有独立操作 ID 与 `executed/phase` 终态。权限切换等待终态，失败保留菜单；切换主机或会话后，旧响应不能关闭新菜单。普通命令仅在明确未执行时回退文本，失联或执行失败不会自动重复发送。
- 手机和桌面入口已用隔离假 DSH 与真实浏览器验证；这不等于在真实 DSH 上启用 Auto review 或完成设备验收。当前修复报告及全量检查日志见 `dist/rc9-bugfix-2026-10-22/`。

以下为适配初稿的历史验证记录，当前计数以本次修复报告为准。

- `node tests/approval-records-ui.test.js` → 7 pass / 0 fail；`node tests/permission-presets-ui.test.js` → 9 pass / 0 fail；`node tests/dsh-021-compat.test.js` → 10 pass / 0 fail。
- 回归抽查（逐文件直跑，均 0 fail）：`history-ui`、`history-load-recovery`、`network-regression`、`session-presets-ui`、`extensions-ui`、`slash-command-bridge`、`pending-ui`、`dsh-015/020/021-compat`、`theme-ui`、`genui`、`doctor-ui`、`device-keys-ui`、`announcement-poll-ui`、`desktop-lifecycle`、`desktop-async-regressions`、`desktop-update-notes`、`connection-isolation`、`session-runtime-ui`、`overview-detection` 等。
- 手机端与桌面端 i18n 字典各语言键数一致（手机 870/870、桌面 443/443，`zh-only` 与 `en-only` 均为 0）。
- 本机沙箱下 `npm run check` 的 `node --test` 会以子进程 `spawn EPERM` 失败（file sandbox 限制），因此改为逐文件直跑；这不等于全量通过，需要用户在正常环境跑一次 `npm run check`。
- 没有重启 DSH、没有改真实 `~/.dsh-remote`、没有安装或开启 Auto review、没有真机验收；`public/build.json` 的 `buildId` 由 `npm run publish` 时重新生成。
- 本轮改动**未提交**，按仓库惯例留到发布流程统一提交。
