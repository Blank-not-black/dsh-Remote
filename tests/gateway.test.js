'use strict'

/**
 * DSH Remote 网关黑盒集成测试
 *
 * 启动方式：child_process.spawn 启动 node gateway.js，环境变量全部指向临时目录：
 *   - TOKEN=test-token：不会读/写真实 ~/.dsh-remote/token
 *   - HOME/USERPROFILE=临时目录：StatsStore、notes 等默认路径都落在临时目录
 *   - DSH_REMOTE_FS_ROOT=临时目录：/fs 测试只操作临时目录
 *   - UPDATE_CHECK_URL 指向本机不可达端口：不触发外网请求
 *
 * 只覆盖网关本地处理的路由（/fs/*、鉴权、静态文件、update.json），
 * 不触发真实 DSH 上游代理。
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
let secondaryRoot = ''
let port = 0
let fakeUpstream = null
let fakeUpstreamPort = 0
const fakeSockets = new Set()

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

function startFakeUpstream() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(404)
      res.end()
    })
    server.on('upgrade', (req, socket) => {
      fakeSockets.add(socket)
      socket.on('close', () => fakeSockets.delete(socket))
      socket.on('error', () => {})
      const accept = wsAccept(req.headers['sec-websocket-key'])
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      )
      const kind = req.url.includes('events.mux') ? 'mux' : req.url.includes('events.host') ? 'host' : null
      if (kind === 'mux') {
        for (const ev of MUX_EVENTS) socket.write(encodeWsText(JSON.stringify(ev)))
      } else if (kind === 'host') {
        socket.write(encodeWsText(JSON.stringify(HOST_EVENT)))
      }
    })
    server.listen(0, '127.0.0.1', () => {
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

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-gateway-test-'))
  secondaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-gateway-test-second-'))
  fs.mkdirSync(path.join(tmpRoot, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'hello.txt'), '0123456789ABCDEF')
  fs.writeFileSync(path.join(secondaryRoot, 'second-root.txt'), 'second root')

  await startFakeUpstream()
  port = await getFreePort()
  base = `http://127.0.0.1:${port}`

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
      DSH_REMOTE_FS_ROOT: [tmpRoot, secondaryRoot].join(path.delimiter),
      DSH_REMOTE_NOTES: path.join(tmpRoot, 'notes.json'),
      DSH_REMOTE_DSH_SERVICE: 'invalid service',
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

  await waitForHealth(base)
})

after(async () => {
  await stopChild()
  await stopFakeUpstream()
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = ''
  }
  if (secondaryRoot) {
    fs.rmSync(secondaryRoot, { recursive: true, force: true })
    secondaryRoot = ''
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
  const noToken = await fetch(`${base}/fs/list`)
  assert.equal(noToken.status, 401)

  const wrongToken = await fetch(`${base}/fs/list`, {
    headers: { authorization: 'Bearer wrong-token' }
  })
  assert.equal(wrongToken.status, 401)

  const ok = await fetch(`${base}/fs/list`, { headers: authHeaders() })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.ok(Array.isArray(body.entries))
  assert.ok(body.entries.some((e) => e.name === 'hello.txt'))
})

test('多文件根使用当前平台路径分隔符', async () => {
  const res = await fetch(fsUrl('/fs/list', { path: secondaryRoot }), { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.entries.some((e) => e.name === 'second-root.txt'))
})

test('路径穿越 / 绝对路径逃逸拒绝', async () => {
  // 用临时目录外、可能不存在的绝对路径即可：fsResolve 先做词法根检查，必然 403
  const outsideAbs = path.join(path.dirname(tmpRoot), 'dsh-remote-outside-does-not-exist.txt')
  const cases = [
    '/fs/list?path=' + encodeURIComponent('../'),
    '/fs/list?path=' + encodeURIComponent('../../outside'),
    '/fs/list?path=' + encodeURIComponent(outsideAbs),
    '/fs/file?path=' + encodeURIComponent(outsideAbs),
    '/fs/file?path=' + encodeURIComponent('../outside.txt')
  ]

  for (const suffix of cases) {
    const res = await fetch(base + suffix, { headers: authHeaders() })
    assert.equal(res.status, 403, suffix)
    const body = await res.json()
    assert.equal(body.error, 'forbidden', suffix)
  }
})

test('符号链接逃逸：列表隐藏、直读拒绝', async (t) => {
  const outsideFile = path.join(
    path.dirname(tmpRoot),
    `dsh-remote-outside-${process.pid}-${Date.now()}.txt`
  )
  const link = path.join(tmpRoot, 'escape.txt')
  fs.writeFileSync(outsideFile, 'secret')
  try {
    fs.symlinkSync(outsideFile, link)
  } catch (err) {
    fs.rmSync(outsideFile, { force: true })
    t.skip('symlink not supported on this platform: ' + err.message)
    return
  }

  try {
    const listRes = await fetch(fsUrl('/fs/list', { path: tmpRoot }), { headers: authHeaders() })
    assert.equal(listRes.status, 200)
    const list = await listRes.json()
    assert.ok(!list.entries.some((e) => e.name === 'escape.txt'), '外逃 symlink 不应出现在列表')

    const fileRes = await fetch(fsUrl('/fs/file', { path: link }), { headers: authHeaders() })
    assert.equal(fileRes.status, 403)
    const body = await fileRes.json()
    assert.equal(body.error, 'forbidden')
  } finally {
    fs.rmSync(outsideFile, { force: true })
    fs.rmSync(link, { force: true })
  }
})

test('Range：合法 bytes=0-9 返回 206，越界范围返回 416', async () => {
  const url = fsUrl('/fs/file', { path: path.join(tmpRoot, 'hello.txt') })

  const ok = await fetch(url, {
    headers: authHeaders({ range: 'bytes=0-9' })
  })
  assert.equal(ok.status, 206)
  assert.equal(await ok.text(), '0123456789')
  assert.equal(ok.headers.get('content-range'), 'bytes 0-9/16')

  const bad = await fetch(url, {
    headers: authHeaders({ range: 'bytes=99-100' })
  })
  assert.equal(bad.status, 416)
  const body = await bad.json()
  assert.equal(body.error, 'range-not-satisfiable')
})

test('分块续传 + SHA-256：正常提交成功，错误校验失败', async () => {
  const name = 'upload.bin'
  const session = `it-session-${Date.now()}`
  const part1 = Buffer.from('Hello ')
  const part2 = Buffer.from('World!')
  const content = Buffer.concat([part1, part2])

  // 第一块：offset=0
  let res = await fetch(fsUrl('/fs/upload', { path: tmpRoot, name, session, offset: 0 }), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: part1
  })
  assert.equal(res.status, 200)
  let body = await res.json()
  assert.equal(body.partial, true)
  assert.equal(body.offset, part1.length)

  // 第二块：offset=6
  res = await fetch(fsUrl('/fs/upload', {
    path: tmpRoot, name, session, offset: part1.length
  }), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: part2
  })
  assert.equal(res.status, 200)
  body = await res.json()
  assert.equal(body.offset, content.length)

  // probe 应看到已传大小
  const probe = await fetch(fsUrl('/fs/upload-probe', { path: tmpRoot, name, session }), {
    headers: authHeaders()
  })
  assert.equal(probe.status, 200)
  const probeBody = await probe.json()
  assert.equal(probeBody.partialSize, content.length)

  // 正确 sha256 -> 201，文件落位
  const goodSha = crypto.createHash('sha256').update(content).digest('hex')
  res = await fetch(fsUrl('/fs/upload', {
    path: tmpRoot, name, session, offset: content.length, finish: 1, sha256: goodSha
  }), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: Buffer.alloc(0)
  })
  assert.equal(res.status, 201)
  body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(fs.readFileSync(path.join(tmpRoot, name)).toString(), content.toString())

  // 错误 sha256 -> 422，目标文件不得落位
  const badName = 'bad.bin'
  const badSession = `bad-session-${Date.now()}`
  const badSha = '0'.repeat(64)
  res = await fetch(fsUrl('/fs/upload', {
    path: tmpRoot, name: badName, session: badSession, offset: 0, finish: 1, sha256: badSha
  }), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: Buffer.from('nope')
  })
  assert.equal(res.status, 422)
  body = await res.json()
  assert.equal(body.error, 'checksum-mismatch')
  assert.equal(fs.existsSync(path.join(tmpRoot, badName)), false)
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

test('工作区目录：创建成功、重复创建冲突、非法名称拒绝', async () => {
  const name = 'workspace-' + Date.now()
  let res = await fetch(fsUrl('/fs/mkdir', { path: tmpRoot, name }), {
    method: 'POST', headers: authHeaders()
  })
  assert.equal(res.status, 201)
  const created = await res.json()
  assert.equal(created.ok, true)
  assert.equal(created.name, name)

  res = await fetch(fsUrl('/fs/list', { path: tmpRoot }), { headers: authHeaders() })
  assert.equal(res.status, 200)
  const list = await res.json()
  assert.ok(list.entries.some(e => e.type === 'dir' && e.name === name))

  res = await fetch(fsUrl('/fs/mkdir', { path: tmpRoot, name }), {
    method: 'POST', headers: authHeaders()
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'exists')

  res = await fetch(fsUrl('/fs/mkdir', { path: tmpRoot, name: '../escape' }), {
    method: 'POST', headers: authHeaders()
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'bad-name')
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
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')

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
  assert.equal(valid.status, 501)
  const validBody = await valid.json()
  assert.equal(validBody.supported, false)
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
      UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
      UPDATE_INTERVAL_MS: '3600000',
      UPDATE_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '*',
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

// 说明：版本比较函数 cmpVersion/parseVersion 位于 public/app.js（浏览器端），
// 不在 gateway.js 进程内；按任务约束不为它引入 vm/DOM 模拟，因此这里只覆盖
// 网关侧的 /update.json 版本兼容输出（rc 后缀剥离逻辑）。
