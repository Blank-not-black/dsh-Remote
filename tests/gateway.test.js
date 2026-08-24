'use strict'

/**
 * DSH Remote 网关黑盒集成测试
 *
 * 启动方式：child_process.spawn 启动 node gateway.js，环境变量全部指向临时目录：
 *   - TOKEN=test-token：不会读/写真实 ~/.dsh-remote/token
 *   - HOME/USERPROFILE=临时目录：StatsStore、notes 等默认路径都落在临时目录
 *   - DSH_REMOTE_FS_ROOT=临时目录：工作台绑定根校验只操作临时目录
 *   - UPDATE_CHECK_URL 指向本机不可达端口：不触发外网请求
 *
 * 只覆盖网关本地处理的路由（鉴权、静态文件、update.json、工作台、/transcribe），
 * 不触发真实 DSH 上游代理。
 *
 * 说明：文件传输（/fs/*）已从网关移除，本文件不再覆盖 /fs 端点。
 */

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { once } = require('node:events')

const ROOT = path.join(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const TOKEN = 'test-token'

let base = ''
let child = null
let tmpRoot = ''
let port = 0
let fakeUpstream = null
let fakeUpstreamPort = 0
const fakeSockets = new Set()
let fakeUpgradeCount = 0
let fakeAnnouncementsStatus = 200
let fakeFeedbackPayload = null
let fakeAnnouncements = {
  items: [{
    id: 'central-initial',
    title: '中央公告',
    content: 'initial',
    poll: {
      id: 'central-poll',
      question: '选择？',
      options: [
        { id: 'one', label: '选项一' },
        { id: 'two', label: '选项二' },
      ],
    },
  }],
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const MUX_EVENTS = [
  { rpcId: 'm1', payload: { type: 'approval/requested', approvalId: 'a1', toolName: 'bash', reason: 'test' } },
  { rpcId: 'm2', payload: { type: 'session/event', sessionId: 's1', event: { type: 'agent/status', seq: 1, data: { running: true } } } },
  { rpcId: 'm3', payload: { type: 'session/projection', sessionId: 's1', key: 'title', value: 'poll test', seq: 2 } }
]
const HOST_EVENT = { rpcId: 'h1', payload: { type: 'host/session-status', sessionId: 's1', running: true } }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address()
      srv.close(() => resolve(p))
    })
  })
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key || '') + WS_GUID).digest('base64')
}

function encodeWsText(str) {
  const payload = Buffer.from(str)
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

function encodeWsControl(opcode, payload, masked) {
  const body = Buffer.from(payload || '')
  assert.ok(body.length <= 125)
  if (!masked) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
  const mask = crypto.randomBytes(4)
  const out = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i++) out[i] = body[i] ^ mask[i % 4]
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, out])
}

function attachWsAutoPong(socket, outgoingMasked) {
  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 2) {
      const first = pending[0]
      const second = pending[1]
      let offset = 2
      let length = second & 0x7f
      if (length === 126) {
        if (pending.length < 4) return
        length = pending.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (pending.length < 10) return
        const big = pending.readBigUInt64BE(2)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return
        length = Number(big)
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      if (masked) offset += 4
      const frameLength = offset + length
      if (pending.length < frameLength) return
      let payload = pending.subarray(offset, frameLength)
      if (masked) {
        const mask = pending.subarray(offset - 4, offset)
        const decoded = Buffer.alloc(length)
        for (let i = 0; i < length; i++) decoded[i] = payload[i] ^ mask[i % 4]
        payload = decoded
      }
      pending = pending.subarray(frameLength)
      if ((first & 0x0f) === 0x9 && !socket.destroyed) {
        socket.write(encodeWsControl(0xA, payload, outgoingMasked))
      } else if ((first & 0x0f) === 0x8) {
        try { socket.end() } catch {}
      }
    }
  })
}

