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
- 透明转发模型配置所需的 DSH RPC；包括模型级思考档位元数据和 `session.selectModel.reasoningEffort`，网关不解析、不持久化 API key。
- mux/host 各维护一条上游事件采集连接，内存缓存并广播给多个客户端。
- WS 失败时提供 `/api/events.poll` 增量轮询，支持恢复后重回 WS。
- 文件列表、文本预览、Range 下载、分块上传、SHA-256 校验和工作区根目录访问。
- 网关/DSH 状态、设备、请求数、更新、公告、反馈、工作台和 DSH 生命周期控制。
- 点号/slash RPC 兼容协商、协议切换后的 collector 重建，以及仅用户同意时上传的脱敏兼容性诊断。
- Token 统计实时接收与历史 session JSONL 回填。

## 4. 具体实现方式

### 鉴权与设备

`loadToken()` 从 `TOKEN`、`TOKEN_FILE` 或默认目录读取/生成 token；`authorized()`、`adminAuthorized()` 和 `controlAuthorized()` 按接口权限区分普通、管理和控制操作。WS 优先使用短时 ticket，ticket 只消费一次并设过期时间。

所有请求会记录设备类型、client ID、IP、最后活跃时间和通道；设备密钥状态持久化到 `device-keys.json`，轮换/退出会主动断开受影响连接。

### 实时事件

`startEventCollector('mux'|'host')` 在网关启动时连接 DSH。连接阶段的 `error`、`close`、超时和构造异常通过幂等收口统一安排退避重连，避免旧连接事件影响新连接。

### DSH 生命周期控制

Linux/macOS 仅在检测到 systemd（或显式指定 `DSH_REMOTE_DSH_CONTROL_MODE=systemd`）时使用 `systemctl --user` 控制 `DSH_REMOTE_DSH_SERVICE`（默认 `dsh-web`）；Windows 使用 `sc.exe queryex` 读取服务状态与 PID，启动使用 `sc.exe start`，重启使用 stop 等待服务停止后再 start。自动模式检测到 Docker/Podman/Kubernetes/LXC 时会把能力声明降为 0；面板或其他外部编排场景也可显式设置 `DSH_REMOTE_DSH_CONTROL_MODE=disabled`，避免前端展示无法执行的按钮。Windows 机器必须先把 DSH 注册为 Windows Service，并确保运行网关的用户拥有查询、启动和停止该服务的权限；可用 `DSH_REMOTE_WINDOWS_SC` 指定 `sc.exe` 的路径。服务恢复后仍需通过 DSH HTTP 和 mux/host 通道检查，不能把服务进程启动视为远程控制成功。

`pushEvent()` 写入带 `seq` 的环形缓冲，同时更新重放基线、广播 WS 客户端并唤醒长轮询。`/health` 将 HTTP 上游探测与 `events.mux/host` 分开表达：网关活着不等于实时就绪。

### DSH 版本兼容与诊断

网关每隔一小段时间重新确认 DSH 的 API 形态，避免 DSH 重启/升级后继续沿用过期的点号或 slash 判断。已知点号 RPC 返回 404、405 或 501 时，会尝试等价的 generated slash RPC；只有成功后才把 collector 切换到 modern mux。`/diagnostics` 返回有 Bearer token 保护的内存快照，且反馈表单只有用户显式勾选时才将快照转发。快照仅含版本、协议形态、脱敏错误摘要和通道状态，不持久化、不包含请求体、token、Cookie、主机路径或会话内容。

为兼容新版 Remote 的按需 Session 读取，`api-session/activity` 会变换为旧客户端可消费的 `host/session-activity`，两端据此更新会话时间和排序。RemoteError/legacy 错误只以 RPC 名、状态和稳定错误码计入诊断，不转发可能携带用户输入的服务端错误文本。

### WS 活性

网关两侧发送 RFC6455 Ping 并等待 Pong，默认 Ping 30 秒、Pong 等待 90 秒；仅在控制帧无响应时销毁连接。关闭 Ping 时才使用可选的业务空闲超时，不能把“长时间没有业务消息”误判为死连接。

