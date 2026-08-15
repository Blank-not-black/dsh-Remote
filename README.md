# DSH Remote

手机远程查看 / 操控 DSH 的移动控制台。一个零依赖网关把 DSH 本机的
`127.0.0.1:3080` 代理成带 Token 认证的局域网服务，手机浏览器或 Android App 访问。

## 下载（GitHub Releases）

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `dsh-remote-win-x64.exe` | 单文件，无需装 Node |
| Linux x64 | `dsh-remote-linux-x64` | 单文件，无需装 Node |
| Android | `dsh-remote.apk` | 手机 App（内置控制台 + 自动更新） |

## 快速开始

### Windows

1. 下载 `dsh-remote-win-x64.exe`，双击运行（或在 cmd 里运行）。
2. 首次会弹出防火墙提示，**允许访问**；若没有弹窗，用管理员 cmd 执行：
   ```bat
   netsh advfirewall firewall add rule name="DSH Remote" dir=in action=allow protocol=TCP localport=8787
   ```
3. 窗口会打印一行 `手机(同一网络): http://电脑IP:8787/?token=xxxx`，用手机浏览器打开即可；或下载 APK 安装后在「设置」里填同样的地址和 token。

### Linux

```bash
chmod +x dsh-remote-linux-x64
./dsh-remote-linux-x64          # 监听 0.0.0.0:8787
```

- 改了默认端口 `PORT=9000 ./dsh-remote-linux-x64`
- 只允许本机 `HOST=127.0.0.1 ./dsh-remote-linux-x64`
- 指定上游 `DSH_UPSTREAM=http://127.0.0.1:3080 ./dsh-remote-linux-x64`
- 固定令牌 `TOKEN=xxx ./dsh-remote-linux-x64`（不设置则生成到 `~/.dsh-remote/token`）
- firewalld 放行：`sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload`

### 手机

- **浏览器**：直接打开启动时打印的 `http://电脑IP:8787/?token=xxx`。
- **App**：安装 `dsh-remote.apk` →「设置」填服务器地址 `http://电脑IP:8787` 和令牌 → 回会话页即可。
  - App 支持**检查更新**：设置页点「检查更新」，发现新版一键下载并安装。

### 管理页（电脑端）

浏览器打开 `http://127.0.0.1:8787/admin`，输入网关令牌进入：

- 网关版本、运行时长、DSH 上游可达状态、**主机 IP（手机连接地址）**、监听地址
- **已连接设备监控**：每台设备的类型（手机 App / 浏览器 / 管理页）、IP、在线状态、请求数、WebSocket 通道、最后活跃时间，支持**自定义设备备注**与一键断开
- **更新检查**：启动后自动查 GitHub Release 最新版（每 6 小时一次），发现新版显示「vX 可用 + 去下载」；电脑开代理时可 `UPDATE_PROXY=http://127.0.0.1:7890` 启动，或 `UPDATE_CHECK_URL` 指向国内镜像
- 右上角 GitHub logo 按钮直达仓库；每 5 秒自动刷新

## 功能

| 页面 | 内容 |
| --- | --- |
| 会话 | 会话列表、运行状态/目标徽章、统计、新建会话 |
| 详情 | 实时对话流（打开即最新消息，上滑自动加载更早）、右侧导航条（用户发言节点 + 拖动定位）、顶栏 📊 统计弹窗、目标控制（暂停/继续/完成/编辑/清除）、子代理中断、发消息、停止任务 |
| 待办 | 工具审批（允许/拒绝）、用户提问（选择/自定义回答）、后台任务 |
| 设置 | 服务器地址、令牌、原生通知开关、工具调用显示开关、DSH 状态探测、检查更新 |

- 工具调用折叠显示工具名（bash / edit 等），可在设置里整体隐藏
- 历史流过滤 `assistant/chunk` 等内部高频事件；思考过程自动换行适配手机
- App 内已适配刘海/状态栏/手势条安全区

## 远程访问（跨网络）

局域网不可达（宿舍 CPE 等）时用 **Tailscale**：电脑与手机登录同一账号，
手机 App「设置 → 服务器地址」填 `http://电脑的Tailscale IP:8787` 即可，链路加密。

## 从源码运行

需要 Node.js ≥ 18：

```bash
git clone https://github.com/Blank-not-black/dsh-Remote.git
cd dsh-Remote
npm install
npm start        # 默认 0.0.0.0:8787
```

## 开发

```bash
npm run build-app   # 构建 Android APK(需 Android SDK)
npm run build-bin   # 打包 Windows/Linux 单文件(需网络拉取 pkg 基座)
npm run publish     # 复制 APK + 生成 update.json, App 端即可推送更新
```

发版流程：改 `package.json` 的 `version` / `updateNotes` → 构建 → `npm run publish` → 上传 Release 资产。

## 架构

```
手机浏览器 / Android App(内置 public/)
   │  http://电脑IP:8787  + Bearer token
   ▼
gateway.js (单文件或源码, 零运行时依赖)
   │ 静态资源 + 鉴权 + 转发 /api/*
   ▼
DSH web (127.0.0.1:3080, 不改 DSH 任何配置)
```

- 全部走 DSH 官方 `/api` RPC 协议（`session.*` / `subagent.*` / `goal.*` 等）。
- 审批/提问经 `/api/respond` 回传，事件流走 WebSocket，断线自动重连。
- 网关不落业务数据；token 只存手机本地。**谁拿到 token 谁就能操控 DSH，请保管好。**

## License

MIT