function startFakeUpstream(listenPort = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/announcements.json')) {
        const body = JSON.stringify(fakeAnnouncements)
        res.writeHead(fakeAnnouncementsStatus, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          etag: `"central-${Buffer.byteLength(body)}"`,
        })
        res.end(body)
        return
      }
      if (req.url === '/submit' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          fakeFeedbackPayload = JSON.parse(raw || '{}')
          const body = JSON.stringify({ ok: true })
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
          res.end(body)
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.on('upgrade', (req, socket) => {
      fakeUpgradeCount++
      fakeSockets.add(socket)
      socket.on('close', () => fakeSockets.delete(socket))
      socket.on('error', () => {})
      if (req.url.includes('reject')) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const accept = wsAccept(req.headers['sec-websocket-key'])
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      )
      // fake 上游作为 WebSocket 服务端，回应网关发来的 masked Ping。
      attachWsAutoPong(socket, false)
      const kind = req.url.includes('events.mux') ? 'mux' : req.url.includes('events.host') ? 'host' : null
      if (kind === 'mux') {
        for (const ev of MUX_EVENTS) socket.write(encodeWsText(JSON.stringify(ev)))
      } else if (kind === 'host') {
        socket.write(encodeWsText(JSON.stringify(HOST_EVENT)))
      }
    })
    server.listen(listenPort, '127.0.0.1', () => {
      fakeUpstreamPort = server.address().port
      fakeUpstream = server
      resolve(server)
    })
    server.on('error', reject)
  })
}

async function stopFakeUpstream() {
  for (const s of fakeSockets) { try { s.destroy() } catch {} }
  fakeSockets.clear()
  if (fakeUpstream) {
    await new Promise((resolve) => fakeUpstream.close(() => resolve()))
    fakeUpstream = null
  }
}

async function waitForHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('gateway did not become healthy: ' + (lastErr?.message || lastErr))
}

async function stopChild() {
  if (!child) return
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit').then(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
  }
  child = null
}

function startChild() {
  child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      PORT: String(port),
      HOST: '127.0.0.1',
      DSH_UPSTREAM: `http://127.0.0.1:${fakeUpstreamPort}`,
      TOKEN,
      TOKEN_FILE: path.join(tmpRoot, 'token'),
      DSH_REMOTE_FS_ROOT: tmpRoot,
      DSH_REMOTE_NOTES: path.join(tmpRoot, 'notes.json'),
      DSH_REMOTE_DSH_SERVICE: 'invalid service',
      DSH_REMOTE_ANNOUNCEMENTS_URL: `http://127.0.0.1:${fakeUpstreamPort}/announcements.json`,
      DSH_REMOTE_ANNOUNCEMENTS_CACHE_MS: '100',
      DSH_REMOTE_FEEDBACK_URL: `http://127.0.0.1:${fakeUpstreamPort}/submit`,
      GATEWAY_WS_UPGRADE_TIMEOUT_MS: '1000',
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      // 清空代理，保证更新检查即使被触发也只连本机不可达端口
      UPDATE_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
}

async function waitForCollectors(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) {
        last = await res.json()
        if (predicate(last.events)) return last
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('collector state did not converge: ' + JSON.stringify(last))
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-gateway-test-'))
  fs.mkdirSync(path.join(tmpRoot, 'sub'), { recursive: true })

  await startFakeUpstream()
  port = await getFreePort()
  base = `http://127.0.0.1:${port}`

  startChild()

  await waitForHealth(base)
})

after(async () => {
  await stopChild()
  await stopFakeUpstream()
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = ''
  }
})

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

function fsUrl(sub, params = {}) {
  const qs = new URLSearchParams(params).toString()
  return `${base}${sub}${qs ? '?' + qs : ''}`
}