**客户端 Ping 应答（2026-09-19 新增）**：上游 collector 的 `socket.data` 监听现在解析客户端发来的 RFC6455 Ping（opcode 0x9、masked——客户端→服务器帧必须带掩码），并回送**未掩码** Pong（opcode 0xA，服务器→客户端帧禁止掩码，RFC6455 §5.1；早期实现误置掩码位导致 lws 客户端立即断链）。HarmonyOS lws 客户端依赖该应答维持链路，缺失时表现为约 30–90s 周期断连。

### 上游 API flavor 探测

探测（`session/list` probe）失败时保持 `unknown` 等待下轮重探，**不固化**为 `legacy`——否则网关先于 DSH Cookie 就绪启动（插件自启场景常见）会把 collector 永久钉在旧双流端点，表现为 events 长期 degraded。仅在探测**成功**且确认不支持 slash RPC 时才标记 legacy。

### modern mux 会话过滤

modern 模式建立 `session/follow` 时跳过 `origin === 'subagent'` 的会话（DSH 对 plain-address follow 返回 session/agent-busy 错误帧）。子代理事件仍经主会话通道下发，过滤只消除错误帧噪音，不丢事件。

### 跨端接续指针 `/handoff`

单条记录端点（GET/PUT/DELETE，Bearer 鉴权）：记录含 `sessionId/title/device/clientId/at`，7 天过期。设备离开会话时 PUT，另一设备打开会话列表时 GET 并按 `clientId` 排除自己写入的记录，展示"在 xx 设备上打开过"卡片；只传指针不传消息内容。HarmonyOS 消费方为 `HandoffState`/`HandoffCard`。

### 文件安全

`fsResolve()` 先做词法根目录检查，再对已存在路径做 realpath 检查；拒绝 `..`、绝对路径逃逸和符号链接逃逸。上传先写临时 part，完成后校验 SHA-256，再原子落位。

允许根判断使用 `path.relative()` 语义，Windows 下按大小写不敏感处理，因此支持盘符根、普通盘符目录和 UNC share，同时仍拒绝跨盘符/跨 share。`/fs/list` 把规范化完整条目路径和允许根返回给客户端；盘符根只有显式配置后才进入允许集合。

### 统计

`StatsStore` 以天为文件保存小时/模型/四桶 token，使用每个 session 的最大 seq 做幂等处理；北京时间 9-12、14-18 为工作日峰时，周末全天谷时。未知模型照记 token，费用为零。

## 5. 制作目的

- 把 DSH Web 的本地服务转换成可控的远程访问面。
- 集中处理安全和兼容，避免三个客户端各自实现 token、WS 和文件安全。
- 在 VPN、重启和上游短时不可达时提供可观察、可恢复的链路。
- 让插件模式和独立网关模式共享相同的客户端协议。

## 6. 关键环境变量

`PORT`、`HOST`、`TOKEN`、`TOKEN_FILE`、`DSH_UPSTREAM`、`DSH_HEALTH_PATH`、`DSH_REMOTE_ADVERTISE_HOSTS`、`DSH_REMOTE_DSH_SERVICE`、`DSH_REMOTE_SYSTEMCTL`、`DSH_REMOTE_WINDOWS_SC`、`DSH_REMOTE_DSH_CONTROL_MODE`、`DSH_REMOTE_DSH_CONTROL_TIMEOUT_MS`、`DSH_REMOTE_DSH_CONTROL_POLL_MS`、`DSH_REMOTE_FS_ROOT`、`DSH_REMOTE_FS_MAX_UPLOAD`、`DSH_REMOTE_DEVICE_KEYS`、`GATEWAY_WS_PING_MS`、`GATEWAY_WS_PONG_TIMEOUT_MS`、`GATEWAY_WS_UPGRADE_TIMEOUT_MS`、`DSH_REMOTE_ANNOUNCEMENTS_URL`、`DSH_REMOTE_FEEDBACK_URL`、`DSH_REMOTE_UPSTREAM_API_RECHECK_MS`、`DSH_REMOTE_COMPATIBILITY_LOG_MAX`。

## 7. 边界与禁止事项

