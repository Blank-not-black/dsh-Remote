# DSH 热门插件界面适配调查

调查日期：2026-10-07。本文用于选择后续适配范围，尚未实施界面或安装候选插件。

后续进度：用户选定首批后，已实现 Web/Android 共用界面与桌面端的上下文及费用摘要，详见 [首批适配说明与验收](plugin-insights.md)。以下为实施前调查记录。

## 结论

建议第一批选择 **dsh-context 的上下文概览**和 **dsh-cost-meter 的费用/额度摘要**；第二批考虑 **任务看板**和 **AgentTeams 团队状态**。技能中心和记忆浏览作为后续选项。

优先级综合远程操作价值、数据接口、现有功能重叠和适配成本判断，不是市场排名。适配方式应是消费主机插件的数据、用 Remote 自己的组件展示，不把第三方 React 页面或依赖打入 Remote。

## 热度依据与范围

- 使用市场插件 dshmarket 声明的上游目录 [awesome-dsh-plugin/plugins.json](https://awesome-dsh-plugin.com/plugins.json)。本次取到的目录更新时间为 **2026-10-05**，包含 **4,414** 条记录。
- 目录包含同仓库子包、同名插件和跨生态项目。下表均用作者和 npm 包名区分；同仓库的 Star 数不能视作每个子包的独立热度。
- 主要候选的 npm 下载量已在 2026-10-07 用 npm 下载 API 重新查询。统一统计区间 **2026-09-06 至 2026-10-05，30 天**。直接 API 与目录缓存数值有差异，下表优先使用直接 API。
- 下载量包含更新、CI、间接依赖及可能的自动化下载，不等于安装用户数；billion-context 同时服务多种客户端，其总下载量尤其不能当作 DSH 用户量。
- Star 和未单独复查的下载数采用目录快照。未统计真实活跃用户，也未验证候选在用户当前 DSH profile 中能否运行。

| 候选与准确来源 | 目录 Star | 30 天 npm 下载 | 适配建议 |
| --- | ---: | ---: | --- |
| [dsh-context / bowenliang123](https://github.com/bowenliang123/dsh-context)，`dsh-context` | 1,867 | 132,348 | 第一批：会话上下文占用、分类组成、压缩/注入记录。先概览再明细。 |
| [dsh-cost-meter / Han-1413141](https://github.com/Han-1413141/dsh-cost-meter)，`dsh-cost-meter` | 374 | 102,337 | 第一批：会话费用、今日费用、账户余额与套餐额度；对接数据源，避免重复记账。 |
| [任务看板 / zhu1090093659](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-task-board)，`@linxin666/dsh-client-ui-task-board` | 8,405* | 168,956 | 第二批：手机按状态分组的任务列表，桌面多列；状态、运行会话和结果先行。 |
| [AgentTeams / NanmiCoder](https://github.com/NanmiCoder/dsh-agent-teams)，`@nanmicoder/dsh-agent-teams` | 1,937 | 55,279 | 第二批：团队、成员、任务依赖、阻塞原因与会话跳转，先只读。 |
| [技能中心 / zhu1090093659](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-skill-explorer)，`@linxin666/dsh-client-ui-skill-explorer` | 8,405* | 175,886 | 后续：按来源浏览、搜索、查看内容；启停和编辑另做权限验收。 |
| [鲸鱼挂件 / MeteorNOX](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，`dsh-whale-widget` | 4,076 | 122,880 | 费用类替代候选：适配余额/预算数据即可；角色、音效、宠物不进入第一批。 |
| [billion-context / ranxianglei](https://github.com/ranxianglei/billion-context)，`billion-context` | 561 | 710,913 | 后续：只读压缩状态与诊断。拥有独立代理运行时，接入成本较高。 |
| [GenUI / omdsh-dev](https://github.com/omdsh-dev/dsh-genui)，`@changfenhuang/dsh-genui` | 514 | 31,405 | 补齐已有只读渲染的兼容差异；交互回传作为单独项目。 |
| [better-sidebar / omdsh-dev](https://github.com/omdsh-dev/DSH-better-sidebar)，`dsh-better-sidebar` | 4,009 | 255,752† | 热门，但整体工作台过大。择需做 Git、文件预览等功能，不搬整套侧栏。 |
| [Mnemon / omdsh-dev](https://github.com/omdsh-dev/dsh-mnemon)，`dsh-mnemon` | 458 | 41,221† | 后续：记忆搜索、浏览和来源检查，已有明确远程接口及读写分界。 |
| [automation / MichengAI](https://github.com/MichengAI/dsh-automation)，`@michengai/dsh-automation` | 22 | 119,289† | 定时任务备选；接口限定 loopback，先解决授权接入，避免与任务看板同时铺两套。 |

\* dsh-web 同仓库 Star，不能分别归属于任务看板和技能中心。† 下载量为目录缓存，本次未单独向 npm 复查。

直接 npm 数据样例：[dsh-context](https://api.npmjs.org/downloads/point/2026-09-06:2026-10-05/dsh-context)、[任务看板](https://api.npmjs.org/downloads/point/2026-09-06:2026-10-05/%40linxin666%2Fdsh-client-ui-task-board)、[费用](https://api.npmjs.org/downloads/point/2026-09-06:2026-10-05/dsh-cost-meter)、[团队](https://api.npmjs.org/downloads/point/2026-09-06:2026-10-05/%40nanmicoder%2Fdsh-agent-teams)。

## 已核对的接入条件

### 1. dsh-context：最适合先做概览

[主机入口](https://github.com/bowenliang123/dsh-context/blob/main/src/host/index.ts)注册 `contextTimeline`、`contextHeaders`、`contextActivity` 会话投影；[明细路由](https://github.com/bowenliang123/dsh-context/blob/main/src/host/detail.ts)使用认证后的 `/api/dsh-context/detail`。

Remote 当前 `gateway.js` 的 `applyModernProjection()` 会把任意投影键转发为旧式 `session/projection`，前端 `proj()` 可按键取值。因此概览有复用现有通道的基础，仍须验证已发布插件的数据 schema、首次基线和切换连接后的刷新。

建议入口为聊天顶部的“上下文”，打开底部抽屉：总量/窗口、组成条、最近压缩与注入记录。概览不主动拉取完整系统提示词；需要明细时再按会话读取，避免默认搬运大量内容。插件未安装时隐藏专属入口。

### 2. dsh-cost-meter：复用账本，不加一套价格计算

[主机源码](https://github.com/Han-1413141/dsh-cost-meter/blob/main/lib/index.js)注册 `costUsage` 投影，并提供 `costMeter` 服务，经 Typert Remote 接口读写状态和配置。与鲸鱼挂件相比，它更适合做独立的费用/额度摘要。

第一批展示已提供的会话/当日费用、余额与套餐额度；金额、订阅百分比和数据更新时间分开显示，官方余额与本地估算使用各自来源标记。当前 Remote 自有 `/stats` 的结果不能直接与插件账本相加。

完整远程 RPC 名称、允许的读操作、服务端返回是否包含敏感配置仍需在固定版本上核对，源码存在服务不等于当前网关已经可以调用。主机负责查询，客户端消费脱敏结果。

鲸鱼挂件的替代方案有 [明确 HTTP 路由](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/main/lib/index.js)：`/dsh-whale/balance.json`、`last-turn.json`、`usage-records.json`。这些不在 `/api/` 前缀内，不能假设已有代理覆盖。

### 3. 任务看板：价值高，鉴权需要专项接入

[协议](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/protocol.ts)和[路由](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host-routes.ts)提供 `/api/task-board/{state,action,events,parse,verification}`。

其请求守卫要求浏览器同源标记及 loopback 检查，或显式受信代理配置与内部 token。Remote 当前代理会移除客户端 Origin、Referer、Sec-Fetch 等头，直接透传不一定通过该插件检查。要按作者支持的授权方式接入，不能简单伪造同源头来宣称兼容。

第一阶段只读任务和运行结果；第二阶段添加创建、手动运行、暂停/恢复及编辑。手机用分组列表和详情，避免把桌面横向看板原样缩小。

### 4. AgentTeams：先补团队视图，不重做子代理系统

[主机入口](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/src/index.ts)提供 `/plugins/dsh-agent-teams/state`，返回团队快照，并有 halt、plan 等控制路由。此路径属于 `/plugins/`，Remote 当前主要代理 `/api/` 及少量明确列出的 `/remote/` 路由，因此需要新增有界的桥接。

Remote 已有子代理目录和会话跳转，可在其基础上补团队角色、任务依赖和阻塞信息。先只读并跳转成员会话，停止团队、提交计划等写操作后续独立验收。插件 package.json 明确列出可用 DSH peer 版本，实施时需固定双方版本测试。

### 5. 技能与记忆：可以适配，但不宜首批同时做

技能中心的 [HTTP 接口](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-skill-explorer/src/routes.ts)包含 `/api/dsh-skill-explorer/{list,read,set-enabled,create,update,delete,health}`，也有请求权限守卫。先浏览和读取，后做编辑/回收站；是否允许操作取决于主机授权。

Mnemon 的 [远程服务](https://github.com/omdsh-dev/dsh-mnemon/blob/main/src/host/remote-rpc.ts)使用 `dshMnemon` namespace，区分 read、activation、write、pack、settings、view；管理能力要求 `remoteAccess: trusted-host`。适合以后做只读记忆检视，不能把存在远程服务理解为默认允许修改记忆。

### 6. 其他热门项的取舍

- **billion-context**：[作者客户端说明](https://github.com/ranxianglei/billion-context/blob/main/CLIENTS.md)表明 DSH 插件会启动/连接独立代理，不能按普通 DSH UI 数据接口处理。需先确定运行时定位和会话对应关系，再考虑压缩摘要，暂不开放全局代理配置。
- **GenUI**：Remote 已有 `public/genui.js`，支持只读展示和受限 HTML 预览。作者现在的图表、Mermaid、3D 等实现依赖其客户端资源；不能在零新增依赖要求下直接搬入。先做固定 schema 的兼容检查，再决定具体补哪些组件。
- **生图插件**：[shanliuling/dsh-image-gen](https://github.com/shanliuling/dsh-image-gen)具备图片、持久附件和画布相关路由。值得先验证生成结果、历史回放、预览与下载是否在 Remote 可见；复杂画布不纳入第一批。这是候选，尚未做真实生成验证。
- **dsh-at-file**：[作者 README](https://github.com/FSMargoo/dsh-at-file)已建议新安装优先使用新版 DSH 内置 `@file`、`@session`。Remote 的引用功能应优先跟随官方契约，避免专门绑定旧插件。
- **归档管理**：Remote 已有归档显示和相关操作，先验证现有能力缺口再选第三方管理器。
- **市场、皮肤、TUI、宠物**：分别与现有插件中心重复、依赖 DSH 页面结构、面向终端或优先级较低，不列入首批。

## 后续实施建议与验收

1. 第一批：上下文概览 + 单个费用数据源的只读摘要。手机 Web/Android 共用实现，桌面复用数据层；鸿蒙按自己的规则实现 ArkUI 页面。
2. 第二批：任务看板与团队状态。先接只读通路，验证后逐个添加写动作。
3. 插件中心增加“打开功能”只针对已安装、运行且通过能力检查的适配插件；包名、作者和能力要明确匹配，不用同名或模糊匹配自动接入。
4. 每个适配器固定接口/方法白名单、参数和响应校验、版本或能力检测。沿用连接 generation，切换主机后拒绝旧请求和迟到数据。404/不支持给出可理解的缺失状态。
5. 在临时 HOME/profile 中验证真实 DSH、插件和网关链路，再做手机与桌面 UI 检查；覆盖未安装/停用、重连、首次加载、切换主机、旧 DSH 和错误响应。展示数据源与更新时间。

本次只新增本文；原有未提交代码保留。未安装、部署、发布或提交任何插件，未运行功能测试，兼容性结论限于源码和公开元数据检查。调查缓存位于已被 git 忽略的 `dist/market-research/`。
