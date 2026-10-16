'use strict'
const { test: nodeTest } = require('node:test')
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { spawnSync, spawn } = require('node:child_process')
const { Registry, signingText } = require('../relay/registry.cjs')
const { createBroker } = require('../relay/broker.cjs')
const { RelayClient, enroll, gatewayAddress } = require('../relay/client.cjs')
const { line, send } = require('../relay/wire.cjs')
const { DailyQuota, DAILY_BYTES, dayAt, resetAt } = require('../relay/quota.cjs')
const { RelayHost } = require('../relay/host.cjs')

// Public, throwaway TLS material, used only on loopback. Never a deployed key.
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/relay-test-cert.pem'))
const key = fs.readFileSync(path.join(__dirname, 'fixtures/relay-test-key.pem'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms = 6000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await pause(20) }
  throw new Error('condition timed out')
}
function keys() {
  const pair = crypto.generateKeyPairSync('ed25519')
  return { publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port
}
async function close(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
function request(port, domain, route, { method = 'GET', token, data, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: route, method, ca: cert, headers: { host: domain, ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, timeout: 6000 }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject)
    req.end(data)
  })
}
async function fixture(t, hostCount = 2, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-'))
  const file = path.join(root, 'registry.json')
  const registry = Registry.init(file, { origin: 'https://localhost', baseDomain: 'relay.test', tunnelHost: '127.0.0.1', tunnelPort: 17443 })
  let broker = createBroker({ file, cert, key, frontTls: true, sweepMs: 30, heartbeatMs: 1000, fileBytesPerSecond: 512 * 1024, ...extra })
  const port = await listen(broker.front)
  const tunnelPort = await listen(broker.tunnel)
  registry.change(state => { state.origin = `https://localhost:${port}`; state.tunnelPort = tunnelPort })
  const hosts = []; const clients = []; const upgraded = new Set(); const cleanupTasks = []
  t.after(async () => {
    for (const cleanup of cleanupTasks) await cleanup()
    for (const client of clients) client.stop()
    for (const socket of upgraded) socket.destroy()
    await broker.close()
    for (const host of hosts) await close(host.gateway)
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (let i = 0; i < hostCount; i++) {
    const name = i ? 'beta' : 'alpha'; const token = `isolated-${name}-test-token`
    const gateway = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('unauthorized') }
      if (req.url === '/fs/download') { res.writeHead(200); return res.end(Buffer.alloc(128 * 1024, 3)) }
      if (req.url === '/slow' || req.url === '/fs/slow') { res.writeHead(200); res.write('first'); const timer = setTimeout(() => res.end('last'), 1500); res.once('close', () => clearTimeout(timer)); return }
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const payload = Buffer.concat(chunks)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ owner: name, method: req.method, path: req.url, authorization: req.headers.authorization, bytes: payload.length, hash: crypto.createHash('sha256').update(payload).digest('hex') }))
      })
    })
    gateway.on('upgrade', (req, socket) => {
      upgraded.add(socket); socket.once('close', () => upgraded.delete(socket)); socket.on('error', () => {})
      if (req.headers.authorization !== 'Bearer ' + token) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
      const text = Buffer.from(name)
      socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]))
      socket.on('data', chunk => {
        // A masked RFC6455 Ping fixture, echoed as an unmasked Pong.
        if (chunk[0] !== 0x89 || !(chunk[1] & 0x80)) return
        const length = chunk[1] & 0x7f
        if (chunk.length !== length + 6) return
        const output = Buffer.alloc(length + 2); output[0] = 0x8a; output[1] = length
        for (let j = 0; j < length; j++) output[j + 2] = chunk[j + 6] ^ chunk[2 + j % 4]
        socket.write(output)
      })
    })
    const gatewayPort = await listen(gateway)
    const issued = registry.issue({ label: name, domain: `${name}.relay.test`, expiresAt: Date.now() + 60000 })
    const pair = keys()
    const config = await enroll(`https://localhost:${port}`, issued.code, pair.publicKey, cert)
    const client = new RelayClient({ ...config, privateKey: pair.privateKey, gateway: `http://127.0.0.1:${gatewayPort}`, ca: cert, reconnectMs: 30, poolSize: 3 })
    client.start(); clients.push(client)
    hosts.push({ name, token, gateway, gatewayPort, issued, pair, config, client, domain: `${name}.relay.test` })
  }
  await until(() => broker.stats().filter(s => s.online && s.pooled >= 2).length === hostCount)
  return { root, file, registry, broker, port, tunnelPort, hosts, clients, cleanupTasks, replaceBroker: value => { broker = value } }
}
function websocket(port, host) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, ca: cert, path: '/events', headers: { host: host.domain, authorization: 'Bearer ' + host.token, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } })
    req.on('error', reject)
    req.on('response', res => { res.resume(); reject(new Error('Upgrade rejected: ' + res.statusCode)) })
    req.on('upgrade', (res, socket, head) => { socket.on('error', () => {}); socket.on('data', () => {}); resolve({ socket, head, res }) })
    req.end()
  })
}

