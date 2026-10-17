# 子代理查看与插件调研（2026-10-17）

## 插件选择

查询 npm 的 `last-month` 接口，本次返回的实际统计窗口为 **2026-09-13～2026-10-12**。以下是包下载次数，包含自动安装和升级，不能视为独立用户数；只比较本次查询的相关候选，并非全站排名。

| 项目 | npm 版本 | 窗口下载次数 | 与查看需求的关系 | 兼容证据 |
| --- | --- | ---: | --- | --- |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 0.73.0 | 158,323 | Fleet 编队页面展示当前代理、父代理、子代理，以及上下文和运行信息；适合借鉴 | 发布包部分 DSH peer 声明 `>=0.1.7-rc.2`；不能单凭范围保证每个后续预览版可用 |
| [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 0.1.23 | 51,849 | 成员、任务依赖、消息和协作面板，偏团队执行和管理 | 发布包明确列出 `0.2.0-rc.2`，以及若干 0.1 预览版；未列出 `0.2.1-alpha.1` |
| [dsh-subagent-monitor](https://github.com/Mombrane/dsh-subagent-monitor) | 0.5.0 | 1,950 | 直接子代理监控卡片，进入子会话查看下一层 | README 标注 0.1.x，宽泛 peer 范围不能证明新 API 已适配 |
| [dsh-nested-followups](https://github.com/sluminositys/dsh-nested-followups) | 0.2.2 | 1,241 | 从回答创建隔离追问并递归分支，接近“对话分支树” | README 明确 0.1.x，演示 0.1.1-rc.2；发布包 peer 范围以 `<0.2.0` 为上界。没有足以确认 0.2 新版兼容的证据 |

版本与兼容性以 [nested 发布包](https://registry.npmjs.org/dsh-nested-followups/latest)、[context 发布包](https://registry.npmjs.org/dsh-context/latest)、[teams 发布包](https://registry.npmjs.org/@nanmicoder%2Fdsh-agent-teams/latest)、[monitor 发布包](https://registry.npmjs.org/@leetoners%2Fdsh-ui-subagent-monitor/latest) 为准。下载来源：[context](https://api.npmjs.org/downloads/point/last-month/dsh-context)、[teams](https://api.npmjs.org/downloads/point/last-month/@nanmicoder%2Fdsh-agent-teams)、[monitor](https://api.npmjs.org/downloads/point/last-month/@leetoners%2Fdsh-ui-subagent-monitor)、[nested](https://api.npmjs.org/downloads/point/last-month/dsh-nested-followups)。这些 URL 的数据会继续变化。

不在 Remote 中加载第三方 React 页面或新增运行时依赖。本次实现查看 DSH 内置子代理目录；nested-followups 自定义追问分支、teams 自定义团队任务尚未接入，也未安装这些插件。

## Remote 的树形查看

- 手机与桌面共用 `public/subagents.js`、`public/subagents.css`。对话顶栏只有紧凑入口，树形目录位于独立全屏页面，进入时才读取并展开第一层；点击节点箭头再读取下一层。点击卡片先选中并展示详情，点击「打开只读记录」再关闭树形页并打开记录，返回进入直接父会话。「返回对话」、Escape 或 Android 返回关闭页面；对话 DOM、草稿和阅读位置保留，历史视图暂停后恢复。刷新按钮重读当前目录和可见展开层。
- 显示名称、模式和运行状态；`inactive` 仅显示“未运行”，不宣称任务已经完成。诊断、循环关系和不可读条目只显示原因，不激活会话。保留现有 continuable 中断操作，使用该节点的直接父会话 ID。
- 导航时保留最近 20 个会话的展开状态；切换连接清空。请求合并、迟到结果隔离，最多展示 300 行、16 层；更多记录可打开子会话继续查看。收起后的目录不自动发起递归查询。
- 子代理记录隐藏输入框、普通会话修改入口和队列修改按钮，避免把子代理当成普通会话发送。此处的只读指记录页面，目录里仍可按原能力中断 continuable 子代理。
- 网关适配 DSH 0.2 的 `session/page` 子代理地址：`{kind:'subagent',parentSessionId,childSessionId,mode}`，分页前读取该子代理 projection 的最新 `asOfSeq`；普通 fork 继续使用普通会话地址。

## 验证边界与文件

协议依据本机已安装的 `@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2` 源码核对。新增网关地址/游标契约测试和树形交互测试，覆盖展开、孙级打开、直接父级返回、异常条目、重试、连接切换、目录去重。隔离浏览器使用模拟上游；不代表真实 DSH 模型运行或 Android 真机验收。

增量文件：`public/subagents.js`、`public/subagents.css`；修改 `public/app.js`、`public/desktop/desktop.js`、两端 HTML、`gateway.js`、`scripts/sync-plugin.mjs`；更新 `tests/subagents-ui.test.js`、`tests/dsh-020-compat.test.js`、`tests/tester-feedback-ui.test.js`、`tests/refresh-efficiency.test.js`、`tests/network-regression.test.js`、`tests/history-ui.test.js`、`tests/desktop-async-regressions.test.js`、`tests/fixtures/realistic-stack.cjs`，并同步插件副本。此前反馈修复保留，详见 `rc-0.8.0-feedback.md`。

会话更新触发重绘时，目录缓存超过 10 秒会重读当前目录和可见展开层，避免每次重绘都查询，同时保留新子代理发现能力。

版本号、更新说明、更新清单和分发 APK 当时恢复为 `0.8.0-rc.2`，之前生成的 rc.3、rc.4 候选撤回并带 `WITHDRAWN.txt`，不可视为当前交付；当晚用户授权「构建 rc.3 版本本地实装」，最终版本、产物与验证见 [rc.0.8.0 反馈记录](rc-0.8.0-feedback.md)。之后只有用户明确同意才更新版本号。

所有改动保持未提交，未安装、未部署、未对外发布。全屏页面验证见本文件后续记录。

2026-10-17 独立页面验证：全量 `npm run check` 共 550 项，542 通过、8 跳过、0 失败。隔离浏览器确认手机/桌面对话区没有树形卡片、顶栏入口打开独立全屏页面；手机确认嵌套展开和返回后草稿保留，桌面确认 Escape 返回。该轮把版本 JSON、包版本、更新清单和分发 APK 恢复为 rc.2，没有运行构建或本地发布脚本；此后用户授权构建 rc.3 并本地实装，见 [rc.0.8.0 反馈记录](rc-0.8.0-feedback.md)。Android 实机手势仍待验收。

## UI 精进：参考与取舍

使用 `cognitive-psychology-ux` 的分组、渐进披露和触摸目标原则，以及 `design-everyday-things` 的操作提示、反馈、映射和错误恢复诊断。这是开发者启发式自查，没有新增真实用户研究，也不虚构可用性测试参与者。

- [nested-followups 的公开树形界面](https://github.com/sluminositys/dsh-nested-followups/blob/main/assets/tree-view.png)与 [Canvas 组件](https://github.com/sluminositys/dsh-nested-followups/blob/main/src/client/view/ConversationTreeCanvas.tsx)：借鉴树的起点、分支连线、搜索、选中状态及独立详情。Remote 使用可读卡片与按层展开，不加入画布拖动、缩放和缩略图，便于手机点选。
- [dsh-context 的编队界面](https://github.com/bowenliang123/dsh-context/blob/main/docs/agent-network.png)与 [Fleet 组件](https://github.com/bowenliang123/dsh-context/blob/main/src/client/components/fleetView.tsx)：借鉴“摘要 → 层级 → 所选对象”的层次、运行状态筛选与卡片分组。只使用当前协议确实提供的目录、模式与 activity，不填充虚构进度、费用或完成率。

页面增加明确的当前会话根节点、连线与可选卡片；运行、等待、未运行、未知和目录异常均有文字标签。`inactive` 不等于业务完成。模式展示为「单次任务」「可续接任务」；异常条目展示可读原因，详情保留原因码。桌面显示树与详情双栏，800px 以下改为上下布局；选中后滚到详情，并可返回树中所选节点。主要触摸目标至少 44px，深层缩进受限，保留完整路径；沿用主题变量和 reduced-motion 设置。

搜索名称或 ID、状态筛选仅检查已读取目录，祖先路径保留，不发起隐式网络请求。筛选中禁用「收起分支」并解释原因。刷新串行读取可见展开层，失败时保留上次目录和重试入口；摘要标注「已读取」，不宣称覆盖尚未展开的整棵树。选中项使用稳定父子 ID 路径，刷新排序改变后不会把打开/中断操作转到其他节点。循环目录不能覆盖祖先的持久地址。

启发式自查：此前 **6/10**（系统状态说明与操作映射不充分）；当前 **8/10**。可发现操作、错误恢复、层级映射和操作约束已有界面及测试证据；“用户理解所有运行结果”一项仍留待真实 DSH 运行和用户实测，目录快照不能证明任务最终完成。这不是实测用户评分。

验证：全量 `npm run check` 共 **553 项，545 通过、8 跳过、0 失败**；树形组件 7 项专项测试覆盖按需读取、选择与打开分离、筛选保留祖先、排序后选择稳定、失败保留目录、异常/循环隔离和不可信文本。隔离浏览器核对桌面双栏、搜索祖先路径，以及实际 390px iframe 视口下的点选、滚到详情和返回节点。截图使用明确的模拟任务，不代表真实 DSH/手机实机验收。未改版本、未构建、未提交或部署。

本轮改动文件：`public/subagents.js`、`public/subagents.css`、两端 `app.js`/`desktop.js` 的根节点状态参数、对应插件同步副本、`tests/subagents-ui.test.js`、`docs/usage.md` 和本文件。验证日志：`dist/subagent-polish-check.log`。

## DSH 0.2.1-rc.1 后续适配

本地 Desktop/CLI 已更新，Remote 源码增加 cached/sequenced 水位区分、旧会话迁移提示和 external 子任务诊断。真实新版 DSH 隔离实例已验证两层子代理目录与历史读取；由测试插件创建 durable 记录，不调用模型，不代表真机或实际任务执行验收。完整升级、备份、文件及验证边界见 [DSH 0.2.1 适配记录](dsh-0.2.1-adaptation.md)。该轮之后 Remote 已随用户授权的 `0.8.0-rc.3` 更新并完成本地实装（见 [rc.0.8.0 反馈记录](rc-0.8.0-feedback.md)），适配补丁已进入用户 profile。
