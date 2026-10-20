# 已适配插件版本检查（2026-10-20）

检查对象以 `public/extensions.js` 的四项适配为准。npm 官方 registry 的 `latest` 元数据于 2026-10-20 12:47–12:51 UTC 读取；下载对应发布包并校验 registry 提供的 SHA-512 integrity 后，仅解包审阅源码，没有执行其安装脚本或替换现有插件。记录在 `dist/ui-topnav-2026-10-20/audit/registry.json`。

| 插件 | 本机 Desktop | npm latest | 现有接口核对结论 |
| --- | --- | --- | --- |
| dsh-context | 0.73.3 | 0.73.3 | `contextTimeline` 的七类组成、`detailRev`、`/api/dsh-context/detail` 的 `rev/head/events` 契约仍兼容。现有 Remote 不展示完整消息或系统提示内容。 |
| dsh-cost-meter | 1.9.11 | 1.9.20 | 零参数 `getState()` 与 `getSessionCost(sessionId)` 保留；余额、Coding Plan windows、隐藏开关及金额字段可沿用当前白名单适配。1.9.20 修正 OpenDesign 5h/周窗口映射，修复来自费用插件，Remote 不另行交换窗口。 |
| @linxin666/dsh-client-ui-skill-explorer | 0.4.6（本地包） | 0.4.8 | `/api/dsh-skill-explorer/list` 与 `/read`、分组 `groups` 和完整性 `complete` 仍存在；Remote 继续只读。新版还提供新增、修改、删除、导入等写接口，本轮没有接入。 |
| @nanmicoder/dsh-agent-teams | 未安装 | 0.1.25 | `/plugins/dsh-agent-teams/state` 保留 `{teams}` 快照；现有按工作区筛选、成员/任务只读适配可保留。0.1.25 主要修正 DSH 0.2.1-rc.2 安装兼容声明，不等同 Remote 的新功能。未做本机运行验证。 |

## 本轮处理

- 额度与余额恢复为 Remote 插件面板的直接可见内容，管理控制台移除用量页及其费用轮询。保留刷新、供应商查询时间、已用比例、未知/失败状态及主机隐藏开关。
- 新建对话接入 DSH 官方的 `agentPresets/list` 和 `session/create.request.agentPreset`。创建参数只影响新对话，不调用 `agentPresets/select`，不修改主机默认类型或已有对话。旧主机未提供预设列表时使用主机默认。
- 当前 Desktop 实际返回 `standard`（默认）、`ptc`、`minimal`、`cordis`；名称从主机读取，没有在 Remote 中写死这四项。

## 后续可添加的功能

| 优先级 | 功能 | 依据与范围 |
| --- | --- | --- |
| 较高 | 自定义余额与网关额度的只读展示 | 费用插件 `customBalances`、`gatewayQuotas` 已提供多账户/多窗口结果。需新增有界白名单摘要，保留状态与币种，排除配置、请求 URL、凭据和错误原文。 |
| 中 | 上下文中的图片数、工具调用与时长 | 0.73.3 发布类型提供 `images/toolCalls/humanInputs/answers/timing` 等可选统计；可先展示计数与汇总，缺失时隐藏，不把历史缺失当零。 |
| 中 | 团队阶段与交付阻断的更清晰提示 | 在既有只读快照内增强 `phase/planReviewState/delivery` 展示；先用实际安装的 0.1.25 做隔离兼容验证。 |
| 后续单独设计 | 技能创建、编辑、导入 | 0.4.8 写接口比当前 Remote 只读能力更广，涉及内容落盘、来源与路径边界，应另做交互及权限设计。 |

这些是候选能力，未作为已完成的功能宣称。四个插件均未自动升级；只有 Remote 本次 RC 更新。

## 证据与限制

- 发布包来源：[dsh-context](https://www.npmjs.com/package/dsh-context)、[dsh-cost-meter](https://www.npmjs.com/package/dsh-cost-meter)、[技能中心](https://www.npmjs.com/package/@linxin666/dsh-client-ui-skill-explorer)、[AgentTeams](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams)。
- 上游源码及说明：[Context](https://github.com/bowenliang123/dsh-context)、[费用插件 1.9.20](https://github.com/Han-1413141/dsh-cost-meter/blob/main/docs/update-notes-1.9.20.md)、[技能中心](https://github.com/zhu1090093659/dsh-web)、[AgentTeams 0.1.25](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/release-notes/v0.1.25.md)。
- “接口兼容”是发布源码/数据契约检查结论，不代表已升级到每个最新版并完成真机验收。费用计价、供应商登录及刷新仍由对应插件负责；本轮未调用模型。
