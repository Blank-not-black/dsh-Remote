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
  assert.ok(html.includes('<th style="text-align:left">名称</th>'))
  assert.ok(html.includes('<th style="text-align:right">数量</th>'))
  assert.ok(html.includes('<th style="text-align:center">备注</th>'))
  assert.ok(html.includes('<td style="text-align:right">3</td>'))
  assert.ok(html.includes('梨'))
})

test('mdToHtml: table cells support inline markdown and remain HTML-escaped', () => {
  const html = mdToHtml('| **加粗** | <b>x</b> |\n| --- | --- |\n| [链接](https://a.com) | `code` |')
  assert.ok(html.includes('<th><strong>加粗</strong></th>'))
  assert.ok(html.includes('<th>&lt;b&gt;x&lt;/b&gt;</th>'))
  assert.ok(html.includes('href="https://a.com"'))
  assert.ok(html.includes('<code>code</code>'))
})

test('mdToHtml: a pipe line without a separator is not treated as a table', () => {
  const html = mdToHtml('a | b\nc | d')
  assert.ok(!html.includes('<table>'))
  assert.ok(html.includes('<p>'))
  assert.ok(html.includes('a | b'))
})

test('mdToHtml: screenshot regression keeps loose numbering and nested alternatives', () => {
  const html = mdToHtml('1. **命名规范**：提供学号\n\n2. **干涉检查**：三个办法：\n\n   - A：参照体\n   - B：零件\n   - C：间隙\n\n3. **主装配基准面**\n\n4. **规则措辞**')
  assert.equal((html.match(/<ol>/g) || []).length, 1)
  assert.equal((html.match(/<li>/g) || []).length, 7)
  assert.ok(html.includes('<ul><li>A：参照体</li><li>B：零件</li><li>C：间隙</li></ul></li><li><p><strong>主装配基准面'))
})

test('mdToHtml: ordered list starts survive separate blocks and repeated source markers count normally', () => {
  assert.equal(mdToHtml('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>')
  assert.equal(mdToHtml('1. first\n\n1. second'), '<ol><li><p>first</p></li><li><p>second</p></li></ol>')
  assert.equal(mdToHtml('2) second\n\n# New section\n\n4. fourth'), '<ol start="2"><li>second</li></ol><h1>New section</h1><ol start="4"><li>fourth</li></ol>')
})

test('mdToHtml: continuation paragraphs, nested numbering and top-level blocks stay separate', () => {
  const html = mdToHtml('1. first\n   continuation\n\n   another paragraph\n\n   2. nested\n   3. nested again\n\n2. second\n\noutside\n\n- separate')
  assert.equal(html, '<ol><li><p>first<br>continuation</p><p>another paragraph</p><ol start="2"><li>nested</li><li>nested again</li></ol></li><li><p>second</p></li></ol><p>outside</p><ul><li>separate</li></ul>')
})

test('mdToHtml: list markers support indentation and nested content stays escaped', () => {
  const html = mdToHtml('  0. **zero**\n     + <script>bad</script>\n     + [x](javascript:alert(1))\n  1. next')
  assert.ok(html.startsWith('<ol start="0"><li><strong>zero</strong><ul>'))
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('href="javascript:'))
  assert.ok(mdToHtml('- parent\n\t- child').includes('<ul><li>child</li></ul>'))
})
