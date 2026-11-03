# 跨模块协议与数据契约

> 源码核对：2026-10-12，仓库 0.7.4；源码能力与历史验收分开说明。[文档首页](../README.md)。

> 状态：现行约束
>
> 相关实现：`gateway.js`、`packages/plugin/index.mjs`、`public/app.js`、`public/desktop/desktop.js`、`public/admin.js`

## 1. 模块定位

本模块不是运行时代码，而是所有端共同遵守的契约清单。它的目的，是在修改网关、插件、手机端、桌面端或管理页时，先确认字段和行为是否已经被其他端依赖。

## 2. 关键数据流

```text
DSH Web
  ├─ HTTP/DSH RPC ───────> gateway.js ───────> 手机 WebUI / 桌面 WebUI
  ├─ mux/host 事件 ──────> gateway collector ─> WS 或 events.poll
  └─ session/event ──────> plugin stats bridge -> gateway-stats.cjs

DSH plugin
  ├─ /remote 静态入口和管理回退
  ├─ 内置 gateway.cjs 自启停
  └─ commands.execute 斜杠命令桥接

admin.js -> /admin/api/state -> gateway 或 plugin fallback
```

## 3. 二维码配对协议

当前格式：

```text
dshremote://pair?token=<token>&server=<url-1>&server=<url-2>...
```

- `token` 是访问凭证，必须 URL 编码。
- `server` 可以重复；每个值是一个 `http://` 或 `https://` 网关地址。
- 管理页合并 `lanIPs`、`DSH_REMOTE_ADVERTISE_HOSTS` 暴露的地址和按主机保存的手动地址，去重后写入全部已启用地址；没有可用地址时使用 `host`/页面主机回退。
- App 使用 `URLSearchParams.getAll('server')` 读取全部地址，去重后保存到服务器列表；二维码中的 token 会绑定到每个导入地址。
- 第一个地址作为本次扫码后的当前连接，其他地址作为备用地址。
- 旧二维码只有一个 `server` 参数，必须继续可用。
- 不能把 token 放入普通日志、公告、测试记录或公开截图。

## 4. 服务器列表与持久化

### Android 通知投递身份（0.8.2-rc.2）

网关收集 `host/session-status`、`host/agent-error` 时，为帧顶层覆盖生成 `remoteEventId: <EVENT_STREAM_EPOCH>:host:<collector seq>`，同一帧在 WS 和 `/api/events.poll` 的 `event` 内保持一致；不使用上游 rpcId 推断投递身份。字段只作有界客户端去重，不参与鉴权；网关重启 epoch 更换。旧客户端忽略额外字段，新 Android 遇到旧网关无此字段时仅用 host 周期状态判定。只有 host 状态可建立运行周期，mux 会话日志的开始/结束不能再建立第二个周期。通知被系统拒绝时不记录已成功处理回执。


### Android 局域网配对 v1（0.8.2-rc.1）

- 默认关闭，仅主令牌可 `GET/POST /admin/api/lan`；POST `{enabled:true}` 要求独立设备密钥模式和非回环监听，返回 10 分钟有效的随机 80-bit 十六进制配对码，GET 不回读配对码。`{enabled:false}` 关闭发现并销毁挑战；重启亦失效。插件 `/remote/admin/api/lan` 经已有认证管理代理转发，不向普通手机设备开放管理能力。
- UDP 8788：请求 `{type:'dsh-remote-discover',version:1,nonce:<32 hex>,padding:...}`，总长 256–512 字节。回复 `{type:'dsh-remote-host',version:1,nonce,instanceId,name,port}`，不包含 code/token，回复不长于请求。Android 只搜索当前 Wi-Fi IPv4 子网，从回复包源地址构造 URL；发现结果仍是不可信候选，必须验证配对码。
- `POST /api/lan-pair` 不要求已有 Token，只接受真实 socket 来源为私网/回环、合法 Origin 与 JSON，忽略转发头。hello 为 `{step:'hello',instanceId,nonce,clientPublic}`，clientPublic/serverPublic 均为 P-256 DER SPKI 的标准 Base64。回复 `{challengeId,serverPublic,serverProof}`。
- transcript 是 `dsh-lan-v1`、instanceId、challengeId、nonce、clientPublic、serverPublic 以 LF 拼接，无尾 LF。配对码去空白/分隔横线后大写，其 SHA-256 为 codeKey。serverProof/clientProof 分别为 HMAC-SHA256(codeKey, `server\n`/`client\n` + transcript)，小写 hex。Android 在发送 clientProof 前验证 serverProof。
- finish 为 `{step:'finish',challengeId,proof:<clientProof>}`；挑战绑定来源 IP，30 秒有效且一次使用（失败亦消耗）。每来源最多 12 次 hello、最多 32 个待处理挑战、最多 128 个来源；10 次错误 proof 关闭整个窗口。输入长度有界，不把错误内容或密钥写入日志。
- AES-256-GCM 密钥为 HMAC-SHA256(codeKey, UTF-8(`key\n` + transcript + `\n`) || ECDH sharedSecret)，12-byte 随机 IV，AAD 为 transcript，16-byte tag。结果 `{iv,ciphertext,tag}` 均为标准 Base64，明文仅 `{token,deviceId}`。成功创建可撤销的独立设备密钥后关闭配对窗口。不交付管理令牌、不自动启用独立设备密钥模式，不自动重试不确定的凭据兑换。
- Android `NativeLan`：`search()`、`getState()`、`pair(hostId,code)`、`takePairResult()`、`cancel()`。hostId 必须来自当前搜索结果；成功凭据通过 take 一次消费，不进入发现状态。关闭/退后台递增 generation，晚到响应不能切换当前连接。


