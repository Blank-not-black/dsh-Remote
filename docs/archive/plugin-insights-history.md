# 会话洞察历史改动与验收

> 历史日志：版本、测试数量、实际安装与未提交状态只对应记录所属工作；本轮未复测这些真实环境。

## 本次改动文件

| 文件 | 用途 |
| --- | --- |
| `public/insights.js`、`public/insights.css` | 共用面板、显示校验、连接/请求隔离、主题与布局 |
| `public/app.js`、`public/index.html` | 手机入口、投影刷新及连接切换关闭 |
| `public/desktop/desktop.js`、`desktop.html` | 桌面入口及相同隔离逻辑 |
| `packages/plugin/insights.mjs`、`index.mjs` | 只读费用桥接及字段白名单 |
| `gateway.js` | 精确 Fetch 路由兼容及只读控制设备路由 |
| `package.json`、`packages/plugin/package.json` | 检查命令与插件打包清单 |
| `scripts/sync-plugin.mjs`、`sync-standalone.mjs` | 新资源及桥接模块分发 |
| `tests/insights*.test.js`、`tests/fixtures/insights-*` | 数据校验、鉴权、竞态、真实 DSH/插件隔离验证 |
| `packages/plugin/public/` 相应文件、`gateway.cjs` | 由同步生成的副本 |

## 验收记录

- 全量 `npm run check`，启用本机 DSH 和真实候选插件的隔离测试：**324 项，320 通过、4 跳过、0 失败**。后续增加请求超时后，30 项相关测试再次全通过。
- 真实 **DSH 0.2.0-rc.2 + dsh-context 0.64.0 + dsh-cost-meter 1.8.12**：使用临时 HOME/profile 启动，创建临时空会话，读取真实上下文明细和费用服务；均经实际 Remote 网关成功。npm 包下载校验 SHA-512 后只解压到忽略目录，未安装到用户 profile，未调用收费模型。
- 真实网关/插件路由配合模拟数据源：控制设备鉴权、无凭据泄漏、GET 白名单、拒绝写操作、保留 dsh-context Fetch JSON 均通过。
- 浏览器检查：实际手机 Web 与桌面页面的会话入口、两个页签及数据显示；390px 手机内容宽度与 scrollWidth 一致，没有横向溢出。另验深色主题、键盘左右切换页签与 Esc 关闭/焦点返回。预览中的非零金额和上下文组成均为明确标记的样例数据，不是用户实际账户结果。
- Android：Capacitor 资源同步成功；初次沙箱用户信息读取失败，在完整权限下重试后进入 Gradle，明确失败于 **SDK location not found**。没有生成新 APK，恢复原 `public/update.json` 和版本元数据，保留原 APK。
- 没有提交、部署或发布，保留此前已有的未提交改动。使用现有 `0.7.2-rc.1` 版本制作本地插件预览包；没有发布新版本。

预览、截图、测试日志和插件包保存在被忽略的 `dist/insights-preview/`。鸿蒙、Android 真机安装、带真实消费记录和实际账户额度的端到端验证仍未进行。

## 本地实装（2026-10-07）

按用户后续要求，补齐 SDK 并将三个插件装入当前实际运行的桌面 DSH：

- Android SDK：`C:/Users/<用户名>/AppData/Local/Android/Sdk`，包含官方 Command-Line Tools、Android 36（revision 2）、Build Tools 35.0.0 和 Platform Tools 37.0.1。下载包 SHA-256 与 Google 官方页面一致；设置用户 `ANDROID_HOME` 和被忽略的 `android/local.properties`，无需后续构建再次指定路径。
- 本地测试版本升至 **0.7.2-rc.2**，同步根/插件清单、lockfile、版本与更新说明。`npm run build-app` 成功；新 APK 的 versionName 为 `0.7.2.rc.2`、versionCode 为 `7022`，签名验证通过，签名证书与原 APK 一致。APK 内共用面板资源与当前源码一致。
- 实装目标：`C:/Users/<用户名>/.dsh/profiles/desktop`。已安装并注册 Remote **0.7.2-rc.2**、dsh-context **0.64.0**、dsh-cost-meter **1.8.12**；第三方插件使用此前校验过的 npm tarball，安装禁用脚本。仅在本机 DSH profile 增加插件及其自身依赖，Remote 项目没有新增运行时依赖。
- 备份：`dist/local-install/desktop-before/` 保存原 profile 清单、锁文件、Cordis 配置、workspace 配置和旧 Remote；`repo-before/` 保存本次构建前的版本元数据和旧 APK。其它 Cordis/workspace 配置按字节核对未变，已有 auto-review 本地覆盖 junction 仍存在。
- 重启真实桌面实例后，网关、DSH 上游、mux 和 host 均正常；安装的 54 个 Remote 文件与本地包源一致。真实历史会话可读上下文明细及八条变化记录，并显示官方账户余额、OpenCode Go 额度及套餐等值估算；截图属于实际数据，不再是样例。今日 API 账本为零，本次未发送收费模型请求。
- 实时验证摘要、日志、截图和 RC 插件包见 `dist/local-install/`；网关现已提供新 APK。`adb devices` 没有连接设备，尚未将 APK 装到手机；鸿蒙本批仍未同步面板。
- 未提交、未发布到 npm/GitHub/Gitee；web profile 未更新，本次安装的是正在运行的 desktop profile。
