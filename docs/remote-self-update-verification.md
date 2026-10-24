# 旧网关接管与 Remote 自更新验证

2026-10-23，基于 `0.8.0-rc.9` 工作区的未发布修复。没有更新真实用户 profile，也没有提交或发布。

## 修复：旧版网关存在却被判定未运行

issue #21 的新反馈指出，部分早期 0.7.x 的 `/health?probe=live` 只有 `ok/service/version/probe/liveness`，PID 位于 `liveness.pid`。`v0.7.0` 源码也使用这个结构。原插件要求顶层 `pid/upstream/events`，因此绕过升级接管，最终只显示端口占用。

`packages/plugin/index.mjs` 现在兼容这种精简结构，读取 `liveness.pid`。缺失的上游信息保留为未知，由现有版本/上游检查触发接管。无需调用旧版可能阻塞的完整 `/health`，也不必更换端口。

服务标识、版本和有效 PID 仍须通过检查。公开探活只用于识别；停止旧网关仍只能使用已有令牌调用 `/admin/api/shutdown`。错误令牌、拒绝关闭、其他服务或非法响应均不会触发进程强杀。手动关闭的网关仍遵守 `gateway.enabled=off`。

## 自更新模拟

`tests/plugin-self-update.test.js` 在临时 HOME/profile、随机回环端口和固定测试令牌下运行真实插件入口、网关、独立 worker 和事务恢复。`tests/fixtures/self-update-host.cjs` 模拟 DSH 宿主、上游协议、精简旧探活与 CLI 下载换包；替换操作实际重命名整个插件目录。目标 `99.0.0-selftest.1` 仅存在于临时目录，不是产品版本。

| 场景 | 验证结果 |
| --- | --- |
| 精简旧探活 → 新插件启动 | 通过认证关闭旧服务，实际启动当前网关，HTTP 与 mux/host 就绪 |
| 旧服务使用另一令牌 | 仍报告运行中及认证问题，不停止旧服务、不启动重复网关 |
| 自更新缺少明确确认 | 拒绝执行 |
| worker 开始后宿主进程退出 | 独立 worker/CLI 继续完成；源码快照和任务记录位于包目录之外 |
| 真实重命名并替换包目录 | 备份保留更新前的完整插件树；仅文件更新不宣称运行版本已更新 |
| 实际重启模拟 DSH 宿主 | 新插件认证关闭旧网关；读回新 PID/版本，HTTP、双 collector 恢复 |
| 断线后重读/重试同一任务 | 终态仍可读，同一 ID 不重复执行 CLI |
| 网关重启后继续使用原配对 | 原 Bearer 令牌有效，可签发新的 WS ticket |
| 换包后 CLI 失败 | 明确失败，仍保留原网关服务，不宣称回滚 |
| 明确恢复更新前状态 | 校验后恢复原包及配置，保存失败文件；恢复任务不会重试安装，重启后记录仍在 |

另外，`tests/plugin-transaction-pnpm.test.js` 使用本机已有 pnpm 和临时回环 registry，实际执行 Remote 自身的预检、精确更新和完整快照，验证已安装版本、待重启状态、旧包备份，以及 Desktop `local-plugins` junction 保留。包内容是本地测试夹具，不连接公网 registry、不添加项目依赖。

## 运行与证据

```powershell
node --test tests/plugin-stop-safety.test.js tests/plugin-self-update.test.js tests/plugin-autostart.test.js tests/plugin-center.test.js tests/plugin-transaction.test.js tests/restart-connectivity.test.js
# 可选：DSH_TEST_PNPM 指向本机已有 pnpm.cjs；CLI 环境会写入临时 HOME
node --test tests/plugin-transaction-pnpm.test.js
npm run check
```

本次针对性回归 54 项：53 通过、1 项平台跳过、0 失败。显式启用的真实 pnpm 测试 1 项通过。全量 `npm run check` 为 961 项：943 通过、18 跳过、0 失败，日志为 `dist/remote-self-update-check-permitted.log`。首次沙箱运行的两项监督进程迁移测试因 `SUPERVISOR_IDENTITY_UNAVAILABLE` 失败，允许 Windows 进程身份查询后全量通过；没有放宽产品身份检查。pnpm 专项日志为 `dist/remote-self-update-pnpm.log`。

本地候选插件包为 `dist/remote-self-update-2026-10-23/dsh-remote-plugin-0.8.0-rc.9.tgz`，保留当前版本号，仅用于验证，不替换公开包。已解读 tarball 核对修复入口、网关、版本文件和插件排障知识库与源码逐字节一致。SHA-256：`4bc91f16305417d300e973eb901f6deb66423006de24af2b6117f08d5cd4160b`。

本轮文件范围：`packages/plugin/index.mjs`、`tests/plugin-stop-safety.test.js`、新增 `tests/plugin-self-update.test.js` 与 `tests/fixtures/self-update-host.cjs`、`tests/plugin-transaction-pnpm.test.js`、`docs/plugin-center.md`、`docs/0.8.0-release-readiness.md`、`docs/wiki/plugins.md`、本文和知识库同步副本。保留工作区之前的文档、版本码和插件列表改动，全部未提交。

## 仍需区分的边界

- 安装完成后仍需重启 DSH，才会加载新插件并触发版本接管。插件启动时会立即检查及延迟检查，管理状态请求也会触发自愈；没有新增定时后台升级。
- 已运行的旧 Windows 网关/DSH 若以包目录为工作目录，仍可能阻止包替换。新源码不能改变旧进程的工作目录；保留备份、确认实例并按[主机维护流程](plugin-center.md)处理，不能强制覆盖或盲目重试。
- 此次是 Windows 下的隔离进程/协议仿真与真实 pnpm 换包验证，未重新运行报告者 macOS 环境、真实 Desktop ASAR 自更新或手机真机流程，也不代表已公开分发。

相关入口：[插件管理](plugin-center.md)、[事务与恢复](plugin-update-transaction.md)、[插件排障知识库](wiki/plugins.md)。
