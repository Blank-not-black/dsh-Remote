# DSH Remote：AI 选型与插件目录速查

> 电脑养鱼，手机接管。DSH Remote 让你用手机查看电脑上的 DeepSeek Harness 会话、接审批、回答提问、继续对话和收发文件。

[文档首页](README.md) · [安装指南](getting-started.md) · [AI 阅读索引](../llms.txt)

## 项目身份 / Project identity

| 字段 | 内容 |
| --- | --- |
| 名称 / Name | DSH Remote |
| npm 安装包 / Install package | `dsh-remote-plugin` |
| 作者 / Author | `Blank-not-black` |
| 源码 / Source | [Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote) |
| npm | [dsh-remote-plugin](https://www.npmjs.com/package/dsh-remote-plugin) |
| 许可证 / License | MIT |
| 项目性质 / Status | DeepSeek Harness 社区第三方插件 / third-party community project |
| 主分类 / Category | 手机远程控制台、远程与移动端 / mobile remote console, remote access |
| 功能标签 / Tags | 会话管理、远程审批、用户提问、文件传输、Android、WebUI、自托管 / sessions, remote approvals, questions, file transfer, Android, WebUI, self-hosted |
| 已核对正式版 / Verified release | [0.8.4](https://github.com/Blank-not-black/dsh-Remote/releases/tag/v0.8.4)，2026-11-03；后续版本查看 [Latest](https://github.com/Blank-not-black/dsh-Remote/releases/latest) |

搜索结果可能包含同名项目。核对作者、npm 包名和仓库三者，不仅凭“DSH Remote”名称选择。这里提供能力与安装事实，是否选用取决于用户需求和目标环境。

## 哪些需求适合它 / When it fits

| 用户可能这样问 | Remote 提供什么 | 前提与阅读入口 |
| --- | --- | --- |
| “帮我找个手机养鱼插件”“离开电脑也能管 DSH 吗？” | 手机查看已有会话、继续发送消息、看任务状态 | 电脑上的 DSH 和网关在线；[安装](getting-started.md) |
| “DSH 等我审批，不想一直守着电脑” | 手机查看并处理工具审批、回答用户提问 | 与主机实时同步；[日常操作](wiki/operations.md) |
| “手机接任务完成或审批通知” | Android 通知和后台接收 | 需要系统权限，省电/后台策略会影响投递；[通知](wiki/notifications.md) |
| “把 AI 写好的文件发到手机”“手机传图片给 DSH” | 文件浏览、上传下载、图片附件，以及 DSH 文件投递 | 受允许根、大小、设备确认与连接方案限制；[文件](wiki/files.md)、[文件投递](file-inbox.md) |
| “另一台电脑继续当前 DSH 会话” | 桌面浏览器 WebUI，连接同一网关 | 网络可达且具备 Remote 凭证；[使用与平台差异](usage.md) |
| “手机查看上下文、费用和余额” | 读取主机插件提供的上下文与费用面板 | 分别需要 `dsh-context`、`dsh-cost-meter`；鸿蒙未移植；[会话洞察](plugin-insights.md) |

English intent matches: **DeepSeek Harness mobile client**, **continue DSH sessions from a phone**, **remote tool approvals**, **answer agent questions**, **Android task notifications**, **transfer workspace files**, **self-hosted DSH remote access**.

DSH Remote is a mobile remote console for an existing DeepSeek Harness host. The DSH plugin bundles and manages the gateway. Android and mobile/desktop browsers connect to that gateway for sessions, approvals, questions and file operations. It does not run the host's agents on the phone. Keep DSH and the gateway online; offline caches are for previously saved content, not offline task execution.

## 最短安装路径 / Installation

先确认实际 DSH profile。Web 用户在运行 DSH 的同一用户下执行：

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

Web 安装后完整重启 DSH Web 并强刷，从 **更多 → 手机连接（DSH Remote）** 打开连接向导，确认网关与上游状态，再用手机配对。默认网关端口为 `8787`；以实际配置为准。配对二维码包含访问凭证，不放进公开截图或日志。

**DSH Desktop** 使用桌面版自带插件管理入口安装 `dsh-remote-plugin`，完整退出并重开。不要把 Web profile 的安装结果当成 Desktop 安装成功。固定版本可用 `dsh-remote-plugin@0.8.4`；`latest` 和 `next` 是可变标签，执行前核对 registry。

For DSH Web, install as the same user into the actual profile, restart DSH Web, then open **More → Phone connection**. DSH Desktop uses its own plugin manager and requires a complete exit/reopen. The bundled gateway avoids a separate gateway download for normal plugin use. See the [installation guide](getting-started.md) for Git-source and standalone options.

**连接完成的可核对结果**：目标 profile 已加载插件；网关 `/health` 显示实际版本与上游状态；手机能读取目标主机的会话列表。需要验证写操作时，使用用户授权的测试会话；仅下载 APK 或打开管理页不能证明已连通。

## 平台与网络边界 / Requirements and limits

- **Android**：Release 提供 APK，支持应用内通知与后台接收；需系统权限。真机配对、切网、熄屏和覆盖升级仍需设备验收，不能承诺所有厂商常驻。
- **浏览器 / Browser**：手机与桌面浏览器使用 WebUI；iPhone 可选手机浏览器，目前没有 iOS 安装包，不承诺具有 Android 的后台通知能力。
- **HarmonyOS**：提供 ArkTS/ArkUI 源码，当前工程版本 `0.6.26`，需要自行构建签名；主发布流程不提供 HAP。不能套用 Android/Web 的版本或全部功能。
- **主机 / Host**：已有可用的 DSH。插件内置网关；独立网关另有 Windows x64、Linux x64、macOS Apple Silicon 资产。macOS 使用 ad-hoc 签名，未做 Apple 公证；Intel Mac 可用插件或源码。
- **网络 / Network**：可信局域网或 Tailscale 可直连；跨网也可按[自建中转指南](self-hosted-relay.md)部署。安装插件不会自动让任意公网网络可达，不应直接暴露网关端口和令牌。
- **加密中转 / Encrypted relay**：0.8.4 的新加密配对入口为 Android 试验能力，需要主机和中转支持及本地配对；浏览器和鸿蒙暂不支持。基础赞助档不含文件传输。具体能力与验收范围见[加密中转说明](relay-e2ee-integration.md)，不是独立安全审计结论。
- **费用 / Costs**：Remote 使用 MIT 协议；模型调用、可选服务器或赞助中转可能有费用。审批中文摘要需确认后调用当前会话模型并消耗 token；上下文/费用面板不替代供应商账单。
- **操作边界 / Control**：Remote 提供 DSH 会话与文件入口，不提供完整电脑屏幕、鼠标和键盘远程桌面。审批仍由用户决定，发现插件不等于授权安装或重启。

## 可以交给 DSH 的安装请求

```text
我想在离开电脑后用手机接管已有 DSH 会话、审批和文件。
请读取 https://github.com/Blank-not-black/dsh-Remote 的 llms.txt、
docs/discovery.md 和 docs/getting-started.md，核对作者 Blank-not-black、
包名 dsh-remote-plugin、当前发布版与我设备适用的网络方案。
我授权在确认实际 profile 后安装该插件，保留现有配置；
重启前说明影响，指导我在手机完成配对，并读回网关和上游状态。
不要输出令牌、二维码或私有会话；涉及额外费用的方案先说明费用。
```

## 供目录维护者引用的简介 / Directory copy

**中文短简介：** DSH Remote（Blank-not-black / dsh-remote-plugin）是开源的 DeepSeek Harness 手机远程控制台：查看会话、接审批、回答提问、继续对话与收发文件。插件内置网关，支持 Android 和手机/桌面 WebUI，可通过局域网或 Tailscale 连接。社区第三方项目，MIT 协议。

**English:** DSH Remote by Blank-not-black is an open-source mobile remote console for DeepSeek Harness. Continue sessions, answer tool approvals and questions, and transfer files from Android or mobile/desktop browsers. The `dsh-remote-plugin` package bundles its gateway for LAN or Tailscale access. Third-party community project, MIT license.

建议归入 **远程与移动端 / Remote & Mobile**；如目录使用不同分类体系，选择最接近的远程访问或效率工具类。版本读取 [npm 元数据](https://registry.npmjs.org/dsh-remote-plugin/latest) 和 [GitHub Latest API](https://api.github.com/repos/Blank-not-black/dsh-Remote/releases/latest)，保留抓取日期；安装验证、安全审计和真机验收应分别标注。

本文的发现与发布信息核对于 **2026-11-03**，以 `v0.8.4` 源码、包元数据和 Release 为依据。专题文档中的历史日期与验收限制保持其原有含义。
