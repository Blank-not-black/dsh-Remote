# 插件中心

2026-10-03 布局更新：手机页面与桌面弹窗共用主题卡片，分类和筛选集中到工具栏；启停开关位于卡片右上角，详情、更新、卸载位于底部操作区。待重启提示集中显示在页面，不对所有插件重复标记。手机单列、桌面自适应双列；键盘焦点和减少动态效果偏好继续保留。

手机端：底部“插件”独立页面（替换原 Token 统计页）；桌面端：侧栏“插件”独立页面。0.7.3 移除了设置中的重复插件入口，详情原地展开，并在刷新后保留展开状态与阅读位置。已安装、添加插件和内置插件共用当前服务器的认证连接。

## 功能与生效方式

- 已安装：提供名称/描述和配置状态筛选、版本、详情和组件运行状态；内置插件单独查看，区分配置启用与实际运行，并提示待重启。
- 发现插件：查询 npm 的 `dsh-plugin` 关键词目录，支持分页、搜索、完整包名查询、具体版本详情。
- 安装、更新：校验目标版本声明 `dsh.bundle.patch`，执行 DSH 自带 `plugin --profile` 命令，固定版本并禁用安装脚本。
- 启用、停用：修改当前 profile 的 bundle 配置，在后续安装或更新时保留停用名单。需要重启 DSH 后生效，不是热启停。
- 卸载：通过 DSH CLI 移除依赖并同步 bundle 列表。不会删除用户的插件数据目录。
- 核心 `@deepseek-ai/*`、Remote 自身及非 profile 依赖不允许通过此入口修改。
- 需要安装脚本、额外凭据或特殊配置的插件，应在主机上完成这些步骤。市场展示不等于兼容性或安全背书。

## 主机与任务边界

只从运行中的 DSH 根 `baseUrl` 识别 profile，校验 `profiles/<name>/package.json`；只从当前启动路径识别 DSH CLI。桌面端验证当前 Electron host、安装中的 `@deepseek-ai/dsh-desktop-host` 与 desktop runtime 版本、启动参数中的运行时目录和 profile 根目录，再使用该安装自带的 `lib/cli.js`。无法确认时只读，不搜索全局 CLI 或 PATH，不猜测 `web`，不允许客户端指定主机路径。

API 位于 `/remote/api/plugins/{state,market,details,operations,recover}`。沿用网关 → DSH 插件鉴权链路；插件端仍校验 Remote token。操作参数只接受包名、精确版本、固定操作类型和请求 ID，不接收命令行片段、URL、Git 地址或本地路径。

任务在独立 Node 子进程执行；桌面端显式使用 Electron Node 模式和桌面版自带 CLI/包管理器，支持 ASAR 中的官方入口。窗口关闭或 HTTP 断开不取消任务。每个 profile 同时只允许一个任务；同一请求 ID 可安全重试。客户端连接切换后拒绝继续向原确认页面提交。

记录保存在当前 profile 的 `.remote-plugin-center/`：

- `job-<id>.json`：任务状态与截断后的日志。
- `backup-<id>/`：修改前的 manifest、锁文件、工作区和 patch 文件（存在时）。
- `disabled.json`：通过此入口停用的 bundle。
- `lock.json`：互斥锁，记录启动者、工作进程与 CLI 子进程 PID。
- `launch-<id>.json`：启动 PID 的独立记录，避免启动者覆盖工作进程锁状态。
- `worker-<id>.log`：权限受限的后台任务启动错误日志，供主机排查启动失败；不直接作为接口响应返回。
- `recovered-lock-<id>.json`：人工恢复时保留的旧锁记录。

失败不会声称已回滚：包管理器可能已改变依赖，备份只覆盖配置文件。已知工作进程和 CLI 均退出后，状态查询或下次提交标记任务中断并自动解除锁，任一进程存活则保留锁。旧版本缺少进程记录的锁提供“恢复旧任务”：需先在主机确认安装进程已退出，再明确确认解除；服务端校验锁 id、配置 revision 和确认字段，并保留旧锁备份。不能通过超时推断安装已结束。操作记录不会自动清理。

## 验收

`npm run check` 包含参数注入拒绝、未知 profile 只读、鉴权、版本冲突、幂等、互斥、停用保留、失败记录、配置备份及真实独立工作进程测试。

设置 `DSH_TEST_CLI_ROOT` 为安装的 DSH 包目录后，`node --test tests/installed-dsh.test.js` 会在临时 HOME 启动真实 DSH，验证网关到插件中心的 profile 和运行状态链路。

设置 `DSH_TEST_DESKTOP_EXE` 为桌面程序、`DSH_TEST_DESKTOP_CLI` 为同一安装中的 `dsh-desktop-host/lib/cli.js` 后，`tests/desktop-plugin-center.test.js` 在临时 HOME/profile 验证真实 ASAR 入口、Electron 独立工作进程，以及安装 → 停用 → 更新（保持停用）→ 启用 → 卸载。全程固定版本、禁用安装脚本，不调用模型。卸载使用 pnpm 11 支持的 `--config.ignore-scripts=true`，安装和更新仍使用 `--ignore-scripts`。

