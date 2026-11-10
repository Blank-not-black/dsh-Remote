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
  let now = start ?? Math.floor((Date.now() + 8 * HOUR) / DAY) * DAY + 4 * HOUR
  const store = new Sponsorship({ file, adminToken: ADMIN, now: () => now, ...options })
  const registry = new Registry(file)
  return { root, file, store, registry, now: () => now, advance: ms => { now += ms }, setNow: ms => { now = ms } }
}
function verifyEmail(store, draft, email = 'person@example.test') {
  store.heartbeat()
  store.requestVerification(draft.id, draft.token, { email }, '127.0.0.1')
  const { code, expiresAt } = store.verifications().find(item => item.id === draft.id)
  store.verificationResult(draft.id, { delivered: true, expiresAt })
  store.verify(draft.id, draft.token, code)
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
  assert.match(f.store.delivery(draft.id).text, /5GB/)
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
  f.store.heartbeat()
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
  const code = f.store.delivery(a.id).text.match(/dsrp_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}/)[0]
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
  const freshCode = f.store.delivery(b.id).text.match(/dsrp_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}/)[0]
  assert.throws(() => f.registry.enroll(code, key), /INVALID_AUTHORIZATION/)
  assert.throws(() => f.registry.enroll(freshCode, other), /HOST_ALREADY_BOUND/)
  assert.equal(f.registry.enroll(freshCode, key).domain, enrolled.domain)
})

