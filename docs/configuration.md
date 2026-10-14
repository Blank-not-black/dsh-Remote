# 配置参考

[文档首页](README.md) · [首次连接](getting-started.md)

以下配置对照 `gateway.js` 和 `packages/plugin/index.mjs`，基线为仓库 `0.7.4`。环境变量需设置在实际启动插件/网关的进程环境中；修改后重启对应进程。

## 监听与上游

| 配置 | 默认/作用 |
| --- | --- |
| 独立网关 `PORT` | `8787` |
| 独立网关 `HOST` | `0.0.0.0`，监听 IPv4 所有网卡 |
| 插件 `DSH_REMOTE_GATEWAY_PORT` | 优先于 `~/.dsh-remote/gateway-port`，最后为 8787 |
| 插件 `DSH_REMOTE_GATEWAY_HOST` | 优先于 `HOST`、`~/.dsh-remote/gateway-host`，最后为 `0.0.0.0` |
| `DSH_UPSTREAM` | 独立网关默认 `http://127.0.0.1:3080`；插件根据当前 DSH 实例传入实际地址 |
| `DSH_HEALTH_PATH` | `/`，上游 HTTP 探测路径 |
| `DSH_REMOTE_ADVERTISE_HOSTS` | 额外公布 IPv4/主机名，逗号或空白分隔；不会改变监听范围或开放防火墙 |
| `DSH_REMOTE_CORS_ORIGINS` | 额外允许的 Origin；默认已有同源与 Capacitor/localhost 规则 |
| `DSH_REMOTE_AUTOSTART` | 插件设为 `0` 时禁用自动管理；用户开关保存在 `gateway.enabled` |

`0.0.0.0` 是监听地址，不能作为手机连接目标。IPv6 监听使用 `HOST=::`（插件优先使用 `DSH_REMOTE_GATEWAY_HOST=::`）；客户端 IPv6 URL 必须用方括号，如 `http://[IPv6地址]:8787`。是否同时接受 IPv4 由系统双栈配置决定。额外公布地址当前只校验 IPv4/主机名，不能把它当作任意 IPv6 地址输入接口。

Linux/macOS 示例：

```sh
PORT=9000 DSH_UPSTREAM=http://127.0.0.1:3080 node gateway.js --supervise
```

PowerShell 示例：

```powershell
$env:PORT = '9000'
$env:DSH_UPSTREAM = 'http://127.0.0.1:3080'
node gateway.js --supervise
```

## 认证与本地状态

| 配置/文件 | 作用 |
| --- | --- |
| `DSH_REMOTE_TOKEN` → `TOKEN` → `TOKEN_FILE` | 令牌来源优先级；默认文件 `~/.dsh-remote/token`，缺失时生成 |
| `DSH_REMOTE_DEVICE_KEYS` | 独立设备密钥，默认 `~/.dsh-remote/device-keys.json` |
| `DSH_REMOTE_DSH_COOKIE_FILE` | 上游 Cookie，默认 `~/.dsh-remote/dsh-upstream.cookie` |
| `DSH_REMOTE_NOTES` | 设备备注，默认 `~/.dsh-remote/device-notes.json` |
| `DSH_REMOTE_WORKBENCH` | 工作台绑定，默认 `~/.dsh-remote/workbench.json` |
| `DSH_REMOTE_HANDOFF` | 跨端接续指针，默认 `~/.dsh-remote/handoff.json` |

`~` 代表运行进程的用户目录；不同账户或 profile 不保证共享状态。主令牌用于管理；独立设备密钥模式下，设备使用自己的令牌。轮换、撤销或改变模式会断开受影响的实时连接。文件 `0600`/目录 `0700` 是 POSIX 权限意图，Windows 仍需关注账户与 ACL。

插件内嵌管理页处于 DSH 登录边界内，不用 Remote Bearer 覆盖浏览器 Basic Auth；独立 `/admin/api/*` 使用主令牌。设备令牌只允许指定控制接口，不能读取管理页中的主令牌与其他设备密钥。

## 文件访问

| 配置 | 默认/作用 |
| --- | --- |
| `DSH_REMOTE_FS_ROOT` | 显式允许根；POSIX 用 `:`，Windows 用 `;` 分隔 |
| `DSH_REMOTE_FS_MAX_UPLOAD` | `2147483648` 字节，2 GiB 单文件上限 |
| `DSH_REMOTE_FS_WORKSPACE_CACHE_MS` | 已登记 DSH 工作区缓存，默认 15000ms |
| `DSH_REMOTE_FS_UPLOAD_TTL_MS` | 未完成上传状态默认保留 24 小时 |

