# 对话内图片预览（2026-10-17）

版本保持 `0.8.0-rc.3`；本轮同时补齐了桌面端不显示对话图片的问题。改动未提交，补丁包按同版本重新构建。

## 现状与问题

- 手机端把 `image` 内容块直接渲染成内联 `<img data:…>`，没有点击行为，长图/截图只能看缩略；
- 桌面端 `blockHtml` 对 `image` 只输出一个 🖼 占位符，**完全不显示图片**；
- 图片没有键盘入口，也没有全屏查看方式。

## 改动

- 新增共享模块 `public/image-preview.js`（零依赖，两端共用）：
  - 对话内图片渲染为可聚焦的缩略按钮 `<button class="chat-image" data-chat-image>`，点击/回车打开全屏灯箱；
  - 灯箱支持 **双击放大 2× / 双击还原**（放大后容器可滚动，并自动居中）、**点空白 / × / Escape** 关闭；
  - 打开时锁定页面滚动、把焦点移入灯箱，关闭后焦点回到原缩略图；
  - 事件委托绑定在 document 上，历史重绘、流式更新都不会丢失监听。
- 手机端 `public/index.html`、桌面端 `public/desktop/desktop.html` 增加同一个 `#image-lightbox` 结构与脚本引用；`aria-label` 中英文随界面语言切换。
- `public/workflow.css` 增加缩略图与灯箱样式（深色背景上的亮色关闭键、安全区内边距、`prefers-reduced-motion` 下无额外动画）。
- `public/app.js` 与 `public/desktop/desktop.js` 的 `image` 块改为输出缩略按钮；桌面端现在真正渲染图片，而不是占位符。
- Android 实体返回键优先关闭灯箱（`app.js` 的 `bindNativeBack`）；桌面端 Escape 关闭。

## Markdown 图片与本地文件

assistant 回复里的 Markdown 图片（`![说明](路径)`）此前会被当成普通文件链接，点击直接下载；现在：

- `public/md.js` 支持图片语法：`data:image/*`、`http(s)`、同源 `/api/...` 直接渲染缩略按钮；本地路径（绝对、相对、`file:`、裸文件名如图 `shot.png`）输出带 `data-chat-image-path` 的占位按钮，仍受 HTML 转义与 `javascript:` 过滤保护。
- `public/image-preview.js` 新增 `configure({resolvePath})` 与 `hydrate()`：占位按钮交给宿主解析成带认证的请求，用 `fetch → Blob → object URL` 载入，成功后替换为可预览的图片，失败显示「图片无法加载」而不是下载链接；用 `IntersectionObserver` 懒加载，`MutationObserver` 覆盖翻页、流式更新和历史缓存重绘产生的新节点。
- 两端宿主（`app.js` / `desktop.js`）提供 `chatImageRequest(path)`：相对路径按当前会话工作区 `cwd` 拼接，绝对路径原样使用，统一走网关 `/fs/file` 并带 Bearer 令牌；响应只做 blob，不在 DOM 里留下令牌。
- Markdown 文案的空 alt 回退到当前语言的 `block.image`。

## 验证

- `npm run check`：**594 项，586 通过、8 跳过、0 失败**。
  - `tests/image-preview-ui.test.js`（9 项）：灯箱开关、遮罩与 ×、Escape、事件委托、双击缩放、空 src 忽略、本地路径走认证请求并换成 blob、失败态、解析器未配置时不动作、MutationObserver 新增节点自动加载，以及两端模板/标记/样式一致性。
  - `tests/md-images.test.js`（4 项）：远程/data 直连、本地路径占位、裸文件名、`file:` 转换、alt 转义与 `javascript:` 过滤、无 fileLinks 时保持原文、缺 alt 回退语言文案。
  - `tests/tester-feedback-ui.test.js` 增加「灯箱打开时返回键先关灯箱」断言。
- 隔离浏览器实测（`dist/image-preview-2026-10-17/`，720×420 模拟截图，真实 DSH 未参与）：

| 检查 | 手机 390px | 桌面 1280px |
| --- | --- | --- |
| 缩略图渲染 | 342×200，`data:image/png` | 560×328（此前只有占位符） |
| Markdown 本地图片 | `shot.png` 经 `/fs/file` 载入为 `blob:`，缩略 342×200 | 同左 |
| 点击打开 | 灯箱显示、页面滚动锁定、alt=「界面截图.png」 | 同左 |
| 双击放大 | `is-zoomed`、宽度 1440px、提示变「双击还原」 | 同左 |
| Escape / × 关闭 | 关闭并解锁滚动 | 同左 |

截图：`mobile-chat.png`（缩略图）、`mobile-lightbox.png`、`mobile-zoom.png`、`mobile-markdown-lightbox.png`（Markdown 本地图片）、`desktop-chat.png`、`desktop-lightbox.png`；数据 `probe.json`。

边界：隔离模拟数据，未在真机验证双指缩放（实现的是双击 2× 与滚动）；超大数据 URL 图片未做压缩，仍按原图解码；多图之间没有左右切换。本地图片依赖会话工作区 `cwd` 与网关允许根；工作区未知或文件被删除时显示「图片无法加载」，不会退回下载。

## 文件

- 新增 `public/image-preview.js`、`tests/image-preview-ui.test.js`、`tests/md-images.test.js`。
- 修改 `public/md.js`、`public/index.html`、`public/desktop/desktop.html`、`public/workflow.css`、`public/app.js`、`public/desktop/desktop.js`、`scripts/sync-plugin.mjs`、`tests/tester-feedback-ui.test.js`、`docs/usage.md`。
- 插件副本由 `npm run sync-plugin` 生成；APK 与 `update.json` 按同版本补丁重新构建。
