# DSH UI compatibility

Remote renders a dependency-free subset of dsh-genui 0.11.0. Specs are display data;
they cannot execute JavaScript or send model actions. The original JSON remains
available below every preview. Local controls reset when their message is rerendered.

Supported additions in 0.6.26-rc.2:

- `chart`: grouped and stacked bars (horizontal or vertical), positive and negative
  stacks, multi-series lines and donuts. Hover titles and data tables retain values.
- `tabs`: local switching and ArrowLeft/ArrowRight/Home/End keyboard navigation.
- `table`: click headers to cycle ascending, descending and original order; numeric
  text recognizes currency, thousands separators and k/m/b/万/亿 units. Row details
  move with their records. `types` supports text, num, delta, bar, badge, spark, ring
  and index. Index cells retain the original record number. `total` sums numeric
  columns after the first label column, excluding index/spark/ring/bar; `export`
  exposes CSV text for manual copying, not automatic clipboard access or download.
- `stat.spark`, `hero.spark`, and `progress.variant: "ring"`.
- `file-tree`: collapsible folders; no disk access.
- `diff`: escaped before/after text, stacked on small screens; no line-level diff.
- `breadcrumb`, `avatar`, and text/table/card field aliases from the plugin schema.

Still explicitly unsupported: form actions, bound filter/sort controls, grouped
table sections (`types: ["group", ...]`), arbitrary ECharts options, diagrams,
Mermaid, formula plots, 3D scenes and external media. Basic ECharts bar/line/pie
presets remain SVG previews. HTML previews remain sandboxed with scripts and
external resources disabled. Unsupported specs retain source rather than running
code or silently applying unknown transformations.

Limits: 240 components, depth 12, 200 table rows, 30 columns/tabs/diff files,
100 chart categories and 6 series. Limits prevent large model output from blocking
the interface; exceeding them returns an explicit fallback or the source fence.
