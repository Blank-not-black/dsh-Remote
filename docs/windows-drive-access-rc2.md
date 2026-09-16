# Windows 跨盘访问：0.6.25-rc.2

默认文件根现在包括当前 Windows 用户目录以及启动时可用的非 C 盘盘符。手机文件页的目录选择器与桌面文件页的根目录选择器直接使用这些根，无需新增前端依赖或重新设计页面。

C 盘系统目录、其他用户目录不能借助已登记的 DSH 工作区或其他盘符上的 junction 绕过限制。Windows 账户权限仍然生效；新挂载磁盘需要重启网关。显式设置 `DSH_REMOTE_FS_ROOT` 时保留原有管理员自定义范围与工作区兼容行为。此范围针对 Remote `/fs/*` 文件接口，不是 DSH 终端或模型工具的操作系统沙箱。

本轮改动：`gateway.js`、`tests/windows-files.test.js`、`README.md`，以及根包、锁文件、插件包和 public 的版本/更新元数据；通过同步脚本更新插件网关与资源副本。

验证：完整检查 173 项，169 通过、4 项 Linux 平台相关跳过；Windows 专项 8 项通过。RC.2 APK 构建成功，真实 DSH 隔离集成测试通过，包含工作区创建与 APK 下载哈希校验。

已更新本机 web profile 并重启：网关报告 0.6.25-rc.2、ready；实际 `/fs/list` 返回 `C:\Users\blank` 与 `D:\`，两者 HTTP 200；`C:\`、`C:\Windows`、`C:\Users` 均为 HTTP 403。新版 App 的 `/update.json?local=...` 返回完整 RC.2 版本并与实际下载 APK 哈希一致；无 local 参数时省略 RC 后缀是既有旧版 App 兼容逻辑。

产物：`dist/rc-0.6.25-rc.2/` 下的 APK、插件 tgz 和 SHA256SUMS；常用 APK 路径仍为 `apk/dsh-remote.apk`。本机 profile 配置备份位于 `C:\Users\blank\AppData\Local\Temp\dsh-web-before-rc2-20260915-164217`。

未进行手机真机安装；旧 RC.1 前端已经支持多根目录选择，因此连接新版网关即可获得新范围。所有源码改动保持未提交，未向外部发布。
