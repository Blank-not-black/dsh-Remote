# 0.8.0-rc.4 本地构建与实装

2026-10-18 按用户要求构建并安装到本机 DSH Desktop。没有执行 `npm run release`，没有 Git 提交、推送、tag、npm/GitHub 发布或 Gitee 同步。`npm run publish` 在本仓库仅负责本地产物整理。

## 变更

- 手机、桌面 WS 仅共享尚未结束的票据请求，不再跨连接重试复用旧票据；只有明确不支持票据接口时才回退旧握手。请求与连接继续受 generation 保护，保留退避和轮询回退。关闭原因改为读取 CloseEvent。
- 远程生命周期命令执行前，原子保存回执到受保护的 `lifecycle-<网关端口>` 目录；请求 ID 可重复查询/去重。新网关接续原任务，仅核验 Desktop 身份、HTTP 和双通道，不重放命令。旧网关发现已核验的 Desktop 端口变更时等待交接；所有权交接后旧实例无法覆盖新实例回执。无法确认时明确返回待确认。
- 状态、POST 回执和状态轮询绑定原服务器/凭证/generation；切换服务器后不再更新当前界面。回执丢失后只查询原请求 ID，短暂断线、404、429和服务端错误在截止时间内继续核验。
- 新版主机元信息保留真实可得字段，缺失显示未知，不把 home 当工作目录；元信息成功不再覆盖上游失败。显式 fresh 探测等待本次健康结果，界面展示 HTTP、双通道与检查时间。
- 此包同时包含此前完成的结果栏/普通分支可见性、公告填空/多选/混合问卷、智能体团队查看、插件规则驱动 Android 峰谷提醒，以及后台状态和异常会话处理。详情见 `turn-results.md`、`announcement-forms-and-teams.md`、`peak-reminders-and-issue18.md`。

本轮主要文件：`gateway.js`、`public/app.js`、`public/desktop/desktop.js`、`public/index.html`；新测试 `tests/desktop-recovery.test.js`、`tests/lifecycle-handoff.test.js`、`tests/reconnect-integration.test.js`；扩展 `tests/dsh-process-control.test.js` 并调整相关 UI/文件保护夹具。根/插件/lockfile 版本、版本元数据、插件同步产物与 APK 同步更新。没有新增依赖。

## 验证

- 完整 `npm run check`：654 项，644 通过、10 跳过、0 失败；日志 `dist/rc4-2026-10-18/check.log`。
- 新增的 21 个恢复场景包含：两端连续 8 次真实网关握手、断线事件记录、旧元信息不能覆盖离线、切服隔离、丢失 POST 回执不重发、重复点击去重、完成回执过期仍保留成功、跨网关身份核验、错误身份/未提交命令不能误判成功、存储失败不执行命令，以及 Desktop 端口交接窗口。
- APK Gradle 构建成功；签名校验通过；`com.dshremote.app`，versionCode `8004`，versionName `0.8.0.rc.4`。
- 本机实际远程重启：原网关 PID `106048`，上游 `127.0.0.1:51242`；新网关 PID `106352`，上游 `127.0.0.1:51710`。同一任务 ID `22556f34-3051-436d-9b68-7cbe73887385` 在新网关完成，耗时约 16.4 秒，HTTP、mux/host 均恢复，没有重发重启 POST。
- 实装后从网关读取前端资源并逐项比对哈希；gzip 与 ETag/304 正常；RC 更新元数据按 JSON 内容一致性核验（路由会重新序列化 JSON），下载 APK 哈希与更新描述一致；只读 session.list 返回 34 项；真实 DSH 插件页 HTTP 200，状态为 `mode: gateway、gatewayInstalled: true`。
- 浏览器实际点击主机管理的探测入口，显示 Desktop 运行状态、HTTP 200、mux/host 正常；当前 DSH 未提供的版本/工作目录/附加会话数显示未知，没有伪造数值。没有观察到页面控制台错误。

## 安装与产物

- 安装 profile：`C:\Users\blank\.dsh\profiles\desktop`。
- 备份：`dist/local-install-2026-10-18-0.8.0-rc.4/`，包括旧插件、manifest、lockfile 和 profile 配置。pnpm 移除旧插件后从本地 tgz 安装；已核对其他依赖与 cordis/workspace 配置保持一致。
- APK：`dist/rc4-2026-10-18/dsh-remote-0.8.0-rc.4.apk`。
- 插件：`dist/rc4-2026-10-18/dsh-remote-plugin-0.8.0-rc.4.tgz`。
- APK SHA-256：`7a00d0d6b83dfd49cc1c86ba94ee09fe1e4a98eb393c88f6933cc185a31ad9a7`。
- 现场证据：同目录 `live-verification.json`、`live-restart.json`、`installed-version.png`；构建及安装日志也在此目录。

实装对象是本机 Desktop 插件及其网关，Android APK 已构建并由该网关提供下载，未执行手机真机安装。Android 息屏通知、省电策略和长时间后台仍需手机验证；未构建 HarmonyOS HAP。上游 issue #18 原始损坏日志的迁移错误仍需 DSH 修复，Remote 保留诊断和重试、不重写用户原始日志。
