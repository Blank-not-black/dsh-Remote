# Desktop 状态与重启恢复排查（2026-10-18）

后续实施状态：本文记录的是修复前的排查快照。相关修复已包含在本地实装的 `0.8.0-rc.4` 中，实际远程重启与构建验收见 [rc.4 安装记录](rc-0.8.0-rc.4.md)。下方复现脚本针对旧行为断言，不应作为修复后的通过门禁。

本次仅分析和复现，没有修改产品代码、重启当前 Desktop、部署或提交。当前工作区之前的功能改动全部保留。现场运行的是已安装的 0.8.0-rc.3，与当前未部署的工作区存在差异；下述缺陷均以读取到的函数和隔离执行结果为依据，不把测试环境结果视为本机长期断连的完整复现。

## 已确认的问题

| 优先级 | 问题 | 触发与影响 | 代码位置 |
| --- | --- | --- | --- |
| P1 | 失效 WS 票据仍被缓存复用 | 网关替换后旧票据不再有效；同一票据 4 次使用后也耗尽。客户端只看过期时间，没有同步剩余次数，也没有在握手失败后清除缓存。默认有效期 90 秒，剩余超过 15 秒时一直复用，因此可能约 75 秒持续尝试旧票据，之后还需等待下一次重试。期间轮询可能恢复消息，不能等同于完全无法收消息。手机和桌面均存在。 | `gateway.js: issueWsTicket/authorized`；两端 `getWsTicket/openStream` |
| P1 | Desktop 重启会替换保存重启任务的网关 | 已观察日志中的上游端口 `61130 → 59417 → 58448`。插件检测端口变化后认证关闭旧网关并启动新网关；`dshControlOperation` 仅保存在旧进程内存。客户端在临时断网或 `OPERATION_NOT_FOUND` 时立即停止轮询，不能跨网关继续确认重启结果。 | `packages/plugin/index.mjs: ensureGateway`；`gateway.js: dshControlOperation/serveDshControl`；`public/app.js: pollDshControlOperation` |
| P2 | 新版状态信息字段不完整 | 兼容层 `host.describe` 仅返回 `home、canOpenPath`，手机设置仍读取 `version、cwd、attachedSessions`，因此 HTTP 成功也无法显示完整主机信息。当前实际安装版只读请求已确认这一返回结构。 | `gateway.js: translateModernRpc`；`public/app.js: refreshHostDescription` |
| P2 | 状态描述成功会覆盖不可达证据 | 新版 `host.describe` 可以直接返回网关缓存，不需要本次访问 DSH。两端收到结果后都强制设置 `health.upstreamReachable = true`。隔离场景中，已有 `upstreamReachable=false、upstreamOk=false` 被改成 `true、false`，可能误导总览。 | 两端 `refreshHostDescription/refreshHostDescriptionDesktop` |
| P2 | 生命周期请求没有绑定服务器身份 | 远程控制轮询每次读取当前 `state.server/token`。A 的任务等待期间切到 B，会拿 A 的任务 ID 和 B 的凭证查询 B；A 的晚到状态也能渲染到当前界面，A 的 POST 回执会启动针对 B 的后续查询。确认的是跨服务器查询、显示和认证提示错位，没有证据表明它会向 B 自动重发重启 POST。 | `public/app.js: loadDshControl/controlDsh/pollDshControlOperation` |
| P3 | WS 关闭原因丢失 | `onclose` 忽略事件参数，读取 `ws.code/ws.reason`；真实关闭码和原因在 CloseEvent 中。注入 `1008 / invalid ticket` 后，两端记录的是 `0 / 空串`，降低现场诊断能力。 | 两端 `openStream: ws.onclose` |

## 验证与边界

- 用真实源码函数在 Node VM 内复现缓存票据复用、断线原因丢失、健康状态覆盖、跨服务器状态污染，以及断网/任务不存在时轮询退出。VM 中的网络和定时器由夹具控制，没有访问用户配置。
- 两个临时 HOME 的真实网关做 HTTP/WS 握手：同一票据连续使用结果为 `101、101、101、101、401`；A 的新票据用于 B 返回 `401`；B 自己签发的新票据返回 `101`。两个网关、模拟上游及临时目录均在结束后清理。
- 现有相关测试 72 项通过，0 失败，0 跳过。这些测试验证了已有行为，但没有覆盖上述恢复缺口；不能据此说缺陷已经修好。
- 保留并验证了已有保护：WS generation/旧连接身份隔离；票据请求跨连接时的迟到结果隔离；轮询 epoch 重置与重同步；Desktop 重启前对可执行文件、启动时间、父子关系、监听端口归属的校验。
- 没有主动重启真实 Desktop，没有复现用户现场持续离线的全过程。上一轮只读现场检查显示 DSH HTTP 与 mux/host 当时正常。

## 建议修复顺序

1. 连接失败或网关实例变化时废弃旧票据；按双通道连接尝试重新签发/分配票据，保留并发共享和 generation 隔离；记录真正的 CloseEvent。
2. 生命周期任务持久化并携带目标 Desktop/启动前身份和网关交接信息。新网关继续核验新 PID、上游 HTTP 与两条通道；前端仅重试状态 GET，不自动重发重启 POST。
3. 生命周期状态、POST 回执及轮询全部捕获原连接身份，切换服务器后停止旧任务对当前界面的更新。
4. 将主机元信息和实时可达性分开；补齐可验证的字段，缺失时显示未知，不能用兼容层的本地成功响应覆盖上游失败证据。

## 本地复现产物

复现脚本与输出放在忽略目录 `dist/`，属于诊断产物，不是正式测试或发布资源：

```powershell
node dist/desktop-recovery-audit-2026-10-18.cjs --integration
```

结果：`dist/desktop-recovery-audit-2026-10-18.json`。
现有测试日志：`dist/desktop-recovery-existing-tests.log`。
脚本断言当前缺陷能够复现；脚本通过代表复现成功，不代表产品修复。