test('relay registry: hashed invitations, idempotent binding, no host/key reassignment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-registry-'))
  try {
    const file = path.join(root, 'state.json')
    const registry = Registry.init(file, { origin: 'https://control.relay.test', baseDomain: 'relay.test', tunnelHost: 'tunnel.relay.test', tunnelPort: 17443 })
    const issued = registry.issue({ expiresAt: Date.now() + 60000, domain: 'one.relay.test' })
    assert.ok(!fs.readFileSync(file, 'utf8').includes(issued.code))
    const pair = keys()
    assert.deepEqual(registry.enroll(issued.code, pair.publicKey), registry.enroll(issued.code, pair.publicKey))
    assert.throws(() => registry.enroll(issued.code, keys().publicKey), /HOST_ALREADY_BOUND/)
    assert.throws(() => registry.issue({ expiresAt: Date.now() + 60000, domain: 'one.relay.test' }), /DOMAIN_ALREADY_ASSIGNED/)
    assert.throws(() => registry.issue({ expiresAt: Date.now() + 60000, domain: 'evil.test' }), /INVALID_TENANT_DOMAIN/)
    assert.throws(() => registry.issue({ expiresAt: Date.now() - 1 }), /INVALID_EXPIRY/)
    fs.writeFileSync(file + '.lock', '')
    assert.throws(() => registry.enroll(issued.code, pair.publicKey), /REGISTRY_BUSY/)
    fs.unlinkSync(file + '.lock')
    registry.revoke(issued.grant.id)
    assert.throws(() => registry.enroll(issued.code, pair.publicKey), /INVALID_AUTHORIZATION/)
    assert.equal(registry.list()[0].state, 'revoked')
    assert.ok(!JSON.stringify(registry.list()).includes('codeHash'))
    assert.ok(!JSON.stringify(registry.list()).includes('BEGIN PUBLIC'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('relay HTTP: real two-host isolation, original gateway auth, upload integrity and unknown hosts', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  for (const host of [a, b]) {
    const good = await request(f.port, host.domain, '/private', { token: host.token })
    assert.equal(good.status, 200); assert.equal(JSON.parse(good.body).owner, host.name)
    assert.equal((await request(f.port, host.domain, '/private', { token: host === a ? b.token : a.token })).status, 401)
    assert.equal((await request(f.port, host.domain, '/private')).status, 401)
  }
  assert.equal((await request(f.port, 'unknown.relay.test', '/private', { token: a.token })).status, 404)
  const payload = crypto.randomBytes(1024 * 1024)
  const uploaded = await request(f.port, a.domain, '/upload', { method: 'PUT', token: a.token, data: payload, headers: { 'content-length': payload.length } })
  assert.equal(uploaded.status, 200)
  assert.equal(JSON.parse(uploaded.body).hash, crypto.createHash('sha256').update(payload).digest('hex'))
  assert.equal(JSON.parse(uploaded.body).bytes, payload.length)
  assert.ok(f.broker.stats().find(s => s.grantId === a.issued.grant.id).upstreamBytes >= payload.length)
})

test('relay authorization: concurrent activation binds exactly one key and hides cloud administration', async t => {
  const f = await fixture(t, 0)
  const issued = f.registry.issue({ domain: 'race.relay.test', expiresAt: Date.now() + 60000 })
  const result = await Promise.allSettled([keys(), keys()].map(pair => enroll(`https://localhost:${f.port}`, issued.code, pair.publicKey, cert)))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(result.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1)
  await assert.rejects(enroll(`https://localhost:${f.port}`, issued.code.replace(/.$/, c => c === 'a' ? 'b' : 'a'), keys().publicKey, cert))
  assert.equal((await request(f.port, 'localhost', '/relay/v1/grants')).status, 404)
  assert.equal((await request(f.port, 'localhost', '/admin')).status, 404)
})

test('relay file lane limits concurrency while ordinary RPC stays available', async t => {
  const f = await fixture(t); const a = f.hosts[0]
  const first = request(f.port, a.domain, '/fs/slow', { token: a.token })
  const second = request(f.port, a.domain, '/fs/slow', { token: a.token })
  await until(() => f.broker.stats().find(s => s.grantId === a.issued.grant.id).active >= 2)
  assert.equal((await request(f.port, a.domain, '/fs/third', { token: a.token })).status, 429)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
  assert.deepEqual((await Promise.all([first, second])).map(r => r.body.toString()), ['firstlast', 'firstlast'])
  const payload = crypto.randomBytes(128 * 1024)
  const start = performance.now()
  const result = await request(f.port, a.domain, '/fs/upload', { token: a.token, method: 'PUT', data: payload, headers: { 'content-length': payload.length } })
  assert.equal(JSON.parse(result.body).hash, crypto.createHash('sha256').update(payload).digest('hex'))
  assert.ok(performance.now() - start >= 180, 'file upload was paced instead of bursting the entire body')
  const downloadStart = performance.now()
  const downloaded = await request(f.port, a.domain, '/fs/download', { token: a.token })
  assert.deepEqual(downloaded.body, Buffer.alloc(128 * 1024, 3))
  assert.ok(performance.now() - downloadStart >= 180, 'download remains paced even after upstream has finished')
})

test('relay WebSocket: preserves initial frames and bidirectional RFC6455 Ping/Pong', async t => {
  const f = await fixture(t); const host = f.hosts[0]
  const ws = await websocket(f.port, host)
  t.after(() => ws.socket.destroy())
  let incoming = ws.head
  ws.socket.on('data', data => { incoming = Buffer.concat([incoming, data]) })
  await until(() => incoming.includes(Buffer.from('alpha')))
  const mask = Buffer.from([1, 2, 3, 4]); const text = Buffer.from('alive')
  ws.socket.write(Buffer.concat([Buffer.from([0x89, 0x80 | text.length]), mask, Buffer.from(text.map((v, i) => v ^ mask[i % 4]))]))
  await until(() => incoming.includes(Buffer.concat([Buffer.from([0x8a, 5]), text])))
  assert.equal(ws.res.statusCode, 101)
})

test('relay revocation: closes existing WebSockets and active HTTP, preserves other tenant', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  const aws = await websocket(f.port, a); const bws = await websocket(f.port, b)
  t.after(() => { aws.socket.destroy(); bws.socket.destroy() })
  const interrupted = new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: f.port, ca: cert, path: '/slow', headers: { host: a.domain, authorization: 'Bearer ' + a.token } }, res => {
      res.once('data', () => {
        res.once('aborted', () => resolve(true))
        res.on('error', () => resolve(true))
        f.registry.revoke(a.issued.grant.id)
      })
      res.once('end', () => reject(new Error('revoked stream completed')))
    })
    req.on('error', reject); req.end()
  })
  const aClosed = once(aws.socket, 'close')
  await interrupted; await aClosed
  await until(() => !a.client.running)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 403)
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
  assert.equal(bws.socket.destroyed, false)
})