手机端和桌面端共享 localStorage 的 `servers-v2`：

```json
{
  "servers": [{ "id": "...", "url": "http://...", "note": "", "group": "默认", "token": "..." }],
  "groups": ["默认"],
  "activeGroup": "默认",
  "autoSelect": { "默认": true },
  "groupActive": { "默认": "server-id" }
}
```

- `state.server` 是当前实际请求地址；空值表示浏览器同源模式，不等于网关离线。
- 服务器连接身份是 `url + token`；同一地址允许配置多个不同 token，测速结果也按这个身份隔离，切换时同步切换 token。
- token 在本地 `servers-v2` 中按连接身份保存，列表不显示完整 token；旧记录没有 token 时沿用旧的全局 `token` 迁移。
- `servers-v1`/`server`/`activeServer` 只用于旧数据迁移，不再作为新写入格式。
- `server` 是当前地址，不是完整服务器列表；新增多地址功能不能只修改它。
- 服务器列表变化后要保存、重绘，并在需要时重建 WS/刷新数据。
- 工作台排序按 `workbenchOrderV1` 且按服务器作用域隔离，避免不同主机顺序互相覆盖。

## 5. HTTP、鉴权与 WS

| 路径 | 作用 | 约束 |
| --- | --- | --- |
| `/health` | 网关存活、上游和 mux/host 就绪状态 | `ok` 是网关响应成功；实时可用还需看 `events.mux/host` |
| `/diagnostics` | 兼容性诊断快照 | Bearer token；只含协议/版本、接口失败摘要和实时链路状态，禁止含 token、Cookie、对话或文件路径 |
| `/api/*` | DSH HTTP RPC 代理 | Bearer token；不得凭空发明 DSH RPC |
| `/api/ws-ticket` | 短时 WS 凭证 | 新客户端优先使用；旧网关保留 token 回退 |
| `/api/events.mux`、`/api/events.host` | 实时事件双通道 | downlink-only；客户端不发送应用层 ping |
| `/api/events.poll` | WS 受阻时的增量轮询 | `kind` 为 `mux`/`host`，使用 `since` 序号 |
| `/fs/*` | 文件列表、预览、上传、下载 | Bearer token、根目录与符号链接隔离 |
| `/handoff` | 跨端接续指针（单条记录） | Bearer token；GET/PUT/DELETE；7 天过期；只传指针不传消息内容 |
| `/admin/api/*` | 管理状态、设备密钥、网关控制 | 主令牌；设备令牌只可访问指定控制路由 |
| `/remote/*` | DSH 插件内嵌入口 | 由插件注册 prefix 路由 |
| `/stats/*` | Token 统计 | 数据来自网关统计核心，包含 token 量与已知模型的费用估算 |

插件内嵌 `/remote/admin/api/*` 已处于 DSH 登录边界内，前端不得发送 Remote Bearer 头覆盖反向代理的 Basic `Authorization`。独立网关 `/admin/api/*` 仍使用 Remote Bearer token。

`/fs/list` 返回规范化的当前 `path`、每个条目的完整 `path`、允许根 `roots`、主机 `platform` 和路径 `separator`。客户端必须把 Windows 盘符和 UNC share 当作有边界的根，不得把 `C:\Users\...` 的父级误算为 `/`，也不得在切换服务器后复用上一主机的文件路径。

DSH RPC 通用请求形态：

```json
{
  "type": "client-request",
  "rpcId": "uuid",
  "method": "session.list",
  "payload": {}
}
```

`session.prompt` 必须使用 `{ sessionId, mode: "queue", content: [{ type: "text", text }] }`；带图片时在 `content` 中加入图片块。斜杠命令走插件 `ctx.commands.execute`，不走 DSH API proxy 白名单。

