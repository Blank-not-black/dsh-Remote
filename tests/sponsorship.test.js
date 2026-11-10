'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { Registry } = require('../relay/registry.cjs')
const { Sponsorship, createSponsorPortal, nextMonth, amountCents } = require('../relay/sponsorship.cjs')
const { MonthlyQuota } = require('../relay/quota.cjs')
const { basicPolicy } = require('../relay/basic-policy.cjs')
const ADMIN = 'isolated-sponsorship-admin-test-secret-123456'
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)])
const proof = 'data:image/png;base64,' + PNG.toString('base64')
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
const at = time => Date.parse('2026-11-09T' + time + ':00+08:00')
const input = (amount = '1') => ({ amount, screenshot: proof })
function fixture(t, { start, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sponsor-')), file = path.join(root, 'registry.json')
  Registry.init(file, { origin: 'https://relay.example.test', baseDomain: 'users.example.test' })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let now = start ?? Date.now()
  const store = new Sponsorship({ file, adminToken: ADMIN, now: () => now, mailEnabled: true, ...options })
  const registry = new Registry(file)
  return { root, file, store, registry, now: () => now, advance: ms => { now += ms }, setNow: ms => { now = ms } }
}
function verifyEmail(store, draft, email = 'person@example.test') {
  const { code, expiresAt } = store.requestVerification(draft.id, draft.token, { email }, '127.0.0.1')
  store.verificationSent(draft.id, expiresAt)
  store.verify(draft.id, code)
}
function submitted(f, email, amount) {
  const draft = f.store.draft()
  verifyEmail(f.store, draft, email)
  f.store.submit(draft.id, draft.token, input(amount))
  return draft
}
const approval = receipt => ({ verified: true, receipt })

test('sponsor minimum is one yuan, any higher amount grants one clamped calendar month', t => {
  assert.equal(amountCents('1'), 100); assert.equal(amountCents('1.01'), 101)
  for (const value of ['0.99', '-1', '1e3', '1.001', 'Infinity']) assert.throws(() => amountCents(value))
  assert.equal(new Date(nextMonth(Date.parse('2026-01-31T12:34:56Z'))).toISOString(), '2026-02-28T12:34:56.000Z')
  assert.equal(new Date(nextMonth(Date.parse('2026-01-30T17:00:00Z'))).toISOString(), '2026-02-27T17:00:00.000Z')
  const f = fixture(t), draft = submitted(f, undefined, '20')
  const result = f.store.approve(draft.id, approval('wx-receipt-001'))
  assert.equal(result.expiresAt, nextMonth(f.now()))
  assert.equal(f.registry.get(result.grantId).plan, 'sponsor-basic')
  assert.match(f.store.claim(draft.id, draft.token).code, /^dsrp_/)
  assert.equal(f.store.list()[0].amountCents, 2000)
})

test('sponsor reserves fewer than 80 slots before payment, expires unpaid drafts and retains submitted slots', t => {
  assert.throws(() => fixture(t, { maxUsers: 80 }), /INVALID_SPONSOR_CAPACITY/)
  const f = fixture(t, { maxUsers: 2 }), a = submitted(f), b = f.store.draft()
  assert.equal(f.store.capacity().remaining, 0)
  assert.throws(() => f.store.draft(), /PILOT_FULL/)
  assert.throws(() => f.registry.issue({ expiresAt: Date.now() + 60000 }), /PILOT_FULL/)
  f.advance(91 * MINUTE)
  assert.equal(f.store.status(b.id, b.token).status, 'expired')
  assert.equal(f.store.capacity().remaining, 1)
  f.advance(86400000)
  assert.equal(f.store.status(a.id, a.token).status, 'submitted')
  f.store.reject(a.id, '未查到到账，请通过邮箱联系核对或退款。')
  assert.equal(f.store.capacity().remaining, 2)
})

test('sponsor requires application secret, validates screenshots and stores proofs outside public assets', t => {
  const f = fixture(t), draft = f.store.draft()
  assert.throws(() => f.store.submit(draft.id, 'wrong', input()), /APPLICATION_UNAUTHORIZED/)
  assert.throws(() => f.store.status(draft.id, 'wrong'), /APPLICATION_UNAUTHORIZED/)
  assert.throws(() => f.store.requestVerification(draft.id, draft.token, { email: 'bad\r\n@example.test' }, '127.0.0.1'), /INVALID_EMAIL/)
  verifyEmail(f.store, draft)
  assert.throws(() => f.store.submit(draft.id, draft.token, { ...input(), screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' }), /INVALID_SCREENSHOT/)
  assert.throws(() => f.store.submit(draft.id, draft.token, { ...input(), screenshot: 'data:image/png;base64,' + Buffer.from('<script>bad</script>').toString('base64') }), /INVALID_SCREENSHOT/)
  f.store.submit(draft.id, draft.token, input())
  assert.deepEqual(f.store.proof(draft.id).bytes, PNG)
  const raw = fs.readFileSync(f.file, 'utf8')
  assert.ok(!raw.includes(PNG.toString('base64')))
  assert.ok(!raw.includes(draft.token))
  assert.equal(f.store.status(draft.id, draft.token).email, 'person@example.test')
})

test('submission and approval retries are idempotent; receipt reuse cannot open a second gateway', t => {
  const f = fixture(t), a = submitted(f)
  assert.equal(f.store.submit(a.id, a.token, input()).status, 'submitted')
  assert.throws(() => f.store.approve(a.id, { verified: false, receipt: 'wx-receipt-001' }), /VERIFIED_RECEIPT_REQUIRED/)
  const first = f.store.approve(a.id, approval('wx-receipt-001'))
  f.advance(60000)
  assert.deepEqual(f.store.approve(a.id, approval('wx-receipt-001')), first)
  const b = submitted(f, 'another@example.test')
  assert.throws(() => f.store.approve(b.id, approval('wx-receipt-001')), /RECEIPT_ALREADY_USED/)
  assert.equal(f.registry.list().length, 1)
  assert.throws(() => submitted(f, 'PERSON@example.test'), /EMAIL_ALREADY_ACTIVE/)
})

test('single-host binding survives expiry and renewal, old code cannot bind another host', t => {
  const f = fixture(t), a = submitted(f)
  const grant = f.store.approve(a.id, approval('wx-first-month'))
  const code = f.store.claim(a.id, a.token).code
  const pair = crypto.generateKeyPairSync('ed25519'), key = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const enrolled = f.registry.enroll(code, key)
  assert.equal(enrolled.monthlyLimitBytes, 5e9); assert.equal(enrolled.fileTransfer, false)
  assert.throws(() => f.registry.enroll(code, other), /HOST_ALREADY_BOUND/)
  f.advance(33 * 86400000)
  assert.equal(f.store.status(a.id, a.token).status, 'expired')
  const b = submitted(f)
  const renewed = f.store.approve(b.id, approval('wx-second-month'))
  assert.equal(renewed.grantId, grant.grantId)
  assert.equal(f.registry.get(grant.grantId).publicKey, key)
  const freshCode = f.store.claim(b.id, b.token).code
  assert.throws(() => f.registry.enroll(code, key), /INVALID_AUTHORIZATION/)
  assert.throws(() => f.registry.enroll(freshCode, other), /HOST_ALREADY_BOUND/)
  assert.equal(f.registry.enroll(freshCode, key).domain, enrolled.domain)
})

test('approval notifications contain neither the activation key nor the private query credential', t => {
  const f = fixture(t), d = submitted(f)
  f.store.approve(d.id, approval('wx-email-copy-001'))
  const message = f.store.delivery(d.id)
  assert.match(message.text, /私密查询凭证领取密钥/)
  assert.doesNotMatch(message.text, /dsrp_/)
  assert.ok(!message.text.includes(d.token))
  assert.match(f.store.claim(d.id, d.token).code, /^dsrp_/)
  assert.throws(() => f.store.claim(d.id, 'wrong'), /APPLICATION_UNAUTHORIZED/)
})
test('delivery survives restart without plaintext codes; sending remains explicitly manual', t => {
  const f = fixture(t), a = submitted(f)
  f.store.approve(a.id, approval('wx-delivery-001'))
  const message = f.store.delivery(a.id)
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes('dsrp_'))
  assert.equal(f.store.status(a.id, a.token).deliveredAt, undefined)
  const restarted = new Sponsorship({ file: f.file, adminToken: ADMIN })
  assert.deepEqual(restarted.delivery(a.id), message)
  assert.equal(restarted.list()[0].sealedCode, undefined)
  assert.equal(restarted.list()[0].tokenHash, undefined)
  restarted.delivered(a.id)
  assert.ok(restarted.status(a.id, a.token).deliveredAt)
  const wrongKey = new Sponsorship({ file: f.file, adminToken: ADMIN + 'rotated' })
  assert.throws(() => wrongKey.delivery(a.id), /DELIVERY_KEY_UNAVAILABLE/)
})

test('monthly ledger cannot reset at midnight or restart and renewal starts a new bounded period', t => {
  const f = fixture(t), a = submitted(f), issued = f.store.approve(a.id, approval('wx-month-quota'))
  const file = path.join(f.root, 'monthly-quota.json'), options = { now: f.now, limit: 100, block: 10 }
  let quota = new MonthlyQuota(file, f.registry, options)
  assert.equal(quota.consume(issued.grantId, 65), true)
  f.advance(86400000)
  assert.equal(quota.view(issued.grantId).usedBytes, 65)
  quota.checkpoint(); quota = new MonthlyQuota(file, f.registry, options)
  assert.equal(quota.view(issued.grantId).usedBytes, 65)
  assert.equal(quota.view(issued.grantId).resetsAt, issued.expiresAt)
  assert.equal(quota.consume(issued.grantId, 36), false)
  assert.equal(quota.view(issued.grantId).exhausted, true)
  f.advance(33 * 86400000)
  const b = submitted(f), next = f.store.approve(b.id, approval('wx-month-quota-2'))
  assert.equal(next.grantId, issued.grantId)
  assert.equal(quota.view(issued.grantId).usedBytes, 0)
  assert.equal(quota.view(issued.grantId).period, 'month')
})

test('monthly corrupt storage fails closed', t => {
  const f = fixture(t), file = path.join(f.root, 'monthly-quota.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { '1122334455667788': { day: '2026-10-30', reserved: 10 } } }))
  assert.throws(() => new MonthlyQuota(file, f.registry), /QUOTA_STORAGE_UNAVAILABLE/)
})

test('operator pause survives restart, blocks only new drafts and leaves paid applications reviewable', t => {
  const f = fixture(t), a = f.store.draft()
  assert.throws(() => f.store.configure({ accepting: 'false' }), /INVALID_SPONSOR_SETTINGS/)
  f.store.configure({ accepting: false })
  assert.throws(() => f.store.draft(), { code: 'CLOSED', reason: 'paused' })
  const restarted = new Sponsorship({ file: f.file, adminToken: ADMIN, now: f.now })
  assert.equal(restarted.settings().accepting, false)
  restarted.submit(a.id, a.token, { ...input(), email: 'paid@example.test' })
  assert.equal(restarted.approve(a.id, approval('wx-paused-paid')).status, 'approved')
  restarted.configure({ accepting: true })
  assert.ok(restarted.draft().id)
})

test('revocation invalidates delivery and enrollment, is retryable and cannot target a newer renewal', t => {
  const f = fixture(t), a = submitted(f), issued = f.store.approve(a.id, approval('wx-revoke-first'))
  f.advance(33 * 86400000)
  assert.equal(f.store.list()[0].status, 'expired')
  assert.throws(() => f.store.delivered(a.id), /DELIVERY_INACTIVE/)
  const b = submitted(f), renewed = f.store.approve(b.id, approval('wx-revoke-second'))
  assert.equal(renewed.grantId, issued.grantId)
  assert.throws(() => f.store.revoke(a.id, 'old application'), /DELIVERY_INACTIVE/)
  const code = f.store.claim(b.id, b.token).code
  assert.throws(() => f.store.revoke(b.id, ''), /REVIEW_NOTE_REQUIRED/)
  const revoked = f.store.revoke(b.id, '已与申请人联系，停止服务并人工处理退款。')
  assert.deepEqual(f.store.revoke(b.id, '已与申请人联系，停止服务并人工处理退款。'), revoked)
  assert.equal(f.store.status(b.id, b.token).status, 'revoked')
  assert.equal(f.store.approve(b.id, approval('wx-revoke-second')).status, 'revoked')
  assert.equal(f.store.list()[0].status, 'revoked')
  assert.throws(() => f.store.delivery(b.id), /DELIVERY_INACTIVE/)
  assert.throws(() => f.store.delivered(b.id), /DELIVERY_INACTIVE/)
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
  assert.throws(() => f.registry.enroll(code, key), /INVALID_AUTHORIZATION/)
})

test('basic policy rejects file endpoints, encoded aliases and ranged images; allows only bounded image routes', () => {
  for (const route of ['/fs', '/fs/list', '/fs/upload', '/fs/file?path=a.txt', '/remote/api/session-file?attachmentId=aa', '/api/file-inbox', '/admin/api/file-inbox', '/api/session.export', '/fs%2fupload', '/fs%252fupload']) assert.throws(() => basicPolicy({ method: 'GET', url: route, headers: {} }), /FILE_TRANSFER_NOT_ALLOWED/)
  assert.equal(basicPolicy({ method: 'GET', url: '/fs/file?path=a.png', headers: {} }), 'image')
  assert.throws(() => basicPolicy({ method: 'GET', url: '/fs/file?path=a.png', headers: { range: 'bytes=1-2' } }))
  assert.equal(basicPolicy({ method: 'POST', url: '/api/session.attachment', headers: {} }), 'attachment')
  assert.equal(basicPolicy({ method: 'POST', url: '/api/session.prompt', headers: {} }), null)
})

async function httpFixture(t, options = {}) {
  const { start, ...portalOptions } = options
  const sent = []
  const f = fixture(t, { start })
  const qrFile = path.join(f.root, 'qr.png')
  fs.writeFileSync(qrFile, PNG)
  const portal = createSponsorPortal({ file: f.file, adminToken: ADMIN, now: f.now, qrFile, publicOrigin: 'https://sponsor.example.test',
    sendMail: async mail => { sent.push(mail) }, ...portalOptions })
  const server = http.createServer((req, res) => { void portal.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = 'http://127.0.0.1:' + server.address().port
  const raw = (route, token, data, headers) => fetch(base + '/sponsor/' + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  })
  const call = async (...args) => {
    const response = await raw(...args)
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  const draft = async () => {
    const response = await call('api/applications', null, {})
    assert.equal(response.status, 201)
    return { ...response.body, route: 'api/applications/' + response.body.id }
  }
  const send = (d, email = 'person@example.test', headers) => call(d.route + '/email', d.token, { email }, headers)
  const verify = (d, code) => call(d.route + '/verify', null, { code })
  return { ...f, store: portal.store, call, raw, draft, send, verify, sent }
}

test('portal serves verified applications and authenticated review, never exposing proofs or keys publicly', async t => {
  const { raw, call, draft: begin, store } = await httpFixture(t, {
    contactEmail: 'ops@example.test',
    readUsage: () => ({ online: true, usedBytes: 123, limitBytes: 5e9, remainingBytes: 5e9 - 123, resetsAt: Date.now() + 60000, apiKey: 'PRIVATE_USAGE_SECRET' })
  })
  const page = await raw('')
  assert.match(await page.text(), /接收邮箱/); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const draft = await begin()
  verifyEmail(store, draft)
  assert.equal((await call('api/applications/' + draft.id, null)).status, 403)
  assert.equal((await call('api/applications/' + draft.id, draft.token, input())).status, 200)
  assert.equal((await call('api/admin/applications', draft.token)).status, 401)
  assert.equal((await call('api/admin/applications/' + draft.id + '/proof')).status, 401)
  assert.equal((await call('api/admin/applications/' + draft.id + '/approve', ADMIN, approval('wx-http-approval'))).status, 200)
  const status = await call('api/applications/' + draft.id, draft.token)
  assert.equal(status.body.status, 'approved'); assert.equal(status.body.sealedCode, undefined); assert.equal(status.body.code, undefined)
  assert.equal(status.headers.get('access-control-allow-origin'), null)
  const delivery = await call('api/admin/applications/' + draft.id + '/delivery', ADMIN)
  assert.doesNotMatch(delivery.body.text, /dsrp_/)
  assert.equal((await call(draft.route + '/claim')).status, 403)
  assert.match((await call(draft.route + '/claim', draft.token)).body.code, /^dsrp_/)
  const listing = await call('api/admin/applications', ADMIN)
  assert.equal(listing.body.applications[0].usage.usedBytes, 123)
  assert.doesNotMatch(JSON.stringify(listing.body), /PRIVATE_USAGE_SECRET|apiKey/)
  assert.equal((await call('api/config')).headers.get('access-control-allow-origin'), '*')
  assert.equal((await call('api/config')).body.contactEmail, 'ops@example.test')
  assert.equal((await call('api/admin/config', draft.token)).status, 401)
  assert.equal((await call('api/admin/config', ADMIN, { accepting: 'false' })).status, 400)
  assert.equal((await call('api/admin/config', ADMIN, { accepting: false })).body.accepting, false)
  assert.equal((await call('api/config')).body.accepting, false)
  assert.equal((await call('api/applications', null, {})).status, 409)
  assert.equal((await call('api/admin/applications/' + draft.id + '/revoke', draft.token, { note: 'test' })).status, 401)
  assert.equal((await call('api/admin/applications/' + draft.id + '/revoke', ADMIN, { note: '人工退款处理' })).body.status, 'revoked')
  assert.equal((await call('api/applications/' + draft.id, draft.token)).body.status, 'revoked')
  assert.equal((await call('api/admin/applications/' + draft.id + '/delivery', ADMIN)).status, 409)
})

test('environment emergency pause cannot be overridden from the admin page', async t => {
  const { call } = await httpFixture(t, { start: at('23:05'), accepting: false })
  assert.equal((await call('api/admin/config', ADMIN, { accepting: false })).body.emergencyPaused, true)
  assert.equal((await call('api/config')).body.reason, 'emergency')
  assert.equal((await call('api/admin/config', ADMIN, { accepting: true })).body.emergencyPaused, true)
  assert.equal((await call('api/config')).body.open, false)
  const closed = await call('api/applications', null, {})
  assert.equal(closed.status, 409)
  assert.deepEqual(closed.body, { error: 'CLOSED', reason: 'emergency' })
})

test('applications and the payment flow work at night with sending disabled', async t => {
  const f = await httpFixture(t, { start: at('23:05'), sendMail: undefined })
  const d = await f.draft()
  assert.equal((await f.call('api/config')).body.mailEnabled, false)
  assert.equal((await f.raw(d.route + '/qr', d.token)).status, 200)
  assert.equal((await f.send(d)).status, 503)
  assert.equal((await f.call(d.route, d.token, { ...input(), email: 'night@example.test' })).status, 200)
  assert.equal((await f.call(d.route, d.token)).body.emailVerified, false)
  assert.equal((await f.call(d.route + '/claim', d.token)).status, 409)
})
test('optional test email is request-limited and only a deliberate POST confirms receipt', async t => {
  const f = await httpFixture(t, { start: at('23:05') }), d = await f.draft()
  assert.equal((await f.send(d)).status, 202)
  assert.equal((await f.send(d)).status, 429)
  const link = f.sent[0].text.match(/https:\/\/\S+/)[0]
  const { hash } = new URL(link)
  const code = hash.split('.')[1]
  assert.match(code, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(f.registry.read()).includes(code))
  assert.equal((await f.call(d.route + '/verify')).status, 405)
  assert.equal((await f.call(d.route, d.token)).body.emailVerified, false)
  assert.equal((await f.verify(d, 'a'.repeat(43))).status, 403)
  assert.equal((await f.verify(d, code)).body.verified, true)
  assert.equal((await f.verify(d, code)).status, 410)
  assert.equal((await f.call(d.route, d.token)).body.emailVerified, true)
})
test('private thread separates roles and applications and records unread and idempotent replies', async t => {
  const f = await httpFixture(t), a = await f.draft(), b = await f.draft()
  const operator = 'api/admin/applications/' + a.id + '/messages'
  const route = a.route + '/messages', post = { text: '<img> 我已付款', requestId: 'first_message_001' }
  assert.equal((await f.call(route, b.token, post)).status, 403)
  assert.equal((await f.call(operator, a.token)).status, 401)
  assert.equal((await f.call(route, a.token, post)).body.messages.length, 1)
  assert.equal((await f.call(route, a.token, post)).body.messages.length, 1)
  assert.equal((await f.call(route, a.token, { ...post, text: 'changed' })).status, 400)
  assert.equal((await f.call('api/admin/applications', ADMIN)).body.applications[0].unreadMessages, 1)
  assert.equal((await f.call(operator, ADMIN, { seenThrough: 1 })).body.unread, 0)
  assert.equal((await f.call(operator, ADMIN, { text: '已看到，请保留付款记录。', requestId: 'operator_reply_01' })).status, 200)
  assert.equal((await f.call(a.route, a.token)).body.unreadMessages, 1)
  assert.equal((await f.call(b.route, b.token)).body.unreadMessages, 0)
  const result = await f.call(route, a.token)
  assert.equal(result.body.messages[1].sender, 'operator')
  assert.equal(result.body.messages[0].text, post.text)
  assert.ok(!JSON.stringify(result.body).includes(post.requestId))
  assert.equal((await f.call(route, a.token, { seenThrough: 2 })).body.unread, 0)
  f.advance(2 * DAY)
  assert.equal((await f.call(route, a.token)).body.messages.length, 2)
})
test('opt-in reply reminder carries no private content and is sent once', async t => {
  const f = await httpFixture(t), d = await f.draft()
  verifyEmail(f.store, d)
  f.store.submit(d.id, d.token, { ...input(), notifyEmail: true })
  const path = 'api/admin/applications/' + d.id
  await f.call(path + '/messages', ADMIN, { text: 'PRIVATE_REPLY', requestId: 'operator_reply_01' })
  assert.equal((await f.call(path + '/notify', ADMIN, {})).status, 202)
  assert.equal((await f.call(path + '/notify', ADMIN, {})).status, 409)
  assert.equal(f.sent.length, 1)
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE_REPLY|dsrp_/)
  assert.ok(!JSON.stringify(f.sent).includes(d.token))
})

test('contract 13: legacy submitted and approved rows remain readable', async t => {
  const f = await httpFixture(t), pending = submitted(f), approved = submitted(f, 'approved@example.test')
  f.store.approve(approved.id, approval('wx-legacy-approved'))
  f.registry.change(state => {
    for (const row of state.sponsorship.applications) {
      delete row.emailVerifiedAt
      for (const field of Object.keys(row).filter(name => name.startsWith('verify'))) delete row[field]
    }
  })
  const before = (await f.call('api/applications/' + pending.id, pending.token)).body
  const after = (await f.call('api/applications/' + approved.id, approved.token)).body
  assert.equal(before.status, 'submitted'); assert.equal(after.status, 'approved')
  assert.equal(before.emailVerified, false); assert.equal(after.emailVerified, false)
  assert.equal((await f.call('api/applications/' + pending.id, pending.token, input())).status, 200)
  assert.match(f.store.claim(approved.id, approved.token).code, /^dsrp_/)
  t.diagnostic('legacy status=' + before.status + ',' + after.status + '; legacy submit retry=200')
})
