# 开发指南

[文档首页](README.md) · [模块索引](modules/README.md) · [发布指南](release.md)

## 开发边界

开始前读根 [AGENTS.md](../AGENTS.md)，涉及鸿蒙还需读 [harmonyos/AGENTS.md](../harmonyos/AGENTS.md)。检查 `git status --short`，保留用户及其他工作留下的改动。默认不提交、不安装、不发布。

网关只用 Node 内置模块，WebUI 保持零构建纯 JavaScript；不新增运行时依赖、第三方 Android/HarmonyOS 库或 CDN 脚本。已有 Capacitor、AndroidX 和本地 vendored 资源是仓库现状，不能把“零新增依赖”误写成整个仓库没有依赖。

## 环境与命令

项目 CI 使用 Node 22。插件 manifest 声明 Node ≥18，但这不是全量测试和 Android 工具链在所有 Node 版本上的验证承诺。新 DSH 功能、Zstandard 历史等还取决于实际运行时能力。

```sh
npm ci
npm run check
```

`check` 按 `package.json` 对列出的 JS 做语法检查，再执行 `tests/*.test.js`，并非扫描所有 JavaScript 文件。测试数量随版本变化，以本次运行结果为准。

## 源码与同步

| 源码 | 同步产物/使用方 |
| --- | --- |
| `gateway.js` | `packages/plugin/gateway.cjs` |
| `gateway-stats.cjs` | `packages/plugin/gateway-stats.cjs` |
| 根 `public/` 中同步清单文件 | `packages/plugin/public/` |
| `public/desktop/`、`public/vendor/` | 插件对应目录整体复制 |
| `apk/dsh-remote.apk` | 插件 `apk/` 副本；不存在时 sync 跳过 |
| 插件 `index.mjs`、`client.js`、`plugin-center.mjs`、`insights.mjs` | 插件自有源码，直接维护 |
| 根与插件 README | 各自维护说明，sync 不复制 README |

只改根前端与网关源码，然后：

```sh
npm run sync-plugin
npm run check
git diff --check
```

新增静态文件时检查 `scripts/sync-plugin.mjs` 与页面加载顺序；同步脚本会清理插件 public 中不在清单内的文件。不要手改 `packages/plugin/public/app.js/index.html` 等产物。

## 测试与真实运行

改 JS 前先读对应测试。子进程测试使用 `mkdtemp`、临时 HOME/USERPROFILE/DSH_HOME/`DSH_REMOTE_FS_ROOT`、固定测试 TOKEN、清代理变量，并精确终止子进程后删除临时目录。禁止测试碰真实 `~/.dsh-remote` 或生产反馈源。

测试层级、显式安装版集成测试开关与真机门禁见[测试模块](modules/10-tests-qa.md)。源码字符串检查、VM 行为测试、真实网关与真实 DSH 测试提供不同证据；都不代替 Android/HarmonyOS 系统权限与 UI 生命周期的真机验收。

## Android

需 JDK 21、Android SDK（当前 compile/target SDK 36，最低 SDK 24）及现有 Gradle/Capacitor 工具链。根据本机路径设置 `JAVA_HOME`、SDK 环境或 `android/local.properties`；不要把个人路径提交到仓库。

```sh
npm run build-app
npm run publish
```

`build-app` 准备版本 → Capacitor sync → `assembleDebug`；`publish` 只复制本地 APK、生成哈希/更新元数据、同步插件，不执行 npm 发布。构建会修改版本元数据与派生产物；纯文档修改无需 APK 构建。构建后按当前 Gradle 用户目录停止 daemon，不结束 DSH/网关。

## HarmonyOS

使用现有系统 ArkUI 与系统 SDK，`oh-package.json5` 的运行时 dependencies 为空。工具链、签名、HAP 验证与平台差异见[自构建指南](harmonyos-self-build.md)和[模块](modules/11-harmonyos-app.md)。根 release 不同步该工程的 manifest 版本，也不构建 HAP。

## 文档变更

使用步骤写入用户指南，接口字段和开发边界更新对应模块；验收记录带版本、日期和范围。旧 RC 报告保留历史数据，研究与蓝图明确标记用途。更新所有引用后才移动文件；避免复制维护两份相同操作步骤。第三方许可证声明保留原意。
