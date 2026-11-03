'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { createPairing, connectPinned } = require('../experiments/relay-e2ee/tls-channel.cjs')
const { basicPolicy } = require('../relay/basic-policy.cjs')

// All keys below are PUBLIC throwaway fixtures, never production credentials.
const fixtureFile = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const cert = fixtureFile('relay-test-cert.pem'), key = fixtureFile('relay-test-key.pem')
const otherCert = fixtureFile('e2ee-impostor-cert.pem'), otherKey = fixtureFile('e2ee-impostor-key.pem')
const pairing = createPairing(cert, 'localhost') // Simulates trusted local QR pairing.
const TOKEN = 'isolated-e2ee-fixture-access-token'
const PROMPT = 'private-fixture-prompt-that-the-cloud-must-not-see'

async function fixture(t, { minVersion = 'TLSv1.3', maxVersion = 'TLSv1.3', impostor = false } = {}) {
  const sockets = new Set(), servers = [], seen = [], trace = []
  let mutate = null, lastRequestCipher = null, responseDropAt = Infinity
  const track = socket => {
    sockets.add(socket); socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  })
  async function listen(server) {
    servers.push(server); server.on('connection', track)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return server.address().port
  }
  const host = https.createServer({ cert: impostor ? otherCert : cert, key: impostor ? otherKey : key,
    minVersion, maxVersion, handshakeTimeout: 1000, ALPNProtocols: ['http/1.1'] }, (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization })
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('unauthorized') }
    // Policy runs at the host, after decryption, never at the opaque relay.
    try { basicPolicy(req) } catch (error) { res.writeHead(error.status); return res.end(error.code) }
    if (req.url === '/api/events.poll') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"events":['); return setImmediate(() => res.end(JSON.stringify(PROMPT) + ']}'))
    }
    if (req.url === '/fs/file?path=image.png') {
      res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ body: Buffer.concat(chunks).toString(), owner: 'paired-host' }))
    })
  })
  host.on('upgrade', (req, socket) => {
    if (req.headers.authorization !== 'Bearer ' + TOKEN || req.url !== '/api/events.mux') return socket.destroy()
    seen.push({ path: req.url, authorization: req.headers.authorization })
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    const message = Buffer.from(PROMPT)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]))
  })
  const hostPort = await listen(host)
  // Represents the cloud's outer TLS termination, then an opaque tunnel. Unlike
  // the production broker, this fixture NEVER parses inner HTTP or sees its token.
  const cloud = https.createServer({ cert, key }, (_, res) => { res.writeHead(404); res.end() })
  cloud.on('upgrade', (req, client, head) => {
    if (req.url !== '/experimental/e2ee' || req.headers.authorization) return client.destroy()
    const upstream = net.connect(hostPort, '127.0.0.1'); track(upstream)
    const forward = chunk => {
      assert.ok(trace.reduce((n, b) => n + b.length, 0) + chunk.length < 1024 * 1024, 'bounded test trace')
      trace.push(Buffer.from(chunk))
      let value = chunk
      if (mutate) { const action = mutate; mutate = null; value = action(Buffer.from(chunk)); lastRequestCipher = Buffer.from(chunk) }
      if (value === null) { client.destroy(); upstream.destroy(); return }
      if (!upstream.write(value)) { client.pause(); upstream.once('drain', () => client.resume()) }
    }
    upstream.once('connect', () => {
      client.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-e2ee-prototype\r\n\r\n')
      if (head.length) forward(head)
      client.on('data', forward)
      upstream.on('data', chunk => {
        if (seen.length >= responseDropAt) { client.destroy(); upstream.destroy(); return }
        trace.push(Buffer.from(chunk))
        if (!client.write(chunk)) { upstream.pause(); client.once('drain', () => upstream.resume()) }
      })
    })
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy())
  })
  const cloudPort = await listen(cloud)
  async function transport() {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: cloudPort, ca: cert, agent: false,
        path: '/experimental/e2ee', headers: { connection: 'Upgrade', upgrade: 'dsh-e2ee-prototype' } })
      req.on('error', reject)
      req.on('response', res => { res.resume(); reject(Error('outer upgrade rejected')) })
      req.on('upgrade', (_, socket, head) => { track(socket); if (head.length) socket.unshift(head); resolve(socket) })
      req.end()
    })
  }
  async function connect(pair = pairing) { return connectPinned({ socket: await transport(), pairing: pair, timeoutMs: 2000 }) }
  return { seen, trace, connect, transport, setMutation: fn => { mutate = fn },
    dropNextResponse: () => { responseDropAt = seen.length + 1 }, getLastCipher: () => lastRequestCipher }
}