本地 APK 构建需要 Android SDK 和现代 JDK。没有生成新 APK 前保留原 `public/update.json`，不把已有 APK 标成 RC。`npm run build-app` 成功后再运行 `npm run publish` 生成与新 APK 匹配的更新元数据。

## 本次改动文件

| 文件 | 内容 |
| --- | --- |
| `packages/plugin/plugin-center.mjs` | 新增 profile 管理、npm 目录查询、持久化任务和独立工作进程 |
| `packages/plugin/index.mjs` | 挂载认证后的插件中心 API |
| `public/plugin-center.js`、`public/plugin-center.css` | 手机与桌面共用插件中心 |
| `public/index.html`、`public/app.js` | 手机入口与连接绑定 |
| `public/desktop/desktop.html`、`public/desktop/desktop.js` | 桌面入口与连接绑定 |
| `scripts/sync-plugin.mjs` | 同步新增前端资源 |
| `package.json`、`package-lock.json`、`packages/plugin/package.json`、`public/version.json` | RC 版本、检查命令及打包文件清单 |
| `tests/plugin-center.test.js` | 新增管理与任务测试 |
| `tests/plugin-runtime.test.js`、`tests/installed-dsh.test.js` | 补充鉴权、只读和真实 DSH 集成验证 |
| `packages/plugin/public/` 对应文件 | 由同步脚本生成的副本 |
| `docs/plugin-center.md` | 功能边界、恢复方式和验收记录 |

## 2026-09-18 本地验收记录

- 全量 `npm run check`：201 项，196 通过，5 按条件跳过，0 失败。
- 启用真实 DSH 的隔离集成测试：1 项通过；确认 profile、运行状态、网关鉴权以及原 APK 的下载哈希。
- 浏览器验收：桌面和 390px 手机端入口、npm 搜索、详情、安装确认、失败记录和主题显示。
- 临时 profile 内实际执行：安装 `dsh-remote-picker@0.1.1` → 停用 → 更新同版本（保持停用）→ 启用 → 卸载，均成功；未对用户的实际 profile 操作。
- 临时 DSH、网关及临时数据已清理。
- 插件 RC：`dist/dsh-remote-plugin-0.6.27-rc.1.tgz`；哈希：`dist/plugin-center-SHA256SUMS.txt`。包中 APK 仍为原有版本。
- 新 APK 未生成：使用现代 JDK 后，构建停在 `SDK location not found`。Android 真机及 Linux 实测仍待完成。
- 未提交、未部署、未发布。

## 2026-10-07 桌面管理适配与本地实装

- 本地 RC **0.7.2-rc.3**：验证当前桌面 host 与 profile 后，使用该 Desktop 安装自带的官方管理 CLI；后台任务显式启用 Electron Node 模式。没有新增依赖，没有修改 DSH 安装目录或放开客户端传路径。
- 全量 `npm run check` 启用真实 DSH、洞察插件及桌面 CLI 隔离测试：**327 项，323 通过、4 跳过、0 失败**。临时 HOME 内真实执行安装、停用、更新、启用、卸载；覆盖 ASAR 路径及实际独立 Electron 工作进程。测试结束清理临时 profile 和子进程。
- 已备份并更新实际 `~/.dsh/profiles/desktop` 的 Remote 插件；本机 `/remote/api/plugins/state` 返回 `writable:true`，原 CLI 不可用提示消失。实际浏览器管理界面完成 dsh-context 停用、启用，两项任务均已完成；恢复原 bundle 顺序后，两个洞察插件继续启用且没有待重启配置差异。
- 核心插件和 Remote 自身继续只读；安装脚本继续禁用，配置启停继续要求重启后生效。现场未卸载用户插件，也未调用收费模型；安装、更新和卸载使用隔离 profile 验证。
- 用户 `cordis.patch.yml`、workspace 配置及已有 auto-review 覆盖 junction 保留；备份在 `dist/desktop-adaptation/desktop-before/`。DSH 启动和 Include Loader 会重写派生的 `cordis.yml`，该文件不是用户 patch，未将其自动生成内容误当作用户配置变更回滚。构建前版本元数据及旧 APK 在 `repo-before/`。
- Android APK 构建和签名验证成功，版本 **0.7.2.rc.3**（versionCode **7023**）；本地 RC 包、截图、日志与验证摘要在 `dist/desktop-adaptation/`。没有连接 Android 设备，未手机装机；鸿蒙本次没有新增改动。
- 本次文件：`packages/plugin/plugin-center.mjs`、`tests/plugin-center.test.js`、`tests/desktop-plugin-center.test.js`、`tests/fixtures/desktop-plugin-center.mjs`、本文，以及版本清单/更新元数据/APK 的同步产物。没有提交或公开发布。
