'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto')
const { createRealisticStack } = require('./fixtures/realistic-stack.cjs')
const key = () => crypto.randomBytes(32).toString('hex')

async function setup(t) {
  const s = await createRealisticStack(); t.after(() => s.stop())
  const api = async (route, body, receiverKey, token = s.token) => {
    const res = await fetch(s.base + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(receiverKey ? { 'x-dsh-remote-inbox-key': receiverKey } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() }
  }
  return { ...s, api }
}
test('actual gateway: consent, device binding, immutable snapshot, receipts and restart persistence', async t => {
  const s = await setup(t), receiver = key(), other = key()
  const register = await s.api('/api/file-inbox', { action: 'register', name: '我的手机' }, receiver)
  assert.equal(register.status, 200)
  await s.api('/api/file-inbox', { action: 'register', name: '其他设备' }, other)
  const devices = await s.api('/admin/api/file-inbox')
  assert.equal(devices.body.devices.length, 2)
  assert.doesNotMatch(JSON.stringify(devices.body), new RegExp(receiver + '|' + s.token))
  const send = { action: 'send', id: crypto.randomUUID(), path: path.join(s.tmpRoot, 'sample.txt'), workspaceRoot: s.tmpRoot, deviceId: register.body.id, sessionId: 'origin-session', title: '<img src=x onerror=alert(1)>', message: '请查收报告' }
  const receipt = await s.api('/admin/api/file-inbox', send)
  assert.equal(receipt.status, 200); assert.equal(receipt.body.phase, 'pending')
  assert.equal((await(await fetch(s.base + '/health')).json()).capabilities.fileInbox, 1)
  assert.equal((await fetch(s.base + '/api/file-inbox/file?id=' + send.id, { headers: { authorization: 'Bearer ' + s.token } })).status, 404, 'bytes must only use the relay-metered /fs namespace')
  assert.equal((await s.api('/api/file-inbox', null, other)).body.transfers.length, 0)
  assert.equal((await s.api('/api/file-inbox', { action: 'accept', id: send.id }, other)).status, 404)
  assert.equal((await s.api('/api/file-inbox', { action: 'receipt', id: send.id, phase: 'complete' }, receiver)).status, 409)
  assert.equal((await fetch(s.base + '/fs/inbox-file?id=' + send.id, { headers: { authorization: 'Bearer ' + s.token } })).status, 403)
  fs.writeFileSync(send.path, 'changed after sending')
  assert.deepEqual((await s.api('/admin/api/file-inbox', send)).body, receipt.body, 'retry must return the same fixed snapshot')
  assert.equal((await s.api('/admin/api/file-inbox', { ...send, message: 'different intent' })).status, 409)
  await s.restartGateway()
  assert.equal((await s.api('/api/file-inbox', null, receiver)).body.transfers[0].phase, 'pending')
  const accept = await s.api('/api/file-inbox', { action: 'accept', id: send.id }, receiver)
  assert.ok(accept.body.ticket)
  const url = s.base + '/fs/inbox-file?id=' + send.id + '&ticket=' + accept.body.ticket
  const download = await fetch(url, { headers: { authorization: 'Bearer ' + s.token } })
  assert.equal(download.status, 200)
  const bytes = Buffer.from(await download.arrayBuffer())
  assert.equal(bytes.toString(), '真实文件下载内容')
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), receipt.body.sha256)
  assert.equal((await s.api('/admin/api/file-inbox', { action: 'status', id: send.id, sessionId: 'different-session' })).status, 404)
  assert.equal((await s.api('/api/file-inbox', { action: 'receipt', id: send.id, phase: 'downloaded' }, receiver)).status, 200)
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer ' + s.token } })).status, 403, 'receipt must revoke the download capability')
  const status = await s.api('/admin/api/file-inbox', { action: 'status', id: send.id, sessionId: send.sessionId })
  assert.equal(status.body.phase, 'downloaded')
  assert.doesNotMatch(JSON.stringify(status.body), /ticket|requestHash|workspaceRoot/)
  assert.equal((await s.api('/api/file-inbox', { action: 'accept', id: send.id }, receiver)).status, 409)
})

