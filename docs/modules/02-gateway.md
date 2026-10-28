# 独立网关模块

> 源码核对：2026-10-12，仓库 0.7.4；源码能力与历史验收分开说明。[文档首页](../README.md)。

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
| `lib/lan-pairing.cjs` → 内嵌 LAN factory | 主动开放的 UDP 发现、双向配对码握手、一次性加密设备凭据兑换；`scripts/embed-lan.mjs` 生成，仍为单文件网关 |
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

`loadToken()` 按 DSH_REMOTE_TOKEN、TOKEN、TOKEN_FILE 优先级读取/生成 token；`authorized()`、`adminAuthorized()` 和 `controlAuthorized()` 按接口权限区分普通、管理和控制操作。WS 优先使用短时 ticket，ticket 只消费一次并设过期时间。

所有请求会记录设备类型、client ID、IP、最后活跃时间和通道；设备密钥状态持久化到 `device-keys.json`，轮换/退出会主动断开受影响连接。

0.8.2-rc.1 提供默认关闭的限时局域网配对。管理页须先启用独立设备密钥，再主动开放 10 分钟发现；不持久化配对码或开放状态。管理接口 `/admin/api/lan` 只认主令牌，手机兑换接口 `/api/lan-pair` 只认一次性挑战证明，并限制真实私网来源、Origin、报文大小、次数与有效期。配对仅交付可撤销的设备密钥，主令牌轮换或关闭设备密钥模式同时关闭窗口。UDP 8788 只回复带随机 nonce 的有界查询；不修改防火墙。完整字段与加密域分隔见 [局域网配对 v1](01-contracts.md)。`DSH_REMOTE_DISCOVERY_PORT` 仅用于隔离测试；当前 Android 搜索固定 UDP 8788。

### 实时事件

`startEventCollector('mux'|'host')` 在网关启动时连接 DSH。连接阶段的 `error`、`close`、超时和构造异常通过幂等收口统一安排退避重连，避免旧连接事件影响新连接。

