# DSH UI compatibility

> Checked against the published dsh-genui 0.17.0 schema. [Documentation](README.md).

手机 WebUI/Android 与桌面 WebUI 共用 `public/genui.js`；HarmonyOS 仅显示源码。这里列出的本地交互不回传模型、不读写主机文件。HTML 预览针对会话中的 HTML/HTM 代码块，不承诺文件浏览器中的独立 HTML 页面预览。

Remote renders a dependency-free, read-only subset. The original JSON is
available below each preview. Local controls reset when their message is rerendered.

Current supported components and interactions:

- `chart`: grouped and stacked bars (horizontal or vertical), positive and negative
  stacks, multi-series lines and donuts. Hover titles and data tables retain values.
- `tabs`: local switching and ArrowLeft/ArrowRight/Home/End keyboard navigation.
- `table`: click headers to cycle ascending, descending and original order; numeric
  text recognizes currency, thousands separators and k/m/b/万/亿 units. Row details
  move with their records. `types` supports text, num, delta, bar, badge, spark, ring
  and index. Index cells retain the original record number. `total` sums numeric
  columns after the first label column, excluding index/spark/ring/bar; `export`
  exposes CSV text for manual copying. Use `wrap: true` to wrap long text and
  retain line breaks. Nested tables follow their own wrap setting.
- `stat.spark`, `hero.spark`, and `progress.variant: "ring"`.
- `file-tree`: collapsible folders; no disk access.
- `diff`: escaped before/after text, stacked on small screens; no line-level diff.
- `breadcrumb`, `avatar`, and field aliases including `card.body` and `grid.columns`.
- `image` and `compare`: use raster images accessible to the current session
  through the Remote gateway. The existing chat image viewer handles enlargement.
  Comparison panels sit side by side and stack on narrow screens. The slider
  layout uses the same read-only pair.
- Nodes with `when` depend on the upstream form state. Remote marks conditional
  content as unsupported and preserves it in the source view.

Still explicitly unsupported: form actions, bound filter/sort controls, grouped
table sections (`types: ["group", ...]`), arbitrary ECharts options, diagrams,
Mermaid, formula plots, 3D scenes and external media. Basic ECharts bar/line/pie
presets remain SVG previews. HTML previews remain sandboxed with scripts and
external resources disabled. Unsupported specs retain source rather than running
code or silently applying unknown transformations.

Limits: 240 components, depth 12, 200 table rows, 30 columns/tabs/diff files,
100 chart categories and 6 series. Limits prevent large model output from blocking
the interface; exceeding them returns an explicit fallback or the source fence.

See [copyable examples](genui-sample.md). `tests/genui.test.js` covers rendering,
escaping, unsupported transformations and budgets. Browser layout and Android
WebView behavior still require their own checks; old RC validation is preserved
in the [historical record](genui-rc5.md).
