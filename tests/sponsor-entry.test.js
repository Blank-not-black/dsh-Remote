'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/sponsor-entry.js'), 'utf8')
test('client sponsor entry refreshes pause/full/disabled states without duplicate links or credentials', async () => {
  let click, now = 100000, config = { enabled: true, accepting: true, remaining: 2 }
  const calls = [], body = { children: [], append(node) { node.parent = this; this.children.push(node) } }
  const node = () => ({ dataset: {}, children: [], append(child) { this.children.push(child) }, remove() { this.parent.children = this.parent.children.filter(child => child !== this) } })
  vm.runInNewContext(source, { window: { I18N: { lang: 'zh' } }, Date: { now: () => now }, AbortSignal,
    document: { addEventListener: (name, fn) => { click = fn }, createElement: node, querySelectorAll: selector => selector === '.donate-body' ? [body] : body.children },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => config } } })
  const open = () => click({ target: { closest: () => true } })
  await open(); assert.match(body.children[0].children[0].textContent, /单次赞助/)
  await open(); assert.equal(calls.length, 1)
  now += 31000; config = { enabled: true, accepting: false }; await open()
  assert.equal(body.children.length, 1); assert.match(body.children[0].children[0].textContent, /暂停新申请.*查询/)
  now += 31000; config = { enabled: true, accepting: true, remaining: 0 }; await open()
  assert.match(body.children[0].children[0].textContent, /名额已满.*查询/)
  now += 31000; config = { enabled: false }; await open(); assert.equal(body.children.length, 0)
  assert.ok(calls.every(call => call.options.credentials === 'omit' && !call.options.headers))
})
