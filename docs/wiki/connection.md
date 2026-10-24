# 连接、认证与网关排障

[首页](README.md) · [错误索引](errors.md)

## 先画清实际链路

手机/App → 局域网/VPN/中转 → Remote 网关 → DSH 主机。插件内嵌面板另外处于 DSH 登录边界内。不要用其中一段成功证明整条链路可用。

默认网关为 8787，DSH 独立部署示例为 3080；Desktop 的 DSH 可能使用动态端口。插件网关端口优先级：`DSH_REMOTE_GATEWAY_PORT` → 运行账户的 `.dsh-remote/gateway-port` → 8787。独立网关使用 `PORT`。以实际配置为准。

在主机做有限的只读检查（将示例端口改为已确认的本机端口）：

~~~powershell
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 3
$health | Select-Object ok, version, pid, status, upstreamOk, upstreamReachable, upstreamStatus
$health.events | Select-Object mux, host
Get-NetTCPConnection -LocalPort 8787 -State Listen
~~~

~~~sh
curl -sS --max-time 3 http://127.0.0.1:8787/health
~~~

保留 health 给本地分析，公开反馈前再脱敏地址、路径和错误文本。不要追加读取令牌文件、Cookie 或全部环境变量。没有事件字段的旧版本标为未知。

## KB-CONN-01：网关待启动、拒绝连接或端口占用

**先看：** 运行账户/profile、端口是否监听、监听者身份、插件网关日志最后约 120 行；同时核对启停意图。

**判断：** 无监听通常在启动链路；有其他监听者是占用；有 Remote health 但面板认为未启动，还需检查管理认证与运行版本。不能只凭 PID 存在判定它是 supervisor。

**下一步：** 优先由用户在插件面板启动或调整端口；变更环境变量通常需要重启相关进程。重启/结束进程必须有明确授权和实例归属。

**验收：** 端口由正确实例监听，health 版本吻合，上游与双事件通道恢复；再从原客户端连接。`SUPERVISOR_*` 诊断见 [错误索引](errors.md)。

## KB-CONN-02：ok:true 但 degraded、upstream 不通

**先看：** `upstreamReachable/upstreamOk/upstreamStatus`、实际 DSH 地址、登录状态、DSH 进程，以及 mux/host 各自状态。默认探测 DSH 根路径 `/`。

**判断：** `ok:true` 只说明网关响应。401 可能说明 HTTP 可达但认证未就绪；Desktop 重启换端口、登录 Cookie 尚未兑换、DSH 本身阻塞需要分别查证。上游临时不可达不应触发网关重启风暴。

**下一步：** 在主机确认 DSH 正常响应，再核对插件记录的 upstream；不要自行把不存在的 `/healthz` 当作重启条件。

**验收：** 正确上游可响应且认证满足当前接口，目标会话可读取，mux/host 恢复或明确使用轮询。

## KB-CONN-03：主机正常，手机打不开或切网后断线

**先看：** 手机实际使用的地址、同一部手机在 Wi-Fi/蜂窝及 VPN 开/关下的对照，DNS 与实际网络路径。手机的 localhost 指向手机自己。

**判断：** 仅某一网络失败优先查网络、VPN、AP 隔离、防火墙和地址族；不能直接归因于云端。纯 IPv6 DDNS 还需确认网关监听 IPv6。

**下一步：** 由用户在已知地址上做最小对照。插件支持 `DSH_REMOTE_GATEWAY_HOST` → `HOST` → `.dsh-remote/gateway-host` → `0.0.0.0`；需要 IPv6 可配置 `::`，但改监听、防火墙与公网暴露属于配置变更。

**验收：** 原失败网络下可进入同一主机、读取同一会话；网络恢复后历史/事件继续，不重复发送消息。

## KB-CONN-04：401、反复登录或实时更新失败

**先看：** 分清 DSH/反向代理登录、Remote 主令牌与独立设备密钥；只确认当前设备配对状态，不读取凭据内容。检查 mux、host、WS ticket 和反向代理 Upgrade。

**判断：** 登录 HTML、代理超时、设备撤销与 token 失效不是同一种错误。单通道降级轮询是设计行为；不能靠“WS connected”断言历史完整。

**下一步：** 需要时由用户重新配对或在原 DSH 登录入口恢复登录；不把公开 health 当作强杀/轮换凭据依据。客户端不发送应用层心跳，网关使用 WebSocket Ping/Pong。

**验收：** 对应认证入口成功，目标接口返回预期数据；检查两条事件流或轮询的实际增量。

## KB-CONN-05：中转 HOST_OFFLINE

**先看：** 当前中转配置、主机网关是否已连接正确中转、设备身份与主机归属；再做 KB-CONN-03 的同手机网络对照。

**判断：** 云端入口可打开，只证明入口响应；`HOST_OFFLINE` 不能唯一定位为防火墙、主机关闭或 DNS 故障。

**下一步：** 对照网关、中转与手机三侧同一时间的有限状态。不要因一端报错就重装云服务或更换凭据。

**验收：** 相同主机通过原网络可访问且可读会话；长连接与中转在线状态分别核对。自建部署的详细环境准备在仓库 `docs/self-hosted-relay.md`。
