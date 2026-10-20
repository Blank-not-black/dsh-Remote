# 自建云服务器中转引导

[文档首页](README.md) · [安装与首次连接](getting-started.md) · [中转实现说明](../relay/README.md)

把中转服务部署到自己的云服务器，让手机通过 HTTPS 访问家中或办公室电脑上的 DSH Remote。电脑主动连接云服务器，不需要给家中路由器做端口映射，也不需要把电脑的 8787 端口开放到公网。

本文按 2026-10-20 工作区 `0.8.0-rc.6` 源码核对。提供的是部署操作指引；本轮未在新购云服务器执行安装，也未完成用户手机验收。公开安装包是否包含对应功能，应以所选版本为准。

## 1. 先分清三台设备

```text
手机 / 浏览器
    │ HTTPS + WebSocket，使用自己的 Remote 访问令牌
    ▼
自己的云服务器：Nginx :443 → broker 127.0.0.1:18180
    ▲
    │ 电脑主动建立 HTTPS Upgrade 隧道（出站 443）
    │
自己的电脑：中转客户端 → Remote 网关 127.0.0.1:8787 → DSH
```

云服务器只运行中转，不必在云端安装 DSH、配置模型 API Key 或复制会话文件。电脑仍要开机、联网，并运行 Remote；要处理会话时 DSH 也要可用。中转不能唤醒已关机或睡眠的电脑。

自建时，你同时是服务运营者和使用者，可以自行签发中转邀请，无需申请公共试用。当前代码的限额仍然生效：最多同时 5 份有效授权，每份授权每日上传和下载合计 5GB，北京时间零点重置；文件接口全局最多 2 路，每路上传、下载分别约 100 KiB/s。**这些限制不会因为使用自己的服务器而自动取消，目前也没有对应的管理 CLI 调参选项。** 云厂商的带宽和流量账单另计。

两段 TLS 在云端终止，云端技术上能够接触中转内容；这不属于端到端加密。主机私钥留在电脑上；手机继续通过 Remote 自己的鉴权访问会话和文件。

## 2. 准备清单与示例值

本文使用 Ubuntu 24.04 / Debian 系列、systemd、Nginx 和 Certbot。需要能用 SSH 登录并执行 `sudo`。其他系统应调整包管理器、服务路径和证书工具，不要逐字照搬。

| 项目 | 本文示例 / 要求 |
| --- | --- |
| 云服务器 | 一台有公网 IPv4 的 Linux 服务器；手机和电脑均能访问它 |
| 域名 | 自己可管理 DNS 的域名，本文用 `example.com` 占位 |
| 控制域名 | `relay-control.example.com`，用于注册和主机隧道 |
| 手机访问域名 | `relay-home.example.com`，只分配给这台电脑 |
| 云端 Node.js | 22+；安装在系统可执行路径，本文以 `/usr/local/bin/node` 为例 |
| 云端代码 | 本仓库 `relay/` 中全部 `.cjs` 文件，无需 `npm install` |
| 本机环境 | 已可本地访问的 DSH Remote；CLI 方式另需本机 Node.js 22+ |
| 管理访问 | 示例 SSH 用户为 `ubuntu`，请替换为实际账户 |

先根据实际使用地区和云厂商要求确认域名接入条件。本文不提供购买套餐或容量承诺；已有服务器也可使用，先确认不会覆盖其他站点。

在 DNS 控制台新增两条 **A 记录**，都指向云服务器公网 IPv4：

```text
relay-control.example.com → 云服务器公网 IPv4
relay-home.example.com    → 云服务器公网 IPv4
```

先使用直接解析到源站的 DNS，关闭这两个域名的 CDN/代理加速。不要发布不可达的 AAAA 记录。控制隧道使用 `Upgrade: dsh-relay-v1`，不是 WebSocket，不能仅凭 CDN 支持 WebSocket 就认为它能中转此隧道。

云安全组与操作系统防火墙需允许 TCP 80、443 入站；SSH 端口只对自己的管理来源开放。本文的 HTTP-01 证书签发和续期都需要 80。**不开放 18180、8787 或 DSH 端口。** 电脑只需允许到控制域名的出站 443。

下文所有 `example.com`、`YOUR_SERVER`、`ubuntu` 和源代码路径都要替换。控制域名与手机域名必须不同，不能用同一个域名下的两个路径替代。

## 3. 云端：安装工具与放置代码

本节及第 4～6 节命令均在**云服务器 SSH 终端**执行。

