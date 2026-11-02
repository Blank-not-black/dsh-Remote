# 缓存升级与 Android 中转设备补齐

2026-11-02。开发发布元数据保持 0.8.3；本地候选为 0.8.4-rc.9 / Android 8025。用户选择暂不处理鸿蒙，浏览器明确显示暂不支持配对加密入口。

## 改动范围

- `scripts/prepare-diagnostics-build.mjs`：HTML 构建标识、JS/CSS 内容版本参数，反复同步结果收敛；管理页 `/admin/ui` 的相对资源路径也覆盖。
- `gateway.js`：界面资源按实际内容计算 ETag；不再单凭时间戳返回 304，`build.json` 禁缓存。测试覆盖同长度、同时间戳而内容变化。
- `public/cache-upgrade.js`、`public/history.js`、手机/桌面入口：检测新界面，忙碌或有未处理输入时提示；空闲时单次重载防循环。旧历史按连接身份迁移，已有新缓存优先，写入失败保留原数据，不清令牌/服务器/主题。
- `MainActivity.java`：加载新构建前只清 WebView 资源缓存。模拟器覆盖升级，访问令牌、服务器列表和持久测试值摘要一致。
- `relay/e2ee-devices.cjs`、host/client/broker/registry/endpoint：独立设备内外层凭据、只存摘要、7/14/30 天有效期、撤销和主机证书更换；主机验权独立于云端路由。
- `relay/gateway-sockets.cjs`、网关管理 API：识别真实中转 TCP 来源，本地管理要求回环、本地 Host/Origin、管理令牌。伪造 Host 不能越过限制。明确的主机环境禁用策略不能被界面临时覆盖。
- `public/relay-devices.js`、`E2eeBridge.java`、`E2eeProxy.java`：本地创建设备并单次导出配对；Android 保存独立设备凭据、检查到期、经已验证通道发送，界面继续默认开启、关闭必确认、失败不降级。
- `EncryptedDownloads.java`：Android 10+ App 内下载，经当前配对路由写入系统 Downloads；完整后发布，拒绝重定向，撤销/失败清残片，中断恢复只清未发布文件。已完成文件保留。
- 根 `public/` 已同步到插件；历史生成副本 `packages/plugin/public/app.js`、`index.html` 不提交。

## 验证

- 最终 `npm run check`：1232 项，1212 通过、20 跳过、0 失败；设备 CRUD/重启/权限、租户隔离、共享旧路由拒绝、撤销已有 WS、HTTP/图片/WS 明文不可见与篡改失败、缓存升级回归。
- Android 16 模拟器真实 APK 与系统 Instrumentation：原生 TLS v2、加密下载 SHA-256、关闭确认、关闭后仅 HTTPS、重新开启、中途撤销失败、残片清理、已完成文件保留。使用临时 broker/凭据和公开测试 CA，仅在测试进程信任；无模型调用。
- 实际 Desktop RC9 的 208 个归档文件核对；8 个其他插件和配置、原访问凭据/中转绑定保持不变；网关、上游和认证 mux/host 核验。
- 本地材料：`dist/completion-worktree/dist/` 下的门禁日志、Android 探针与截图；`dist/completion-rc-build/dist/artifacts/` 下的 tgz；`dist/local-install-0.8.4-rc.9-20261102/` 下的安装备份和核验报告。以上路径相对主仓库。

Windows 的既有插件事务测试曾出现并发文件锁/工作进程中断，未改测试来跳过；构建结束后独立运行全量门禁再核验。

## 云端待确认的具体部署范围

只读检查：现有 `dsh-relay-pilot` 为旧实现，应用目录 `/opt/dsh-relay-pilot/app`，状态目录 `/var/lib/dsh-relay-pilot`，回环入口 18180。Nginx 已透传任意 Upgrade，无需新增端口或改站点配置。

候选包为 `dist/completion-worktree/dist/cloud-e2ee-candidate/relay-candidate.tar.gz`，18 份 CJS，清单与 SHA-256 同目录。归档 SHA-256：`5e39dec041eec210d2d89b2fada86a5e4badaf7357e149c8992f2bcc0f6974df`。

确认部署后按此顺序执行：

1. 复核线上 broker/registry 和服务配置未发生变化；上传至临时路径，核对归档及逐文件摘要。
2. 在同一 `/opt/dsh-relay-pilot` 下复制现有 app 为候选目录，保留赞助静态页面，仅覆盖上述 CJS；逐文件 `node --check`，检查 Nginx 配置。
3. 停止该中转服务，等待正常结算流量；在私有备份目录保存 app、服务配置和当前状态，不输出凭据或付款资料。
4. 切换 app 目录，启动同一服务。所有中转连接会短暂中断并重连；不修改授权、额度、付款/审核配置，不新增权限或公网端口，不发布版本。
5. 核验服务、HTTPS 健康、赞助公开页/未认证管理拒绝、原主机旧模式恢复。仅为用户当前主机明确启用加密，创建模拟器独立配对，验证真实公网证书/内层 pin、请求和撤销；其他主机保留原模式。
6. 失败则停服务、恢复上一份 app 并重启。保留当前流量/审核状态，**不以旧状态备份覆盖账本来回补额度**。用户当前主机迁移失败时明确恢复先前配置，不自动让开启加密的客户端降级。

线上更新尚未执行，不将隔离测试描述为生产验收。物理手机切网/熄屏、鸿蒙和独立安全审计仍未验收。
