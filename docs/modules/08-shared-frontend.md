# 共享前端能力模块

> 状态：现行基础设施
>
> 源码范围：`public/i18n.js`、`theme.js`、`theme-vars.css`、`styles.css`、`md.js`、`sha256.js`、`motion.js`、`morphicons-init.js`、`transcribe-core.js`、本地 vendor 目录

## 1. 模块定位

这些文件提供跨手机、桌面、管理页和插件页共享的基础能力。它们不是某一个页面的业务模块，修改时要特别注意影响面和同步产物。

## 2. 代码结构

| 文件 | 功能 |
| --- | --- |
| `i18n.js`、各端 i18n | 翻译初始化、key 查找和占位符替换 |
| `theme.js`、`theme-vars.css` | 四套主题、状态色和主题持久化 |
| `styles.css`、desktop CSS | 公共组件、移动/桌面布局和状态样式 |
| `md.js` | 先转义再渲染的零依赖 Markdown/GFM 子集 |
| `sha256.js` | 浏览器原生 `crypto.subtle` 校验封装 |
| `motion.js` | GSAP 本地资源、timeline、列表重排和 reduced-motion |
| `morphicons-init.js` | 本地 Web Component 图标与静态 SVG 回退 |
| `transcribe-core.js` | Prompt 转写、SSE 解析和增量拼接 |
| `vendor/` | 本地 GSAP/Morphicons 静态资源与许可证 |

## 3. 当前功能

- 中英切换和各页面独立命名空间翻译。
- default/dark/light/neutral 四套主题，状态色独立于主题色。
- 安全 Markdown：HTML 转义、代码、列表、引用、链接和 GFM 表格。
- 文件上传 SHA-256 和 Prompt 转写的 SSE 增量处理。
- 页面/列表进入动效、位置重排、拖拽反馈和 reduced-motion 保护。
- 图标 Web Component 初始化失败时仍可使用静态 SVG。

## 4. 具体实现方式

Markdown 必须先 `escape` 用户内容，再识别标记；链接协议只允许安全协议，不能直接把远端 Markdown 当 HTML 插入。校验使用浏览器原生 `crypto.subtle`，不能添加第三方 hash 库。

动效使用仓库内本地 GSAP，不从 CDN 加载。所有动效都应允许 `prefers-reduced-motion` 跳过；布局变化优先 transform/位置重排，不能用持续动画掩盖状态问题。

主题只改变视觉变量，不改变组件位置、协议或交互。图标优先本地 Morphicons，必须保留可读的静态 SVG/文本回退。

## 5. 制作目的

- 统一多端视觉和安全行为。
- 在零新增依赖约束下复用基础能力。
- 把 XSS、动画性能、图标和翻译等横向风险集中测试。

## 6. 接口与数据契约

共享基础资源以浏览器全局、脚本加载顺序和约定 key 提供能力，不定义新的 DSH RPC。修改加载方式时，必须同时检查手机、桌面、管理页、插件页和 `sync-plugin` 文件清单。

## 7. 边界与禁止事项

- 不引入 CDN 脚本或新的运行时依赖。
- 不让主题色承担 success/warning/error 语义。
- 不用 Emoji 取代既有线性 SVG 图标系统。
- 不把 Markdown 渲染器改成任意 HTML 直通。
- 修改根 `public/` 后必须同步插件副本。

## 8. 测试与验收

- `tests/md.test.js`：Markdown 转义、链接、代码、表格和安全性。
- `tests/transcribe-core.test.js`：密钥掩码、SSE 分帧和增量顺序。
- `tests/network-regression.test.js`：图标、GSAP、动效和拖拽契约。
- `tests/plugin-icon.test.js`：插件图标边界。
- UI 改动需检查手机窄屏、桌面宽屏、空状态、长文本、弹窗和 reduced-motion。

## 9. 修改前检查清单

- 这是共享能力还是页面业务？是否应放在本模块？
- 是否存在第三方依赖/CDN 风险？
- 是否有 XSS、隐私、性能或无障碍影响？
- 手机、桌面、管理和插件页面是否都加载该资源？
- 是否更新静态测试和插件同步副本？

## 10. 未决事项

- 当前前端资源仍是零构建静态文件；如果未来进行模块化，需要先定义 browser module 加载与插件打包策略。
