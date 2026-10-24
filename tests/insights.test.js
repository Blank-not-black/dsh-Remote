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

test('host token panels support API-only, Plan-only and mixed billing without treating Plan equivalents as paid costs', async () => {
  const { summarizeCost } = await adapter
  for (const [cost, apiCost, planEquivalent] of [[2, 2, 0], [3, 0, 3], [4, 1, 3]]) {
    const raw = clone(state)
    raw.today = { date: '2026-10-19', cost, apiCost, input: 100, cacheRead: 200, cacheWrite: 300, output: 400, reasoning: 400 }
    raw.planStats = { providers: { go: { windows: { fiveHour: { localTokens: 12345 } } } } }
    raw.history = Array.from({ length: 10 }, (_, i) => ({ ...raw.today, date: '2026-10-' + String(19-i).padStart(2, '0') }))
    const data = summarizeCost(raw, null, '')
    assert.equal(data.today.totalTokens, 1000, 'reasoning is already part of output and must not be added again')
    assert.equal(data.today.apiCost, apiCost); assert.equal(data.today.planEquivalent, planEquivalent)
    assert.equal(data.plans[0].windows[0].localTokens, 12345)
    assert.equal(data.history.length, 7); assert.equal(data.history[0].date, '2026-10-13'); assert.equal(data.history.at(-1).date, '2026-10-19')
    const html = ui.costHtml(data, '', true, true)
    assert.match(html, /今日 Token.*全部渠道/); assert.match(html, /今日 API 费用/); assert.match(html, /Plan 等值.*非实付/); assert.match(html, /12,345/); assert.match(html, /近 7 日账本/)
    assert.doesNotMatch(html, /高峰占比|¥/)
  }
  const raw = clone(state); delete raw.today.apiCost
  assert.equal(summarizeCost(raw, null, '').today.apiCost, null)
})

test('quota data is directly available in the plugin drawer; management no longer polls costs', async () => {
  const admin = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8'), panel = fs.readFileSync(path.join(__dirname, '../public/plugin.js'), 'utf8')
  assert.doesNotMatch(admin, /loadStats|insights\/cost|API \+ '\/cost'/)
  assert.match(panel, /loadUsage\(\)/)
  assert.doesNotMatch(panel, /stats\/summary/); assert.doesNotMatch(admin, /stats\/summary/)
  assert.doesNotMatch(panel, /if \(!gateway\) \{[\s\S]*?renderUsage/)
  const elements = new Map(), $ = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id) }
  const source = panel.slice(panel.indexOf('function renderUsage('), panel.indexOf('async function loadUsage('))
  const context = vm.createContext({ $, window: { DshInsights: ui } })
  vm.runInContext(source, context)
  context.renderUsage(null, 'error'); assert.match($('plugin-cost-data').innerHTML, /读取失败/); assert.doesNotMatch($('plugin-cost-data').innerHTML, /0\.00/)
})

