# 插件发现改造与 README 预览：设计与实施提示词

> 状态：**设计，未实施**。日期 2026-10-19。代码基线 `0.8.0-rc.5`（工作区未提交状态）。
> 本文件同时是交给编程流程的**自包含提示词**：背景 + 硬约束 + 精确落点 + 验收清单。实施者按本文件改代码并自测，不提交、不部署、不改发布形态。
> 本文所有现状描述与数据均为 2026-10-19 实测，来源见各节标注。

---

## 0. 先做步骤 0 探针（未通过就停下来报告，不要自行改设计）

本设计的地基是一个**尚未在运行宿主上验证**的假设：

> `ctx.get('pluginMarket')` 能从我们的插件里拿到官方的 `pluginMarket` 服务实例。

已验证的部分（静态证据）：

- 官方包 `@deepseek-ai/dsh-plugin-market`（0.2.1-alpha.4，`deepseek-ai/deepseek-harness` 仓库）`lib/index.js`：class 继承 `TypertRemoteService`，`static inject = ["pluginManager"]`，方法 `listIndexes` / `setIndexes` / `search` 均带 `@Remote` 装饰。
- 生成式 Remote 契约（`lib/typert.host.js`、`lib/typert.remote-client.js`）确认 face 名为 `pluginMarket`，`search(url, query)` 两参数。
- 我们的仓库已在用同一模式读第三方/宿主服务：`packages/plugin/insights.mjs:51` `ctx.get?.('costMeter')`（读第三方 dsh-cost-meter）、`peak-reminders.mjs:42` 同、`plugin-center.mjs:251` `ctx.get?.('loader')`、`session-file.mjs:8` `ctx.get?.('sessionController')` / `ctx.get?.('attachments')`、`teams.mjs:32` `ctx.get?.('workspaceRegistry')`。

**未验证的部分**：`TypertRemoteService` 派生的服务是否也通过 `ctx.get(name)` 暴露给同进程内的其他插件（还是只对客户端 Remote 协议暴露）。

**步骤 0 要求**：

1. 在临时 `HOME`/`USERPROFILE` 下用真实 DSH 实例（`DSH_TEST_CLI_ROOT` 路径，参照 `tests/installed-dsh.test.js` 的做法）加载我们的插件。
2. 打印 `typeof ctx.get('pluginMarket')`、其可见方法名、`await ctx.get('pluginMarket').listIndexes()` 的结果。
3. **同时**打印当前 `ctx` 上可枚举的服务名列表，作为失败时的证据。

**判定**：

- 拿到实例且 `listIndexes()` 可调用 → 继续第 4 节。
- 拿不到 → **停止实施，原样回报探针输出**。不要改用"自己抓索引 JSON""自己实现相关性排序"或任何替代方案：那等于重新实现官方的校验与检索语义（含 MiniSearch 相关性、CJK 分词、兼容性求值），属于另一次决策，不在本文件范围内。

---

## 1. 背景（实测依据）

### 1.1 现状：发现页是一个裸的 npm 关键词搜索，没有任何排序

`packages/plugin/plugin-center.mjs:382-389`：

```js
if (method === 'GET' && sub === '/market') {
  const data = await registryJson('/-/v1/search?text=' + encodeURIComponent('keywords:dsh-plugin ' + q) + '&size=20&from=' + offset)
  return { ok: true, source: REGISTRY, total: data.total || 0, items: (data.objects || []).map(({ package: p }) => ({ name: p.name, version: p.version, description: p.description || '' })) }
}
```

`REGISTRY = 'https://registry.npmjs.org'`（同文件第 9 行）。**没有 `sort` 参数**，吃 npm 默认相关性排序；条目只有 `name`/`version`/`description`。

实测后果（2026-10-19）：

| 口径 | 我们的位置 |
| --- | --- |
| `keywords:dsh-plugin` 默认排序，共 8956 条 | **第 488 名**（插件中心 20 条/页 → 第 25 页） |
| 富目录内按 30 天下载 | 第 428 / 2949 |

即：**在我们自己的插件中心里，我们自己的插件基本搜不到**，且没有分类、没有兼容性、没有安装状态。

### 1.2 官方发现能力的真实范围（重要：它不是"可信排名"）

format-1 索引格式（`@deepseek-ai/dsh-plugin-market-index`，`lib/index.js` 是可执行规则）定义了 `sort` 的四种形状：

