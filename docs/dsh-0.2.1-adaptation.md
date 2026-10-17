# 本地 DSH 升级与 Remote 适配（2026-10-17）

## 本地升级结果

DSH Desktop 和全局 CLI 已由 `0.2.0-rc.2` 更新至 **`0.2.1-rc.1`**。这是预览通道版本：核对时 npm `next` 为该版本，`latest` 仍为 `0.2.0-rc.2`。依据：[官方发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)、[官方 npm 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)。

桌面沿用已配置的 `nightly` 更新源，下载安装前核对官方 feed 的 SHA-512，Windows Authenticode 签名有效，发布者为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.。安装目录保持 `D:/dsh_desktop`，重启后读取 `app.asar` 中桌面包与内置 DSH 的版本，均为 `0.2.1-rc.1`。CLI 首次官方源依赖下载遭遇连接重置，核对镜像该版本 integrity 与官方一致后重试成功，`dsh.cmd --version` 确认新版本。

升级前确认没有运行中的会话，备份后停止已核对归属的旧桌面进程组，安装后重新启动。只读在线复核：原 Remote 网关仍为 `0.8.0-rc.2`，DSH 上游可达，mux/host 均连接、无当前错误。升级后首次读取 29 个会话，最终复核 30 个、运行中 0 个；本轮真实联调只写临时隔离 profile，不向用户 profile 写测试会话。计数不能替代逐条内容完整性校验，本轮未逐条重读用户历史。

原自装插件 dependencies 完全一致；`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml` 哈希未变。DSH 自动调整了 profile `package.json` 的内置 bundles：移除 `@deepseek-ai/dsh-experimental-schedule-bundle`，加入 `@deepseek-ai/dsh-experimental-inspector-profile`。没有回写旧清单或修改自装插件版本。

备份和核验资料保留在：

- `dist/dsh-update-2026-10-17-0.2.1-rc.1/`：旧桌面目录归档、旧 CLI 归档及启动脚本、已验证的安装器、下载校验记录、配置哈希、`live-verification.json`、测试日志。
- `C:/Users/blank/.dsh/backups/local-upgrade-2026-10-17-0.2.1-rc.1/state-before.tar`：升级前用户状态备份，包含敏感配置，仅本机保留，不提交。未包含 node_modules、附件、skills、运行时及临时缓存，不能当作这些目录的完整副本。

回退时需先关闭已核对的桌面及其网关进程，按归档恢复旧桌面/CLI；用户状态仅在确有必要时从备份选择恢复，避免覆盖升级后新产生的会话。不自动执行回退。

## 新版协议适配

以实际安装的 `0.2.1-rc.1` 服务端源码为依据，完成以下改动：

- 区分 `projections.kind = cached | sequenced`。缓存水位不是连接流序号，网关不将其写入实时游标；读取缓存会话历史前获取最新 projection，手机/桌面收到实时 projection 后允许替换数值更大的缓存水位，保留同一实时序列的乱序保护。
- 识别 `formatStatus = migration-required` 以及 `session/projections` 返回的同名分支。历史读取和父目录返回明确错误码，提示先在 DSH 打开原会话完成迁移；不自动激活这些会话，也不为其建立普通会话订阅。子目录保留旧记录名称并说明迁移要求。
- 新目录的 `external` 条目显示为外部任务及不可读原因，不伪装成本地子会话；当前 durable `session/page` 地址并不支持该模式。
- 保留子代理专用历史地址和直接父级关系。独立树形界面继续按层展开，读取时刷新 durable 游标；不把子代理记录变成可发送的普通会话。

`session/list` 虽声明了可选 cursor，当前实际实现仍返回完整 items，因此没有凭类型声明添加无效的分页循环。没有新增依赖或修改发布形态，也没有为尚未验证的版本范围补写兼容性承诺。

## 文件与验证

本轮源码落点：`gateway.js`、`public/app.js`、`public/desktop/desktop.js`、`public/index.html`、`public/desktop/desktop.html`、`public/subagents.js`；通过 `npm run sync-plugin` 更新对应插件副本。测试落点：新增 `tests/dsh-021-compat.test.js`，更新 `tests/installed-dsh.test.js`。既有用户反馈和独立树形页改动保留。

- `npm run check`：**560 项，552 通过、8 跳过、0 失败**。日志 `dist/dsh-update-2026-10-17-0.2.1-rc.1/check.log`。
- 设置 `DSH_TEST_CLI_ROOT` 后另跑 `node --test tests/installed-dsh.test.js`：**1 项通过、0 失败**。实际启动新版 DSH Web、加载工作区 Remote 插件及网关，所有 HOME/USERPROFILE/DSH_HOME/文件根均指临时目录，固定测试 token、清理代理和密钥变量，结束停止子进程并清理临时目录。
- 真实隔离联调覆盖：插件挂载和当前树形 JS/CSS 资源、插件管理状态、会话创建/重命名/历史/空会话归档、原生模型目录与 Remote 结果一致、工作区、设置、provider 列表、两层子代理 durable catalog/history、实时队列/job 基线、晚加入 WS 重放、APK 下载哈希。两层记录由测试插件直接写 durable 事实，没有创建 Agent 或调用模型；不等同于真实模型运行、中断/续接或 Android 真机验收。
- 缓存水位、迁移分支、external 诊断以及手机/桌面状态转换由 7 项协议/前端专项测试覆盖。`git diff --check` 通过；Git 的 CRLF 提示不属于检查失败。

Remote 当时仍为 `0.8.0-rc.2`，没有运行版本更新、APK 构建、发布、提交或推送，适配源码尚未安装到实际桌面 profile；线上健康检查验证的是原有 Remote 在新 DSH 下的基本连通性，适配补丁验证来自隔离实例与自动化测试。

后续（2026-10-17 晚）：用户授权构建 `0.8.0-rc.3` 并本地实装，本文件所述适配源码已随该版本进入实际桌面 profile，线上健康接口报告 `version=0.8.0-rc.3`、上游 `upstreamOk=true`、mux/host 双通道连接。构建、备份与复核记录见 [rc.0.8.0 反馈记录](rc-0.8.0-feedback.md)。
