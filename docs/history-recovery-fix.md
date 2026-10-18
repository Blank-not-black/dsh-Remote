# rc.4 历史空白与返回阻塞补修

日期：2026-10-18。保留 DSH 接力改动，以下为本轮补修；版本仍为 `0.8.0-rc.4`，未提交、未公开发布。后续按用户“本地实装”请求完成本机 Desktop 安装，见下文。

## 行为与原因

- 手机端返回原先等待历史加载及归档请求，桌面端也会等待归档请求。两端现在先切回列表，再做原有的空会话清理；手机端取消全局 pending 锁，旧清理完成不会覆盖后来打开的会话。
- 未加载、加载中或显示失败的历史不能作为空会话清理依据；草稿、附件、运行任务及队列仍受原有保护。
- DSH 接力补上了远端响应处理异常，但最终 DOM 渲染在保护范围之外。现在两端只在渲染完成后报告已同步；失败清除 loading，显示错误和重试。整体渲染失败时重置视图缓存，避免重试命中已脱离 DOM 的旧节点。
- 共享 HistoryView 隔离每一条消息的渲染异常，保留正常记录，为坏记录显示安全文本占位及重试。相同对象在失败后允许重新渲染。
- 本地缓存恢复抛错时仍继续读取远端历史，避免打开会话直接中断。

这些缺口已通过实际源码调用测试确认。此前抓取的用户原始历史在桌面 Chromium 可以显示，尚不能证明它们就是截图中 Android 空白的唯一原因；手机原始操作仍需安装此包复测。未修改用户原始会话日志。

## 本轮文件

- 源码：`public/app.js`、`public/history.js`、`public/index.html`、`public/desktop/desktop.js`、`public/desktop/desktop.html`。
- 测试：新增 `tests/back-navigation-recovery.test.js`；扩展 `tests/history-load-recovery.test.js`、`tests/history-ui.test.js`；更新 `tests/session-list-ui.test.js`、`tests/activity-group-ui.test.js` 中对应旧行为断言。
- 上述五个前端源文件的 `packages/plugin/public/` 副本通过 `npm run sync-plugin` 自动同步，未手工修改。
- 本报告。既有脏工作区中的其他功能改动继续保留。

## 验证及产物

- 针对性测试：48 通过，0 失败。
- `npm run check`：668 项，658 通过、10 跳过、0 失败。日志：`dist/rc4-blank-history/fix-check.log`。
- 隔离浏览器：三条历史中间一条消息格式异常，前后两条正常显示，状态为显示失败且提供重试；点击返回回到列表。模拟上游修复后重新打开，三条全部显示。证据：`history-error.png`、`history-recovered.png`。重试按钮及缓存异常恢复另有源码调用回归测试。
- Android Gradle 构建成功，APK v2 签名校验通过，包名 `com.dshremote.app`，versionCode `8004`，versionName `0.8.0.rc.4`。
- APK 内五个前端文件的 SHA-256 与当前源码逐个一致。清单：`dist/rc4-blank-history/fix-manifest.json`。
- 修复 APK：`dist/rc4-blank-history/dsh-remote-0.8.0-rc.4-history-fix.apk`。
- APK SHA-256：`cdb14318bf73aed4ed48ebd118758069d525f40cb9d24888b4b36f14f023b67d`。

这是同版本手动覆盖安装用的修复包，手机端尚未覆盖安装。

## 本机实装

- 已重新识别活动进程及 profile：`C:\Users\blank\.dsh\profiles\desktop`，启动程序 `D:\dsh_desktop\DeepSeek Harness.exe`。
- 备份：`dist/local-install-2026-10-18-rc4-history-fix/`，含原插件、manifest、lockfile 与配置。
- 本地分发脚本更新 APK、更新元数据和插件副本；未执行 release、commit、push、tag 或远端发布。新插件包：`dist/rc4-blank-history/dsh-remote-plugin-0.8.0-rc.4.tgz`。
- 经鉴权优雅关闭旧网关，停止核实归属的 Desktop 进程；pnpm 移除旧包再从该本地 tgz 安装，并重启 Desktop。
- 新网关 PID `62656`，上游 `http://127.0.0.1:59349`；上游 HTTP 200、mux/host collector 连接正常，客户端两条 WebSocket 均成功打开。
- 实际提供的前端文件与安装源哈希一致，gzip 和 ETag/304 正常；带 `local=0.8.0-rc.4` 的更新元数据指向修复 APK，下载哈希与上列值一致。
- 真实 DSH 插件管理页 HTTP 200，插件状态 `mode: gateway`、`gatewayInstalled: true`；只读会话列表成功返回 35 项。
- cordis 两份配置、pnpm-workspace.yaml、manifest 中其他依赖和 profile bundles 均与备份一致。
- 现场验证报告：`dist/rc4-blank-history/live-install-verification.json`。验证器结束后网关仍存活；未将 APK 安装到手机。