test('relay expiry and host-offline produce distinct failures and cut active connections', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  const ws = await websocket(f.port, a); const closed = once(ws.socket, 'close')
  f.registry.change(state => { state.grants.find(g => g.id === a.issued.grant.id).expiresAt = Date.now() + 100 })
  await closed
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 403)
  b.client.stop()
  await until(() => !f.broker.stats().find(s => s.grantId === b.issued.grant.id).online)
  const response = await request(f.port, b.domain, '/private', { token: b.token })
  assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).error, 'HOST_OFFLINE')
})

test('relay challenge authentication rejects wrong tenant key and replayed signatures', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  async function rejected(grantId, privateKey, signatureOverride) {
    const socket = tls.connect({ host: '127.0.0.1', port: f.tunnelPort, ca: cert })
    socket.on('error', () => {})
    const challenge = await line(socket)
    const signature = signatureOverride || crypto.sign(null, signingText(challenge.nonce, grantId, 'control', ''), privateKey).toString('base64url')
    const closed = once(socket, 'close')
    send(socket, { role: 'control', grantId, session: '', signature })
    await closed
    return signature
  }
  await rejected(b.issued.grant.id, a.pair.privateKey)
  // Capture a genuinely valid signature, close that session, then replay it
  // against a fresh challenge. Duplicate-host rejection cannot mask the test.
  const third = f.registry.issue({ domain: 'replay.relay.test', expiresAt: Date.now() + 60000 })
  const thirdKeys = keys(); f.registry.enroll(third.code, thirdKeys.publicKey)
  const first = tls.connect({ host: '127.0.0.1', port: f.tunnelPort, ca: cert }); first.on('error', () => {})
  const challenge = await line(first)
  const signature = crypto.sign(null, signingText(challenge.nonce, third.grant.id, 'control', ''), thirdKeys.privateKey).toString('base64url')
  send(first, { role: 'control', grantId: third.grant.id, session: '', signature })
  assert.equal((await line(first)).type, 'accepted')
  first.destroy()
  await until(() => !f.broker.stats().find(s => s.grantId === third.grant.id).online)
  await rejected(third.grant.id, thirdKeys.privateKey, signature)
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
})