```sh
sudo apt-get update
sudo apt-get install -y nginx certbot git curl
node --version
command -v node
```

若没有 Node 或版本低于 22，先从 [Node.js 官方下载页](https://nodejs.org/en/download)取得适合服务器架构的受支持版本，并核对发布文件的校验值。本文不使用远程脚本一键安装。运行账户不能依赖 SSH 用户的 nvm 或家目录；下面 systemd 配置开启了 `ProtectHome=true`。

确认系统路径的 Node 可用。若安装位置不同，后续所有 `/usr/local/bin/node`（包括服务文件）一起替换为实际绝对路径：

```sh
/usr/local/bin/node --version
```

准备一份选定版本的源码。下面获取默认分支快照并记录提交；若使用发布标签，应先切换到实际存在的标签。云端与本机 CLI 使用同一份代码快照，不能把本文工作区版本当作已公开发布版本。

```sh
git clone --depth 1 https://github.com/Blank-not-black/dsh-Remote.git "$HOME/dsh-remote-src"
git -C "$HOME/dsh-remote-src" rev-parse HEAD
```

若已经下载源码，直接使用其目录，无需再次克隆。首次安装时创建专用运行账户和目录：

```sh
sudo useradd --system --user-group --home-dir /var/lib/dsh-relay-pilot --shell /usr/sbin/nologin dshrelay
sudo install -d -m 755 /opt/dsh-relay-pilot/app
sudo install -d -o dshrelay -g dshrelay -m 700 /var/lib/dsh-relay-pilot
sudo install -m 644 "$HOME/dsh-remote-src"/relay/*.cjs /opt/dsh-relay-pilot/app/
sudo -u dshrelay /usr/local/bin/node --version
```

这些是首次安装命令；已有同名账户、目录或服务时先检查其用途。代码由管理员维护，运行账户只写状态目录。不要把邀请、注册表或私钥放进 Nginx 静态网站目录。

## 4. 云端：配置域名和 HTTPS

### 4.1 先配置 HTTP 验证入口

先确认端口占用与 DNS：

```sh
sudo ss -ltnp
getent ahostsv4 relay-control.example.com
getent ahostsv4 relay-home.example.com
```

DNS 应指向本服务器的公网入口。如果已有 Nginx、Apache、Tailscale Serve 或面板监听 80/443，应先理清监听范围；不要停止其他服务或直接覆盖整套 Nginx 配置。服务器经 NAT 映射公网地址时，该公网地址未必能写进 `listen`，须以 `ip addr` 中实际可绑定的本机地址为准。

首次部署、以下两个配置文件均不存在时，建立专用站点。此阶段不引用尚未签发的证书：

```sh
sudo install -d -m 755 /var/www/dsh-relay-pilot/.well-known/acme-challenge
sudo tee /etc/nginx/sites-available/dsh-relay-pilot >/dev/null <<'NGINX'
server {
    listen 80;
    server_name relay-control.example.com relay-home.example.com;
    access_log off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/dsh-relay-pilot;
        try_files $uri =404;
    }
    location / { return 404; }
}
NGINX
sudo ln -s /etc/nginx/sites-available/dsh-relay-pilot /etc/nginx/sites-enabled/dsh-relay-pilot
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

`nginx -t` 失败时先修正错误，不继续 reload 或申请证书。其他发行版如果不加载 `sites-enabled`，应使用其实际加载的配置目录，不要重复加载同一份站点。

### 4.2 签发包含两个域名的证书

```sh
sudo certbot certonly --webroot -w /var/www/dsh-relay-pilot \
  --cert-name dsh-relay-pilot \
  -d relay-control.example.com -d relay-home.example.com
sudo certbot certificates
```

按 Certbot 提示填写邮箱等信息。成功后应能看到两个域名及证书路径。没有成功签发就先处理 DNS、80 入站或验证目录，不要关闭客户端的 TLS 校验。

### 4.3 启用 HTTPS 反向代理

先备份刚才创建的站点，再使用仓库 [Nginx 示例](../relay/nginx.conf.example)生成最终配置：

```sh
sudo cp -a /etc/nginx/sites-available/dsh-relay-pilot "/etc/nginx/sites-available/dsh-relay-pilot.before-https-$(date +%Y%m%d%H%M%S)"
sed 's/relay-pilot\.example\.com relay-a\.example\.com relay-b\.example\.com/relay-control.example.com relay-home.example.com/g' \
  "$HOME/dsh-remote-src/relay/nginx.conf.example" \
  | sudo tee /etc/nginx/sites-available/dsh-relay-pilot >/dev/null
sudo nginx -t
sudo systemctl reload nginx
```

这里的替换只生成本文两个域名；使用自己的域名时，修改替换后的域名部分。检查生成文件中的 `server_name`、证书路径和 `proxy_pass http://127.0.0.1:18180`。

示例文件需处于 Nginx 的 `http {}` 上下文，因为含有 `log_format`。它显式传递 Host、Upgrade 和 Connection，使用 HTTP/1.1，关闭请求/响应缓冲、缓存和上游自动重试，保留流式输出、长轮询与 WS。不要只复制一个普通静态网站的代理片段。示例的 `client_max_body_size 20m` 也会限制上传请求；提高时需结合网关上限、带宽、超时及每日额度验证。

配置证书成功续期后 reload Nginx 的钩子，并测试续期：

```sh
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/dsh-relay-nginx >/dev/null <<'HOOK'
#!/bin/sh
/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx
HOOK
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/dsh-relay-nginx
sudo certbot renew --dry-run
systemctl list-timers --all 'certbot*'
```

保留 ACME 验证路径与 80 入站。若没有续期 timer，应按当前 Certbot 安装方式配置周期执行 `certbot renew`；若已用 cron 或其他调度，不要重复建立任务。`--dry-run` 验证续期流程，本身不证明部署钩子已经在正式续期中执行过。

## 5. 云端：初始化并启动中转服务

只初始化一次，**不要覆盖已有的 `registry.json`**：

```sh
sudo -u dshrelay /usr/local/bin/node /opt/dsh-relay-pilot/app/admin.cjs init \
  --state /var/lib/dsh-relay-pilot/registry.json \
  --origin https://relay-control.example.com --base-domain example.com
```

`--origin` 是 HTTPS 控制域名，不带业务路径；`--base-domain` 是可分配手机域名的父域，本文允许 `*.example.com`。默认隧道也使用控制域名的 443，无需额外启用直连 TLS 端口。

使用仓库 [systemd 示例](../relay/dsh-relay-pilot.service.example)，只调整 Node 路径：

```sh
sed 's|/opt/dsh-relay-pilot/runtime/bin/node|/usr/local/bin/node|' \
  "$HOME/dsh-remote-src/relay/dsh-relay-pilot.service.example" \
  | sudo tee /etc/systemd/system/dsh-relay-pilot.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-relay-pilot
sudo systemctl status dsh-relay-pilot --no-pager
```

检查 broker 本地健康，必须带控制域名的 Host：

```sh
curl --fail --show-error -H 'Host: relay-control.example.com' http://127.0.0.1:18180/health
curl --fail --show-error https://relay-control.example.com/health
```

两者都应返回 `{"ok":true,"service":"dsh-relay-pilot"}`。不带正确 Host 的回环请求会被当成租户入口，不能据其失败判断 broker 不健康。

公网检查还应在电脑或其他网络执行一次。**控制域名健康只证明云端入口工作，不证明电脑已连入或 DSH 会话可用。**

## 6. 云端：为自己的电脑签发邀请

域名和证书就绪后，签发一份 30 天邀请：

```sh
sudo -u dshrelay /usr/local/bin/node /opt/dsh-relay-pilot/app/admin.cjs issue \
  --state /var/lib/dsh-relay-pilot/registry.json \
  --label my-home --domain relay-home.example.com --days 30 \
  --out /var/lib/dsh-relay-pilot/invites/my-home.json
sudo -u dshrelay /usr/local/bin/node /opt/dsh-relay-pilot/app/admin.cjs list \
  --state /var/lib/dsh-relay-pilot/registry.json
```

邀请最长 90 天，首次绑定一把主机公钥。记录输出中的授权 `id`、域名和有效期。邀请文件含 `server` 与 `code` 两个字段，是敏感文件；注册表只保存邀请码摘要，不代表邀请文件可公开。

为普通 SSH 用户生成仅本人可读的临时传输副本：

```sh
sudo install -m 600 -o "$(id -un)" -g "$(id -gn)" \
  /var/lib/dsh-relay-pilot/invites/my-home.json "$HOME/dsh-relay-invite.json"
```

下一步用 SCP 下载，完成绑定后删除云端临时副本、原始邀请与电脑上的临时邀请文件。不要把邀请码发到 issue、截图、聊天日志或源码仓库。

## 7. 电脑：接入自己的中转

当前设置页只接收 `dsrp_…` 格式的邀请码，**没有自定义服务地址输入框**，默认连接公共试用控制地址。自建邀请不能直接粘贴到仍使用默认配置的页面。

可以选择下面一种方式。插件/Desktop 用户先用 **A：独立 CLI**，无需更改现有网关启动方式；能管理网关实际启动环境的用户可用 **B：内置客户端**。两种方式不要同时使用同一授权。

### A. 独立 CLI（Windows PowerShell）

电脑需有 Node.js 22+ 和与云端相同快照的 `relay/` 文件。进入本机源码的 `relay` 目录，先确认本地 Remote 正常；如实际端口不是 8787，后面一并替换。`127.0.0.1:8787` 应是独立网关根地址，不能填 DSH 的 `/remote` 挂载路径。

```powershell
node --version
curl.exe --fail --show-error http://127.0.0.1:8787/health
$relayState = Join-Path $env:USERPROFILE '.dsh-remote/relay-pilot/self-hosted-cli'
New-Item -ItemType Directory -Force -Path $relayState | Out-Null
$relayAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $relayState /inheritance:r /grant:r "${relayAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F'
scp 'ubuntu@YOUR_SERVER:./dsh-relay-invite.json' (Join-Path $relayState 'invite.json')
node .\client.cjs enroll --invite (Join-Path $relayState 'invite.json') --state $relayState --gateway http://127.0.0.1:8787
node .\client.cjs run --state $relayState
```

确认 `icacls` 和 SCP 成功后再激活。`enroll` 从邀请 JSON 的 `server` 读取自建控制地址，输出专属 HTTPS 地址；`run` 保持运行并应显示 `online`。关闭此终端会失去中转，断网时客户端会自动重连。

在另一 PowerShell 终端停止：

```powershell
node .\client.cjs stop --state (Join-Path $env:USERPROFILE '.dsh-remote/relay-pilot/self-hosted-cli')
```

需要隐藏运行时见 [CLI 使用说明](../relay/CLIENT.md)中的 `run-client.ps1`；它不自动创建登录启动任务。先完成前台验收，再自行配置系统进程管理。电脑的 Remote 网关和 CLI 都必须保持运行。

Linux/macOS 使用相同 Node 命令和参数，把状态目录替换为 `~/.dsh-remote/relay-pilot/self-hosted-cli`；先 `umask 077`、创建目录并设为 0700，再下载邀请并激活。私钥文件应为 0600。

### B. 内置客户端（适合自行管理网关启动环境）

网关支持以下环境变量，需在**实际启动网关的进程环境**中设置，重启后才生效：

| 变量 | 自建用途 |
| --- | --- |
| `DSH_REMOTE_RELAY_ORIGIN` | `https://relay-control.example.com`，控制地址，不带路径 |
| `DSH_REMOTE_RELAY_STATE` | 独立私有状态目录，建议与公共试用、CLI 目录分开 |
| `DSH_REMOTE_RELAY_CA_FILE` | 可选的受信 CA PEM 路径；正常公网证书不需要设置，不能用于跳过验证 |

例如在手动启动独立网关的 PowerShell 中设置：

```powershell
$env:DSH_REMOTE_RELAY_ORIGIN = 'https://relay-control.example.com'
$env:DSH_REMOTE_RELAY_STATE = Join-Path $env:USERPROFILE '.dsh-remote/relay-pilot/self-hosted-integrated'
```

先创建并按 A 的方式限制该目录 ACL，然后从**同一终端**按原有命令启动网关（源码方式为 `node .\gateway.js --supervise`，从仓库根目录执行）。以上变量只对该进程及其子进程生效；后续重启也必须保留配置。已有网关时应通过原管理方式停止旧实例后再启动，不能让第二个网关争用同一端口。

插件/Desktop/登录自启各有启动链路，不能假定在任意 PowerShell 设置变量就会改变已运行的应用或其系统服务。如果不能确认变量传递到了网关，使用 A。不要修改默认控制域名的源码来绕过启动环境配置。

从本地地址连接主机，在「更多 → 主机与连接 → 云服务器中转」或主机插件管理页，粘贴本次邀请 JSON 的 **`code` 值**，点击「绑定并开启」。不要粘贴整个 JSON。管理操作使用主机管理令牌；设备密钥只能读取状态，需要在页面提供的输入框中临时填写管理令牌。

确认状态变为已连接，返回的专属地址是 `https://relay-home.example.com`。如果仍向公共试用服务注册，应检查实际网关的启动环境，先不要反复点击绑定。

已有公共试用连接的主机，先通过本地地址停用旧连接，备份其私有状态，再使用新的状态目录。页面的「接管已有试用连接」面向原 `owner-preview` 目录，不是通用的 CLI 导入功能；不要用它迁移自建 CLI。

## 8. 手机：连接与验收

1. 手机切换到蜂窝网络，避免只验证了同一 Wi-Fi 下的访问。
2. 在 Android App 或浏览器添加 `https://relay-home.example.com`。填写自己 Remote 的访问令牌或已授权的设备密钥，**不是**中转邀请码、云服务器密码或模型 API Key。
3. 打开会话列表，选一个测试会话发送短消息，检查流式回复；在诊断页确认 mux/host 实时通道。能打开静态首页不代表实时链路正常。
4. 上传、下载一个小文件，确认内容完整；大文件受当前云端限速和额度约束。
5. 让客户端空闲数分钟后继续操作，再切换 Wi-Fi/蜂窝网络，确认连接能恢复。发送结果未知时先检查会话历史，不要重复提交写操作。
6. 通过本地地址确认中转状态、有效期与用量，保留局域网或其他可信直连地址作为管理备用入口。

首次部署的验收记录至少应包含：

| 检查层 | 通过证据 |
| --- | --- |
| 云端进程 | `dsh-relay-pilot` 和 Nginx 均为 active，18180 仅回环监听 |
| 控制入口 | 外部网络访问控制域名 `/health` 返回 broker 健康 JSON，TLS 校验通过 |
| 主机接入 | CLI `online` 或内置状态「已连接」，授权未到期 |
| Remote 鉴权 | 手机使用自己的访问凭证成功；无凭证的受保护 API 应拒绝 |
| 实际功能 | 会话读写、mux/host、流式回复、小文件传输及网络切换均通过 |

手机域名下的 `/health` 来自自己的 Remote 网关，与控制域名下的 broker `/health` 含义不同。Remote 的 `ok:true` 还不能代替 `upstreamOk` 和实时通道检查；DSH 未启动或上游认证失效时，需要先恢复电脑上的 DSH。

## 9. 日常维护、续用与停用

### 状态与日志（云端）

```sh
sudo systemctl status dsh-relay-pilot nginx --no-pager
sudo journalctl -u dsh-relay-pilot -n 80 --no-pager
sudo tail -n 40 /var/log/nginx/dsh-relay-pilot.error.log
sudo -u dshrelay /usr/local/bin/node /opt/dsh-relay-pilot/app/admin.cjs list --state /var/lib/dsh-relay-pilot/registry.json
sudo -u dshrelay /usr/local/bin/node /opt/dsh-relay-pilot/app/admin.cjs usage --state /var/lib/dsh-relay-pilot/registry.json
```

`usage` 是约每 5 秒写出的运行统计快照，重启后重新累计；每日额度以 `daily-quota.json` 的持久账本为准。不要删除账本来处理连接故障。示例 Nginx 访问日志使用不含查询串的 `$uri`；不要改成记录完整请求、Authorization 或 Cookie。分享排障信息前仍需去除凭证与个人内容。

### 授权到期与换电脑

当前 CLI 没有原地续期或换绑命令。先为**新域名**配置 DNS、证书和 Nginx，再签发新邀请，在本机绑定新邀请码，并更新手机地址。旧域名即使授权撤销或过期也不能再次分配；同一邀请码也不能绑定另一把主机密钥。

新增域名时，证书须同时覆盖仍在使用的旧域名和新增域名。可用 `certbot certonly --webroot --cert-name dsh-relay-pilot` 并以多个 `-d` 列出完整域名集合扩展该证书，然后检查并 reload Nginx。一次新增、证书验证和手机验收完成后再撤销旧授权；有效授权已达 5 份时需先安排释放名额。

撤销指定授权（将 `GRANT_ID` 替换为 `list` 返回的实际 id）：

```sh
sudo -u dshrelay /usr/local/bin/node /opt/dsh-relay-pilot/app/admin.cjs revoke \
  --state /var/lib/dsh-relay-pilot/registry.json --id GRANT_ID
```

撤销或到期会断开该授权已有的 HTTP/WS；公网入口失效后，通过本地地址管理主机。临时停用时用设置页「停用中转」或 CLI `stop`；再次开启不重置有效期或额度。

### 备份与升级

云端备份 `registry.json`、`daily-quota.json`、Nginx 配置、systemd 配置及证书续期配置；电脑备份对应状态目录中的 `connection.json` 和 `host-private.pem`，限制访问权限。私钥丢失后原邀请码不能绑定新密钥，需要新授权与新域名。

备份云端一致状态时可先停止 `dsh-relay-pilot`，复制状态后恢复服务，这会短暂中断中转。升级先备份，替换同一版本的一整组 CJS 文件，再重启该中转服务并重复验收；不要重新执行 `init`，不要用旧备份覆盖当前日额度来回补流量。

彻底撤下服务时先停用主机客户端并撤销授权，再停止/禁用 `dsh-relay-pilot`；只移除本服务的 Nginx enabled 链接，`nginx -t` 通过后 reload。如证书或续期钩子已与其他站点共用，应先确认用途。保留受保护的备份，不覆盖其他站点配置。

## 10. 常见问题

| 现象 | 检查顺序 |
| --- | --- |
| 域名解析失败 / `DNS_PROBE_FINISHED_BAD_CONFIG` | 检查 A/AAAA；在同一手机比较 VPN 开/关、Wi-Fi/蜂窝网络，再判断是否云端故障 |
| 公网拒绝连接或超时 | 安全组/防火墙 → `ss -ltnp` → Nginx 状态；`bind() ...:443 failed` 时检查与其他服务的监听冲突 |
| Nginx 502 | broker 是否 active、18180 是否监听、`proxy_pass` 是否一致；先带控制 Host 做回环健康检查 |
| 证书错误 / 激活 `ENROLLMENT_CONNECTION_FAILED` | 两个域名的解析和证书覆盖、证书链、系统时间、出站 443；不使用 `-k` 或禁用 TLS 验证来掩盖问题 |
| `HOST_OFFLINE` | 租户域名已到 broker，但对应电脑未连入；查 CLI/内置状态、电脑联网与授权，不代表 broker 本身宕机 |
| `INVALID_AUTHORIZATION` / 授权失效 | 邀请是否来自这台自建服务、是否到期/撤销；内置方式检查 `DSH_REMOTE_RELAY_ORIGIN` 实际生效 |
| `HOST_ALREADY_BOUND` | 邀请已绑定另一把公钥；找回原状态私钥，或签发新授权和新域名，不能强行换绑 |
| `DOMAIN_ALREADY_ASSIGNED` | 域名曾分配过，即使授权过期也不重用；换新域名并补齐 DNS、证书、Nginx |
| `PILOT_FULL` | 已达 5 份有效授权；用 `list` 核对，撤销确认不再需要的授权 |
| `REGISTRY_BUSY` | 先停止所有注册表写入进程，确认没有写入后再检查遗留 `.lock`；不能在运行中盲删锁 |
| `DAILY_QUOTA_EXCEEDED` / 429 | 今日 5GB 已用完，等北京时间零点；`FILE_TRANSFER_BUSY` 则是全局文件并发满，稍后重试 |
| `QUOTA_STORAGE_UNAVAILABLE` | 查状态目录权限、磁盘空间和账本完整性；存储不可用时会暂停传输，不应删除账本规避 |
| 413 / 大文件失败 | Nginx 示例的请求上限为 20m；确认上传请求大小、网关限制、限速和超时，先用小文件验收 |
| 网页能开但实时输出断续 | 检查 Upgrade/Connection、HTTP/1.1、缓冲/缓存和代理超时；确认控制域名没有经过不兼容的 CDN |
| 401 或会话/文件不可见 | 手机应使用自己的 Remote 凭证；中转邀请不能代替它。DSH 上游不可用则回电脑检查 DSH 与上游登录状态 |

需要协助时提供：代码版本/提交、系统、CLI 或内置方式、脱敏状态、失败阶段与时间，以及同一手机换网络/VPN 的结果。不要提供邀请码、Remote 令牌、主机私钥、Cookie 或模型 API Key。

## 参考与验证范围

- 项目实现：[中转服务与限制](../relay/README.md)、[CLI](../relay/CLIENT.md)、[Nginx 示例](../relay/nginx.conf.example)、[systemd 示例](../relay/dsh-relay-pilot.service.example)。
- 外部配置依据：[Nginx 协议升级代理](https://nginx.org/en/docs/http/websocket.html)、[Certbot webroot 与续期](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)、[Node.js 下载](https://nodejs.org/en/download)。部署工具以实际安装版本为准。
- 本轮运行 `node --test tests/relay.test.js tests/relay-settings.test.js`，23 项通过，0 失败。测试覆盖临时目录与模拟主机，不代表本文整套 Linux/Nginx/证书流程已在新服务器实机跑通；第 8 节是部署者仍需完成的验收。
