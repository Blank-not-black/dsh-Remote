'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { head, detail, state, sessionCost } = require('./fixtures/insights-data.cjs')
const ui = require('../public/insights.js')
const adapter = import('../packages/plugin/insights.mjs')
const clone = value => structuredClone(value)
test('cost adapter returns only bounded display fields, with API and plan equivalents separate', async () => {
  const { summarizeCost } = await adapter
  const data = summarizeCost(state, sessionCost, 'insights-session')
  assert.equal(data.today.apiCost, .72); assert.equal(data.session.own.apiCost, .18)
  assert.equal(data.session.own.cost, .52); assert.equal(data.currency, 'USD')
  assert.equal(data.balance.currency, 'CNY'); assert.equal(data.plans[0].windows[0].percent, 38.5)
  assert.doesNotMatch(JSON.stringify(data), /SECRET|apiKey|private\.invalid|authorization|config|headers/)
})
test('invalid amounts and quotas are unknown rather than fabricated zero or clamped usage', async () => {
  const { summarizeCost } = await adapter, raw = clone(state)
  raw.today.cost = NaN; raw.today.apiCost = '12'; raw.balance.totalBalance = Infinity
  raw.codingPlans.anthropic.windows.weekly.percent = 200
  const data = summarizeCost(raw, { found: false }, 'session')
  assert.equal(data.today.cost, null); assert.equal(data.today.apiCost, null)
  assert.equal(data.balance.total, null); assert.equal(data.session.own, null)
  assert.equal(data.plans[1].windows[0].percent, null)
})
test('host display switches remain respected', async () => {
  const { summarizeCost } = await adapter, raw = clone(state)
  raw.config.hideOfficialBalance = true; raw.config.hideTodayCost = true
  raw.config.goQuota.display = 'off'; raw.codingPlans.anthropic.display = 'off'
  const data = summarizeCost(raw, sessionCost, 'session')
  assert.equal(data.today, null); assert.equal(data.balance, null); assert.deepEqual(data.plans, [])
})
test('service reads coalesce and never call a configuration mutation', async () => {
  const { readCostInsights } = await adapter
  let reads = 0
  const service = { async getState() { reads++; await new Promise(r => setImmediate(r)); return state }, async getSessionCost(id) { assert.equal(id, 'session'); return sessionCost }, updateConfig() { assert.fail('write called') } }
  const ctx = { get: key => key === 'costMeter' ? service : undefined }
  const results = await Promise.all([readCostInsights(ctx, 'session'), readCostInsights(ctx, 'session')])
  assert.equal(reads, 1); assert.ok(results.every(r => r.body.available))
  await readCostInsights(ctx, 'session'); assert.equal(reads, 1)
})
test('absent and incompatible services are distinguishable; plugin errors cannot leak secrets', async () => {
  const { readCostInsights } = await adapter
  assert.equal((await readCostInsights({ get() {} })).body.code, 'not-installed')
  assert.equal((await readCostInsights({ get: () => ({}) })).body.code, 'unsupported')
  const failed = await readCostInsights({ get: () => ({ getState() { throw new Error('SECRET https://private.invalid') } }) })
  assert.equal(failed.status, 502); assert.doesNotMatch(JSON.stringify(failed), /SECRET|private/)
  assert.equal((await readCostInsights({}, 'bad\nvalue')).status, 400)
})
test('context renders real categories, official occupancy, and both projection generations', () => {
  const session = { projections: { values: { contextTimeline: head, contextPressure: { pressureTokens: 38000, contextWindow: 128000 } } } }
  const html = ui.contextHtml(session, detail, '')
  assert.match(html, /38,000/); assert.match(html, /5,800/); assert.match(html, /项目约定/)
  assert.doesNotMatch(ui.contextHtml(session, { ...detail, rev: 6 }, ''), /项目约定/)
  const inline = { ...head, events: detail.events }; delete inline.detailRev
  assert.match(ui.contextHtml({ projections: { values: { contextTimeline: inline } } }, null, ''), /项目约定/)
  assert.match(ui.contextHtml({ projections: { values: {} } }, detail, ''), /31,300/)
})
test('malformed plugin schemas and HTML payloads do not become markup or zero balances', async () => {
  const { summarizeCost } = await adapter
  assert.equal(ui.contextOf({ current: { total: '100' } }), null)
  assert.equal(ui.costOf({ schema: 2, available: true }), null)
  const hostile = { ...head, model: '<img src=x onerror=alert(1)>', events: [] }; delete hostile.detailRev
  assert.doesNotMatch(ui.contextHtml({ projections: { values: { contextTimeline: hostile } } }, null, ''), /<img/)
  const raw = clone(state); raw.balance.status = 'error'; raw.balance.totalBalance = 123
  const html = ui.costHtml(summarizeCost(raw, { found: false }, 'session'), '')
  assert.doesNotMatch(html, /CNY 123/); assert.match(html, /尚无此会话记录/)
})