test('relay live host cannot be displaced by a duplicate connection', async t => {
  const f = await fixture(t); const a = f.hosts[0]
  const duplicate = new RelayClient({ ...a.config, privateKey: a.pair.privateKey, gateway: `http://127.0.0.1:${a.gatewayPort}`, ca: cert, reconnectMs: 100 })
  t.after(() => duplicate.stop()); duplicate.start()
  await pause(250)
  assert.equal(duplicate.context, null)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
})

test('relay restarts reconnect without exchanging activation codes again', async t => {
  const f = await fixture(t); const a = f.hosts[0]
  await f.broker.close()
  const replacement = createBroker({ file: f.file, cert, key, frontTls: true, sweepMs: 30, heartbeatMs: 1000 })
  replacement.front.listen(f.port, '127.0.0.1'); replacement.tunnel.listen(f.tunnelPort, '127.0.0.1')
  await Promise.all([once(replacement.front, 'listening'), once(replacement.tunnel, 'listening')])
  f.replaceBroker(replacement)
  await until(() => replacement.stats().filter(s => s.online && s.pooled >= 2).length === 2)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
})

test('relay client requires HTTPS and loopback gateway, TLS certificate verification remains enabled', async t => {
  assert.throws(() => gatewayAddress('http://169.254.169.254/'), /LOCAL_GATEWAY_REQUIRED/)
  assert.throws(() => gatewayAddress('http://127.0.0.1:8787/api'), /LOCAL_GATEWAY_REQUIRED/)
  await assert.rejects(enroll('http://localhost', 'invalid', keys().publicKey), /HTTPS_ORIGIN_REQUIRED/)
  const f = await fixture(t); const a = f.hosts[0]
  await assert.rejects(enroll(`https://localhost:${f.port}`, a.issued.code, a.pair.publicKey), /ENROLLMENT_CONNECTION_FAILED/)
})

test('relay admin CLI stores invitations only in private output files and refuses overwrite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = path.join(root, 'registry.json'); const out = path.join(root, 'invitation.json')
  const cli = path.join(__dirname, '../relay/admin.cjs')
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: root, USERPROFILE: root, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }, encoding: 'utf8' })
  assert.equal(run(['init', '--state', state, '--origin', 'https://control.relay.test', '--base-domain', 'relay.test', '--tunnel-host', 'tunnel.relay.test']).status, 0)
  const issued = run(['issue', '--state', state, '--out', out, '--domain', 'dev.relay.test'])
  assert.equal(issued.status, 0, issued.stderr)
  const invite = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.ok(!issued.stdout.includes(invite.code))
  assert.ok(!fs.readFileSync(state, 'utf8').includes(invite.code))
  assert.notEqual(run(['issue', '--state', state, '--out', out, '--domain', 'dev2.relay.test']).status, 0)
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600)
})

