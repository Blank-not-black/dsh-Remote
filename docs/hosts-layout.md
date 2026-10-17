# 主机与连接：连接地址布局优化（2026-10-17）

本轮只调整「更多 → 主机与连接 → 连接地址」的布局密度与窄屏表现，版本保持 `0.8.0-rc.3`，未构建 APK、未实装、未提交。

## 问题

用隔离预览（`dist/hosts-ui-2026-10-17/preview.cjs`，模拟主机 + 5 条地址 + 3 个分组）实测：

| 位置 | 390px | 320px |
| --- | --- | --- |
| 单个地址行高 | 91 / 111 / 111px | **378 / 452 / 432px** |
| 分组标题高 | 58px | 58px |
| 地址行图标按钮 | 44×44px | 44×44px |

原因有三：

1. 二级设置页的通用规则 `.workflow-v8 .workflow-subpage button { min-width:44px; min-height:44px }` 也作用于分组标题里的 ⚡／✕ 与地址行的 ✎／✕。四个 44px 控件加一枚状态徽标占满行宽，地址文本被压到一字一行。
2. 地址行用 flex 顺序排列「备注／地址／令牌状态／测速徽标／两个按钮」，长地址按 `break-all` 断行，令牌状态和测速徽标各占一列，行高随文案变化。
3. 「当前组」栏允许换行，320px 下「+ 组」被挤到独立一行；桌面端分组选择器通栏铺满整张卡片。

## 改动

- **地址行改为网格**：`minmax(0,1fr) auto auto auto`，第一列是备注（最多两行，完整文本放进 `title`）与地址，后面依次是状态徽标、编辑、删除。窄屏（≤360px）改用 `"note badge badge" / "url edit del"` 两行网格，地址不再被状态挤成竖排。
- **每行只保留一条状态**：缺令牌 → 「未配置令牌」；有延迟 → 「12ms · 当前」；不可达 → 「不可达」；当前地址但未测速 → 「当前」；其余 → 「未测速」。令牌状态文案并入这一枚徽标，不再单独占位。徽标 `min-width:52px` 居中，各行操作按钮基本对齐。
- **图标按钮回归紧凑尺寸**：分组标题 32px、地址行 32px（≤360px 时 30px），分组开关 34×20px；「测速／添加／+ 组」等独立按钮仍保持 44px 触摸高度。通用 44px 规则的覆盖写在 `workflow.css`，移动与桌面共用。
- **分组标题单行省略**：名称包在 `.srv-group-label` 里 `ellipsis`，计数徽标固定在右侧，不再一字一行。
- **当前组栏不换行**：`flex-wrap:nowrap`、选择器 `min-width:0`；≤360px 隐藏左标签（值已在按钮里），并给选择按钮补 `aria-label`。
- **摘要去掉空括号**：`当前：家里 · 书房主机 · 本机`，有测速结果时才追加 ` · 12ms`。
- **桌面端**：地址行同一套网格与徽标规则；分组选择器限宽 `340px`，不再通栏；行内 `.ds-mini` 按钮 34px。

## 结果

| 指标 | 改动前 | 改动后 |
| --- | --- | --- |
| 390px 地址行高 | 91 / 111 / 111px | **56 / 72 / 72px** |
| 320px 地址行高 | 378 / 452 / 432px | **74 / 74 / 74px** |
| 分组标题高 | 58px | 48px |
| 行内图标按钮 | 44×44px | 32×32px（≤360px 30×30px） |
| 横向溢出 | 0 | 0 |

## 验证

- `npm run check`：**575 项，567 通过、8 跳过、0 失败**。新增 `tests/hosts-layout.test.js`（4 项）覆盖网格/窄屏布局、单条状态徽标与「当前」、中英文标签、桌面端一致性。
- 隔离预览（无真实 DSH、无真实令牌）：390 深色/浅色、320 浅色英文、空状态、滚动到添加与扫码区域、桌面深色截图；`layout-audit.json` 记录每行的宽高、按钮尺寸、横向溢出。
- 交互探针（同一隔离页面）：手选模式点击第二条地址后 `groupActive` 变为该条、行变高亮、徽标变「当前」、摘要同步；点击「公司」分组后 `activeGroup` 切换、其余分组收起；页面无 JS 错误。
- 边界：截图与探针都基于模拟上游，不代表真实 DSH 会话或 Android 真机手感；未在真机复验 44px 以上的独立按钮触摸区域。

## 文件

- `public/styles.css`：地址行网格、徽标、图标按钮、分组标题与当前组栏。
- `public/workflow.css`：二级页 44px 规则的紧凑覆盖、≤360px 两行布局、桌面分组选择器窄屏规则。
- `public/app.js`：地址行与分组标题模板、单一状态徽标、`aria-label`、摘要文案。
- `public/index.html`：`servers.currentOnly`、`groups.currentLabel`，并去掉摘要里的 `{ms}`。
- `public/desktop/desktop.css`、`public/desktop/desktop.js`、`public/desktop/desktop.html`：桌面端同构改动与 `ds.*` 文案。
- `tests/hosts-layout.test.js`：新增回归。
- 插件副本由 `npm run sync-plugin` 生成。
- 预览与截图：`dist/hosts-ui-2026-10-17/`（`preview.cjs`、`capture.cjs`、`layout-audit.json`、`mobile-dark-390.png`、`mobile-light-390.png`、`mobile-dark-390-scrolled.png`、`mobile-dark-390-empty.png`、`mobile-light-en-320.png`、`desktop-dark.png`）。