斜杠 RPC 的 modern collector 启动时仅打开 `$events`、`session/control`、`workspace/follow` 三条全局逻辑流，不按会话列表全量打开 `session/follow`。针对 [issue #21](https://github.com/Blank-not-black/dsh-Remote/issues/21)，成功读取历史后才登记该会话的短期观察需求，且只有宿主已经激活的普通会话（`agentAvailable` 或 `running` 为 true）才订阅日志和 `job/list`；冷历史及子会话保持只读，Remote 不通过 follow 恢复冷 Agent。需求最多保留最近 8 个会话，90 秒未续期后由 15 秒维护任务取消订阅；现有客户端每 15 秒同步当前历史，无需新增客户端协议。取消使用上游 `cancel`，重新观察分配新 stream id，丢弃旧连接和旧订阅的晚到帧，并清理旧 cursor、推理和任务重放。审批与问题仍由全局事件流投递，不受会话观察上限影响。

### DSH 生命周期控制

Linux/macOS 自动模式仅在检测到 systemd（或显式指定 `DSH_REMOTE_DSH_CONTROL_MODE=systemd`）时使用 `systemctl --user` 控制 `DSH_REMOTE_DSH_SERVICE`（默认 `dsh-web`）。Windows 自动模式先通过 `sc.exe queryex` 检查服务：存在时仍使用服务后端；仅在服务不存在（1060）时尝试普通进程托管，权限错误不会回退为另一个实例。显式 `windows` 模式不回退，`process` 强制使用进程托管。Docker、面板等外部编排可设置 `disabled`。`/health` 和管理页的 `dshLifecycle` 根据实际服务或有效启动配置声明，不再只按操作系统判断。

Windows CLI 中的插件会将经过 profile 检查的 Node 路径、原始启动参数（保留 profile、patch 和端口，追加 `--no-open`）、工作目录和 DSH_HOME 等环境写入 `~/.dsh-remote/dsh-launch.json`（可通过 `DSH_REMOTE_DSH_LAUNCH_FILE` 指定）。Windows Desktop 则生成 `kind:desktop` 配置，记录 GUI 根进程与 Host 的 PID、出生时间、可执行文件、Host 脚本和 profile 路径；无法验证的启动器不生成配置。文件原子替换，不通过 HTTP 接口接受命令。配置必须与网关的本机上游地址一致，路径失效或缺少配置时明确提示不支持控制。该文件及 `dsh-process.log` 含本机启动信息，应保持用户私有。

进程托管使用无 shell 的后台 spawn，启动前检查端口，已运行实例必须通过 HTTP 和 mux/host 检查才能报告成功；其他端口占用不会启动第二个实例。普通 CLI 进程仅在网关持有当前 ChildProcess 时允许重启，其他实例返回 `EXTERNAL_PROCESS`，不根据旧 PID 杀进程。Windows Desktop 的实验性控制另以完整进程身份、Host 祖先关系与端口归属核验接管 GUI 根进程；重启只结束已验证的 GUI 根进程，等待 Host 通过正常 IPC 断开流程退出，避免结束独立网关。启动退出时返回退出码与日志文件路径。网关退出不会主动结束托管 DSH。

此功能要求网关已经运行。Windows 管理页提供默认关闭的「登录后自动运行网关」选项，使用当前用户的 `HKCU/Software/Microsoft/Windows/CurrentVersion/Run`，不注册系统服务。`GET/POST /admin/api/autostart` 仅接受主令牌；插件内嵌页经已认证管理代理调用同一接口。写请求只允许布尔值 `enabled`，不接收路径、命令或环境。读取实际登记项并核对启动文件；开启/关闭后读回校验，其他启动配置不会被覆盖。后台监督、手动停止和 DSH 生命周期控制的边界保持独立。

为避免插件升级删除旧目录，开启时保存独立网关与静态资源副本及可信启动配置到 `~/.dsh-remote/autostart/`；新网关启动时只刷新已登记的自启。PowerShell 隐藏运行 `--supervise`，从私有 JSON 恢复端口、上游、认证及中转等配置，过滤 IPC/监督状态与 `NODE_OPTIONS`。Electron 运行时使用 `ELECTRON_RUN_AS_NODE`。登录只启动网关；需完成用户登录、配置中转和有效 DSH 启动信息后，才能通过公网启动 DSH。服务模式仍要求对应服务存在且网关用户有控制权限，可通过 `DSH_REMOTE_WINDOWS_SC` 指定 `sc.exe` 路径。

`pushEvent()` 写入带 `seq` 的环形缓冲，同时更新重放基线、广播 WS 客户端并唤醒长轮询。`/health` 将 HTTP 上游探测与 `events.mux/host` 分开表达：网关活着不等于实时就绪。

从 0.7.4-rc.1 起，上游与生命周期状态在后台约每 5 秒刷新，并合并并发探测。`/health` 和 `/admin/api/state` 使用快照，不等待 PowerShell；冷启动的普通健康请求最多等待 100ms，`/health?probe=live` 不等待上游且保留完整协议元数据。`upstreamCheckedAt` 标明上次完成时间，`upstreamChecking` 标明探测是否仍在进行。测速、首页网关存活判断和插件自愈使用存活探测；真正执行启动或重启前仍实时核验进程身份。Desktop 端口归属只计入目标本地地址和相关通配地址上的监听者，`disabled` 同时关闭 Desktop 后台崩溃事件探测；正常退出后未找到崩溃证据的日志探测最多持续两分钟。

### DSH 版本兼容与诊断

网关每隔一小段时间重新确认 DSH 的 API 形态，避免 DSH 重启/升级后继续沿用过期的点号或 slash 判断。已知点号 RPC 返回 404、405 或 501 时，会尝试等价的 generated slash RPC；只有成功后才把 collector 切换到 modern mux。`/diagnostics` 返回有 Bearer token 保护的内存快照，且反馈表单只有用户显式勾选时才将快照转发。快照仅含版本、协议形态、脱敏错误摘要和通道状态，不持久化、不包含请求体、token、Cookie、主机路径或会话内容。

为兼容新版 Remote 的按需 Session 读取，`api-session/activity` 会变换为旧客户端可消费的 `host/session-activity`，两端据此更新会话时间和排序。RemoteError/legacy 错误只以 RPC 名、状态和稳定错误码计入诊断，不转发可能携带用户输入的服务端错误文本。

**DSH 0.2.0-rc.2（Remote 0.7.1-rc.1）**：control baseline 与 session snapshot 中的 `inbox` 投影，以及后续投影更新，统一转换为 `session/queue`。`next-turn` 对应 `queued`，`next-step` 对应 `context`，保留消息 id、内容与来源；空投影会清空客户端队列。被按需观察的活动普通会话另外订阅 `job/list`，将完整 `rows.jobs` 转为 `session/jobs`，空列表同样下发。旧版 control 的 queue/jobs 帧继续支持；旧上游不提供 job namespace 时仅忽略该可选流的“方法不可用”错误，其他错误仍展示。

新加入的 WS 客户端重放最新队列和任务列表，包括清空状态；会话删除会取消两个流并移除对应缓存。`workspace/archiveSession` 成功回执中的 `archivedSessionIds` 先更新本地工作区缓存，避免紧接着的 `workspace.list` 因另一连接上的 follow 帧尚未抵达而返回旧归档状态。该适配已用隔离的真实 DSH 0.2.0-rc.2 验证，不调用收费模型，也不接触用户会话。

DSH 0.2 移除 `subagents/list` 后，`subagent.list` 会在该接口明确不可用时读取父会话的 `session/projections.subagentCatalog`，并读取子会话投影来恢复模式、标签及子目录状态；实时活动状态来自新读取的 session summaries。缺失或损坏的子会话保留诊断条目，根目录读取失败仍返回错误，不把失败当作空列表。旧版仍优先调用原接口。所有投影读取均不激活或恢复 Agent。

### WS 活性

网关两侧发送 RFC6455 Ping 并等待 Pong，默认 Ping 30 秒、Pong 等待 90 秒；仅在控制帧无响应时销毁连接。关闭 Ping 时才使用可选的业务空闲超时，不能把“长时间没有业务消息”误判为死连接。

客户端关闭本地 collector 通道时，网关立即停止广播和心跳，回复 Close 帧并结束连接；非法状态码、Close 控制帧分片及超长载荷返回 1002，非法 UTF-8 原因返回 1007，避免反复切换连接时旧通道滞留。测试 `tests/linux-extremes.test.js` 可用 `DSH_TEST_EXTREMES=1` 启用有界混合负载；真实 DSH 测试另用 `DSH_TEST_CLI_ROOT` 与 `DSH_TEST_OBSERVATION_STRESS=1` 检查 8 会话观察上限、真实 90 秒过期及重新观察，均只使用临时 profile。

**客户端 Ping 应答（2026-09-19 新增，2026-09-20 组帧加固）**：上游 collector 的 `socket.data` 监听解析客户端发来的 RFC6455 Ping（opcode 0x9、masked——客户端→服务器帧必须带掩码），并回送**未掩码** Pong（opcode 0xA，服务器→客户端帧禁止掩码，RFC6455 §5.1；早期实现误置掩码位导致 lws 客户端立即断链）。HarmonyOS lws 客户端依赖该应答维持链路，缺失时表现为约 30–90s 周期断连。解析采用 per-socket 接收缓冲 + 完整组帧（`wsParseClientFrame`，支持 126/127 扩展长度）：TCP 不保证帧边界与 data 事件对齐，凑齐整帧才应答；掩码残帧不产生任何 Pong；控制帧载荷超 125（§5.5 违规）丢弃不应答；未掩码/超长帧清空接收缓冲；缓冲上限 1MB。

### 上游 API flavor 探测

探测（`session/list` probe）失败时保持 `unknown` 等待下轮重探，**不固化**为 `legacy`——否则网关先于 DSH Cookie 就绪启动（插件自启场景常见）会把 collector 永久钉在旧双流端点，表现为 events 长期 degraded。仅在探测**成功**且确认不支持 slash RPC 时才标记 legacy。

### modern mux 会话过滤

modern 模式建立 `session/follow` 时跳过 `origin === 'subagent'` 的会话（DSH 对 plain-address follow 返回 session/agent-busy 错误帧）。子代理事件仍经主会话通道下发，过滤只消除错误帧噪音，不丢事件。

### 跨端接续指针 `/handoff`

单条记录端点（GET/PUT/DELETE，Bearer 鉴权）：记录含 `sessionId/title/device/clientId/at`，7 天过期。设备离开会话时 PUT，另一设备打开会话列表时 GET 并按 `clientId` 排除自己写入的记录，展示"在 xx 设备上打开过"卡片；只传指针不传消息内容。HarmonyOS 消费方为 `HandoffState`/`HandoffCard`。

### 文件安全

`fsResolve()` 先做词法根目录检查，再对已存在路径做 realpath 检查；拒绝 `..`、绝对路径逃逸和符号链接逃逸。上传先写临时 part，完成后校验 SHA-256，再原子落位。

允许根判断使用 `path.relative()` 语义，Windows 下按大小写不敏感处理，因此支持盘符根、普通盘符目录和 UNC share，同时仍拒绝跨盘符/跨 share。`/fs/list` 把规范化完整条目路径和允许根返回给客户端；Windows 默认包含当前用户目录与启动时可用的非 C 盘根；默认模式拒绝通过 workspace/junction 扩大到 C 盘其他区域。显式配置模式仍兼容已校验的 DSH 工作区。

### 统计

`StatsStore` 以天为文件保存小时/模型/四桶 token，使用每个 session 的最大 seq 做幂等处理；北京时间 9-12、14-18 为工作日峰时，周末全天谷时。未知模型照记 token，费用为零。

### 弱网与异常恢复

HTTP 对合适的静态/只读响应按需 gzip，静态资源使用编码区分 ETag/304，不改变 Range 下载。mux/host 长轮询独立等待与唤醒，避免一个通道阻塞另一个。配置默认值集中见[配置参考](../configuration.md)。

插件和 npm start 使用同一网关文件的 --supervise 路径；异常退出按 1/2/4/8/16 秒、每 5 分钟最多 5 次重试，正常停止与端口冲突不恢复。Windows Desktop 需要匹配的崩溃事件与实例身份；外部服务不被当作网关持有的子进程。日志只记录白名单事实，完整日志不自动上传。

Supervisor 互斥由系统 IPC 持有：Windows 使用命名管道，Linux 的 Node 20.8+ 使用抽象 Unix 套接字，按真实状态目录与端口区分，强杀后系统自动释放；较老 Node 与其他 Unix 使用文件套接字，连接确认无响应后回收残留路径。`gateway-supervisor-<port>.json` 的 v2 记录只用于诊断与 nonce 所有权清理，不再按 PID 是否存在判定占用。迁移旧租约时核对进程命令行、`--supervise` 与进程出生时间；无关进程、死亡进程和损坏租约可自动回收，身份查询失败则保留旧记录并写明诊断。`crashes.jsonl` 新增 `lease-recovered`、`lease-conflict`、`lease-failed`，启动冲突退出 78 也有可查询记录。此修复对应 [issue #19](https://github.com/Blank-not-black/dsh-Remote/issues/19)。

针对 [issue #20](https://github.com/Blank-not-black/dsh-Remote/issues/20)，文件套接字使用 16 位哈希后缀，按 UTF-8 字节数选择 `os.tmpdir()` 或 `/tmp`，路径最多 100 字节，监听后权限设为 `0600`。Windows 命名管道和 Linux 抽象套接字保留原来的 40 位名称。文件套接字迁移时同时持有可用的旧名称，并核验旧 v2 租约的命令和出生时间，避免端点变化绕过旧 supervisor；不是仅凭存活 PID 拒绝启动。路径错误记录为 `SUPERVISOR_ENDPOINT_TOO_LONG`，不会降级为 `INTERNAL_ERROR`。

`macos-files.yml` 在 Apple Silicon / Node 22 上运行全量 `npm run check`；真实产品失败保持失败，不自动跳过。主发布 `release-build.yml` 与手动 `macos-preview.yml` 复用 `macos-build.yml`，依赖该门禁后按构建、ad-hoc 签名、验签、产物冒烟、上传顺序执行；主发布汇总同版 APK、三个平台网关与 SHA256，任一 macOS 步骤失败会阻止发布。`node scripts/smoke-gateway.mjs` 可在 Linux/macOS/Windows 隔离验证源码；传入二进制绝对路径则验证单文件产物。脚本使用临时 HOME、固定测试令牌、禁用外部上游和生命周期控制，显式启动 `--supervise`，验证进程归属、HTML/JS 资源及正常关闭，失败输出日志并清理进程。此检查不等于完整 DSH 集成、Intel / Node 25 验证或用户真机验收；依赖 `DSH_TEST_*` 的集成用例仍需额外准备夹具。未加入 launchd 自启。

### 可选图片视觉桥接

只有上游明确在接纳消息前拒绝图片（session/attachment-invalid、MODEL_DOES_NOT_SUPPORT_IMAGES）时，网关才检查主机已启用的 dsh-image-vision config/attach 接口，把内联图片转换为同上游附件引用并保留其他内容与原发送模式。超时、结果不明或已接受的 prompt 不通过此路径重试，避免重复消息。缺少插件、未启用或附件引用非法时明确失败；tests/vision-bridge.test.js 覆盖这些边界。

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

## 9. 修改前检查清单

- 新端点是否鉴权、校验参数、处理 OPTIONS/CORS 和错误状态？
- 是否要同时更新 health capabilities、客户端回退和测试？
- WS 变化是否覆盖静默、断线、重连和上游恢复？
- 文件相关变化是否覆盖路径穿越、符号链接和上传中断？
- 修改后是否同步 `gateway.cjs` 并检查 `cmp`？

## 10. 未决事项

- 统计价格表当前为 v1 固定代码，未来可配置化，但需单独设计迁移和费用口径。

历史变更见[模块历史记录](../archive/module-changes.md)。
