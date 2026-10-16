# 独立授权的公网中转试用

rc.2 已接入设置页：每位开发者运行自己的 DSH 和 Remote 网关，在「更多 → 主机与连接 → 云服务器中转」填写个人中转密钥，绑定并开启。插件管理页也有同样入口。客户端随网关运行，无需另外安装运行时、运行脚本或创建计划任务。没有新增 npm 依赖，网关保持单文件形态。旧 rc.1 手机可访问已开通的公网地址；设置入口和主机内置客户端需要 rc.2。

## 连接与凭证

```text
手机（自己的 Remote 令牌）── HTTPS / WebSocket ── 云服务器 Nginx
                                                   │
                                       独立中转 broker（回环监听）
                                                   │
                            主机主动建立的 HTTPS Upgrade 加密连接
                                                   │
                               本机 client ── 127.0.0.1:8787
                                                   │
                                          自己的 Remote / DSH
```

运营者签发限期邀请文件。主机本地产生 Ed25519 私钥，使用邀请码注册公钥，并用服务端随机挑战签名建立连接。服务端只保存邀请码 SHA-256 摘要、公钥、域名和有效期。同一授权只绑定一个公钥；重复激活相同公钥可恢复，其他公钥不能换绑。既有域名不回收给下一位用户，防止残留的浏览器存储或 Service Worker 串用。

中转密钥只授权接入指定入口，不能替代 Remote 的访问令牌，也不提供云服务器 SSH、shell 或任意端口转发。客户端只转发到配置的 HTTP 回环网关。手机仍填写自己的 Remote 访问令牌，中转服务不代填、不持久化该令牌或模型 API Key。

两段 TLS 都在云端终止；这不是端到端加密。运营者在技术上可接触经过的明文。应用和示例 Nginx 日志不记录正文、请求头或查询串，私钥只保留在用户电脑。

## 开发者使用

推荐直接使用 rc.2 设置页。已有访问凭证可读取状态；开通/停用属于主机管理操作，需要主机管理令牌。使用设备密钥连接时，页面会提供仅本次操作使用的管理令牌输入，不在浏览器另存中转密钥或私钥。绑定后输入框立即清空，不自动重试结果未知的开通操作。

独立命令行工具继续保留，见 [CLIENT.md](CLIENT.md)，其运行环境需要 Node.js 22+。Windows/Linux 单文件网关与插件已内置客户端，无需为中转另装 Node。

内置客户端默认状态目录为 `~/.dsh-remote/relay-pilot/integrated`，位于 Remote 文件服务的敏感目录保护范围内。Linux/macOS 使用目录 0700、私钥 0600；Windows 文件 mode 不能代替 ACL，应限制为本用户和 SYSTEM。不要把邀请文件或私钥放进工作区、可共享文件目录、安装包或日志。

对于本轮原有 `owner-preview` 试用目录，设置页提供「接管已有试用连接」：保留原主机私钥和公网地址，在私有目录中复制配置，向旧客户端写入明确停止标记，再启动内置客户端；不杀 DSH/网关进程，也不自动接管。若目标目录已有一次未完成激活留下的密钥，会先在同目录备份再替换。其他自行配置的 CLI 目录仍由原工具管理，不能让两个进程同时使用同一授权。

## 运营者操作

服务端使用 Node.js 22+，只需复制本目录的 CJS 文件。运行账户与系统管理账户分开；本次试用是无登录权限的 `dshrelay`。状态目录必须归运行账户所有，不能开放公网读写。

首次初始化（**不要覆盖已存在的 registry**）：

```sh
node admin.cjs init --state /var/lib/dsh-relay-pilot/registry.json \
  --origin https://relay-pilot.example.com --base-domain example.com
```

先配置租户域名 DNS、HTTPS 证书及 Nginx `server_name`，再签发授权；随机生成的域名不会自动获得 DNS 或证书。首版最多同时存在 5 份有效授权。

```sh
node admin.cjs issue --state /var/lib/dsh-relay-pilot/registry.json \
  --label developer-01 --domain relay-user01.example.com --days 7 \
  --out /var/lib/dsh-relay-pilot/invites/developer-01.json
node admin.cjs list --state /var/lib/dsh-relay-pilot/registry.json
node admin.cjs usage --state /var/lib/dsh-relay-pilot/registry.json
node admin.cjs revoke --state /var/lib/dsh-relay-pilot/registry.json --id GRANT_ID
```

`issue` 不在终端显示原始授权码，拒绝覆盖已有输出文件。从文件中私密交付 `code` 作为该用户的个人中转密钥，用户直接粘贴到设置页；CLI 用户可读取整个邀请文件。激活后删除临时邀请副本。原始邀请文件是敏感材料；注册表的摘要存储不意味着导出的邀请文件也不敏感。撤销和到期会关闭已建立的隧道及 HTTP/WS，默认检查周期 500ms；网络端观察到断开仍受 TCP/Nginx 关闭传播影响。撤销后需要新授权和新域名。

注册表修改使用排他 `.lock` 和原子替换。进程在写入期间被强制终止可能遗留锁；遇到 `REGISTRY_BUSY` 应先确认所有 registry 写入进程已停止，再检查和移除遗留锁，不能在仍有写入时盲删。恢复服务前先检查 JSON 完整性并备份注册表。

## 部署

参考 [dsh-relay-pilot.service.example](dsh-relay-pilot.service.example) 和 [nginx.conf.example](nginx.conf.example)。HTTP 入口只监听 `127.0.0.1`；由 Nginx 提供有效 HTTPS 证书，转发 `Host`、`Upgrade` 和 `Connection`，关闭缓冲、缓存和上游自动重试。无需增加公网端口。

