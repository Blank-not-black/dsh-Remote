# DSH Remote 公网中转：开发者试用

推荐使用 rc.2「更多 → 主机与连接 → 云服务器中转」，粘贴个人密钥后点击「绑定并开启」。插件管理页也提供同样入口，客户端随网关自动运行。手机访问已经开通的地址时 rc.1 也可使用。

以下是保留的独立 CLI 方式，需要自己的 DSH、已运行的 Remote 网关和 Node.js 22+，不安装第三方依赖。旧 CLI 与内置客户端不要同时使用同一授权。

1. 从运营者获得私密邀请 JSON 文件和有效期，保存到仅自己可读的位置。
2. 确认本机 `http://127.0.0.1:8787/health` 正常；网关使用其他端口时替换下方地址。
3. 在工具文件夹的 PowerShell 中激活一次：

```powershell
$relayState = Join-Path $env:USERPROFILE '.dsh-remote/relay-pilot/my-desktop'
New-Item -ItemType Directory -Force -Path $relayState | Out-Null
$relayAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $relayState /inheritance:r /grant:r "${relayAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F'
node .\client.cjs enroll --invite 'C:\私密目录\invite.json' --state $relayState --gateway http://127.0.0.1:8787
```

激活会输出专属 HTTPS 地址和有效期。私钥保存在状态目录，不要发给运营者或其他人；同一邀请绑定一台主机。完成激活后删除临时邀请文件。不要删除 `host-private.pem`，否则需要重新申请授权。

4. 前台运行（终端会显示 `online`、`reconnecting` 等状态）：

```powershell
node .\client.cjs run --state $relayState
```

也可运行隐藏客户端包装脚本；关闭该脚本进程会一并结束其 Node 子进程：

```powershell
.\run-client.ps1 -StateDirectory $relayState
```

5. 手机添加激活时输出的 HTTPS 地址，填写**自己 Remote 的访问令牌**，然后连接。无需在手机填写中转邀请或主机私钥。DSH、Remote 和此客户端需要同时运行。
6. 在另一终端停止客户端：

```powershell
node .\client.cjs stop --state $relayState
```

再次执行 `run` 即恢复。前台运行也可 Ctrl+C。授权过期或被撤销后客户端退出，应联系运营者重新开通。主机离线返回 503；失效授权返回 403。暂时断网会自动重连，但不自动重发未确认成功的操作。

Linux/macOS 使用相同 Node 命令，把状态路径替换为 `~/.dsh-remote/relay-pilot/my-desktop`，并确保目录 0700、私钥 0600；停止命令相同。

每用户每天上传与下载合计 5GB，北京时间零点重置，由云端持久记账，重连不会重置。用完会断开该用户传输，零点恢复；本地访问仍可管理。云服务器终止 TLS，可在技术上接触中转明文。文件传输当前每路约 100 KiB/s，控制请求和实时输出不经过该速率限制器，但同样计入每日额度。尚无支付或流量套餐。
