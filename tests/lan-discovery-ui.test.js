'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
class Element {
  constructor() { this.children = []; this.listeners = {}; this.nodes = new Map(); this.value = ''; this.disabled = false; this.textContent = ''; this.removed = false; const set = new Set(); this.classList = { add: x => set.add(x), remove: x => set.delete(x), contains: x => set.has(x) } }
  setAttribute() {}
  focus() { this.focused = true }
  addEventListener(event, handler) { this.listeners[event] = handler }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector) }
  append(node) { this.children.push(node) }
  replaceChildren() { this.children = [] }
  remove() { this.removed = true }
  click() { if (!this.disabled) this.listeners.click?.() }
}
function harness(native = true) {
  const button = new Element(), body = new Element(), calls = [], applied = [], timers = new Map(), events = {}
  let state = { phase: 'searching', hosts: [] }, result = {}, seq = 0
  const bridge = { search: () => calls.push('search'), cancel: () => calls.push('cancel'), getState: () => JSON.stringify(state), takePairResult: () => JSON.stringify(result), pair: (id, code) => { calls.push({ id, code }); state.phase = 'pairing'; return true } }
  const window = { I18N: { lang: 'zh' }, ...(native ? { NativeLan: bridge } : {}) }
  const document = { body, createElement: () => new Element(), addEventListener: (name, fn) => events[name] = fn }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/lan-discovery.js'), 'utf8'), { window, document, setTimeout: fn => { const id = ++seq; timers.set(id, fn); return id }, clearTimeout: id => timers.delete(id) })
  window.DshLanDiscovery.mount(button, value => applied.push(value))
  return { button, body, calls, applied, events, document, state: value => state = value, result: value => result = value,
    tick() { const [id, fn] = [...timers.entries()].at(-1); timers.delete(id); fn() }, modal: () => body.children.at(-1) }
}
test('LAN search requires the native bridge, escapes host names, validates code and applies credentials only once', () => {
  const web = harness(false); web.button.click(); assert.equal(web.body.children.length, 0)
  const h = harness(), host = { id: 'host', server: 'http://192.168.1.2:8787', name: '<img onerror=bad()>', instanceId: 'instance' }
  h.button.click(); const modal = h.modal(); assert.deepEqual(h.calls, ['search'])
  h.state({ phase: 'done', hosts: [host] }); h.tick()
  const entry = modal.querySelector('[data-lan-list]').children[0]
  assert.equal(entry.textContent, '<img onerror=bad()> · http://192.168.1.2:8787'); assert.equal(entry.innerHTML, undefined)
  entry.click(); modal.querySelector('[data-lan-code]').value = 'short'; modal.querySelector('[data-lan-connect]').click()
  assert.equal(h.calls.length, 1)
  modal.querySelector('[data-lan-code]').value = 'ABCD-ABCD-ABCD-ABCD-ABCD'; modal.querySelector('[data-lan-connect]').click()
  assert.equal(h.calls[1].id, 'host'); assert.equal(modal.querySelector('[data-lan-code]').value, '')
  h.result({ token: 'device-token', server: host.server, name: host.name }); h.state({ phase: 'paired', hosts: [host] }); h.tick()
  assert.equal(h.applied.length, 1); assert.equal(modal.removed, true); assert.equal(h.calls.at(-1), 'cancel')
})
test('closing/visibility changes cancel discovery; stale native results cannot switch the active host', () => {
  const h = harness(); h.button.click(); const modal = h.modal()
  h.document.hidden = true; h.events.visibilitychange()
  h.result({ token: 'stale', server: 'http://192.168.1.3:8787' }); h.state({ phase: 'paired', hosts: [] })
  assert.equal(modal.removed, true); assert.equal(h.applied.length, 0); assert.equal(h.calls.at(-1), 'cancel')
})

test('an old LAN status response cannot erase a newly generated pairing code', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8')
  const nodes = new Map(), jobs = [], deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } }
  const context = vm.createContext({ I18N: { lang: 'zh' }, token: 'admin', API: '/admin/api', AbortSignal,
    lastState: { deviceKeys: { enabled: true } }, $: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id) }, adminHeaders: () => ({}), toast() {},
    fetch: () => { const job = deferred(); jobs.push(job); return job.promise } })
  vm.runInContext(source.slice(source.indexOf('let lanBusy ='), source.indexOf('const revealedDeviceKeys')), context)
  const old = context.refreshLan(), open = context.changeLan(true)
  const expiresAt = Date.now() + 600000
  jobs[1].resolve({ ok: true, json: async () => ({ ok: true, enabled: true, code: 'ABCD-ABCD-ABCD-ABCD-ABCD', expiresAt }) }); await open
  jobs[0].resolve({ ok: true, json: async () => ({ ok: true, enabled: false }) }); await old
  assert.equal(nodes.get('lan-pairing-code').hidden, false)
  assert.equal(nodes.get('lan-pairing-code').textContent, 'ABCD-ABCD-ABCD-ABCD-ABCD')
})