| sort kind | 含义 | 真实索引可用性 |
| --- | --- | --- |
| `{kind:'relevance'}` | MiniSearch 文本相关性；名称/标题权重 3×、关键词 2×；NFKC 大小写不敏感；前缀匹配；词长 ≥4 时编辑距离 ≤ 长度/5 且 ≤2；中日韩按相邻二字组合切分 | ✅ 可用 |
| `{kind:'published', direction}` | 按 `publishTimestamp` | ✅ 可用 |
| `{kind:'index'}` | 索引自身策展顺序 | ✅ 可用 |
| `{kind:'key', id, direction}` | **已声明的排序键** | ❌ **结构性失效** |

对一份真实索引（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，标题 `Awesome DSH Plugin`，2953 条）的完整统计：

```
索引级 metadata.categories 声明数 : 23     ← 分类可用
索引级 metadata.labels 声明数     : 0
索引级 metadata.sortKeys 声明数   : 0      ← 没有任何排序键被声明
插件级 metadata.sortKeys 填充     : 0 / 2953
插件级 metadata.labels 填充       : 0 / 2953
插件级 metadata.keywords 填充     : 0 / 2953
插件级 versions 条数 > 1          : 0 / 2953
```

**结论**：官方能提供的是**相关性 + 发布时间 + 分类 + 权威兼容性/安装状态**；**不提供**热度或可信度。因此本设计的排序口径只能是官方的三种有效排序，**不得声称或暗示这是"可信排名"**。

### 1.3 官方 `search` 返回的字段（本设计的排序与展示依据）

`search` 返回索引标题/描述/声明、`fetchedAt`、`total`、`nextOffset`；每个插件带 `installation`、`defaultVersion`、`versionCount`、`category`、双语 `title`/`description`、`author`、`homepage`、`repository`（含 `directory`）；每个版本带 ISO 发布时间、`compatibility`、以及可直接用于安装的 `install` 与 `registry`。

其中两项是本设计的关键收益：

- **`installation`**：`not-installed` / `installed` / `update-available` / `different-version` / `provided`，按 `pluginManager.listBundles()` 实时计算。
- **`compatibility`**：与真实安装路径**同一套** `evaluatePluginCompatibility` 得出。

这补上了一个已确认的功能性缺口：`dsh.bundle.patch` 并非普遍声明（实测 `@roarpeng/graphflow` 未声明），而我们的安装链路强制校验它，用户会"能浏览、能点安装、必然失败"。官方返回的 `compatibility`/`installation` 是权威结论，优于任何基于 npm 元数据的推断。

### 1.4 官方发现服务的前提（决定了降级设计）

来自官方 `README.zh.md`（`@deepseek-ai/dsh-plugin-market`）：

- 配置项 `indexes` 默认 `[]`，**"默认不配置任何索引源，因此在用户添加索引源之前，Host 不发送任何市场请求"**。
- 该服务位于可选组合包 `plugin-market-bundle`，随附 profile **默认不启用**；该行还会等待 `pluginManager`。**可能根本没挂载。**
- `listIndexes()` **从不发起获取**，只回报已配置 URL 及其最近成功读取的标题/描述，或最近一次失败的错误。
- `setIndexes(urls)` 是**写用户设置**的操作（需 Settings 与 profile 条目）。**本设计禁止调用它。**
- 已知限制：无升级支持（需先卸再装）、索引无签名、后写入者覆盖、拒绝重定向、读取整份文档并在内存建 MiniSearch 索引（20,000 条约 130 MiB 堆）。

### 1.5 "已适配"的权威清单已存在于代码中

`public/extensions.js` 的 `catalog` 是仓库内唯一权威的适配注册表：

```js
const catalog = [
  { id: 'skills',  name: '@linxin666/dsh-client-ui-skill-explorer', label: '打开技能中心' },
  { id: 'teams',   name: '@nanmicoder/dsh-agent-teams',             label: '查看智能体团队' },
  { id: 'cost',    name: 'dsh-cost-meter',                          label: '查看费用与额度' },
  { id: 'context', name: 'dsh-context',                             label: '查看当前会话上下文', session: true },
]
```

核验版本基线（从适配器注释与文档中取得）：