async function waitForPollEvents(kind, minCount = 1, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const res = await fetch(fsUrl('/api/events.poll', { kind, since: 0 }), { headers: authHeaders() })
    if (res.ok) {
      const data = await res.json()
      last = data
      if (data.events.length >= minCount) return data
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for poll events (${kind}); last=${JSON.stringify(last)}`)
}

test('鉴权：无 token / 错误 token 拒绝，正确 token 通过', async () => {
  const noToken = await fetch(`${base}/workbench`)
  assert.equal(noToken.status, 401)

  const wrongToken = await fetch(`${base}/workbench`, {
    headers: { authorization: 'Bearer wrong-token' }
  })
  assert.equal(wrongToken.status, 401)

  const ok = await fetch(`${base}/workbench`, { headers: authHeaders() })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.bound, false)
})

test('静态文件与 update.json：根页面、version.json、update.json 可访问', async () => {
  const idx = await fetch(`${base}/`)
  assert.equal(idx.status, 200)
  assert.match(await idx.text(), /DSH Remote/)

  const verRes = await fetch(`${base}/version.json`)
  assert.equal(verRes.status, 200)
  const ver = await verRes.json()
  assert.equal(typeof ver.version, 'string')

  const rawUpdate = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'update.json'), 'utf8'))
  const noLocal = await fetch(`${base}/update.json`)
  assert.equal(noLocal.status, 200)
  const noLocalBody = await noLocal.json()
  assert.equal(noLocalBody.version, String(rawUpdate.version).replace(/-.*$/, ''))
  assert.equal(noLocalBody.notes, rawUpdate.notes)

  const withLocal = await fetch(`${base}/update.json?local=1`)
  assert.equal(withLocal.status, 200)
  const withLocalBody = await withLocal.json()
  assert.equal(withLocalBody.version, rawUpdate.version)
})

test('中央公告：定时刷新、失败时使用上次成功缓存、投票按中央选项校验', async () => {
  let res = await fetch(`${base}/announcements.json`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-dsh-announcements-source'), 'central')
  assert.equal((await res.json()).items[0].id, 'central-initial')

  fakeAnnouncements = {
    items: [{
      id: 'central-updated',
      title: '中央公告已更新',
      content: 'updated',
      poll: {
        id: 'central-poll-updated',
        question: '下一步？',
        options: [
          { id: 'stability', label: '稳定性' },
          { id: 'files', label: '文件能力' },
        ],
      },
    }],
  }
  await new Promise(resolve => setTimeout(resolve, 130))
  res = await fetch(`${base}/announcements.json`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).items[0].id, 'central-updated')

  fakeFeedbackPayload = null
  res = await fetch(`${base}/feedback`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      type: 'poll',
      message: 'ignored',
      announcementId: 'central-updated',
      pollId: 'central-poll-updated',
      optionId: 'files',
    }),
  })
  assert.equal(res.status, 200)
  assert.equal(fakeFeedbackPayload.announcementId, 'central-updated')
  assert.equal(fakeFeedbackPayload.optionLabel, '文件能力')

  fakeAnnouncementsStatus = 503
  await new Promise(resolve => setTimeout(resolve, 130))
  res = await fetch(`${base}/announcements.json`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-dsh-announcements-source'), 'central')
  assert.match(res.headers.get('warning') || '', /stale/i)
  assert.equal((await res.json()).items[0].id, 'central-updated')
  fakeAnnouncementsStatus = 200
})

test('静态文件：Last-Modified 支持 If-Modified-Since 重新校验', async () => {
  const first = await fetch(`${base}/app.js`)
  assert.equal(first.status, 200)
  const lastModified = first.headers.get('last-modified')
  assert.ok(lastModified)
  const second = await fetch(`${base}/app.js`, { headers: { 'if-modified-since': lastModified } })
  assert.equal(second.status, 304)
  assert.equal(await second.text(), '')
})

test('工作台：鉴权、绑定根目录校验、持久化与解绑', async () => {
  const noToken = await fetch(`${base}/workbench`)
  assert.equal(noToken.status, 401)

  const initial = await fetch(`${base}/workbench`, { headers: authHeaders() })
  assert.equal(initial.status, 200)
  assert.deepEqual(await initial.json(), { bound: false, path: null, title: null })

  let res = await fetch(`${base}/workbench/bind`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: 'relative/path' })
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'bad-path')

  res = await fetch(`${base}/workbench/bind`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: path.dirname(tmpRoot) })
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'outside-roots')

  const boundPath = path.join(tmpRoot, 'sub')
  res = await fetch(`${base}/workbench/bind`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: boundPath })
  })
  assert.equal(res.status, 200)
  const bound = await res.json()
  assert.equal(bound.bound, true)
  assert.equal(bound.path, fs.realpathSync(boundPath))
  assert.equal(bound.title, 'sub')

  const persisted = await fetch(`${base}/workbench`, { headers: authHeaders() })
  assert.equal(persisted.status, 200)
  assert.deepEqual(await persisted.json(), bound)

  res = await fetch(`${base}/workbench/unbind`, {
    method: 'POST', headers: authHeaders()
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { bound: false })
})

test('远程 DSH 控制接口：鉴权与动作校验', async () => {
  const preflight = await fetch(`${base}/admin/api/dsh`, {
    method: 'OPTIONS',
    headers: {
      origin: 'capacitor://localhost',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'
    }
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'capacitor://localhost')

  const deniedOrigin = await fetch(`${base}/workbench`, {
    headers: authHeaders({ origin: 'https://evil.example' })
  })
  assert.equal(deniedOrigin.status, 200)
  assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), null)

  const noToken = await fetch(`${base}/admin/api/dsh`)
  assert.equal(noToken.status, 401)

  const bad = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ action: 'shell' })
  })
  assert.equal(bad.status, 400)
  const body = await bad.json()
  assert.match(body.error, /start|restart/)

  const valid = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ action: 'start' })
  })
  assert.equal(valid.status, 202)
  const accepted = await valid.json()
  assert.equal(accepted.accepted, true)
  let validBody = accepted
  for (let i = 0; i < 20 && !validBody.done; i++) {
    await new Promise(resolve => setTimeout(resolve, 25))
    const progress = await fetch(`${base}/admin/api/dsh?operation=${encodeURIComponent(accepted.operationId)}`, { headers: authHeaders() })
    assert.equal(progress.status, 200)
    validBody = await progress.json()
  }
  assert.equal(validBody.done, true)
  assert.equal(validBody.code, 'INVALID_SERVICE')
  assert.equal(validBody.stage, 'failed')
})

test('事件轮询：鉴权 401', async () => {
  const noToken = await fetch(fsUrl('/api/events.poll', { kind: 'mux', since: 0 }))
  assert.equal(noToken.status, 401)

  const wrongToken = await fetch(fsUrl('/api/events.poll', { kind: 'mux', since: 0 }), {
    headers: { authorization: 'Bearer wrong-token' }
  })
  assert.equal(wrongToken.status, 401)
})

test('事件轮询：增量语义 + seq 单调 + mux/host 都有缓冲', async () => {
  const all = await waitForPollEvents('mux', 1)
  assert.ok(all.events.length >= 1)
  const seqs = all.events.map((e) => e.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.ok(seqs.every((s) => Number.isSafeInteger(s) && s > 0))
  assert.equal(all.latestSeq, seqs[seqs.length - 1])

  // since=最新 -> 空
  const emptyRes = await fetch(fsUrl('/api/events.poll', { kind: 'mux', since: all.latestSeq }), {
    headers: authHeaders()
  })
  assert.equal(emptyRes.status, 200)
  const empty = await emptyRes.json()
  assert.deepEqual(empty.events, [])

  // since=第一个 seq -> 只返回后面的增量
  const incRes = await fetch(fsUrl('/api/events.poll', { kind: 'mux', since: seqs[0] }), {
    headers: authHeaders()
  })
  assert.equal(incRes.status, 200)
  const inc = await incRes.json()
  assert.ok(inc.events.length >= 1)
  assert.ok(inc.events.every((e) => e.seq > seqs[0]))

  // host 流也有独立缓冲
  const host = await waitForPollEvents('host', 1)
  assert.ok(host.events.length >= 1)
  assert.ok(host.events.every((e) => e.seq > 0))
})

test('事件轮询：坏参数 400', async () => {
  const badKind = await fetch(fsUrl('/api/events.poll', { kind: 'xxx', since: 0 }), {
    headers: authHeaders()
  })
  assert.equal(badKind.status, 400)

  const badSince = await fetch(fsUrl('/api/events.poll', { kind: 'mux', since: 'abc' }), {
    headers: authHeaders()
  })
  assert.equal(badSince.status, 400)
})

test('WebSocket 透传：idle 超时销毁死连接', async () => {
  const idlePort = await getFreePort()
  const idleChild = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      PORT: String(idlePort),
      HOST: '127.0.0.1',
      DSH_UPSTREAM: `http://127.0.0.1:${fakeUpstreamPort}`,
      TOKEN,
      TOKEN_FILE: path.join(tmpRoot, 'token'),
      DSH_REMOTE_FS_ROOT: tmpRoot,
      DSH_REMOTE_NOTES: path.join(tmpRoot, 'notes.json'),
      DSH_REMOTE_ANNOUNCEMENTS_URL: '',
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      UPDATE_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*',
      GATEWAY_WS_PING_MS: '0',
      GATEWAY_WS_IDLE_MS: '300'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  idleChild.stdout.on('data', () => {})
  idleChild.stderr.on('data', () => {})
  try {
    await waitForHealth(`http://127.0.0.1:${idlePort}`, 10000)
    const closed = await new Promise((resolve) => {
      const sock = net.connect(idlePort, '127.0.0.1')
      let buf = ''
      let upgraded = false
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        sock.destroy()
        resolve(ok)
      }
      sock.setTimeout(5000)
      sock.on('timeout', () => finish(false))
      sock.on('error', () => finish(false))
      sock.on('close', () => finish(upgraded))
      sock.on('data', (d) => {
        buf += d.toString('binary')
        if (!upgraded && buf.includes('101 Switching Protocols')) upgraded = true
      })
      sock.write(
        `GET /api/events.mux?token=${TOKEN} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      )
    })
    assert.equal(closed, true, 'idle WS 应被网关自动销毁')
  } finally {
    if (idleChild.exitCode === null) idleChild.kill('SIGTERM')
    await Promise.race([
      once(idleChild, 'exit').then(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
  }
})

test('WebSocket 透传：VPN 友好的 Ping/Pong 使静默连接保持在线', async (t) => {
  if (typeof WebSocket !== 'function') {
    t.skip('当前 Node 没有内置 WebSocket')
    return
  }
  const heartbeatPort = await getFreePort()
  const heartbeatChild = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tmpRoot,
      USERPROFILE: tmpRoot,
      PORT: String(heartbeatPort),
      HOST: '127.0.0.1',
      DSH_UPSTREAM: `http://127.0.0.1:${fakeUpstreamPort}`,
      TOKEN,
      TOKEN_FILE: path.join(tmpRoot, 'token'),
      DSH_REMOTE_FS_ROOT: tmpRoot,
      DSH_REMOTE_NOTES: path.join(tmpRoot, 'notes.json'),
      DSH_REMOTE_ANNOUNCEMENTS_URL: '',
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      UPDATE_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*',
      GATEWAY_WS_PING_MS: '100',
      GATEWAY_WS_PONG_TIMEOUT_MS: '500',
      GATEWAY_WS_IDLE_MS: '600'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  heartbeatChild.stdout.on('data', () => {})
  heartbeatChild.stderr.on('data', () => {})
  let ws = null
  const messages = []
  try {
    await waitForHealth(`http://127.0.0.1:${heartbeatPort}`, 10000)
    const upstreamBefore = fakeUpgradeCount
    const ticketRes = await fetch(`http://127.0.0.1:${heartbeatPort}/api/ws-ticket`, {
      method: 'POST',
      headers: authHeaders({ 'x-dsh-remote-client': 'web' })
    })
    assert.equal(ticketRes.status, 200)
    const ticket = (await ticketRes.json()).ticket
    assert.ok(ticket)
    ws = new WebSocket(`ws://127.0.0.1:${heartbeatPort}/api/events.mux?ticket=${encodeURIComponent(ticket)}`)
    ws.addEventListener('message', (event) => messages.push(String(event.data)))
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(ws.readyState, WebSocket.OPEN, '静默但有 Pong 的连接不应被 idle 清理')
    assert.equal(fakeUpgradeCount, upstreamBefore, '客户端 WebSocket 不应再为每个设备创建独立上游连接')
    assert.ok(messages.some((data) => data.includes('approval/requested')), '新客户端应收到 collector 重放的待处理请求')
  } finally {
    try { ws?.close() } catch {}
    if (heartbeatChild.exitCode === null) heartbeatChild.kill('SIGTERM')
    await Promise.race([
      once(heartbeatChild, 'exit').then(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
  }
})

test('WebSocket 升级失败：上游非 101 时及时返回错误而不是挂起', async () => {
  const sock = net.connect(port, '127.0.0.1')
  let buf = ''
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade rejection timed out')), 3000)
      sock.on('data', (chunk) => {
        buf += chunk.toString()
        if (buf.includes('\r\n\r\n')) {
          clearTimeout(timer)
          resolve(buf)
        }
      })
      sock.on('error', reject)
      sock.write(
        `GET /api/reject?token=${TOKEN} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      )
    })
    assert.match(String(response), /^HTTP\/1\.1 401 Unauthorized/)
  } finally {
    sock.destroy()
  }
})

test('事件轮询：upstream 不可达时接口仍可用（纯内存读）', async () => {
  await stopFakeUpstream()
  const res = await fetch(fsUrl('/api/events.poll', { kind: 'mux', since: 0 }), {
    headers: authHeaders()
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.events))
})

test('事件采集：启动时 upstream 不可达，恢复后自动重连', async () => {
  const unavailablePort = fakeUpstreamPort
  await stopChild()
  await stopFakeUpstream()
  startChild()
  await waitForHealth(base)

  const failed = await waitForCollectors((events) =>
    events.mux.lastError || events.host.lastError
  )
  assert.equal(failed.events.mux.connected, false)
  assert.equal(failed.events.host.connected, false)

  await startFakeUpstream(unavailablePort)
  const recovered = await waitForCollectors((events) =>
    events.mux.connected && events.host.connected
  )
  assert.ok(recovered.events.mux.reconnects >= 1)
  assert.ok(recovered.events.host.reconnects >= 1)
})

test('中央公告首次不可达时回退内置公告', async () => {
  fakeAnnouncementsStatus = 503
  await stopChild()
  startChild()
  await waitForHealth(base)
  const res = await fetch(`${base}/announcements.json`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('x-dsh-announcements-source'), 'local')
  const body = await res.json()
  assert.ok(body.items.some(item => item.id === '2026-08-23-feedback-polls'))
  fakeAnnouncementsStatus = 200
})

test('转写代理：鉴权、配置校验、test 模式与 SSE 流式透传', async () => {
  // 存根 provider：记录收到的鉴权头/请求体，返回 OpenAI 兼容响应
  const seen = { auth: null, modelsAuth: null, streamFlag: null, body: null }
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      seen.modelsAuth = req.headers.authorization || null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'x' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/chat/completions') {
      seen.auth = req.headers.authorization || null
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        seen.body = JSON.parse(b)
        seen.streamFlag = seen.body.stream
        if (seen.body.model === 'fail-model') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'bad key', code: 401 } }))
          return
        }
        if (seen.body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: {"choices":[{"delta":{"content":"整理"}}]}\n\n')
          res.write('data: {"choices":[{"delta":{"content":"结果"}}]}\n\n')
          res.end('data: [DONE]\n\n')
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'non-stream' } }] }))
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const providerPort = await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(provider.address().port)))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-transcribe-test-'))
  const port = await getFreePort()
  const tbase = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PORT: String(port),
      HOST: '127.0.0.1',
      DSH_UPSTREAM: 'http://127.0.0.1:1', // 不可达上游: 只测网关本地 /transcribe
      TOKEN,
      TOKEN_FILE: path.join(root, 'token'),
      DSH_REMOTE_FS_ROOT: root,
      DSH_REMOTE_NOTES: path.join(root, 'notes.json'),
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      UPDATE_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  const hdrs = { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }
  const payload = (over) => Object.assign({
    base: `http://127.0.0.1:${providerPort}`,
    model: 'gpt-x',
    key: 'sk-test',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '原文' }]
  }, over)
  try {
    await waitForHealth(tbase)

    // 无网关鉴权 → 401
    let res = await fetch(tbase + '/transcribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload({})) })
    assert.equal(res.status, 401)

    // CORS 预检: App(Capacitor http://localhost)等跨源环境 POST 前先发 OPTIONS,
    // 必须 204 放行, 否则浏览器拦截请求(用户侧"网络错误,请检查网络或API地址")
    res = await fetch(tbase + '/transcribe', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:8080',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      }
    })
    assert.equal(res.status, 204)
    assert.match(res.headers.get('access-control-allow-origin') || '', /localhost/)
    assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/)

    // base 非 http(s) → 400
    res = await fetch(tbase + '/transcribe', { method: 'POST', headers: hdrs, body: JSON.stringify(payload({ base: 'file:///etc/passwd' })) })
    assert.equal(res.status, 400)

    // test 模式: {ok:true, ms} 且 provider 收到 Bearer key
    res = await fetch(tbase + '/transcribe', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ test: true, base: payload({}).base, model: 'gpt-x', key: 'sk-test' })
    })
    assert.equal(res.status, 200)
    const testData = await res.json()
    assert.equal(testData.ok, true)
    assert.ok(Number.isInteger(testData.ms) && testData.ms >= 0)
    assert.equal(seen.modelsAuth, 'Bearer sk-test')

    // 连接测试回退: 不实现 GET /models 的兼容服务, 回退到最小 chat 探测
    const provider2 = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/models') { res.writeHead(404); res.end(); return }
      if (req.method === 'POST' && req.url === '/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
        return
      }
      res.writeHead(404); res.end()
    })
    const provider2Port = await new Promise((resolve) => provider2.listen(0, '127.0.0.1', () => resolve(provider2.address().port)))
    res = await fetch(tbase + '/transcribe', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ test: true, base: `http://127.0.0.1:${provider2Port}`, model: 'gpt-x', key: 'sk-test' })
    })
    assert.equal(res.status, 200)
    const fallback = await res.json()
    assert.equal(fallback.ok, true, '不实现 /models 的服务应回退到 chat 探测成功: ' + JSON.stringify(fallback))
    assert.equal(fallback.via, 'chat')

    // 模型服务完全不可达 → ok:false error:'network'
    res = await fetch(tbase + '/transcribe', {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ test: true, base: 'http://127.0.0.1:1', model: 'gpt-x', key: 'sk-test' })
    })
    assert.equal(res.status, 200)
    const netFail = await res.json()
    assert.equal(netFail.ok, false)
    assert.equal(netFail.error, 'network')
    provider2.closeAllConnections?.()
    await new Promise((resolve) => provider2.close(resolve))

    // 流式代理: SSE 透传 delta 与 [DONE], provider 收到 stream:true 与原文
    res = await fetch(tbase + '/transcribe', { method: 'POST', headers: hdrs, body: JSON.stringify(payload({})) })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
    const body = await res.text()
    assert.match(body, /整理/)
    assert.match(body, /结果/)
    assert.match(body, /\[DONE\]/)
    assert.equal(seen.streamFlag, true)
    assert.equal(seen.auth, 'Bearer sk-test')
    assert.equal(seen.body.messages[1].content, '原文')

    // provider 401 → 网关透传状态码与错误文本
    res = await fetch(tbase + '/transcribe', { method: 'POST', headers: hdrs, body: JSON.stringify(payload({ model: 'fail-model' })) })
    assert.equal(res.status, 401)
    assert.match(String((await res.json()).msg), /bad key/)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit').then(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
    provider.closeAllConnections?.()
    await new Promise((resolve) => provider.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('转写代理: 慢速分块 SSE 实时透传(首块先到, 不等全部完成)', async () => {
  // provider 每 180ms 发一块, 共 5 块(总时长约 900ms);
  // 若网关缓冲整流, 客户端要等 ~900ms 才拿到第一块; 流式则 ~180ms 即到。
  const provider = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const parts = ['块一', '块二', '块三', '块四', '块五']
      let i = 0
      const timer = setInterval(() => {
        if (i < parts.length) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i] } }] }) + '\n\n')
          i++
        } else { clearInterval(timer); res.end('data: [DONE]\n\n') }
      }, 180)
      return
    }
    res.writeHead(404); res.end()
  })
  const providerPort = await new Promise((resolve) => provider.listen(0, '127.0.0.1', () => resolve(provider.address().port)))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-transcribe-stream-'))
  const port = await getFreePort()
  const tbase = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: root, USERPROFILE: root,
      PORT: String(port), HOST: '127.0.0.1',
      DSH_UPSTREAM: 'http://127.0.0.1:1',
      TOKEN, TOKEN_FILE: path.join(root, 'token'),
      DSH_REMOTE_FS_ROOT: root,
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  try {
    await waitForHealth(tbase)
    const t0 = Date.now()
    const res = await fetch(tbase + '/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({
        base: `http://127.0.0.1:${providerPort}`, model: 'gpt-x', key: 'sk-test',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '原文' }]
      })
    })
    assert.equal(res.status, 200)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read() // 阻塞到第一块网络数据到达
    const firstAt = Date.now() - t0
    let body = decoder.decode(first.value, { stream: true })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
    }
    const total = Date.now() - t0
    // 首块必须在全部完成前显著到达: 总时长约 900ms, 首块应 < 600ms(留余量)
    assert.ok(firstAt < Math.min(600, total - 150), `首块应流式先到(首块=${firstAt}ms, 总=${total}ms)`)
    assert.ok(total >= 700, `慢速 provider 总时长应约 900ms(实际=${total}ms), 证明未被缓冲吞并`)
    assert.match(body, /块一/)
    assert.match(body, /块五/)
    assert.match(body, /\[DONE\]/)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit').then(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
    provider.closeAllConnections?.()
    await new Promise((resolve) => provider.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// 说明：版本比较函数 cmpVersion/parseVersion 位于 public/app.js（浏览器端），
// 不在 gateway.js 进程内；按任务约束不为它引入 vm/DOM 模拟，因此这里只覆盖
// 网关侧的 /update.json 版本兼容输出（rc 后缀剥离逻辑）。
