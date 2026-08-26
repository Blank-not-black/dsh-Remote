# DSH Remote 模块文档与 Vibe Coding 规范

> 目的：让每次需求都有明确的模块归属、实现边界、数据契约和验证路径，减少重复实现与跨模块冲突。
>
> 核对基线：`0.6.15`（2026-08-26 工作区）。本文档描述当前代码和已确认的开发规则，不替代源码和测试。

## 1. 文档使用方式

开始需求前：

1. 先在本索引中找到涉及的模块。
2. 阅读该模块的“边界与禁止事项”“契约”“测试与验收”。
3. 如果需求跨模块，先阅读 [跨模块协议与数据契约](01-contracts.md)，再分别修改各模块文档涉及的源码。
4. 修改完成后，把实际新增的行为、数据字段和测试补回对应文档。

模块文档只记录已经确认的实现。想法、未决方案和未来能力必须放进“未决事项”，不能写成已支持功能。

## 2. 模块清单

| 文档 | 模块 | 主要代码范围 |
| --- | --- | --- |
| [01-contracts.md](01-contracts.md) | 跨模块协议与数据契约 | QR、服务器状态、HTTP/WS、DSH RPC、版本能力 |
| [02-gateway.md](02-gateway.md) | 独立网关 | `gateway.js`、`gateway-stats.cjs` |
| [03-plugin.md](03-plugin.md) | DSH 插件集成 | `packages/plugin/index.mjs`、`client.js`、插件页面 |
| [04-mobile-webui.md](04-mobile-webui.md) | 手机 WebUI / Android 前端 | `public/index.html`、`public/app.js` |
| [05-desktop-webui.md](05-desktop-webui.md) | 桌面 WebUI | `public/desktop/*` |
| [06-admin-console.md](06-admin-console.md) | 网关管理控制台 | `public/admin.html`、`public/admin.js` |
| [07-android-app.md](07-android-app.md) | Android 原生壳与服务 | `android/` |
| [08-shared-frontend.md](08-shared-frontend.md) | 共享前端能力 | 主题、i18n、Markdown、动效、图标、加密 |
| [09-build-release.md](09-build-release.md) | 构建、同步与发布 | `package.json`、`scripts/`、产物 |
| [10-tests-qa.md](10-tests-qa.md) | 测试与真实场景 QA | `tests/`、fixture、门禁 |

## 3. 统一模块文档格式

每个模块文档必须包含以下栏目；模块专属内容可以插入“接口与数据契约”和“边界与禁止事项”之间，但不能省略这些基本信息：

1. **模块定位**：它为谁解决什么问题。
2. **代码结构**：源码、产物、入口和关键文件。
3. **功能**：当前已经支持的用户行为。
4. **具体实现方式**：状态、流程、关键函数和技术限制。
5. **制作目的**：为什么存在，解决了什么架构或产品问题。
6. **接口与数据契约**：请求、响应、事件、持久化字段和兼容要求。
7. **边界与禁止事项**：不应由本模块承担的责任，以及不能破坏的规则。
8. **测试与验收**：对应测试、人工检查和不能由自动化替代的部分。
9. **修改前检查清单**：Vibe Coding 开始前的最小确认项。
10. **未决事项**：只放未决定的设计，不冒充现状。

## 4. 全局改动规则

- 根目录 `public/` 是 WebUI 源码；`packages/plugin/public/` 是同步产物，禁止直接编辑后者。
- `gateway.js` 是网关源文件；改动后必须运行 `npm run sync-plugin`，同步为 `gateway.cjs`。
- 不新增运行时依赖，不改变单文件网关和零构建纯 JavaScript WebUI 的发布形态。
- 跨端功能必须同时检查手机端和桌面端；跨端契约改变时，必须更新 [01-contracts.md](01-contracts.md)。
- 需求修复默认只改代码、测试和模块文档，不自动改版本、不提交、不发布、不安装。
- 最低门禁：`npm run sync-plugin`、`npm run check`、`git diff --check`。
- 真实重启、降级、恢复、Android 原生桥和真机行为，不能仅用静态测试结果代替。

## 5. Vibe Coding 变更记录格式

在对应模块文档末尾追加一条简短记录：

```text
### YYYY-MM-DD：变更标题
- 需求：用户要解决什么问题。
- 方案：改了哪个入口、状态或契约。
- 联动：需要同步哪些模块/产物。
- 验证：测试、真机或人工验证结果。
- 未做：明确没有做的发布、安装或未来能力。
```

如果变更只是内部重构，也要说明对外行为是否保持不变。