function harness() {
  class Element {
    constructor() { this.attrs = {}; this.events = {}; this.open = false; this.children = new Map(); this.tabs = ['context', 'cost'].map(tab => ({ dataset: { insTab: tab }, setAttribute() {}, addEventListener() {}, focus() {} })) }
    set innerHTML(value) { this.html = value }
    get innerHTML() { return this.html || '' }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector) }
    querySelectorAll() { return this.tabs }
    setAttribute(key, value) { this.attrs[key] = value }
    addEventListener(key, callback) { this.events[key] = callback }
    showModal() { this.open = true }
    close() { this.open = false; queueMicrotask(() => this.events.close?.()) }
  }
  let dialog, pending = [], identity = 1, session = { sessionId: 'A', projections: { values: { contextTimeline: head } } }
  const c = vm.createContext({ window: {}, document: { body: { append() {} }, createElement() { dialog = new Element(); return dialog } },
    Intl, Date, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      pending.push({ url, init, resolve })
    }) })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/insights.js'), 'utf8'), c)
  const open = (tab = 'context') => { const generation = identity; c.window.DshInsights.open({ tab,
    connection: { token: 'test-only', valid: () => generation === identity }, url: route => 'http://host' + route, getSession: () => session }) }
  const respond = (index, data) => pending[index].resolve({ ok: true, text: async () => JSON.stringify(data) })
  return { open, respond, pending, api: c.window.DshInsights, dialog: () => dialog, switchIdentity() { identity++ }, switchSession() { session = { sessionId: 'B', projections: { values: {} } } } }
}
const tick = () => new Promise(r => setImmediate(r))
test('late responses after host or session change never populate the panel', async () => {
  for (const switcher of ['switchIdentity', 'switchSession']) {
    const h = harness(); h.open(); assert.equal(h.pending.length, 1)
    h[switcher](); h.respond(0, { ok: true, value: detail }); await tick()
    assert.doesNotMatch(h.dialog().querySelector('.ins-content').innerHTML, /项目约定/)
    h.api.close()
  }
})
test('a queued close event cannot cancel a newly opened panel or accept the older result', async () => {
  const h = harness(); h.open(); h.open(); await tick()
  assert.equal(h.dialog().open, true); assert.equal(h.pending.length, 2)
  h.respond(0, { ok: true, value: { ...detail, events: [{ kind: 'inject', name: 'OLD-HOST', time: 1 }] } })
  h.respond(1, { ok: true, value: detail }); await tick()
  const html = h.dialog().querySelector('.ins-content').innerHTML
  assert.match(html, /项目约定/); assert.doesNotMatch(html, /OLD-HOST/); h.api.close()
})
test('closing cancels a pending cost fetch; a late body cannot update a reopened panel', async () => {
  const { summarizeCost } = await adapter, h = harness(); h.open('cost'); h.api.close()
  assert.equal(h.pending[0].init.signal.aborted, true)
  h.open(); h.respond(0, { ok: true, ...summarizeCost(state, sessionCost, 'A') }); await tick()
  assert.doesNotMatch(h.dialog().querySelector('.ins-content').innerHTML, /账户余额/)
  h.api.close()
})
