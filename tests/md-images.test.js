'use strict'

const test = require('node:test')
const assert = require('node:assert')
const mdToHtml = require('../public/md.js')

test('mdToHtml images: remote and data URLs become preview buttons that load directly', () => {
  const remote = mdToHtml('![架构图](https://example.com/a.png)')
  assert.ok(remote.includes('class="chat-image" data-chat-image'))
  assert.ok(remote.includes('src="https://example.com/a.png"'))
  assert.ok(remote.includes('alt="架构图"'))
  assert.ok(!remote.includes('<a '), 'not rendered as a file download link')
  const data = mdToHtml('![x](data:image/png;base64,AAAA)')
  assert.ok(data.includes('class="chat-image" data-chat-image'))
  assert.ok(data.includes('src="data:image/png;base64,AAAA"'))
})

test('mdToHtml images: local paths become authenticated placeholders in chat', () => {
  const html = mdToHtml('![界面](dist/hosts-ui/mobile-dark.png)', { fileLinks: true, imageLabel: 'Image' })
  assert.ok(html.includes('data-chat-image-path="dist/hosts-ui/mobile-dark.png"'))
  assert.ok(html.includes('class="chat-image is-loading"'))
  assert.ok(html.includes('data-chat-image-alt="界面"'))
  assert.ok(!html.includes('data-dsh-file-path'), 'image must not fall back to a download link')
  const fileUrl = mdToHtml('![a](file:///D:/work/a.png)', { fileLinks: true })
  assert.ok(fileUrl.includes('data-chat-image-path="D:/work/a.png"'))
})

test('mdToHtml images: alt text is escaped and unsafe schemes stay text', () => {
  const escaped = mdToHtml('!["><script>alert(1)</script>](dist/a.png)', { fileLinks: true })
  assert.ok(!escaped.includes('<script>'))
  assert.ok(escaped.includes('&quot;&gt;alert(1)'), 'tags are stripped and quotes escaped')
  const unsafe = mdToHtml('![x](javascript:alert(1))', { fileLinks: true })
  assert.ok(!unsafe.includes('data-chat-image'))
  assert.ok(!unsafe.includes('href="javascript:'))
  const notChat = mdToHtml('![a](dist/a.png)')
  assert.ok(!notChat.includes('data-chat-image'), 'file preview mode keeps plain markdown')
})

test('mdToHtml images: missing alt falls back to the caller label', () => {
  const html = mdToHtml('![](https://example.com/a.png)', { imageLabel: 'Image' })
  assert.ok(html.includes('aria-label="Image"'))
  const zh = mdToHtml('![](https://example.com/b.png)', { imageLabel: '图片' })
  assert.ok(zh.includes('aria-label="图片"'))
})