test('relay client CLI stop actually terminates its control connection and process', async t => {
  const f = await fixture(t, 0)
  const issued = f.registry.issue({ domain: 'cli.relay.test', expiresAt: Date.now() + 60000 })
  const pair = keys(); const config = f.registry.enroll(issued.code, pair.publicKey)
  const state = path.join(f.root, 'client'); fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, 'host-private.pem'), pair.privateKey, { mode: 0o600 })
  fs.writeFileSync(path.join(state, 'connection.json'), JSON.stringify({ ...config, gateway: 'http://127.0.0.1:1' }))
  const cli = path.join(__dirname, '../relay/client.cjs')
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }
  const child = spawn(process.execPath, [cli, 'run', '--state', state, '--ca', path.join(__dirname, 'fixtures/relay-test-cert.pem')], { env, stdio: 'ignore', cwd: path.join(__dirname, '..') })
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), pause(2000)]) }
  })
  await until(() => f.broker.stats().some(s => s.grantId === issued.grant.id && s.online))
  const exited = once(child, 'exit')
  const stopped = spawnSync(process.execPath, [cli, 'stop', '--state', state], { env, encoding: 'utf8' })
  assert.equal(stopped.status, 0)
  const [code] = await exited; assert.equal(code, 0)
  await until(() => f.broker.stats().every(s => !s.online))
})

test('relay daily quota: decimal 5GB, Beijing midnight, durable reservations and no restart reset', t => {
  assert.equal(DAILY_BYTES, 5_000_000_000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-quota-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-10-16T15:59:59Z')
  const file = path.join(root, 'daily.json'), id = '1122334455667788', other = '8877665544332211'
  const options = { now: () => now, limit: 1000, block: 64 }
  const quota = new DailyQuota(file, options)
  assert.equal(dayAt(now), '2026-10-16')
  assert.equal(resetAt(now), Date.parse('2026-10-16T16:00:00Z'))
  assert.equal(quota.consume(id, 65), true)
  assert.equal(quota.view(id).usedBytes, 65)
  const recovered = new DailyQuota(file, options)
  assert.equal(recovered.view(id).usedBytes, 128, 'uncertain unused reservation stays charged after a crash')
  assert.equal(recovered.consume(id, 1000), false)
  assert.equal(recovered.view(id).exhausted, true)
  assert.equal(new DailyQuota(file, options).view(id).remainingBytes, 0)
  assert.equal(recovered.view(other).remainingBytes, 1000)
  now += 1000
  assert.equal(recovered.view(id).day, '2026-10-17')
  assert.equal(recovered.view(id).usedBytes, 0)
  assert.equal(recovered.consume(id, 10), true)
  recovered.checkpoint()
  assert.equal(new DailyQuota(file, options).view(id).usedBytes, 10)
})

test('relay quota storage fails closed on corrupt state or unavailable disk', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-ledger-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'daily.json')
  fs.writeFileSync(file, '{broken')
  assert.throws(() => new DailyQuota(file))
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { bad: { day: 'x', reserved: -1 } } }))
  assert.throws(() => new DailyQuota(file), /QUOTA_STORAGE_UNAVAILABLE/)
  fs.unlinkSync(file)
  const quota = new DailyQuota(file)
  fs.unlinkSync(file); fs.mkdirSync(file)
  assert.throws(() => quota.consume('1122334455667788', 1), /QUOTA_STORAGE_UNAVAILABLE/)
  assert.throws(() => quota.view('1122334455667788'), /QUOTA_STORAGE_UNAVAILABLE/)
})

test('relay quota enforces HTTP and existing WS, survives restart, resets by server day and isolates users', async t => {
  let now = Date.parse('2026-10-16T15:59:59Z')
  const quotaOptions = { now: () => now, limit: 4096, block: 128 }
  const f = await fixture(t, 2, { quotaOptions }); const [a,b] = f.hosts
  const aws = await websocket(f.port, a), bws = await websocket(f.port, b)
  t.after(() => { aws.socket.destroy(); bws.socket.destroy() })
  const closed = once(aws.socket, 'close')
  await request(f.port, a.domain, '/upload', { method: 'PUT', token: a.token, data: Buffer.alloc(8192) }).catch(() => {})
  await closed
  const blocked = await request(f.port, a.domain, '/private', { token: a.token })
  assert.equal(blocked.status, 429)
  assert.equal(JSON.parse(blocked.body).daily.remainingBytes, 0)
  assert.equal(JSON.parse(blocked.body).error, 'DAILY_QUOTA_EXCEEDED')
  await until(() => a.client.running && a.client.context)
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
  assert.equal(bws.socket.destroyed, false)
  await f.broker.close()
  const replacement = createBroker({ file: f.file, cert, key, frontTls: true, quotaOptions, sweepMs: 30, heartbeatMs: 1000 })
  replacement.front.listen(f.port, '127.0.0.1'); replacement.tunnel.listen(f.tunnelPort, '127.0.0.1')
  await Promise.all([once(replacement.front, 'listening'), once(replacement.tunnel, 'listening')]); f.replaceBroker(replacement)
  await until(() => replacement.stats().filter(s => s.online && s.pooled >= 2).length === 2)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 429)
  now += 1000
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
  assert.equal(replacement.quota.view(a.issued.grant.id).day, '2026-10-17')
})

