# rc.9 仿真与 Auto review 问题修复

2026-10-22，版本保持 `0.8.0-rc.9`。本次在已有未提交工作区上修复确定的问题，未提交、未部署、未重启真实 DSH，也未上传 npm 或 GitHub。所有服务测试使用临时配置、固定测试令牌、随机本机端口及假上游。

## 修复与落点

| 文件 | 修复 |
| --- | --- |
| `gateway.js` | JSON 入口按字节限额收集后统一解码，跨分片中文和 emoji 不损坏；超限返回 413；备注类型和长文件名校验；静态 NUL 路径返回 400，内部错误不回显路径；过滤请求、响应的逐跳头和 Connection 指定头。 |
| `gateway.js` | multipart 验证声明边界及结束标记，结束前不提交文件；正文中的相似边界完整保留。合法长文件名使用短临时文件名，兼容原续传命名。 |
| `gateway.js` | 文件根、工作区和列表统一使用系统 realpath，检查 Windows 扩展路径及 UNC 前缀，受保护文件使用同一归一化比较。 |
| `packages/plugin/index.mjs` | 请求体完整解码及超限响应；异步命令增加操作 ID、executed 与失败终态，显式拒执行不再显示完成；错误不回显内部路径。 |
| `public/approval-records.js` | 普通工具结果不再误记 Auto review 拒绝；识别官方转人工格式，按 ID 合并乱序申请与决定，持久化保留决定，最终拒绝按会话隔离调用 ID。 |
| `public/app.js`、`public/desktop/desktop.js` | 普通异步命令读取相同操作的终态；仅明确未执行可回退普通文本，失联或执行失败不重复提交。权限切换等待成功，旧会话/主机响应不能影响新菜单；保留跨会话 compact 状态归属。缓存写回绑定原主机快照。 |
| `public/permission-presets.js` | 过期按钮与迟到权限响应失效，失败保留菜单，重开菜单不受旧请求影响。 |
| `public/workflow.js` | 手机、桌面“更多 → 审批与操作回执”显示审批记录；关闭时恢复容器；清除全部数据包含审批缓存并取消待写定时器。 |
| `tests/gateway.test.js`、`tests/windows-files.test.js` | 实际 HTTP 分片、413、备注类型、NUL、代理逐跳头、multipart、合法/非法长名，以及真实目录链接和敏感目录别名；覆盖扩展路径下的受保护文件。 |
| `tests/plugin-runtime.test.js`、`tests/slash-command-bridge.test.js` | 真实挂载插件的异步完成/拒执行/异常/操作 ID、中文分片、超限与错误脱敏；客户端终态匹配、权限失败及失联防重复。 |
| `tests/approval-records-ui.test.js`、`tests/permission-presets-ui.test.js`、`tests/tester-feedback-ui.test.js` | 负例、乱序、跨会话 ID、缓存清除和延迟写回、权限菜单竞态，以及实际回执入口的 DOM 挂载/恢复。 |
| `tests/compaction-status.test.js` | 补齐新增审批收集函数的隔离 VM 上下文，继续验证压缩事件。 |
| `package.json`、`docs/permission-presets-adaptation.md`、`docs/rc-0.8.0-rc.9.md` | 更新本地 RC 说明、当前入口、修复内容及验证范围。 |

通过 `npm run sync-plugin` 同步根 public、gateway 和 APK 到插件分发目录，未手工修改同步副本。

## 当前验证

- `npm run check`：946 项，928 通过、18 跳过、0 失败。日志：`dist/rc9-bugfix-2026-10-22/check-final.log`。
- 额外开启 `DSH_TEST_EXTREMES=1`：2 项通过。1000 个持久化回执后新操作返回 429，精确重试不重复执行；15 秒混合负载完成 29 轮、928 次重复请求，仅执行 29 次，29 次中断上传不生成目标文件，29 次续传校验和 29 次 WebSocket 重连通过。
- 压力测试运行在 Windows；`/proc` 的 FD/RSS 指标不可用，不声明 Linux 内存或句柄稳定性已验收。
- 手机和桌面真实浏览器从会话历史加载审批后，经“更多 → 审批与操作回执”显示原因与已拒绝结果，普通成功工具不出现在记录中。截图位于同一 dist 目录。
- `npm run build-app` 成功，APK `versionName=0.8.0.rc.9`、`versionCode=8009`。APK 中六个关键前端/构建资源逐字节匹配当前源码。
- 本地整理 APK 与插件 tgz 后，核对插件包内网关、入口、前端和 APK 哈希，`update.json` 的 APK SHA-256 一致；`git diff --check` 通过。

## 本地产物

位于 `dist/rc9-bugfix-2026-10-22/`：

- `dsh-remote-0.8.0-rc.9-fixed.apk`，SHA-256 `a3620246ee3013a7a01e37ad357db8498ec60dcfb077b2daea4d879f2f1a4a34`。
- `dsh-remote-plugin-0.8.0-rc.9.tgz`，SHA-256 `225e4aae8907b75b203653eb9805b3adb1c5c8e88ad1975eb0545c74725fe148`。
- `manifest.json`、`apk-verification.json`、`artifact-verification.log`：源码和产物哈希及核对记录。

版本号沿用 rc.9，仅构建本地文件；同版本不会自动形成线上更新。本地产物没有安装到当前运行 profile。

## 仍待验证的范围

原报告的 junction 越界在同源码的两个本机环境均未复现，均返回 403；本次作为系统路径解析加固，并增加真实链接与敏感目录别名门禁，不宣称证实并修复了凭据泄漏根因。

## CI 发布阶段补充修复

首轮真实 runner 暴露了两类路径别名问题，发布门禁按原样阻止了分发，尚未生成 rc.9 Release：

- Windows native realpath 会改变短名称或目录大小写。列表仍用 canonical 路径做磁盘访问与安全检查，但返回条目地址与请求目录保持同一命名空间；新增大小写变体真实请求回归。
- macOS `/var` 与 `/private/var` 的别名导致敏感目录/自定义令牌文件边界比较、插件快照和 worker 入口识别不一致。保护规则增加 canonical 路径，未生成文件根据存在的父目录解析；插件事务按真实根比较，后台入口同时解析脚本路径。两项新增真实目录别名回归验证敏感文件仍返回 403，以及 detached worker 可完成任务。

补充修复后，本机全量 **948 项：930 通过、18 跳过、0 失败**。CI 发布以修复后的提交重新运行；上文构建哈希和本地安装记录仍绑定此前快照，不把它们作为补充修复后的新包哈希。

18 个跳过项包含 Unix/systemd、已安装 DSH 或真实 pnpm 的显式选择测试等。此次未连接 Linux 笔记本、未运行 macOS，也未在真实 DSH 上启用 Auto review；设备、真实权限投影和登录边界继续保留到相应环境验收。源码门禁与本地构建通过不等于正式版已上线。
