# Remote 技能中心适配

实现与验证日期：2026-10-13。接口基线：`@linxin666/dsh-client-ui-skill-explorer` 0.4.6。

## 入口与范围

手机 Web 与桌面端打开“插件管理 → 技能中心”。共享界面提供：

- 按来源浏览项目、用户、自定义和插件注册的技能。
- 搜索名称、说明、适用场景和项目名称；按来源与模型调用状态筛选。
- 查看适用场景、模型/手动调用状态及纯文本正文。未知状态单独显示。
- 显示读取时间；列表不完整、过长、未安装、停用、版本不兼容和读取失败有明确反馈，允许重试。
- 桌面使用列表与详情两栏，手机按单栏显示；筛选排除已选技能时清空其详情。

本版只读。没有新增技能编辑、启停、删除或安装操作。技能文本不会执行，也不会作为 HTML 插入。项目范围和同名技能的来源优先级由主机技能插件决定；本版不提供 Remote 端工作区切换或重新计算优先级。

## 主机与网关契约

新增主机 Remote 路由：

```
GET /remote/api/skills/list
GET /remote/api/skills/read?id=<64位十六进制技能标识>
```

请求沿用 Remote token/设备密钥鉴权。主机固定请求自己的技能插件列表接口，以姓名、扫描路径和来源生成不含路径的标识；读取正文时重新扫描，主机解析标识并调用固定的原插件 read 路由。客户端不能指定文件路径、cwd、主机 URL、RPC 方法或写动作。

新增网关客户端路由白名单只包含这两个精确路径；主机只接受 GET，查询参数严格校验，响应 `Cache-Control: no-store`。列表只提取显示字段，不返回原始路径、配置或上游错误。输出最多 50 个来源组、500 条技能；正文最多 100,000 字符，上游读取最多 2 MiB、单次等待 10 秒。

主机访问原技能插件时使用受信的本机监听地址和既有 DSH 会话 Cookie；不转发客户端 Cookie 或 Origin。原插件仍保留自身的权限检查。监听在指定非回环网卡或认证不可用时可能拒绝读取，此时 Remote 显示主机拒绝提示，不绕过原插件权限。

没有该数据源时显示“主机未提供技能中心”，不把缺失状态冒充空技能库。插件注册而不提供文件的技能显示元信息及“未提供可读取的文件正文”。

页面离开、页签切换或重开时取消请求；响应与 JSON 读取后再次核对连接身份。列表刷新、详情选择和筛选有独立序号，旧详情不会覆盖后来选择。

## 验证证据

- `npm run check`：461 项，453 通过、8 因环境条件跳过、0 失败。
- 手动提供验证路径后，真实 DSH CLI + 已发布技能插件 0.4.6 + 当前 Remote 主机适配器 + 网关链路通过：从临时技能文件读取列表与正文，识别模型调用停用状态，拒绝路径参数和写操作。没有调用模型。
- 已发布技能插件在独立测试 HTTP 主机中挂载，通过真实网关验证设备密钥读取、错误 token、只读约束、参数校验和资源加载。
- 浏览器检查桌面展示，以及 390×844 手机视口下的正文、搜索、来源筛选和状态筛选；手机页面宽度与视口均为 390，未出现横向溢出。
- 全量检查发现并修复插件中心读取任务锁时的 Windows 瞬时共享冲突；相关后台 worker 状态读取重复运行 12 次全部通过。
- `npm run sync-plugin` 和 `git diff --check` 通过；打包后核对新模块、静态资源和两个 HTML 入口与源码字节一致。

早期浏览器截图使用隔离主机和示例技能，自动 DSH 主机测试使用临时 HOME/profile。后续按用户要求安装到真实 Desktop profile，验证 28 个技能（4 个内置、24 个用户 Agents 技能）、正文读取和鉴权边界；模拟器 App 连接这个真实主机验证界面。没有调用模型，也未做 Android/HarmonyOS 真机验证。

早期预览在 `dist/skills-preview/`。最终版本修正为 **0.7.5-rc.1**，插件包和新 APK 位于 `dist/skills-0.7.5-rc.1/`；Android 显示版本 `0.7.5.rc.1`，versionCode `7051`。Desktop 与 Android 模拟器均已安装这个版本。没有生成新 HAP，也未发布到外部。

用户指出手机“查看技能”会跳回顶部后，取消强制 `scrollIntoView`，改成在点击的卡片内展开；保留列表节点，切换技能时补偿上方详情收起造成的位移。Android API 36 模拟器实际 WebView 测量：列表中部展开前后按钮位置变化 0 CSS 像素，切换下一卡片变化约 0.05 CSS 像素。正文返回后位置仍保持，412 CSS 像素视口没有横向溢出。证据为 `android-scroll-proof.json`、`android-switch-proof.json` 和未修改的 ADB 截图 `android-skills-inline.png`。

最终 APK 的技能资源、入口 HTML 和版本数据与根 `public/` 一致；真实 profile 安装的 13 个关键文件（含 APK）与打包源码一致，其他依赖、bundles 和 `cordis.yml` 保持。备份分别位于 `dist/local-install-2026-10-13-skills/desktop/` 和 `dist/local-install-2026-10-13-0.7.5-rc.1/desktop/`。

## 本轮改动文件

主机和网关：

- `packages/plugin/skills.mjs`（新增适配器）
- `packages/plugin/index.mjs`（注册主机读取路由）
- `gateway.js`、`packages/plugin/gateway.cjs`（精确客户端路由白名单）
- `packages/plugin/plugin-center.mjs`（Windows 锁更新时读取竞态修复）

界面和打包：

- `public/skills.js`、`public/skills.css`（新增共享界面）
- `public/plugin-center.js`、`public/plugin-center.css`（页签与生命周期）
- `public/index.html`、`public/desktop/desktop.html`（资源入口）
- 对应的 `packages/plugin/public/` 六份同步副本
- `package.json`（语法检查、版本与更新说明）、`packages/plugin/package.json`（发布文件与版本）、`package-lock.json`（版本）、`scripts/sync-plugin.mjs`（同步资源）
- `public/version.json`、`public/update.json` 及同步副本、根与插件 APK（本地 RC 产物）

测试和文档：

- `tests/skills.test.js`
- `tests/skills-bridge.test.js`
- `tests/skills-installed.test.js`
- `tests/fixtures/skills-upstream.mjs`
- `tests/plugin-center-ui.test.js`、`tests/plugin-center.test.js`
- 本文

原有未提交文档与前一轮插件中心改动保留。本轮已按用户要求本地安装并验证，未提交、未发布。
