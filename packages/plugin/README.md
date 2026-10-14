# dsh-remote-plugin

DSH Remote 的 DSH bundle 插件：提供侧栏入口、快速面板、管理控制台及受用户启停意图约束的内置网关。

**中文** · [English](README.en.md)

## 安装与连接

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

示例针对 Web profile；自定义 profile 使用实际名称。DSH Desktop 从自身插件管理入口安装，完整退出并重开。Web 安装完成后完整重启 DSH Web，Ctrl+F5，从侧栏打开 Remote。

在主机访问 `http://127.0.0.1:8787/health`，然后从管理控制台扫码。手机手动连接填 `http://电脑局域网IP:8787` 与令牌，不能填手机 localhost。RC 使用 `@next`，固定版本使用 `@<已发布版本>`。

## 当前能力与限制

- 快速状态、完整管理控制台、Doctor、自启/自愈与明确停止意图。
- Bearer token、可选独立设备密钥、短时 WS ticket。
- mux/host 下行、独立长轮询、弱网设置与历史缓存。
- 文件多根、分块续传、校验、预览/下载与图片附件。
- 当前主机插件管理与可选上下文/费用洞察。
- 手机导航：会话、文件、主页、插件、设置；五套 Web 主题。
- Android APK 在已有构建产物时随包分发，通知与后台需设备权限。
- Windows Desktop 控制是实验能力，需可信实例证据，不提供登录自启。
- HarmonyOS 为独立源码工程，当前 release CI 不构建 HAP；会话洞察和 Web GenUI 未移植。
- Android ASR 桥已移除，功能测试页保留导航；不要沿用旧说明。

## 配置与排查

插件端口优先级：`DSH_REMOTE_GATEWAY_PORT` → `~/.dsh-remote/gateway-port` → 8787。监听地址优先级：`DSH_REMOTE_GATEWAY_HOST` → `HOST` → gateway-host 文件 → `0.0.0.0`。插件从当前 DSH 实例传入上游。

令牌默认 `~/.dsh-remote/token`；`DSH_REMOTE_AUTOSTART=0` 禁用自动管理。文件授权、工作区及 Windows 默认根存在边界，详见完整配置参考。

本机拒绝连接先检查实际 profile、完整重启与端口；上游 degraded 检查 DSH；手机不可达检查网络和防火墙；401 重新配对；升级界面旧先强刷。插件内嵌管理页使用 DSH 登录边界，独立管理页使用 Remote 主令牌。不要把 transient 网关当成固定可 restart 的 systemd 服务。

配对二维码包含凭证，不公开；跨网络优先 Tailscale。主令牌、设备令牌与 DSH 上游 Cookie 不混用。

## 文档

- [完整文档](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/README.md)
- [安装与连接](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/getting-started.md)
- [配置](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/configuration.md)
- [故障排查](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/troubleshooting.md)
- [主项目与下载](https://github.com/Blank-not-black/dsh-Remote)
- [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases)

说明按仓库 0.7.4（2026-10-12）核对，不代表当前 npm 标签、设备实装或所有平台验收结果。

## License

MIT