test('actual gateway: independent device keys cannot enumerate senders or use another receiver capability; revocation stops receipt access', async t => {
  const s = await setup(t), mode = await s.api('/admin/api/device-keys/mode', { enabled: true, note: 'phone' })
  assert.equal(mode.status, 200)
  const token = mode.body.deviceKeys.entries[0].token
  const second = await s.api('/admin/api/device-keys/create', { note: 'tablet' })
  assert.equal(second.status, 201)
  const otherToken = second.body.entry.token, receiver = key()
  const device = await s.api('/api/file-inbox', { action: 'register', name: 'phone' }, receiver, token)
  assert.equal(device.status, 200)
  assert.equal((await s.api('/admin/api/file-inbox', null, null, token)).status, 401)
  const send = { action: 'send', id: crypto.randomUUID(), path: path.join(s.tmpRoot, 'sample.txt'), workspaceRoot: s.tmpRoot, deviceId: device.body.id, sessionId: 'session' }
  assert.equal((await s.api('/admin/api/file-inbox', send)).status, 200)
  assert.equal((await s.api('/api/file-inbox', null, receiver, otherToken)).status, 403)
  const accepted = await s.api('/api/file-inbox', { action: 'accept', id: send.id }, receiver, token)
  const download = '/fs/inbox-file?id=' + send.id + '&ticket=' + accepted.body.ticket
  assert.equal((await fetch(s.base + download, { headers: { authorization: 'Bearer ' + otherToken } })).status, 403)
  assert.equal((await fetch(s.base + download, { headers: { authorization: 'Bearer ' + s.token } })).status, 401)
  assert.equal((await s.api('/admin/api/device-keys/revoke', { id: mode.body.deviceKeys.entries[0].id })).status, 200)
  assert.equal((await fetch(s.base + download, { headers: { authorization: 'Bearer ' + token } })).status, 401)
})

test('actual gateway: rejects protected state, workspace escape and directories; rejection never exposes bytes', async t => {
  const s = await setup(t), receiver = key(), d = await s.api('/api/file-inbox', { action: 'register' }, receiver)
  const base = { action: 'send', workspaceRoot: s.tmpRoot, deviceId: d.body.id, sessionId: 'session' }
  for (const p of [path.join(s.tmpRoot, '.dsh-remote', 'file-inbox', 'index.json'), s.tmpRoot]) {
    const out = await s.api('/admin/api/file-inbox', { ...base, id: crypto.randomUUID(), path: p })
    assert.ok(out.status >= 400, p)
  }
  assert.equal((await s.api('/admin/api/file-inbox', { ...base, id: crypto.randomUUID(), path: path.join(s.tmpRoot, 'sample.txt'), workspaceRoot: path.join(s.tmpRoot, 'project-one') })).status, 403)
  const id = crypto.randomUUID()
  assert.equal((await s.api('/admin/api/file-inbox', { ...base, id, path: path.join(s.tmpRoot, 'sample.txt') })).status, 200)
  assert.equal((await s.api('/api/file-inbox', { action: 'reject', id }, receiver)).body.phase, 'rejected')
  assert.equal((await s.api('/api/file-inbox', { action: 'reject', id }, receiver)).status, 200)
  assert.equal((await s.api('/api/file-inbox', { action: 'accept', id }, receiver)).status, 409)
  assert.ok(!fs.existsSync(path.join(s.tmpRoot, '.dsh-remote', 'file-inbox', id + '.bin')))
  assert.equal((await fetch(s.base + '/api/file-inbox', { method: 'OPTIONS', headers: { origin: 'https://localhost', 'access-control-request-headers': 'x-dsh-remote-inbox-key' } })).headers.get('access-control-allow-headers').includes('x-dsh-remote-inbox-key'), true)
})

test('store: expiry, file limit, corruption, restart and changed snapshot fail closed', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-store-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8'), c = vm.createContext({ fs, path, crypto, Buffer, process })
  vm.runInContext(source.slice(source.indexOf('function createFileInbox('), source.indexOf('// END FILE INBOX STORE')), c)
  let time = 1000, valid = true
  const options = { root: path.join(tmp, 'store'), now: () => time, validAuth: () => valid, maxFile: 4, ttl: 100, resolveSource: async p => p }
  const store = c.createFileInbox(options), receiver = key(), d = await store.register('auth', receiver, 'phone'), local = path.join(tmp, 'file.txt')
  fs.writeFileSync(local, 'tiny')
  const row = { id: crypto.randomUUID(), deviceId: d.id, path: local, workspaceRoot: tmp, sessionId: 'session' }
  await store.send(row)
  const accepted = await store.decide('auth', receiver, row.id, 'accept')
  fs.writeFileSync(path.join(options.root, row.id + '.bin'), 'oops')
  await assert.rejects(store.download('auth', row.id, accepted.ticket), /integrity/)
  fs.writeFileSync(local, 'too large')
  await assert.rejects(store.send({ ...row, id: crypto.randomUUID() }), /too-large/)
  fs.writeFileSync(local, 'tiny'); const pending = await store.send({ ...row, id: crypto.randomUUID() })
  const reopened = c.createFileInbox(options)
  time += 101
  assert.equal((await reopened.status(pending.id, 'session')).phase, 'expired')
  await assert.rejects(reopened.decide('auth', receiver, pending.id, 'accept'), /expired/)
  assert.ok(!fs.existsSync(path.join(options.root, pending.id + '.bin')))
  valid = false
  await assert.rejects(reopened.list('auth', receiver), /not-registered/)
  fs.writeFileSync(path.join(options.root, 'index.json'), '{broken')
  await assert.rejects(c.createFileInbox(options).devices(), /storage-invalid/)
})