| 插件 | 包名 | 已核验基线 | 依据 |
| --- | --- | --- | --- |
| 费用与额度 | `dsh-cost-meter` | **1.8.x**（峰谷提醒核到 1.8.17） | `insights.mjs:1`、`docs/plugin-insights.md:29`、`docs/rc-0.8.0-feedback.md:20` |
| 当前会话上下文 | `dsh-context` | **0.64.0** | `docs/plugin-insights.md:19` |
| 技能中心 | `@linxin666/dsh-client-ui-skill-explorer` | **0.4.x** | `skills.mjs:1` |
| 智能体团队 | `@nanmicoder/dsh-agent-teams` | **0.1.23**（调查）／**0.1.24-rc.1**（真实快照生成代码） | `docs/plugin-ui-adaptation-survey-2026-10-13.md:23`、`docs/announcement-forms-and-teams.md:48` |

> **上表最后一行口径不一致，实施前必须由维护者定一个值**；不得把两个数字混写进用户可见文案。

### 1.6 README 数据源与覆盖率

- npm **完整 packument**（`GET /{name}`）根字段含 `readme`；**单版本 endpoint（`/{name}/latest`）不含** `readme`（实测 `dsh-cost-meter` 的 `/latest` 文档键里没有该字段）。
- 覆盖率**不完整**。8 个真实插件抽样：

  | 插件 | README 长度 |
  | --- | ---: |
  | `billion-context`（30 天下载第 1） | **0（未提供）** |
  | `dsh-whale-widget` | 31,113 |
  | `@roarpeng/graphflow` | 26,786 |
  | `dsh-plugin-teamflow` | 10,468 |
  | `dsh-subagent-delegation` | 847 |
  | `@rebornace/dsh-tracescope` | **0（未提供）** |
  | `dsh-prompt-stash` | **0（未提供）** |

  即 **3/8 没有 README，含下载量第一者**。所以"没有 README"必须是正常状态而非错误态。
- 官方 `search` 结果带 `homepage` 与 `repository`（含 `directory`），可作为将来的回落线索——但 **v1 不做**（见第 7 节非目标）。

### 1.7 渲染器的安全现状（本设计必须处理的地方）

`public/md.js` 是零依赖 Markdown 渲染器，`mdToHtml(text, options)` 支持 `options.imageLabel`、`options.fileLinks`、`options.richContent`。它的图片策略是为**聊天（用户自己的内容）**设计的：

```js
if (/^(?:data:image\/|https?:\/\/|\/api\/)/i.test(target)) {
  return '<button ...><img src="' + escapeHtml(target) + '" ...></button>'
}
```

对**第三方不可信 README** 这意味着：

1. `https?://` 任意远程图 → 手机 IP/UA 泄露给任意主机、追踪像素、流量消耗。
2. **`/api/` 同源路径 → 恶意 README 写 `![x](/api/...)` 会让手机带着用户凭证发同源 GET。** 必须禁掉。
3. `data:image/` → 对不可信内容应排除 `svg+xml`。

另外 `mdToHtml` 默认会把 ```dsh-ui 与 ```html 代码块交给 `genui`。`genui.html()` 本身的实现是安全的（标签白名单 + 属性白名单 + `<iframe sandbox srcdoc>` + 严格 CSP `default-src 'none'`），但第三方 README 没有必要开这个面，用 `richContent: false` 关掉。

---

## 2. 目标

1. **发现页的搜索改走官方 `pluginMarket` 服务**：拿到官方相关性、23 个分类、双语描述、权威 `compatibility`/`installation`、稳定分页。零新增依赖。
2. **空查询时展示「Remote 已适配」推荐区**：数据来自本地 `extensions.js` catalog，**离线可用、不依赖索引源**，每项带已核验版本与真实安装/运行状态。
3. **支持预览插件 README**：新增只读端点，用 `md.js` 的**严格图片模式**渲染。
4. 移除 npm 关键词搜索作为发现路径（保留"按完整包名查看详情"的既有能力）。

## 3. 非目标（明确不做，避免范围蔓延）

