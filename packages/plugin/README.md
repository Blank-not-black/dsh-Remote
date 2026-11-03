# dsh-remote-plugin

**电脑养鱼，手机接管。** DSH Remote 是 DeepSeek Harness 的手机远程控制台：电脑上的智能体继续工作，你用手机查看会话、接审批、回答提问、继续对话和收发文件。

社区第三方项目，作者 **Blank-not-black**，MIT 协议。安装包 **`dsh-remote-plugin`** 对应源码 **[Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)**；插件内置网关，常规安装无需另外下载网关或在手机运行 DSH。主机与网关需保持在线。

**中文** · [English](README.en.md)

## 适合什么时候用

- 电脑上运行 DSH，人暂时离开电脑，想在手机看进度、处理工具审批与用户提问。
- 想从手机继续已有会话、上传图片或把工作区文件带走；文件能力受授权目录与连接方案限制。
- 想让 DSH 帮你找“手机养鱼 / 手机远程 / remote approvals”插件：先读 [AI 选型速查](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/discovery.md) 和 [llms.txt](https://github.com/Blank-not-black/dsh-Remote/blob/main/llms.txt)，核对包名、平台与网络要求。

截至 2026-11-03，已发布正式版 [0.8.4](https://github.com/Blank-not-black/dsh-Remote/releases/tag/v0.8.4)；后续版本见 [Latest](https://github.com/Blank-not-black/dsh-Remote/releases/latest)。Android 和手机/桌面浏览器可连接，HarmonyOS 需要自行构建签名。局域网/Tailscale 可直连；Android 试验性加密中转需对应主机能力与配对，浏览器和鸿蒙暂不支持该配对入口，基础赞助档不含文件传输。

[操作与排障知识库](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/wiki/README.md)按任务、症状和错误码导航；用户 AI 可从仓库根 llms.txt 开始。包内离线副本位于 `skills/dsh-remote-doctor/references/wiki/`，内置 Doctor 按需读取并引用 KB 编号。

## 安装与连接

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

示例针对 Web profile；自定义 profile 使用实际名称。DSH Desktop 从自身插件管理入口安装，完整退出并重开。Web 安装完成后完整重启 DSH Web，Ctrl+F5，从左侧导航「更多 → 手机连接（DSH Remote）」进入浏览器配对页。首次加载会提示入口位置；选择「开始连接」或「稍后」后不再重复提示。旧宿主缺少该菜单扩展点时，入口保留在左下角。

在主机访问 `http://127.0.0.1:8787/health`，然后在插件连接向导或管理控制台显示连接二维码。手机通过「更多 → 主机与连接 → 扫码连接」配对；APK 下载码只用于安装。手动连接填 `http://电脑局域网IP:8787` 与令牌，不能填手机 localhost。固定版本使用 `@<已发布版本>`，`@next` 与 `@latest` 的指向需另行查询。

## 当前能力与限制

- 快速状态、完整管理控制台、Doctor、自启/自愈与明确停止意图。
- Bearer token、可选独立设备密钥、短时 WS ticket。
- mux/host 下行、独立长轮询、弱网设置与历史缓存。
- 文件多根、分块续传、校验、预览/下载与图片附件。
- 当前主机插件管理与可选上下文/费用洞察。
- 手机导航：会话、文件、更多；十二套 Web 主题（含孤独摇滚四人、企鹅女管·白昼/极夜角色皮肤），默认蓝色大肥鱼，保留已有主题选择。
- 手机端八步新手引导；完成或整体跳过后移除首页入口，在「更多 → 偏好与维护 → 新手引导」重新学习。
- 0.8.4 新增按需审批中文摘要、主机插件一键更新及 Android 试验性端到端加密中转；摘要经确认调用当前会话模型并消耗 token，仅供审批参考。
- Android APK 在已有构建产物时随包分发，通知与后台需设备权限。
- Windows Desktop 控制是实验能力，需可信实例证据；管理页可选网关登录自启，默认关闭，不注册系统服务。
- HarmonyOS 为独立源码工程，当前 release CI 不构建 HAP；会话洞察和 Web GenUI 未移植。
- Android ASR 桥和空功能测试页入口已移除；通知测试位于高级通知选项。
- macOS 可通过插件使用同一网关源码；主发布 CI 已配置 Apple Silicon 独立网关构建、ad-hoc 签名和启动冒烟，未做 Apple 公证。

## 配置与排查

插件端口优先级：`DSH_REMOTE_GATEWAY_PORT` → `~/.dsh-remote/gateway-port` → 8787。监听地址优先级：`DSH_REMOTE_GATEWAY_HOST` → `HOST` → gateway-host 文件 → `0.0.0.0`。插件从当前 DSH 实例传入上游。

令牌默认 `~/.dsh-remote/token`；`DSH_REMOTE_AUTOSTART=0` 禁用自动管理。文件授权、工作区及 Windows 默认根存在边界，详见完整配置参考。

本机拒绝连接先检查实际 profile、完整重启与端口；上游 degraded 检查 DSH；手机不可达检查网络和防火墙；401 重新配对；升级界面旧先强刷。插件内嵌管理页使用 DSH 登录边界，独立管理页使用 Remote 主令牌。不要把 transient 网关当成固定可 restart 的 systemd 服务。

配对二维码包含凭证，不公开；跨网络优先 Tailscale。主令牌、设备令牌与 DSH 上游 Cookie 不混用。

## 文档

- [完整文档](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/README.md)
- [安装与连接](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/getting-started.md)
- [AI 选型与目录收录](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/discovery.md)
- [0.8.4 发布记录](https://github.com/Blank-not-black/dsh-Remote/releases/tag/v0.8.4)
- [新手引导](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/onboarding-guided-practice.md)
- [配置](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/configuration.md)
- [故障排查](https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/troubleshooting.md)
- [主项目与下载](https://github.com/Blank-not-black/dsh-Remote)
- [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases)

项目与发布信息按 2026-11-03 的 0.8.4 核对；npm 标签、已安装版本及设备权限需在目标环境确认。旧专题指南保留原核对日期，Android 真机与 macOS 真机验收未因此补齐。

## License

MIT
