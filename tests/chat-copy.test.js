'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const copy = require('../public/chat-copy.js'), md = require('../public/md.js')
test('message copy resolves original Markdown, preserves long text and excludes tools/reasoning', () => {
  const text = '# 标题\r\n' + '**原文** 👩‍💻\n'.repeat(5000)
  const entries = [{ seq: 1, event: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private thinking' }, { type: 'text', text }, { type: 'image', data: 'not Markdown' }] } } } }]
  assert.equal(copy.messageText(entries, '1'), text)
  assert.equal(copy.messageText(entries, '2'), '')
  assert.equal(copy.messageText([{ seq: 1, event: { type: 'tool/result', data: { content: [{ type: 'text', text }] } } }], '1'), '')
  const a = {}, b = {}; assert.equal(copy.scope(a), copy.scope(a)); assert.notEqual(copy.scope(a), copy.scope(b))
  assert.doesNotMatch(copy.button('<script>', a), /<script>/)
})
test('chat code copy is opt-in, excludes language headers and escapes content and labels', () => {
  const source = '```js\nconst x = "<script>"\n```'
  const html = md(source, { copyCode: true, copyCodeLabel: 'Copy <code>' })
  assert.match(html, /data-chat-copy-code/); assert.match(html, /<pre><code>const x = &quot;&lt;script&gt;&quot;<\/code>/)
  assert.match(html, /Copy &lt;code&gt;/); assert.doesNotMatch(html, /<script>|<code>js\n/)
  assert.doesNotMatch(md(source), /data-chat-copy-code/)
  assert.match(md('```\nplain\n```', { copyCode: true }), /<code>plain<\/code>/)
  assert.match(copy.code('<tag>\n'), /<pre><code>&lt;tag&gt;\n<\/code>/)
})
function harness() {
  let handler, valid = true, resolve, calls = [], notices = []
  const history = { visible: [{ seq: 3, event: { type: 'assistant/message', data: { content: [{ type: 'text', text: '**original**' }] } } }] }
  const button = { dataset: { chatCopyMarkdown: '3', chatCopyScope: copy.scope(history) }, disabled: false, hasAttribute: name => name === 'data-chat-copy-markdown' }
  const box = { dataset: {}, contains: () => true, addEventListener(name, fn) { handler = fn } }
  const host = { capture: () => ({ history, valid: () => valid }), copy: text => { calls.push(text); return new Promise(done => { resolve = done }) }, notice: (...value) => notices.push(value) }
  copy.bind(box, host); copy.bind(box, host)
  const click = () => handler({ target: { closest: () => button }, preventDefault() {}, stopPropagation() {} })
  return { history, button, calls, notices, click, done: result => resolve(result), invalidate: () => { valid = false } }
}
test('delegated message copy rejects stale history scopes, debounces clicks and reports failure', async () => {
  const h = harness(); h.button.dataset.chatCopyScope = 'stale'; await h.click(); assert.equal(h.calls.length, 0)
  h.button.dataset.chatCopyScope = copy.scope(h.history)
  const pending = h.click(); await h.click(); assert.deepEqual(h.calls, ['**original**']); assert.equal(h.button.disabled, true)
  h.done(false); await pending; assert.equal(h.notices[0][1], 'err'); assert.equal(h.button.disabled, false)
  const second = h.click(); h.invalidate(); h.done(true); await second; assert.equal(h.notices.length, 1)
})
test('code copy reads decoded source only and handles thrown clipboard failures', async () => {
  let handler, copied, notice
  const button = { dataset: {}, hasAttribute: () => false, closest: () => ({ querySelector: () => ({ textContent: 'a < b && c\n'.repeat(5000) }) }) }
  copy.bind({ dataset: {}, contains: () => true, addEventListener(name, fn) { handler = fn } }, {
    capture: () => ({ valid: () => true }), copy: async text => { copied = text; throw Error('denied') }, notice: (text, kind) => { notice = kind },
  })
  await handler({ target: { closest: () => button }, preventDefault() {}, stopPropagation() {} })
  assert.equal(copied, 'a < b && c\n'.repeat(5000)); assert.equal(notice, 'err'); assert.equal(button.disabled, false)
})
