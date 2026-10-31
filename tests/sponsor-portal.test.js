'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { setImmediate: next } = require('node:timers/promises')
const source = fs.readFileSync(path.join(__dirname, '../relay/sponsor/portal.js'), 'utf8')
const credential = { id: 'R1122334455667788', token: 'a'.repeat(43), reservedUntil: Date.now() + 60000 }
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.children = []; this.events = {}; this.disabled = false; this.hidden = false }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  addEventListener(name, fn) { this.events[name] = fn }
  removeAttribute(name) { delete this[name] }
  querySelector() { return this.children[0] || new Element() }
  scrollIntoView() {}
}
function harness(admin, fetch, saved) {
  const elements = new Map(), storage = new Map(saved ? [['dsh-relay-sponsor-application-v1', JSON.stringify(saved)]] : [])
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
  get('filter').value = 'all'
  const window = { addEventListener() {} }
  vm.runInNewContext(source, { document: { getElementById: get, createElement: () => new Element(), body: { hasAttribute: () => admin } },
    window, fetch, navigator: { clipboard: { writeText: async () => {} } }, URL, AbortController, setTimeout, clearTimeout,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, location: { reload() {} } })
  const fire = (id, event = 'click') => get(id).events[event]({ preventDefault() {}, submitter: new Element() })
  return { get, fire, storage }
}
const response = (body, status = 200) => ({ ok: status < 400, json: async () => body })
const settle = async () => { await next(); await next() }

test('logging out during an admin read discards late private data and errors; failed login remains visible', async () => {
  const pending = []
  const h = harness(true, () => new Promise((resolve, reject) => pending.push({ resolve, reject })))
  h.get('admin-token').value = 'isolated-admin-test-secret'
  h.fire('admin-form', 'submit')
  assert.equal(h.get('admin-token').value, '')
  h.fire('logout')
  pending[0].resolve(response({ applications: [{ id: credential.id, email: 'private@example.test', amountCents: 100, status: 'approved' }], capacity: { remaining: 1, maxUsers: 79 } }))
  pending[1].reject(Error('late private failure'))
  await settle()
  assert.equal(h.get('applications').children.length, 0)
  assert.equal(h.get('message').textContent, '')
  assert.equal(h.get('admin-controls').hidden, true)
  h.get('admin-token').value = 'invalid'
  h.fire('admin-form', 'submit')
  pending[2].resolve(response({ error: 'UNAUTHORIZED' }, 401)); pending[3].resolve(response({ error: 'UNAUTHORIZED' }, 401))
  await settle()
  assert.equal(h.get('message').textContent, '审核密钥无效。')
})

test('query recovery never puts credentials in URLs and a wrong credential preserves the current application', async () => {
  const calls = []
  const h = harness(false, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ accepting: false, remaining: 0 })
    if (options.headers.authorization !== 'Bearer ' + credential.token) return response({ error: 'APPLICATION_UNAUTHORIZED' }, 403)
    return response({ ...credential, status: 'submitted' })
  }, credential)
  await settle()
  assert.equal(h.get('begin').disabled, true)
  h.get('restore-code').value = credential.id + '.' + 'b'.repeat(43)
  h.fire('restore-form', 'submit'); await settle()
  assert.equal(h.get('restore-code').value, '')
  assert.equal(JSON.parse(h.storage.get('dsh-relay-sponsor-application-v1')).token, credential.token)
  assert.match(h.get('message').textContent, /查询凭证无效/)
  h.get('restore-code').value = credential.id + '.' + credential.token
  h.fire('restore-form', 'submit'); await settle()
  assert.match(h.get('status').textContent, /已提交/)
  assert.equal(h.get('recovery-code').value, credential.id + '.' + credential.token)
  assert.ok(calls.every(call => !call.url.includes(credential.token) && !call.url.includes('b'.repeat(43))))
  const count = calls.length
  h.get('restore-code').value = 'malformed'
  h.fire('restore-form', 'submit'); await settle()
  assert.equal(calls.length, count)
})