主机隧道使用 HTTPS 的 `Upgrade: dsh-relay-v1`，不是 WebSocket；控制域名应保持直连源站。没有验证之前不要把它接到仅支持 WebSocket 的 CDN。后续若试 EdgeOne，可以先只处理手机访问的租户域名，验证动态请求、WS、长轮询、令牌、禁缓存和禁止写操作自动重试。

Windows 可使用 `run-client.ps1` 隐藏运行；脚本通过系统 Job Object 绑定 Node 子进程，结束包装进程时同时结束连接。它不创建任务、不提高权限、不设置开机启动；任务管理由运营者另行配置。Linux/macOS 可直接运行 `node client.cjs run`，或使用系统进程管理器。

默认限制：

- 每租户最多 32 个活跃 HTTP/WS、8 个等待请求、8 条备用工作连接；服务监听器最多 256 个连接。每个长连也占用连接额度。
- 文件接口 `/fs` 和 `/fs/*` 全局最多同时 2 个请求，每个请求上传和下载分别限为 100 KiB/s，防止文件占满 5 Mbps 出口。超过并发限制返回 429；普通 RPC 和 WS 不经过此限速器。文件接口扩展路径时必须同步这条匹配规则。
- 单次工作连接只处理一个请求，按流背压传输，不重放失败的写操作。断线自动重连，有上限的退避；重连不等于重新提交操作。
- 每位用户（按独立中转授权）每日上传与下载合计 **5,000,000,000 字节（5GB）**，以云服务器时间的北京时间零点重置。云端在转发前记账，计入隧道内 HTTP 头/正文和所有 WS 帧；不计 TLS、TCP 和控制握手开销，不等于云厂商账单流量。用完返回 `429 DAILY_QUOTA_EXCEEDED`，关闭该用户正在传输的 HTTP/WS，不影响其他用户；控制连接保持在线，零点自动恢复接入。
- `daily-quota.json` 使用原子替换和 fsync，提前持久化每用户最多 64KiB 的共享额度预留，避免每个小帧都同步写盘。服务正常关闭会结算实际用量；异常退出可能保守多计不足 64KiB，不能通过重连/重装/重启回补已用额度。最后一个超过余额的数据块会被拒绝并耗尽剩余额度；未转发的该块尾部也会保守计入，最多一个传输块。损坏或无法写入记账文件时暂停传输，不退回无限额。历史记账文件须备份；删除文件属于运营管理重置，不能交由用户操作。
- 设置页通过已认证的控制通道读取额度，通常最多延迟 20 秒；超额事件立即通知，前端不负责扣减或修改额度。失效或用完后要通过本地地址管理主机；公网的限额错误仍返回重置时间和额度摘要。
- `usage.json` 继续提供进程内 HTTP 正文字节/WS 字节快照，每 5 秒更新，重启后重新累计；日额度以上述独立持久账本为准。没有支付功能，不作为收费计量系统。
- 注册入口限制每来源地址每分钟 20 次；当前 Nginx 回环代理使该额度由本试点共同使用，不能宣称为真实用户 IP 限流。

本轮仅面向少数可信开发者。独立子域提供同源存储隔离，但不隔离父域 Cookie 等同站行为；对不可信公众开放前，应使用独立于运营者其他业务的注册域名，并单独做 Cookie、浏览器权限与滥用防护评审。

## 部署、停用与回退

控制域名、租户入口、授权有效期、服务器路径、证书配置和备份位置由运营者私下维护，不放入公共源码。示例配置使用 `example.com` 占位域名，部署时应替换并完成域名、HTTPS、权限和授权隔离检查。

停用内置中转时，在主机的中转设置中操作；不要同时运行使用同一授权的旧 CLI 或计划任务。回退插件前先停用内置连接，保留仅自己可读的状态和配置备份，再按目标版本的安装说明处理。

云端撤回试用时，先撤销对应授权，再按部署清单停用专属服务、移除该服务的 Nginx enabled 链接，经 `nginx -t` 通过后 reload。保留私有状态以便审计；不要用旧备份覆盖整套 Nginx，也不要影响其他服务。

## 验证与文件范围

```sh
node --test tests/relay.test.js
npm run check
```

21 项中转/设置测试使用临时 HOME/USERPROFILE/目录、模拟网关和内置 Node 测试组件，覆盖摘要存储、并发兑换、密钥绑定、签名重放拒绝、租户隔离、原网关鉴权、HTTP/WS、限速、撤销/到期、重连、TLS 验证、停止、日额度持久化/跨日重置、磁盘失败闭锁、HTTP/WS 超额、单文件网关开通/恢复、管理权限、切主机竞态、不自动重试和旧试用接管（同一密钥、原地址、旧客户端正常退出）。TLS fixture 及其公开私钥仅用于测试，不能部署。

本功能源码：`registry.cjs`、`wire.cjs`、`broker.cjs`、`quota.cjs`、`client.cjs`、`host.cjs`、`options.cjs`、`admin.cjs`、`run-client.ps1`；服务/Nginx 示例与文档；`tests/relay.test.js`、`tests/relay-settings.test.js` 与两个测试 PEM。设置 UI 为根 `public/relay-settings.js` 和 `.css`，由手机/桌面/管理页共用；网关与插件增加设置 API，`scripts/embed-relay.mjs` 将主机客户端嵌入网关，`sync-plugin` 自动生成和同步。没有把真实邀请、私钥或用户数据打包。rc.2 本地产物见 [候选版说明](../docs/rc-0.8.0.md)，未提交或公开发布。
