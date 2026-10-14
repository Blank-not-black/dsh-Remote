# 插件中心历史改动与验收

> 历史日志：版本、测试数量、实际安装与未提交状态只对应记录所属工作；本轮未复测这些真实环境。

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