网关通过点号 RPC 与 generated slash RPC 双向适配 DSH 版本。在点号 RPC 返回 404/405/501 时，网关只对已知的无副作用或客户端既有 RPC 尝试对应的 slash RPC；成功后切换实时采集器。`/feedback` 只有 `includeDiagnostics: true` 时才把当前脱敏诊断快照交给收集器，客户端默认不勾选。

普通 `/feedback` 正文上限为 20000 个 UTF-16 单元，投票编码上限仍为 2000，网关/配套收集器请求体上限为 256 KiB。收集器正文落盘后返回 `messageSha256`，网关核对已提供的摘要；旧服务明确拒绝长度/请求体时返回可辨识的 `collector-message-limit` / `collector-body-limit`，摘要不一致返回 `feedback-content-unconfirmed`，不裁剪或自动重发正文。轮询缓冲保留完整事件，按条数和总字节目标淘汰整条记录，与 WS 正文一致。详见[限制审计](../size-limits-and-chat-copy.md)。

generated Remote 的 `api-session/activity(sessionId, updatedAt)` 统一转换为 `host/session-activity`；手机和桌面端用它增量更新列表排序，避免新版 DSH 按需会话读取时每次活动都全量拉取。Remote/legacy 请求失败的诊断只记录 RPC 名称、HTTP 状态与稳定错误码，不记录错误正文。

### `/handoff` 跨端接续指针（2026-09-19 新增）

网关单条记录式端点，Bearer 鉴权，用于设备间接续提示（"在 xx 设备上打开过"卡片）。只传指针不传消息内容，消息仍走实时通道。

- **PUT**（写方离开会话时调用）：请求体 `{ sessionId, title, device, clientId, at }`——`sessionId` 目标会话 id；`title` 会话显示名；`device` 写方设备名（`deviceInfo.marketName`）；`clientId` 写方客户端 id（`StorageService.getOrCreateClientId`）；`at` 毫秒 epoch。网关整条覆盖存储，7 天过期。
- **GET**（接收方打开会话列表时调用）：返回记录或 `{}`；客户端必须**按 `clientId` 排除自己写入的记录**，`at` 超过 7 天视为过期忽略。
- **DELETE**：清除记录。
- 消费方：HarmonyOS `models/HandoffState.ets`（解析）+ `components/HandoffCard.ets`（展示）；网关实现见 02-gateway.md §4。
- 兼容约束：字段只增不改语义；旧网关无此端点时客户端必须静默降级（不展示卡片、不报错）。

模型配置沿用 DSH 已声明的设置/凭据服务：`llm.providers` 和 `settings.describe` 读取提供方与设置元数据，`credentials.describe` 只读取“是否已配置”等非秘密状态，`credentials.set/unset` 写入或清除密钥，`settings.mutate` 保存 API 地址、协议和模型目录，`llm.discoverModels` 获取候选模型，`settings.openDocument` 请求 DSH 打开配置文件。客户端不得把 API key 写入 localStorage、URL、二维码、反馈或日志。

模型目录中的单个模型可以附带思考深度元数据，Remote 不新增 RPC，继续通过既有 `session.selectModel` 的 `reasoningEffort` 传递用户选择：

```json
{
  "id": "custom-reasoner",
  "name": "Custom Reasoner",
  "reasoning": {
    "efforts": [
      { "id": "fast", "name": "快速", "description": "低延迟" },
      { "id": "deep", "name": "深度", "description": "更充分的推理" }
    ],
    "defaultEffort": "fast"
  }
}
```

`reasoning.efforts[].id` 是传给 DSH 的选择值，`name` 和 `description` 只负责显示；Remote 不假定第三方 API 使用哪一个 HTTP 字段。实际请求参数由 DSH 提供方适配器解释并序列化，不支持该值的适配器应返回错误或忽略该选择。旧模型没有该元数据时，客户端继续使用 `low/high/max` 兼容档位。

## 6. 版本与能力

`/health` 的 `protocol.version` 和 `capabilities` 是能力协商入口。新增能力应：

1. 增加能力字段并保持旧端回退；
2. 同时更新手机端、桌面端和必要的管理页；
3. 补测试，证明旧网关不会被新版客户端直接拒绝。

### 当前事件、异步与缓存契约

DSH 0.2 Inbox 的 next-turn / next-step 转换为客户端 queued / context 条目，保留消息 id 与 content；替换和空列表都是有效状态。普通会话订阅 job/list roster，替换/清空后更新重放基线；子代理查询从持久投影兼容，不能继续假定旧 subagent.list 必定存在。归档成功回执先更新网关已提交状态，不等待 workspace 流才报告归档。

