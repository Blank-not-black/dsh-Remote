# 故障排查

[文档首页](README.md) · [配置参考](configuration.md)

## 按链路顺序检查

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

Windows Desktop 重启会关闭并重开应用，可能中断任务；控制仅适用于能验证当前实例身份的配置，不创建登录自启。正常退出、网络故障与真正崩溃分开处理。崩溃恢复记录可用于排查，不能承诺电脑关机后仍能自愈。

本地 tgz 安装遇到旧 lock 引用或 `EPERM`，核对 profile 和占用进程；使用 pnpm 安装本地替换包前需按主机流程先 remove 旧插件再 add。不要对正在运行的真实安装目录盲目替换。当天发布包被 `minimumReleaseAge` 阻止时，核对实际 profile 的 `pnpm-workspace.yaml`。

## 提交问题

在 [GitHub Issues](https://github.com/Blank-not-black/dsh-Remote/issues) 提供 Remote/DSH 版本、系统、安装方式、出现步骤、HTTP 状态和固定错误码。可从客户端主动附带脱敏兼容性诊断或崩溃摘要。截图遮蔽二维码、令牌、Cookie、账户和个人路径；不要直接上传原始启动配置或完整会话日志。