test('delivery email explains the new LAN auto-pair flow and asks for a sanitized pairing log', t => {
  const f = fixture(t, { contactEmail: 'ops@example.test' }), draft = submitted(f)
  f.store.approve(draft.id, approval('wx-email-copy-001'))
  const message = f.store.delivery(draft.id)
  assert.match(message.text, /Remote 0\.8\.5/)
  assert.match(message.text, /通过当前局域网连接自动配对/)
  assert.match(message.text, /配对日志/)
  assert.match(message.text, /ops@example\.test/)
  assert.ok(message.text.includes(draft.id))
  assert.match(message.text, /5GB/)
  assert.match(message.text, /请勿发送中转密钥或 Remote 访问令牌本身/)
  const fallback = fixture(t), other = submitted(fallback)
  fallback.store.approve(other.id, approval('wx-email-copy-002'))
  const plain = fallback.store.delivery(other.id).text
  assert.match(plain, /回复本邮件/)
  assert.doesNotMatch(plain, /ops@example\.test/)
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
  verifyEmail(restarted, a)
  restarted.submit(a.id, a.token, input())
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
  const code = f.store.delivery(b.id).text.match(/dsrp_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}/)[0]
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
  const f = fixture(t, { start })
  const qrFile = path.join(f.root, 'qr.png')
  fs.writeFileSync(qrFile, PNG)
  const portal = createSponsorPortal({ file: f.file, adminToken: ADMIN, now: f.now, qrFile, ...portalOptions })
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
  const heartbeat = () => call('api/admin/heartbeat', ADMIN, {})
  const send = (d, email = 'person@example.test', headers) => call(d.route + '/email', d.token, { email }, headers)
  const queue = () => call('api/admin/verifications', ADMIN)
  const verify = (d, code) => call(d.route + '/verify', d.token, { code })
  const result = (d, value) => call('api/admin/verifications/' + d.id + '/result', ADMIN, value)
  return { ...f, store: portal.store, call, raw, draft, heartbeat, send, queue, verify, result }
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
  assert.match(delivery.body.text, /dsrp_/)
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

test('contract 01: at 23:05 draft is closed until tomorrow at 09:00 Shanghai', async t => {
  const f = await httpFixture(t, { start: at('23:05') })
  const closed = await f.call('api/applications', null, {})
  const { open, reason, opensAt } = (await f.call('api/config')).body
  assert.equal(closed.status, 409)
  assert.deepEqual(closed.body, { error: 'CLOSED', reason: 'hours' })
  assert.deepEqual({ open, reason, opensAt }, { open: false, reason: 'hours', opensAt: at('09:00') + DAY })
  t.diagnostic(closed.status + ' ' + closed.body.error + '; opensAt=' + new Date(opensAt).toISOString())
})

test('contract 02: a 22:45 draft can request a code at 22:52', async t => {
  const f = await httpFixture(t, { start: at('22:45') }), d = await f.draft()
  assert.equal(d.reservedUntil - f.now(), 90 * MINUTE)
  f.setNow(at('22:52')); await f.heartbeat()
  const sent = await f.send(d)
  assert.equal(sent.status, 202)
  const [{ code, expiresAt }] = (await f.queue()).body
  assert.equal(expiresAt, at('22:52') + 10 * MINUTE)
  f.setNow(at('23:00')); await f.heartbeat()
  const closed = await f.send(d), verified = await f.verify(d, code), submit = await f.call(d.route, d.token, input())
  assert.deepEqual(closed.body, { error: 'CLOSED', reason: 'hours' })
  assert.equal(closed.status, 409); assert.equal(verified.status, 200); assert.equal(submit.status, 200)
  t.diagnostic('22:52 send=' + sent.status + '; 23:00 new send=' + closed.status + ' ' + closed.body.error + ', verify=' + verified.status + ', submit=' + submit.status)
})

test('contract 03: the draft cutoff starts exactly at 22:50', async t => {
  const f = await httpFixture(t, { start: at('22:50') - 1 })
  await f.draft()
  for (const time of ['22:50', '22:52']) {
    f.setNow(at(time))
    const closed = await f.call('api/applications', null, {})
    assert.equal(closed.status, 409)
    assert.deepEqual(closed.body, { error: 'CLOSED', reason: 'hours' })
    t.diagnostic(time + ' ' + closed.status + ' ' + closed.body.error)
  }
})

test('contract 04: unverified drafts cannot submit or read the payment QR', async t => {
  const f = await httpFixture(t), d = await f.draft()
  const submit = await f.call(d.route, d.token, { ...input(), email: 'bypass@example.test' })
  const qr = await f.call(d.route + '/qr', d.token)
  for (const response of [submit, qr]) {
    assert.equal(response.status, 409); assert.equal(response.body.error, 'EMAIL_NOT_VERIFIED')
  }
  assert.equal((await f.raw('qr')).status, 404)
  assert.equal((await f.call(d.route + '/qr')).status, 403)
  assert.equal((await f.call(d.route, d.token)).body.status, 'draft')
  t.diagnostic('submit=' + submit.status + ' ' + submit.body.error + '; QR=' + qr.status + ' ' + qr.body.error)
})

test('contract 05: resend waits a full 60 seconds', async t => {
  const f = await httpFixture(t), d = await f.draft()
  await f.heartbeat()
  const first = await f.send(d)
  assert.equal(first.status, 202); assert.equal(first.body.cooldownUntil, f.now() + MINUTE)
  f.advance(MINUTE - 1)
  const early = await f.send(d)
  assert.equal(early.status, 429); assert.equal(early.body.error, 'EMAIL_VERIFICATION_COOLDOWN')
  f.advance(1)
  const next = await f.send(d)
  assert.equal(next.status, 202)
  t.diagnostic('59999ms=' + early.status + ' ' + early.body.error + '; 60000ms=' + next.status)
})

test('contract 06: a draft cannot request a sixth code', async t => {
  const f = await httpFixture(t), d = await f.draft()
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.heartbeat()).status, 200)
    assert.equal((await f.send(d)).status, 202)
    f.advance(MINUTE)
  }
  await f.heartbeat()
  const sixth = await f.send(d)
  assert.equal(sixth.status, 429); assert.equal(sixth.body.error, 'VERIFY_SEND_LIMIT')
  t.diagnostic('first five=202; sixth=' + sixth.status + ' ' + sixth.body.error)
})

test('contract 07: an email cannot request its eleventh code across three drafts', async t => {
  const f = await httpFixture(t)
  for (const email of ['person@example.test', 'PERSON@EXAMPLE.TEST']) {
    const d = await f.draft()
    for (let index = 0; index < 5; index++) {
      await f.heartbeat(); assert.equal((await f.send(d, email)).status, 202); f.advance(MINUTE)
    }
  }
  const third = await f.draft()
  await f.heartbeat()
  const eleventh = await f.send(third)
  assert.equal(eleventh.status, 429); assert.equal(eleventh.body.error, 'TRY_LATER')
  assert.equal((await f.send(third, 'different@example.test')).status, 202)
  f.advance(DAY); await f.heartbeat()
  assert.equal((await f.send(await f.draft())).status, 202)
  t.diagnostic('first ten=202; eleventh on third draft=' + eleventh.status + ' ' + eleventh.body.error + '; after 24h=202')
})

