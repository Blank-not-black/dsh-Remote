# 本地操作日志

本轮按用户澄清，新增日志只保存在用户 App／浏览器本地，由用户自行复制或导出反馈，不附带到反馈请求。网关代码与本轮开始前逐字节一致，未改云端收集器。

## 使用

进入「更多 → 关于与维护 → 本地操作日志」。无需填反馈、无需主机在线；反馈窗口里也提供打开此日志的按钮。可刷新预览、复制 JSON、导出 JSON、清除记录。

Android 的导出通过系统文件选择器选择保存位置，不依赖网关下载，不新增存储权限。界面区分等待选择、取消、实际写入成功和失败；旧壳缺少接口时显示失败并保留复制入口。其他浏览器用文件下载。

## 记录范围与保存

- 会话打开、缓存命中／失败、历史请求与渲染阶段、记录数量、渲染错误、返回列表。
- RPC 方法名、HTTP 状态、阶段耗时与关联 traceId；不保存请求／响应正文。
- mux／host 连接打开、断开代码、重连次数、重试间隔、轮询降级，前后台与在线状态。
- 页面异常的类别、受限脚本文件名与行列位置；不保存任意错误原文。
- Android 后台服务状态、最后成功时间、HTTP 状态、省电、忽略电池优化及通知总开关状态。后台部分采集当前和回前台时的状态，不等同于 Android 全系统日志。
- 版本和基于前端／Android 源码生成的 buildId，用于区分同为 rc.4 的不同构建。

日志上限为最近 160 条、最长 24 小时，并限制结构化数据容量约 48 KB。普通记录合并后写本地存储；失败、会话打开／返回和历史渲染开始阶段立即保存，避免随后页面卡住而丢失最后阶段。前后台切换也会保存。清除日志和清除全部本地配置都会清理操作记录。

会话与服务器仅保存带本地随机盐的匿名指纹。字段白名单过滤对话、模型输入、令牌、Cookie、完整 URL、文件路径和任意错误文本。首次加载只请求同源／App 包内的构建元数据，不上传日志；现有反馈正文和旧的可选兼容性／崩溃摘要行为保持原样。

## 文件

- 新增：`public/diagnostics.js`、`public/build.json`、`scripts/prepare-diagnostics-build.mjs`、`tests/client-diagnostics.test.js`、本说明。
- 修改：`public/app.js`、`public/desktop/desktop.js`、两端入口 HTML、`public/history.js`、`public/workflow.js`、`public/workflow.css`。
- Android：`android/app/src/main/java/com/dshremote/app/MainActivity.java` 增加文件选择器导出及后台状态事实。
- 构建：`scripts/sync-plugin.mjs`、`scripts/prepare-version.mjs`、`package.json`；更新使用说明和 Android 模块文档。插件 public 副本均由同步脚本生成。

## 验证与交付

- `npm run check`：675 项，665 通过、10 跳过、0 失败。
- 新增 7 项测试覆盖字段脱敏、日志容量／过期／存储异常、卡住前的阶段落盘、Android 离线导出状态、后台快照、反馈请求不包含新日志，以及独立弹窗／复制／浏览器导出／清除。
- 隔离浏览器实际打开本地日志入口，预览包含加载／返回等操作轨迹，不含测试会话正文；未观察到页面控制台错误。截图和预览样本位于 `dist/diagnostic-logs/`。
- Android Gradle 构建成功，签名 v2 校验通过。APK 内 9 个关键前端文件及构建元数据与源码逐个核对一致。
- APK：`dist/diagnostic-logs/dsh-remote-0.8.0-rc.4-local-logs.apk`，versionCode `8004`，versionName `0.8.0.rc.4`。
- SHA-256：`8c4773e6ea37a7a6b928b2101eec8fadf750334c56d642d941682b4920820e46`。
- 插件包：`dist/diagnostic-logs/dsh-remote-plugin-0.8.0-rc.4.tgz`。

未新增依赖，未提交／推送／公开发布。本轮只构建本地安装包，未替换上轮已实装的 Desktop，也未安装到手机；Android 系统文件选择器的真机保存仍待手机验收。
