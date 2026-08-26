# 跨模块协议与数据契约

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
- 管理页从 `lanIPs` 去重后写入所有主机地址；没有可用 LAN 地址时使用 `host`/页面主机回退。
- App 使用 `URLSearchParams.getAll('server')` 读取全部地址，去重后保存到服务器列表。
- 第一个地址作为本次扫码后的当前连接，其他地址作为备用地址。
- 旧二维码只有一个 `server` 参数，必须继续可用。
- 不能把 token 放入普通日志、公告、测试记录或公开截图。

## 4. 服务器列表与持久化

手机端和桌面端共享 localStorage 的 `servers-v2`：

```json
{
  "servers": [{ "id": "...", "url": "http://...", "note": "", "group": "默认" }],
  "groups": ["默认"],
  "activeGroup": "默认",
  "autoSelect": { "默认": true },
  "groupActive": { "默认": "server-id" }
}
```

- `state.server` 是当前实际请求地址；空值表示浏览器同源模式，不等于网关离线。
- `servers-v1`/`server`/`activeServer` 只用于旧数据迁移，不再作为新写入格式。
- `server` 是当前地址，不是完整服务器列表；新增多地址功能不能只修改它。
- 服务器列表变化后要保存、重绘，并在需要时重建 WS/刷新数据。
- 工作台排序按 `workbenchOrderV1` 且按服务器作用域隔离，避免不同主机顺序互相覆盖。

## 5. HTTP、鉴权与 WS

| 路径 | 作用 | 约束 |
| --- | --- | --- |
| `/health` | 网关存活、上游和 mux/host 就绪状态 | `ok` 是网关响应成功；实时可用还需看 `events.mux/host` |
| `/api/*` | DSH HTTP RPC 代理 | Bearer token；不得凭空发明 DSH RPC |
| `/api/ws-ticket` | 短时 WS 凭证 | 新客户端优先使用；旧网关保留 token 回退 |
| `/api/events.mux`、`/api/events.host` | 实时事件双通道 | downlink-only；客户端不发送应用层 ping |
| `/api/events.poll` | WS 受阻时的增量轮询 | `kind` 为 `mux`/`host`，使用 `since` 序号 |
| `/fs/*` | 文件列表、预览、上传、下载 | Bearer token、根目录与符号链接隔离 |
| `/admin/api/*` | 管理状态、设备密钥、网关控制 | 管理凭证或插件内管理回退 |
| `/remote/*` | DSH 插件内嵌入口 | 由插件注册 prefix 路由 |
| `/stats/*` | Token 统计 | 数据来自网关统计核心 |

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

## 6. 版本与能力

`/health` 的 `protocol.version` 和 `capabilities` 是能力协商入口。新增能力应：

1. 增加能力字段并保持旧端回退；
2. 同时更新手机端、桌面端和必要的管理页；
3. 补测试，证明旧网关不会被新版客户端直接拒绝。

## 7. 边界与禁止事项

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

## 10. 未决事项

- 当前二维码使用重复 `server` 参数；暂不改成 JSON/Base64 承载，以保持可读、兼容和低改动。
