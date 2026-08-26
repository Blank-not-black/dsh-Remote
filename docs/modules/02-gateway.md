# 独立网关模块

> 状态：现行核心模块
>
> 源码：`gateway.js`、`gateway-stats.cjs`
>
> 同步产物：`packages/plugin/gateway.cjs`、`packages/plugin/gateway-stats.cjs`

## 1. 模块定位

网关是 DSH Remote 的本地安全边界和连接中枢。它让手机或另一台电脑不必直接暴露 DSH Web，统一承接鉴权、HTTP/WS 代理、文件传输、状态诊断和统计。

## 2. 代码结构

| 文件/区域 | 作用 |
| --- | --- |
| `gateway.js` 顶部配置 | 端口、上游、token、CORS、WS 超时、文件根和公告源 |
| token/device 区域 | 共享 token、独立设备密钥、设备识别和踢下线 |
| DSH control 区域 | 服务状态、启动/重启异步操作和证据 |
| event collector 区域 | mux/host 上游 WS、内存事件缓冲、广播和轮询 |
| static/API/admin 区域 | 静态资源、DSH RPC、管理、健康、反馈和公告 |
| `/fs` 区域 | 列表、预览、Range 下载、分块续传、校验和取消 |
| WS upgrade 区域 | WS ticket、collector 客户端和普通 WS 透传 |
| `gateway-stats.cjs` | usage 事件聚合、北京时间峰谷、日文件和幂等游标 |

运行方式：`node gateway.js`；默认监听 `0.0.0.0:8787`，上游默认为 `http://127.0.0.1:3080`。

## 3. 当前功能

- Bearer token 与可选独立设备密钥鉴权。
- 静态托管手机端、桌面端、管理页和插件页。
- `/api/*` HTTP 代理到 DSH；`/api/*` WebSocket 透传到 DSH。
- mux/host 各维护一条上游事件采集连接，内存缓存并广播给多个客户端。
- WS 失败时提供 `/api/events.poll` 增量轮询，支持恢复后重回 WS。
- 文件列表、文本预览、Range 下载、分块上传、SHA-256 校验和工作区根目录访问。
- 网关/DSH 状态、设备、请求数、更新、公告、反馈、工作台和 DSH 生命周期控制。
- Token 统计实时接收与历史 session JSONL 回填。

## 4. 具体实现方式

### 鉴权与设备

`loadToken()` 从 `TOKEN`、`TOKEN_FILE` 或默认目录读取/生成 token；`authorized()`、`adminAuthorized()` 和 `controlAuthorized()` 按接口权限区分普通、管理和控制操作。WS 优先使用短时 ticket，ticket 只消费一次并设过期时间。

所有请求会记录设备类型、client ID、IP、最后活跃时间和通道；设备密钥状态持久化到 `device-keys.json`，轮换/退出会主动断开受影响连接。

### 实时事件

`startEventCollector('mux'|'host')` 在网关启动时连接 DSH。连接阶段的 `error`、`close`、超时和构造异常通过幂等收口统一安排退避重连，避免旧连接事件影响新连接。

`pushEvent()` 写入带 `seq` 的环形缓冲，同时更新重放基线、广播 WS 客户端并唤醒长轮询。`/health` 将 HTTP 上游探测与 `events.mux/host` 分开表达：网关活着不等于实时就绪。

### WS 活性

网关两侧发送 RFC6455 Ping 并等待 Pong，默认 Ping 30 秒、Pong 等待 90 秒；仅在控制帧无响应时销毁连接。关闭 Ping 时才使用可选的业务空闲超时，不能把“长时间没有业务消息”误判为死连接。

### 文件安全

`fsResolve()` 先做词法根目录检查，再对已存在路径做 realpath 检查；拒绝 `..`、绝对路径逃逸和符号链接逃逸。上传先写临时 part，完成后校验 SHA-256，再原子落位。

### 统计

`StatsStore` 以天为文件保存小时/模型/四桶 token，使用每个 session 的最大 seq 做幂等处理；北京时间 9-12、14-18 为工作日峰时，周末全天谷时。未知模型照记 token，费用为零。

## 5. 制作目的

- 把 DSH Web 的本地服务转换成可控的远程访问面。
- 集中处理安全和兼容，避免三个客户端各自实现 token、WS 和文件安全。
- 在 VPN、重启和上游短时不可达时提供可观察、可恢复的链路。
- 让插件模式和独立网关模式共享相同的客户端协议。

## 6. 关键环境变量

`PORT`、`HOST`、`TOKEN`、`TOKEN_FILE`、`DSH_UPSTREAM`、`DSH_HEALTH_PATH`、`DSH_REMOTE_FS_ROOT`、`DSH_REMOTE_FS_MAX_UPLOAD`、`DSH_REMOTE_DEVICE_KEYS`、`GATEWAY_WS_PING_MS`、`GATEWAY_WS_PONG_TIMEOUT_MS`、`GATEWAY_WS_UPGRADE_TIMEOUT_MS`、`DSH_REMOTE_ANNOUNCEMENTS_URL`、`DSH_REMOTE_FEEDBACK_URL`。

## 7. 边界与禁止事项

- 必须保持零运行时依赖和单文件网关形态。
- 改 `gateway.js` 后必须 `npm run sync-plugin`，不能只改 `gateway.cjs`。
- 不因 `upstreamOk=false` 就自动重启网关；应显示 degraded 并等待上游恢复。
- 不让文件传输绕过 token、根目录或 realpath 检查。
- 不把 `/health.ok` 当成 mux/host 已连接的唯一证据。

## 8. 测试与验收

- `tests/gateway.test.js`：网关 HTTP、文件、公告、事件轮询、WS 活性和恢复。
- `tests/device-keys.test.js`：设备密钥持久化与生命周期。
- `tests/stats.test.js`：统计聚合、价格和幂等游标。
- `tests/lifecycle.test.js`：DSH 多次重启、网关重启、客户端恢复和文件可用性。
- 使用隔离 HOME、固定 token 和临时文件根；不碰真实 `~/.dsh-remote`。

## 9. 修改前检查清单

- 新端点是否鉴权、校验参数、处理 OPTIONS/CORS 和错误状态？
- 是否要同时更新 health capabilities、客户端回退和测试？
- WS 变化是否覆盖静默、断线、重连和上游恢复？
- 文件相关变化是否覆盖路径穿越、符号链接和上传中断？
- 修改后是否同步 `gateway.cjs` 并检查 `cmp`？

## 10. 未决事项

- 统计价格表当前为 v1 固定代码，未来可配置化，但需单独设计迁移和费用口径。
