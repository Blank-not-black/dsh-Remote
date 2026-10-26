# 故障排查

[文档首页](README.md) · [配置参考](configuration.md)

需要按症状、错误码或 KB 编号逐项排查时，先读[操作与排障知识库](wiki/README.md)；交给用户自己的 AI 时，从 [AI 指引](wiki/ai-guide.md) 开始。本文保留快速检查入口。

## 按链路顺序检查

如果问题发生在 DSH Remote 自身，也可以从“反馈 → AI 排查问题”启动一次只读诊断；它会用你的 DSH 模型收集证据、区分已确认与可能原因，并生成反馈草稿。开始前会明确提示额度消耗，具体边界见 [AI 排查插件问题](plugin-doctor.md)。

先在 DSH 主机测试网关，再测试上游，最后测试另一台设备。默认地址下可使用：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
Get-NetTCPConnection -LocalPort 8787 -State Listen
```

Linux/macOS HTTP 检查：

```sh
curl -i http://127.0.0.1:8787/health
curl -i http://127.0.0.1:3080/
```

Linux 另可用 `ss -ltnp` 查看监听归属。自定义端口、上游和账户时用实际配置替代示例。

## 常见现象

| 现象 | 检查与处理 |
| --- | --- |
| 本机网关拒绝连接 | 确认实际 profile 安装、完整重启 DSH、网关启停意图和端口归属；从插件面板启动网关 |
| `ok:true`，上游不可达 | 网关能响应；检查 DSH 地址与进程，默认探测 `/`。不要将 degraded 当作网关未启动 |
| 本机正常，手机打不开 | 使用电脑 IP/Tailscale 地址，确认网络互通、AP 隔离与 TCP 网关端口入站；手机不能填 localhost |
| HTTP 正常，消息不实时 | 分别查看 `events.mux` 与 `events.host`；反向代理需支持 WS Upgrade 和长连接，检查 ticket 与上游认证 |
| 401/未授权 | 重新配对，确认当前设备令牌、独立设备密钥模式与撤销状态；不要根据公开 health 内容清空/重写主机凭证 |
| 插件管理页反复登录 | `/remote/` 与 `/remote/admin/api/*` 应使用一致的 DSH/反向代理登录规则；登录 HTML 或超时不等于 Remote 令牌失效 |
| 页面黑屏、升级后界面没变 | 强刷，退出重开 App，并核对实际插件包、静态文件与 APK 版本；不要只看 update.json |
| 文件 403 | 确认允许根、真实路径、账户权限、Windows junction 与 UNC 授权；不要通过工作区登记绕过默认 Windows 范围 |
| 上传 409/422 | 检查冲突、并发占用、续传偏移与 SHA-256；保留错误码并按客户端提示重试或清理上传 |
| 插件中心只读 | 主机 profile/官方 CLI 未确认、核心包受保护，或主机 Remote 插件太旧；在主机管理入口核对 |
| 插件任务一直显示进行中 | 查看任务进程是否仍活着；已知进程全部退出后自动标记中断，旧锁恢复需在主机核对后确认 |
| DSH 控制按钮不可用 | 看 `dshLifecycle` 和后端支持；需实际服务/可信启动配置，外部管理用 disabled |
| Android 后台无提醒 | 检查通知、前台服务、后台设置及厂商电池限制；实际时间可能被 Doze 延迟 |
| HarmonyOS 提醒/后台失效 | 侧载代理提醒与长时任务可能被拒绝或取消，进程内回退在应用冻结时不能保证执行 |

## health 的含义

`ok` 表示网关响应。`upstreamReachable/upstreamOk/upstreamStatus` 表示上游探测结果，`events` 表示两条采集流状态，`protocol/capabilities` 声明能力。

当前普通健康和管理状态读取后台快照；`upstreamCheckedAt/upstreamChecking` 表示完成时间与进行中状态。`/health?probe=live` 是快速存活探测，仍保留协议元数据，不等待昂贵的 Desktop 身份检查；它不能证明一次新的上游探测已完成。控制操作会另行实时核验身份。

## 重启与恢复

插件网关可能由 transient systemd 单元或 detached 进程启动，固定 `systemctl --user restart dsh-remote-gateway.service` 不是通用方法。优先使用插件面板的启停操作，或按实际方式重启 DSH。手动处理前核对 PID、路径和监听归属，禁止用 `pkill -f` 批量结束。

Windows Desktop 重启会关闭并重开应用，可能中断任务；控制仅适用于能验证当前实例身份的配置。若需要未打开 DSH 时通过公网启动，可先在管理页选择「登录后自动运行网关」，并配置中转和有效 DSH 启动信息；默认不会开启，Windows 登录前不会运行。自启异常可刷新状态、修复缺失文件，并检查 `~/.dsh-remote/autostart/startup-error.log`。正常退出、网络故障与真正崩溃分开处理。崩溃恢复记录可用于排查，不能承诺电脑关机后仍能自愈。

本地 tgz 安装遇到旧 lock 引用或 `EPERM`，核对 profile 和占用进程；使用 pnpm 安装本地替换包前需按主机流程先 remove 旧插件再 add。不要对正在运行的真实安装目录盲目替换。当天发布包被 `minimumReleaseAge` 阻止时，核对实际 profile 的 `pnpm-workspace.yaml`。

## 软件内更新 DSH Remote 失败

先确认更新入口：Remote 的“主机插件 → dsh-remote-plugin”更新、DSH Desktop 插件市场更新、Android App 下载更新，以及 DSH Desktop 自身更新，属于不同操作。不能只凭“软件内更新失败”判断为同一种目录锁。

Remote 插件管理中的更新失败时，展开该任务的操作记录，保留目标版本、失败阶段、错误码及任务日志。`snapshot` 阶段失败表示尚未开始安装；`cli` 或后续核验失败可能已改变部分文件，不能假定已回滚。有“恢复更新前状态”时先核对失败现场，再按提示明确恢复；不要连续重试同一次未知结果。

网关崩溃记录要按记录中的 `at` 核对发生时间，不能把反馈提交时附带的旧崩溃当作本次更新的原因。例如 0.8.0-rc.8 的 `gateway.cjs:3757` 是统计回填的 `console.log`，该位置本身不是安装器或插件事务。需要结合本地 `~/.dsh-remote/plugin-gateway.log` 与该更新任务的日志判断。

当前源码单独处理 stdout/stderr 输出流的 `EPIPE`、`EBADF`、`EIO`、`ERR_STREAM_DESTROYED`：日志接收端退出时网关继续服务，并为每条输出流最多保存一条 `log-unavailable` 本地诊断。其他程序异常仍按崩溃机制退出恢复；网络连接上的同名错误不因此被忽略。崩溃诊断现在保留这些固定错误码，不保存任意错误原文。旧版本已丢失的错误码无法补回。

Windows 的 `ERR_PNPM_EPERM ... rename` 另见[插件中心的目录锁说明](plugin-center.md#windows-自更新目录锁080-rc2)；DSH Desktop 自身安装目录被占用则见下一节。

## Windows：DSH 更新点了没反应 / 提示安装更新失败

DSH Desktop 的 Windows 内置更新会先退出 DSH，再由 NSIS 安装器原地替换整个安装目录。Windows 不允许覆盖正在运行的 exe：安装目录里的 `DeepSeek Harness.exe` 只要仍被别的进程占用，替换就无法完成。表现可能是明确提示「安装更新失败」，也可能看起来「点了没反应」、重新打开后仍是旧版本。下文用 `<DSH 安装目录>` 指实际安装目录（例如 `D:\dsh_desktop`）。

| 现象 | 含义 |
| --- | --- |
| 更新流程结束后重新打开仍是旧版本 | 先确认安装器是否运行过、安装目录是否被写入，再查占用 |
| 提示「安装更新失败」，或停在重启/安装阶段 | 常见失败点在替换文件，不是下载或哈希校验；安装器未必报出具体占用者 |
| 安装目录当天没有文件被修改，`resources\app.asar` 修改时间不变 | 新版本没有落盘；更新提示和下载完成都不等于安装成功 |
| 卸载登记项 `DisplayVersion` 仍是旧版本 | 同上；以实际文件、卸载登记项和关于页版本为准 |

以下检查在 DSH 已退出、更新失败之后进行。DSH 自身运行时同样占用自己的 exe，属于正常现象，不能用运行中的 DSH 判断更新是否被锁。

### 证据一：安装目录里的 exe 是否仍被占用

对 exe 做读写打开（`r+`，不写入内容）。DSH 已退出却仍返回 `EBUSY`（共享冲突，运行中占用最常见）或 `EPERM`（权限/只读），说明还有进程持有它。此命令需要 PATH 中有 Node，没有时可跳过，直接看下面的进程命令行：

```powershell
node -e "const fs=require('node:fs');try{fs.closeSync(fs.openSync(process.argv[1],'r+'));console.log('exe 可写')}catch(e){console.log(e.code)}" "<DSH 安装目录>\DeepSeek Harness.exe"
```

DSH 更新时本体已经退出，占用者通常是 Remote 插件的常驻网关。旧版插件在 Windows 上用 `process.execPath` 启动它，桌面版就是安装目录里的 exe，一般表现为监督进程与工作进程两个 PID：

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -match 'gateway\.cjs' } |
  Select-Object ProcessId, ExecutablePath, CommandLine
```

返回为空时去掉 `Name` 过滤再查一次；新版插件可能改用 PATH 或 `~/.dsh-remote/runtime` 中的 node 启动，进程名是 `node.exe`（内置副本为 `node-<版本>.exe`）：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'gateway\.cjs' } |
  Select-Object ProcessId, Name, ExecutablePath, CommandLine
```

只用 `ExecutablePath`（或 `CommandLine` 中第一个参数）核对解释器路径，不要仅凭进程名判断归属。安装器若用 Restart Manager 报出占用者，点名同一安装目录的 exe 或 `gateway.cjs` 时与上述结果互相印证。

### 证据二：安装器运行过，但没有写入安装目录

```powershell
# 安装器 Prefetch 记录；读取 Prefetch 通常需要管理员权限，无权限可跳过
Get-ChildItem "$env:SystemRoot\Prefetch\*DEEPSEEK*HARNESS*" -ErrorAction SilentlyContinue |
  Select-Object Name, LastWriteTime

# NSIS 残留
Get-ChildItem $env:TEMP -Filter 'nsr*.tmp' -ErrorAction SilentlyContinue |
  Select-Object Name, LastWriteTime

# 安装目录当天被修改的文件数
Get-ChildItem '<DSH 安装目录>' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -ge (Get-Date).Date } |
  Measure-Object
```

前两项有记录、最后一项 `Count` 为 0，说明安装器确实运行过，但安装目录没有被替换。再核对卸载登记项与 `resources\app.asar`：

```powershell
$uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
             'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
             'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
Get-ItemProperty $uninstall -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*DeepSeek*Harness*' } |
  Select-Object DisplayName, DisplayVersion, InstallLocation

Get-Item '<DSH 安装目录>\resources\app.asar' | Select-Object Length, LastWriteTime
```

`DisplayVersion` 和 asar 修改时间仍是更新前的值、重新打开 DSH 的关于页仍是旧版本，即可确认新版本没有落盘。

### 根因

旧版 Remote 插件在 Windows 上用 `process.execPath` 以 detached 方式拉起常驻网关（桌面版即安装目录内的 `DeepSeek Harness.exe`），并特意让网关在 DSH 退出后继续运行。Windows 不能替换正在运行的 exe，NSIS 更新器又要原地替换整个安装目录，写入因此被共享冲突挡住，安装器结束后版本仍是旧的。结束旧网关或由新插件认证接管旧网关后，exe 才重新可写，更新才能完成。

### 已修复的解释器选择顺序

Remote 0.8.1 起按以下顺序选择网关解释器：

1. `DSH_REMOTE_NODE`：绝对路径，须能执行 `-v` 且主版本 ≥ 18；无效值跳过并记录。
2. PATH 中的 `node`：同样校验。
3. DSH Desktop 内置运行时 `<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`：按版本复制到 `%USERPROFILE%\.dsh-remote\runtime\node-<版本>.exe`，同版本副本可执行则复用，新版本另建并保留旧副本。
4. 最后回退 `process.execPath`，并显式告警：`~/.dsh-remote/plugin-gateway.log` 写入「警告: 本次网关解释器位于 DSH 安装目录内，DSH 更新可能失败；…」，插件面板在版本号旁显示同一告警。

在 DSH Desktop 中，按真实路径解析后落在安装目录内的候选会被拒绝（含符号链接、目录联接；Windows 大小写不敏感），只有第 4 项例外。PATH Node 能正常启动网关时不复制内置运行时；没有可用外部候选，或外部候选通过 `-v` 但实际启动失败时，才按需准备内置副本。选择结果与跳过原因以 `网关解释器:`、`网关解释器候选跳过:` 开头的行写入 `~/.dsh-remote/plugin-gateway.log`。

插件面板版本号旁显示当前网关进程实际报告的解释器来源（`DSH_REMOTE_NODE`、PATH、内置副本、宿主 node 或外部 node）。若显示「网关解释器待确认」，从面板停止再启动网关后核对，不能仅凭没有安装目录告警就认定已经迁移。桌面插件重启后，同版本遗留网关也可经认证关闭并迁移到新选定的外部解释器；本次启动已尝试并回退的实例不会被反复重启。

### 修复后验证

1. 确认网关解释器不在安装目录内：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'gateway\.cjs' } |
  Select-Object ProcessId, Name, ExecutablePath, CommandLine
```

`ExecutablePath` 应为 PATH 中的 node，或 `%USERPROFILE%\.dsh-remote\runtime\node-<版本>.exe`，不能是 `<DSH 安装目录>` 下的 `DeepSeek Harness.exe`。

2. 退出 DSH 后重做 `r+` 打开测试，应输出「exe 可写」，不再报 `EBUSY`/`EPERM`。
3. 重试内置更新；完成后核对卸载登记项与 `resources\app.asar` 已更新。

### 处理与恢复

1. 升级 Remote 插件到含修复的版本；旧插件不会自动获得该行为。
2. 让旧网关被接管：重启 DSH，或在插件面板停止再启动网关。插件版本变化或网关重启时，新插件会认证关闭旧网关并拉起新网关。
3. 旧版遗留的网关也可以先在插件面板停止；面板无法接管时（认证失败或不属于当前实例），核对 PID、命令行与解释器路径后结束对应的网关 PID（旧版一般为监督进程与工作进程两个），再重试更新。不要按进程名批量结束，也不要把不属于网关的进程算进去。
4. 结束占用后先复测 `r+` 可写，再重试更新。

### 回滚与覆盖

- `~/.dsh-remote/runtime/` 下的副本按版本保留，可删除后由插件重新复制；删除前确认没有网关进程正在使用对应文件。
- 设置 `DSH_REMOTE_NODE` 为安装目录外的合格 Node 绝对路径可强制指定解释器；无效值或解析后位于安装目录内的路径会被跳过并记录，继续按顺序尝试后续候选。修改后需重启 DSH 或插件进程，解释器才会重新解析。配置项说明见[配置参考](configuration.md#网关解释器)。
- Linux/macOS 不受影响：运行中的可执行文件可以被替换，网关进程不会锁住更新；本条目只针对 Windows 的原地安装更新。

知识库对应条目：KB-PLUGIN-06（[插件管理与升级](wiki/plugins.md)）。

## 提交问题

在 [GitHub Issues](https://github.com/Blank-not-black/dsh-Remote/issues) 提供 Remote/DSH 版本、系统、安装方式、出现步骤、HTTP 状态和固定错误码。可从客户端主动附带脱敏兼容性诊断或崩溃摘要。截图遮蔽二维码、令牌、Cookie、账户和个人路径；不要直接上传原始启动配置或完整会话日志。
