# 后续插件适配候选调查（2026-10-13）

建议下一批先做 **任务看板 + 长任务进度**，随后做技能浏览和 Git 状态；团队、记忆和生图进入下一轮。这个顺序按手机远程使用价值、现有功能缺口和接入成本判断，不是市场排名。

本轮是调查：没有安装候选插件、修改产品代码、部署或提交。前一轮插件中心锁修复和工作区原有文档改动均保留。

## 核验范围

- 2026-10-13 重新获取 [市场目录](https://awesome-dsh-plugin.com/plugins.json)：目录自报更新日期为 2026-10-12，共 4,527 条。
- 对 14 个候选独立查询 npm 最新版元数据和统一区间下载量；其中 13 个下载并索引已发布包，重点查看数据通路、方法和鉴权。没有运行第三方包内代码。
- npm 下载区间为 **2026-09-13 至 2026-10-12，共 30 天**。下载包含更新、CI 和聚合包依赖，不等于用户数。dsh-web 家族多个子包共享仓库和分发体系，不用总仓库 Star 给每个子包单独背书；billion-context 面向多个客户端，也不能把全部下载视作 DSH 用户。
- 当前 Remote 的上下文和费用摘要已实现；GenUI 已有只读渲染。这些不作为新适配项目重复计算。
- 缓存、脚本和包内文件索引位于 `dist/market-research-2026-10-13/`，`verified.json` 记录准确版本、下载响应、tarball 地址及包内路径。该目录被 Git 忽略。

## 优先候选

| 顺序 | 准确插件来源 / npm 包 | 本轮 npm 版本 | 30 天下载 | Remote 第一阶段范围 | 成本判断 |
| --- | --- | --- | ---: | --- | --- |
| 1 | [任务看板](https://github.com/zhu1090093659/dsh-web/tree/dev/packages/dsh-task-board) / `@linxin666/dsh-client-ui-task-board` | 0.4.6 | 150,050 | 按工作区与状态浏览卡片、最近执行结果、失败/验收原因、会话跳转、下次计划时间 | 中；先只读，执行与定时编辑另加动作 |
| 2 | [长任务进度](https://github.com/chen8923/dsh-task-progress) / `dsh-task-progress` | 0.3.0 | 13,565 | 当前会话进度卡：阶段、上报百分比、消息、更新时间、完成/失败/取消 | 较低；有独立只读端点，但需新增精确桥接 |
| 3 | [技能中心](https://github.com/zhu1090093659/dsh-web/tree/dev/packages/dsh-skill-explorer) / `@linxin666/dsh-client-ui-skill-explorer` | 0.4.6 | 161,878 | 按来源浏览、搜索、查看正文与当前启用状态 | 中；读接口明确，权限和路径仍需主机限定 |
| 4 | [Git 图谱](https://github.com/zhu1090093659/dsh-web/tree/dev/packages/dsh-git-graph) / `@linxin666/dsh-client-ui-git-graph` | 0.4.6 | 139,404 | 当前分支、未提交文件、最近提交、worktree 列表 | 中；只读业务也使用 POST，不能按 HTTP 方法直接区分权限 |
| 5 | [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams) / `@nanmicoder/dsh-agent-teams` | 0.1.23 | 48,657 | 团队与成员状态、任务依赖/阻塞、验收状态、成员会话跳转 | 中；独立状态接口，但返回多个工作区数据，需筛选 |
| 6 | [Mnemon](https://github.com/omdsh-dev/dsh-mnemon) / `dsh-mnemon` | 0.5.28 | 44,435 | 会话记忆使用记录、运行时记忆、项目档案和记忆空间的搜索/读取 | 中到高；采用插件 RPC 通道，固定方法和响应摘取 |
| 7 | [对话生图](https://github.com/shanliuling/dsh-image-gen) / `dsh-image-gen` | 0.8.7 | 22,945 | 已生成图片的预览、历史重开、下载，展示生成结果状态 | 中；先补结果与附件兼容，再评估画布和生成控制 |
| 专项 | [改动审查](https://github.com/9087/dsh-diff-approval) / `dsh-diff-approval` | 0.34.0 | 7,070 | 待审文件、增删摘要和逐文件差异；保留/回退另立权限阶段 | 高；通道要求 trusted-host，不能整条暴露给远程客户端 |

下载原始来源格式为 `https://api.npmjs.org/downloads/point/2026-09-13:2026-10-12/<URL编码包名>`，例如 [任务看板](https://api.npmjs.org/downloads/point/2026-09-13:2026-10-12/%40linxin666%2Fdsh-client-ui-task-board)、[长任务进度](https://api.npmjs.org/downloads/point/2026-09-13:2026-10-12/dsh-task-progress)、[技能中心](https://api.npmjs.org/downloads/point/2026-09-13:2026-10-12/%40linxin666%2Fdsh-client-ui-skill-explorer)。npm 版本是本轮取得的 latest 元数据，后续实施需固定所验版本。

## 已核对的接入条件

### 任务看板：先让手机能看到长期任务

0.4.6 发布包的 `src/protocol.ts` 定义状态 schema 6 与 `/api/task-board` 前缀；主机提供 `GET /state`、`GET /events`、`POST /action`。卡片具有真实执行、定时调度和验收状态，不应把某个会话结束直接显示为任务验收通过。

第一阶段读取主机账本摘要，按项目/状态筛选，展示最近执行对应的会话及失败原因。展示调度器时区；手机时区与主机不同也要能看懂下次执行时间。后续再逐项增加新建、运行、暂停计划；这些动作会改变主机状态，运行还会调用模型。

原端点具有回环/同源接入限制。Remote 在新 DSH 下会把通用 `/api/*` POST 转成 RPC，目前只有上下文明细有精确 Fetch 例外；看板 action 不能未经核对就套用这条转换。应由 Remote 主机侧提供自己的固定桥接契约。

### 长任务进度：最贴合“等待时不知道发生了什么”

0.3.0 的 `lib/index.js` 和 `docs/PROTOCOL.md` 定义 `GET /plugins/task-progress/state?session=<id>`，响应包含 `v`、`generatedAt`、`pollMs` 和 `tasks`。请求先经过 DSH `connection.requestRejection`，一次只读取指定会话，响应不带文件系统路径。

接入后可展示脚本上报的阶段、计数和百分比，以及主机推断的结束状态。没有上报百分比时展示“执行中”与耗时；若结束来自 job registry 推断，要标明与脚本主动上报的区别，不能替它编造中途进度。

其 README 声明基线为 DSH 0.1.7-rc.1 Web profile，当前用户实际 Desktop/Web 版本尚未验证。现有网关只代理 `/api/*` 和 `/remote/*`，这个 `/plugins/*` 路由需要新增精确鉴权桥接。

### 技能浏览：优先围绕主机技能注册表

0.4.6 发布包明确提供 `/api/dsh-skill-explorer/list`、`/read` 和 `/health`，写动作另外划分为启停、创建、更新、删除。读正文参数包含路径；Remote 应以主机确认的技能标识映射，不接受客户端任意路径。

同类替代候选为 [dsh-skill-hub](https://github.com/cheshireez/dsh-skill-hub)（0.3.21，6,827 次）和 [skills-management](https://github.com/weibaohui/skills-management)（0.9.1，9,808 次）。后者声明 DSH `>=0.1.7-rc.2`。适配设计应首先核对主机官方 skills 服务是否能满足浏览需求，再选择第三方扩展；不同时建设多套技能市场。

### Git 与改动审查：分成状态查看和修改文件两层

Git 图谱 0.4.6 的主机路由为 `/git/*`，包含 status、branches、graph、worktrees；这些业务读操作也走 POST。主机要求路径规范化后属于已注册工作区。第一阶段由 workspaceId 映射主机路径，再读取状态；不开放任意主机目录、分支切换或 worktree 删除。

差异审批 0.34.0 的 `/diff-approval` Connection 通道注册为 `authority: 'trusted-host'`，同一处理器含读取和文件修改能力。因此必须先核对受支持的主机服务接入方式，仅摘取只读结果；整条 RPC 透传不是可接受的初版。保留/回退还需要 revision、会话范围、冲突检测和持久化结果验证。

### 团队、记忆与生图

- AgentTeams 0.1.23 提供 `/plugins/dsh-agent-teams/state`，通过 DSH Connection 校验后汇总注册工作区中的团队。Remote 应限定当前选定工作区，按自己的契约摘取状态；`/halt` 是另外的写操作，初版不混入读取。
- Mnemon 0.5.28 已是可组合记忆架构，发布包区分 `/dsh-mnemon-read`、`/dsh-mnemon-view` 与多条写入/设置/同步通道。不能继续仅按旧版“单个记忆库”假设设计，需要版本或能力检测，先读来源和证据。
- 生图 0.8.7 具备 `/plugins/dsh-image-gen/image`、import、delete、studio、save-workspace 等独立路由。优先验证已生成附件的认证预览、历史重开与下载，复杂画布、密钥设置和多模型执行留待后续。

## 后续候选与暂缓原因

| 候选 | 本轮版本 / 30 天下载 | 建议 |
| --- | --- | --- |
| [自动化](https://github.com/MichengAI/dsh-automation) / `@michengai/dsh-automation` | 0.1.63 / 122,305 | 有价值，但与任务看板的定时调度重叠。先选择一个来源；发布包使用 loopback 权限通道，不假设现有网关可直接接入。 |
| [代码审查](https://github.com/MichengAI/dsh-code-review) / `@michengai/dsh-code-review` | 0.1.14 / 67,719 | `/review`、`/review-status`、`/review-cancel` 可先核对现有斜杠命令流程与报告展示，确认缺口后再做专属面板。 |
| [MCP 连接器](https://github.com/duhu2000/dsh-mcp-connector) / `dsh-mcp-connector` | 0.2.70 / 22,905 | 适合只读连接状态、工具搜索与诊断；`/mcp-connector/api` 处理器包含读写方法，不能整条代理。OAuth/配置编辑属于另外阶段。 |
| [billion-context](https://github.com/ranxianglei/billion-context) | 0.1.195 / 1,182,592 | 热度高但涉及独立运行时，与已有上下文洞察重叠；本轮未下载或分析其发布包，不据下载量把它列为优先适配。 |

皮肤、整套侧栏、宠物和重复市场页面继续排后。Remote 保持零新增依赖和现有发布形态；消费候选数据并用自有组件显示，不把它们的前端 bundle 或 UI 框架打入 Remote。

## 建议下一轮的具体验收

1. 固定任务看板 0.4.6 和进度 0.3.0，在临时 HOME/profile 中验证真实 DSH → 插件 → Remote 网关 → 手机/桌面链路。
2. 首版只实现任务列表/详情/会话跳转和会话进度卡；保留来源、更新时间和失败原因。能力不可用时展示明确原因。
3. 覆盖未安装、停用、版本不支持、权限拒绝、首次基线、任务中断、网络重连、关闭面板停止轮询，以及主机/会话切换后的迟到响应。
4. 只允许固定路由、参数和响应字段；读取成功不代表写操作可用。后续再对具体任务动作分别验收。

当前证据限于公开目录、npm 元数据和已发布代码，尚不代表候选在用户实际 Desktop、Android 或 HarmonyOS 环境中已兼容。
