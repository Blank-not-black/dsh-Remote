# GenUI 只读适配：0.6.25-rc.5

## 范围

按本机安装的 `@changfenhuang/dsh-genui 0.11.0` 的 `src/client/genui-runtime/schema.ts` 核对格式。该插件已在本机 DSH Web profile 的 dependencies 和 bundles 中登记，无需重复安装。

手机端与桌面端共用 Markdown 渲染入口，闭合的 `dsh-ui`、`json dsh-ui`、`dsh-ui json` 代码块可显示常用布局、文本、指标、进度、表格、列表、折叠内容及 SVG 柱状图、折线图、环形图。简单 ECharts bar/line/pie preset 显示基础数据预览；完整 option 不支持。

这是只读子集：表单提交、事件回传、持久面板、Mermaid、3D、表达式绘图等未实现。未支持的组件/数据转换显示提示并保留 JSON；外观细节如 spark、表格特殊单元格和进度环不复刻。非法、未闭合或超出预算的规格回退源码，不执行模型代码。原始规格始终可展开。

HTML/HTM 代码块使用空 sandbox 的 iframe 和 CSP，仅允许文字、基本排版和内联样式；脚本、图片、网络资源、导航和表单均禁用。这次不包含文件浏览器中独立 HTML 文件的预览。

## 验证

- 启用 `DSH_TEST_CLI_ROOT` 后运行 `npm run check`：183 项，179 通过、4 跳过、0 失败。测试隔离 HOME、USERPROFILE 与文件根，不使用真实会话。
- 7 项 GenUI 测试覆盖三类图表、负数、非法规格、注入字符串、嵌套限制、系列颜色、数据转换回退及同步产物。
- 真实 DSH 隔离启动后验证 `/remote/genui.js`、`genui.css`、`md.js` 的 HTTP 内容与源码一致；网关提供的 APK 哈希与更新清单一致。
- 浏览器 390px 内容区实测：三类 SVG 图表、表格与不支持提示正常；无横向溢出。HTML 文字正常显示；sandbox/CSP 存在、危险标签被清理、脚本未执行、资源探针请求为零。
- 使用 JDK 21、本地 Android SDK 和已有 Gradle 缓存完成 assembleDebug。APK 内 genui.js、genui.css、md.js 和 version.json 与源码逐一相等。
- 构建阶段未进行本机部署；后续用户授权的实装验收见下节。Android APK 真机安装仍未验证。

## 本机实装验收（2026-09-16）

- 已备份 Web profile 配置和旧插件到 `dist/local-install-rc5-backup/`，保留 rc.4 tgz 可回滚。
- 使用 DSH plugin 命令先 remove 后 add 安装本地 rc.5 tgz；保留 `@changfenhuang/dsh-genui 0.11.0` 的依赖及 bundle 注册。
- 按原 `dsh web --no-open` 命令隐藏重启。启动时 DSH PID 84048、网关 PID 84408，端口分别 3080、8787；health 返回 rc.5、上游 HTTP 200。
- 运行中网关返回 genui.js、genui.css、md.js、version.json 与工作区逐字一致。`update.json?local=0.6.25-rc.4` 返回 rc.5，实际 APK 下载 SHA-256 为 `87294d123c24e79bca899e946a2b3abe9707fde32bd3ab9b4be39e771ae0aa99`，与产物清单一致。无 local 参数时为兼容旧客户端会隐藏 rc 后缀，属于既有逻辑。
- 新建保留验收会话「DSH Remote rc.5 渲染验收」，让模型仅输出指定 dsh-ui 与 HTML，无工具调用。DSH 原页面的 GenUI 渲染器显示柱状图、折线图、环形图；同一会话在实装 Remote 桌面及 390×844 手机视口均显示三类图表和 HTML 隔离预览，展开数据为完成 75、待办 25。
- 实际 Remote 总览显示网关、上游、mux、host 四项在线，连接模式为实时 WS。本机安装与浏览器验收完成，未外部发布、未提交。

## 文件与产物

- 实现：`public/genui.js`、`public/genui.css`、`public/md.js`。
- 接入：`public/index.html`、`public/desktop/desktop.html`、`scripts/sync-plugin.mjs`。
- 测试：`tests/genui.test.js`、`tests/installed-dsh.test.js`；可复制规格：`docs/genui-sample.md`。
- 版本：package.json、package-lock.json、packages/plugin/package.json、public/version.json、public/update.json；插件静态资源与 APK 由脚本同步。
- 本地测试包：`dist/rc-0.6.25-rc.5/`，含 APK、插件 tgz、更新清单和 SHA256SUMS。

保留此前工作区的未提交修改；本次没有提交、推送或外部发布。`npm run publish` 在此仓库只生成本地 APK/更新清单并同步插件副本。
