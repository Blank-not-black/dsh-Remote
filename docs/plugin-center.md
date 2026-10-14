# 插件中心

> 源码核对：2026-10-12，仓库 0.7.4。[文档首页](README.md)。


当前手机与桌面独立插件页面共用主题卡片，分类和筛选集中到工具栏；启停开关位于卡片右上角，详情、更新、卸载位于底部操作区。待重启提示集中显示在页面，不对所有插件重复标记。手机单列、桌面自适应双列；键盘焦点和减少动态效果偏好继续保留。

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

## 历史与验证边界

[历史改动与验收记录](archive/plugin-center-history.md)保留旧 RC/实装证据。本轮仅核对源码与全量自动测试，没有重新安装实际 profile、调用付费模型或做 Android/HarmonyOS 真机验证。