test('relay gateway settings: single-file enrollment, admin boundary, restart recovery and disable', async t => {
  const f = await fixture(t, 0), home = path.join(f.root, 'isolated-home')
  fs.mkdirSync(home)
  const gatewayCopy = path.join(home, 'gateway.cjs')
  fs.copyFileSync(path.join(__dirname, '../gateway.js'), gatewayCopy)
  const reservation = http.createServer(); const gatewayPort = await listen(reservation); await close(reservation)
  const origin = `https://localhost:${f.port}`, base = `http://127.0.0.1:${gatewayPort}`
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_RELAY_ORIGIN: origin, DSH_REMOTE_RELAY_CA_FILE: path.join(__dirname, 'fixtures/relay-test-cert.pem'),
    PORT: String(gatewayPort), HOST: '127.0.0.1', TOKEN: 'relay-settings-admin-test', DSH_UPSTREAM: 'http://127.0.0.1:1',
    DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', UPDATE_CHECK_URL: 'http://127.0.0.1:1', DSH_REMOTE_ANNOUNCEMENTS_URL: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }
  // Do not inherit real profile/file overrides from the invoking shell.
  for (const name of ['TOKEN_FILE','DSH_REMOTE_DEVICE_KEYS','DSH_REMOTE_RELAY_STATE','DSH_REMOTE_NOTES','DSH_REMOTE_WORKBENCH','DSH_REMOTE_CRASH_LOG_FILE','DSH_REMOTE_DSH_COOKIE_FILE']) delete env[name]
  let child
  const start = async () => {
    child = spawn(process.execPath, [gatewayCopy], { env, cwd: home, stdio: 'ignore' })
    await until(async () => { try { return (await fetch(base+'/health')).ok } catch { return false } })
  }
  const stop = async () => { if (child && child.exitCode===null) { const done=once(child,'exit');child.kill();await done } }
  f.cleanupTasks.push(stop)
  const api = async (route, payload, token=env.TOKEN) => {
    const res = await fetch(base+route,{method:payload===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})})
    return { status:res.status, body:await res.json() }
  }
  await start()
  assert.equal((await api('/relay',undefined,'invalid')).status,401)
  assert.equal((await api('/relay',{action:'enroll',key:'invalid',server:'http://169.254.169.254'})).status,400)
  const initial = await api('/relay'); assert.equal(initial.body.canManage,true);assert.equal(initial.body.configured,false)
  const issued = f.registry.issue({domain:'alpha.relay.test',expiresAt:Date.now()+60000})
  const activated = await api('/relay',{action:'enroll',key:issued.code})
  assert.equal(activated.status,200,JSON.stringify(activated.body));assert.equal(activated.body.enabled,true)
  await until(()=>f.broker.stats().some(s=>s.online&&s.pooled>=2))
  const publicStatus = await request(f.port,'alpha.relay.test','/relay',{token:env.TOKEN})
  assert.equal(JSON.parse(publicStatus.body).configured,true)
  const local = await api('/relay')
  assert.equal(local.body.daily.limitBytes,DAILY_BYTES)
  assert.ok(!JSON.stringify(local).includes(issued.code))
  assert.ok(!JSON.stringify(local).includes('PRIVATE KEY'))
  const localState = path.join(home,'.dsh-remote/relay-pilot/integrated/connection.json')
  assert.ok(!fs.readFileSync(localState,'utf8').includes(issued.code))
  const device = await api('/admin/api/device-keys/create',{note:'isolated device'})
  const deviceToken = device.body.entry?.token
  assert.ok(deviceToken,'fixture created a device key')
  assert.equal((await api('/admin/api/device-keys/mode',{enabled:true})).status,200)
  const deviceRead = await api('/relay',undefined,deviceToken)
  assert.equal(deviceRead.status,200);assert.equal(deviceRead.body.canManage,false)
  assert.equal((await api('/relay',{action:'disable'},deviceToken)).status,403)
  await stop();await until(()=>f.broker.stats().every(s=>!s.online));await start()
  await until(()=>f.broker.stats().some(s=>s.online&&s.pooled>=2))
  assert.equal((await api('/relay')).body.configured,true)
  assert.equal((await api('/admin/api/relay',{action:'disable'})).body.enabled,false)
  await until(()=>f.broker.stats().every(s=>!s.online))
  assert.equal((await request(f.port,'alpha.relay.test','/health')).status,503)
})

