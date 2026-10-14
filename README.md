# DSH Remote

> **把电脑上的 DSH，带到你的掌心。**
>
> 在手机或另一台电脑查看会话、处理审批与提问、传输文件，并掌握主机运行状态。

**中文** · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-remote-plugin)](https://www.npmjs.com/package/dsh-remote-plugin)
[![Release](https://img.shields.io/github/v/release/Blank-not-black/dsh-Remote?label=release)](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/release-build.yml?branch=main&label=CI)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/release-build.yml)
[![Compat](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/compat.yml?branch=main&label=compat)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/compat.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Android](https://img.shields.io/badge/Android-远程控制台-3DDC84?logo=android&logoColor=white)](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
[![WebUI](https://img.shields.io/badge/WebUI-桌面与移动端-5B8CFF)](https://github.com/Blank-not-black/dsh-Remote)
[![dshbase listed](https://dshbase.com/badges/dsh-Remote.svg)](https://dshbase.com/plugins/dsh-Remote/)
[![dsh.so risk](https://www.dsh.so/badge/dsh-remote-2.svg)](https://www.dsh.so/artifact/dsh-remote-2/)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-remote-2.svg)](https://www.dsh.so/artifact/dsh-remote-2/)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh-remote-plugin on dsh.fish](https://dsh.fish/a/dsh-remote-plugin/badge.svg)](https://dsh.fish/a/dsh-remote-plugin)
[![dshplugin.dev listed](https://dshplugin.dev/badges/blank-not-black-dsh-remote-plugin.svg)](https://dshplugin.dev/plugins/blank-not-black-dsh-remote-plugin)
[![dshfind](https://dshfind.com/api/badge/Blank-not-black/dsh-Remote)](https://dshfind.com/en/plugins/Blank-not-black/dsh-Remote?ref=badge)

DSH Remote 由 DSH 插件、单文件网关和多端客户端组成。插件提供 DSH 内入口并管理网关；网关负责鉴权、HTTP/实时代理和文件传输；客户端包括 Android、手机/桌面 WebUI 与 HarmonyOS 源码工程。

[文档首页](docs/README.md) · [安装指南](docs/getting-started.md) · [故障排查](docs/troubleshooting.md) · [下载](https://github.com/Blank-not-black/dsh-Remote/releases/latest) · [反馈](https://github.com/Blank-not-black/dsh-Remote/issues)

## 你可以做什么

| 能力 | 内容 |
| --- | --- |
| 会话控制 | 历史与实时消息、模型/思考档位、审批、提问、目标、队列与子代理 |
| 文件与图片 | 主机目录、预览、下载、分块续传、图片附件 |
| 主机状态 | 网关、DSH、双事件流、设备、Token 与费用估算 |
| 插件管理 | 当前主机已安装/发现插件、详情、配置启停与操作记录 |
| 会话洞察 | 可选 dsh-context 上下文与 dsh-cost-meter 费用/额度摘要 |
| 弱网与恢复 | 独立长轮询、WS 退避重连、历史缓存、gzip/ETag、受限异常恢复 |
| 多网络与主题 | 多地址配对、服务器分组、局域网/Tailscale、五套 Web 主题 |

手机底部导航为 **会话、文件、主页、插件、设置**；统计由主页简要用量与会话入口查看。桌面 WebUI 使用宽屏工作台、文件页和按需抽屉。详细操作与跨端差异见[使用指南](docs/usage.md)。

图片理解由 DSH 与模型能力决定；Remote 的费用估算不是供应商账单。会话洞察需安装对应主机插件，缺失时显示不可用。DSH UI 支持[安全只读子集](docs/dsh-ui-support.md)。

## 快速开始：DSH Web 插件

先确认 DSH Web 能正常打开，在运行 DSH 的同一用户下执行：

```sh
dsh plugin --profile web add dsh-remote-plugin@latest
dsh plugin --profile web list --depth 0
```

1. 完整重启 DSH Web，浏览器 Ctrl+F5，从侧栏打开 DSH Remote。
2. 确认网关运行，在主机打开 `http://127.0.0.1:8787/health`。
3. 在管理控制台生成二维码，用客户端「设置 → 服务器」扫码。
4. 手动连接时填写 `http://电脑局域网IP:8787` 和令牌。手机上的 localhost 指向手机自己。

示例使用 `web` profile，自定义 profile 请用实际名称。DSH Desktop 从桌面版自带插件管理入口安装，完整退出并重开；不要把 Web profile 的安装当作 Desktop 已安装。RC 包使用 `@next`，标签实际指向需查询 npm。

首次连接、多网卡、独立网关、固定版本和 Git 源安装见[安装指南](docs/getting-started.md)。

> 配对二维码包含凭证。使用可信局域网或 Tailscale；不要公开二维码/令牌或直接把网关端口暴露到公网。

## 截图

2026-10-12 更新：手机图片来自 Android 16 模拟器中实际运行的 0.7.4 APK；桌面、插件面板和管理页来自浏览器。会话、用量、设备和地址均为仿真示例，未使用真实 profile 或凭证；没有进行实体手机或 HarmonyOS 截图。[查看全部 19 张截图与说明](docs/screenshots/README.md)。

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/android-home-0.7.4-emulator.png" alt="Android App 主页，模拟器与示例数据" width="280"><br><sub>App 主页</sub></td>
    <td align="center"><img src="docs/screenshots/android-settings-0.7.4-emulator.png" alt="Android App 设置，模拟器与示例数据" width="280"><br><sub>App 设置</sub></td>
  </tr>
</table>

<p align="center"><img src="docs/screenshots/plugin-panel-0.7.4-demo.jpg" alt="插件面板示例" width="520"></p>
<p align="center"><img src="docs/screenshots/gateway-control-0.7.4-demo.jpg" alt="网关控制台示例" width="900"></p>

<p align="center"><img src="docs/screenshots/desktop-chat-0.7.4-demo.jpg" alt="桌面工作台，仿真会话与数据" width="900"></p>

## 下载与平台状态

[GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases) 提供版本与资产；[Latest](https://github.com/Blank-not-black/dsh-Remote/releases/latest) 是正式版入口，RC 单独用于验收。

| 平台 | 资产与范围 |
| --- | --- |
| Android | `dsh-remote.apk`，Capacitor 壳；相机、通知、后台及安装权限需真机确认 |
| Windows x64 | `dsh-remote-win-x64.exe`，免 Node 网关 |
| Linux x64 | `dsh-remote-linux-x64`，免 Node 网关，需执行权限 |
| 浏览器 | 连接网关，使用手机/桌面 WebUI |
| HarmonyOS | ArkTS/ArkUI 源码，需[自行构建与签名](docs/harmonyos-self-build.md)，当前发布流程不提供 HAP |
| macOS | 不在当前主发布工作流目标内；历史预览不保证每版同步 |

本轮文档源码基线为 **0.7.4（2026-10-12）**；HarmonyOS manifest 仍为 **0.6.26**。这不是对 GitHub/npm/Gitee 当前分发状态的独立核验，也不代表本轮完成 Android/HarmonyOS 真机验收。

Windows Desktop 启动/重启属实验能力，需要经过验证的实例与启动配置；网关必须在线，不注册 Windows 服务或登录自启。后台、恢复与文件授权边界见[配置参考](docs/configuration.md)。

## 文档与开发

| 内容 | 入口 |
| --- | --- |
| 用户文档 | [安装](docs/getting-started.md)、[使用](docs/usage.md)、[配置](docs/configuration.md)、[排障](docs/troubleshooting.md) |
| 功能专题 | [插件中心](docs/plugin-center.md)、[会话洞察](docs/plugin-insights.md)、[DSH UI](docs/dsh-ui-support.md) |
| 开发与接口 | [开发指南](docs/development.md)、[模块索引](docs/modules/README.md)、[兼容性](docs/compatibility.md) |
| 构建与发布 | [发布指南](docs/release.md)、[鸿蒙自构建](docs/harmonyos-self-build.md) |
| 历史与设计 | [历史索引](docs/archive/README.md)、[文档核对记录](docs/documentation-audit.md) |

网关零运行时依赖，WebUI 零构建纯 JS；整个仓库保留已有 Capacitor/AndroidX 与本地 vendored 资源。开发不新增依赖，遵守 [AGENTS.md](AGENTS.md)，改根 `public/` 或网关后同步插件副本。

```sh
npm ci
npm run sync-plugin
npm run check
git diff --check
```

Android 构建为 `npm run build-app`，本地 APK/更新元数据准备为 `npm run publish`。正式 `npm run release <version>` 会提交全部非忽略改动、推送并更新 tag，需按发布流程明确授权；`--dry-run` 仍修改本地文件。

## 贡献者与致谢

感谢代码、修复、文档与反馈贡献者。以下名单与客户端离线致谢保持一致，完整历史见 [GitHub Contributors](https://github.com/Blank-not-black/dsh-Remote/graphs/contributors)：

- [Blank-not-black](https://github.com/Blank-not-black)
- [wikkd](https://github.com/wikkd)
- [anupamme](https://github.com/anupamme)
- [liuchang-t](https://github.com/liuchang-t)

客户端设置中的关于页提供贡献者入口；历史名单不是本轮重新查询的贡献排名。

## ☕ 支持项目

如果 DSH Remote 对你的工作流有帮助，欢迎给项目点一个 Star，或请作者喝杯咖啡。每一份反馈、Issue、PR 和赞赏，都会帮助这个小工具继续变得更可靠。

<p align="center">
  <img src="public/donate.png" alt="DSH Remote 赞赏码" width="420">
</p>

## License

[MIT](LICENSE)