连接上下文包括规范化地址、令牌与 generation；会话操作另捕获 sessionId/请求序号。请求开始、回执、body 读取及 finally 均检查归属，A→B→A 也不能放行第一次 A 的旧结果。history.js 按连接身份分区缓存与分页，切换时不复用旧会话的队列、模型、审批或文件路径。

Web 轮询使用 mux/host 独立长请求（wait=25000）与 since 游标；4 秒是任务检查周期。weak/normal/auto 是网络偏好，不是新的协议版本。goal phase 为 active/paused/blocked/complete，completed 不能替代 complete。

## 7. 边界与禁止事项

### 0.8 操作回执与事件实例

`/health.capabilities.operations=1` 时，Web 客户端对受支持的写入使用 `POST /api/operations?id=<稳定操作ID>`，body 为 `{method,payload}`；返回 202 表示已记下意图，不表示上游完成。随后只用 `GET` 查询同一 ID。响应 phase 为 `running|complete|rejected|unknown`，终态 result 保留原 RPC `{result:{ok,value|error}}` 外形。不同 payload 重用 ID 返回 409。

回执按上游地址、认证凭证和 ID 隔离，最长保留 24 小时、最多 1000 条；只存操作元数据、请求摘要和必要结果，不存输入正文或令牌。重启前仍在运行的回执恢复为 unknown，不重新执行。旧 DSH 的执行与网关记账之间没有跨进程事务，unknown 必须由用户核对，不能解释为失败后可安全重发。旧网关不声明此能力时保留原 RPC 路径。

`/api/events.poll` 新增可选 `epoch` 参数及响应 `epoch/reset/baseline`。网关实例变化、序号回退或缓冲截断均可触发 reset；客户端清理旧游标，处理基线和新事件，重新同步会话。baseline 来自 collector 的当前会话及待处理请求重放记录，不是完整历史。移动 Web、桌面 Web、Android 后台和 HarmonyOS 轮询都读取该实例标识。WS 仍遵守仅下行协议，慢客户端积压超过上限后断开并按既有重连/轮询机制恢复。

- 不把二维码、HTTP API、WS、文件传输和 DSH RPC 混成一个未经说明的“万能协议”。
- 不因为 HTTP `/health` 返回 200 就声称实时链路健康。
- 不在前端或插件内复制一套与 DSH Web 不一致的 RPC 字段。
- 不直接修改插件同步副本；协议相关源码只改根目录源文件。

## 8. 测试与验收

- `tests/network-regression.test.js`：实时协议、服务器状态、二维码结构与兼容回退。
- `tests/user-flows.test.js`：RPC、消息、文件、管理和公告全链路。
- `tests/gateway.test.js`：鉴权、事件轮询、WS、文件安全。
- 需要人工确认时，至少用一个有多个 LAN 地址的主机生成二维码，扫码后检查服务器列表和实际连接地址。

## 9. 修改前检查清单

- 这个字段是新增契约还是已有字段的语义变化？
- 手机端和桌面端是否都读取它？
- 旧二维码、旧网关或旧 App 是否需要回退？
- 是否需要同步 plugin public 副本？
- 是否补了结构测试和至少一个真实/隔离流程测试？

## 10. 赞助三端与插件只读适配（2026-11-01 开发变更）

- 赞助接收端：`/sponsor/api/applications` 创建编号，`/applications/:id` 以独立 Bearer 查询/提交；可复制的 `申请编号.随机凭证` 只用于恢复查询，不是中转密钥，不放入 URL。
- 管理端：`/sponsor/api/admin/config` GET/POST 读写布尔 `accepting`，环境紧急暂停优先；`/admin/applications/:id/revoke` POST 接收非空 `note`，只撤销该申请当前服务月的资格。列表可含受限 `usage`（month、online、usedBytes/limitBytes/remainingBytes/resetsAt），不返回凭据。
- 客户端：`/relay` 状态新增 `quotaPeriod: day|month`、`monthlyLimitBytes: number|null`、`fileTransfer: boolean`；旧响应缺字段仍兼容。文件限制由云端执行，界面说明不是授权依据。
- 任务看板：原生 `taskBoard.snapshot()` 接受 schema 6/7，投影仍返回 Remote `schema:1`；不透传新增 provider 配置或电源控制，schema 8 等未知值返回 unsupported。
- 团队：原生状态路由 404 返回 `available:false,code:endpoint-missing`，不把 404 当成卸载证据；原生 401/403 映射 host-denied。工作区成员边界不变。

## 11. 未决事项

- 当前二维码使用重复 `server` 参数；暂不改成 JSON/Base64 承载，以保持可读、兼容和低改动。
- /handoff 已实现；旧客户端可忽略，旧网关无端点时消费者须静默降级。

历史变更见[模块历史记录](../archive/module-changes.md)。