test('contract 08: five incorrect attempts lock the code until resend', async t => {
  const f = await httpFixture(t), d = await f.draft()
  await f.heartbeat(); await f.send(d)
  const [{ code }] = (await f.queue()).body, attempts = []
  const wrong = code === '000000' ? '000001' : '000000'
  for (let left = 4; left >= 0; left--) {
    const invalid = await f.verify(d, wrong)
    assert.equal(invalid.status, 403); assert.deepEqual(invalid.body, { error: 'INVALID_CODE', attemptsLeft: left })
    attempts.push(invalid.body.attemptsLeft)
  }
  const locked = await f.verify(d, code)
  assert.equal(locked.status, 429); assert.equal(locked.body.error, 'TOO_MANY_ATTEMPTS')
  f.advance(MINUTE); assert.equal((await f.send(d)).status, 202)
  const [fresh] = (await f.queue()).body
  const verified = await f.verify(d, fresh.code)
  assert.equal(verified.status, 200); assert.deepEqual(verified.body, { verified: true })
  t.diagnostic('403 attemptsLeft=' + attempts.join(',') + '; correct after lock=' + locked.status + ' ' + locked.body.error + '; resend then verify=' + verified.status)
})

test('contract 09: verified email is immutable and verification extends the reservation', async t => {
  const f = await httpFixture(t), d = await f.draft()
  f.advance(75 * MINUTE); await f.heartbeat(); await f.send(d)
  const [{ code, expiresAt }] = (await f.queue()).body
  await f.result(d, { delivered: true, expiresAt })
  assert.equal((await f.verify(d, code)).status, 200)
  const changed = await f.send(d, 'different@example.test')
  assert.equal(changed.status, 409); assert.equal(changed.body.error, 'APPLICATION_NOT_EDITABLE')
  assert.equal((await f.verify(d, code)).body.error, 'APPLICATION_NOT_EDITABLE')
  const status = (await f.call(d.route, d.token)).body
  assert.equal(status.reservedUntil, f.now() + HOUR); assert.equal(status.verifyExpiresAt, 0)
  assert.equal((await f.call(d.route, d.token, { ...input(), email: 'different@example.test' })).status, 200)
  assert.equal((await f.call(d.route, d.token)).body.email, 'person@example.test')
  t.diagnostic('change=' + changed.status + ' ' + changed.body.error + '; reservation remaining=' + (status.reservedUntil - f.now()) / MINUTE + 'min; original email retained')
})

test('contract 10 API: at 91 seconds offline the server withholds QR and rejects sends', async t => {
  const f = await httpFixture(t), d = await f.draft(), unverified = await f.draft()
  assert.equal((await f.call('api/config')).body.mailerOnline, false)
  assert.equal((await f.call('api/admin/heartbeat', d.token, {})).status, 401)
  assert.equal((await f.call('api/admin/heartbeat', ADMIN)).status, 405)
  assert.deepEqual((await f.heartbeat()).body, { at: f.now() })
  verifyEmail(f.store, d)
  f.advance(89 * 1000)
  const live = (await f.call('api/config')).body
  assert.equal(live.mailerOnline, true)
  assert.equal(live.mailerOnlineUntil - live.serverTime, 1000)
  const qr = await f.raw(d.route + '/qr', d.token)
  assert.equal(qr.status, 200); assert.equal(qr.headers.get('cache-control'), 'no-store'); await qr.arrayBuffer()
  f.advance(2000)
  const { mailerOnline } = (await f.call('api/config')).body
  const offlineQr = await f.call(d.route + '/qr', d.token), send = await f.send(unverified)
  assert.equal(mailerOnline, false); assert.equal(offlineQr.status, 429)
  assert.equal(send.status, 429); assert.equal(send.body.error, 'TRY_LATER')
  t.diagnostic('mailerOnline=' + mailerOnline + '; QR=' + offlineQr.status + '; send=' + send.status + ' ' + send.body.error)
})

test('contract 11 API: delivery failure is visible and clears the queue', async t => {
  const f = await httpFixture(t), d = await f.draft()
  await f.heartbeat(); await f.send(d)
  const [{ expiresAt }] = (await f.queue()).body, reason = '550 recipient non-existent'
  const report = await f.result(d, { delivered: false, reason, expiresAt })
  assert.equal(report.status, 200); assert.deepEqual(report.body, { ok: true })
  assert.deepEqual((await f.queue()).body, [])
  const value = (await f.call(d.route, d.token)).body
  assert.equal(value.verifyError, reason); assert.equal(value.verifyExpiresAt, expiresAt); assert.equal(value.verifyPending, false)
  t.diagnostic('result=' + report.status + '; queue=0; verifyError=' + value.verifyError)
})

