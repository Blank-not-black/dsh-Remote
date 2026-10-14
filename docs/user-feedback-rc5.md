# 用户反馈修复与本地验收（0.7.5-rc.5）

本轮处理顶部高度、压缩反馈、Remote 本体更新和聊天附件下载。可选插件仍通过对应的已安装、已启用且实际运行的插件入口访问。没有新增依赖，没有提交或正式发布。

## 顶部空间与 Android 系统栏

旧桥把系统状态栏高度直接交给页面；当 Android 已经把 WebView 放到状态栏下面，页面仍添加同样的避让，形成重复留白。

新桥根据系统栏、decor 和 WebView 的实际屏幕位置计算剩余遮挡，布局变化时通知页面。页面仅应用剩余遮挡；长会话标题保持单行省略，完整标题仍可在会话信息里查看。该处理不依赖手机品牌，也不强制改变状态栏透明度。[Android 官方系统栏说明](https://developer.android.com/develop/ui/views/layout/edge-to-edge)

API 36 模拟器同一长标题测量：标题栏 113.56 → 52.76 CSS px，对话区域 648 → 713 CSS px。系统状态栏为 52dp，WebView 已下移 52dp，因此剩余顶部遮挡为 0。一加 15 真机仍需用户验证。

## 压缩状态与完成提示

- 快照重放明确携带 replay 标记，并从事件入口传至状态判断；恢复历史状态时不弹完成提示。
- 当前压缩由匹配 compactionId 的 compaction/end 结束；error 表示失败。summary 不是结束事件，旧序号及其他操作的结束事件不覆盖当前操作。
- session/end-seed 清理中断状态，保持静默；不根据运行时长猜测成功。
- 记录已经结束的操作，拒绝旧轮询状态重新激活；连接切换后的旧响应不改变新连接状态。
- 命令、状态查询与事件共同维护同一状态，匹配结束事件能解除命令发起的“正在压缩”。

终态字段以 [DSH compaction 类型定义](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/compaction/compaction/src/types.ts) 为依据。手机端与桌面端均覆盖；模拟器实际页面验证历史提示 0 条、当前状态条结束即消失、完成提示仅 1 条。

## 更新 Remote 本体

插件中心的已安装 Remote 行增加“更新 Remote”，仅在主机 CLI 可验证、插件中心可写时提供。仍拒绝对 Remote 的安装、卸载、启用或停用操作。

确认页显示主机、目标版本与更新范围，说明先备份配置和旧包、任务在主机后台执行、重启 DSH 后生效以及连接可能短暂中断。手机 App 需要单独升级。更新过程中工作进程保持运行，旧包文件被替换后仍保存任务结果。

已验证实际本地入口与保护动作，以及隔离子进程中旧包备份、执行中的工作文件被替换、目标版本落盘和任务完成。没有对真实 profile 发起 npm registry 自更新；本轮实际安装使用已构建的本地 RC5 包。

## 聊天文件下载

正式 file 附件根据当前会话中的 attachmentId 查找主机声明的附件，再使用附件服务读取。attachmentId 不作为路径。会话检查使用不激活会话的 inspect，服务缺失时返回明确的不支持状态。[附件类型定义](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/attachment/attachment/src/types.ts)、[会话控制服务](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/api/session-controller/README.md)

聊天 Markdown 的绝对路径、file URI 和 ./、../ 文件链接可触发下载；相对路径依赖会话工作目录，路径下载仍遵守网关允许根目录与鉴权规则。技能文档等非聊天 Markdown 保留原来的链接行为。

下载先以 HEAD 校验，再交给 Android DownloadManager，保存到系统 **Download/dsh-remote/**。原生下载凭证放在请求头中，文件名清除路径分隔符和控制字符。不会自动下载或执行文件。

最终 APK 实测：生产附件处理器搭配隔离会话与自有附件，经 App 点击、鉴权 HEAD、系统鉴权 GET 后，77 字节文件落盘，SHA256 与源文件一致。真实 Desktop 的附件端点也已确认可用，并拒绝不存在的会话附件。没有向真实 DSH 会话写入测试消息。

## 验证与文件范围

完整检查：490 项，482 通过、8 跳过、0 失败；Android 离线构建成功，versionName 0.7.5.rc.5、versionCode 7055。模拟器回放 25 次实时消息更新时阅读位移 0px。完整本地证据见 dist/user-feedback-rc5/REPORT.md。

本轮主要文件：

- Android：android/app/src/main/java/com/dshremote/app/MainActivity.java。
- 前端：public/app.js、public/desktop/desktop.js、public/chat-files.js、public/md.js、public/plugin-center.js、public/styles.css、public/theme-vars.css、public/desktop/desktop.css、两端 HTML。
- 网关与插件：gateway.js、packages/plugin/index.mjs、packages/plugin/plugin-center.mjs、packages/plugin/session-file.mjs。
- 测试：tests/compaction-status.test.js、tests/session-file.test.js、tests/plugin-center.test.js、tests/plugin-center-ui.test.js、tests/skills-installed.test.js；tests/dsh-process-control.test.js 将任意等待改为等待测试监听端口就绪，修复负载下夹具竞态。
- 版本与同步：package.json、package-lock.json、packages/plugin/package.json、public/version.json、public/update.json、scripts/sync-plugin.mjs 及同步生成的插件资源、网关副本和 APK。

仓库原有其他未提交改动保留。本轮不涉及 HarmonyOS 适配或验收。
