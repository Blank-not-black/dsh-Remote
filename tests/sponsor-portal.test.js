'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { setImmediate: next } = require('node:timers/promises')
const source = fs.readFileSync(path.join(__dirname, '../relay/sponsor/portal.js'), 'utf8')
const credential = { id: 'R1122334455667788', token: 'a'.repeat(43), reservedUntil: Date.now() + 60000 }
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.children = []; this.events = {}; this.disabled = false; this.hidden = false }
  append(...nodes) { for (const node of nodes) node.parentElement = this; this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  addEventListener(name, fn) { this.events[name] = fn }
  removeAttribute(name) { delete this[name] }
  setAttribute(name, value) { this[name] = value }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector === '[hidden]' && node.hidden) return node; return null }
  querySelector() { return this.children[0] || new Element() }
  scrollIntoView() { this.scrolled = true }
}
function harness(admin, fetch, saved) {
  const elements = new Map(), storage = new Map(saved ? [['dsh-relay-sponsor-application-v1', JSON.stringify(saved)]] : [])
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
  get('filter').value = 'all'
  for (const name of ['review', 'revoke', 'delivery']) get(name + '-message').parentElement = get(name === 'revoke' ? 'revoke-panel' : name)
  const window = { addEventListener() {} }
  vm.runInNewContext(source, { document: { getElementById: get, createElement: () => new Element(), body: { hasAttribute: () => admin } },
    window, fetch, navigator: { clipboard: { writeText: async () => {} } }, URL, AbortController, setTimeout, clearTimeout,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, location: { reload() {} } })
  const fire = (id, event = 'click') => get(id).events[event]({ preventDefault() {}, submitter: new Element() })
  return { get, fire, storage }
}
const response = (body, status = 200) => ({ ok: status < 400, json: async () => body, blob: async () => new Blob(['isolated-test-proof']) })
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

async function reviewFixture(t, options = {}) {
  const calls = [], row = { id: credential.id, email: 'review@example.test', amountCents: 32500, status: 'submitted' }
  const h = harness(true, async (url, request) => {
    calls.push({ url, request })
    if (url.endsWith('/admin/config')) return response({ accepting: true })
    if (url.endsWith('/admin/applications')) {
      if (row.status === 'approved' && options.refreshError) throw Error('isolated list failure')
      return response({ applications: [{ ...row }], capacity: { remaining: 72, maxUsers: 79 } })
    }
    if (url.endsWith('/proof')) return response({})
    if (url.endsWith('/approve')) {
      const result = options.approve ? await options.approve() : response({ status: 'approved' })
      if (result.ok) row.status = 'approved'
      return result
    }
    if (url.endsWith('/delivery')) {
      if (options.deliveryError) throw Error('isolated delivery failure')
      return response({ email: row.email, subject: 'isolated subject', text: 'isolated activation text' })
    }
    throw Error('Unexpected isolated route')
  })
  t.after(() => h.fire('logout'))
  h.get('admin-token').value = 'isolated-admin-test-secret'
  h.fire('admin-form', 'submit'); await settle()
  h.get('applications').children[0].children[2].events.click(); await settle()
  h.get('receipt').value = 'isolated-receipt-001'; h.get('verified').checked = true
  return { ...h, calls, row }
}

test('invalid receipt and missing payment confirmation show feedback beside review without posting approval', async t => {
  const h = await reviewFixture(t)
  h.get('receipt').value = '325'
  h.fire('review-form', 'submit'); await settle()
  assert.match(h.get('review-message').textContent, /8–120/)
  assert.equal(h.get('review-message').scrolled, true)
  h.get('receipt').value = 'isolated-receipt-001'; h.get('verified').checked = false
  h.fire('review-form', 'submit'); await settle()
  assert.match(h.get('review-message').textContent, /勾选核验/)
  assert.equal(h.calls.some(call => call.url.endsWith('/approve')), false)
  assert.equal(h.get('review').hidden, false)
  h.fire('receipt', 'invalid')
  assert.match(h.get('review-message').textContent, /交易编号/)
})

test('server refusal stays visible in review and retains the entered receipt for correction', async t => {
  const h = await reviewFixture(t, { approve: async () => response({ error: 'VERIFIED_RECEIPT_REQUIRED' }, 400) })
  h.fire('review-form', 'submit'); await settle()
  assert.match(h.get('review-message').textContent, /核实到账/)
  assert.equal(h.get('review-message').scrolled, true)
  assert.equal(h.get('receipt').value, 'isolated-receipt-001')
  assert.equal(h.get('approve').disabled, false)
  assert.equal(h.get('review').hidden, false)
  assert.equal(h.calls.some(call => call.url.endsWith('/delivery')), false)
})

test('approval prevents repeat requests while busy and shows the generated delivery with success feedback', async t => {
  let finish
  const h = await reviewFixture(t, { approve: () => new Promise(resolve => { finish = resolve }) })
  h.fire('review-form', 'submit'); await settle()
  assert.equal(h.get('approve').disabled, true)
  assert.equal(h.get('approve')['aria-busy'], 'true')
  h.fire('review-form', 'submit'); await settle()
  assert.equal(h.calls.filter(call => call.url.endsWith('/approve')).length, 1)
  finish(response({ status: 'approved' })); await settle()
  assert.equal(h.get('review').hidden, true)
  assert.equal(h.get('delivery').hidden, false)
  assert.equal(h.get('delivery-text').value, 'isolated activation text')
  assert.match(h.get('delivery-message').textContent, /审核通过/)
  assert.equal(h.get('delivery-message').scrolled, true)
  assert.equal(h.get('approve').disabled, false)
  assert.equal(h.get('approve')['aria-busy'], undefined)
  assert.match(h.get('admin-capacity').textContent, /预留30分钟/)
})

for (const failure of ['refreshError', 'deliveryError']) {
  test('completed approval with ' + failure + ' directs the operator to recover delivery without approving twice', async t => {
    const h = await reviewFixture(t, { [failure]: true })
    h.fire('review-form', 'submit'); await settle()
    assert.equal(h.row.status, 'approved')
    assert.equal(h.get('review').hidden, true)
    assert.match(h.get('message').textContent, /审核已通过.*无需再次审批/)
    assert.equal(h.get('message').scrolled, true)
    assert.equal(h.calls.filter(call => call.url.endsWith('/approve')).length, 1)
  })
}
