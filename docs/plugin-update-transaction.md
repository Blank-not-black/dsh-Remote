# 插件更新预检、版本批准与失败恢复

2026-10-19。手机和桌面共用同一插件管理流程；未提交、未部署、未发布。

## 使用流程

1. 选择安装、更新或卸载后，先检查当前锁文件中的 registry 包和目标版本的发布时间，以及当前 profile 的发布年龄设置。
2. 确认页列出真正被拦的包（可能与目标插件无关）、精确版本、发布时间、无需豁免的时间和合并后的规则。涉及豁免或重复规则合并时，必须勾选信任列出版本后才能提交；取消不会执行安装。
3. 后台任务先备份完整 `node_modules` 和控制文件，再按已批准的计划合并精确版本豁免。保持原发布年龄，不新增全版本或通配豁免。
4. 使用当前主机已核验的 DSH CLI 非交互安装，继续禁用安装脚本。结束后合并 pnpm 再次追加的重复项，并检查策略没有超出确认范围、manifest/根 importer/已安装版本一致。只有核验通过才报告完成。
5. 失败后在操作记录点击“恢复更新前状态”，再次确认后恢复完整插件目录和配置。恢复前核对失败现场指纹和 DSH 配置锁；有新改动、活动进程锁、缺失证据或文件占用时停止，保留备份与现场。恢复不执行 pnpm，不重放原更新命令；恢复完成后需重启 DSH。

预检凭据绑定目标动作、包名、版本和控制文件指纹，有效期 10 分钟。确认后配置若改变或凭据过期，需要重新预检。重复提交同一个任务 ID 返回原回执。HTTP 安装/更新/卸载接口要求预检凭据，旧页面会被明确提示升级。

备份位于当前 profile 的 `.remote-plugin-center/backup-任务ID/`，包括插件树快照及 `transaction.json` 中的控制文件内容/缺失状态。恢复任务保留被替换的失败插件树。分离任务和事务模块均保存到 profile 台账，因此 Remote 自更新替换自身包目录后，原 worker 仍可完成记录。

## 当前支持范围

支持标准 pnpm registry 锁文件包标识、本地 `file:` tarball、根 importer、普通 YAML 数值字段、块式精确版本列表和 JSON 形式内联列表。本地 tarball 不查询 registry 发布时间，但会核对锁文件记录的版本与安装版本。发布时间缺失、复杂 YAML/通配策略、其他不支持的来源、超出 1200 条的锁文件、配置被环境变量或 profile `.npmrc` 覆盖等情况会停止并提示主机核对。使用当前 profile 的数值策略，未设置时按 pnpm 24 小时默认值预检；pnpm 仍是最终执行策略的裁决者。

预检检查已有锁文件和目标版本，不实现另一套依赖解析器。新解析出的传递依赖、网络故障、主机外部策略或 Windows 文件占用仍可能使 pnpm 拒绝操作；不会自动扩展豁免或反复安装。后置核验及完整快照用于防止将部分成功当作完成，并为失败提供可核验的恢复入口。若更新前本就不一致，确认页会说明；恢复快照会返回原状态，而非声称已修复此前存在的问题。

## 本轮文件

- 事务实现：`packages/plugin/plugin-transaction.mjs`、`packages/plugin/plugin-center.mjs`。
- 共用界面：`public/plugin-center.js`、`public/plugin-center.css` 及对应插件同步副本、构建标识。
- 分发与路由：`gateway.js`（仅本轮 `/preflight` 路由分类一行）、对应 `packages/plugin/gateway.cjs`、`packages/plugin/package.json`、`scripts/sync-standalone.mjs`。
- 回归测试：`tests/plugin-transaction.test.js`、`tests/plugin-transaction-pnpm.test.js`、`tests/plugin-center-ui.test.js`；自更新夹具补入事务模块：`tests/plugin-center.test.js`。
- 峰谷常驻状态：`packages/plugin/peak-reminders.mjs`、`android/app/src/main/java/com/dshremote/app/PeakReminderService.java`、`PeakReminderPolicy.java`、`tests/peak-reminders.test.js`。
- 本文。工作区原有及其他并行修改保留，没有将其视为本轮实现范围。

## 峰谷常驻通知

常驻通知显示“DSH Remote · 当前峰时”或“DSH Remote · 当前谷时”。主机投影当前状态和完整切换时间表，Android 仅重放这些时间戳，每 30 秒核对；提醒本身的峰/谷方向过滤不影响状态。离线且缓存有效时继续显示状态，并注明使用缓存；规则过期、未同步、插件不可用或旧主机未提供状态时显示未知及原因。周期检查不重复响铃，原提前提醒、去重和限时补发行为保留。状态与规则计算仍由 dsh-cost-meter 语义驱动，没有在 Android 复制计费规则。

## 验证

- 插件事务/管理/界面针对性测试覆盖未批准不能提交、过期/变更拒绝、整锁文件无关包阻塞、退出码成功但文件不一致、完整恢复、失败后新改动保护、活动配置锁、死 worker 恢复、自更新及本地 tarball 兼容。
- 额外真实集成：本机 pnpm 和已安装 DSH CLI，在独立 HOME/profile、回环 mock registry 下复现旧规则阻塞；精确批准后完成实际更新，再注入失败并成功恢复真实安装后的插件目录、控制文件和锁文件。没有访问用户 profile 或外部 registry。日志：`dist/plugin-transaction-real-cli.log`。
- 峰谷 6 项通过，包括完整状态时间表、单方向提醒、真实安装的 cost-meter 1.8.17 pricing 逐点对照、独立 JVM 状态边界/过期/非法时间表验证。
- rc.5 最终全量检查：708 项，697 通过、11 跳过、0 失败；真实 DSH CLI/pnpm 集成及 cost-meter 逐点对照另外显式启用，均通过。日志：`dist/rc5-2026-10-19/check.log`。
- Android `assembleDebug` 成功，APK 签名校验通过，versionCode 8004、versionName `0.8.0.rc.4`。预览沿用工作区现有版本号，不是新发布版本。构建日志：`dist/plugin-transaction-apk-build.log`。
- 配套预览产物在 `dist/plugin-update-preview-2026-10-19/`：`dsh-remote-0.8.0-rc.4-preview.apk`、`dsh-remote-plugin-0.8.0-rc.4.tgz` 和 `SHA256SUMS`。已核对 APK 内当前界面资源、插件包内事务模块和内嵌 APK 一致。只有预览暂存目录的 APK/下载元数据更新，未替换根 `apk/` 或实际安装目录。

没有新增依赖，未改变单文件网关或零构建前端发布形态。未进行真实手机通知栏、息屏和长期后台验证。

后续按用户要求使用 `0.8.0-rc.5` 重新构建并完成本机 Desktop 安装，见 [rc.5 安装报告](rc-0.8.0-rc.5.md)。上面的 rc.4 预览产物记录保留为构建过程快照。