Windows 默认允许当前用户目录与启动时可用的非 C 盘盘符。默认模式不因 DSH 工作区登记扩大到 C 盘系统/其他用户目录，也拒绝盘符内 junction 逃逸。新挂载磁盘后需重启网关；UNC 共享需显式授权。

Linux/macOS 默认允许当前用户目录，并向本机 DSH 验证已登记工作区。显式根模式仍兼容经过 DSH 校验的工作区，因此 `DSH_REMOTE_FS_ROOT` 不能描述为限制 DSH 全部工具的沙箱。所有模式均受进程账户权限约束，并对真实路径做根边界检查。

## 实时连接与弱网

| 配置 | 默认 |
| --- | --- |
| `GATEWAY_WS_PING_MS` | 30000ms，RFC6455 Ping；0 关闭 |
| `GATEWAY_WS_PONG_TIMEOUT_MS` | 90000ms |
| `GATEWAY_WS_IDLE_MS` | 180000ms，仅关闭 Ping 后使用；0 关闭硬空闲限制 |
| `GATEWAY_WS_UPGRADE_TIMEOUT_MS` | 15000ms |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | 30000ms |
| `GATEWAY_HTTP_COMPRESSION` | 设为 `0` 关闭响应 gzip |

WebUI「设置 → 通用」可选自动、弱网或正常网络模式。弱网降低历史每页数量至 20（正常为 60），延长只读超时；不自动重试发送等写操作。HTTP 支持按需 gzip 与静态资源 ETag，Range 文件下载保持原有语义。

mux/host 独立长轮询请求最长等待 25 秒；成功后继续获取增量，失败退避。前端每 4 秒检查轮询任务，每 30 秒尝试恢复 WS，不能把它描述成每 4 秒全量刷新。

## DSH 生命周期与恢复

| 配置 | 默认/作用 |
| --- | --- |
| `DSH_REMOTE_DSH_CONTROL_MODE` | `auto`；另可选 `systemd/windows/process/disabled` |
| `DSH_REMOTE_DSH_SERVICE` | `dsh-web`，需实际服务存在 |
| `DSH_REMOTE_SYSTEMCTL` / `DSH_REMOTE_WINDOWS_SC` | 默认 `systemctl` / `sc.exe` |
| `DSH_REMOTE_DSH_LAUNCH_FILE` | 默认 `~/.dsh-remote/dsh-launch.json`，只接受主机上的可信启动配置 |
| `DSH_REMOTE_AUTO_RESTART` | 设为 `0` 禁用异常恢复 |
| `DSH_REMOTE_CRASH_LOG_FILE` | 默认 `~/.dsh-remote/crashes.jsonl` |

`auto` 根据服务与启动证据选择后端。Windows 服务不存在时才尝试受控进程路径；权限错误不自动启动另一实例。Desktop 控制是实验能力，核验 PID 出生时间、路径、Host 祖先与监听归属；正常关闭不等于崩溃。Docker/面板外部管理 DSH 时使用 `disabled`。

进程监督异常重试为 1/2/4/8/16 秒，每 5 分钟最多 5 次；正常停止和端口冲突不自动重启。电脑或监督进程停止后无法保证恢复。不会自动注册 Windows 服务或登录自启。

## 公告、更新与反馈

| 配置 | 默认/作用 |
| --- | --- |
| `DSH_REMOTE_ANNOUNCEMENTS_URL` | 源码内中央 HTTPS 源；空字符串禁用中央源 |
| `DSH_REMOTE_ANNOUNCEMENTS_FILE` | 默认 `public/announcements.json`，源不可达时回退 |
| `DSH_REMOTE_ANNOUNCEMENTS_CACHE_MS` | 15000ms，保留最后成功结果 |
| `DSH_REMOTE_FEEDBACK_URL` | 源码内反馈收集端点 |
| `UPDATE_CHECK_URL` | 默认 GitHub Latest Release API |
| `UPDATE_INTERVAL_MS` | 默认 6 小时 |

诊断及崩溃摘要上传默认关闭，由用户明确选择；本地崩溃日志不会完整自动上传。公告投票与普通反馈的回退行为不同，见[使用指南](usage.md)。不要在文档或反馈中放入凭证、Cookie、对话正文或个人启动路径。