function request(channel, route, { token = TOKEN, data = '', upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => channel
    const req = http.request({ host: 'localhost', path: route, method: data ? 'POST' : 'GET', agent,
      headers: { authorization: 'Bearer ' + token, ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'sec-websocket-version': '13' } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }))
    req.on('error', reject); req.end(data)
  })
}

test('E2EE pairing rejects malformed records, fingerprint changes and hostname mismatch', () => {
  assert.throws(() => createPairing(cert, 'attacker.invalid'), { code: 'E2EE_HOSTNAME_MISMATCH' })
  assert.throws(() => createPairing(cert + cert, 'localhost'), { code: 'INVALID_E2EE_PAIRING' })
  assert.throws(() => createPairing('not a certificate', 'localhost'), { code: 'INVALID_E2EE_PAIRING' })
  assert.equal(Object.isFrozen(pairing), true)
})

test('E2EE real TLS-in-HTTPS hides HTTP tokens, paths, prompts, poll events and images from cloud', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const channel = await f.connect()
  assert.equal(channel.getProtocol(), 'TLSv1.3')
  const response = await request(channel, '/api/session.prompt', { data: PROMPT })
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).body, PROMPT)
  const poll = await request(await f.connect(), '/api/events.poll')
  assert.deepEqual(JSON.parse(poll.body).events, [PROMPT])
  const image = await request(await f.connect(), '/fs/file?path=image.png')
  assert.equal(image.body.toString('hex'), '89504e470d0a1a0a')
  const trace = Buffer.concat(f.trace)
  for (const secret of [TOKEN, PROMPT, '/api/session.prompt', '/api/events.poll', '/fs/file']) assert.equal(trace.includes(Buffer.from(secret)), false)
})

test('E2EE authenticated WebSocket handshake and downlink frame traverse the same encrypted tunnel', { timeout: 10000 }, async t => {
  const f = await fixture(t), channel = await f.connect()
  const response = await request(channel, '/api/events.mux', { upgrade: true })
  assert.equal(response.status, 101)
  const frame = response.head.length ? response.head : (await once(response.socket, 'data'))[0]
  assert.equal(frame[0], 0x81); assert.equal(frame.subarray(2).toString(), PROMPT)
  assert.equal(Buffer.concat(f.trace).includes(Buffer.from(PROMPT)), false)
  response.socket.destroy()
})

test('E2EE does not replace gateway authentication or host file policy', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  assert.equal((await request(await f.connect(), '/private', { token: 'wrong-fixture-token' })).status, 401)
  assert.equal((await request(await f.connect(), '/fs/download')).status, 403)
})

test('E2EE cloud certificate substitution fails before any application credential is sent', { timeout: 10000 }, async t => {
  const f = await fixture(t, { impostor: true })
  // The impostor certificate is signed by the trusted test CA and names
  // localhost. Normal CA + hostname checks pass; the exact leaf pin must fail.
  await assert.rejects(f.connect(), { code: 'E2EE_PIN_MISMATCH' })
  assert.equal(f.seen.length, 0)
  assert.equal(Buffer.concat(f.trace).includes(Buffer.from(TOKEN)), false)
})

