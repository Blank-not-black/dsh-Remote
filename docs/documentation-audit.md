# 文档核对记录

核对日期：2026-10-12。根与插件版本 `0.7.4`，HarmonyOS manifest `0.6.26` / `6269`。任务范围为文档更新与必要重组；没有修改运行时代码、依赖、版本元数据或发布流程实现。

## 改动范围

| 分组 | 文件与处理 |
| --- | --- |
| 项目与插件入口 | 根 `README.md`、`README.en.md`、插件两份 README：精简入口，统一安装/平台/主题/导航/限制 |
| 使用指南 | 新增 `docs/README.md`、`getting-started.md`、`usage.md`、`configuration.md`、`troubleshooting.md` |
| 开发维护 | 新增 `development.md`、`release.md`、`compatibility.md`、本文；更新根与鸿蒙 AGENTS 的过时事实，保留硬约束 |
| 模块 | 更新 `docs/modules/README.md` 与 01–11 全部模块；鸿蒙和 Android 模块重写，日期记录归档 |
| 专题 | 更新插件中心、会话洞察、DSH UI 支持、样例和社区介绍 |
| 鸿蒙 | 更新工程 README，新增 `harmonyos-self-build.md`，说明独立版本、签名与真实平台差异 |
| 历史/设计 | RC/兼容性报告加历史边界，蓝图/市场/鸿蒙设计调研加日期与用途；新增 archive 索引及模块、鸿蒙、插件中心、洞察历史 |
| 第三方声明 | 检查根/插件 vendor 的 Morphicons README 与 GSAP NOTICE；保留版本与许可文字，不改第三方声明 |

## 已纠正的事实

- Android ASR 已从当前 WebUI/系统桥移除；鸿蒙仍保留自身诊断。
- 当前手机主导航包括插件页，统计不再占主导航；Web 五套主题，鸿蒙自身四套。
- 根 release 不更新鸿蒙版本或构建 HAP，不能表述为所有平台全面同步。
- 健康/管理读后台快照，快速存活探测不等于新的上游与 Desktop 身份核验。
- mux/host 为独立长轮询；4 秒是任务检查周期，不是固定全量轮询间隔。
- Windows 默认文件根、workspace/junction、UNC 与显式根的授权边界。
- 共享 history/network、缓存隔离、迟到请求、弱网与异常恢复行为。
- `publish` 是本地 APK 准备；`sync-standalone` 会远端推送；`release --dry-run` 仍写文件，`--no-build` 仍提交/推送。
- Release CI 不执行全量 check，不构建 macOS/HAP；compat CI 验证已发布 npm 插件安装挂载。
- Android versionCode 使用有限 RC 槽，任意正整数 RC 不保证同版升级顺序；文档记录问题，没有改实现。
- `sha256.js` 是已有增量 JS 实现，浏览器 APK 校验使用 `crypto.subtle`；整个仓库不等于无已有依赖。

## 本轮验证

`npm run check`：444 项，437 通过，7 跳过，0 失败。跳过为当前 Windows 环境不适用的 4 项 systemd 测试，以及未显式配置路径的真实 DSH、洞察插件和 Desktop 集成测试。Windows 文件真实网关测试已执行通过。

文档整理阶段的结构检查覆盖 51 份 Markdown、206 个本地链接目标、9 个图片引用与 4 段 JSON 示例，均通过；目前文档没有带 fragment 的本地 Markdown 锚点链接。274 处现行文件引用检查通过，双语入口已核对安装、能力与限制。第三方或外部安装路径不当作仓库文件检查，外部 URL 未逐个联网重查。

`npm run sync-plugin` 通过，同步后没有产生运行时代码、静态资源、版本或 APK 的内容差异；`git diff --check` 通过。文档整理阶段只改 Markdown，后续追加的截图与元数据见截图库；没有暂存或提交。

文档整理阶段未构建 APK/HAP/单文件网关，未安装实际 profile，未重启真实服务，未执行设备/浏览器视觉验收，未重新验证 npm/GitHub/Gitee 分发面或第三方最新信息。旧日志只作为历史证据。所有改动保持未提交，没有发布 Wiki。

## 后续截图更新（2026-10-12）

按用户要求追加隔离仿真浏览器截图：手机六页、桌面三页、插件面板、管理页与 Doctor 共 12 张。全部使用当前 0.7.4 界面与示例数据，逐张检查后替换中英文 README 的旧图引用；新增[截图目录与验证范围](screenshots/README.md)及尺寸/哈希清单。浏览器截图不替代 Android/HarmonyOS 真机或真实账户验证，源码行为没有改动。