test('relay quota also meters WS frames without HTTP body traffic', async t => {
  const f = await fixture(t,1,{quotaOptions:{limit:2048,block:64}}), a=f.hosts[0]
  const ws=await websocket(f.port,a), closed=new Promise(resolve=>ws.socket.once('close',resolve))
  const before=f.broker.quota.view(a.issued.grant.id).usedBytes
  const mask=Buffer.from([1,2,3,4]),payload=Buffer.alloc(120,7)
  const frame=Buffer.concat([Buffer.from([0x89,0x80|120]),mask,Buffer.from(payload.map((v,i)=>v^mask[i%4]))])
  for(let i=0;i<30&&!ws.socket.destroyed;i++){ws.socket.write(frame);await pause(10)}
  await closed
  assert.ok(before>0,'upgrade headers were metered')
  assert.equal(f.broker.quota.view(a.issued.grant.id).remainingBytes,0)
  assert.equal((await request(f.port,a.domain,'/private',{token:a.token})).status,429)
})

test('relay settings takes over the prior CLI trial with the same key and stops only that client', async t => {
  const f=await fixture(t,0),root=path.join(f.root,'private-relay'),legacy=path.join(root,'owner-preview')
  fs.mkdirSync(legacy,{recursive:true})
  const pair=keys(),issued=f.registry.issue({domain:'alpha.relay.test',expiresAt:Date.now()+60000})
  const config=f.registry.enroll(issued.code,pair.publicKey)
  fs.writeFileSync(path.join(legacy,'host-private.pem'),pair.privateKey,{mode:0o600})
  fs.writeFileSync(path.join(legacy,'connection.json'),JSON.stringify({...config,gateway:'http://127.0.0.1:1'}))
  const env={...process.env,HOME:f.root,USERPROFILE:f.root,DSH_REMOTE_FS_ROOT:f.root,TOKEN:'migration-test-token',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'}
  const child=spawn(process.execPath,[path.join(__dirname,'../relay/client.cjs'),'run','--state',legacy,'--ca',path.join(__dirname,'fixtures/relay-test-cert.pem')],{env,cwd:path.join(__dirname,'..'),stdio:'ignore'})
  const manager=new RelayHost({root:path.join(root,'integrated'),gateway:'http://127.0.0.1:1',origin:`https://localhost:${f.port}`,ca:cert})
  f.cleanupTasks.push(async()=>{manager.stop();if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done}})
  await until(()=>f.broker.stats().some(s=>s.online))
  assert.equal(manager.status().legacyAvailable,true)
  fs.mkdirSync(path.join(root,'integrated'))
  const unusedKey=keys().privateKey
  fs.writeFileSync(path.join(root,'integrated/host-private.pem'),unusedKey,{mode:0o600})
  const exited=once(child,'exit')
  await manager.change('import')
  assert.equal((await exited)[0],0)
  await until(()=>manager.phase==='online')
  assert.equal(manager.status().publicUrl,config.publicUrl)
  assert.equal(fs.readFileSync(path.join(root,'integrated/host-private.pem'),'utf8'),pair.privateKey)
  const saved=fs.readdirSync(path.join(root,'integrated')).find(name=>name.startsWith('host-private.pem.before-import-'))
  assert.equal(fs.readFileSync(path.join(root,'integrated',saved),'utf8'),unusedKey)
  assert.equal(f.registry.get(issued.grant.id).publicKey,pair.publicKey)
  await assert.rejects(manager.change('import'),/HOST_ALREADY_CONFIGURED/)
})
