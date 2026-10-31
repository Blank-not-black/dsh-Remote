# 2026-11-01 赞助三端、问题单及兼容性检查

本轮按“赞助接收端、管理端、客户端”完成结构与联调，不把“三端”解释为三个操作系统。基准为 dev 的 Remote 0.8.3，开发分支 `codex/sponsor-three-platform-audit`。不启用生产赞助业务、不发送真实邮件、不发布版本或标签，不升级本机和笔记本正在使用的插件。

## 三端交付

| 角色 | 本轮补齐 |
| --- | --- |
| 赞助接收端 `/sponsor/` | 三项付款材料保持不变；可私下复制查询凭证，换浏览器恢复；错误凭证不覆盖当前申请；查询撤销说明；暂停/满额仍能查旧申请 |
| 管理端 `/sponsor/admin` | 状态筛选、编号/邮箱搜索、绑定及到期信息、月流量和在线状态；暂停/恢复申请持久化；带说明和确认的撤销；过期/撤销后禁止旧交付和标记发送 |
| 客户端 `/relay` | 首条额度回报前即可显示服务月、5GB、单网关和文件限制；仍使用原访问令牌连接；赞助入口重新读取启用/暂停/满额状态 |

旧申请不能撤销后来续期的同一 grant。撤销由 cloud registry 判定并由 broker sweep 断开现有连接，旧密钥不能重新绑定。浏览器退出清除审核密钥、截图对象 URL、交付正文及个人列表，迟到响应不能恢复它们。公开能力接口不返回个人申请或管理数据。详见[赞助试运营](relay-sponsorship-pilot.md)。

浏览器隔离验收已走通申请、截图提交、凭证恢复、审核、生成邮件、标记发送、暂停和撤销；390px 窄屏无横向溢出。自动化 TLS broker 验证从申请到绑定/月额度/文件拒绝/撤销的闭环。没有访问微信账户、收款、发信或退款。生产启用前的真实到账、人工邮件和手机连接验收仍需运营者执行。

## Issue 处理