test('E2EE modified trusted pairing is refused without starting TLS', { timeout: 10000 }, async t => {
  const f = await fixture(t), socket = await f.transport()
  await assert.rejects(connectPinned({ socket, pairing: { ...pairing, fingerprint: '0'.repeat(64) } }), { code: 'E2EE_PIN_MISMATCH' })
  assert.equal(socket.destroyed, true); assert.equal(f.seen.length, 0)
})

test('E2EE TLS 1.2 downgrade is rejected without plaintext fallback', { timeout: 10000 }, async t => {
  const f = await fixture(t, { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })
  await assert.rejects(f.connect()); assert.equal(f.seen.length, 0)
})

test('E2EE ciphertext tampering fails before host dispatch', { timeout: 10000 }, async t => {
  const f = await fixture(t), channel = await f.connect()
  f.setMutation(chunk => { chunk[chunk.length - 1] ^= 1; return chunk })
  await assert.rejects(request(channel, '/api/session.prompt', { data: PROMPT }))
  assert.equal(f.seen.length, 0)
})

test('E2EE repeated TLS application record cannot dispatch a write twice', { timeout: 10000 }, async t => {
  const f = await fixture(t), channel = await f.connect()
  f.setMutation(chunk => Buffer.concat([chunk, chunk]))
  await request(channel, '/api/session.prompt', { data: PROMPT }).catch(() => {})
  assert.equal(f.seen.length, 1)
})

test('E2EE reconnect derives fresh keys and rejects ciphertext from a previous connection', { timeout: 10000 }, async t => {
  const f = await fixture(t), first = await f.connect()
  const firstKey = first.exportKeyingMaterial(32, 'dsh-e2ee-prototype-test', Buffer.alloc(0))
  f.setMutation(chunk => chunk)
  assert.equal((await request(first, '/api/session.prompt', { data: PROMPT })).status, 200)
  const oldCipher = f.getLastCipher(), second = await f.connect()
  assert.notDeepEqual(second.exportKeyingMaterial(32, 'dsh-e2ee-prototype-test', Buffer.alloc(0)), firstKey)
  assert.equal(second.isSessionReused(), false)
  f.setMutation(() => oldCipher)
  await assert.rejects(request(second, '/api/session.prompt', { data: 'new-fixture-prompt' }))
  assert.equal(f.seen.length, 1) // No retry of either write.
})

test('E2EE cloud disconnect before dispatch does not retry a request', { timeout: 10000 }, async t => {
  const f = await fixture(t), channel = await f.connect()
  f.setMutation(() => null)
  await assert.rejects(request(channel, '/api/session.prompt', { data: PROMPT }))
  assert.equal(f.seen.length, 0)
})

test('E2EE lost response leaves the executed write uncertain and never resends it', { timeout: 10000 }, async t => {
  const f = await fixture(t), channel = await f.connect()
  f.dropNextResponse()
  await assert.rejects(request(channel, '/api/session.prompt', { data: PROMPT }))
  assert.equal(f.seen.length, 1)
})

test('E2EE stalled, closed and plaintext transports fail closed and are cleaned up', { timeout: 10000 }, async t => {
  const sockets = new Set(), server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('data', () => {})
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const socket = net.connect(server.address().port, '127.0.0.1')
  await assert.rejects(connectPinned({ socket, pairing, timeoutMs: 50 }), { code: 'E2EE_HANDSHAKE_TIMEOUT' })
  assert.equal(socket.destroyed, true)
  await assert.rejects(connectPinned({ socket, pairing }), { code: 'INVALID_E2EE_TRANSPORT' })
  server.removeAllListeners('connection')
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.end('HTTP/1.1 200 OK\r\n\r\nplaintext') })
  const plain = net.connect(server.address().port, '127.0.0.1')
  await assert.rejects(connectPinned({ socket: plain, pairing, timeoutMs: 1000 }))
  assert.equal(plain.destroyed, true)
})
