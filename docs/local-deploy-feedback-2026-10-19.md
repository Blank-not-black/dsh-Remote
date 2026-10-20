# 本地部署：10 月 19 日反馈修复预览

按用户后续“本地部署”要求，将 `dist/feedback-preview-2026-10-19/dsh-remote-plugin-0.8.0-rc.5.tgz` 安装到实际运行的 `C:\Users\blank\.dsh\profiles\desktop`。同版本预览补丁，未提交、推送、打 tag 或发布。

## 安装与保护

- 通过当前进程命令确认 Desktop 为 `D:\dsh_desktop\DeepSeek Harness.exe`，其 Host 使用上述 desktop profile。安装前插件中心无活动任务，最近会话列表无运行任务。
- 在 `dist/local-install-feedback-2026-10-19/` 备份控制文件、完整 `node_modules`、本地插件源码和原进程身份。备份复制经过完整内容指纹核验；普通同步复制将 junction 实体化的首份副本也保留，实际恢复依据使用保留链接的异步副本。
- 使用鉴权 `/admin/api/shutdown` 停止网关，关闭确认过路径和出生时间的 Desktop/Host；没有按进程名批量终止其他 Node 程序。
- 用同一 Desktop 附带的 pnpm **11.28.5** 离线移除旧本地 tarball 引用，再安装新本地 tarball，禁用安装脚本。最初 `remove --offline` 被参数校验拒绝，尚未改变安装；之后改用支持的 `--config.offline=true`。
- **82 个安装文件逐字节匹配预览暂存包**。manifest 仅 Remote tarball 指向改变；workspace、Cordis 配置、停用列表和其他插件内容核对未变。`dsh-cost-meter` 保持原 `1.8.17`，没有自动重试它的版本更新。
- 重启同一 Desktop 安装。新网关 PID **114180**，实际上游 `http://127.0.0.1:61114`（此次验证快照）。

## 在线验证

- 网关 `0.8.0-rc.5`、上游 HTTP **200**，mux/host collector 正常；认证票据建立两条真实 WebSocket 通道成功。
- **13 个实际服务资源**与新安装文件一致，包括图片引用预览、手机/桌面聊天、插件发现、README、Token/API/Plan 费用面板。gzip 解压内容一致，ETag 返回 **304**。
- RC 元数据通过 `/update.json?local=0.8.0-rc.5` 验证；网关实际下载 APK SHA-256 为 `acaa8569ca9c46298d6c9dd07d151b991bf7816f2df395a45483dd9531891b8b`，与预览包一致。
- 实际插件页 **200**，状态为 `mode: gateway`、`gatewayInstalled: true`。
- 费用接口来源 `dsh-cost-meter`，新 Token 字段、API/Plan 等值拆分、**1** 项可展示套餐和最近 **7** 个记账日均可读取；内嵌管理端与网关端读取一致。
- 新快照指纹代码可读取实际含自动审查插件 junction 的完整插件树，未再报“快照路径越界”。没有实际发起 cost-meter 安装或恢复任务。
- 会话列表只读请求成功。结束临时 WebSocket 验证进程后，确认网关仍是同一 PID 且上游与双通道正常。

## 当前边界

主机未启用官方 `pluginMarket` 服务，实时 `/market/indexes` 返回 `available:false, code:not-installed`。发现页按设计显示“Remote 已适配”和配置提示；本次没有修改索引源或自动启用官方服务。

安装对象是 Windows Desktop 插件与网关；新 APK 已由本机网关提供下载，尚未安装到手机。浏览器工具此前无法打开本地验收页，本轮以实际 HTTP 资源、接口与通道核验为依据，不宣称完成手机显示或灯箱点击的人工验收。

证据：备份目录中的 `before.json`、`installed.json`、`live.json`、进程记录及 pnpm 日志。构建和隔离测试见 [反馈实现报告](feedback-2026-10-19.md)。本轮没有追加产品源码改动。
