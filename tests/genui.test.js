'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const md = require('../public/md.js')
const genui = require('../public/genui.js')
const fence = value => '```dsh-ui\n' + JSON.stringify(value) + '\n```'

test('dsh-ui renders layouts, text, tables and common charts inside Markdown', () => {
  const html = md('Before\n' + fence({ title: 'Report', items: [
    { type: 'grid', cols: 2, items: [{ type: 'stat', label: 'Revenue', value: '120' }, { type: 'progress', value: 40 }] },
    { type: 'chart', kind: 'bars', data: [{ label: 'A', value: -4 }, { label: 'B', value: 10 }] },
    { type: 'chart', kind: 'line', series: [{ label: 'S1', data: [{ label: 'A', value: 2 }] }, { label: 'S2', data: [{ label: 'A', value: 3 }] }] },
    { type: 'chart', kind: 'donut', data: [{ label: 'A', value: 1 }, { label: 'B', value: 3 }] },
  ] }) + '\nAfter')
  assert.match(html, /<p>Before<\/p>/)
  assert.match(html, /<p>After<\/p>/)
  assert.match(html, /class="genui-grid"/)
  assert.equal((html.match(/<svg /g) || []).length, 3)
  assert.match(html, /25\.0%/)
  assert.match(html, /<td>-4<\/td>/)
  assert.doesNotMatch(html, /(?:NaN|Infinity)/)
})

test('unclosed/invalid fences stay source, unknown components are explained and retained', () => {
  assert.doesNotMatch(md('```dsh-ui\n{"items":['), /class="genui"/)
  assert.doesNotMatch(md('```dsh-ui\nnot JSON\n```'), /class="genui"/)
  assert.match(md(fence({ type: 'scene3d', meshes: [] })), /Unsupported: scene3d/)
  assert.match(md(fence({ type: 'chart', kind: 'bars', stacked: true })), /Unsupported: chart options/)
  assert.match(md('```json dsh-ui\n{"type":"text","content":"ok"}\n```'), /<p>ok<\/p>/)
})

test('model strings and chart colors cannot inject HTML, attributes, scripts or requests', () => {
  const evil = '"><img src=x onerror=alert(1)>'
  const html = md(fence({ title: evil, items: [
    { type: 'text', content: '<script>alert(1)</script>' },
    { type: 'chart', kind: 'bars', data: [{ label: evil, value: 1, color: 'red" onload="alert(1)' }] },
    { type: 'button', label: 'Execute', action: 'run' },
    { type: 'image', src: 'https://untrusted.example/a' },
  ] }))
  assert.doesNotMatch(html, /<script|<img|<button|onload="|onerror="|src="https:/)
  assert.match(html, /&lt;script&gt;/)
})

test('invalid numeric/negative donut data and component budget do not create misleading charts', () => {
  assert.match(genui.render({ type: 'chart', data: [{ label: 'a', value: Infinity }] }), /Unsupported/)
  assert.match(genui.render({ type: 'chart', kind: 'donut', data: [{ label: 'a', value: -1 }] }), /Unsupported/)
  assert.match(genui.render({ type: 'chart', data: [{ label: 'a', value: 0 }] }), /<svg/)
  const nested = { type: 'text', content: 'leaf' }
  let n = nested
  for (let i = 0; i < 20; i++) n = { type: 'col', items: [n] }
  assert.throws(() => genui.render(n), /limit/)
})

test('malformed nested records preserve valid siblings and series colors are honored', () => {
  const html = genui.render({ items: [
    { type: 'chart', series: [null] },
    { type: 'list', items: [null, 'Still visible'] },
    { type: 'keyvalue', pairs: [null] },
    { type: 'tabs', tabs: [null] },
    { type: 'hero', title: 'Title', label: 'Label', subtitle: 'Subtitle', delta: '+8' },
    { type: 'chart', kind: 'line', series: [{ label: 'Blue', color: '#123456', data: [{ label: 'A', value: 3 }] }] },
  ] })
  assert.match(html, /Unsupported: chart data/)
  for (const text of ['Still visible', 'Title', 'Label', 'Subtitle', '+8']) assert.ok(html.includes(text))
  assert.match(html, /stroke="#123456"/)
})

test('data transformations and oversized tables are explicit fallbacks', () => {
  assert.match(genui.render({ type: 'table', filter: 'A', columns: ['Name'], rows: [['A']] }), /Unsupported: table filter/)
  assert.match(genui.render({ type: 'table', columns: ['Name'], rows: Array.from({ length: 201 }, () => ['A']) }), /Unsupported: table size limit/)
  assert.match(genui.render({ type: 'progress', value: 25, target: 80 }), /Target: 80%/)
})

test('both shipped clients load GenUI before Markdown with matching plugin assets', () => {
  const fs = require('node:fs'), path = require('node:path')
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  for (const file of ['index.html', 'desktop/desktop.html']) {
    const html = read('public/' + file)
    assert.ok(html.indexOf('genui.js') < html.indexOf('md.js'))
    assert.ok(html.includes('genui.css'))
  }
  for (const file of ['genui.js', 'genui.css', 'md.js']) assert.equal(read('public/' + file), read('packages/plugin/public/' + file))
})
