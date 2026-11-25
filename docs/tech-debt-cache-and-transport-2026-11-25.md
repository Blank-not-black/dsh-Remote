# 缓存与网络传输技术债审计及重构方案

日期：2026-11-25。状态：方案待评审，尚未实施；本文不含代码改动。`gateway.js` 本轮明确不纳入。

审计基线：`dev` 分支 `89ca1d6`（`package.json` 0.9.0）。主工作区已有的未跟踪目录（`.acl-repair/`、`.codegraph/` 等）不属于本次审计范围，也未改动。

结论先行：欠债是结构性的，不是几个孤立 bug。两套手写客户端、四套缓存实现、约 100 处裸 `fetch`、两份已分叉的流状态机，导致同一个连接或缓存问题通常要修两遍，而且两端已经出现行为差异。建议分两个阶段做，先缓存、后传输；网关单文件本轮保持现状。

本文所有数字是对当前源码的静态统计，不是运行时测量；未做性能剖析，因此不承诺具体毫秒收益。

## 1. 范围、基线与方法

### 1.1 范围

| 类别 | 本轮纳入 | 说明 |
| --- | --- | --- |
| 移动端 WebUI | 是 | `public/app.js` 及其共享模块 |
| 桌面端 WebUI | 是 | `public/desktop/desktop.js` 及其共享模块 |
| 缓存层 | 是 | 会话列表、历史、图片、公告、旧缓存迁移 |
| HTTP/WS 传输层 | 是 | 请求封装、鉴权头、超时、错误映射、WS/轮询状态机 |
| 测试与文档 | 是 | 新增模块测试、回归测试改造、使用说明 |
| `gateway.js` | 否 | 单文件发布形态，本轮不改；只记录后续边界建议 |
| Android / HarmonyOS 原生 | 否 | 只做兼容性验证，不做原生重构 |
| relay / E2EE 云端协议 | 否 | 只保留现有行为契约 |

### 1.2 基线说明

- 审计开始时工作区 `dev` 无已跟踪文件改动；存在多项未跟踪的本地辅助目录。
- 全量 `npm run check` 未能在当前会话完成：`node --test` 需要派生测试进程，当前沙箱拒绝带管道的子进程（`spawn EPERM`）。纯 JS 用例可用 `node --test --experimental-test-isolation=none` 运行；含子进程的网关测试需要在沙箱外或授权后执行。这不是测试失败，但意味着动代码前必须补一次完整基线门禁。

### 1.3 方法

- 统计行数、文件字符数、顶层 `function` 声明数量。
- 用临时脚本提取两端同名顶层函数，空白归一化后比较：相同、不同、仅一端存在。
- 文本统计 `fetch(`、`localStorage`、测试中的 `indexOf(` / `slice(`。
- 抽样阅读启动、缓存、WS、轮询、E2EE 传输代码路径。

限制：函数计数不包含箭头函数、对象方法、IIFE 内部函数；行号会随改动漂移；未测量真实首屏、弱网 RTT、缓存写入耗时。本文把“代码路径推断”和“实测”分开写。

## 2. 现状与证据

### 2.1 两套客户端

| 指标 | 移动端 | 桌面端 | 说明 |
| --- | --- | --- | --- |
| 主文件 | [public/app.js](../public/app.js) 9,932 行 / 476K 字符 | [public/desktop/desktop.js](../public/desktop/desktop.js) 5,116 行 / 263K 字符 | 均为零构建全局脚本 |
| 顶层函数 | 566 | 342 | 同名 287 个 |
| 同名且逐字相同 | — | — | 133 个 |
| 同名但已分叉 | — | — | **154 个** |
| 首屏脚本 | [public/index.html](../public/index.html) 57 个 `<script>` | [public/desktop/desktop.html](../public/desktop/desktop.html) 50 个 | 多数同步加载 |

关键函数分叉示例：

