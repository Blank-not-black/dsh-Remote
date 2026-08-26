# DSH 插件集成模块

> 状态：现行模块
>
> 核心代码：`packages/plugin/index.mjs`、`packages/plugin/client.js`
>
> 页面：根 `public/plugin.html`、`public/plugin.js`，同步到 `packages/plugin/public/`

## 1. 模块定位

插件把 DSH Remote 接入 DSH Web。它负责在 DSH 内提供入口、挂载 `/remote` 页面、管理内置网关，并把 DSH 原生 commands/agents 能力桥接给远程控制台。

## 2. 代码结构

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | DSH Node half：路由、网关生命周期、管理回退、命令桥接、统计投递 |
| `client.js` | DSH client half：侧栏 footer 入口和右侧 shell overlay 抽屉 |
| `public/plugin.html` | 插件内快速状态面板页面 |
| `public/plugin.js` | 网关状态、用量和快捷按钮渲染 |
| `package.json` | 插件元数据与入口 |
| `cordis.patch.yml` | DSH 插件运行环境补丁声明 |

## 3. 当前功能

- 在 DSH 原生侧栏注册 DSH Remote 入口。
- 通过 iframe 懒加载快速状态面板，深入管理打开完整控制台。
- 在 DSH Web HTTP Server 上挂 `/remote` 前缀。
- 网关已运行时复用；未运行时按用户意图自启/自愈。
- 优先用 `systemd-run` 启动 transient 网关，失败则 detached spawn 回退。
- 从 `ctx.webServer` 获取真实 DSH host/port，向网关传入 `DSH_UPSTREAM`。
- 管理页在网关不可用时显示插件本地回退状态。
- 通过 `ctx.commands.execute(agent, line, signal)` 执行斜杠命令。
- 监听 `session/event`，把 usage 投递给网关统计模块。

## 4. 具体实现方式

端口优先级为 `DSH_REMOTE_GATEWAY_PORT` 环境变量、`~/.dsh-remote/gateway-port` 文件、默认 8787。`portInUse()` 在启动前检查端口，避免误杀或覆盖其他服务。

`gatewayRunning()` 通过 `/health` 判断网关；`ensureGateway()` 只有在网关版本或 DSH 上游地址发生变化时才重启，不能因为 DSH 短时不可达制造重启风暴。自启意图保存在 `gateway.enabled`，用户明确关闭后不能后台拉起。

插件路由使用 `webServer.register({ kind: 'prefix', path: '/remote' })`。`serveStatic()` 服务插件页面，并代理管理/统计/设备密钥请求到本地网关；网关未运行时返回显式能力为 0 的 fallback，而不是假装完整网关能力存在。

斜杠命令先解析 session 对应 agent；执行成功返回 `executed`，未执行时由客户端回退成普通文本。这样 commands 不绕过 DSH 插件注入边界。

## 5. 制作目的

- 让用户可以在原有 DSH 工作流中一键打开远程控制台。
- 把网关生命周期绑定到 DSH 生命周期，同时尊重用户的手动停止意图。
- 复用 DSH 原生 command/agent 能力，不在网关重复实现内部控制逻辑。
- 在网关暂时不可用时仍提供可理解的本地主机状态。

## 6. 生命周期

```text
apply(ctx)
  -> 读取 DSH host/port
  -> 注册 /remote prefix
  -> 监听 session/event 统计
  -> ensureGateway()

DSH restart / plugin reload
  -> 检查用户意图、网关版本、上游地址
  -> 必要时精确终止旧网关
  -> 拉起新网关并等待 health
```

## 7. 边界与禁止事项

- 不在插件中复制完整网关协议；网关仍是 `gateway.js` 的职责。
- 不把上游短时不可达当成网关重启条件。
- 不用 `pkill -f` 清理网关；本地处理必须使用 health/PID 后精确 `kill <pid>`。
- 不直接编辑 `packages/plugin/public/*` 的同步文件。
- 不把插件回退状态宣称为真实网关的设备、事件或统计状态。

## 8. 测试与验收

- `tests/plugin-runtime.test.js`：真实挂载、管理回退和 command/agent 链路。
- `tests/plugin-autostart.test.js`：systemd-run 失败时的 fallback 启动、管理和停止。
- `tests/network-regression.test.js`：上游不可达不触发重启。
- `tests/plugin-icon.test.js`：插件入口图标约束。
- 本地实装若被明确要求，必须额外核对 profile 包版本、网关 PID、端口和 `/health`，不能以测试代替安装。

## 9. 修改前检查清单

- 是 DSH 原生能力桥接，还是网关能力？归属是否正确？
- 是否会影响 plugin mode 和 standalone gateway mode？
- 是否改变网关启动/停止、端口或 DSH 重启行为？
- 是否需要更新 `packages/plugin` 同步产物？
- 是否同时覆盖 systemd-run 和 detached spawn？

## 10. 未决事项

- systemd-run、用户服务和 detached spawn 的统一日志/状态模型仍可进一步收敛，但不应改变当前自愈边界。
