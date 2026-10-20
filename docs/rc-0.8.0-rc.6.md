# 0.8.0-rc.6 本地构建与部署

2026-10-20，从当前未提交工作区构建并部署至实际 Windows DSH Desktop profile。包含本轮 Markdown、运行错误、思考过程、历史补同步，以及用户追加反馈的肥鱼皮肤归档按钮透出修复。没有提交、推送、tag 或对外发布。

## 最终产物

最终采用 `dist/rc6-2026-10-20-archive-fix/` 中的包，替代同日较早的初始 rc.6 构建。两次构建均为本地预览，版本保持 `0.8.0-rc.6`。

- APK：`dsh-remote-0.8.0-rc.6.apk`，10,501,950 字节，SHA-256 `57053e0eb52b79d7718f57afc1a6e6499a017b67f103591f97965cee851bdab6`。
- 插件：`dsh-remote-plugin-0.8.0-rc.6.tgz`，SHA-256 `78cb3219f188664637a9e7a1cbdb1fd0e10ab6a9f2762c58628b5b1c6cf574e7`。
- Android：`com.dshremote.app`，versionCode **8006**，versionName **0.8.0.rc.6**，APK v2 签名验证通过。
- APK 的 75 项静态资源、内嵌版本及插件包的 93 个文件均核对一致。APK、根 apk 目录和插件内嵌 APK 内容相同。

## 肥鱼皮肤归档修复

真实页面复现了红色归档按钮透出：透明 `.session-card` 无法遮住其背后的 `.sc-archive-btn`。修复位于 `public/skins/blue-fish/skin.css`：关闭时按钮位于行外，由现有 overflow 裁剪；滑动时跟随 `--swipe-x` 进入；`revealed` 时完整展开。保持透明底纹，同时覆盖最近会话和工作区列表。

隔离样例核验了关闭、半滑、完整展开及展开后点击；未对用户真实会话执行归档。部署后重新加载实际肥鱼主题页面，确认关闭状态不再露出红色按钮。截图：`dist/rc6-2026-10-20-archive-fix/live-fish-fixed.png`。

## 门禁与运行证据

- 最终全量检查：761 项，**747 通过、14 跳过、0 失败**。之前两项 supervisor 失败在允许 Windows 进程身份查询后通过；没有为此改变进程保护实现。
- 真实 DSH 0.2.1-rc.1 隔离集成测试在初始 rc.6 构建后通过，包含失败回合、思考记录、RPC、分支、子代理和 APK SHA-256；最终皮肤补丁后重新运行全量门禁。
- `git diff --check` 通过。
- 实际 Desktop：`D:\dsh_desktop\DeepSeek Harness.exe`；实际 profile：`C:\Users\blank\.dsh\profiles\desktop`。进程身份和实际 `host.describe` 均确认该 profile。
- 最终补丁替换前确认无运行会话或插件任务；鉴权关闭旧网关，仅停止已核验身份的 Desktop 子进程树，再安装本地包并重启。
- 最终备份：`dist/local-install-2026-10-20-0.8.0-rc.6-archive-fix/`，包含配置、原 node_modules 和本地插件源。93 个安装文件逐份核对，其他插件和 profile 配置未变。
- 首次安装离线缓存缺少 acorn 元数据，补取现有 registry 的校验元数据后通过，未放宽供应链策略；最终补丁安装使用离线方式并禁用脚本。
- 运行网关版本 rc.6，PID **22048**；上游 `http://127.0.0.1:62262` HTTP 200；mux/host collector 及真实客户端票据握手通过。
- 17 项实际服务资源内容一致，gzip 和 ETag/304 通过，插件页面 HTTP 200、状态 `mode: gateway`、`gatewayInstalled: true`。
- `/update.json?local=0.8.0-rc.6` 与当前元数据一致，实际下载 APK 哈希匹配最终包。验证进程退出后再次确认网关、上游及双事件流仍正常。

以上 PID/端口是此次验证快照。机器证据为最终备份目录中的 `installed.json`、`live.json`，以及最终产物目录中的构建、检查、签名与资源验证记录。

## 改动范围与边界

本次版本/构建修改：根 `package.json` 的 version/updateNotes、`package-lock.json` 的根版本、`packages/plugin/package.json`、`public/version.json`、`public/update.json`、`public/build.json`、插件同步副本及 APK。追加皮肤修复修改 `public/skins/blue-fish/skin.css` 并同步；本轮功能源码与测试清单见 [运行错误与同步核查](runtime-errors-reasoning-sync.md)。保留其他已有未提交改动。

本地 Desktop 插件与网关部署已完成。APK 由本机网关提供下载，未替用户安装到手机；若已安装较早的 rc.6，需重新下载最终 APK 覆盖安装。未构建 HAP 或独立网关二进制，未发布 npm/GitHub/Gitee。
