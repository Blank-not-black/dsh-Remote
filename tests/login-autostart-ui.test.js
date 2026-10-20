'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8')
const code = source.slice(source.indexOf('let loginStartup ='), source.indexOf('let doctorExpanded ='))

function fixture() {
  const elements = new Map(), requests = [], notices = [], jobs = []
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', hidden: false,
      classList: { toggle(_name, value) { elements.get(id).hidden = value } },
      addEventListener(_event, fn) { this.click = fn } })
    return elements.get(id)
  }
  const context = vm.createContext({ $, token: 'A', pluginMode: false, API: '/admin/api', AbortSignal,
    t: key => key, adminHeaders: () => ({ authorization: 'Bearer A' }), toast: (...args) => notices.push(args),
    fetch: (url, options) => { requests.push({ url, options }); return new Promise((resolve, reject) => jobs.push({ resolve, reject })) } })
  vm.runInContext(code, context)
  const reply = (index, value, ok = true) => jobs[index].resolve({ ok, json: async () => value })
  return { $, context, requests, notices, jobs, reply }
}

test('Startup UI reads without enabling; unsupported and missing-file states retain explicit user choice', async () => {
  const f = fixture(), { context: c, $ } = f
  const loading = c.loadLoginStartup()
  assert.equal(f.requests[0].options.method, undefined)
  f.reply(0, { ok: true, supported: true, enabled: false })
  await loading
  assert.equal($('btn-login-startup').disabled, false)
  assert.equal($('btn-login-startup').textContent, 'startup.enable')
  assert.equal($('login-startup-status').textContent, 'startup.off')
  let next = c.loadLoginStartup()
  f.reply(1, { ok: true, supported: false, enabled: false })
  await next
  assert.equal($('btn-login-startup').disabled, true)
  next = c.loadLoginStartup()
  f.reply(2, { ok: true, supported: true, enabled: true, code: 'STARTUP_FILES_MISSING' })
  await next
  assert.equal($('btn-login-startup').textContent, 'startup.disable')
  assert.equal($('btn-login-startup-repair').hidden, false)
})

test('Toggle waits for server proof; failure keeps prior state, permits retry and refreshes', async () => {
  const f = fixture(), { context: c, $ } = f
  const load = c.loadLoginStartup()
  f.reply(0, { ok: true, supported: true, enabled: false }); await load
  const enable = c.changeLoginStartup(true)
  assert.equal($('btn-login-startup').disabled, true)
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { enabled: true })
  f.reply(1, { ok: false, detail: 'denied' }, false)
  await enable
  assert.equal(f.notices[0][0], 'denied')
  assert.equal($('btn-login-startup').textContent, 'startup.enable')
  f.reply(2, { ok: true, supported: true, enabled: false })
  await new Promise(resolve => setImmediate(resolve))
  const retry = $('btn-login-startup').click()
  f.reply(3, { ok: true, supported: true, enabled: true })
  await retry
  assert.equal($('btn-login-startup').textContent, 'startup.disable')
  assert.equal(f.notices[1][0], 'startup.savedOn')
  f.reply(4, { ok: true, supported: true, enabled: true })
})

test('Late startup reads cannot overwrite a newer session or a newer refresh', async () => {
  const f = fixture(), { context: c, $ } = f
  const old = c.loadLoginStartup()
  c.token = 'B'
  const current = c.loadLoginStartup()
  f.reply(1, { ok: true, supported: true, enabled: true }); await current
  f.reply(0, { ok: true, supported: true, enabled: false }); await old
  assert.equal($('btn-login-startup').textContent, 'startup.disable')
  const staleMutation = c.changeLoginStartup(false)
  c.token = 'C'
  f.reply(2, { ok: true, supported: true, enabled: false }); await staleMutation
  assert.equal(f.notices.length, 0)
  f.reply(3, { ok: true, supported: true, enabled: true })
})
