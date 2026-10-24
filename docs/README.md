# DSH Remote 文档

本轮用户文档核对基线：仓库 `0.8.0-rc.9`，2026-10-22。版本来自根 `package.json`；这里描述源码能力，安装包、公开发布、实际 profile 和真机验证各自需要核验。HarmonyOS 工程当前仍为 `0.6.26`，不能套用主项目版本号。当前候选版变化与验证范围见 [rc.9 说明](rc-0.8.0-rc.9.md)，旧版验收记录保留原结论。

## 使用指南

按任务/症状查找：[操作与排障知识库](wiki/README.md)。给用户 AI 的入口为 [AI 指引](wiki/ai-guide.md) 和仓库根 `llms.txt`；安装包随附离线副本。

| 你要做的事 | 文档 |
| --- | --- |
| 选择安装方式，连接第一台设备 | [安装与首次连接](getting-started.md) |
| 一步一步熟悉连接、对话与反馈 | [手机端新手引导](onboarding-guided-practice.md) |
| 使用自己的云服务器提供公网入口 | [自建云服务器中转引导](self-hosted-relay.md) |
| 使用会话、文件、通知与多服务器 | [客户端使用与平台差异](usage.md) |
| 配置监听、网络、文件范围和生命周期 | [配置参考](configuration.md) |
| 排查拒绝连接、401、实时链路与更新 | [故障排查](troubleshooting.md) |
| 用 AI 做只读排查并整理反馈 | [AI 排查插件问题](plugin-doctor.md) |
| 管理主机插件和恢复中断任务 | [插件中心](plugin-center.md) |
| 查看上下文、费用和套餐用量 | [会话洞察](plugin-insights.md) |
| 查看插件适配诊断、多渠道额度、团队检查与任务看板 | [插件适配与任务看板](plugin-adaptation-2026-10-23.md) |
| 查看结构化图表与 HTML 安全预览 | [DSH UI 支持范围](dsh-ui-support.md)、[示例](genui-sample.md) |
| 查看当前界面与截图来源 | [rc.9 WebUI 与旧版截图库](screenshots/README.md) |
| 自行构建和签名 HarmonyOS 客户端 | [HarmonyOS 自构建](harmonyos-self-build.md) |

## 开发与维护

| 内容 | 文档 |
| --- | --- |
| 开发环境、源码与同步边界 | [开发指南](development.md) |
| RC 准备、正式发布、分发验证 | [构建与发布](release.md) |
| 准备 0.8.0 的升级计数与旧会话已知限制 | [正式版准备](0.8.0-release-readiness.md) |
| 查看当前 rc.9 的功能、修复与验证边界 | [rc.9 说明](rc-0.8.0-rc.9.md) |
| 协议、网关、插件及各端模块 | [模块索引](modules/README.md) |
| DSH 适配策略和证据边界 | [兼容性](compatibility.md) |
| 权限模式、Auto review 与审批记录接入 | [权限模式适配](permission-presets-adaptation.md) |
| 本轮文档核对范围和限制 | [文档核对记录](documentation-audit.md) |
| 社区介绍文案 | [项目介绍](community-introduction.md) |

## 历史与设计资料

[历史索引](archive/README.md) 汇总旧 RC 验收记录、插件调研和设计参考。保留当时的版本、测试数量和验证结论，不把它们当作当前版本的验收。设计方案不等于已经实现的功能。

## 维护规则

- 用户操作步骤放在本目录的使用指南；接口与开发约束放在 `modules/`。README 保留介绍、下载和最短上手路径。
- 行为改变时更新对应指南和模块；版本声明以源码、元数据和实际产物为依据。不要只替换旧报告中的版本号。
- 中文和英文项目/插件 README 的安装、能力和限制保持一致。插件包说明使用 GitHub 绝对链接，避免 npm 页面上的相对链接失效。
- 记录自动测试、构建、安装、浏览器和真机验证的区别。跳过的测试与未验证的平台必须明确说明。
- 现有 Markdown 是文档源；后续若发布 Wiki，应从这些文件同步，保持一份维护来源。
