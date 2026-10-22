# DSH 0.2.1-rc.2 升级与文件上传验证

2026-10-21，Windows 本机实测。DSH 已实际升级；Remote 修复保留在源码与本地验证 APK，未安装到用户 profile、未提交或发布。

## DSH 升级

Desktop 与全局 CLI 均从 `0.2.1-rc.1` 升至 `0.2.1-rc.2`。安装前确认实际 Desktop 进程位于 `D:/dsh_desktop`，Host 使用 `C:/Users/blank/.dsh/profiles/desktop`，59 个会话中运行数为 0。通过已认证管理接口关闭网关，核对 PID、路径和启动时间后停止旧进程，安装官方更新并从原目录重启。

版本和安装器来自 [DSH 官方更新源](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml)；CLI 使用 [官方 npm 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)。安装器 289385456 字节，SHA-512 与官方 feed 一致，Windows Authenticode 签名有效，发布者为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.。没有关闭签名或证书校验。

升级后读取安装包中的 Desktop/Core 版本均为 rc.2，`dsh.cmd --version` 同样为 rc.2。实际运行的 Remote 仍为 `0.8.0-rc.8`，上游 HTTP 可达，mux/host 均连接，无当前错误。升级前后的 59 个会话 ID 一致；自装插件 dependencies、bundles 和 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml` 五份文件均未变化。未逐条重读用户历史，也没有向用户会话发送测试消息。

回退资料仅保留在本地忽略目录 `dist/dsh-update-2026-10-21-0.2.1-rc.2/`：旧 Desktop 完整归档、旧 CLI 及启动脚本归档、用户状态归档、校验记录、升级前后审计。状态归档包含敏感配置，不应提交或上传；排除了 node_modules、附件、skills、运行时与缓存，不能代替这些目录的完整备份。

## rc.2 适配验证

显式指定新安装的 CLI，启动临时 HOME/USERPROFILE/DSH_HOME/文件根的真实 DSH Web，加载工作区 Remote 插件与网关：

- 会话列表、创建、重命名、历史、空会话归档、模型目录、工作区、设置和 provider 接口通过。
- 在 durable 夹具记录上验证完成回合的精确分支边界、最终回复、用量与时间戳，以及两层子代理目录和历史。
- 验证失败回合和失败尝试的思考记录，晚加入 WS 的基线重放、APK 下载校验。
- 220 个冷会话在网关启动与历史读取后仍未激活，持久化写句柄打开数为 0；选中的活跃会话仍接收事件和任务状态。
- 新 Desktop 的真实 Electron worker 在隔离 profile 完成插件安装、禁用、更新、启用、卸载。测试同时隔离 pnpm store 与 APPDATA/LOCALAPPDATA，修正原夹具在受限 Windows 环境尝试写 `C:/.pnpm-store` 的问题。

上述 CLI 2 项、Desktop 1 项均通过。测试没有调用模型，不等同于付费模型推理验收。

## 上传发现与修复

`public/app.js` 修复以下已由失败回归复现的问题：

1. 零字节文件收尾遇到覆盖冲突时，递归重启会丢失覆盖授权并反复询问；现在确认一次后携带授权提交。
2. 服务端纠正续传偏移时，旧哈希状态没有同步到新偏移；现在重算真实前缀，再继续传输。
3. 切换主机后，迟到的探测响应可能继续在新连接上传旧文件；现在上传持有连接及任务身份，切换时取消请求和 XHR，所有异步阶段检查归属。
4. 旧取消请求结束后可能清空新上传任务；现在只清理所属任务。

同时为探测的完整读取设置截止时间，验证偏移范围，防止连续点击启动重复任务，并对持续偏移冲突有界暂停。切换文件时后台清理请求的拒绝也被处理。新增 `tests/upload-ui.test.js` 的 8 项行为回归，执行实际前端 SHA-256 实现。

## 实际上传结果

两个环境分别完成以下 10 项 HTTP/磁盘验证，全部通过：工作区源码＋隔离真实 DSH rc.2；当前已安装 Remote＋升级后的日常 Desktop rc.2。后者只在本工作区的专用验证目录写合成数据，逐个清理测试文件，不修改用户会话或配置。

| 场景 | 结果 |
| --- | --- |
| 中文、空格文件名及下载 SHA-256 | 通过 |
| 零字节上传与默认拒绝覆盖 | 通过 |
| 明确授权后覆盖 | 通过 |
| 16 MiB 分块、probe、续传及校验 | 通过 |
| 实际 TCP 中断，保留前缀后续传 | 通过 |
| 取消后清理分片且无目标文件 | 通过 |
| 错误 SHA-256 不覆盖已有原件 | 通过 |
| 超出已有分片的偏移被拒绝 | 通过 |
| 无鉴权与文件名路径穿越被拒绝 | 通过 |
| 声明长度未满足时不提交 | 通过 |

手机网页使用实际文件选择器上传中文空格文件、零字节文件、16 MiB 文件；覆盖冲突确认后正常完成。64 MiB 文件点击暂停，页面显示暂停，继续后成功落盘。四个文件的磁盘 SHA-256 均与原件一致；16 MiB 文件又通过页面下载，浏览器下载文件的 SHA-256 与原件一致。最终手机尺寸为 390×844，页面未记录控制台错误。

这里覆盖的是“文件”页传输。聊天输入框当前只选择图片，本轮没有新增任意文件聊天附件，也未验证真实模型读取上传文件。Android 系统文件选择器、手机切网、Linux 上的新 DSH rc.2 未在本轮实机复测。

## 门禁、产物和改动范围

- `npm run check`：886 项，868 通过、18 跳过、0 失败；显式启用的实际 CLI/Desktop 联调另列上文，不能把默认跳过算成实测。
- `npm run sync-plugin` 完成；`git diff --check` 通过。
- `npm run build-app` 完成。保留原公开 `update.json` 与 APK 分发内容，验证包独立存放；没有运行发布命令。
- 验证 APK：`dist/dsh-update-2026-10-21-0.2.1-rc.2/dsh-remote-0.8.0-rc.8-upload-validation.apk`。
- APK SHA-256：`4c6c9eb890e64aaf26792cb402af73c8472a82a4b4e9734e830b851856b5e8d0`。包内 10 个关键前端资源与当前源码逐字节哈希一致。

本轮新增或修改：`public/app.js`、`tests/upload-ui.test.js`、`tests/desktop-plugin-center.test.js`、`docs/modules/10-tests-qa.md`、本文，以及同步的 `packages/plugin/public/app.js`、根/插件 `build.json`。保留工作区此前的 macOS、Linux、Doctor 和连接恢复改动，所有改动均未提交。

原始日志与结果位于上述 dist 目录：`before.json`、`after.json`、`installed-compat.log`、`desktop-compat.log`、`check-final.log`、`upload-isolated-results.json`、`upload-installed-results.json`、`upload-browser-files.json`、`apk-assets.json`。页面截图为 `upload-paused.png`、`upload-complete.png`、`upload-mobile-final.png`。
