# AGENTS.md — dsh-remote 开发指南

DSH（DeepSeek Harness）手机远程控制台：DSH 插件（内置网关自启停）+ 独立单文件网关 + Android App（Capacitor）+ WebUI（零构建纯 JS）。

## 硬性约束（违反即返工）

1. **零新增依赖**：测试只用 Node 内置 `node:test` + `fetch`；前端校验用浏览器原生 `crypto.subtle`；Android 只用系统 API。**不引第三方库**（含 npm 运行时依赖、CDN 脚本）
2. **不改变发布形态**：单文件网关（gateway.js/gateway.cjs）、零构建纯 JS 前端
3. **历史遗留文件不要动、不要提交**：`packages/plugin/public/app.js`、`packages/plugin/public/index.html`（它们是同步产物副本，修改一律改根 `public/` 后跑同步）
4. **改动一律不提交**：攒到 release 时由 `npm run release` 的 `git add -A` 统一提交（用户流程惯例）。除非用户明确要求单独提交
5. **gateway.js 改动必须同步**：`cp gateway.js packages/plugin/gateway.cjs`（或跑 `npm run sync-plugin`——它含自动复制），否则插件包运行旧代码
6. **测试隔离铁律**：不碰真实 `~/.dsh-remote`；子进程测试用 HOME/USERPROFILE/`DSH_REMOTE_FS_ROOT` 指临时目录、清代理变量、固定 TOKEN、mkdtemp + rmSync + kill
7. **宣传口径**：README 禁用"原生 App"字样；不提"唯一/首创"；不点名贬低竞品

## 架构速览

- `gateway.js`：单文件网关（Node，默认 `0.0.0.0:8787`，CJS 零依赖）。静态托管 `public/` + `/api/*` 代理到 DSH + WS 透传 + `/fs/*` 文件传输（Bearer token 鉴权，路径穿越拒绝）
- `packages/plugin/index.mjs`：DSH 插件入口。`inject ['webServer','commands','agents']`，在 DSH web httpServer 挂 `/remote` 前缀路由；内置网关自启停（systemd-run 优先，回退 detached spawn）；**网关端口**：`DSH_REMOTE_GATEWAY_PORT` env > `~/.dsh-remote/gateway-port` 文件 > 8787（插件管理页可改）；spawn 前 `net.connect` 端口占用预检
- `public/`：Web UI 三端——`index.html`（手机端/App 同源）、`desktop/desktop.html`（桌面端）、`admin.html`（管理页）；`md.js` 是零依赖 Markdown 渲染器（先 esc 再转标记，XSS 安全）；i18n 用 `i18n.js`
- `android/`：Capacitor 壳。`MainActivity` 的 `BackgroundBridge`（@JavascriptInterface）暴露原生能力（含 `startPeakReminder/stopPeakReminder`）；`RemotePollService`（后台轮询前台服务）、`PeakReminderService`（峰谷提醒前台服务，30s 检查 9/12/14/18 点）
- 实时通道：客户端 WS 双流（mux/host）遵守 DSH downlink-only 协议，不发送应用层心跳；网关每个通道只维护一条上游 collector，并向已认证客户端广播下行帧，连接新加入时重放 session 基线和仍待处理请求。客户端接入网关本地 WS，网关两侧各发送 RFC6455 Ping（默认 30s）并等待 Pong（默认 90s，VPN 友好），仅在控制帧无响应时清理连接。前端按通道 generation 防旧连接竞态，指数退避重连（1.5s 起步、60s 上限 +20% 抖动）→ 单通道连续失败 3 次降级轮询（4s 拉 `/api/events.poll`，30s 试恢复 WS）
- 健康检查：`/health` 返回 `{ok, version, pid, upstream, upstreamProbe, upstreamOk, upstreamReachable, upstreamStatus, events, runtime}`；默认探测 DSH 根路径 `/`，探测失败只显示 degraded，不触发插件重启。插件仅在网关版本或 DSH 上游地址变化时重启，避免 VPN/DSH 短暂不可达造成重启风暴。WebSocket 默认使用短时 `/api/ws-ticket`，旧网关不可用时前端才回退 token 握手；CORS 默认只放行同源、Capacitor/localhost 和 `DSH_REMOTE_CORS_ORIGINS`
- 斜杠命令：客户端 `/xxx` → 网关 `/remote/api/command` → 插件 `ctx.commands.execute(agent, line, signal)`（DSH api-proxy 白名单**没有** commands.*，只能插件内执行）；返回 executed:false 回退当文本

