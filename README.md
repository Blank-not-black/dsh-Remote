# DSH Remote

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

DSH 移动远程控制台。**插件 + 内置网关 + 手机 App 是一个整体**：装插件时网关随插件分发、随 DSH 自动启停，抽屉里直接拿到令牌和主机地址，手机 App 填上即可远程操控 DSH。

| 组件 | 作用 | 安装来源 |
| --- | --- | --- |
| DSH 插件（`packages/plugin`） | DSH 原生侧边栏入口 + 右侧抽屉管理页；**内置网关程序并自动启停** | 一条 `dsh plugin` 命令 |
| 网关（`gateway.js` / 单文件二进制） | 8787 端口的带 Token 代理 + 设备监控 + 更新检查 + **文件传输 `/fs/*`**；插件会自动拉起它 | 随插件内置；也可单独下载 |
| Android App（`dsh-remote.apk`） | 手机远程会话/审批/提问/goal/文件互传，支持 App 内检查更新 | GitHub Releases |

## 推荐安装：插件（自带网关）

插件有三种等价获取方式：

```sh
# 1) npm 包(推荐, 可被 Oh-My-DSH / DSH 插件搜索收录)
dsh plugin --profile web add dsh-remote-plugin

# 2) monorepo git 源
dsh plugin --profile web add "github:Blank-not-black/dsh-Remote#main&path:/packages/plugin"

# 3) 插件专用 root 仓库(Oh-My-DSH 目录收录的独立包形态)
dsh plugin --profile web add "github:Blank-not-black/dsh-remote-plugin#main"
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
3. App「设置」里添加服务器地址（可加多个，如局域网 `http://192.168.x.x:8787` + Tailscale `http://100.x.x.x:8787`），点「测速」自动选当前最快的；再填令牌即可。
4. 手机浏览器也可以直接打开 `http://电脑IP:8787/?token=xxx`。

- **防火墙**：手机连不上时放行 8787——Linux `sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload`；Windows 首次运行弹窗点允许，否则 `netsh advfirewall firewall add rule name="DSH Remote" dir=in action=allow protocol=TCP localport=8787`。
- **App 内更新**：设置 → 检查更新，发现新版一键下载安装。

## 文件传输（局域网 / Tailscale 直传，不经 Telegram）

网关提供 `/fs/*` 文件端点，手机 App 和浏览器控制台都有「文件」页。大小文件都走直连：上传上限默认 **2GB**（可调），下载支持 **Range 断点续传**。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/fs/list?path=xxx` | GET | 列目录；`path` 缺省为 `~`，返回 `{path, entries:[{name,type,size,mtimeMs}]}` |
| `/fs/file?path=xxx` | GET | 流式下载；支持 `Range: bytes=a-b`；`Content-Disposition` 已做 UTF-8 文件名编码 |
| `/fs/upload?path=目录&name=文件名` | POST | raw body 或 `multipart/form-data`；同名返回 409，加 `overwrite=1` 覆盖 |

- **鉴权**：所有 `/fs/*` 必须带 token——`Authorization: Bearer <token>`（首选）或 `?token=<token>`；无 token 一律 401。
- **安全**：所有路径 resolve 后必须位于允许根内（默认 `~`），`../` 穿越与指向根外的符号链接会被拒绝；`DSH_REMOTE_FS_ROOT=/home/you:/mnt/data` 可开多个根（`:` 分隔）。
- **上限**：`DSH_REMOTE_FS_MAX_UPLOAD`（字节，默认 `2147483648` = 2GB）。

```bash
TOKEN=$(cat ~/.dsh-remote/token); HOST=http://127.0.0.1:8787
curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list"                          # 列 ~
curl -H "Authorization: Bearer $TOKEN" "$HOST/fs/list?path=~/下载"               # 列下载目录
curl -OJ -H "Authorization: Bearer $TOKEN" "$HOST/fs/file?path=~/下载/大文件.iso" # 下载(带断点: 追加 -r 0-1048575)
curl -H "Authorization: Bearer $TOKEN" --data-binary @./手机照片.jpg \
     "$HOST/fs/upload?path=~/下载&name=手机照片.jpg"                              # 上传; 同名报 409 时追加 &overwrite=1
```

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
| 文件 | 列目录/进入目录/返回上级、下拉刷新、下载到系统「下载/dsh-remote」子目录（DownloadManager）、选文件上传带进度 |
| 待办 | 工具审批（允许/拒绝）、用户提问（选择/自定义回答）、后台任务 |
| 设置 | 多服务器地址（测速自动选最快，局域网/Tailscale 自动切换）、令牌、通知开关、工具调用显示、DSH 状态探测、检查更新 |

> 聊天记录会随会话缓存在手机本地：网关断线时，会话列表和看过的历史仍可离线浏览。

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
npm run sync-plugin       # 同步 public/ 到插件包 + 复制 gateway.cjs + 生成插件版 update.json
npm run sync-standalone   # 生成/推送 dsh-remote-plugin 独立 root 仓库(Oh-My-DSH 收录用)
npm run build-app         # 构建 Android APK(需 Android SDK)
npm run build-bin         # 打包 Windows/Linux 单文件
npm run publish           # 复制 APK + 生成 update.json + 同步插件包
```

发版流程：改 `package.json` 的 `version` / `updateNotes` → 构建 → `npm run publish` → 提交并上传 Release 资产 → `npm run sync-standalone`（同步独立仓库）→ 发布 npm（`cd packages/plugin && npm publish --access public`）。

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
