# 错误码与状态索引

[首页](README.md)

相同 HTTP 状态可以来自不同层。先记下发生阶段、端点类别和组件版本，再查本表；表内不是完整错误枚举。

| 原文/状态/检索词 | 解释边界 | 下一篇 |
| --- | --- | --- |
| `ok:true`、`ready`、`degraded` | 网关响应与就绪程度；上游、事件通道分别核对 | [连接](connection.md) KB-CONN-02 |
| `EADDRINUSE`、`PORT_IN_USE` | 监听冲突，需要确认占用者身份 | [连接](connection.md) KB-CONN-01 |
| `SUPERVISOR_ALREADY_RUNNING`、`supervisor already running` | 当前互斥/兼容旧租约的判断；PID 存活本身不够 | [连接](connection.md) KB-CONN-01 |
| `SUPERVISOR_IDENTITY_UNAVAILABLE` | 无法核实旧 supervisor 身份，保守拒绝接管；可能是进程查询权限 | [连接](connection.md) KB-CONN-01 |
| `SUPERVISOR_ENDPOINT_TOO_LONG`、`EINVAL`、`ENAMETOOLONG` | macOS 等文件 socket 的路径/监听诊断；不等于端口占用 | [连接](connection.md) KB-CONN-01 |
| 401、登录 HTML、Unauthorized | 先区分 DSH/代理登录与 Remote 设备认证 | [连接](connection.md) KB-CONN-04 |
| `HOST_OFFLINE` | 中转视角的主机离线状态；不能唯一定位根因 | [连接](connection.md) KB-CONN-05 |
| mux/host 重连、WS 失败、轮询中 | 一条/两条事件通道退化；HTTP 可用不证明实时可用 | [连接](connection.md) KB-CONN-04 |
| `session/migration-required`、`cannot safely transform unclassified message source` | 上游旧会话迁移限制，Remote 侧隔离与提示 | [会话](sessions.md) KB-SESSION-02 |
| `permission: cannot restore preset "auto" without its active integration` | DSH 恢复 Auto 权限事实时缺当前有效集成；核对错误所属会话 | [会话](sessions.md) KB-SESSION-04 |
| accepted / rejected / pending / unknown | 分别核对操作阶段；未知不等于未执行 | [会话](sessions.md) KB-SESSION-03 |
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | 发布时间策略可能被锁文件中其他依赖触发 | [插件](plugins.md) KB-PLUGIN-03 |
| `EPERM`、快照路径越界、任务锁 | 要结合任务阶段，不能统称网络失败或随意删锁 | [插件](plugins.md) KB-PLUGIN-03 |
| 文件 403、路径不在允许范围 | 授权根、账户、真实路径和保护目录 | [文件](files.md) KB-FILE-01 |
| 上传 409/422、offset、SHA-256 | 冲突、续传或校验等，具体以响应固定错误为准 | [文件](files.md) KB-FILE-02 |
| 通知 unknown、规则不可用/过期 | 先区分规则来源和 Android 投递 | [通知](notifications.md) |

历史 issue #19 对应旧租约/PID 复用，#20 对应 macOS socket 过长，#21 对应大量会话主动观察，#18 仍包含上游迁移限制。这里是检索线索；关闭 issue 不代表当前机器已验证恢复。版本、实际安装与运行证据要求见 [AI 指引](ai-guide.md)。
