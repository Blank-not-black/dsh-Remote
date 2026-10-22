# 构建与发布

[文档首页](README.md) · [开发指南](development.md)

对照 `scripts/release.mjs`、`build-app.mjs`、`publish.js`、`prepare-version.mjs` 及 `.github/workflows/release-build.yml`；基线 `0.7.4`。

## 命令的实际作用

| 命令 | 动作与副作用 |
| --- | --- |
| `npm run sync-plugin` | 本地复制前端/网关/统计；已有 APK 时复制 APK |
| `npm run build-app` | 写版本元数据、Capacitor sync、Gradle `assembleDebug` |
| `npm run publish` | 本地复制 APK、写 SHA-256/update/version、同步插件；不发布 npm |
| `npm run build-bin` | pkg 打包 Windows/Linux 网关，含 `--no-bytecode --public-packages "*" --public` |
| `npm run sync-standalone` | 在临时目录生成独立插件仓库并推送；需要已有部署配置 |
| `npm run release <version>` | bump、构建、sync、`git add -A`、commit、push main、强制更新并推送 tag |
| `npm run release <version> -- --dry-run` | **仍写本地版本文件**，只是提前停止提交/推送；不是只读预览 |
| `npm run release <version> -- --no-build` | 仍 bump/sync/提交/推送/tag；保留旧 update/APK 等待 CI 构建 |

普通开发与文档任务不执行 release、standalone 推送或镜像同步。发布前枚举 `git add -A` 将包含的完整范围，并取得用户对该范围的明确接受；不要混入本机材料、凭证或不属于本次发布的改动。

## RC 准备与版本流

版本格式为 `x.y.z` 或 `x.y.z-rc.N`，N 为正整数。先 RC 构建与真实设备验收，再正式发布。

1. 更新根 `package.json` 的 `version/updateNotes` 与插件版本、lockfile 根版本。
2. APK 构建前 `prepare-version.mjs` 生成 `public/version.json/update.json`；不要把旧 APK 标为新版本。
3. `npm run build-app` 完成后运行 `npm run publish`，得到对应 APK 哈希与插件副本。
4. 执行源码门禁、同步一致性与产物核验。需要本地 tgz 时在插件目录执行 `npm pack`，不对外发布。
5. 核对 APK manifest 与内嵌 version/static 文件，记录 Android 真机结果；独立二进制需下载/运行验证，构建成功不能代替启动验证。

APK 常用路径：`android/app/build/outputs/apk/debug/app-debug.apk`、`apk/dsh-remote.apk`、`packages/plugin/apk/dsh-remote.apk`。三者内容哈希应一致。APK 不放进 `public/`，避免被再次打入 App assets。

Android versionName 将 RC 连字符转换为点。当前 versionCode 公式为 `major*100000 + minor*1000 + patch*10 + (rc或9)`：它只保证 rc.1–rc.8 低于同版正式版，rc.9 与正式版相等、更大 RC 会跨槽。发布脚本允许任意正整数 RC，因此多轮 RC 必须额外核对升级顺序，不能宣称该公式对所有 RC 单调。文档核对没有修改这个实现。

## 正式发布与 CI

只有明确授权发布时才执行：

```sh
npm run release <version>
```

脚本提交当前工作区的全部非忽略变更，推送 `origin main`，使用 `tag -f` 与强制推送 tag；没有自动替用户选择分支或判断全部改动是否应发布。已有 tag 的替换也需要符合用户接受的发布范围。

CI 先等待 Windows 文件专项门禁；随后 Node 22/JDK 21 环境执行安装、插件同步一致性、Android 构建、本地 publish 和 Windows/Linux 二进制构建，并上传本次构建的公共资产。macOS 任务复用 `macos-build.yml`：在 Apple Silicon runner 上先执行全量 `npm run check`，再下载相同 APK 与版本元数据、构建 arm64 网关，完成 ad-hoc 签名、验签和隔离启动/静态资源/关闭冒烟。所有平台成功后，发布任务汇总资产、同步插件，再执行独立插件仓库同步、SHA256SUMS、GitHub Release 和 npm 发布；macOS 失败会阻止发布。本地全量门禁仍不能省略，CI 不替代用户真机与完整 DSH 集成验收。独立仓库同步位于 Release 上传之前，失败可能阻塞后续步骤；npm 在资产上传后执行，npm 失败不撤销已上传资产。

主发布工作流资产为 `dsh-remote.apk`、`dsh-remote-linux-x64`、`dsh-remote-win-x64.exe`、`dsh-remote-macos-arm64` 和 `SHA256SUMS.txt`。macOS 目前仅 Apple Silicon，产物未做 Apple 公证；首次运行见[安装指南](getting-started.md#独立网关)。`macos-preview.yml` 保留手动预览入口，复用相同的 macOS 构建与验证步骤，发布到独立预览 tag。Intel Mac 可使用 npm 插件或 Node.js 源码方式；HAP 不在此流程内。工作流修改需要提交、推送后才在线生效。

RC 标记为 prerelease，npm 用 `next`；稳定版用 `latest`。若精确 npm 版本已存在，CI 跳过发布，这不自动证明 dist-tag 正确。

用户明确要求 RC 发布到 latest 时，可在该次发布期间将仓库变量 `RELEASE_CHANNEL` 设为 `latest`；现有工作流会将 GitHub prerelease 设为 false，并使用 npm latest。完成后恢复原变量状态，避免影响后续普通 RC。另需读回 GitHub `/releases/latest` 和 npm dist-tag，不能只看 CI 成功。

`public/build.json` 的构建标识以源码内容计算，文本统一为 LF、路径统一为 `/` 后排序，保证 Windows 本机构建与 Linux CI 的插件同步检查一致。

## 发布后独立核验

| 分发面 | 至少确认 |
| --- | --- |
| 本地/Git tag | 版本、实际提交、tag 指向与接受范围 |
| GitHub | CI 状态、Release prerelease/latest、资产可下载及 SHA256SUMS |
| npm | 精确版本、dist-tag、tarball 内容与 registry integrity |
| 独立插件仓库 | 实际推送版本与文件读回 |
| Gitee | 代码与 release 附件分别读回；未同步须单独报告 |
| 实际 profile/设备 | 若明确要求安装，先备份，再安装/重启，核对真实版本、health、双事件流和 UI |

Gitee 由本地 `scripts/sync-gitee-code.sh` 与 `sync-gitee-release.sh` 在 GitHub 发布后单独执行，需要已有 `GITEE_TOKEN` 环境配置；不要输出凭证。脚本会做远端写入与发布记录维护，执行前读当前脚本。附件配额不足时按明确接受的保留范围处理旧版本，不把 GitHub 成功当作镜像成功。
