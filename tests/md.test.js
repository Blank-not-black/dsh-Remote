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