- **不做可信评分或热度排名**。官方不提供（`sortKeys` 全空，1.2 节）；能力审计数据只存在于第三方富目录（7 MB、站点私有 schema），引入它是一个**独立决策**，不在本文件范围。
- **不做 GitHub raw README 回落**。npm 无 README 时直接显示"该插件未提供 README"；引入 `raw.githubusercontent.com` 是新的对外信任边界，另议。
- **不调用 `setIndexes`**。发现页保持只读，索引源由用户在主机侧配置。
- **不自动安装、不内置、不默认启用**任何推荐插件（沿用 `docs/optional-plugin-product-review.md` 规则 7）。
- **不引入任何第三方库、CDN 脚本、构建步骤**。
- **不做 i18n 改造**。`public/plugin-center.js` 现状是硬编码中文（全文件无 `i18n`/`I18N` 引用），新增文案保持一致，不为此新建 i18n 框架。
- **不改变聊天里的 Markdown 渲染行为**（`md.js` 默认路径必须逐字不变）。

---

## 4. 精确落点

### 4.1 新增 `packages/plugin/market.mjs`（官方发现服务只读适配器）

仿照 `insights.mjs` / `skills.mjs` 的既有范式：只读、有界、固定错误码、**不回显上游错误原文**。

```js
export function createMarketAdapter(ctx) { ... }
```

要求：

- 服务获取：`let service; try { service = ctx.get?.('pluginMarket') } catch {}`——**沿用 `insights.mjs:51` 的写法**，不在 `index.mjs` 的 `inject` 里加硬依赖（`index.mjs:23` 当前是 `['webServer','commands','agents','connection']`，**不要改**）。
- 能力探测：服务不存在 → `{available:false, code:'not-installed'}`；存在但 `listIndexes`/`search` 非函数 → `{available:false, code:'unsupported'}`。探测只读取状态或方法存在性，**不发起昂贵的索引拉取**。
- `listIndexes()`：直接透传，但只保留 `url`、`title`、`description`、`error` 四个字段；**不要把 `error` 原文直接给前端**（官方文档说明该字段是失败消息，可能含 URL 等主机信息）→ 归一化为固定 `code`，或仅在主机日志中保留。
- `search(url, query)`：**只接受由 `listIndexes()` 返回过的 URL**（白名单校验，防止客户端指定任意地址）；`query` 只接受 `text`/`category`/`labels`/`sort`/`offset`/`limit`/`fetchedAt`，逐字段校验类型与范围（`offset` 非负整数、`limit` 1–100）；`sort` 只接受四种合法形状（1.2 节），其余拒绝。
- 超时兜底：参照 `insights.mjs` 的 `bounded(task, ms = 20000)` 写法。
- 长度与条数上限：单页最多保留官方允许的 `limit`（≤100）条；字段截断（`title`/`description`/`author` 按官方已截断的 300 字符量级，双语文案各截断，`homepage`/`repository.url` 限长）。
- 失败一律返回固定码，绝不回传主机路径、URL、凭证或官方错误原文。

### 4.2 改 `packages/plugin/plugin-center.mjs` 的 `/market`（现行 382–389 行）

新增/调整端点（`handle(method, sub, body, query)` 已有 `query` 参数，无需改签名）：

| 端点 | 说明 |
| --- | --- |
| `GET /market/indexes` | 返回 `{ok, available, code?, indexes:[{url,title,description}], source}` |
| `GET /market` | 改为官方搜索：参数 `q`、`index`（可选，缺省用第一个可用索引源）、`category`、`sort`、`offset`、`fetchedAt` |
| `GET /readme` | 见 4.4 |

`/market` 响应建议形状（保持 `ok`/`total`/`items` 以降低前端改动量）：

```js
{ ok: true, available: true, source: 'official',
  index: { url, title, description }, categories: [...声明...],
  total, nextOffset, fetchedAt,
  items: [{ name, version, title, description, author, homepage, repository,
            category, installation, versionCount, compatibility }] }
```

- 排序默认 `{kind:'index'}`（策展顺序，空查询态）；有 `q` 时默认 `{kind:'relevance'}`。可选 `{kind:'published', direction:'desc'}`（"最新"）。
- **不要**暴露 `{kind:'key', ...}`：真实索引 0 条 sortKeys，永远空转，暴露只会造成"这个排序坏了"的观感。
- 保留 `pluginDetails()`（第 179–191 行，走 npm 单版本文档）**不动**——它服务于预检/安装/详情，与发现路径无关。

### 4.3 改 `public/plugin-center.js` 的发现页（`search()`，现行 243–264 行）