- 必须保持零运行时依赖和单文件网关形态。
- 改 `gateway.js` 后必须 `npm run sync-plugin`，不能只改 `gateway.cjs`。
- 不因 `upstreamOk=false` 就自动重启网关；应显示 degraded 并等待上游恢复。
- 不让文件传输绕过 token、根目录或 realpath 检查。
- 不把 `/health.ok` 当成 mux/host 已连接的唯一证据。
- 模型配置请求仍必须经过普通 Bearer token 鉴权，网关日志不能记录请求体中的密钥；思考档位也只能作为 DSH RPC 的普通非秘密字段转发，不能在网关层自行映射第三方请求参数。

## 8. 测试与验收

- `tests/gateway.test.js`：网关 HTTP、文件、公告、事件轮询、WS 活性和恢复。
- `tests/device-keys.test.js`：设备密钥持久化与生命周期。
- `tests/stats.test.js`：统计聚合、价格和幂等游标。
- `tests/lifecycle.test.js`：DSH 多次重启、网关重启、客户端恢复和文件可用性。
- 使用隔离 HOME、固定 token 和临时文件根；不碰真实 `~/.dsh-remote`。

### 2026-08-26：透明转发模型级思考档位
- 需求：让自定义提供方的模型选择能够携带用户配置的思考档位。
- 方案：保持网关为 Bearer 鉴权后的 DSH RPC 透明代理，转发模型元数据和已有选择字段。
- 联动：不修改网关请求解析、日志和存储逻辑，由 DSH 适配器负责第三方参数映射。
- 验证：执行 `npm run sync-plugin`、`npm run check` 和 `git diff --check`。
- 未做：不新增网关端点、不记录 API key、不在网关中实现提供方适配器。

### 2026-09-03：DSH 接口兼容协商与可选诊断上传
- 需求：DSH 版本变化导致点号接口 404 时，客户端仍能创建会话和读取主机信息，并为问题分析保留证据。
- 方案：点号 RPC 404/405/501 后尝试对应 slash RPC；协议改变时重建 collector，并以有界、内存、脱敏日志生成 `/diagnostics` 快照。
- 后续：依据 DSH v0.1.2-alpha.2/alpha.4 的 RemoteError 与会话按需读取契约，兼容 `api-session/activity` 增量排序并记录稳定错误码。
- 联动：手机与桌面反馈表单增加默认未勾选的诊断上传选项；同步插件产物。
- 验证：网关子进程模拟点号 404/slash 成功，验证诊断和反馈链路；全量门禁待执行。
- 未做：不自动上传、不持久化诊断、不安装、提交或发布。

### 2026-09-19：HarmonyOS 链路修复与 `/handoff` 接续指针（PR #12 评审）
- 需求：评审发现 HarmonyOS lws 客户端周期断连（网关不回客户端 Ping）、events 长期 degraded（flavor 探测被毒化为 legacy）、子代理会话 follow 错误帧刷屏，并要求跨设备接续卡片。
- 方案：collector 侧新增 RFC6455 客户端 Ping→未掩码 Pong 应答（§4 WS 活性）；flavor 探测失败保持 unknown 不固化 legacy；modern mux 跳过 subagent 会话的 session/follow；新增单条记录端点 `/handoff`（GET/PUT/DELETE，Bearer，7 天过期）。
- 联动：`harmonyos/` RealtimeService 断连/降级恢复；HandoffState/HandoffCard 消费 `/handoff`（契约登记待 01-contracts.md）；同步 `packages/plugin/gateway.cjs`（cmp 一致）。
- 验证：真机 Pong 应答后断连消失（reason 75 收敛）；网关重启后 events ready/mux/host 全通；`npm run check` 189 pass / 0 fail。
- 未做：A/B 双服务器真机快速切换未跑（仅服务器语义层验证）；`/handoff` 正式契约条目待补 01-contracts.md。

## 9. 修改前检查清单

- 新端点是否鉴权、校验参数、处理 OPTIONS/CORS 和错误状态？
- 是否要同时更新 health capabilities、客户端回退和测试？
- WS 变化是否覆盖静默、断线、重连和上游恢复？
- 文件相关变化是否覆盖路径穿越、符号链接和上传中断？
- 修改后是否同步 `gateway.cjs` 并检查 `cmp`？

## 10. 未决事项

- 统计价格表当前为 v1 固定代码，未来可配置化，但需单独设计迁移和费用口径。