| Issue | 处理与依据 |
| --- | --- |
| [#21](https://github.com/Blank-not-black/dsh-Remote/issues/21) | 已回复并按 completed 关闭；报告者已确认冷会话修复及两条旧网关接管路径，DSH 版本更正为 0.2.1-rc.2 |
| [#22](https://github.com/Blank-not-black/dsh-Remote/issues/22) | 已回复并按 completed 关闭；报告者明确确认新版本修好 |
| [#28](https://github.com/Blank-not-black/dsh-Remote/issues/28) | 已补充 0.8.3 修复机制、回归与真实只读预检结果；等待报告者升级复验，保留 open |
| [#19](https://github.com/Blank-not-black/dsh-Remote/issues/19) | Windows supervisor 修复回归通过，但仍无报告者原机确认，保留 open，避免重复已有两条验证回复 |
| [#18](https://github.com/Blank-not-black/dsh-Remote/issues/18) | 保留 open；单会话隔离不能代替上游迁移修复。当前 Desktop 附带迁移器的来源白名单仍不包含报告中的 fallback/instruction-hint；未改用户原始日志 |
| [#23](https://github.com/Blank-not-black/dsh-Remote/issues/23) | 保留 open；报告者未补手机侧诊断，没有证据认定 iOS 连接问题已解决 |
| [#11](https://github.com/Blank-not-black/dsh-Remote/issues/11) | 保留功能需求；本机当前 API 未发现正式的永久删除方法，不用文件删除或归档冒充 |

本机真实 desktop profile 的更新预检：目标 `dsh-context@0.78.2`，28.6 秒返回 202、plan 成功、发布年龄 1440 分钟、blockers=0。没有调用安装 operations。超大 packument 的流式解析与边界回归继续通过，保留整份 lockfile 的 pnpm 策略校验。

## 本机与上游插件

本机实际运行 DSH Desktop 0.2.1-rc.3，Remote 插件及网关仍为 0.8.3-rc.1；健康 ready、upstreamOk、mux/host 均正常。技能、费用、峰谷提醒、任务看板端点实际可读；团队原生状态路由自身返回 404，虽然运行时列出插件 active。当前 profile 有 pendingRestart，尚不能把 404 唯一归因于此；没有重启真实实例。

Remote 原先将原生 404 解释成 not-installed，本轮改为 endpoint-missing，并给出启用/重启后刷新指引；401/403 则区分为 host-denied。独立临时 profile 中同一团队接口可正常挂载，说明本机真实实例的路由组装状态还需重启后的验收，不能宣称已修好该实例。

2026-11-01 从 npm 官方 registry 查询并下载以下**确切发布包**，逐个校验 SHA-512，检查归档路径和文件类型后解包。使用 Desktop 自带 0.2.1-rc.3 的依赖副本，在临时 HOME/profile 挂载；不改真实 profile，不请求真实模型。

| 插件 | 本机已装 | 查询到的 latest | 当前验证 |
| --- | --- | --- | --- |
| [dsh-context](https://www.npmjs.com/package/dsh-context/v/0.78.2) | 0.73.3 | 0.78.2 | active；持久夹具会话的 detail.head 能被 Remote contextOf 解析 |
| [dsh-cost-meter](https://www.npmjs.com/package/dsh-cost-meter/v/1.9.46) | 1.9.11 | 1.9.46 | active；费用及峰谷提醒 adapter 均可读 |
| [skill explorer](https://www.npmjs.com/package/@linxin666/dsh-client-ui-skill-explorer/v/0.4.13) | 0.4.6 | 0.4.13 | active；list/read 契约保留，技能列表 adapter 可读 |
| [task board](https://www.npmjs.com/package/@linxin666/dsh-client-ui-task-board/v/0.4.13) | 0.4.8 | 0.4.13 | active；原生 snapshot 为 schema 7，本轮增加 6/7 适配后可读 |
| [AgentTeams](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams/v/0.1.28) | 0.1.26 | 0.1.28 | 临时 profile 内原生及 Remote 均能读到合成团队，成员仍按工作区过滤 |
| [BetterSidebar](https://www.npmjs.com/package/dsh-better-sidebar/v/0.28.2) | 0.28.0 | 0.28.2 | 发布包源码核对；不是 Remote 独立数据视图，未承诺完整第三方侧边聊天运行时 |
| [OpenCode Go](https://www.npmjs.com/package/dsh-opencode-go/v/0.1.24) | 0.1.24 | 0.1.24 | 没有版本漂移；未调用付费模型 |
| [GenUI](https://www.npmjs.com/package/@changfenhuang/dsh-genui/v/0.15.0) | 历史基线 0.11.0，当前 desktop 未装 | 0.15.0 | schema/变更记录核对；Remote 仍是零依赖只读子集，不是完整运行时 |

`dsh-genui` 无 scope 是另一个包，不能用它的 0.3.1 代替 `@changfenhuang/dsh-genui`。当前 `@deepseek-ai/dsh` 的 latest 为 0.2.1-rc.5；本轮真实集成验证的是已安装 rc.3 及独立 CLI rc.2，未宣称 rc.5 已全量验收。

本轮明确修复的上游漂移是任务看板 schema 7。新增 provider、电源和卡片默认字段不进入 Remote 展示投影；未知 schema 8 继续返回 unsupported。开发目录的“已核验版本”更新到上述实际通过隔离验证的五个发布版本，安装仍提交精确版本并经过预检，不改成 latest。

可考虑的后续功能（本轮未实现）：

- GenUI 0.15 的 carousel、image-group 和 0.14 的 blocks/arrow，可先做不执行表达式、不引入地图引擎的只读子集；computed、map、交互提交仍需独立设计，不默认为已支持。
- Context 新的 fleet/skills 视图可作为只读信息扩展，需保持连接、会话和 workspace 归属。
- 费用插件新增外部用量和多币种展示，应与主机 API 实付/Plan 等值分开，不能简单混成一个费用数字。
- 技能启停/导入/编辑、团队计划控制和任务看板 provider 控制是写入能力，不因只读兼容验证通过就自动开放。

## Linux 笔记本

真实环境为 Nyarch/Arch、Node 22.23.2、npm 10.9.9、pnpm 11.7.0，DSH 源码 shim 为 0.2.1-alpha.3。checkout 仍有原来的两项 llm-pi-ai 改动，未修改；隔离集成使用已有 lib 构建产物，不把它等同于 shim 当前源码实装验收。

原网关保持 0.8.0-rc.8、PID 4127710、ready，未升级/重启。当前源码只上传到现有网站工作区下专用 `.dsh-remote-audit-20261101`，没有改网站源文件。所有测试 HOME、文件根、TMPDIR/XDG、DSH profile 均在这个专用目录内；代理和真实凭据清除。

首次快照 966 文件，SHA-256 `4e7c849be606dc885037f1cf5783cf9789209bdb3abd47cdddd6e80cd6338adf`。全量 1162 项：1143 通过、5 失败、14 跳过；赞助专项 49/49、网关冒烟通过。5 个失败已拆分：

- 两项登录/运行时失败来自测试启动器的父级 TOKEN 覆盖测试自己的夹具令牌，启动器已修正；这不是产品缺陷。
- 两项官方市场集成失败，因为旧 checkout 没有 `@deepseek-ai/dsh-plugin-market/lib/index.js`，未为通过测试而安装或改动上游。
- `::1` 自启用例失败：宿主 lo/all 禁用 IPv6，直接绑定 ::1 返回 EADDRNOTAVAIL，未改 sysctl、路由或防火墙。

`systemctl --user` 在 bwrap 沙箱内报 ENODATA，但 D-Bus socket 可连接且服务可路由，不能认定宿主用户总线故障。宿主网关 PID 在沙箱 /proc 不可见，因此 fd/RSS 是 unavailable，不能记为 0。沙箱外只读查询的自动审批审查两次超时，已取消等待，没有执行或继续要求用户审批。

最终产品源码快照为 968 文件，SHA-256 `2455e732639e9cd32aa30fc7ee7eec77f5b693232defb62b01a62605931c716d`。修正父级 TOKEN 后，另发现一次替换网关测试在重启后的 health 读到连接失败；测试原先保留同源旧 PID 的 HTTP keep-alive 连接。已收紧夹具：readiness 使用 Connection:close 并验证当前 PID，重启测试请求关闭复用；没有修改产品重试逻辑或放宽功能断言。两份测试文件以各自 SHA-256 校验后更新到隔离快照，重启两项用例连续三轮全通过，最终全量只剩上述市场模块缺失和 ::1 三项环境失败。

| 最终验证 | 结果 |
| --- | --- |
| Windows 全量 `npm run check` | 1166 项：1146 通过、20 跳过、0 失败 |
| 当前 Desktop rc.3 + 五个最新发布插件隔离集成 | 1/1；费用/提醒/技能/任务/团队/上下文详情均通过，不请求模型 |
| Desktop 真实 Electron 插件生命周期 | 安装/停用/更新/启用/移除在临时 profile 全通过 |
| Linux 全量（开启已有 CLI opt-in） | 1166 项：1149 通过、3 失败、14 跳过，保留退出 1 |
| Linux 已有真实 CLI 核心集成 | 2/2；220 个冷会话在启动/历史读取阶段均无写打开，选中会话仍可流式接收 |
| Linux 赞助及团队专项 | 50/50，0 失败 |
| Linux 替换网关/上游重启专项 | 连续 3 轮各 2/2；最终全量中也通过 |
| Windows/Linux RC 单文件网关 | 均在临时 HOME、18787 端口验证 0.8.4-rc.1、HTML/JS、正常关闭 |

## 验证与分发边界

PR 首轮 Linux/Windows CI 已通过，macOS 因 GitHub 的 macOS 14 退役演练被取消，尚未执行测试。依据 [GitHub 官方退役通知](https://github.com/actions/runner-images/issues/13518)及[托管 runner 架构表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，将检查和构建的 runner 一并迁移到 `macos-15`，保留 Apple Silicon arm64 构建与本机执行冒烟。

最终门禁、Linux 修正后结果和本地 RC 产物记录保存在忽略目录 `dist/maintenance-20261101/`。本地构建版本为 **0.8.4-rc.1 / Android 8017**，只在独立构建副本中覆盖版本，开发仓库发布元数据仍为 0.8.3；没有发布标签、GitHub Release 或 npm 版本。候选包括 APK、插件 tgz、Windows/Linux 单文件网关及云端赞助源码包。APK 签名通过，165 份 APK 静态资源与构建副本一致，APK 内版本一致，插件内 APK 与独立 APK 一致，服务器 update.json 的 SHA-256 一致；构建后生成的服务器 update.json 不要求与 APK 构建前的内嵌更新描述逐字相同。

真实支付、人工发信、Android 覆盖安装和长期弱网不由构建结果代替。鸿蒙源码与 HAP 不在本次“三端角色”任务范围。

主要改动：`relay/{sponsorship,broker,host}.cjs`、`relay/sponsor/*`、共享 `public/{sponsor-entry,relay-settings,extensions,teams}.js`、插件 `task-board.mjs/teams.mjs`、内嵌网关及同步副本、对应测试和本报告。`packages/plugin/public/app.js` 与 `index.html` 没有作为本轮修改或提交。