现状：`list.replaceChildren(node('p','正在查询 npm 插件目录…'))` → `api('/market?q=&offset=')` → 固定来源说明（249 行 `'来源：npm · 安装前校验 DSH bundle。…'`）→ 卡片列表 → 上一页/下一页（20 条/页）。

改为三态分支（`indexState = 'ready' | 'none' | 'unavailable'`，由 `/market/indexes` 得出）：

| indexState | 空查询 | 有查询词 |
| --- | --- | --- |
| `ready` | **推荐区** + 官方列表（`{kind:'index'}`，分类可筛） | **推荐区**（可置顶或折叠）+ 官方 `{kind:'relevance'}` 结果 |
| `none` | **推荐区** + 一行引导：「主机 → 插件 → 发现 → 索引源」添加后可搜索 | 同左，并说明未配置索引源；保留"按完整包名查看详情" |
| `unavailable` | **推荐区** + 说明当前主机未启用官方发现服务 | 同左，说明服务不可用 |

要求：

- **来源标注必须显式且随状态变化**，取代现行 249 行那句固定文案。三种文案分别标注：`来源：主机官方索引（<索引标题>）` / `未配置索引源，以下为 Remote 已适配插件` / `当前主机未启用官方发现服务`。
- **不得回落 npm 关键词搜索**。理由：它是让我们自己排第 488 名的那个东西，用它冒充搜索结果比空着更糟。
- **按完整包名查看详情的能力必须保留**：查询串匹配 npm 包名语法（沿用 `plugin-center.mjs` 的 `packagePattern` 同类规则）时，提供"查看 `<name>` 详情"动作，仍走既有 `/details`（该路径对任意包名有效，`showDetails` 现行 265 行起已支持）。这是用户已知包名时的唯一退路，不能丢。
- 沿用既有的竞态防护：`searchSequence`（243–248 行）、`generation`、`tab !== 'market'` 校验、`AbortSignal.timeout(30000)`（`api()`，36 行）。分页用官方 `fetchedAt` 保证翻页稳定；`refresh` 只在用户显式操作时传。
- 已安装条目走既有 `renderInline`/`installedDetails` 与 `action = row ? 'update' : 'install'` 逻辑（163 行），不新增安装路径。

### 4.4 新增 `GET /readme`（`plugin-center.mjs`）

契约：

```
GET /remote/api/plugins/readme?name=<pkg>[&version=<ver>]
```

- 校验 `name` 与 `version`（复用 `packagePattern` / `versionPattern`）。
- 取数：`registryJson('/' + encodeURIComponent(name))`（完整 packument，已有 8 MiB 上限保护，见第 165–177 行），读根字段 `readme`。
- 上限：`content` 截断至 **100,000 字符**并置 `truncated`（与 `skills.mjs:44` 的 `slice(0, 100000)` 一致）。
- 缓存：TTL（建议 10 分钟）+ 条数上限，防止内存增长；缓存键为包名。
- 返回：

  ```js
  { ok:true, available:true, source:'npm', content, truncated, version }
  { ok:true, available:false, code:'no-readme' }     // 该包未提供 README（正常态，非错误）
  { ok:false, code:'readme-unavailable' }            // 拉取/解析失败，固定码
  { ok:false, code:'invalid-name' }                  // 校验失败
  ```

- **准确性要求**：packument 根字段的 `readme` 对应**最新发布版**，不保证等于请求的 `version`。响应必须带 `version`（该 README 实际对应的版本），前端文案写"该插件在 npm 上的 README（对应最新发布版）"，**不得**声称它是任意指定版本的 README。

### 4.5 改 `public/md.js`：新增严格图片模式

现状：`mdToHtml(text, options)` → `renderLines(escaped.split('\n'), options?.fileLinks === true)` → `inline(s, fileLinks)` / `tableHtml(table, fileLinks)` → `inline(value, fileLinks)`。`fileLinks` 是一个**布尔量**在多层之间传递。

要求：

- 把图片策略作为**新增选项**传入，并随渲染层级透传。推荐把透传的布尔量收敛为一个 opts 对象（如 `{ fileLinks, imageHosts }`），但**必须保持默认调用行为逐字不变**。
- 新增 `options.imageHosts`：为 `string[]` 时进入**严格模式**——只允许 hostname 在白名单内的 `https://` 图片，并显式拒绝：
  - 任意非白名单 host 的 `https?://`
  - **所有 `/api/` 同源路径**（凭证泄露面，见 1.7）
  - `data:`（严格模式下整体拒绝，含 `svg+xml`）
  - `file:` 与本地路径（严格模式下不解析为文件）
