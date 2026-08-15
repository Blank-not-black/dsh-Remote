# DSH Remote

DSH 移动远程控制台。**插件 + 内置网关 + 手机 App 是一个整体**：装插件时网关随插件分发、随 DSH 自动启停，抽屉里直接拿到令牌和主机地址，手机 App 填上即可远程操控 DSH。

| 组件 | 作用 | 安装来源 |
| --- | --- | --- |
| DSH 插件（`packages/plugin`） | DSH 原生侧边栏入口 + 右侧抽屉管理页；**内置网关程序并自动启停** | 一条 `dsh plugin` 命令 |
| 网关（`gateway.js` / 单文件二进制） | 8787 端口的带 Token 代理 + 设备监控 + 更新检查；插件会自动拉起它 | 随插件内置；也可单独下载 |
| Android App（`dsh-remote.apk`） | 手机远程会话/审批/提问/goal，支持 App 内检查更新 | GitHub Releases |

## 推荐安装：插件（自带网关）

```sh
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"
```

1. 重启 DSH Web，浏览器 **Ctrl+F5**。
2. 左侧边栏底部出现 App 图标的「DSH Remote」入口，点击从右侧滑出管理抽屉（460px）。
3. 插件在 DSH 启动时会**自动拉起内置网关**（独立 `dsh-remote-gateway.service`，监听 `0.0.0.0:8787`），抽屉直接进入网关模式：显示完整令牌、主机 IP、设备监控，**无需手动下载或输入令牌**。
4. 令牌保存在 `~/.dsh-remote/token`（首次自动生成，之后一直复用，不会覆盖）。

### 网关开关与自愈

- 抽屉顶部「停止网关 / 启动网关」按钮控制网关，意图持久化在 `~/.dsh-remote/gateway.enabled`。
- **默认 `on`**：DSH 重启或网关意外退出后，插件会在几秒内自动拉起（抽屉每次刷新状态都会检查）。
- 点「停止网关」写入 `off`，此后不会自动拉起，直到你点「启动网关」。
- 想整体禁用自动管理：以 `DSH_REMOTE_AUTOSTART=0` 启动 DSH Web。

## 手机 App

1. 从 [Releases](https://github.com/Blank-not-black/dsh-Remote/releases/latest) 下载 `dsh-remote.apk` 并安装。
2. 打开插件抽屉，复制「令牌」和「主机 IP」。
3. App「设置」里填服务器地址 `http://电脑IP:8787` 和令牌，回会话页即可。
4. 手机浏览器也可以直接打开 `http://电脑IP:8787/?token=xxx`。

- **防火墙**：手机连不上时放行 8787——Linux `sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload`；Windows 首次运行弹窗点允许，否则 `netsh advfirewall firewall add rule name="DSH Remote" dir=in action=allow protocol=TCP localport=8787`。
- **App 内更新**：设置 → 检查更新，发现新版一键下载安装。

## 独立网关（无 DSH 插件 / Windows 主机）

不需要装插件、或主机没有 systemd 时，单独运行网关：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `dsh-remote-win-x64.exe`（双击运行，单文件免 Node） |
| Linux x64 | `dsh-remote-linux-x64`（`chmod +x` 后运行） |

```bash
./dsh-remote-linux-x64            # 默认 0.0.0.0:8787
PORT=9000 ./dsh-remote-linux-x64  # 换端口
TOKEN=xxx ./dsh-remote-linux-x64  # 固定令牌(不设置则生成到 ~/.dsh-remote/token)
```

管理页在 `http://127.0.0.1:8787/admin`（独立网关模式需要输令牌进入）：主机 IP、上游可达、设备监控、备注/断开设备、GitHub 更新检查。

## 管理抽屉能看什么

- 网关版本 / 运行时长 / 主机 IP / DSH 上游状态 / 请求统计
- **已连接设备**：类型（手机 App / 浏览器 / 管理页）、IP、在线、请求数、通道、最后活跃，支持备注与断开
- 令牌展示 + 一键复制；GitHub 更新检查（6 小时一次）

## 手机上能做什么

| 页面 | 功能 |
| --- | --- |
| 会话 | 会话列表、运行状态/目标徽章、统计、新建会话 |
| 详情 | 实时对话、上滑加载历史、目标控制（暂停/继续/完成/编辑/清除）、子代理中断、发消息、停止任务 |
| 待办 | 工具审批（允许/拒绝）、用户提问（选择/自定义回答）、后台任务 |
| 设置 | 服务器地址、令牌、通知开关、工具调用显示、DSH 状态探测、检查更新 |

## 远程访问（跨网络）

局域网不可达时用 **Tailscale**：电脑与手机登录同一账号，App「设置 → 服务器地址」填 `http://电脑的Tailscale IP:8787` 即可，链路加密。

## 从源码运行

需要 Node.js ≥ 18：

```bash
git clone https://github.com/Blank-not-black/dsh-Remote.git
cd dsh-Remote
npm install
npm start        # 网关, 默认 0.0.0.0:8787
```

## 开发与发版

```bash
npm run sync-plugin  # 同步 public/ 到插件包 + 复制 gateway.cjs + 生成插件版 update.json
npm run build-app    # 构建 Android APK(需 Android SDK)
npm run build-bin    # 打包 Windows/Linux 单文件
npm run publish      # 复制 APK + 生成 update.json + 同步插件包
```

发版流程：改 `package.json` 的 `version` / `updateNotes` → 构建 → `npm run publish` → 提交并上传 Release 资产。

## 架构

**整体模式（推荐）**

```
DSH web (3080)
   ├─ dsh-remote 插件 /remote ──► 主机浏览器: 侧边栏入口 + 抽屉管理页
   └─ 自动启停 ──► dsh-remote-gateway.service (0.0.0.0:8787, Bearer token)
                       ▲
       手机 App / 手机浏览器(局域网或 Tailscale)
       静态资源 + 鉴权 + 转发 /api/* + 设备监控
                       │
                       ▼
                  DSH web (127.0.0.1:3080)
```

**独立网关模式**（无插件时，同样的 `gateway.js` 单文件）

```
手机浏览器 / Android App ── http://电脑IP:8787 + token ──► gateway.js ──► DSH web (127.0.0.1:3080)
```

- 全部走 DSH 官方 `/api` RPC（`session.*` / `subagent.*` / `goal.*`），事件流走 WebSocket，断线自动重连。
- 网关不落业务数据；token 只存本机与手机本地。**谁拿到 token 谁就能操控 DSH，请保管好。**

## License

MIT