## 开发流程（用户主导的协作管线）

用户会给一份**自包含提示词**（含背景、硬约束、精确落点、验收清单），你按提示词改代码并自测。流程：提示词 → 编程 → 本地 rc → 门禁（测试全绿 + 人工验证）→ 发布 → Gitee 同步。

- 你的职责：**改代码、跑测试、构建 rc 产物**。不部署、不问运行方式、不提交
- 提示词里要求"改完不提交"时，绝对不要 `git commit`
- 改 `public/` 后跑 `npm run sync-plugin` 同步插件包；改 gateway.js 同样靠它同步 gateway.cjs
- 完成报告要含：改动文件清单、验证结果、未提交状态说明（不要只报"完成了"）

## 测试与检查

```bash
npm run check   # node --check 全部 JS + node --test tests/*.test.js，当前 20/20
```

改任何 JS 前先看对应测试（tests/gateway.test.js 覆盖网关鉴权/路径穿越/上传/WS idle 等）。

## 已知坑（实测踩过）

1. **pnpm 装插件包**：`pnpm add "file:...tgz"` 前必须 `pnpm remove dsh-remote-plugin`（lock 引用旧 tgz 报 ENOENT）
2. **本地网关是 transient systemd 服务**（systemd-run 拉起）：`systemctl --user restart dsh-remote-gateway.service` 会报 not found；正确做法：`pgrep -f "node .../dsh-remote-plugin/gateway.cjs"` 拿精确 PID 后 `kill`，再 `systemctl --user restart dsh-web`（插件自愈拉起）。**不要用 `pkill -f`**（会匹配到命令自身）
3. **npm registry 慢**：用 `npm_config_registry=https://registry.npmmirror.com`
4. **pnpm minimumReleaseAge**：当天发布的新包安装被拒时，检查 profile 的 `pnpm-workspace.yaml` 有 `minimumReleaseAge: 0`
5. **页面黑屏/功能不见 = 浏览器缓存**：升级后强刷（Ctrl+Shift+R）
6. **DSH 侧探测端点**：网关默认探测 `/` 判断可达性，可用 `DSH_HEALTH_PATH` 覆盖；不能把某个不存在的健康路径当作插件重启条件
7. **session.prompt payload**：必须 `{ sessionId, mode: 'queue', content: [{type:'text', text}] }`——旧 `{sessionId, text}` 格式报 `invalid payload for session.prompt`
8. **goal phase 枚举**：`active|paused|blocked|complete`（'completed' 是事件类型不是 phase；blocked 必须显示）

## 发布流程（用户/CI 侧执行，你一般只负责构建产物）

`npm run release <版本号>`：bump → build-app → publish → `git add -A` commit → push → tag → CI（构建 APK + 双平台二进制 → SHA256SUMS → GitHub Release → npm → 独立仓库）。

**发布前置**（用户会要求你做的部分）：
- 更新 `package.json` 的 `updateNotes`（用户可见更新说明，release 会写进 update.json 的 notes/history）
- rc 版本：bump 三处（package.json / public/version.json / packages/plugin/package.json）+ update.json，构建 APK（`npm run build-app`）+ `npm run publish`
- Gitee 同步在发布后本地跑（`scripts/sync-gitee-release.sh` + `sync-gitee-code.sh`，需 GITEE_TOKEN）；**Gitee 附件配额 1GB**（约 6 个版本满）——上传 400 报错时先删旧 release（API 按数字 id 删，保留最近 2 个）

## 版本策略

- 0.x 阶段高频发版正常；**每次迭代先 rc 版本真机验证，全过才发正式版**
- rc 版本号要有信息量（0.6.5-rc.1、rc.2…），正式版 0.6.5
