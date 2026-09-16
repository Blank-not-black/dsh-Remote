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
  function unsupported(node, reason) {
    return '<div class="genui-unsupported">暂不支持 / Unsupported: ' + esc(reason || node?.type || 'spec') + details(node) + '</div>'
  }

  function chart(node) {
    const kind = node.kind || 'bars'
    if (!['bars', 'line', 'donut'].includes(kind) || node.stacked || node.filter || node.sortField) return unsupported(node, 'chart options')
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
          const center = (horizontal ? top : left) + step * (i + 0.5), pos = scale(d.value)
          const hint = '<title>' + esc((s.label ? s.label + ' · ' : '') + d.label + ': ' + d.value) + '</title>'
          if (kind === 'line') {
            points.push(center + ',' + pos)
            svg += '<circle cx="' + center + '" cy="' + pos + '" r="3" fill="' + colors[si] + '">' + hint + '</circle>'
          } else {
            const size = step * 0.7 / series.length, lane = center - step * 0.35 + si * size
            const zero = scale(0)
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
    function node(n, depth) {
      if (++count > 240 || depth > 12) throw Error('Component limit')
      if (!n || typeof n !== 'object' || Array.isArray(n)) return unsupported(n)
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
      if (type === 'hero') return '<div class="genui-stat"><small>' + esc(n.label) + '</small><strong>' + esc(n.value) + '</strong><h4>' + esc(n.title) + '</h4><span>' + esc(n.subtitle) + '</span><span>' + esc(n.delta) + '</span></div>'
      if (type === 'stat') return '<div class="genui-stat"><small>' + esc(n.label) + '</small><strong>' + esc(n.value) + '</strong><span>' + esc(n.delta) + '</span></div>'
      if (type === 'badge') return '<span class="genui-badge">' + esc(n.label) + '</span>'
      if (type === 'divider') return '<hr>'
      if (type === 'spacer') return '<div class="genui-spacer"></div>'
      if (type === 'progress' && !number(n.value)) return unsupported(n, 'progress value')
      if (type === 'progress') return '<div>' + esc(n.label) + '<progress max="100" value="' + Math.max(0, Math.min(100, Number(n.value) || 0)) + '"></progress><small>' + esc(n.valueLabel || String(n.value || 0) + '%') + '</small>' + (number(n.target) ? '<small> · 目标 / Target: ' + esc(n.target) + '%</small>' : '') + '</div>'
      if (type === 'callout') return '<aside class="genui-callout"><strong>' + esc(n.title) + '</strong><p>' + esc(n.content) + '</p></aside>'
      if (type === 'code' || type === 'json') return raw(type === 'code' ? n.code : n.value)
      if (type === 'list' || type === 'timeline' || type === 'steps') return '<ul>' + array(n.items || n.steps).slice(0, 100).map(v => '<li>' + (v && typeof v === 'object' ? (v.type ? node(v, depth + 1) : '<strong>' + esc(v.title) + '</strong> ' + esc(v.desc) + ' ' + esc(v.time)) : esc(v)) + '</li>').join('') + '</ul>'
      if (type === 'keyvalue') return '<dl>' + array(n.pairs).slice(0, 100).map(v => '<dt>' + esc(v?.key) + '</dt><dd>' + esc(v?.value) + '</dd>').join('') + '</dl>'
      if (type === 'table') return '<div class="genui-scroll"><table><thead><tr>' + array(n.columns).slice(0, 30).map(v => '<th>' + esc(v) + '</th>').join('') + '</tr></thead><tbody>' + array(n.rows).slice(0, 200).map(row => '<tr>' + array(row).slice(0, 30).map(v => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'
      if (type === 'chart') return chart(n)
      if (type === 'echart' && !n.option && ['bar', 'line', 'pie'].includes(n.preset)) return '<small>ECharts 基础数据预览 / Basic preview</small>' + chart({ ...n, type: 'chart', kind: { bar: 'bars', line: 'line', pie: 'donut' }[n.preset] })
      if (type === 'accordion' || type === 'tabs') return array(n.tabs || n.items).slice(0, 30).map(v => '<details><summary>' + esc(v?.label || v?.title) + '</summary>' + nodes(v?.items, depth + 1) + '</details>').join('')
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
  return { render, html }
})