追加后检查通过：52 份 Markdown、227 个本地目标、23 个图片引用、4 段 JSON 示例、275 处文件引用。12 张 JPEG 尺寸/哈希已验证，临时服务正常退出并清理测试目录，浏览器视口已恢复。新图片与 `docs/screenshots/manifest.json` 的完整清单见截图库；旧图保留。

## Android 模拟器安装与 App 截图（2026-10-12）

经用户授权，已安装 Google 官方 Android Emulator 37.2.12 与 Android 16 / API 36 Google APIs x86_64 镜像（revision 7），并创建专用 Pixel 7 AVD。两份下载包按官方 SHA-1 校验，SDK 安装列表已确认；没有新增项目依赖。

两次软件模式启动均未完成开机，ADB 保持 offline；没有安装 APK，也没有生成 Android App 截图。卡住的模拟器与隔离演示服务已关闭。

随后经用户授权，通过管理员权限启用了 Google 推荐的 [Windows Hypervisor Platform](https://developer.android.com/studio/run/emulator-acceleration#vm-windows)，功能状态从 Disabled 变为 Enabled，执行时使用 `-NoRestart`，没有自动重启电脑。安装命令返回 `RestartNeeded: false`，但当时独立检测仍显示 `HypervisorPresent: false`，模拟器 `-accel-check` 返回代码 6。只读检查确认启动配置已为 `hypervisorlaunchtype Auto`，没有修改 BCD。

用户手动重启后，独立检测确认 `HypervisorPresent: true`、`-accel-check` 返回 0，WHPX 可用；专用 AVD 完成开机，`sys.boot_completed=1`。初次使用 SwiftShader 时模拟器进程崩溃，切换到电脑显卡渲染后完成截图。已安装并运行现有 `apk/dsh-remote.apk`（0.7.4 / versionCode 7049），抽查的十个包内前端资源与当前源码一致，没有重新构建或修改 APK。

新增 7 张 1080×2400 Android App PNG：主页、设置、会话列表、对话、文件、插件与系统键盘。通过正常深链连接隔离演示网关，演示代理补充 App 来源的 CORS 响应；未读取真实 profile 或调用模型。图片由 ADB 直接输出，逐张查看，保留系统栏，没有修改像素。中英文 README 的手机图片已替换，截图库与 manifest 明确区分 7 张 APK 模拟器截图及原 12 张浏览器截图；这不替代实体手机、通知、后台、相机或实际弱网验收。

追加后检查通过：52 份 Markdown、234 个本地目标、30 个图片引用、4 段 JSON 示例；19 张截图的字节数与 SHA-256 全部一致，7 张新增 PNG 尺寸均为 1080×2400。临时辅助脚本语法与 `git diff --check` 通过。测试模拟器正常关闭，隔离演示服务正常退出并清理测试目录；保留专用 AVD 与已安装工具链。生产源码和 APK 没有内容变化，没有暂存或提交。

## 完整文档文件清单

更新 32 份、新增 16 份文档；第三方声明检查后保留。

- `AGENTS.md`
- `README.en.md`
- `README.md`
- `docs/README.md`
- `docs/apk-progress-rc3.md`
- `docs/archive/README.md`
- `docs/archive/harmonyos-development-history.md`
- `docs/archive/module-changes.md`
- `docs/archive/plugin-center-history.md`
- `docs/archive/plugin-insights-history.md`
- `docs/community-introduction.md`
- `docs/compatibility.md`
- `docs/configuration.md`
- `docs/development.md`
- `docs/documentation-audit.md`
- `docs/dsh-0.1.5-compatibility.md`
- `docs/dsh-ui-support.md`
- `docs/empty-session-rc4-and-genui.md`
- `docs/genui-rc5.md`
- `docs/genui-sample.md`
- `docs/getting-started.md`
- `docs/harmonyos-design-reference.md`
- `docs/harmonyos-self-build.md`
- `docs/modules/01-contracts.md`
- `docs/modules/02-gateway.md`
- `docs/modules/03-plugin.md`
- `docs/modules/04-mobile-webui.md`
- `docs/modules/05-desktop-webui.md`
- `docs/modules/06-admin-console.md`
- `docs/modules/07-android-app.md`
- `docs/modules/08-shared-frontend.md`
- `docs/modules/09-build-release.md`
- `docs/modules/10-tests-qa.md`
- `docs/modules/11-harmonyos-app.md`
- `docs/modules/README.md`
- `docs/plugin-center.md`
- `docs/plugin-insights.md`
- `docs/plugin-ui-adaptation-survey.md`
- `docs/release.md`
- `docs/screenshots/README.md`
- `docs/troubleshooting.md`
- `docs/ui-product-blueprint.md`
- `docs/usage.md`
- `docs/windows-drive-access-rc2.md`
- `harmonyos/AGENTS.md`
- `harmonyos/README.md`
- `packages/plugin/README.en.md`
- `packages/plugin/README.md`
