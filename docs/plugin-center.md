# 插件中心（0.7.0-rc.1）

手机端与桌面端：设置 → 插件中心。已安装与发现插件共用当前服务器的认证连接。

## 功能与生效方式

- 已安装：显示 profile 包列表、版本、配置启用状态；展开查看当前 Loader 的实际加载状态。
- 发现插件：查询 npm 的 `dsh-plugin` 关键词目录，支持分页、搜索、完整包名查询、具体版本详情。
- 安装、更新：校验目标版本声明 `dsh.bundle.patch`，执行 DSH 自带 `plugin --profile` 命令，固定版本并禁用安装脚本。
- 启用、停用：修改当前 profile 的 bundle 配置，在后续安装或更新时保留停用名单。需要重启 DSH 后生效，不是热启停。
- 卸载：通过 DSH CLI 移除依赖并同步 bundle 列表。不会删除用户的插件数据目录。
- 核心 `@deepseek-ai/*`、Remote 自身及非 profile 依赖不允许通过此入口修改。
- 需要安装脚本、额外凭据或特殊配置的插件，应在主机上完成这些步骤。市场展示不等于兼容性或安全背书。

## 主机与任务边界

只从运行中的 DSH 根 `baseUrl` 识别 profile，校验 `profiles/<name>/package.json`；只从当前启动路径识别 DSH CLI。无法确认时只读，不猜测 `web`，不允许客户端指定主机路径。

API 位于 `/remote/api/plugins/{state,market,details,operations}`。沿用网关 → DSH 插件鉴权链路；插件端仍校验 Remote token。操作参数只接受包名、精确版本、固定操作类型和请求 ID，不接收命令行片段、URL、Git 地址或本地路径。

任务在独立 Node 子进程执行，窗口关闭或 HTTP 断开不取消任务。每个 profile 同时只允许一个任务；同一请求 ID 可安全重试。客户端连接切换后拒绝继续向原确认页面提交。

记录保存在当前 profile 的 `.remote-plugin-center/`：

- `job-<id>.json`：任务状态与截断后的日志。
- `backup-<id>/`：修改前的 manifest、锁文件、工作区和 patch 文件（存在时）。
- `disabled.json`：通过此入口停用的 bundle。
- `lock.json`：任务互斥锁。

失败不会声称已回滚：包管理器可能已改变依赖，备份只覆盖配置文件。主机崩溃或工作进程被强制杀死时，锁会保守保留；确认相关 Node/pnpm 进程已结束、检查依赖及配置后，由主机管理员处理残留锁。操作记录不会自动清理。

## 验收

`npm run check` 包含参数注入拒绝、未知 profile 只读、鉴权、版本冲突、幂等、互斥、停用保留、失败记录、配置备份及真实独立工作进程测试。

设置 `DSH_TEST_CLI_ROOT` 为安装的 DSH 包目录后，`node --test tests/installed-dsh.test.js` 会在临时 HOME 启动真实 DSH，验证网关到插件中心的 profile 和运行状态链路。

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
