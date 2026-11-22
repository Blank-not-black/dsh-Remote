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
  focus() { this.focused = true }
  reportValidity() { return true }
  click() { this.clicked = true }
  remove() { this.removed = true }
}
function harness(admin, fetch, saved, clientDate = Date, hash = '', persistent = null) {
  const elements = new Map(), storage = new Map(saved ? [['dsh-relay-sponsor-application-v1', JSON.stringify(saved)]] : [])
  const timers = new Map(), revoked = [], downloads = [], blobs = []
  let elapsed = 0, sequence = 0
  const defer = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id }
  const tick = delay => {
    elapsed += delay
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue
      timers.delete(id); timer.fn()
    }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id) }
  get('filter').value = 'all'
  for (const name of ['review', 'revoke', 'delivery']) get(name + '-message').parentElement = get(name === 'revoke' ? 'revoke-panel' : name)
  const window = { addEventListener() {} }
  const storageFor = area => ({ getItem: key => area.get(key), setItem: (key, value) => area.set(key, value), removeItem: key => area.delete(key) })
  vm.runInNewContext(source, { document: { getElementById: get, createElement: () => new Element(), body: { hasAttribute: () => admin, append: node => downloads.push(node) } },
    window, fetch, crypto: globalThis.crypto, navigator: { clipboard: { writeText: async () => {} } },
    Blob, URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:isolated-test-image' }, revokeObjectURL: url => revoked.push(url) },
    FileReader: class { readAsDataURL(file) { this.result = file.data; this.onload() } },
    AbortController, Date: clientDate, performance: { now: () => elapsed }, setTimeout: defer, clearTimeout: id => timers.delete(id),
    sessionStorage: storageFor(storage), localStorage: storageFor(persistent || new Map()), location: { reload() {}, hash, pathname: '/sponsor/', search: persistent ? '?app=1' : '' }, history: { replaceState() {} } })
  const fire = (id, event = 'click') => get(id).events[event]({ preventDefault() {}, submitter: new Element() })
  return { get, fire, storage, tick, revoked, downloads, blobs }
}
const response = (body, status = 200) => ({ ok: status < 400, json: async () => body, blob: async () => new Blob(['isolated-test-proof']) })
const settle = async () => { await next(); await next() }

test('approved applicants can download a short-lived activation file and still claim the manual key', async () => {
  const file = { type: 'dsh-remote-relay-activation', version: 1, code: 'dsra_' + 'a'.repeat(16) + '.' + 'b'.repeat(43), expiresAt: Date.now() + 60000 }
  const h = harness(false, async (url, options) => {
    if (url.endsWith('/config')) return response({ open: true, activationFiles: true })
    if (url.endsWith('/activation')) {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers.authorization, 'Bearer ' + credential.token)
      return response(file, 201)
    }
    return response({ ...credential, status: 'approved', serverTime: Date.now(), expiresAt: Date.now() + 60000 })
  }, credential)
  await settle()
  assert.equal(h.get('download-activation').hidden, false)
  assert.equal(h.get('claim').hidden, false)
  h.fire('download-activation')
  await settle()
  assert.equal(h.downloads.at(-1).download, 'dsh-remote-relay-activation.json')
  assert.equal(h.downloads.at(-1).clicked, true)
  assert.deepEqual(JSON.parse(await h.blobs.at(-1).text()), file)
  assert.equal(JSON.stringify([...h.storage]).includes(file.code), false)
})

test('management-only portal keeps recovery available and never offers a new application', async () => {
  const h = harness(false, async url => {
    assert.match(url, /\/config$/)
    return response({open:true,remaining:2})
  }, null, Date, '#manage')
  await settle()
  assert.equal(h.get('first-application').hidden, true)
  assert.equal(h.get('begin').disabled, true)
  assert.equal(h.get('existing-application').hidden, false)
  h.fire('lookup')
  assert.equal(h.get('restore-code').focused, true)
})

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

