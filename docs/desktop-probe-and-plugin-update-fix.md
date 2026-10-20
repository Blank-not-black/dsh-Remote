# 分支图标、Desktop 探测与插件更新诊断

2026-10-19。源码修复，未部署、未提交、未发布；没有新增依赖或改变单文件网关、零构建前端形态。

## 行为变化

- 分支按钮改用竖直主线与分叉曲线，替换原分享节点图形。手机与桌面共用 `turn-results.js`。
- 新版 DSH 的远程通道 ready 帧可能只提供 home。网关处理 `host.describe` 时，通过自己的主 token 和上游会话 Cookie 读取 DSH 插件的 `/remote/api/host-description`。插件在实际 Host 进程中读取已核验启动包的版本、`process.cwd()`、`ctx.agents.list().length`。不以网关目录、home 或所有历史会话数替代这些字段。接口仅允许鉴权后的 GET，不缓存；旧插件、不完整字段或请求失败时保留通道中已有的真实字段，缺失字段继续显示未知，不改变健康探测或路径打开权限。
- 保留工作区原有的 `immatureReleaseNotice` 改动，补充锁文件中真正被拦的包可能并非更新目标、等待发布年龄窗口、备份位置和未自动回滚提示，增加错误解析与实际 worker 回归测试。不会修改用户的发布年龄策略、豁免或锁文件，也不会自动重试失败安装。

## 最近聊天中的插件更新问题

已只读查看本地 DSH 最近会话 `session-271f5e93-9110-4e18-8758-3737116077d2`。原始报告是另一台 `C:\Users\Billy` 机器在更新 `dsh-cost-meter@1.9.6` 时，锁文件中的 `dsh-remote-plugin@0.8.0-rc.4` 触发 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。

本机 pnpm 源码的 `evaluateVersionPolicy` 确认同名包规则首条命中即返回；写回代码会追加新的精确版本规则。重复规则可能使新版本豁免失效。Remote 非交互执行不能弹出 pnpm 的批准对话；整份锁文件的检查又可能使其他插件更新一并失败。此次修复改进错误诊断，不宣称已修复 pnpm 本身或修改了报告机器的策略。失败后仍应核对主机上的 manifest、lockfile、已安装版本及配置备份。

## 改动文件

- `public/turn-results.js`
- `gateway.js`
- `packages/plugin/index.mjs`
- `packages/plugin/plugin-center.mjs`（包含进入本轮前已有的未提交改动）
- `tests/host-description.test.js`
- `tests/plugin-runtime.test.js`
- `tests/plugin-center.test.js`
- 同步产物：`packages/plugin/gateway.cjs`、`packages/plugin/public/turn-results.js`、`public/build.json`、`packages/plugin/public/build.json`
- 本文：`docs/desktop-probe-and-plugin-update-fix.md`

## 验证与边界

- 针对性测试 34/34 通过。
- `npm run sync-plugin` 完成；上述网关、图标模块及构建标识同步副本逐字节一致。
- `npm run check`：680 项，670 通过、10 跳过、0 失败。日志：`dist/current-fixes-check.log`。
- 使用实际安装的 `D:\dsh_desktop\DeepSeek Harness.exe` 在 Electron Node 模式、独立临时 HOME/profile 中执行探测函数，读取实际 ASAR 内的 Host/Core 包版本均为 `0.2.1-rc.1`，返回临时进程实际目录和附加会话数 0。该验证没有启动或修改用户 Desktop profile。
- 额外设置 `DSH_TEST_COST_ROOT` 指向本机已安装的 `dsh-cost-meter@1.8.17`，峰谷提醒 5 项全部通过，包含与实际 pricing 实现的逐点对照。没有核验报告机器的 1.9.6 安装状态或通知真机行为。
- `git diff --check` 通过。当前没有运行中的 DSH Desktop，未进行部署后的界面验证；未构建新 APK/RC，也未提交、推送、打 tag 或发布。