test('compact plugin quotas preserve provider status and omit conversation costs and history',async()=>{
  const {summarizeCost}=await adapter
  const html=ui.costHtml(summarizeCost(state,null,''),'',true,false,true)
  assert.match(html,/账户余额|套餐额度/);assert.match(html,/38\.5%/)
  assert.doesNotMatch(html,/当前会话 API 费用|今日 API 费用|今日 Token|近 7 日账本/)
  const raw=clone(state);raw.balance.status='error';raw.codingPlans.anthropic.status='error'
  assert.doesNotMatch(ui.costHtml(summarizeCost(raw,null,''),'',true,false,true),/CNY 123/)
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
test('custom balances and gateway quotas preserve identities, units, partial errors and host visibility without forwarding configuration', async () => {
  const { summarizeCost } = await adapter, raw = clone(state)
  raw.config.customBalances = [{ enabled: true, display: 'both' }, { enabled: true, display: 'off' }, { enabled: false }]
  raw.customBalances = [
    { index: 0, label: '渠道 <A>', unit: 'EUR', status: 'ok', remaining: -2.5, fetchedAt: 123, request: { token: 'SECRET' } },
    { index: 1, label: 'hidden', status: 'ok', remaining: 999 }, { index: 2, label: 'disabled', remaining: 999 },
    { index: 99, label: 'unrecognized', remaining: 999 },
  ]
  raw.config.gatewayQuotas = { sources: [{ id: 'visible', enabled: true, display: 'both', url: 'https://SECRET.invalid' }, { id: 'hidden', enabled: true, display: 'off' }] }
  raw.gatewayQuotas = [{ id: 'visible', label: '代理网关', status: 'partial', fetchedAt: 456, message: 'SECRET URL', accounts: [
    { label: 'a***', provider: 'codex', status: 'ok', authIndex: 'SECRET', windows: [{ label: '5h', percent: 37, resetsAt: 'tomorrow', token: 'SECRET' }] },
    { label: 'b***', provider: 'codex', status: 'error', message: 'SECRET', windows: [{ percent: 0 }] },
  ] }, { id: 'hidden', accounts: [] }]
  const data = summarizeCost(raw, null, '')
  assert.equal(data.customBalances.length, 1); assert.equal(data.customBalances[0].remaining, -2.5); assert.equal(data.customBalances[0].currency, 'EUR')
  assert.equal(data.gatewayQuotas.length, 1); assert.equal(data.gatewayQuotas[0].status, 'partial')
  assert.equal(data.gatewayQuotas[0].accounts[0].windows[0].percent, 37)
  assert.doesNotMatch(JSON.stringify(data), /SECRET|authIndex|request|headers|config/)
  const html = ui.costHtml(data, '', true, false, true)
  assert.match(html, /自定义渠道余额/); assert.match(html, /EUR -2.50/); assert.match(html, /37.0%/); assert.match(html, /部分账户查询失败/)
  assert.doesNotMatch(html, /<A>|hidden|disabled|unrecognized|0.0%/)
  raw.customBalances[0].remaining = undefined
  assert.equal(summarizeCost(raw, null, '').customBalances[0].remaining, null)
  delete raw.config.customBalances; delete raw.customBalances
  raw.config.customBalance = { enabled: true, display: 'both' }; raw.customBalance = { status: 'error', remaining: 100, unit: 'CREDITS' }
  assert.doesNotMatch(ui.costHtml(summarizeCost(raw, null, ''), ''), /CREDITS 100/)
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
    constructor() { this.attrs = {}; this.events = {}; this.open = false; this.children = new Map(); this.tabs = ['context', 'cost'].map(tab => ({ dataset: { insTab: tab }, events:{}, setAttribute() {}, addEventListener(name,fn) {this.events[name]=fn}, focus() {} })) }
    append() {}
    prepend() {}
    remove() {}
    focus() {}
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
  const c = vm.createContext({ window: {}, document: { body: { append() {} }, createElement(tag) { const el = new Element(); if (tag === 'dialog' || tag === 'section') dialog = el; return el } },
    Intl, Date, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      pending.push({ url, init, resolve })
    }) })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/insights.js'), 'utf8'), c)
  const open = (tab = 'context', extra = {}) => { const generation = identity; c.window.DshInsights.open({ tab, ...extra,
    connection: { token: 'test-only', valid: () => generation === identity }, url: route => 'http://host' + route, getSession: () => session }) }
  const respond = (index, data) => pending[index].resolve({ ok: true, text: async () => JSON.stringify(data) })
  const mount=(hostOverview=false)=>{const generation=identity;c.window.DshInsights.mount({tab:hostOverview?'cost':'context',hostOverview,connection:{token:'test-only',valid:()=>generation===identity},url:r=>'http://host'+r,getSession:()=>session},{replaceChildren(){}})}
  return { open, mount, respond, pending, api: c.window.DshInsights, dialog: () => dialog, switchIdentity() { identity++ }, switchSession() { session = { sessionId: 'B', projections: { values: {} } } },clearSession(){session=null} }
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

test('host cost overview works without a selected session and excludes session-specific missing data',async()=>{
 const {summarizeCost}=await adapter,h=harness();h.clearSession();h.mount(true)
 assert.equal(h.pending[0].url,'http://host/remote/api/insights/cost')
 h.respond(0,{ok:true,...summarizeCost(state,null,'')});await tick()
 const html=h.dialog().querySelector('.ins-content').innerHTML;assert.match(html,/今日 API 费用|账户余额/);assert.doesNotMatch(html,/尚无此会话记录|当前会话 API 费用/)
 h.api.close()
})

test('full context analysis renders all supplied changes and filters by change type',()=>{
 const events=Array.from({length:24},(_,i)=>({kind:i%2?'prune':'inject',time:i+1,name:'change-'+i})),inline={...head,events};delete inline.detailRev
 const session={projections:{values:{contextTimeline:inline}}}
 assert.doesNotMatch(ui.contextHtml(session,null,''),/change-0</)
 const full=ui.contextHtml(session,null,'',{full:true});assert.match(full,/change-0</);assert.equal((full.match(/<li>/g)||[]).length,24)
 const filtered=ui.contextHtml(session,null,'',{full:true,kind:'prune'});assert.equal((filtered.match(/<li>/g)||[]).length,12);assert.doesNotMatch(filtered,/change-0</)
})

test('a single available capability hides other tabs and keyboard navigation cannot fetch them',async()=>{
 for(const tab of ['context','cost']){
  const h=harness();h.open('context',{allowedTabs:[tab]});const tabs=h.dialog().tabs
  assert.equal(tabs.find(b=>b.dataset.insTab!==tab).hidden,true)
  assert.equal(tabs.find(b=>b.dataset.insTab===tab).hidden,false)
  tabs.find(b=>b.dataset.insTab!==tab).events.click()
  tabs.find(b=>b.dataset.insTab===tab).events.keydown({key:'ArrowRight',preventDefault(){}})
  assert.ok(h.pending.every(p=>tab==='cost'?p.url.includes('/insights/cost'):!p.url.includes('/insights/cost')))
  h.api.close()
 }
})
test('full context stays in a dialog and closing it restores its owner exactly once',async()=>{
 const h=harness();let returns=0;h.open('context',{allowedTabs:['context'],fullPage:true,onClose:()=>returns++})
 assert.equal(h.dialog().className,'ins-dialog ins-full-page');assert.equal(h.dialog().open,true)
 assert.ok(h.dialog().tabs.every(b=>b.hidden))
 h.dialog().querySelector('[data-ins-close]').events.click();await tick();assert.equal(returns,1);h.api.close();assert.equal(returns,1)
})