test('admin shows observed failure source and clears diagnostics on logout', async () => {
  const h = harness(true, async url => response(url.endsWith('/admin/config') ? {} : {
    applications: [{ id: credential.id, status: 'submitted' }], capacity: { remaining: 1, maxUsers: 85 },
    alerts: [{ at: 1, count: 12, event: 'SPONSOR_RELAY_FAILURE_SURGE', source: 'host', code: 'UPSTREAM_HTTP_503' }],
    diagnostics: { since: 1, failures: [{ code: 'HOST_WORK_TIMEOUT', total: 3, source: 'unknown', lastAt: 2 }] }
  }))
  h.get('admin-token').value = 'isolated-admin-test-secret'
  h.fire('admin-form', 'submit'); await settle()
  const alert = h.get('alerts-list').children[0].textContent
  assert.match(alert, /主机端.*503/)
  assert.ok(!alert.includes(credential.id))
  assert.match(h.get('diagnostics-list').children[0].textContent, /未定位.*等待主机通道超时.*3 次/)
  h.fire('logout')
  assert.equal(h.get('diagnostics-summary').textContent, '')
  assert.equal(h.get('diagnostics-list').children.length, 0)
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
  const calls = [], row = { id: credential.id, email: 'review@example.test', amountCents: 32500, status: 'submitted', ...options.row }
  const h = harness(true, async (url, request) => {
    calls.push({ url, request })
    if (url.endsWith('/admin/config')) return response({ accepting: true, mailerOnline: true })
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
  h.get('applications').children[0].children.find(node => node.textContent === '查看付款并审核').events.click(); await settle()
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
  assert.match(h.get('admin-capacity').textContent, /邮件服务/)
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

test('an available application shows payment and opens its private inbox without email sending', async () => {
  const calls = []
  const h = harness(false, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ open: true, remaining: 5, mailEnabled: false })
    if (url.endsWith('/messages')) return response({ messages: [{ number: 1, sender: 'operator', at: Date.now(), text: '<b>站内回复</b>' }], unread: options.method === 'GET' ? 1 : 0 })
    return response({ ...credential, status: 'draft', emailVerified: false, serverTime: Date.now(), unreadMessages: 1 })
  }, credential)
  await settle()
  assert.equal(h.get('send-code').disabled, true)
  assert.equal(h.get('submission').hidden, false)
  assert.equal(h.get('payment').hidden, false)
  assert.equal(h.get('qr').src, 'blob:isolated-test-image')
  assert.match(h.get('open-inbox').textContent, /1 条新消息/)
  h.fire('open-inbox'); await settle()
  assert.equal(h.get('messages').children[0].children[1].textContent, '<b>站内回复</b>')
  assert.equal(calls.find(call => call.url.endsWith('/messages')).options.headers.authorization, 'Bearer ' + credential.token)
  assert.ok(calls.some(call => call.url.endsWith('/messages') && call.options.method === 'POST' && call.options.body.includes('seenThrough')))
})

test('an expired qualification can recover a distinct renewal credential when no new slots remain', async () => {
  const calls = [], now = Date.now(), next = { id: 'R9988776655443322', token: 'b'.repeat(43), reservedUntil: now + 60000 }
  const h = harness(false, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ open: true, remaining: 0 })
    if (url.endsWith('/renew')) return response(next, 201)
    if (url.endsWith('/' + credential.id)) return response({ id: credential.id, status: 'expired', approvedAt: now - 86400000, renewable: true, renewalDeadline: now + 60000, serverTime: now })
    return response({ id: next.id, status: 'draft', email: 'renewal@example.test', renewal: true, renewalDeadline: now + 60000, serverTime: now })
  }, credential)
  await settle()
  assert.equal(h.get('renew').hidden, false)
  assert.equal(h.get('restart').hidden, true)
  assert.match(h.get('renewal-detail').textContent, /原到期日加 30 天/)
  h.fire('renew'); await settle()
  assert.equal(calls.find(call => call.url.endsWith('/renew')).options.headers.authorization, 'Bearer ' + credential.token)
  assert.equal(calls.find(call => call.url.endsWith('/' + next.id + '/qr')).options.headers.authorization, 'Bearer ' + next.token)
  assert.deepEqual(JSON.parse(h.storage.get('dsh-relay-sponsor-application-v1')), { id: next.id, token: next.token })
  assert.match(h.get('submission-title').textContent, /提交续费申请/)
})

