# DSH Remote (0.6.9-mod)

> **把电脑上的 DSH，带到你的掌心。**

DSH Remote 是一套面向 DSH 的远程控制台：在手机或另一台电脑上查看会话、处理审批与提问、传输文件，并掌握主机运行状态。

**中文** · [English](README.en.md)

- **原项目（上游）**：[Blank-not-black/dsh-Remote](https://github.com/Blank-not-black/dsh-Remote)
- **本仓库（mod 分支）**：[produce123/dsh-Remote-mod](https://github.com/produce123/dsh-Remote-mod)

本仓库 `mod-069` 分支基于上游 v0.6.9（重大重构版）继续开发。除下方 7 项改动外，其余功能与上游保持一致，完整说明请参考原项目 README。

DSH Remote 由三个相互配合的部分组成：DSH 插件、独立网关和 Android 应用 / WebUI。插件负责在 DSH 侧提供入口并管理网关；网关负责鉴权、实时连接和文件传输；手机端与桌面端则把不同场景下的远程操作做得更清晰、更顺手。

## ✨ 本分支基于 v0.6.9 新增 / 修改

| # | 改动 | 说明 |
| --- | --- | --- |
| 1 | **管理界面统一** | 插件侧不再独立渲染管理页；`/remote/admin`、`/remote/admin/`、`/remote/admin.html`、`/remote/admin/index.html` 统一跳转到独立网关管理页（自动携带令牌），网关侧 `/admin`、`/admin/`、`/admin/index.html` 也统一指向同一管理界面，管理入口单一化 |
| 2 | **桌面归档折叠修复** | 桌面端会话列表的「归档折叠」与打开会话改为一次性事件委托绑定，不再随每次渲染重复绑定，修复归档区展开 / 折叠失效的问题 |
| 3 | **设备列表修复** | 网关设备列表按真实设备（IP）聚合：同一设备的 WebSocket 通道记录与轮询 / 文件请求记录合并为一行，多通道（mux/host）合并计数；管理页自身的访问记录不再计入「已连接设备」；设备数与在线数与列表同源，消除「2 台设备显示 6 条」的虚增 |
| 4 | **手机端语音输入（含长按框选修复）** | 新增语音输入：Android 系统 SpeechRecognizer 经 SpeechBridge 桥接，浏览器 webkit 识别兜底；输入框「按住说话」与键盘语音按钮两种入口，按住上滑取消，波形浮层实时反馈；按住说话期间全局禁用文本选中与长按菜单，修复手机系统长按框选文本打断语音手势的冲突；全屏输入同样支持语音 |
| 5 | **输入框豆包风格贴底** | 会话页隐藏底部导航后，输入框直接贴屏幕底部（安全区由输入框内边距处理），豆包风格贴底布局 |
| 6 | **设置 → 通用 → 语音输入扩展** | 设置新增「语音输入」页：转写模式（原文 / 润色为 prompt）、OpenAI 兼容 API（Base / Model / Key）配置、连接测试、功能测试页（按住说话实测）、离线识别包（SenseVoice-Small）下载与管理 |
| 7 | **桌面链路检测修复** | 桌面端链路状态改为实测网关 `/health`（网关在线 + DSH 上游可达），不再依赖「是否配置服务器 / 令牌」的间接判断；网关在线但上游探测失败时用 `host.describe` 复核，避免健康探测路径配置不当造成误报；直接打开 `:8787`（未配置服务器）不再误报「网关离线」；结果 20 秒过期自动重测，检测中显示「检测中」态 |

## 🚀 快速开始

### 独立网关模式（无需插件）

```sh
node gateway.js                            # 默认监听 0.0.0.0:8787，上游 127.0.0.1:3080
PORT=9000 TOKEN=your-token node gateway.js # 自定义端口或固定令牌
```

启动后：

- 手机 / 电脑浏览器打开 `http://电脑IP:8787` → 手机端 / 桌面端 WebUI；
- 管理页：`http://电脑IP:8787/admin`；
- 文件端点受 Bearer token 保护，拒绝路径穿越；上传支持分块、断点续传与 SHA-256 校验。

也可下载平台单文件网关（Windows / Linux 二进制，无需安装 Node.js）。

### 插件模式（DSH 内嵌入口）

```sh
dsh plugin --profile web add dsh-remote-plugin   # 或安装本仓库 packages/plugin
```

插件在 DSH 侧提供入口并自动管理网关（自启停、自愈），网关端口与令牌可通过管理页调整。

> 🔐 令牌就是远程控制凭证。默认不引入额外账号系统，部署简单，但请像保护 SSH 密钥一样保护它。

## 🧪 构建与测试

```bash
npm install
npm run check          # 语法检查 + Node 测试（node --check + node --test）
npm run build-app      # 构建 Android APK
npm run sync-plugin    # 同步 public/ 与 gateway.cjs 到插件包
```

项目约束：零新增运行时依赖、单文件网关（gateway.js / gateway.cjs）、零构建纯 JavaScript WebUI。修改 WebUI 只编辑根目录 `public/`，之后同步插件副本。

## 🗂️ 项目结构

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
