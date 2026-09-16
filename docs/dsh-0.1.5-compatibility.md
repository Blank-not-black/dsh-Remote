# DSH 0.1.5 适配报告

日期：2026-09-14 开始，2026-09-15 完成产物核验。Remote 候选版本：**0.6.25-rc.1**。

本次完成源码适配、插件同步、隔离集成验证、RC APK 构建与插件包打包。已生成本地更新产物，未提交、未部署、未向 npm/GitHub 正式发布。仍需 Android 真机验收后再发正式版。

## 上游更新与实际验证版本

[DSH 0.1.5-rc.1 官方发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1) 汇总了从 0.1.2-rc.1 起的更新，主要包括：

- 新 DeepSeek Flash 模型及图片能力、通用文件上传。
- 可继续对话的子代理队列和插话操作。
- 文件预览 Sidebar、工作区外部应用打开入口。
- 会话日志 V3、生命周期句柄及会话锁。
- 目标暂停、断线恢复、Windows 路径和后台进程等修复。

本机 CLI 是 `@deepseek-ai/dsh@0.1.5-rc.1`。其 npm 依赖使用版本范围，本次安装的 `dsh-api-session-controller` 等组件实际为 `0.1.5-rc.2`，因此验证对象是这套真实安装组合，并非声称所有子包都锁定 rc.1。

## 本次适配

| 范围 | 原问题 | 处理结果 |
| --- | --- | --- |
| 实时思考 | 新版 `session/follow` 要显式传 `assistantStream: true`，并通过无持久序号的独立帧传输 | 网关订阅新流，转换成手机、桌面端可消费的思考状态；独立维护 revision/index，不污染历史游标 |
| 重连与重试 | 流快照、重复帧、重试、放弃和完成会造成增量丢失或旧思考残留 | 恢复快照，忽略重复帧，清理结束/失序状态；HTTP 历史和新接入 WS 客户端均可恢复当前思考；较旧 HTTP 回包不覆盖更新的实时状态 |
| 历史统计 | 扫描器只认 `session.jsonl.zstd`，漏掉分代文件和明文日志 | 识别规范 `session.vN.jsonl[.zstd]`，每个会话只选最高代，遵循 `DSH_HOME`；优先使用 Node 内置 Zstandard，旧 Node 回退系统命令 |
| 迁移去重 | V3 插入事件后 seq 改变，旧游标不能直接复用 | 从保留的前代日志提取已计用量身份，再扫描新代；缺失前代或匹配失败时保留统计与游标并报告错误；损坏输入不推进游标 |
| 文件消息 | 桌面端忽略新版 `file` 内容块，手机端显示未知类型 | 两端显示经过 HTML 转义的文件名和字节数 |
| Windows 测试 | 把 POSIX `0600` 位直接用于 Windows 断言 | 仅 POSIX 平台验证 mode bits；Windows 保留真实 Cookie 交换、内容和启动链路验证 |

继续使用原有斜杠 RPC、Cookie 认证、命令桥接及双流客户端契约；没有新增第三方依赖或改变单文件网关发布形态。

## 验证

启用 `DSH_TEST_CLI_ROOT` 指向本机安装后运行 `npm run check`：**171 项，167 通过，0 失败，4 跳过**。跳过项均为 Linux systemd 专项，Windows 本机不适用。

新增 `tests/installed-dsh.test.js` 为显式启用的集成测试：在临时 HOME/USERPROFILE/DSH_HOME 和随机本地端口启动真正的 DSH 与 Remote，挂载真正的插件，验证认证交换、会话列表/创建/重命名/历史/模型目录、工作区创建、设置、提供商目录、Agent/命令服务、`remote.mux` 会话与思考基线。结束时终止子进程并清理临时目录，不接触真实会话或模型凭据。

新增行为回归覆盖思考快照、重复帧、重试/放弃、序号隔离、附件转义、V3 迁移去重、重新启动后增量统计、明文/Zstandard 和损坏文件。`npm run sync-plugin` 已执行，`git diff --check` 通过。

