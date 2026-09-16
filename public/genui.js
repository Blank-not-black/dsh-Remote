/* DSH Remote: dependency-free, read-only dsh-ui subset. Never executes model code. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.DshGenUi = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const palette = ['#2563eb', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2']
  const array = value => Array.isArray(value) ? value : []
  const number = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12
  const color = (value, i) => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value || '') ? value : palette[i % palette.length]
  const raw = value => '<pre><code>' + esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '</code></pre>'
  const details = value => '<details class="genui-source"><summary>JSON / 源码</summary>' + raw(value) + '</details>'
  let uid = 0
  function spark(values) {
    if (!Array.isArray(values) || values.length < 2 || values.length > 100 || !values.every(number)) return ''
    const low = Math.min(...values), span = Math.max(...values) - low || 1
    return '<svg class="genui-spark" viewBox="0 0 120 30" role="img" aria-label="趋势"><title>' + esc(values.join(', ')) + '</title><polyline fill="none" stroke="currentColor" stroke-width="2" points="' + values.map((v, i) => (2 + i * 116 / (values.length - 1)) + ',' + (28 - (v - low) / span * 26)).join(' ') + '"/></svg>'
  }
  function ring(value, label) {
    const pct = Math.max(0, Math.min(100, value))
    return '<span class="genui-ring"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" opacity=".15" stroke-width="4"/><circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" stroke-width="4" pathLength="100" stroke-dasharray="' + pct + ' 100" transform="rotate(-90 20 20)"/></svg><span>' + esc(label) + '</span></span>'
  }
  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
    let s = String(value ?? '').trim().replace(/^[¥$€£]/, '').replace(/%$/, '')
    if (!s) return NaN
    let factor = 1
    const unit = s.slice(-1).toLowerCase()
    if ('kmb万亿'.includes(unit)) { factor = ({ k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 })[unit]; s = s.slice(0, -1) }
    return s.trim() ? Number(s.replace(/[,，\s]/g, '')) * factor : NaN
  }
  function unsupported(node, reason) {
    return '<div class="genui-unsupported">暂不支持 / Unsupported: ' + esc(reason || node?.type || 'spec') + details(node) + '</div>'
  }

  function chart(node) {
    const kind = node.kind || 'bars'
    if (!['bars', 'line', 'donut'].includes(kind) || (node.stacked && kind !== 'bars') || node.filter || node.sortField) return unsupported(node, 'chart options')
    const series = array(node.series).length ? node.series : [{ label: node.title || '', data: node.data }]
    if (series.length > 6 || (kind === 'donut' && series.length !== 1)) return unsupported(node, 'chart series')
    if (series.some(s => !s || !Array.isArray(s.data) || !s.data.length || s.data.length > 100 || s.data.some(d => !d || !number(d.value)))) return unsupported(node, 'chart data')
    const data = series[0].data
    if (series.some(s => s.data.length !== data.length || s.data.some((d, i) => d.label !== data[i].label))) return unsupported(node, 'unaligned series')
    const colors = series.map((s, i) => color(s.color || array(node.palette)[i], i))
    const table = '<div class="genui-scroll"><table><thead><tr><th></th>' + series.map(s => '<th>' + esc(s.label || 'Value') + '</th>').join('') + '</tr></thead><tbody>' + data.map((d, i) => '<tr><th>' + esc(d.label) + '</th>' + series.map(s => '<td>' + esc(s.data[i].value) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'
    let svg = ''
    if (kind === 'donut') {
      const total = data.reduce((sum, d) => sum + d.value, 0)
      if (data.some(d => d.value < 0) || total <= 0) return unsupported(node, 'donut requires non-negative values and positive total')
      let offset = 0
      svg = data.map((d, i) => {
        const fraction = d.value / total * 100
        const segment = '<circle cx="160" cy="120" r="75" fill="none" stroke="' + color(d.color || array(node.palette)[i], i) + '" stroke-width="34" pathLength="100" stroke-dasharray="' + fraction + ' ' + (100 - fraction) + '" stroke-dashoffset="' + (-offset) + '" transform="rotate(-90 160 120)"><title>' + esc(d.label) + ': ' + esc(d.value) + ' (' + fraction.toFixed(1) + '%)</title></circle>'
        offset += fraction
        return segment
      }).join('') + '<text x="160" y="124" text-anchor="middle" fill="currentColor">' + esc(total) + '</text>'
      svg = '<svg viewBox="0 0 320 240" role="img" aria-label="' + esc(node.title || 'Donut chart') + '">' + svg + '</svg>'
      svg += '<div class="genui-legend">' + data.map((d, i) => '<span><i style="background:' + color(d.color || array(node.palette)[i], i) + '"></i>' + esc(d.label) + ' · ' + (d.value / total * 100).toFixed(1) + '%</span>').join('') + '</div>'
    } else {
      const values = series.flatMap(s => s.data.map(d => d.value))
      const stacked = node.stacked === true && kind === 'bars'
      if (stacked) data.forEach((_, i) => {
        values.push(series.reduce((sum, s) => sum + Math.max(0, s.data[i].value), 0))
        values.push(series.reduce((sum, s) => sum + Math.min(0, s.data[i].value), 0))
      })
      let min = Math.min(0, ...values), max = Math.max(0, ...values)
      if (min === max) max = min + 1
      const horizontal = kind === 'bars' && node.horizontal === true
      const width = 560, height = horizontal ? Math.max(240, data.length * 35 + 50) : 270
      const left = horizontal ? 110 : 64, right = 20, top = 20, bottom = 45
      const w = width - left - right, h = height - top - bottom
      const scale = value => horizontal ? left + (value - min) / (max - min) * w : top + (max - value) / (max - min) * h
      for (let i = 0; i <= 4; i++) {
        const value = min + (max - min) * i / 4, p = scale(value)
        svg += horizontal
          ? '<path d="M' + p + ' ' + top + 'V' + (top + h) + '" class="genui-gridline"/><text x="' + p + '" y="' + (height - 12) + '" text-anchor="middle">' + esc(Number(value.toPrecision(4))) + '</text>'
          : '<path d="M' + left + ' ' + p + 'H' + (left + w) + '" class="genui-gridline"/><text x="' + (left - 7) + '" y="' + (p + 4) + '" text-anchor="end">' + esc(Number(value.toPrecision(4))) + '</text>'
      }
      const step = (horizontal ? h : w) / data.length
      series.forEach((s, si) => {
        const points = []
        s.data.forEach((d, i) => {
          const base = stacked ? series.slice(0, si).reduce((sum, prev) => sum + (d.value >= 0 ? Math.max(0, prev.data[i].value) : Math.min(0, prev.data[i].value)), 0) : 0
          const center = (horizontal ? top : left) + step * (i + 0.5), pos = scale(base + d.value)
          const hint = '<title>' + esc((s.label ? s.label + ' · ' : '') + d.label + ': ' + d.value) + '</title>'
          if (kind === 'line') {
            points.push(center + ',' + pos)
            svg += '<circle cx="' + center + '" cy="' + pos + '" r="3" fill="' + colors[si] + '">' + hint + '</circle>'
          } else {
            const size = step * 0.7 / (stacked ? 1 : series.length), lane = center - step * 0.35 + (stacked ? 0 : si * size)
            const zero = scale(base)
            svg += '<rect x="' + (horizontal ? Math.min(zero, pos) : lane) + '" y="' + (horizontal ? lane : Math.min(zero, pos)) + '" width="' + (horizontal ? Math.abs(zero - pos) : size) + '" height="' + (horizontal ? size : Math.abs(zero - pos)) + '" fill="' + (series.length === 1 ? color(d.color || array(node.palette)[i], i) : colors[si]) + '">' + hint + '</rect>'
          }
        })
        if (kind === 'line') svg += '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + colors[si] + '" stroke-width="2.5"/>'
      })
      data.forEach((d, i) => {
        if (!horizontal && i % Math.ceil(data.length / 8) !== 0) return
        const text = String(d.label || '')
        svg += '<text x="' + (horizontal ? left - 6 : left + step * (i + 0.5)) + '" y="' + (horizontal ? top + step * (i + 0.5) + 4 : height - 21) + '" text-anchor="' + (horizontal ? 'end' : 'middle') + '">' + esc(text.length > 12 ? text.slice(0, 11) + '…' : text) + '</text>'
      })
      svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(node.title || kind + ' chart') + '">' + svg + '</svg>'
      if (series.length > 1) svg += '<div class="genui-legend">' + series.map((s, i) => '<span><i style="background:' + colors[i] + '"></i>' + esc(s.label) + '</span>').join('') + '</div>'
    }
    return '<figure class="genui-chart">' + (node.title ? '<figcaption>' + esc(node.title) + '</figcaption>' : '') + svg + '<details><summary>数据 / Data</summary>' + table + '</details></figure>'
  }

  function render(spec) {
    if (!spec || typeof spec !== 'object') throw Error('Invalid spec')
    let count = 0
    function nodes(items, depth) { return array(items).map(n => node(n, depth)).join('') }
    function fileTree(items, depth) {
      if (depth > 12 || (count += array(items).length) > 240) throw Error('Component limit')
      return '<ul class="genui-tree">' + array(items).map(v => !v || typeof v !== 'object' ? '<li>' + esc(v) + '</li>' : '<li>' + (v.type === 'dir' || Array.isArray(v.children) ? '<details open><summary>' + esc(v.name) + '</summary>' + fileTree(v.children, depth + 1) + '</details>' : '<span>' + esc(v.name) + '</span>') + '</li>').join('') + '</ul>'
    }
    function table(n, depth) {
      const columns = array(n.columns), rows = array(n.rows), types = array(n.types)
      if (!columns.length || rows.some(r => !Array.isArray(r)) || types.some(t => !['text', 'num', 'delta', 'bar', 'badge', 'spark', 'ring', 'index'].includes(t))) return unsupported(n, 'table shape/types')
      const cell = (v, type, i) => {
        const num = numeric(v)
        if (type === 'index') return String(i + 1)
        if (type === 'spark') return spark(String(v).split(/[\s,;]+/).map(Number)) || esc(v)
        if (type === 'ring' && Number.isFinite(num)) return ring(num, v)
        if (type === 'bar' && Number.isFinite(num)) return '<span>' + esc(v) + '</span><progress max="100" value="' + Math.max(0, Math.min(100, num)) + '"></progress>'
        if (type === 'badge') return '<span class="genui-badge">' + esc(v) + '</span>'
        if (type === 'delta') return '<span class="genui-' + (num > 0 ? 'positive' : num < 0 ? 'negative' : 'neutral') + '">' + esc(v) + '</span>'
        return esc(v)
      }
      let foot = ''
      if (n.total) foot = '<tfoot><tr>' + columns.map((_, j) => {
        const values = rows.map(r => numeric(r[j]))
        return '<td>' + (j === 0 ? '合计 / Total' : values.length && values.every(Number.isFinite) && !['index', 'spark', 'ring', 'bar'].includes(types[j]) ? esc(Number(values.reduce((a, b) => a + b, 0).toPrecision(12))) : '') + '</td>'
      }).join('') + '</tr></tfoot>'
      return '<div class="genui-scroll"><table class="genui-table"><thead><tr>' + columns.map((v, j) => '<th aria-sort="none"><button type="button" data-genui-sort="' + j + '">' + esc(v) + ' ↕</button></th>').join('') + '</tr></thead>' + rows.map((r, i) => '<tbody data-genui-order="' + i + '"><tr>' + columns.map((_, j) => '<td data-genui-value="' + esc(r[j]) + '">' + cell(r[j], types[j], i) + '</td>').join('') + '</tr>' + (array(n.details?.[i]).length ? '<tr><td colspan="' + columns.length + '"><details><summary>详情 / Details</summary>' + nodes(n.details[i], depth + 1) + '</details></td></tr>' : '') + '</tbody>').join('') + foot + '</table></div>' + (n.export ? '<details><summary>导出数据 / CSV</summary>' + raw([columns, ...rows].map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n')) + '</details>' : '')
    }
    function node(n, depth) {
      if (++count > 240 || depth > 12) throw Error('Component limit')
      if (!n || typeof n !== 'object' || Array.isArray(n)) return unsupported(n)
      // 插件公开的常用字段别名。
      n = { ...n }
      if (n.type === 'text' && n.content === undefined) n.content = n.text
      if (n.type === 'table') { n.columns ??= n.headers; n.rows ??= n.data }
      if (n.type === 'card') { n.title ??= n.label; n.items ??= n.content }
      const type = n.type
      // Reject data-transforming options rather than silently displaying different data.
      if (n.filter || n.sortField) return unsupported(n, type + ' filter/sort')
      if ((type === 'table' && (array(n.rows).length > 200 || array(n.columns).length > 30)) ||
          (['list', 'timeline', 'steps', 'keyvalue'].includes(type) && array(n.items || n.steps || n.pairs).length > 100)) return unsupported(n, type + ' size limit')
      if (['row', 'col', 'grid', 'card'].includes(type)) {
        const cols = Math.max(1, Math.min(4, Math.floor(Number(n.cols) || 2)))
        return '<section class="genui-' + type + '"' + (type === 'grid' ? ' style="--genui-cols:' + cols + '"' : '') + '>' + (n.title ? '<h4>' + esc(n.title) + '</h4>' : '') + nodes(n.items, depth + 1) + '</section>'
      }
      if (type === 'text') { const tag = ['h1', 'h2', 'h3'].includes(n.size) ? n.size : 'p'; return '<' + tag + '>' + esc(n.content) + '</' + tag + '>' }
      if (type === 'hero') return '<div class="genui-stat"><small>' + esc(n.label) + '</small><strong>' + esc(n.value) + '</strong><h4>' + esc(n.title) + '</h4><span>' + esc(n.subtitle) + '</span><span>' + esc(n.delta) + '</span>' + spark(n.spark) + '</div>'
      if (type === 'stat') return '<div class="genui-stat"><small>' + esc(n.label) + '</small><strong>' + esc(n.value) + '</strong><span>' + esc(n.delta) + '</span>' + spark(n.spark) + '</div>'
      if (type === 'badge') return '<span class="genui-badge">' + esc(n.label) + '</span>'
      if (type === 'divider') return '<hr>'
      if (type === 'spacer') return '<div class="genui-spacer"></div>'
      if (type === 'progress' && !number(n.value)) return unsupported(n, 'progress value')
      if (type === 'progress' && n.variant === 'ring') return '<div>' + esc(n.label) + ring(n.value, n.valueLabel || n.value + '%') + (number(n.target) ? '<small>目标 / Target: ' + esc(n.target) + '%</small>' : '') + '</div>'
      if (type === 'progress') return '<div>' + esc(n.label) + '<progress max="100" value="' + Math.max(0, Math.min(100, Number(n.value) || 0)) + '"></progress><small>' + esc(n.valueLabel || String(n.value || 0) + '%') + '</small>' + (number(n.target) ? '<small> · 目标 / Target: ' + esc(n.target) + '%</small>' : '') + '</div>'
      if (type === 'callout') return '<aside class="genui-callout"><strong>' + esc(n.title) + '</strong><p>' + esc(n.content) + '</p></aside>'
      if (type === 'code' || type === 'json') return raw(type === 'code' ? n.code : n.value)
      if (type === 'list' || type === 'timeline' || type === 'steps') return '<ul>' + array(n.items || n.steps).slice(0, 100).map(v => '<li>' + (v && typeof v === 'object' ? (v.type ? node(v, depth + 1) : '<strong>' + esc(v.title) + '</strong> ' + esc(v.desc) + ' ' + esc(v.time)) : esc(v)) + '</li>').join('') + '</ul>'
      if (type === 'keyvalue') return '<dl>' + array(n.pairs).slice(0, 100).map(v => '<dt>' + esc(v?.key) + '</dt><dd>' + esc(v?.value) + '</dd>').join('') + '</dl>'
      if (type === 'table') return table(n, depth)
      if (type === 'file-tree') return fileTree(n.items, depth + 1)
      if (type === 'breadcrumb') return '<nav aria-label="路径">' + array(n.items).map(esc).join(' › ') + '</nav>'
      if (type === 'avatar') return '<span class="genui-badge">' + esc(n.name) + '</span>'
      if (type === 'diff') {
        if (array(n.diffs).length > 30) return unsupported(n, 'diff size limit')
        return array(n.diffs).map(d => '<details class="genui-diff" open><summary>' + esc(d?.path) + '</summary><div class="genui-grid">' + (d?.oldText == null ? '<section>新增文件 / New file</section>' : '<section><strong>修改前 / Before</strong>' + raw(d.oldText) + '</section>') + '<section><strong>修改后 / After</strong>' + raw(d?.newText) + '</section></div></details>').join('')
      }
      if (type === 'chart') return chart(n)
      if (type === 'echart' && !n.option && ['bar', 'line', 'pie'].includes(n.preset)) return '<small>ECharts 基础数据预览 / Basic preview</small>' + chart({ ...n, type: 'chart', kind: { bar: 'bars', line: 'line', pie: 'donut' }[n.preset] })
      if (type === 'tabs') {
        const id = 'genui-tabs-' + (++uid), tabs = array(n.tabs).slice(0, 30)
        return '<div class="genui-tabs"><div role="tablist" aria-label="' + esc(n.title || '标签页') + '">' + tabs.map((v, i) => '<button type="button" role="tab" id="' + id + '-tab-' + i + '" aria-controls="' + id + '-panel-' + i + '" aria-selected="' + (i === 0) + '" tabindex="' + (i === 0 ? 0 : -1) + '" data-genui-tab="' + i + '">' + esc(v?.label) + '</button>').join('') + '</div>' + tabs.map((v, i) => '<div role="tabpanel" id="' + id + '-panel-' + i + '" aria-labelledby="' + id + '-tab-' + i + '"' + (i ? ' hidden' : '') + '>' + nodes(v?.items || v?.content, depth + 1) + '</div>').join('') + '</div>'
      }
      if (type === 'accordion') return array(n.items).slice(0, 30).map(v => '<details><summary>' + esc(v?.title) + '</summary>' + nodes(v?.items, depth + 1) + '</details>').join('')
      return unsupported(n)
    }
    const body = Array.isArray(spec) ? nodes(spec, 0) : spec.type ? node(spec, 0) : nodes(spec.items, 0)
    if (!body) throw Error('No components')
    return '<section class="genui"><div class="genui-caption">DSH UI · 只读预览 / Read-only</div>' + (spec.title ? '<h3>' + esc(spec.title) + '</h3>' : '') + body + details(spec) + '</section>'
  }

  function html(source) {
    if (typeof document === 'undefined' || String(source).length > 200000) return raw(source)
    // Template contents are inert: source images cannot start fetching during sanitization.
    const template = document.createElement('template')
    template.innerHTML = String(source)
    const allowed = new Set('title style div span p br hr h1 h2 h3 h4 h5 h6 strong em b i u s small sub sup pre code blockquote ul ol li dl dt dd table thead tbody tfoot tr td th caption colgroup col section article header footer main aside figure figcaption details summary progress'.split(' '))
    function clean(parent) {
      for (const child of Array.from(parent.children)) {
        if (!allowed.has(child.localName)) { child.remove(); continue }
        for (const attr of Array.from(child.attributes)) {
          if (!['style', 'class', 'colspan', 'rowspan', 'value', 'max'].includes(attr.name)) child.removeAttribute(attr.name)
        }
        clean(child)
      }
    }
    clean(template.content)
    const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    const srcDoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + policy + '"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.6 system-ui;margin:16px;overflow-wrap:anywhere}table{border-collapse:collapse}td,th{padding:6px;border:1px solid #ccc}pre{white-space:pre-wrap}*{max-width:100%;box-sizing:border-box}</style></head><body>' + template.innerHTML + '</body></html>'
    return '<section class="genui"><div class="genui-caption">HTML · 只读预览（脚本及外部资源已禁用）</div><iframe class="genui-html" sandbox="" referrerpolicy="no-referrer" title="HTML preview" srcdoc="' + esc(srcDoc) + '"></iframe></section>'
  }
  function activateTab(button, focus = false) {
    const list = button.parentElement, tabs = Array.from(list.children)
    tabs.forEach(tab => {
      const active = tab === button
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1
      const panel = Array.from(list.parentElement.children).find(p => p.id === tab.getAttribute('aria-controls'))
      if (panel) panel.hidden = !active
    })
    if (focus) button.focus()
  }
  function compareCells(a, b) {
    const x = numeric(a), y = numeric(b)
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y
    if (Number.isFinite(x)) return -1
    if (Number.isFinite(y)) return 1
    return String(a ?? '').localeCompare(String(b ?? ''))
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', event => {
      const button = event.target.closest?.('.genui button')
      if (!button) return
      if (button.hasAttribute('data-genui-tab')) activateTab(button)
      if (button.hasAttribute('data-genui-sort')) {
        const table = button.closest('table'), th = button.parentElement
        const col = Number(button.dataset.genuiSort)
        const previous = th.getAttribute('aria-sort'), direction = previous === 'ascending' ? 'descending' : previous === 'descending' ? 'none' : 'ascending'
        Array.from(table.tHead.rows[0].cells).forEach(cell => cell.setAttribute('aria-sort', 'none'))
        th.setAttribute('aria-sort', direction)
        Array.from(table.tBodies).sort((a, b) => {
          const order = Number(a.dataset.genuiOrder) - Number(b.dataset.genuiOrder)
          if (direction === 'none') return order
          const compared = compareCells(a.rows[0].cells[col]?.dataset.genuiValue, b.rows[0].cells[col]?.dataset.genuiValue)
          return (direction === 'ascending' ? compared : -compared) || order
        }).forEach(body => table.insertBefore(body, table.tFoot))
      }
    })
    document.addEventListener('keydown', event => {
      const button = event.target.closest?.('.genui [data-genui-tab]')
      if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const tabs = Array.from(button.parentElement.children), i = tabs.indexOf(button)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      event.preventDefault(); activateTab(tabs[next], true)
    })
  }
  return { render, html, compareCells }
})