- README 渲染调用方必须传：`{ richContent: false, fileLinks: false, imageHosts: README_IMAGE_HOSTS }`。
- `README_IMAGE_HOSTS` 建议初始白名单（依据本生态 README 常见图床）：`raw.githubusercontent.com`、`github.com`、`objects.githubusercontent.com`、`user-images.githubusercontent.com`、`img.shields.io`、`shields.io`、`badgen.net`、`cdn.jsdelivr.net`。白名单放在**一处常量**，便于维护者增删。
- 严格模式产出的 `<img>` 需带 `loading="lazy"` 与 `referrerpolicy="no-referrer"`（减少对图床的 referrer 泄露）。
- **回归硬要求**：`tests/md.test.js`、`tests/md-images.test.js`、`tests/genui.test.js` 必须在**不修改断言**的前提下继续通过——它们是"聊天渲染行为未变"的闸门。

### 4.6 推荐区：扩展 `public/extensions.js` 的 catalog（单一数据源）

现有 catalog 只有 `id`/`name`/`label`/`session`。推荐区还需要"它给 Remote 加什么能力"与"已核验版本"。**在同一份 catalog 上补充字段**，不要新增第二份清单（两个消费方向必须共用一份，否则必然漂移）：

```js
{ id:'cost', name:'dsh-cost-meter', label:'查看费用与额度',
  summary:'<一句能力描述>', verified:'1.8.x' }
```

- `summary`：描述**装了什么能力**，不是描述按钮动作。注意 `context` 的入口是会话级的（`session: true`），其 `summary` 也应讲能力而非会话动作。
- `verified`：取第 1.5 节表格的值。`agent-teams` 的值需先由维护者澄清（0.1.23 vs 0.1.24-rc.1）。
- 状态复用**既有**能力探测：`window.DshExtensions.getCapabilities(config)` 已返回 `{known, skills, cost, context, teams}`，其内部已判定「已安装 + `enabled === true` + runtime `phase === 'active'`」。三态映射：未安装 / 已安装未启用 / 可用。
- 已安装项：跳既有入口（`window.DshExtensions` 既有导航）。`context` 为会话级，在发现列表里只显示"已安装"，不提供伪会话入口。
- 安装动作：**必须固定到已核验版本**，且**必须走既有 `preflight` + `operations` 审批流程**（不得绕过，也不得使用 `@latest`）。理由：适配器是按基线版本核验的，装上未核验的更高版本会先弄坏我们自己的适配功能。
- 文案纪律：标题写「Remote 已适配」，附边界说明（例如「仅核验上述版本，其他版本不保证」）。**禁止**使用「推荐 / 精选 / 最好用 / 唯一 / 首创」等措辞。（`AGENTS.md` 宣传口径）

### 4.7 样式

新增类名 `pc-market-note`（已存在，见 `plugin-center.js:249`）的复用与推荐区卡片样式，落在 `public/plugin-center.css`。沿用现有主题变量，不引入新配色、不做第二套设计语言。改 `public/` 后必须跑 `npm run sync-plugin`。

---

## 5. 降级矩阵（验收要逐格覆盖）

| 场景 | 官方服务 | 索引源 | 期望表现 |
| --- | --- | --- | --- |
| A | 已挂载 | 1 个 | 空查询：推荐区 + 官方策展列表；有查询：推荐区 + 官方相关性结果；来源标注官方 |
| B | 已挂载 | 0 个（**默认态**） | 推荐区 + 引导配置索引源；不发起市场请求；明说未配置 |
| C | 已挂载 | 多个 | 用第一个可用索引源；响应带索引标题，UI 明示当前来源；提供切换 |
| D | 未挂载 | — | 推荐区 + 说明服务不可用；`code:'not-installed'` |
| E | 已挂载但 `search` 抛错 | 1 个 | 固定错误码，不显示官方错误原文；推荐区仍可用 |
| F | 任一时点的索引拉取失败 | 1 个（`listIndexes` 带 `error`） | 该索引标记不可用，引导用户检查；不显示原始错误文本 |
| G | 断网 | — | 推荐区仍显示（本地数据）；官方路径给出明确失败态 |

