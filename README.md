# DSH Remote

> **把电脑上的 DSH，带到你的掌心。**
>
> DSH Remote 是一套面向 DSH 的远程控制台：在手机或另一台电脑上查看会话、处理审批与提问、传输文件，并掌握主机运行状态。

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

<p align="center">
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-应用内截图">查看截图</a> ·
  <a href="#-下载">下载</a> ·
  <a href="https://github.com/Blank-not-black/dsh-Remote/issues">反馈问题</a>
</p>

<p align="center">
  <em>不是把整台电脑搬到手机上，而是把 DSH 最重要的决策面带到你身边。</em>
</p>

DSH Remote 由三个相互配合的部分组成：DSH 插件、独立网关和 Android 应用 / WebUI。插件负责在 DSH 侧提供入口并管理网关；网关负责鉴权、实时连接和文件传输；手机端与桌面端则把不同场景下的远程操作做得更清晰、更顺手。

### 3 分钟开始连接

```sh
dsh plugin --profile web add dsh-remote-plugin
```

完整重启 DSH Web 后，从侧栏打开 DSH Remote。管理控制台会按顺序检查 DSH、网关、局域网地址、主机防火墙、终端配对与实时通道；跟随提示启动网关并扫码，即可在手机继续会话。详细步骤和故障排查见[快速开始](#-快速开始插件模式推荐)。

> 手机和电脑应位于同一可信局域网，或通过 Tailscale 互通。不要把网关端口直接暴露到公网，也不要公开配对令牌。

## ✨ 为什么是 DSH Remote

| 能力 | 你能得到什么 |
| --- | --- |
| 🧠 会话远程控制 | 随时查看会话、继续工作、切换模型和自定义思考档位、处理目标与后台任务 |
| 🔔 实时决策通知 | 审批、提问、任务状态实时到达；网络波动时自动降级并恢复 |
| 📁 文件与图片 | 浏览主机目录、断点传输文件，把照片或相册图片作为会话附件发送 |
| 📊 运行全景 | DSH 版本、网关链路、设备连接、Token、费用和近期活动集中呈现 |
| 🌐 多网络接入 | 支持局域网、Tailscale 和可靠的 WebSocket 隧道 |
| 🎨 一套设计语言 | 手机端、桌面端、插件面板和管理控制台共享主题与状态色 |

## 🧩 三个部分，各司其职

| 部分 | 角色 |
| --- | --- |
| **DSH 插件** | 提供 DSH 内入口，自动管理网关，展示主机与网关状态 |
| **独立网关** | 负责令牌鉴权、实时 mux/host 链路、文件传输和设备监控 |
| **Android 应用 / WebUI** | 提供手机、桌面浏览器和插件内嵌的远程操作界面 |

> 🔐 令牌就是远程控制凭证。默认不额外引入账号系统，部署简单，但请像保护 SSH 密钥一样保护它。

## 🖼️ 应用内截图

真实界面示例，截图中的会话标题、地址和令牌已做模糊处理。

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/mobile-home-0.6.9-rc.1.png" alt="新版手机端主页" width="280"><br><sub>新版主页：链路健康、运行指标与活动</sub></td>
    <td align="center"><img src="docs/screenshots/mobile-settings-0.6.9-rc.1.png" alt="新版手机端设置" width="280"><br><sub>新版设置：服务器、通知、皮肤与反馈</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/plugin-panel-latest.png" alt="DSH Remote 插件面板" width="520"><br>
  <sub>插件面板：网关状态、用量概览与快捷控制</sub>
</p>

<p align="center">
  <img src="docs/screenshots/gateway-control-latest.png" alt="DSH Remote 网关管理控制台" width="900"><br>
  <sub>网关控制台：版本、设备、请求和 Token 用量一屏掌握</sub>
</p>

## 🎯 适合什么场景

- DSH 在电脑上运行，但你想用手机查看会话、回复提问或处理工具审批。
- 你需要在手机与 DSH 工作目录之间传输文件，或把图片作为当前会话的附件发送。
- 你需要从另一台电脑查看会话、文件、Token 统计和设备连接状态。
- 你希望通过局域网或 Tailscale 访问，而不为 DSH 额外搭建账号系统。

## 🧭 当前界面

### 📱 手机端 / Android 应用

手机端进入后默认显示主页，底部导航为：

| 页面 | 主要内容 |
| --- | --- |
| 会话 | 会话列表、工作台项目、运行状态、归档和新建会话 |
| 文件 | 目录浏览、下载、上传、断点续传、暂停/继续/取消 |
| 主页 | DSH 版本、网关状态、链路健康、待处理事项、近期活动 |
| 统计 | Token 四桶、费用、高峰占比和近 7 日用量 |
| 设置 | 服务器、令牌、模型提供方、功能测试、通知、后台轮询、皮肤、更新和反馈 |

会话详情页支持实时消息、历史加载、目标控制、子代理中断、斜杠命令、模型切换、模型级思考档位和全屏输入。设置 → 模型中可为自定义提供方的每个模型配置档位名称、档位值、说明和默认档位；选择结果通过 DSH 适配器转换为第三方接口参数。全屏输入会保留会话标题栏，发送动作上移到标题栏；退出全屏可以点击收起按钮、下滑顶部手柄或使用系统返回键。

图片附件入口支持拍照和相册选择。图片会作为 `session.prompt` 的图片内容发送到当前 DSH 会话；图片能力仍取决于当前 DSH 组合和模型路由是否支持图像输入。

### 🖥️ 桌面端 WebUI

电脑浏览器打开网关地址时会自动进入桌面布局：

- 左侧会话列表与工作台项目；
- 文件传输；
- 主页总览；
- 统计抽屉；
- 设置、服务器分组和主题切换；
- 审批 / 提问通知卡片栈。

### 🛠️ 插件面板与管理控制台

DSH 插件入口提供快速状态面板，可查看网关运行情况、设备数、Token 用量和快捷操作。进入管理控制台后可以查看：

- 网关版本、运行时长、端口和 DSH 上游状态；
- 主机 IP、已连接设备、请求数、通道和最后活跃时间；
- Token 统计与近 7 日峰谷用量；
- 令牌复制、二维码配对和令牌轮换；
- 首次连接向导与 Doctor 自检，逐项显示 DSH、网关、网络、终端和实时链路状态；
- 网关启动 / 停止、自愈设置和更新检查。

## 📦 下载

所有正式版资产位于 [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest)。RC 版本只用于真机验收，不会替代 Latest 正式版。

| 平台 | 资产 | 说明 |
| --- | --- | --- |
| Android | `dsh-remote.apk` | 手机远程控制台，支持相机、通知和应用内更新 |
| Windows x64 | `dsh-remote-win-x64.exe` | 单文件网关，不需要额外安装 Node.js |
| Linux x64 | `dsh-remote-linux-x64` | 单文件网关，赋予执行权限后运行 |
| macOS Apple Silicon | `dsh-remote-macos-arm64` | 独立预览产物，未承诺与主版本同步 |

## 🚀 快速开始：插件模式（推荐）

先确认 DSH Web 本身可以在这台电脑上正常打开，然后在安装 DSH 的同一用户下执行：

```sh
dsh plugin --profile web add dsh-remote-plugin
dsh plugin --profile web list --depth 0
```

第二条命令用于确认插件确实装进了 `web` profile。接着：

1. **完整重启 DSH Web 进程**。如果你是手动运行 `dsh web`，先停止旧进程再重新运行；如果你配置了 systemd 用户服务，可执行 `systemctl --user restart dsh-web`。
2. 在 DSH Web 中执行一次 Ctrl+F5，从左侧入口打开 DSH Remote 面板。
3. 在插件面板确认“网关已运行”，然后先在 DSH 主机上打开 `http://127.0.0.1:8787/health`。看到 JSON 即表示网关端口已可用。
4. 从插件面板复制令牌或打开配对二维码。令牌也保存在 `~/.dsh-remote/token`，请勿公开。
5. 安装 Android 应用，在「设置 → 服务器」中扫码，或手动填写 `http://电脑局域网IP:8787` 和令牌。手机中不能填 `127.0.0.1` 或 `localhost`，它们指向手机自己。
6. 另一台电脑可直接打开 `http://DSH主机IP:8787`，桌面浏览器会进入桌面 WebUI。

也可以安装指定版本或 Git 源：

```sh
# 指定正式版本
dsh plugin --profile web add dsh-remote-plugin@0.6.8

# monorepo 插件目录
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

插件内置网关，默认监听 `0.0.0.0:8787`，并随 DSH 自动启动和自愈。网关意图保存在 `~/.dsh-remote/gateway.enabled`，令牌保存在 `~/.dsh-remote/token`。

## 🩺 网关打不开：按顺序排查

先在 **DSH 所在电脑** 上测试，再测手机。这样可以快速区分“网关没启动”和“网络无法到达”。

```bash
# 1. 网关是否在监听
curl -i http://127.0.0.1:8787/health

# 2. Linux 查看 8787 端口的真实占用者
ss -ltnp | grep ':8787'

# 3. DSH Web 上游是否可访问（默认 3080）
curl -i http://127.0.0.1:3080/
```

Windows 可用 `netstat -ano | findstr :8787`，或在 PowerShell 执行 `Invoke-RestMethod http://127.0.0.1:8787/health`。

| 现象 | 原因与处理 |
| --- | --- |
| 本机 `127.0.0.1:8787` 直接拒绝连接 | 网关未启动、插件未装在 `web` profile、自动启动被关闭，或者端口已被其他进程占用。先查插件面板，再完整重启 DSH Web。 |
| `/health` 返回 `ok: true` 但 `upstreamOk: false` | 网关已打开，是 DSH Web 上游不可达。检查 3080 端口和 DSH Web 进程；不要把 degraded 误当成网关未启动。 |
| 本机能打开，手机打不开 | 确认手机使用的是电脑局域网 IP 或 Tailscale IP，不是 `127.0.0.1`；确认两端网络互通、路由器未启用 AP 隔离，且防火墙允许 **TCP 8787 入站**。不需要对公网放行 DSH 3080。 |
| 页面打开但提示 401/未授权 | 网络正常，令牌不一致。从当前插件面板重新扫码，或重新复制 `~/.dsh-remote/token`。 |
| 页面黑屏或升级后功能没变 | 先 Ctrl+F5 强刷，手机端完全退出 App 后重开，避免旧静态资源缓存。 |
| 改过端口后 8787 打不开 | 实际端口优先级为 `DSH_REMOTE_GATEWAY_PORT` → `~/.dsh-remote/gateway-port` → 8787。手机、防火墙和浏览器地址必须同步修改。 |

如果使用 systemd 运行 DSH，还可查看：

```bash
systemctl --user status dsh-web --no-pager
journalctl --user -u dsh-web -n 100 --no-pager
```

> 插件拉起的网关可能是 transient 进程，不要把 `systemctl --user restart dsh-remote-gateway.service` 作为通用重启方式。优先使用插件面板的“启动网关”，或重启 DSH Web 让插件自愈拉起。发布日志或截图前，请隐藏令牌。

## 🧰 独立网关模式

不使用 DSH 插件时，可以直接下载对应平台的单文件网关：

```sh
./dsh-remote-linux-x64

# 自定义端口或固定令牌
PORT=9000 TOKEN=your-token ./dsh-remote-linux-x64
```

默认上游为本机 DSH Web `http://127.0.0.1:3080`，默认监听 `0.0.0.0:8787`。管理页地址为 `http://127.0.0.1:8787/admin`。

## 📁 文件传输

手机端和桌面端都可以使用文件页。网关文件端点受到 Bearer token 保护：默认允许当前用户目录，并会向本机 DSH 校验后自动允许 `workspace.list` 中已登记的工作区目录。

- 默认单文件上限为 2GB，可通过 `DSH_REMOTE_FS_MAX_UPLOAD` 调整；
- 上传支持分块、断点续传、暂停、继续和取消；
- 完成上传前进行 SHA-256 校验，校验通过后再原子落位；
- 拒绝 `../` 路径穿越、绝对路径逃逸和指向允许根目录之外的符号链接；
- DSH 工作区无需手动配置允许范围；对于 DSH 尚未登记的其他目录，可用 `DSH_REMOTE_FS_ROOT` 配置多个允许根目录，Linux/macOS 使用 `:` 分隔，Windows 使用 `;` 分隔。

示例：

```bash
TOKEN=$(cat ~/.dsh-remote/token)
HOST=http://127.0.0.1:8787

curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list"
curl -OJ -H "Authorization: Bearer $TOKEN" "$HOST/fs/file?path=~/Downloads/example.zip"
curl -H "Authorization: Bearer $TOKEN" --data-binary @./photo.jpg \
  "$HOST/fs/upload?path=~/Downloads&name=photo.jpg"
```

## 🌐 远程访问与安全

- 局域网访问：手机和电脑在同一网络，访问电脑的局域网 IP；
- Tailscale：两端加入同一网络后，使用电脑的 `100.x.x.x` 地址；
- 公网隧道：只使用带认证、可靠支持 WebSocket 的方案，并限制暴露范围。

网关默认监听所有网卡，令牌等同于 DSH 的远程操作凭证。请不要把令牌提交到仓库、截图公开或写入 URL 后转发给他人。实时连接使用 WebSocket；连续失败后会自动降级为轮询，恢复后再切回实时通道。

网关控制台可以选择开启「独立设备密钥」。开启后，共享令牌只用于进入管理控制台，每台手机或浏览器使用各自的设备令牌；控制台按“备注、最近 IP、Token”列出设备密钥，并支持分别生成二维码、轮换、复制和退出。开启或关闭模式、轮换令牌、退出设备时，受影响的现有实时连接会立即断开，避免旧凭证继续使用。独立设备密钥保存在 `~/.dsh-remote/device-keys.json`，文件权限会收紧为仅当前用户可读写；可用 `DSH_REMOTE_DEVICE_KEYS` 覆盖保存位置。

`/health` 同时返回 `protocol.version` 和 `capabilities`。新版 App 会根据明确声明的能力选择短时 WebSocket ticket、DSH 生命周期控制等路径；旧网关没有能力声明时仍按兼容路径尝试，不会仅因缺少该字段拒绝连接。

## 🔔 通知、公告与后台轮询

- 通知设置支持审批 / 提问通知、峰谷提醒、后台轮询和任务结束通知；
- 「设置 → 通知 → 历史公告」会保存已获取的公告，方便再次查看；
- 公告默认从项目的中央 HTTPS 公告源读取，网关会短时缓存并在中央源不可达时回退安装包内的 `announcements.json`，格式如下：

```json
{
  "items": [
    {
      "id": "release-0.6.8",
      "title": "0.6.8 正式版",
      "content": "本次更新修复了会话输入和通知显示问题。",
      "minVersion": "0.6.8",
      "publishedAt": "2026-08-22T10:00:00+08:00",
      "expiresAt": "2026-09-30T23:59:59+08:00",
      "actionUrl": "https://github.com/Blank-not-black/dsh-Remote/releases",
      "actionText": "查看版本详情",
      "poll": {
        "id": "next-update-priority-2026-09",
        "question": "下一步你更希望优先改进什么？",
        "options": [
          { "id": "stability", "label": "连接稳定性", "description": "继续优化弱网和重连" },
          { "id": "files", "label": "文件能力", "description": "增加更多预览与管理功能" }
        ]
      }
    }
  ]
}
```

公告按版本、发布时间和有效期筛选，内容按纯文本展示，不执行远端 HTML 或脚本；需要用户确认后才能关闭时可设置 `"force": true`。

投票为单选，每个公告支持 2–8 个选项。网关会根据中央公告缓存（中央源不可达时回退内置文件）校验 `announcementId`、`pollId` 和 `optionId`，不接受客户端伪造的选项名；合法投票会通过现有反馈收集器提交结构化字段，同时用稳定的 `POLL {...}` 文本兼容只保留通用字段的旧收集器。客户端只在服务端确认成功后记录“已投票”；未投票的公告可从历史公告再次打开。系统不收集账号，仍使用网关原有的频率限制和脱敏 IP。

可以直接对收集器的 JSONL 文件生成去标识化计数和百分比，脚本不输出联系方式或 IP：

```bash
node scripts/summarize-polls.mjs /path/to/feedback.jsonl
node scripts/summarize-polls.mjs /path/to/feedback.jsonl --json
```

App/页面启动后约 4 秒检查公告，前台运行时每 30 秒检查一次；重新回到前台或网络恢复时也会立即补查。网关默认从 `https://vm-0-2-ubuntu.tail1f6fc4.ts.net/announcements.json` 读取中央公告，15 秒内复用缓存，中央源失败时优先保留上次成功内容，冷启动失败才回退内置文件。可用 `DSH_REMOTE_ANNOUNCEMENTS_URL` 覆盖中央源，设为空字符串则完全禁用中央源；自定义公网地址必须使用 HTTPS（仅测试时允许 localhost HTTP）。

维护者更新 `public/announcements.json` 后运行 `bash scripts/sync-central-announcements.sh`，即可原子上传并回读验证中央公告。中央源只提供经过大小和 JSON 结构校验的公开数据，公告正文仍按纯文本展示，不执行远端 HTML 或脚本。

Android 后台轮询由前台服务执行，间隔为 30 秒、1 分钟、5 分钟或 15 分钟。灭屏后的 Doze 策略可能拉长实际间隔；部分系统还需要允许应用自启动、后台运行和不受限电量使用。

## 🎨 主题与反馈

当前保留四套配色：默认深空、落日、易北爱乐厅、草原孤塔。主题变量同时作用于页面、图标和状态色，避免切换皮肤后图标融入背景。

App、桌面端和管理页都提供反馈入口。App / 桌面端的「写反馈」会通过网关转发到反馈收集器，也可以直接提交 [GitHub Issues](https://github.com/Blank-not-black/dsh-Remote/issues)。

## 🧪 开发与发布

项目约束：零新增运行时依赖、单文件网关、零构建纯 JavaScript WebUI。修改 WebUI 时只编辑根目录 `public/`，然后同步插件副本。

```bash
npm install
npm run check          # 语法检查 + Node 测试
npm run sync-plugin    # 同步 public/、gateway.cjs 与插件资源
npm run build-app      # 构建 Android APK
npm run publish        # 复制 APK、生成 update.json 并同步插件
npm run build-bin      # 构建 Windows/Linux 单文件网关
```

模块结构、功能边界、实现方式、数据契约和 Vibe Coding 变更规则见[模块文档与开发规范](docs/modules/README.md)。

正式发布使用：

```bash
npm run release 0.6.8
```

发布脚本会更新稳定版本号、本地构建 APK、同步插件、提交并推送 `main`、创建 `v0.6.8` tag。GitHub Actions 随后构建 Windows/Linux 网关和 APK，生成 `SHA256SUMS.txt`，上传 GitHub Release，发布 npm 包并同步独立插件仓库。发布所需的仓库凭据由 GitHub Actions Secrets 管理。

## 🗂️ 项目结构

```text
gateway.js                 # 单文件网关
public/                    # 手机端、桌面端、管理页与公共资源
packages/plugin/           # DSH 插件及同步后的插件资源
android/                   # Capacitor Android 工程
docs/modules/              # 模块说明、跨端契约与 Vibe Coding 规范
tests/                     # 网关、Markdown、统计测试
scripts/                   # 同步、构建、发布脚本
```

## ☕ 支持项目

如果 DSH Remote 对你的工作流有帮助，欢迎给项目点一个 Star，或请作者喝杯咖啡。每一份反馈、Issue、PR 和赞赏，都会帮助这个小工具继续变得更可靠。

<p align="center">
  <img src="public/donate.png" alt="DSH Remote 赞赏码" width="420">
</p>

## License

MIT
