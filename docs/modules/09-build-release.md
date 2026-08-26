# 构建、同步与发布模块

> 状态：现行流程
>
> 入口：`package.json`、`scripts/`

## 1. 模块定位

本模块负责把源码变成插件、Android APK、独立网关和发布元数据。它不负责业务功能，也不代表“构建成功”就等于“已安装/已发布”。

## 2. 代码结构

| 文件 | 作用 |
| --- | --- |
| `scripts/sync-plugin.mjs` | 根 `public/`、网关、统计和 APK 同步到插件 |
| `scripts/prepare-version.mjs` | APK sync 前写入版本和更新信息 |
| `scripts/publish.js` | 复制 APK、计算 SHA-256、写 update/version |
| `scripts/sync-standalone.mjs` | 生成/同步独立插件仓库 |
| `scripts/release.mjs` | bump、构建、同步、commit、push、tag |
| `scripts/sync-central-announcements.sh` | 中央公告源同步 |
| `scripts/sync-gitee-*.sh` | GitHub 后的 Gitee 代码/附件同步 |
| `scripts/summarize-polls.mjs` | 反馈/投票数据汇总 |

## 3. 当前命令

```text
npm run check          语法检查 + tests/*.test.js
npm run sync-plugin    同步 public、gateway.cjs、统计和 APK
npm run build-app      准备版本 + Capacitor sync + Gradle APK
npm run publish        复制 APK、写更新元数据、同步插件
npm run build-bin      构建 Linux/Windows 单文件网关
npm run release x.y.z  bump + build + sync + commit/push/tag
```

## 4. 具体实现方式

`sync-plugin.mjs` 以根 `public/` 为源，把列出的文件和 `desktop/vendor` 目录复制到 `packages/plugin/public/`，再复制 `gateway.js -> gateway.cjs` 和 `gateway-stats.cjs`。它还会把 `apk/dsh-remote.apk` 放入插件包。

版本流从根 `package.json` 开始，写入 `packages/plugin/package.json`、`package-lock.json`、`public/version.json` 和 `public/update.json`。APK 构建前必须先写版本，否则 APK 内资源可能滞后。

`publish.js` 只在已有 APK 时运行，计算 sha256 并写入 update metadata。`release.mjs` 会执行 git add/commit/push/tag，因此是明确的外部写入流程，不能在普通修复任务中顺手调用。

## 5. 制作目的

- 保持 monorepo 源码、插件包和 APK 内前端的一致性。
- 让 git 源安装、npm 包、独立网关和 Android 版本使用同一版本来源。
- 把发布的不可逆动作集中到显式命令，避免把本地验证误当成正式发布。

## 6. 接口与数据契约

构建与同步的主要契约是：根 `public/` -> `packages/plugin/public/`，`gateway.js` -> `gateway.cjs`，根版本 -> plugin/package-lock/version/update 元数据，APK -> `apk/` 和插件 APK 副本。

## 7. 发布阶段边界

| 阶段 | 允许动作 | 默认不做 |
| --- | --- | --- |
| 修复/功能 | 改源码、测试、同步、门禁 | bump、commit、发布、安装 |
| RC 构建 | 递增 rc、构建、完整性校验 | 自动安装、正式 Release |
| 本地实装 | 安装指定插件或 APK、重启相关服务、核对版本/health | 代替正式发布 |
| 正式发布 | 用户明确授权后 release/CI/Gitee | 未经授权的外部写入 |

## 8. 边界与禁止事项

- 不直接编辑 `packages/plugin/public/*`。
- 不用 `--no-build` 掩盖未同步的插件产物；no-build 也必须 sync。
- 构建 APK 使用 JDK 21 和项目 `.gradle-home`；构建后停止 Gradle，但保持 DSH Web/网关不受影响。
- RC、正式版、npm、GitHub Release、Gitee 和本地 profile 是独立结果，报告时分别说明。
- 不把 token、部署凭据或 Gitee token 写进命令、日志、文件或回复。

## 9. 测试与验收

- 源码修改至少执行 `npm run sync-plugin`、`npm run check`、`git diff --check`。
- RC 额外核对 APK 三份副本 SHA-256、APK 内 version.json、versionName/versionCode 和 Gradle 状态。
- 本地插件实装额外核对 profile 实际包版本、网关 PID/端口、`/health`、`events.mux/host`。
- 正式发布额外核对 CI、Release 资产、Latest/Prerelease、npm 和 Gitee。

## 10. 修改前检查清单

- 本次只需要同步，还是需要构建/安装/发布？
- 是否已累计更新说明，是否应递增 RC？
- 源码和插件副本是否可以用 `cmp` 验证？
- 是否有未提交用户改动需要保留？
- 外部写入是否得到明确授权？

## 11. 未决事项

- 当前 release 脚本会自动 commit/push/tag；未来若拆分“本地准备”和“正式发布”，需保留现有发布兼容性并重新定义授权边界。