test('app mode restores existing credentials and reopens the current service after closing the screen', async () => {
  const calls = [], persistent = new Map(), now = Date.now()
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ open: true, remaining: 0 })
    return response({ id: credential.id, status: 'approved', expiresAt: now + 86400000, serverTime: now })
  }
  const first = harness(false, fetch, null, Date, '', persistent)
  await settle()
  assert.equal(first.get('begin').disabled, true)
  first.fire('lookup')
  assert.equal(first.get('recovery').open, true)
  assert.equal(first.get('restore-code').focused, true)
  first.get('restore-code').value = credential.id + '.' + credential.token
  first.fire('restore-form', 'submit'); await settle()
  assert.equal(first.get('existing-application').hidden, true)
  assert.equal(first.get('recovery').open, false)
  assert.equal(first.get('progress').focused, true)
  assert.equal(first.storage.size, 0)
  assert.equal(persistent.size, 1)
  const reopened = harness(false, fetch, null, Date, '', persistent)
  await settle()
  assert.equal(reopened.get('progress').hidden, false)
  assert.match(reopened.get('status').textContent, /审核通过.*有效期至/)
  assert.equal(reopened.get('renew').hidden, true)
  assert.equal(reopened.get('first-application').hidden, true)
  assert.ok(calls.every(call => call.options.method === 'GET' && !call.url.includes(credential.token)))
})

test('Android inbox keeps the original recipient after renewal and acknowledges only that visible thread', async () => {
  const calls = [], now = Date.now(), newOrder = { id: 'R9988776655443322', token: 'b'.repeat(43) }
  const persistent = new Map([['dsh-relay-sponsor-application-v1', JSON.stringify({ id: credential.id, token: credential.token })]])
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ open: true, remaining: 0 })
    if (url.endsWith('/renew')) return response(newOrder, 201)
    if (url.endsWith('/messages')) return response({ messages: [{ number: 1, sender: 'operator', at: now, text: '指定申请的运营消息' }], unread: options.method === 'GET' ? 1 : 0 })
    if (url.endsWith(credential.id)) return response({ id: credential.id, status: 'expired', serverTime: now, renewable: true, renewalDeadline: now + 60000 })
    return response({ id: newOrder.id, status: 'submitted', serverTime: now })
  }
  const first = harness(false, fetch, null, Date, '', persistent)
  await settle()
  first.fire('renew'); await settle()
  const saved = JSON.parse(persistent.get('dsh-relay-sponsor-application-v1'))
  assert.equal(saved.id, newOrder.id)
  assert.deepEqual(saved.inbox, { id: credential.id, token: credential.token })
  assert.match(first.get('inbox-binding').textContent, new RegExp(credential.id))
  assert.ok(!calls.some(call => call.url.endsWith('/messages')))

  const reopened = harness(false, fetch, null, Date, '#inbox', persistent)
  await settle()
  assert.match(reopened.get('status').textContent, new RegExp(newOrder.id))
  assert.match(reopened.get('inbox-thread').textContent, new RegExp(credential.id))
  assert.equal(reopened.get('messages').children[0].children[1].textContent, '指定申请的运营消息')
  const inboxCalls = calls.filter(call => call.url.endsWith('/messages'))
  assert.deepEqual(inboxCalls.map(call => call.options.method), ['GET', 'POST'])
  assert.ok(inboxCalls.every(call => call.url.includes(credential.id) && call.options.headers.authorization === 'Bearer ' + credential.token))
  assert.deepEqual(JSON.parse(inboxCalls[1].options.body), { seenThrough: 1 })
})

test('first application uses the existing draft flow and foregrounds the next step', async () => {
  const now = Date.now(), methods = []
  const h = harness(false, async (url, options) => {
    methods.push(options.method)
    if (url.endsWith('/config')) return response({ open: true, remaining: 1 })
    if (options.method === 'POST') return response(credential, 201)
    return response({ id: credential.id, status: 'draft', serverTime: now, reservedUntil: now + 60000 })
  }, null, Date, '', new Map())
  await settle()
  assert.equal(h.get('begin').disabled, false)
  h.fire('begin'); await settle()
  assert.equal(h.get('first-application').hidden, true)
  assert.match(h.get('submission-title').textContent, /提交开通申请/)
  assert.equal(h.get('verification').focused, true)
  assert.deepEqual(methods, ['GET', 'POST', 'GET', 'GET'])
})