统一要求：切换主机/令牌后，迟到的官方响应不得污染新主机的列表（沿用 `generation` + `searchSequence`）。

---

## 6. 验收清单

**自动化**

1. `npm run check` 全绿。**先跑一次记录基线条数，改完再跑并对比**，不预设数字（`AGENTS.md`：「数量以本次结果为准」）。
2. `git diff --check` 通过（Git 的 CRLF 提示不算失败）。
3. 新增测试至少覆盖：
   - `market.mjs`：服务缺失→`not-installed`；方法缺失→`unsupported`；`search` 拒绝非白名单 URL；`sort` 四种形状的接受/拒绝；`limit`/`offset` 越界拒绝；上游错误→固定码且不含 URL/路径。
   - `/readme`：有 README→截断与 `truncated` 正确；无 README→`available:false, code:'no-readme'`；非法包名→`invalid-name`；上游失败→`readme-unavailable` 且响应体不含上游文本。
   - `md.js` 严格模式：白名单 host 放行；非白名单 `https://` 拒绝；**`/api/` 拒绝**；`data:` 拒绝；`file:`/本地路径拒绝；未传 `imageHosts` 时行为与改动前一致。
   - 降级矩阵 A–G（至少覆盖 A、B、D）。
4. **md 回归**：`tests/md.test.js`、`tests/md-images.test.js`、`tests/genui.test.js` 断言未改动且通过。
5. 推荐区断言：**不调用** `operations`/`preflight`（纯展示）；安装动作携带的是已核验版本而非 `latest`；`catalog` 只有一份（无第二份清单）。

**人工/边界**

6. 用隔离 mock 上游验证发现页三态渲染、来源标注随状态变化、分页稳定、切换主机不串数据。
7. 确认默认态（索引源为 0）下页面不是空白，而是推荐区 + 引导。
8. 确认没有新增任何第三方依赖（检查 `package.json`、`packages/plugin/package.json` 与前端无 CDN 引用）。
9. 确认未触碰历史遗留文件 `packages/plugin/public/app.js`、`packages/plugin/public/index.html`；`public/` 改动已通过 `npm run sync-plugin` 同步。

**交付纪律**

10. **不提交**（攒到 release 由 `npm run release` 统一 `git add -A`）；不部署；不改发布形态。
11. 完成报告需含：改动文件清单、验证结果、未提交状态说明。

---

## 7. 未验证与风险（不得当作已成立）

- **`ctx.get('pluginMarket')` 可达性未验证**——本设计的地基，步骤 0 必须先验（第 0 节）。失败即停止回报，不自行改设计。
- **未做真机与真实 DSH 版本验收**。本文件的所有现状数据来自源码、npm registry、第三方索引与官方发布包；不代表在用户实际 Desktop / Android / HarmonyOS 环境可用。
- **索引内容是第三方声明**。官方文档明确：「索引没有签名——索引内容（包括 Git 条目的名称和版本）是市场的声明；实际安装什么由已安装的 manifest 决定」。UI 不得把索引内容当作安全或兼容性背书。
- **1.2 节统计是 2026-10-19 的快照**（2953 条、`sortKeys` 全空）。索引生成器补齐 `sortKeys` 后，"策展顺序"的实际含义可能变化，届时需重新评估。
- **README 覆盖率只做了 8 个抽样**（3/8 缺失），不是全量统计。
- **`agent-teams` 核验版本口径不一致**（1.5 节），需维护者先澄清。
- 本设计**不解决**"可信度/风险审计"需求：官方不提供、第三方能力审计需引入新依赖，属独立决策。

---

## 8. 与既有文档的关系

- `docs/optional-plugin-product-review.md` 规则 1 曾明确移除「技能 / 费用」的默认功能卡片，理由是"可选适配像必备功能"。**本设计的推荐区必须只出现在「发现／添加插件」语境**，不得回到「插件」默认页，且不得自动安装或默认启用（同文档规则 7）。这是本设计与既有决策最容易冲突的一点。
- `docs/plugin-ui-adaptation-survey-2026-10-13.md` 的候选清单（任务看板、长任务进度等）**不是"已适配"**，不得进入推荐区。每完成一个新适配，推荐区才增加一项——推荐区长度即适配进度的显示器。
- `docs/plugin-center.md` 描述的是现行 npm 来源的行为；本设计落地后该文档需同步更新来源与排序说明。
