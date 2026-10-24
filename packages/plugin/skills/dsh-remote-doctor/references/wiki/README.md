# DSH Remote 操作与排障知识库

这是供用户和用户的 AI 共同使用的 Wiki 式入口。先按操作或症状找文章，再按证据判断原因。正文保存在仓库内，与代码一起审阅；插件包也携带同一份知识库，断网时可查。

核对基线：2026-10-23，Remote 源码 `0.8.0-rc.9`，包含尚未发布的正式版准备与实验性插件折叠改动。真实 DSH 联调记录包含 `0.2.1-rc.2`，不是全部旧版和未来版本的兼容承诺。不同版本的实际界面、capability、安装包和运行状态优先于这里的基线。

## 我要操作

| 任务 | 入口 |
| --- | --- |
| 连接主机、选工作区、发送、审批、文件、通知 | [日常操作手册](operations.md) |
| 安装、更新、停用、卸载插件，查看实验性插件 | [插件管理与升级](plugins.md) |
| 查看历史、思考、插队、分支与子智能体 | [会话、历史与发送结果](sessions.md) |
| 上传、续传、下载，检查允许目录 | [文件传输](files.md) |
| 开启后台通知与峰谷提醒 | [通知与后台](notifications.md) |

## 我遇到问题

| 症状或检索词 | 文章与编号 |
| --- | --- |
| 网关待启动、拒绝连接、端口占用、upstream、401 | [连接与网关](connection.md)：KB-CONN-01～04 |
| 本机正常手机打不开、VPN、Tailscale、中转 HOST_OFFLINE | [连接与网关](connection.md)：KB-CONN-03、05 |
| 加载中、历史非零却空白、迁移、fallback、instruction-hint | [会话与历史](sessions.md)：KB-SESSION-01、02 |
| 发送结果未知、重复消息、插队没有马上中断 | [会话与历史](sessions.md)：KB-SESSION-03、04 |
| 插件只读、列表漏显、更新卡住、pnpm 发布时间限制 | [插件管理](plugins.md)：KB-PLUGIN-01～04 |
| 适配诊断、任务看板、费用余额、团队计划审查与交付警告 | [插件适配数据](plugins.md)：KB-PLUGIN-02、05 |
| 403、路径不在允许范围、409、422、上传中断 | [文件传输](files.md)：KB-FILE-01、02 |
| 息屏断连、没有审批通知、峰谷规则不可用 | [通知与后台](notifications.md)：KB-NOTIFY-01、02 |
| 找到错误码但不知道归谁处理 | [错误与状态索引](errors.md) |

## 给 AI 与维护者

- [AI 阅读与执行指引](ai-guide.md)：先确认版本与实际目标，区分操作请求和排障请求。
- [证据采集与反馈模板](evidence.md)：最小、脱敏、可复核，不上传原始会话。
- [源码与验证依据](sources.md)：每类结论对应实现、回归测试和专题文档。
- [维护约定](maintenance.md)：新问题如何入库、适用版本与证据如何更新。

仓库入口是 `docs/wiki/README.md`；已安装插件中的离线入口是 `skills/dsh-remote-doctor/references/wiki/README.md`。后者由 `npm run sync-plugin` 生成，不能直接修改。根 `llms.txt` 提供给外部 AI 的简短索引。

历史 issue 已关闭、测试通过、构建成功或公告写了“修复”，都不自动证明用户当前主机已安装修复或原设备已经验收。先读 [AI 指引](ai-guide.md)。
