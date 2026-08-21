# DSH Remote

> DSH 的移动远程控制台：在手机或另一台电脑上查看会话、处理审批、传输文件，并掌握主机运行状态。

**中文** · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-remote-plugin)](https://www.npmjs.com/package/dsh-remote-plugin)
[![Release](https://img.shields.io/github/v/release/Blank-not-black/dsh-Remote?label=release)](https://github.com/Blank-not-black/dsh-Remote/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/release-build.yml?branch=main&label=CI)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/release-build.yml)
[![Compat](https://img.shields.io/github/actions/workflow/status/Blank-not-black/dsh-Remote/compat.yml?branch=main&label=compat)](https://github.com/Blank-not-black/dsh-Remote/actions/workflows/compat.yml)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

DSH Remote 由三个相互配合的部分组成：DSH 插件、独立网关和 Android 应用 / WebUI。插件负责在 DSH 侧提供入口并管理网关；网关负责鉴权、转发和文件传输；手机端与桌面端负责不同尺寸下的远程操作体验。

## 适合什么场景

- DSH 在电脑上运行，但你想用手机查看会话、回复提问或处理工具审批。
- 你需要在手机与 DSH 工作目录之间传输文件，或把图片作为当前会话的附件发送。
- 你需要从另一台电脑查看会话、文件、Token 统计和设备连接状态。
- 你希望通过局域网或 Tailscale 访问，而不为 DSH 额外搭建账号系统。

## 当前界面

### 手机端 / Android 应用

手机端进入后默认显示主页，底部导航为：

| 页面 | 主要内容 |
| --- | --- |
| 会话 | 会话列表、工作台项目、运行状态、归档和新建会话 |
| 文件 | 目录浏览、下载、上传、断点续传、暂停/继续/取消 |
| 主页 | DSH 版本、网关状态、链路健康、待处理事项、近期活动 |
| 统计 | Token 四桶、费用、高峰占比和近 7 日用量 |
| 设置 | 服务器、令牌、通知、后台轮询、皮肤、更新和反馈 |

会话详情页支持实时消息、历史加载、目标控制、子代理中断、斜杠命令、模型切换和全屏输入。全屏输入会保留会话标题栏，发送动作上移到标题栏；退出全屏可以点击收起按钮、下滑顶部手柄或使用系统返回键。

图片附件入口支持拍照和相册选择。图片会作为 `session.prompt` 的图片内容发送到当前 DSH 会话；图片能力仍取决于当前 DSH 组合和模型路由是否支持图像输入。

### 桌面端 WebUI

电脑浏览器打开网关地址时会自动进入桌面布局：

- 左侧会话列表与工作台项目；
- 文件传输；
- 主页总览；
- 统计抽屉；
- 设置、服务器分组和主题切换；
- 审批 / 提问通知卡片栈。

### 插件面板与管理控制台

DSH 插件入口提供快速状态面板，可查看网关运行情况、设备数、Token 用量和快捷操作。进入管理控制台后可以查看：

- 网关版本、运行时长、端口和 DSH 上游状态；
- 主机 IP、已连接设备、请求数、通道和最后活跃时间；
- Token 统计与近 7 日峰谷用量；
- 令牌复制、二维码配对和令牌轮换；
- 网关启动 / 停止、自愈设置和更新检查。

## 下载

正式版本发布后，所有资产位于 [GitHub Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest)：

| 平台 | 资产 | 说明 |
| --- | --- | --- |
| Android | `dsh-remote.apk` | 手机远程控制台，支持相机、通知和应用内更新 |
| Windows x64 | `dsh-remote-win-x64.exe` | 单文件网关，不需要额外安装 Node.js |
| Linux x64 | `dsh-remote-linux-x64` | 单文件网关，赋予执行权限后运行 |
| macOS Apple Silicon | `dsh-remote-macos-arm64` | 独立预览产物，未承诺与主版本同步 |

## 快速开始：插件模式（推荐）

在安装 DSH 的电脑上执行：

```sh
dsh plugin --profile web add dsh-remote-plugin
```

然后：

1. 重启 DSH Web，并对浏览器执行一次 Ctrl+F5；
2. 从 DSH 左侧入口打开 DSH Remote 面板；
3. 确认网关已启动，复制令牌或打开二维码；
4. 安装 Android 应用，在「设置 → 服务器」中扫码连接，或手动填写 `http://电脑IP:8787` 和令牌；
5. 电脑端直接打开 `http://电脑IP:8787`，桌面浏览器会进入桌面 WebUI。

也可以安装指定版本或 Git 源：

```sh
# 指定正式版本
dsh plugin --profile web add dsh-remote-plugin@0.6.8

# monorepo 插件目录
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

插件内置网关，默认监听 `0.0.0.0:8787`，并随 DSH 自动启动和自愈。网关意图保存在 `~/.dsh-remote/gateway.enabled`，令牌保存在 `~/.dsh-remote/token`。

## 独立网关模式

不使用 DSH 插件时，可以直接下载对应平台的单文件网关：

```sh
./dsh-remote-linux-x64

# 自定义端口或固定令牌
PORT=9000 TOKEN=your-token ./dsh-remote-linux-x64
```

默认上游为本机 DSH Web `http://127.0.0.1:3080`，默认监听 `0.0.0.0:8787`。管理页地址为 `http://127.0.0.1:8787/admin`。

## 文件传输

手机端和桌面端都可以使用文件页。网关文件端点受到 Bearer token 保护，默认允许根目录为当前用户目录。

- 默认单文件上限为 2GB，可通过 `DSH_REMOTE_FS_MAX_UPLOAD` 调整；
- 上传支持分块、断点续传、暂停、继续和取消；
- 完成上传前进行 SHA-256 校验，校验通过后再原子落位；
- 拒绝 `../` 路径穿越、绝对路径逃逸和指向允许根目录之外的符号链接；
- 可用 `DSH_REMOTE_FS_ROOT` 配置多个允许根目录，Linux/macOS 使用 `:` 分隔，Windows 使用 `;` 分隔。

示例：

```bash
TOKEN=$(cat ~/.dsh-remote/token)
HOST=http://127.0.0.1:8787

curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list"
curl -OJ -H "Authorization: Bearer $TOKEN" "$HOST/fs/file?path=~/Downloads/example.zip"
curl -H "Authorization: Bearer $TOKEN" --data-binary @./photo.jpg \
  "$HOST/fs/upload?path=~/Downloads&name=photo.jpg"
```

## 远程访问与安全

- 局域网访问：手机和电脑在同一网络，访问电脑的局域网 IP；
- Tailscale：两端加入同一网络后，使用电脑的 `100.x.x.x` 地址；
- 公网隧道：只使用带认证、可靠支持 WebSocket 的方案，并限制暴露范围。

网关默认监听所有网卡，令牌等同于 DSH 的远程操作凭证。请不要把令牌提交到仓库、截图公开或写入 URL 后转发给他人。实时连接使用 WebSocket；连续失败后会自动降级为轮询，恢复后再切回实时通道。

## 通知、公告与后台轮询

- 通知设置支持审批 / 提问通知、峰谷提醒、后台轮询和任务结束通知；
- 「设置 → 通知 → 历史公告」会保存已获取的公告，方便再次查看；
- 公告文件与 `update.json` 同目录，格式如下：

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
      "actionText": "查看版本详情"
    }
  ]
}
```

公告按版本、发布时间和有效期筛选，内容按纯文本展示，不执行远端 HTML 或脚本；需要用户确认后才能关闭时可设置 `"force": true`。

Android 后台轮询由前台服务执行，间隔为 30 秒、1 分钟、5 分钟或 15 分钟。灭屏后的 Doze 策略可能拉长实际间隔；部分系统还需要允许应用自启动、后台运行和不受限电量使用。

## 主题与反馈

当前保留四套配色：默认深空、落日、易北爱乐厅、草原孤塔。主题变量同时作用于页面、图标和状态色，避免切换皮肤后图标融入背景。

App、桌面端和管理页都提供反馈入口。App / 桌面端的「写反馈」会通过网关转发到反馈收集器，也可以直接提交 [GitHub Issues](https://github.com/Blank-not-black/dsh-Remote/issues)。

## 开发与发布

项目约束：零新增运行时依赖、单文件网关、零构建纯 JavaScript WebUI。修改 WebUI 时只编辑根目录 `public/`，然后同步插件副本。

```bash
npm install
npm run check          # 语法检查 + Node 测试
npm run sync-plugin    # 同步 public/、gateway.cjs 与插件资源
npm run build-app      # 构建 Android APK
npm run publish        # 复制 APK、生成 update.json 并同步插件
npm run build-bin      # 构建 Windows/Linux 单文件网关
```

正式发布使用：

```bash
npm run release 0.6.8
```

发布脚本会更新稳定版本号、本地构建 APK、同步插件、提交并推送 `main`、创建 `v0.6.8` tag。GitHub Actions 随后构建 Windows/Linux 网关和 APK，生成 `SHA256SUMS.txt`，上传 GitHub Release，发布 npm 包并同步独立插件仓库。发布所需的仓库凭据由 GitHub Actions Secrets 管理。

## 项目结构

```text
gateway.js                 # 单文件网关
public/                    # 手机端、桌面端、管理页与公共资源
packages/plugin/           # DSH 插件及同步后的插件资源
android/                   # Capacitor Android 工程
tests/                     # 网关、Markdown、统计测试
scripts/                   # 同步、构建、发布脚本
```

## License

MIT