## 构建产物与验证

- RC APK：`apk/dsh-remote.apk`，8954611 字节，应用 ID `com.dshremote.app`，versionCode `6251`，versionName `0.6.25.rc.1`；包内 Web 版本为 `0.6.25-rc.1`。
- APK SHA-256：`4ee8566a7f6fd991a4d4b6d2888bf29c09f211129b05325e0f0ce3f4e52c9886`。
- RC 插件包：`dist/rc-0.6.25-rc.1/dsh-remote-plugin-0.6.25-rc.1.tgz`，8288074 字节，包含新 APK、WebUI、网关和插件。
- 插件包 SHA-256：`481553e2b8eb0a0cf23a90accde1fa225176c7a7c62d1760040054ef53fb6857`。
- APK v2 签名校验通过；签名证书 SHA-256 为 `adbeb80d827533bb170b241220bf26e8afbe3ec07a149b1a2d26828864df0ce4`，与仓库旧 APK 一致。核对了包内手机与桌面 JS 的哈希，均与本次源码一致。
- `npm run publish` 已执行，此仓库的该脚本只生成本地 APK/更新清单并同步插件，不对外发布。真实网关 HTTP 下载的 APK 哈希与更新清单一致，新增下载集成断言通过。
- 初始缺少 Android SDK，已从 Google 官方下载并校验，安装在忽略目录 `dist/android-sdk`。使用已有 JDK 21；慢速 Maven 下载通过仅本次构建使用的镜像初始化脚本解决，没有更改项目依赖版本或系统代理。Gradle 最终 **BUILD SUCCESSFUL**，188 项任务，111 执行、77 缓存命中。

复现本地构建时，在 PowerShell 设置 `JAVA_HOME=C:\Program Files\Java\jdk-21`、`ANDROID_HOME=D:\dsh-remote\dist\android-sdk` 和 `ANDROID_USER_HOME=D:\dsh-remote\dist\android-sdk-user`，再运行 `npm run build-app`。若需要本次镜像，先完成 Web 资源同步，再从 `android` 目录运行 `gradlew.bat --init-script D:\dsh-remote\dist\android-sdk-setup\maven-mirror.gradle assembleDebug --console=plain`。构建后运行 `npm run publish` 生成本地更新清单。

## 覆盖边界与待验收

- 没有调用付费模型，未进行真机 Android 安装、完整模型流式对话或公网/VPN 人工验收。思考内容增量由契约回归验证，真实集成验证了订阅和基线传输。
- 通用文件本次适配消息显示；未移植 DSH 的通用文件上传回执流程、完整 Sidebar、多标签预览或子代理队列新 UI。已有 Remote 文件传输流程仍独立使用 `/fs/*`。
- 新 DeepSeek 模型通过上游模型目录读取，无需硬编码新选择项。本项目费用估算仍使用原有固定价格表；未登记的新模型仅统计 Token，现有实现费用返回 0，不能据此认定实际免费。本次没有猜测或更改新模型单价。
- 正式发布前仍需真机验证 RC APK，以及完成上述人工验收；当前没有剩余本地构建阻塞。

## 文件清单

- 主实现：`gateway.js`、`gateway-stats.cjs`、`public/app.js`、`public/desktop/desktop.js`。
- 版本：`package.json`、`package-lock.json`、`packages/plugin/package.json`、`public/version.json`、`public/update.json`。
- 测试：`tests/dsh-015-compat.test.js`、`tests/installed-dsh.test.js`、`tests/plugin-autostart.test.js`、`tests/stats.test.js`。
- 自动同步副本：`packages/plugin/gateway.cjs`、`packages/plugin/gateway-stats.cjs`、`packages/plugin/public/app.js`、`packages/plugin/public/desktop/desktop.js`、`packages/plugin/public/version.json`、`packages/plugin/public/update.json`、`packages/plugin/apk/dsh-remote.apk`。均通过同步脚本生成，没有直接编辑遗留副本。
- 报告：本文件。RC 打包目录受 `.gitignore` 排除。