test('new checkout locks the server quote, submits a proof and delivers the activation key after approval', async () => {
  const now = Date.now(), calls = []
  const order = { kind: 'open', amountCents: 1500, periods: [{ startsAt: now, expiresAt: now + 30 * 86400000, packs: 2 }] }
  const current = { id: credential.id, status: 'draft', order, serverTime: now, reservedUntil: now + 60000 }
  const h = harness(false, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ open: true, remaining: 100, maxUsers: 100, serviceOrders: true, priceCents: 500 })
    if (url.endsWith('/applications')) return response(credential, 201)
    if (url.endsWith('/claim')) return response({ code: 'isolated-activation-key' })
    if (options.method === 'POST') current.status = 'submitted'
    return response(current)
  })
  await settle()
  assert.equal(h.get('order-package').hidden, false)
  assert.equal(h.get('initial-total').textContent, '¥5')
  h.get('initial-packs').value = '2'
  h.fire('initial-packs', 'change')
  assert.match(h.get('initial-entitlements').textContent, /15 GB.*文件传输/)
  h.fire('begin'); await settle()
  assert.deepEqual(JSON.parse(calls.find(call => call.options.method === 'POST').options.body), { packs: [2] })
  assert.equal(h.get('quote-total').textContent, '¥15')
  assert.match(h.get('quote-periods').children[0].children[1].textContent, /2 包 · 15 GB · ¥15/)
  assert.equal(h.get('amount').readOnly, true)
  assert.equal(h.get('order-quote').focused, true)
  assert.equal(h.get('step-pay')['aria-current'], 'step')
  assert.equal(h.get('payment').hidden, false)

  h.get('email').value = 'test-buyer@example.test'
  h.get('amount').value = '5'
  h.get('proof').files = [{ size: 100, data: 'data:image/png;base64,dGVzdA==' }]
  h.fire('application-form', 'submit'); await settle()
  const submitted = calls.find(call => call.url.endsWith(credential.id) && call.options.method === 'POST')
  assert.equal(JSON.parse(submitted.options.body).amount, '15.00')
  assert.equal(h.get('payment').hidden, true)
  assert.equal(h.get('step-review')['aria-current'], 'step')
  assert.match(h.get('status').textContent, /等待人工审核/)
  assert.equal(h.get('claim').hidden, true)

  Object.assign(current, { status: 'approved', expiresAt: order.periods[0].expiresAt })
  h.fire('refresh'); await settle()
  h.fire('claim'); await settle()
  assert.equal(h.get('claim-panel').hidden, false)
  assert.equal(h.get('claim-code').value, 'isolated-activation-key')
  assert.ok(calls.every(call => !call.url.includes(credential.token)))
})

test('a locked checkout hides the payment code when its local deadline elapses', async () => {
  const now = Date.now()
  const order = { kind: 'open', amountCents: 500, periods: [{ startsAt: now, expiresAt: now + 86400000, packs: 0 }] }
  const h = harness(false, async url => response(url.endsWith('/config') ? { open: true, serviceOrders: true } :
    { id: credential.id, status: 'draft', serverTime: now, reservedUntil: now + 300, order }), credential)
  await settle()
  assert.equal(h.get('payment').hidden, false)
  h.tick(300)
  assert.equal(h.get('payment').hidden, true)
  assert.equal(h.get('qr').src, undefined)
  assert.match(h.get('quote-deadline').textContent, /付款窗口已结束/)
})