| 函数 | 移动端 | 桌面端 | 差异要点 |
| --- | --- | --- | --- |
| `rpc` | [public/app.js:622](../public/app.js#L622) | [public/desktop/desktop.js:755](../public/desktop/desktop.js#L755) | 客户端标识：移动端按原生/网页切换 `app`/`web`，桌面端固定 `web` |
| `openStream` | [public/app.js:1711](../public/app.js#L1711) | [public/desktop/desktop.js:1377](../public/desktop/desktop.js#L1377) | 函数体 5,441 / 5,114 字符，重连与降级细节已不同 |
| `pollKind` | [public/app.js:1877](../public/app.js#L1877) | [public/desktop/desktop.js:1526](../public/desktop/desktop.js#L1526) | 3,270 / 2,416 字符，重置与原生通知处理不同 |
| `refreshSessions` | [public/app.js:2260](../public/app.js#L2260) | [public/desktop/desktop.js:2014](../public/desktop/desktop.js#L2014) | 会话缓存键、工作台刷新与桌面专用渲染不同 |
| `restoreCachedHistory` | [public/app.js:3333](../public/app.js#L3333) | [public/desktop/desktop.js:2280](../public/desktop/desktop.js#L2280) | 当前逐字相同（各 1,185 字符），但仍是两份副本 |

影响：

1. 连接、重连、缓存、鉴权问题通常要改两遍；改一端不会自动同步另一端。
2. 154 个函数已经分叉，说明“先复制后修改”的模式在持续制造隐性差异。
3. 测试也分两套：49 个测试文件读移动端源码，38 个读桌面端源码；94 个测试出现 `indexOf` 源码索引，其中约 77 个明显用索引/切片抽函数，进一步固化重复。
4. 部分共享已经存在（`history.js`、`image-cache.js`、`network.js` 等），证明“共享模块 + 两端薄壳”可行；真正缺的是缓存门面与传输门面。

### 2.2 缓存层

当前至少有四套缓存实现：

| 数据 | 实现 | 键 / 库 | 容量与回收 | 备注 |
| --- | --- | --- | --- | --- |
| 会话列表 | 移动端 `LS` + `cacheRead/cacheWrite` | `sessionsCacheV2:<scope>` | 最多 80 条；无过期、无总量 | [public/app.js:2287](../public/app.js#L2287) |
| 会话列表 | 桌面端 `LS` | `historyCacheV2:<scope>:sessions` | 最多 80 条 | [public/desktop/desktop.js:2029](../public/desktop/desktop.js#L2029) |
| 会话历史 | [public/history.js](../public/history.js) | IndexedDB `dshRemoteHistoryV1`，键 `<scope>:session:<id>`；localStorage 回退 | 每次最多 750,000 字符；每个 scope 最多 10 条；1.5 秒超时 | 无跨 scope 总量；旧格式用 Worker 解码 |
| 图片 | [public/image-cache.js](../public/image-cache.js) | IndexedDB `dshRemoteImagesV1`，键 `[scope, id]` | 200MB / 500 条 / 30 天，按 `accessedAt` 淘汰 | 另一套 `open/transaction` 实现 |
| 公告 | 移动端内联函数 | `seenAnnouncementsV1`、`announcementHistoryV1`、`announcementVotesV1` | 未设容量；失败回退 sessionStorage / 内存 | [public/app.js:6577](../public/app.js#L6577) |
| 工作台与偏好 | 移动端/桌面端 `LS` | `workbenchOrderV1`（内部按 server 分 scope）、`groupDrawerHiddenShortcutsV1` 等 | 不回收 | 属于设置，不应被缓存清理误删 |

已确认的问题：

**C1 会话列表缓存键两端不一致。** 移动端写 `sessionsCacheV2:<scope>`，桌面端写 `historyCacheV2:<scope>:sessions`。两端通常同 origin，localStorage 共享，但键不同，导致一端写入的会话列表另一端读不到。这是现成的不一致，不是理论风险。

**C2 “缓存优先”并没有优先。** `boot()` 的顺序是：`await loadLocalVersion()` → `await selectFastestServer()` → `await maybeWarnAppBehindGateway()` → `openStreams()` → `refreshAll()`；会话缓存直到 `refreshSessions()` 开头才恢复（[public/app.js:2261](../public/app.js#L2261)、[public/app.js:3295](../public/app.js#L3295)）。也就是说，有缓存时首屏仍要等版本请求和测速；多主机或弱网冷启动时，首页可能空等数秒。历史缓存的顺序反而是对的：`openSession` 先 `restoreCachedHistory()` 再请求（[public/app.js:3001](../public/app.js#L3001)）。

**C3 缓存没有跨连接总量控制。** 历史缓存按 scope 各自累积，每个 scope 最多 10 条 × 750K 字符；图片另算 200MB；旧 scope 不主动回收。多个连接长期使用后，localStorage 配额可能被历史缓存占满，而公告已读、填写标记等小数据也需要同一配额。`docs/next-version-cache-cleanup.md` 中的“跨连接总量控制/自动回收”仍未落地。

**C4 旧缓存迁移仍在主线程解析。** `migrateLegacy` 扫描最多 100 个 localStorage 键；只有大于 250KB 才用 Worker（[public/history.js:268](../public/history.js#L268)）。低端 Android WebView 升级后首次启动，可能在主线程 `JSON.parse` 中等键值并卡顿。

**C5 缓存实现重复。** `history.js` 与 `image-cache.js` 各自实现 IndexedDB 打开、事务、1.5 秒超时、`onblocked/onerror` 回退；`cache-upgrade.js` 再负责迁移时机；app.js/desktop.js 各自维护会话列表缓存。超时、配额、清理责任分散在四个文件。

### 2.3 传输层

| 指标 | 现状 |
| --- | --- |
| 裸 `fetch(` | 28 个文件、100 处（app.js 35、desktop.js 20、admin.js 12，其余分散在 relay/fs/update/diagnostics 等） |
| 鉴权头 | `authorization: 'Bearer ' + token`、`x-dsh-remote-client: app/web`、`x-dsh-remote-client-id`、fs/admin 专用头等多套拼法 |
| 超时 | 3.5s 探测、6.5s 健康、8s ticket、15s respond/relay、45s 默认 RPC、90s 弱网历史、25s 长轮询等，分散在各调用点 |
| 弱网 profile | 只覆盖历史分页/读取与轮询；普通 RPC、文件、更新、公告不读 `DshNetwork.profile()` |
| 错误映射 | `rpc` 内统一映射 401/HTTP/业务错误；其他调用点各自判断，部分不处理 401 |
| 流状态机 | `openStream`/`pollKind`/`enterPollMode`/`tryRestoreWs` 内嵌在 app.js，桌面端另有副本且已分叉 |
| 原生 E2EE | [public/e2ee-transport.js](../public/e2ee-transport.js) 覆写全局 `fetch`、`WebSocket`、`XMLHttpRequest`（[108](../public/e2ee-transport.js#L108) 行起），把配对地址映射到本机代理 |

传输层的隐式契约：

1. `DshE2eeTransport` 在脚本加载时替换全局 `fetch/WebSocket`。新的传输模块必须在**调用时**取全局 `fetch`/`WebSocket`，不能在模块初始化时缓存原始引用，否则 Android 配对/加密链路会绕过映射。
2. WS 是 downlink-only，不发应用层心跳；网关负责 RFC6455 Ping/Pong。状态机不能引入应用层 ping。
3. 每个通道用 generation 隔离旧连接；轮询降级后仍保留 WS 试恢复。
4. 写操作没有自动重试语义；`DshOperations` 的受理回执与 `rpc` 的普通请求不能混为一谈。
5. 轮询重置依赖 `epoch`、`truncated`、`latestSeq < since` 三个条件（[public/app.js:1909](../public/app.js#L1909)），不能为了简化而删条件。

**N1 没有统一 HTTP 入口。** 100 处 `fetch` 各自拼头、超时、错误处理；新增鉴权头、代理头、诊断埋点要全量搜索。

**N2 超时与错误语义漂移。** 同一个网关在不同调用点可能得到不同超时；401 在 `rpc` 中变成 `AUTH`，在文件/管理/更新路径中各有各的处理。弱网用户只能获得部分请求的宽容。

**N3 流状态机两份。** 断线退避、3 次失败降级、`tryRestoreWs`、前后台恢复、网络类型变化、多主机切换都在 app.js/desktop.js 各写一遍，且已经分叉。任何实时链路修复都要双端验证。

**N4 启动链有无超时 await。** `loadLocalVersion()` 的 `fetch('version.json')` 没有 `signal`（[public/app.js:6562](../public/app.js#L6562)），却位于 `boot()` 的第一个 await；网络停顿时可能拖住后续启动。

**N5 弱网策略只覆盖一部分。** `network.js` 的 `profile()` 提供 `readTimeout/historyPageSize/pingTimeout/pollTimeout`，但普通 RPC 默认仍是 45s，文件上传/下载、公告、更新各有固定值。弱网模式给用户的承诺与实现范围不一致。

**N6 E2EE 覆写是隐式契约。** 传输重构如果直接捕获 `window.fetch`，或在模块顶层缓存 `WebSocket`，会绕过原生映射；必须把“动态取全局”写成测试。

**N7 网关静态资源每次请求读文件算哈希（本轮不改）。** `serveStatic` 对 `.html/.js/.css` 先整文件读入再算 SHA-256 作为 ETag（[gateway.js:5776](../gateway.js#L5776)），没有进程内内容哈希缓存。手机一次冷启动要请求 50+ 个脚本，属于可优化项，但和本轮客户端重构分开。

### 2.4 测试、同步与硬约束

| 项目 | 现状 |
| --- | --- |
| 测试文件 | 173 个 |
| 读 `public/app.js` 源码 | 49 个 |
| 读 `public/desktop/desktop.js` 源码 | 38 个 |
| 用 `indexOf` 索引源码的测试 | 94 个（其中约 77 个明显用索引/切片抽函数，启发式统计） |
| 会派生外部进程 | 37 个（网关/插件/构建类） |
| 生成副本 | `packages/plugin/public/*`、`packages/plugin/gateway.cjs`，由 [scripts/sync-plugin.mjs](../scripts/sync-plugin.mjs) 复制 |
| 同步清单 | 硬编码文件列表，新增共享 JS 必须同时改列表、两处 HTML、测试 |

硬约束：零新增依赖、前端零构建、单文件网关、不改历史生成副本、不碰真实 `~/.dsh-remote`。这些约束决定了重构必须是“拆共享模块 + 两端薄壳”，不能引入打包器或第三方依赖。

### 2.5 优先级汇总

| ID | 级别 | 问题 | 影响 | 处理阶段 |
| --- | --- | --- | --- | --- |
| C1 | P1 | 会话列表缓存键两端不一致 | 两端读不到对方写入的列表 | 阶段 1 |
| C2 | P1 | 首屏被版本请求/测速 awaited | 弱网、多主机冷启动空等 | 阶段 1 |
| C3 | P1 | 无跨连接缓存总量 | 配额可能被历史占满，影响公告等写入 | 阶段 1 |
| C4 | P2 | 旧缓存迁移在主线程解析 | 低端机升级首启卡顿 | 阶段 1 |
| C5 | P2 | 四套缓存实现重复 | 超时/配额/清理改四处 | 阶段 1 |
| N1 | P1 | 100 处裸 `fetch` | 鉴权/超时/诊断改动要全量搜 | 阶段 2 |
| N2 | P1 | 超时与错误语义漂移 | 弱网体验不一致，401 处理不统一 | 阶段 2 |
| N3 | P1 | 流状态机两份且已分叉 | 实时链路修复要双端做 | 阶段 2 |
| N4 | P1 | 启动链有无超时 await | 网络停顿可能拖住启动 | 阶段 1（小修） |
| N5 | P2 | 弱网 profile 覆盖不全 | 用户预期与实现不一致 | 阶段 2 |
| N6 | P2 | E2EE 全局覆写是隐式契约 | 传输重构容易绕过映射 | 阶段 2（约束） |
| N7 | P2 | 网关静态资源每请求读盘算哈希 | 冷启动 CPU/IO 可优化 | 本轮不做 |

级别定义：P1 = 用户可感的一致性问题/延迟，或明显回归风险；P2 = 维护成本、性能优化、约束记录。没有 P0（数据丢失/安全）项。

建议的最小起步批次（已确认）：**C1 + C2 + N4** 一起做——统一会话列表键、启动缓存优先、给 `version.json` 请求加超时。一个分支 3–4 个提交，不动历史/图片存储与流状态机，风险最低；验收通过后再做 C3/C5 和阶段 2。历史缓存容量（D2）放到阶段 1 的后续批次。

## 3. 目标与非目标

### 3.1 目标

| 编号 | 目标 |
| --- | --- |
| G1 | 有缓存时先渲染：离线/弱网冷启动不等待网络请求就能看到上次会话列表与可读历史 |
| G2 | 一套缓存门面：会话列表、历史、图片、迁移、统计、清理共用 scope、超时、回退与容量策略 |
| G3 | 总量可控：为可重建缓存设跨连接上限，优先回收最久未用数据，绝不动连接凭据、设置、公告已读/填写标记 |
| G4 | 一套 HTTP 传输入口：鉴权头、超时、错误分类、诊断埋点、弱网策略集中管理 |
| G5 | 一套流控制器：WS 连接、ticket、退避、轮询降级、恢复在移动端与桌面端共用 |
| G6 | 行为可验证：新增模块有行为测试；被搬迁函数的现有测试同步改造，不靠源码文本偶然通过 |

### 3.2 非目标

- 不拆 `gateway.js`，不引入网关构建步骤，不改变单文件发布形态。
- 不改变 DSH 上游协议、WS downlink-only 语义、E2EE 映射协议。
- 不重做 UI，不新增产品功能，不调整主题/导航。
- 不承诺尚未测量的性能数字；本方案只定义可验证的行为。
- 不清理历史文档中的旧版本号或旧验收记录。

## 4. 阶段 1：缓存层收敛

### 4.1 设计原则

1. **可重建数据才可回收。** 历史、图片、会话列表可回收；服务器列表、令牌、分组、主题、公告已读/填写标记不可回收。
2. **连接身份隔离。** scope 继续用 `SHA-256(JSON.stringify([server || origin, token]))`，不把 A 主机的缓存显示给 B 主机。
3. **读旧写新。** 新键先写成功，再删旧键；迁移失败保留旧数据，不能把“没迁移”当成“已迁移”。
4. **超时与回退。** IndexedDB 不可用、超时、被其他标签页阻塞时，回退 localStorage；再失败回退内存，并记录不含正文的诊断。
5. **首屏不等网络。** 缓存恢复是同步/短异步路径，位于任何网络 await 之前。

### 4.2 目标结构

新增 `public/cache-store.js`（零依赖，全局 `DshCacheStore`），只做基础设施，不包含业务渲染：

```text
DshCacheStore
  scopeFor(server, token)                 // 与现有 SHA-256 口径一致
  openDatabase(name, version, upgrade)    // 统一 1.5s 超时/onblocked/versionchange
  withStore(db, store, mode, action, fallback, timeoutMs)
  local.get(key, fallback) / set / delete // 统一 quota 失败诊断
  stats(kinds) / clear(kind, scope)       // 统一统计与清理
  migrate({ scopes, idle, signal })       // 分片迁移，单键失败不影响其他键
```

键登记表（第一版，不改变历史缓存现有键，避免无谓迁移）：

| 数据 | 键 / 库 | 归属 |
| --- | --- | --- |
| 连接凭据/服务器/分组 | `token`、`servers`、`servers-v2`、`activeServer` | 设置，不归缓存门面管理 |
| 会话列表 | `sessionsCacheV2:<scope>` | 规范键；读取时同时接受 `sessionsCacheV2:<scope>` 与桌面端旧键 `historyCacheV2:<scope>:sessions` |
| 历史 | `dshRemoteHistoryV1`，键 `<scope>:session:<id>` + localStorage 回退 | 保持现状，交给门面统一超时/统计 |
| 图片 | `dshRemoteImagesV1`，键 `[scope, id]` | 保持现状 schema，交给门面统一打开/事务 |
| 公告 | `seenAnnouncementsV1` 等 | 保留在 app.js，但走门面的 `local` 包装 |
| 工作台/偏好 | `workbenchOrderV1` 等 | 保留，不参与缓存回收 |

容量策略（初始建议，最终数值需确认）：

- 历史缓存跨 scope 总量上限 32MiB；超过后按 `updatedAt` 从最旧 scope 的会话开始删，保留当前打开会话和每个 scope 的最新一条。
- 图片沿用 200MB / 500 条 / 30 天。
- localStorage 回退索引最多 10 条；写入前为设置与公告预留余量，不能等到 `QuotaExceededError` 才处理。
- 所有上限集中为常量，便于按真机数据调整；不在多个文件里各写一个数字。

启动顺序（目标）：

```text
boot()
  initToken(); bindUi()
  restoreCachedSessions()          // 同步渲染上次会话列表，带 generation 校验
  renderCachedHistoryIfOpen()      // 若启动时已有目标会话，按现有 openSession 路径
  const version = loadLocalVersion({ timeout: 1500 })   // 不阻塞首屏
  if (!state.token) ...
  else {
    await selectFastestServer({ silent: true, reconnect: false })  // 网络等待发生在缓存渲染之后
    await version                     // 最多 1.5s，仅影响版本提示
    maybeWarnAppBehindGateway(...)    // 不阻塞首屏
    openStreams()
    refreshAll()                      // 权威数据回来后合并，不闪空列表
  }
```

注意：`selectFastestServer` 目前内部还会 `await maybeWarnAppBehindGateway()`（[public/app.js:1025](../public/app.js#L1025)），且切换连接时依赖 `reconnect` 决定是否重开流。实施时要把它拆成“选择连接”和“提示版本”两件事，避免后台化后漏掉版本提示或流重开。

迁移：

- `cache-upgrade.mount` 仍在首屏后触发，但迁移任务按“一个键一个 idle 回调”分片；>64KB 一律 Worker（比现在的 250KB 更保守）。
- 迁移前记录旧值；写入新键并确认事务完成后，才删除旧键；同一键失败则保留并计入 `pending`。
- 无连接身份的旧 V1 数据只回收，不混入任意主机 scope。
- 用户手动清理时，缓存门面统一处理历史/图片/会话列表；连接凭据、公告已读/填写标记、偏好不动。

### 4.3 实施步骤

每一步单独可回滚，且每一步结束都应能跑相关测试：

| 步骤 | 内容 | 主要文件 | 验证 |
| --- | --- | --- | --- |
| 1.1 | 新增 `cache-store.js` 骨架：打开 DB、事务超时、local 回退、scope 计算；不接管现有调用 | `public/cache-store.js`、两处 HTML、`sync-plugin.mjs`、新测试 | 新模块单元测试（假 IndexedDB/localStorage） |
| 1.2 | 会话列表键统一：先读两种旧键，写规范键；桌面端改为同一实现 | app.js、desktop.js、新测试 | 两端同 origin 共享；旧桌面键可迁移；连接隔离 |
| 1.3 | 启动缓存优先：把 `restoreCachedSessions` 提到任何网络 await 之前；`loadLocalVersion` 加超时并后台化；版本提示改为不阻塞 | app.js、desktop.js | 离线冷启动首屏有列表；慢网络不空等；版本提示仍会出现 |
| 1.4 | 历史/图片存储内部改走门面：统一 DB 打开、超时、统计；schema 不变 | history.js、image-cache.js | 现有 `cache-management`、`cache-upgrade`、`history-*` 测试 |
| 1.5 | 跨 scope 总量与回收：统计、LRU 回收、设置页展示占用；保留手动清理入口 | cache-store.js、app.js、desktop.js、设置页 | 容量测试、凭据/公告不被删、清理语义不变 |
| 1.6 | 文档与验收记录：使用说明补充缓存行为与容量 | `docs/usage.md`、本文件 | 文档核对 |

### 4.4 验收清单

- 飞行模式冷启动：有上次缓存时，首屏出现会话列表与可读历史；不出现“等网络再显示”的空窗。
- 多主机：A 的缓存不会出现在 B；测速切到 B 后清空 A 的列表，B 的缓存可恢复。
- 升级兼容：保留 0.9.0 的 `sessionsCacheV2`、`historyCacheV2`、旧 V1 数据，升级后可见；迁移完成才删旧副本；写入失败时旧数据仍在。
- 容量：人为把历史缓存推到上限，最久未用 scope 被回收；当前会话最新记录保留；令牌、服务器、公告已读/投票、主题不被删。
- 超时/异常：IndexedDB 打开超时、localStorage 配额满、Worker 不可用三种情况下，历史仍能回退或明确提示，不白屏。
- 清理：图片、历史、全部缓存、删除连接四种入口的现有语义不变（对应 `cache-management.test.js`）。
- 两端一致：桌面端与移动端对同一连接使用同一会话列表缓存键。
- 全量 `npm run check` 在允许子进程的环境通过；新增模块测试覆盖键迁移、容量回收、超时回退、启动顺序。

### 4.5 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 先渲染旧连接缓存，再切到新连接，短暂串数据 | 渲染前校验 scope；identity 变化时清空并按新 scope 重读；测试 A→B→A |
| 迁移写一半，旧键被删 | 只有确认新写入成功才删旧键；失败保留旧键并计入 pending；回滚只需保留旧键 |
| 桌面端旧键与移动端新键同时存在，读哪个 | 读时优先新键，其次旧键；写只写新键；首次读到旧键时后台迁移 |
| 容量回收误删设置/公告 | 缓存门面只允许操作白名单 kind；凭据/公告/偏好不经它删除 |
| 测试依赖源码切片，搬迁后假失败 | 新增模块用行为测试；被搬迁函数的相关测试在同一提交改为行为断言；不保留纯文本断言作为唯一证据 |
| 新增共享文件漏同步 | `sync-plugin.mjs` 文件列表、`index.html`、`desktop.html`、测试四处一起改；CI 或检查脚本核对 |

## 5. 阶段 2：传输层收敛

阶段 2 必须在阶段 1 验收后开始。原因是缓存首屏能显著降低传输层重构期间的回归噪音；反过来做，弱网/离线问题会混在一起难以定位。

### 5.1 设计

新增 `public/transport.js`（零依赖，全局 `DshTransport`），先做 HTTP，不碰流状态机：

```text
DshTransport
  request(path, { method, body, headers, timeoutMs, signal, cache, expect })
    -> { status, ok, data }            // 统一解析 JSON/text/空响应
  errorOf(responseOrError) -> { kind: 'auth'|'http'|'timeout'|'network'|'protocol', status, message }
  rpc(method, payload, { timeoutMs, signal, auth }) -> result.value
  authHeaders(auth)                    // Bearer / client id / native-web 标记
  backoffDelay(attempt, { base=1500, cap=60000, jitter=0.2 })
```

约束：

1. 取全局 `fetch` 必须发生在调用时（`root.fetch(...)`），不能模块初始化时 `const f = fetch`；否则 E2EE 映射失效。
2. `auth` 由调用方以快照传入（`{ server, token, clientId, native }`），模块不直接读全局 `state`；便于测试，也避免连接切换时读错身份。
3. 写操作不自动重试；只有读操作允许调用方显式重试。`DshOperations` 的受理回执路径保留在 app.js，但底层 HTTP 可复用 `request`。
4. 超时按“连接/上传/服务执行/响应读取”分别定义，不统一成一个超大值；弱网 profile 只放大读类请求，写类请求保持短超时并明确报错。
5. 401 统一映射为 `auth`，由调用方决定是否触发登录/切换；不吞掉错误。

### 5.2 流控制器

在 HTTP 统一之后，再抽 `public/stream-controller.js`，职责：

- 连接一个 kind（mux/host），维护 generation、attempt、failures、retry timer。
- 获取 WS ticket；ticket 不支持时回退 token 握手。
- 指数退避 1.5s 起步、60s 上限、20% 抖动。
- 任一通道连续失败 3 次进入轮询；轮询期间每 30s 试恢复 WS；打开成功后由调用方决定是否停轮询。
- 前后台、online/offline、网络类型变化由控制器提供 `resume()/suspend()/networkChanged()`，UI 只接收回调。
- 回调：`onOpen(kind)`、`onFrame(kind, full)`、`onDown(kind, info)`、`onPollReset(kind)`；刷新/渲染/提示仍留在 app.js/desktop.js。

必须保留的现有行为：

- mux 重连时清空并重放审批/提问基线。
- 轮询重置条件（epoch/truncated/latestSeq）与 `muxReady` 状态。
- `mux` 与 `host` 独立失败计数，不互相清零。
- 后台恢复先修复历史，再重开流。
- 网关重启、ticket 失效、401、多主机切换的可恢复路径。

### 5.3 实施步骤

| 步骤 | 内容 | 主要文件 | 验证 |
| --- | --- | --- | --- |
| 2.1 | `transport.js` 骨架 + 行为测试（假 fetch/AbortSignal）；不接管调用 | 新模块、两处 HTML、sync 列表 | 超时、401、HTTP 错误、abort、JSON 解析 |
| 2.2 | 统一鉴权头与 `rpc/respond/bcRpc`；保留操作回执分支 | app.js、desktop.js | 现有 `rpc`/回执/连接隔离测试 |
| 2.3 | 迁移文件、管理、更新、公告等 `fetch` 调用，分批提交 | fs/admin/update/announcement 相关模块 | 按模块回归 |
| 2.4 | 抽流控制器，移动端先接、桌面端后接；保持旧实现可回退直到两端测试通过 | app.js、desktop.js、新模块 | 断网/切网/后台/网关重启/降级轮询矩阵 |
| 2.5 | 把相关源码切片测试改为行为测试；保留必要的源码契约（downlink-only、无应用层 ping） | tests | 全量 + 故障注入 |

### 5.4 验收矩阵

| 场景 | 期望 |
| --- | --- |
| 冷启动在线 | 缓存先显示，权威数据回来后合并；不闪空列表 |
| 冷启动离线 | 缓存可用；状态明确提示离线；不无限转圈 |
| WS 正常 | mux/host 均连接；无应用层心跳；帧按 generation 丢弃旧连接 |
| WS 连续失败 3 次 | 进入轮询；不丢审批/提问；30s 试恢复 |
| 轮询中 WS 恢复 | 两个通道都 OPEN 后停轮询；不重复处理旧帧 |
| 网关重启 | 游标重置；会话、待办、当前历史重新同步 |
| 401 | 统一进入鉴权失败流程；不静默重试写操作 |
| 切网/回前台 | 关旧流、重开；历史恢复；多主机重新测速 |
| 多主机 A→B | 旧请求结果被 generation 丢弃；B 的缓存/流不混入 A |
| ticket 接口 404/501 | 回退 token 握手，不降级轮询 |
| E2EE 配对 | 全局 fetch/WS 映射仍生效；加密链路不回退明文 |

### 5.5 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 流状态机回归面大 | 先 HTTP 后流；流控制器分移动端/桌面端两步接入；每步保留旧路径直到测试通过 |
| E2EE 映射被绕过 | 动态取全局；新增“替换全局 fetch 后请求仍走映射”的测试 |
| 操作回执语义被统一层误改 | 回执路径留在 app.js；`request` 只负责传输，不负责业务幂等 |
| 弱网超时放大写操作，造成重复提交 | 写操作不自动重试；超时明确报“结果未知”，由用户决定 |
| 测试改造工作量被低估 | 只改被搬迁函数相关的切片测试；新增模块一律行为测试；不追求一次改完 94 个文件 |

## 6. 阶段 3：gateway 边界（本轮不做）

`gateway.js` 8,875 行，承担鉴权、静态资源、`/fs`、`/api` 代理、WS 上游、轮询缓冲、现代 API 适配、relay/E2EE、管理 API、更新检查。受“单文件网关 + 零构建”约束，本轮不动。

后续若要动，建议顺序：

1. 先抽纯策略函数（路径判定、鉴权判定、轮询缓冲、modern 适配）到 `gateway-*.cjs`，`gateway.js` 只留路由与胶水；不改变发布产物。
2. 为抽出的模块加契约测试，再考虑是否构建单文件。
3. 静态资源 ETag 可加进程内内容哈希缓存（同一文件内容不变时不重复读盘/哈希），但这属于网关性能优化，独立排期。

## 7. 验证与证据

### 7.1 命令

```bash
# 纯 JS 用例（当前沙箱可用；cache-upgrade 等含子进程的用例除外）
node --test --experimental-test-isolation=none tests/cache-management.test.js tests/history-load-recovery.test.js

# 全量门禁（需要允许子进程的沙箱或本机终端）
npm run check
```

当前沙箱下 `npm run check` 会在测试派生进程时报 `spawn EPERM`，不是用例失败。实施阶段应在允许子进程的环境跑一次完整基线，并记录测试数量、通过/跳过/失败。

### 7.2 重点回归集

- 缓存：`cache-management`、`cache-upgrade`、`history-load-recovery`、`history-ui`、`image-cache`、`session-list-ui`。
- 启动：`refresh-efficiency`、`connection-isolation`、`reconnect-integration`、`desktop-async-regressions`。
- 弱网/流：`weak-network`、`stream-weak`、`network-policy`、`network-regression`、`poll-summary`。
- 传输：`gateway`、`relay`、`e2ee-transport-ui`、`fs-path-aliases`、`fs-protected-dirs`、`upload-safety`、`upload-ui`。

其中 `gateway`、`relay`、`cache-upgrade` 等 37 个会派生外部进程的测试，需要在允许子进程的环境运行。

### 7.3 人工验证

| 场景 | 步骤 | 证据 |
| --- | --- | --- |
| 离线冷启动 | 先用在线状态产生缓存，再开飞行模式冷启动 | 首屏时间、列表/历史截图、无网络请求空等 |
| 多主机切换 | 两个连接，A 产生缓存，切 B 再切回 A | 不串数据、缓存恢复、流重开 |
| 升级迁移 | 用 0.9.0 旧键/旧 V1 数据升级到新构建 | 迁移数量、旧键清理、失败保留 |
| 配额满 | 写满 localStorage 后启动、收公告 | 不丢凭据、提示明确、可恢复 |
| 网关重启 | 流连接中重启网关 | 自动重连、游标重置、无漏审批 |
| E2EE | Android 配对后请求/WS/加密下载 | 仍走本机映射，无明文回退 |

### 7.4 证据记录

- 记录首屏“缓存可见时间”和“在线可操作时间”的 p50/p95，区分本地渲染与主机确认。
- 记录请求数/字节数变化；不把请求合并说成“更快”，要有数值。
- 记录缓存类别、数量、失败阶段；诊断不记录正文、令牌、文件内容。
- 真机与模拟器、Android WebView 与桌面浏览器分开写，不互相替代。

## 8. 交付与流程

- 分支：阶段 1 `codex/tech-debt-cache-first`；阶段 2 `codex/tech-debt-transport`。均从 `dev` 开独立 worktree，不合入同一个大分支。
- 提交：阶段 1 按 1.1–1.6 拆小提交；阶段 2 按 2.1–2.5 拆小提交。每个提交只做一件事，测试随提交。
- 同步：改 `public/` 后运行 `npm run sync-plugin`；新增共享文件同时更新 `scripts/sync-plugin.mjs` 的 `files` 列表、`public/index.html`、`public/desktop/desktop.html`。
- 版本：每阶段完成本地 RC，按现有流程真机验证；不因“重构”跳过 RC。合入 `dev` 不等于发布，发布仍需明确授权。
- 文档：阶段 1 更新 `docs/usage.md` 的缓存说明；阶段 2 更新 `docs/troubleshooting.md` 的连接/弱网说明；本文件保留为方案依据，实施后追加验收结果而不是改写历史。

当前环境备注：本会话沙箱默认禁止写入 `.git`；提交、创建 worktree 等 Git 操作需要临时完全权限。首批实施在独立 worktree 进行，不直接改主工作区。

## 9. 已确认决策（2026-11-25 评审）

首批范围：C1 + C2 + N4。D2 的容量实现放到阶段 1 后续批次。

| 编号 | 决策 | 已确认方案 |
| --- | --- | --- |
| D1 | 会话列表缓存键迁移 | 两端统一写 `sessionsCacheV2:<scope>`。规范键缺失或损坏时，才读桌面旧键 `historyCacheV2:<scope>:sessions` 并尝试迁移；有效的 `[]` 也是权威结果，不能回退旧键让旧会话复活。旧键保留到 RC 回滚窗口结束；用户主动清缓存或删除连接时同时清两种键。 |
| D2 | 历史缓存容量上限 | 先以 **32 MiB** 作为 IndexedDB 历史缓存的跨连接预算，保留每连接 10 条上限；按 `updatedAt` 从旧到新回收，优先保留当前会话。每个连接的最新一条是软保护，连接足够多时仍须遵守总预算。localStorage 回退单独设更小预算，具体值用真机数据定。本项放到阶段 1 后续批次。 |
| D3 | 两端共享 | 同一 origin 且 `server + token` 相同就共享；切地址或换令牌都切换 scope。 |
| D4 | 弱网策略 | 只对具有只读语义的请求放宽超时。写操作沿用各自的超时和受理回执语义，禁止自动重试。 |
| D5 | 启动先显示缓存 | 先确定启动连接，再恢复该 scope 的缓存。测速从 A 切到 B 时，立即清掉 A 的可见列表和历史；即使 B 没有缓存也要清，迟到的 A 响应用 generation 丢弃。 |
| D6 | 独立 RC | 首批单独出本地 RC，验证旧版本升级、飞行模式冷启动和 A→B→A 切换；阶段 1 验收后再推进 HTTP 收敛。 |

评审补充的两点实施修正：

1. **C2 按视图验收，不只检查函数调用顺序。** 两端连接 setter 已经会排队恢复缓存；仅提前调用恢复函数会漏掉“列表 DOM 仍是旧主机”的问题。验收要看断网时用户能否看到列表并打开已有缓存的会话。
2. **N4 用 1.5 秒作为初始超时，覆盖响应体读取。** 超时或失败时保留 Android 安装版本回退（`NativeUpdate.getInstalledVersion`）。版本结果供更新提示和公告使用；主机选定后即可开流和刷新会话，不等待版本请求。

首批实施时，旧键保留策略按“读旧写新 + 旧键存在时镜像写”执行，便于 RC 回滚；回滚窗口结束后再单独移除旧键兼容代码。

## 10. 附录

### A. 统计口径

- 行数/字符数：工作区文件直接读取；行数按 `\n` 拆分，字符数为 JavaScript 字符串长度（非 UTF-8 字节）。
- 顶层函数：匹配行首 `function name(` 或 `async function name(`；不含缩进函数、箭头函数、对象方法。
- 同/异：函数体按空白归一化后比较；同名但内容不同计为分叉。
- `fetch/localStorage`：对 `public/*.js`、`public/desktop/*.js` 做正则计数，不含 `vendor/` 与压缩库。
- 测试：对 `tests/*.test.js` 做文本统计；“读某文件”指测试源码中出现该路径字符串。

### B. 关键位置索引

| 主题 | 位置 |
| --- | --- |
| 连接 scope / 缓存键 | [public/app.js:36](../public/app.js#L36) |
| 会话缓存读写 | [public/app.js:2287](../public/app.js#L2287)、[public/app.js:3295](../public/app.js#L3295) |
| 历史缓存实现 | [public/history.js:199](../public/history.js#L199)、[public/history.js:211](../public/history.js#L211)、[public/history.js:268](../public/history.js#L268) |
| 图片缓存实现 | [public/image-cache.js:4](../public/image-cache.js#L4)、[public/image-cache.js:9](../public/image-cache.js#L9) |
| 缓存升级调度 | [public/cache-upgrade.js:42](../public/cache-upgrade.js#L42) |
| 启动顺序 | [public/app.js:9697](../public/app.js#L9697) |
| 版本请求无超时 | [public/app.js:6562](../public/app.js#L6562) |
| RPC | [public/app.js:622](../public/app.js#L622)、[public/desktop/desktop.js:755](../public/desktop/desktop.js#L755) |
| WS 流 | [public/app.js:1711](../public/app.js#L1711) |
| 轮询降级 | [public/app.js:1877](../public/app.js#L1877) |
| E2EE 全局覆写 | [public/e2ee-transport.js:108](../public/e2ee-transport.js#L108) |
| 同步清单 | [scripts/sync-plugin.mjs](../scripts/sync-plugin.mjs) |
| 网关静态缓存 | [gateway.js:5712](../gateway.js#L5712) |

### C. 相关文档

- [下一版本：旧缓存迁移与容量管理](next-version-cache-cleanup.md)
- [缓存升级与 Android 中转设备补齐](completion-cache-and-devices.md)
- [弱网流式精简](streaming-weak-network.md)
- [网络切换与历史恢复](network-switch-history-recovery.md)
- [开发指南](development.md)
- [AGENTS.md](../AGENTS.md)