test('contract 12: spoofed client date and timezone cannot open the server gate', async t => {
  const f = await httpFixture(t, { start: at('23:05') })
  const headers = { date: 'Tue, 10 Nov 2026 09:30:00 GMT', 'x-time-zone': 'America/Los_Angeles' }
  const closed = await f.call('api/applications', null, { now: at('09:30'), timeZone: 'Pacific/Auckland' }, headers)
  assert.equal(closed.status, 409); assert.deepEqual(closed.body, { error: 'CLOSED', reason: 'hours' })
  f.setNow(at('09:00') + DAY)
  const opened = await f.call('api/applications', null, {}, headers)
  assert.equal(opened.status, 201)
  t.diagnostic('server 23:05=' + closed.status + ' ' + closed.body.error + '; server 09:00=' + opened.status)
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
  assert.match(f.store.delivery(approved.id).text, /通过当前局域网连接自动配对/)
  t.diagnostic('legacy status=' + before.status + ',' + after.status + '; legacy submit retry=200')
})

test('contract 14: activation email method matches the main baseline byte for byte', t => {
  const source = fs.readFileSync(path.join(__dirname, '../relay/sponsorship.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const delivery = source.slice(source.indexOf('  delivery(id) {'), source.indexOf('  delivered(id) {'))
  const hash = crypto.createHash('sha256').update(delivery).digest('hex')
  assert.equal(hash, 'f6fb0e2a2999c38ecd2c8748e43d98118ea1d213ca72c7319e07ef0c45cb86ce')
  assert.match(delivery, /通过当前局域网连接自动配对/)
  t.diagnostic('main and HEAD SHA-256=' + hash)
})

test('admin queue is authenticated, sealed at rest, expiry-aware, and safe against delayed reports', async t => {
  const f = await httpFixture(t), first = await f.draft(), second = await f.draft()
  await f.heartbeat()
  assert.equal((await f.call('api/admin/verifications', first.token)).status, 401)
  await f.send(second); f.advance(MINUTE); await f.send(first, 'second@example.test')
  const queue = await f.queue()
  assert.equal(queue.headers.get('cache-control'), 'no-store')
  assert.deepEqual(queue.body.map(item => item.id), [second.id, first.id])
  const [old] = queue.body
  assert.match(old.code, /^\d{6}$/)
  const row = f.registry.read().sponsorship.applications.find(a => a.id === second.id)
  assert.equal(row.verifyCodeHash, crypto.createHash('sha256').update('dsh-sponsor-verify-v1\0' + second.id + '\0' + old.code).digest('hex'))
  assert.ok(!Object.values(row).includes(old.code))
  const status = (await f.call(second.route, second.token)).body
  assert.equal(status.code, undefined); assert.equal(status.verifyCodeHash, undefined); assert.equal(status.sealedVerificationCode, undefined)
  assert.equal((await f.send(second)).status, 202)
  await f.result(second, { delivered: false, reason: 'old result', expiresAt: old.expiresAt })
  const fresh = (await f.queue()).body.find(item => item.id === second.id)
  assert.equal(fresh.expiresAt, f.now() + 10 * MINUTE)
  assert.equal((await f.result(second, { delivered: true })).status, 200)
  assert.equal(f.registry.read().sponsorship.applications.find(a => a.id === second.id).sealedVerificationCode, undefined)
  f.advance(10 * MINUTE)
  const expired = await f.verify(second, fresh.code)
  assert.equal(expired.status, 410); assert.equal(expired.body.error, 'CODE_EXPIRED')
  assert.deepEqual((await f.queue()).body, [])
})

for (const trustProxy of [false, true]) {
  test('IP verification limits use ' + (trustProxy ? 'the trusted first forwarded hop' : 'the socket without proxy trust'), async t => {
    const f = await httpFixture(t, { trustProxy }), drafts = []
    const headers = (hop, proxy) => ({ 'x-forwarded-for': hop + ', ' + proxy })
    await f.heartbeat()
    for (let index = 0; index < 5; index++) drafts.push(await f.draft())
    for (let minute = 0; minute < 4; minute++) {
      for (let index = 0; index < drafts.length; index++) {
        const chain = headers('192.0.2.1', '192.0.2.' + (index + 10))
        assert.equal((await f.send(drafts[index], 'ip' + index + '@example.test', chain)).status, 202)
      }
      f.advance(MINUTE); await f.heartbeat()
    }
    const d = drafts[0], email = 'ip0@example.test'
    assert.equal((await f.send(d, email, headers('192.0.2.1', '192.0.2.255'))).status, 429)
    assert.equal((await f.send(d, email, headers('192.0.2.2', '192.0.2.255'))).status, trustProxy ? 202 : 429)
    f.advance(HOUR); await f.heartbeat()
    assert.equal((await f.send(await f.draft(), email, headers('192.0.2.1', '192.0.2.255'))).status, 202)
  })
}
