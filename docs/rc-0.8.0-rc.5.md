# 0.8.0-rc.5 本地构建与安装

2026-10-19，按用户要求从工作区当前改动构建并安装到实际 DSH Desktop profile。没有 Git 提交、推送、tag、npm/GitHub 发布或 Gitee 同步。

## 内容与文件

包含插件安装/更新/卸载预检、精确版本批准、完整备份与手动恢复；Android 常驻通知显示当前峰时/谷时；分支图标与 Desktop 元信息探测修复；以及工作区已有的 Windows 登录自启动设置。事务与峰谷实现文件清单和验证边界见 [实现报告](plugin-update-transaction.md)。保留了其他并行修改。

本轮版本文件：根 `package.json` 的 version/updateNotes、`package-lock.json` 的两个根版本、`packages/plugin/package.json`、`public/version.json`、`public/update.json` 及插件同步副本；APK/构建标识同步更新。为实际 profile 中的本地 tgz 依赖补充 `packages/plugin/plugin-transaction.mjs` 的锁文件兼容及 `tests/plugin-transaction.test.js` 回归覆盖。所有代码和版本修改仍未提交。

## 产物与门禁

- 版本 `0.8.0-rc.5`；Android `com.dshremote.app`，versionCode **8005**，versionName **0.8.0.rc.5**。Gradle 构建成功，APK v2 签名验证通过。
- `npm run check`：708 项，697 通过、11 跳过、0 失败；`git diff --check` 通过。
- 三处 APK（构建输出、根 apk、插件内嵌）一致；插件包中的事务、峰谷模块与当前源码一致。安装后 81 个文件逐字节核对一致。
- APK：`dist/rc5-2026-10-19/dsh-remote-0.8.0-rc.5.apk`，SHA-256 `da581377f028b765e48b1dbef311054797b76db6c635a7fb1d2182122b47a252`。
- 插件：`dist/rc5-2026-10-19/dsh-remote-plugin-0.8.0-rc.5.tgz`，SHA-256 `57212eab6d320f5d998fc945312a8b824bd1a593466e777f317d6319385480aa`。
- 构建/检查/安装/验签及 `SHA256SUMS` 均保存在同一产物目录。

## 本地安装与运行核验

- 实际应用：`D:\dsh_desktop\DeepSeek Harness.exe`；实际 profile：`C:\Users\blank\.dsh\profiles\desktop`。
- 先备份 profile 的 manifest、lockfile、workspace 和 cordis 配置以及旧插件至 `dist/local-install-2026-10-19-0.8.0-rc.5/`。
- 安装前确认无运行会话。校验主进程/Host 的路径和出生时间后，使用鉴权 shutdown 停网关，停止确认的 Desktop/Host。pnpm 离线移除旧本地 tarball 引用后安装 rc.5 tarball；安装脚本禁用。其他 manifest 项、cordis 配置与 workspace 配置逐项核对未变，随后重启同一 Desktop。
- 运行网关 PID **13796**，版本 **rc.5**；上游 **127.0.0.1:54878**，HTTP 200，mux/host collector 正常，真实客户端 WS 票据握手均成功。验证器退出后网关仍运行。
- 读取实际服务资源并比较插件安装文件哈希；gzip、ETag/304 正常。RC 更新元数据通过 `/update.json?local=0.8.0-rc.5` 验证，下载 APK 哈希匹配新包。
- `host.describe` 返回实际 DSH **0.2.1-rc.1**、Host 工作目录及非空数值的附加会话数（0 也有效），不再全部未知。
- 实际插件页 HTTP 200，状态为 `mode: gateway`、`gatewayInstalled: true`；`preflight/restore` 能力可见。对当前已安装 cost-meter 版本进行只读预检并生成绑定计划成功（HTTP 202），没有提交安装或修改豁免，原 profile 一致性无告警。
- 实际峰谷接口 available/enabled 均为 true，提供当前状态及 **20** 个后续状态切换。

证据：`live-verification.json`、`live-preflight.json`、`installed-verification.json`。上述 PID/端口属于此次验证快照。

## 验证边界

本次实际安装对象是 Windows DSH Desktop 插件与网关。APK 已构建并由本机网关提供下载，未安装到手机；新常驻通知栏显示、息屏和长期后台仍待手机真机验收。Desktop 原生窗口文档可通过辅助功能读取，但原生截图/点击因捕获和坐标几何不可用未完成；没有把 HTTP 页面核验等同于完整原生界面点击验收。未构建 HAP 或独立网关二进制。
