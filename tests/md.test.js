'use strict'

const test = require('node:test')
const assert = require('node:assert')
const mdToHtml = require('../public/md.js')

test('mdToHtml: escapes HTML and renders basic markdown', () => {
  const html = mdToHtml('# Hi\n\n**bold** and *italic*')
  assert.ok(html.includes('<h1>Hi</h1>'))
  assert.ok(html.includes('<strong>bold</strong>'))
  assert.ok(html.includes('<em>italic</em>'))
  assert.ok(!html.includes('<script>'))
})

test('mdToHtml: renders code blocks, lists, blockquote and safe links', () => {
  const html = mdToHtml('```\nconst a = 1\n```\n\n- a\n- b\n\n> quote\n\n[x](https://example.com)')
  assert.ok(html.includes('<pre><code>const a = 1</code></pre>'))
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'))
  assert.ok(html.includes('<blockquote>quote</blockquote>'))
  assert.ok(html.includes('href="https://example.com"'))
})

test('mdToHtml: blocks javascript links and escapes inline script', () => {
  const html = mdToHtml('[x](javascript:alert(1)) <script>alert(1)</script>')
  assert.ok(!html.includes('href="javascript:'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('javascript:alert(1)'))
})

test('mdToHtml: renders GFM tables with header, body and alignment', () => {
  const html = mdToHtml('| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 苹果 | 3 | 好吃 |\n| 梨 | 2 | 一般 |')
  assert.ok(html.includes('<table>'))
  assert.ok(html.includes('<thead><tr><th>名称</th><th style="text-align:right">数量</th><th style="text-align:center">备注</th></tr></thead>'))
  assert.ok(html.includes('<tbody><tr><td>苹果</td><td style="text-align:right">3</td><td style="text-align:center">好吃</td></tr>'))
  assert.ok(html.includes('梨'))
})

test('mdToHtml: table cells support inline markdown and are HTML-escaped', () => {
  const html = mdToHtml('| **加粗** | <b>x</b> |\n| --- | --- |\n| [链接](https://a.com) | `code` |')
  assert.ok(html.includes('<th><strong>加粗</strong></th>'))
  assert.ok(html.includes('<th>&lt;b&gt;x&lt;/b&gt;</th>'))
  assert.ok(html.includes('href="https://a.com"'))
  assert.ok(html.includes('<code>code</code>'))
})

test('mdToHtml: 非表格的 | 行不误判为表格（缺分隔行按段落渲染）', () => {
  const html = mdToHtml('a | b\nc | d')
  assert.ok(!html.includes('<table>'))
  assert.ok(html.includes('<p>'))
  assert.ok(html.includes('a | b'))
})
