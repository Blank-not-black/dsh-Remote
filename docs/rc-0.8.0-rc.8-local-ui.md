# RC.8 本地 UI 实装与验收

日期：2026-10-20。已将本地构建的 `dsh-remote-plugin@0.8.0-rc.8` 安装到当前 Desktop profile，并重启 Desktop。未提交、推送、打 tag 或向 npm/GitHub 发布；`npm run publish` 在本项目中仅生成本地产物。

## 用户可见变化

- 插件面板直接展示额度与余额，支持刷新、供应商查询时间、未知及失败提示；管理控制台不再有“用量”分区，也不再轮询费用。
- 控制台反馈菜单移到页面顶层，支持原生 Popover top layer，并按 iframe 自身视口定位、限制高度和内部滚动。短视口时会向上展开。
- 手机/Web 与桌面 Web 的新建对话、新建工作区支持选择 DSH Agent 类型；工作区快捷新建也先打开选择框。当前主机返回 standard、ptc、minimal、cordis，默认 standard。只传递本次创建的 `agentPreset`，不修改主机默认。
- 不支持预设列表的主机继续使用自己的默认类型；失败的预设不可选，旧请求不能覆盖重新打开的表单，切换主机后旧选择不能用于创建。

## 改动文件

- `public/plugin.html`、`plugin.js`、`insights.js`：额度入口及共享额度视图。
- `public/admin.html`、`admin.js`、`remote-ui.js`、`remote-ui.css`：五个管理分区与反馈浮层修复。
- `public/session-presets.js`（新增）、`public/index.html`、`app.js`、`public/desktop/desktop.html`、`desktop.js`：共享预设选择及各新建入口。
- `gateway.js`：精确适配只读 `agentPresets.list → agentPresets/list`，现有 `session.create` 保留 `agentPreset`。
- `scripts/sync-plugin.mjs`、版本清单、APK/更新元数据，以及同步生成的 `packages/plugin/` 文件。
- 新增 `tests/session-presets-ui.test.js`、`admin-feedback-ui.test.js`，扩展额度、网关适配与现有测试夹具。

根 `public/` 是源文件，插件副本由 `npm run sync-plugin` 生成。没有新增依赖。工作区此前已有大量未提交修改，均保留。

## 验证

| 项目 | 结果 |
| --- | --- |
| 完整 `npm run check` | 822 项：808 通过，14 跳过，0 失败 |
| Windows 恢复测试 | 需要本机进程启动身份查询权限；普通沙箱中两项无法读取身份，在具备该权限的隔离环境中 21/21 通过；完整门禁同样通过 |
| APK | versionName `0.8.0.rc.8`，versionCode `8008`，v2 签名校验通过 |
| APK SHA-256 | `d6d76058b1c732afa84312c6130c3b3add2ca8d8a16786503283691dd9f126e1` |
| 实装文件 | 103 个源包文件与 Desktop 已安装包逐字节一致 |
| 配置 | 其他依赖、cordis.yml、cordis.patch.yml、pnpm-workspace.yaml 保持原样 |
| 真实服务 | 网关 0.8.0-rc.8，上游响应正常，mux/host 均完成 HTTP 101 握手，验证后网关 PID 保持存活 |
| 服务资源 | 19 项页面、JS/CSS、更新元数据及网关/插件 APK 哈希核对通过；gzip 和 ETag 304 通过 |
| 新建对话 | 真实页面弹窗显示四种主机类型，选择 ptc 后正确回显；创建参数在隔离测试中验证，没有为验收在真实 profile 创建空对话或调用模型 |
| 反馈裁切 | 360×260 iframe 中代理加载真实已安装页面，三项反馈入口完整位于框内；短视口自动测试同时覆盖 Popover 与固定定位回退 |
| 差异检查 | `git diff --check` 通过 |

浏览器实测截图：

![短视口反馈菜单](../dist/ui-followup-2026-10-20/live-feedback-narrow.png)

![新建对话类型](../dist/ui-followup-2026-10-20/live-session-type.png)

验收边界：本轮核对真实 Desktop 后端及其浏览器页面，没有完成 Android 真机安装。原生 Desktop 窗口捕获连续超时，未据此声称其原生窗口视觉验收已完成。

## 本地产物与回退

- 测试包：`dist/ui-followup-2026-10-20/dsh-remote-plugin-0.8.0-rc.8.tgz`。
- Android：`apk/dsh-remote.apk`。
- RC.7 插件及原 profile 配置备份：`dist/ui-followup-2026-10-20/backup-rc7/`。
- 机器可读证据：同目录 `installed-verification.json`、`live-verification.json`、`check.log`、`build-app.log`、`install.log`。
- 四项外部插件的新版核对与候选功能见 [插件适配审计](plugin-adaptation-audit-2026-10-20.md)。没有自动升级其他插件。