test('new renewal quotes selected packs per month and keeps the original application recoverable', async () => {
  const calls = [], now = Date.now(), renewed = { id: 'R9988776655443322', token: 'b'.repeat(43) }
  const order = { kind: 'renew', amountCents: 2500, periods: [{ startsAt: now, expiresAt: now + 86400000, packs: 1 },
    { startsAt: now + 86400000, expiresAt: now + 172800000, packs: 2 }] }
  const h = harness(false, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/config')) return response({ open: true, remaining: 0, serviceOrders: true })
    if (url.endsWith('/renew')) return response({ ...renewed, order }, 201)
    if (url.endsWith(credential.id)) return response({ id: credential.id, status: 'approved', renewable: true, expiresAt: now + 86400000,
      orderOptions: { renewalPeriods: 2, addPacks: 1 }, serverTime: now })
    return response({ id: renewed.id, status: 'draft', order, renewal: true, reservedUntil: now + 60000, serverTime: now })
  }, credential)
  await settle()
  assert.equal(h.get('add-packs').hidden, false)
  h.get('renewal-count').value = '2'; h.get('renewal-packs-1').value = '1'; h.get('renewal-packs-2').value = '2'
  h.fire('renewal-count', 'change')
  assert.match(h.get('renewal-total').textContent, /¥25/)
  h.fire('renew'); await settle()
  assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/renew')).options.body), { packs: [1, 2] })
  assert.equal(h.get('return-application').hidden, false)
  assert.equal(JSON.parse(h.storage.get('dsh-relay-sponsor-application-v1')).parent.id, credential.id)
  h.fire('return-application'); await settle()
  assert.equal(h.get('return-application').hidden, true)
  assert.match(h.get('status').textContent, new RegExp(credential.id))
})

test('the operator must enter the exact actual payment for an order before approving', async t => {
  const startsAt = Date.parse('2026-11-18T12:00:00+08:00')
  const h = await reviewFixture(t, { row: { order: { kind: 'open', amountCents: 1000, periods: [{ startsAt, expiresAt: startsAt + 86400000, packs: 1 }] } } })
  assert.equal(h.get('verified-amount').required, true)
  assert.equal(h.get('paid-at').required, true)
  assert.match(h.get('review-periods').children[0].children[1].textContent, /10 GB · ¥10/)
  h.get('paid-at').value = '2026-11-18T12:00:00'
  h.get('verified-amount').value = '5'
  h.fire('review-form', 'submit'); await settle()
  assert.match(h.get('review-message').textContent, /到账金额与订单金额不符/)
  assert.ok(!h.calls.some(call => call.url.endsWith('/approve')))
  h.get('verified-amount').value = '10'
  h.fire('review-form', 'submit'); await settle()
  const review = JSON.parse(h.calls.find(call => call.url.endsWith('/approve')).request.body)
  assert.equal(review.verifiedAmountCents, 1000)
  assert.equal(review.paidAt, startsAt)
})

test('operator enters verified renewal payment time in Beijing time', async t => {
  const h = await reviewFixture(t, { row: { renewalOf: 'R9988776655443322', renewalDeadline: Date.parse('2026-11-18T12:00:00+08:00') } })
  assert.equal(h.get('paid-at-label').hidden, false)
  assert.equal(h.get('paid-at').required, true)
  h.fire('review-form', 'submit'); await settle()
  assert.ok(!h.calls.some(call => call.url.endsWith('/approve')))
  h.get('paid-at').value = '2026-11-18T11:59:45'
  h.fire('review-form', 'submit'); await settle()
  assert.equal(JSON.parse(h.calls.find(call => call.url.endsWith('/approve')).request.body).paidAt, Date.parse('2026-11-18T03:59:45Z'))
})

test('opening a confirmation link only displays a prompt; the explicit button sends the token', async () => {
  const calls = [], token = 'd'.repeat(43)
  const h = harness(false, async (url, options) => {
    calls.push({ url, options })
    return response(url.endsWith('/config') ? { open: true, remaining: 5, mailEnabled: true } : { verified: true })
  }, null, Date, '#confirm=' + credential.id + '.' + token)
  await settle()
  assert.equal(h.get('confirm-email').hidden, false)
  assert.ok(!calls.some(call => call.options.method === 'POST'))
  h.fire('confirm-email-button'); await settle()
  assert.equal(JSON.parse(calls.find(call => call.options.method === 'POST').options.body).code, token)
  assert.ok(calls.every(call => !call.url.includes(token)))
  assert.match(h.get('confirm-email-status').textContent, /已确认收信/)
})
