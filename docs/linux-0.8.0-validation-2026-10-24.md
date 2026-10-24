# 0.8.0 Linux 笔记本隔离实测

2026-10-24，通过此前配对的 Remote 在用户笔记本上执行当前工作区源码快照。没有新增产品改动，也没有提交、推送或发布。

## 结论与范围

网关冒烟、已有 DSH 集成、真实 pnpm 更新／恢复／Remote 自更新，以及三分钟混合负载测试通过。全量 `npm run check` 原始结果为 **975 项：956 通过、1 失败、18 跳过**，退出码 1；失败对应当前测试进程环境无法访问 IPv6 回环 `::1`，未修改断言、跳过条件或系统配置来消除失败。

本轮测试当前 **Remote 0.8.0 源码**，在独立目录和临时 profile 中运行。笔记本原有 Remote 仍为 `0.8.0-rc.8`，不是 0.8.0 实装升级验收；真实已安装 DSH 为 `0.2.1-alpha.3`。Windows 上的 `0.2.1-rc.2` 适配验收仍以[此前记录](remote-adapters-live-2026-10-23.md)为准。

## 环境与源码

- Nyarch／Arch Linux x86_64，Node `22.23.2`、npm `10.9.9`；使用已有 pnpm `11.7.0`，没有下载或升级到仓库 pin 的 `11.28.5`。
- DSH 构建 CLI：`/home/blank/code/deepseek-harness/apps/cli/lib/bin.js`，实际执行 `--version` 后确认 `0.2.1-alpha.3`。没有重建或修改上游仓库，其两项既有改动保留。
- 专用目录：`/home/blank/dsh-remote-linux-080-2026-10-23T16-55-20-115Z`。目录名沿用连接建立时的时间，不作为报告日期依据。
- 快照来自 Windows 工作区的 753 个源文件，基准 Git HEAD 为 `813db9518ae250a38a0c7262c4ec330cc8d67c63`，包含当时未提交的候选版改动；不是只测该提交。
- 源码归档 SHA-256：`67ef870efe1638b60557b94a99c32fb596d0453f8009c967a7dc0f7107604229`。解压前检查路径与条目类型，拒绝穿越及链接；测试前后 753/753 文件清单校验一致。
- 各阶段使用独立临时 HOME／USERPROFILE／DSH_HOME／DSH_REMOTE_FS_ROOT／XDG 目录，清除外层代理、真实令牌和 Node 注入选项；未读取真实 `~/.dsh-remote`、其他会话或凭据。

## 实际结果

各行是独立运行，含部分可选测试的再次启用，不相加成一次全量结果。

| 检查 | 命令与结果 |
| --- | --- |
| 全量检查 | `npm run check`：975 项，956 通过、1 失败、18 跳过；退出 1 |
| 网关冒烟 | `node scripts/smoke-gateway.mjs`：退出 0；18787 端口的 supervisor／worker、HTML／JS 静态资源、正常关闭通过 |
| 已安装 DSH | `node --test tests/installed-dsh.test.js tests/session-observation-installed.test.js`：2/2 通过，无跳过 |
| 真实 pnpm | 设置 `DSH_TEST_PNPM` 为已有 CLI 后运行 `node --test tests/plugin-transaction-pnpm.test.js`：1/1 通过，无跳过 |
| Linux 容量与混合负载 | `DSH_TEST_EXTREMES=1 node --test tests/linux-extremes.test.js`：2/2 通过，无跳过；约 185.8 秒 |

已有 DSH 测试使用 220 个临时冷会话：启动及历史读取阶段 `coldAttached=0`、`writeOpens=0`，选中的正常会话可以收到实时事件。RSS 分别约 242 MiB 和 270 MiB。这不代表用户原始坏会话已完成迁移。

真实 pnpm 测试使用临时 profile 与本地模拟 registry，复现整份 lockfile 策略失败，并验证经过预检的更新、失败后恢复及 Remote 经操作 API 自更新。没有更新笔记本正在运行的插件，也没有调用真实模型。

容量测试接受并持久化 1000 条回执，下一次新写入返回 429；原请求重试没有重复执行，读取和健康检查继续可用。混合负载持续约 180.6 秒，完成 344 轮：

- 344 次 WebSocket 重连、344 次中断上传与 344 次内容校验续传。
- 11,008 次重复重试，对应上游意图仅 344 次。
- 每轮 16 路并发读取，健康检查批次 P95 为 33ms。
- 采样文件描述符约 89～90 个，结束时 73 个；RSS 采样峰值约 157.7 MiB。这是三分钟有界测试，不作为长期无内存增长的证明。

## 环境限制与剩余验收

唯一全量失败是 `插件自启：:: 上游认证、HTTP 和 WS 使用回环地址`。独立探测绑定 `::1` 返回 `EADDRNOTAVAIL`，当前 `lo` 没有 `::1`，`net.ipv6.conf.lo.disable_ipv6=1`。这解释了测试访问 `[::1]` 上游失败；保留退出码 1，未通过 sudo／sysctl 修改环境。网卡仍有 IPv6 地址，因此不能笼统称整台机器没有 IPv6。

当前执行环境的 `systemctl --user` 无法连接用户总线。本轮覆盖普通进程及 detached fallback，没有验证 systemd 用户单元生命周期。未做 Linux 0.8.0 实装升级、Linux 浏览器交互、Android 真机覆盖安装或报告者原始坏会话复验。

## 证据与清理

原始证据保存在工作区忽略目录 `dist/linux-0.8.0-2026-10-24/`，包含 `ENVIRONMENT.json`、`LINUX-RESULTS.json`、远端 `REPORT.md`、`PROGRESS.json`、源码快照及 `logs/`。完整测试命令、退出码、源码清单校验及清理记录以这些原始文件为准。准备阶段一次错误工作目录的日志也保留，正式全量结果来自正确的 `source/` 目录。

专用测试目录和日志保留供复查，只清理本次临时 HOME 与测试子进程。笔记本现有网关测试前后 PID 均为 `4127710`，版本仍为 `0.8.0-rc.8`；没有升级、停止或重启现有服务。

本轮文档改动仅本文及[正式版准备记录](0.8.0-release-readiness.md)，证据目录不入库；其他既有未提交改动保持原样。
