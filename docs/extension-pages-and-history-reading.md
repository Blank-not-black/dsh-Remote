# 扩展专属页面与历史阅读保护

版本：0.7.5-rc.2。实现与本地验收日期：2026-10-13。

本文记录 rc.2 的实现与验收。rc.3 已根据用户反馈修正默认入口，现行产品规则见 [可选插件产品逻辑复核](optional-plugin-product-review.md)；以下“扩展中心”导航描述仅对应旧版。

## 三个页面

- 手机 Web/Android 和桌面的“插件”主导航进入扩展中心，分别提供技能中心、费用与额度、插件管理入口。
- 技能中心具有独立列表与详情页，支持搜索、来源数量、模型调用状态和排序。详情提供完整说明、适用场景、模型/手动调用状态、正文搜索、复制与 Markdown 阅读。返回列表保留筛选、DOM 节点和滚动位置；返回期间到达的旧详情不覆盖列表。
- 费用与额度页读取当前主机的今日费用、余额和已启用套餐，不要求选择会话。保留供应商查询时间、有效零值、隐藏配置和缺失状态；不增加历史费用或账单趋势接口。
- 聊天内的“上下文与费用”快捷面板增加“打开完整页面”。上下文分析页展示当前占用、七类组成、累计变化及主机提供的变化记录，支持变化类型筛选，最多显示最近 500 条。它仍绑定当前会话；“完整页面”不保证插件提供了从会话创建起的全部历史。
- 主机身份切换或页面离开会中止读取并清理定时器。保持现有鉴权桥接、零新增依赖和零构建前端。

## 历史阅读保护

原手机实时思考刷新用“距底部不到 240 像素”请求跟随，历史渲染又会按距离重算阅读状态。用户在尾部附近阅读、展开或选择历史内容时容易重新进入自动跟随；隐藏聊天视图还会使 WebView 清零滚动位置。

现在向上滚动、展开或选择历史内容会进入持续阅读状态。新记录继续接收，保留正在阅读的消息节点和实时思考区域的当前显示，提示“回到最新”及待查看记录数量。点击“回到最新”，或明确向下滚到实际尾部，才恢复跟随。点击折叠内容引起的布局滚动不被当成自动翻页请求。离开聊天期间暂缓 DOM 更新，并保存位置，返回后恢复再处理新数据。

## 验收

- `npm run check`：470 项，462 通过、8 环境跳过、0 失败；`git diff --check` 通过。
- 已备份实际 Desktop profile，安装并运行 Remote 0.7.5-rc.2；其他依赖、profile 配置和 `cordis.yml` 保持。
- Android API 36 模拟器覆盖安装 APK：versionName 0.7.5.rc.2、versionCode 7052，内嵌版本 0.7.5-rc.2。未验证 Android 物理设备或 HarmonyOS 页面。
- 真实主机提供 28 个技能；arkcli 搜索命中 23 项，正文搜索命中 69 处，Markdown 阅读可用；返回筛选列表的滚动位移为 0。
- 未选会话时费用页读取真实主机的今日费用和账户余额，不显示“当前会话无记录”。
- 真实会话上下文页读取 13 条变化记录；返回聊天时原消息锚点保持，最终测量位移约 0.38 CSS 像素。
- 最终 APK WebView 内的隔离回放测试连续追加 25 次新记录和思考更新，持续两秒，超过旧阅读意图计时窗口：最大阅读位移 0 CSS 像素，消息锚点不变，25 条待查看记录保留；主动回到最新后显示全部 226 条记录并位于尾部。此项为内存回放，不是付费模型任务执行，没有改写真实主机历史。
- 实际 Desktop 安装的 21 个关键文件与当前包一致；11 个在线资源源码匹配、gzip 和 ETag/304 正常；APK 静态资源检查无差异。上游、mux 和 host 均在线。

本地包、截图、检查日志和 JSON 证据位于 `dist/extensions-0.7.5-rc.2/`；安装前备份位于 `dist/local-install-2026-10-13-0.7.5-rc.2/desktop/`。

## 本轮文件

- 新增：`public/extensions.js`、`public/extensions.css`、`tests/extensions-ui.test.js`、本文。
- 页面与导航：`public/skills.js`、`public/skills.css`、`public/insights.js`、`public/insights.css`、`public/plugin-center.js`、`public/index.html`、`public/desktop/desktop.html`。
- 聊天与生命周期：`public/history.js`、`public/app.js`、`public/desktop/desktop.js`、`public/desktop/desktop.css`。
- 同步与版本：`scripts/sync-plugin.mjs`、`package.json`、`package-lock.json`、`packages/plugin/package.json`、`public/version.json`、`public/update.json`、根 APK 与插件 APK，以及对应插件静态资源同步副本。
- 测试：`tests/history-ui.test.js`、`tests/skills.test.js`、`tests/insights.test.js`、`tests/network-regression.test.js`。

保留工作区原有改动。本轮未提交，也未发布到 npm、GitHub 或 Gitee。
