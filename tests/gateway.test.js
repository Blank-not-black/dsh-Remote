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
let fakeUpgradeCount = 0

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

function encodeWsControl(opcode, payload) {
  const body = Buffer.from(payload || '')
  assert.ok(body.length <= 125)
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
}

function attachWsAutoPong(socket) {
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
        socket.write(encodeWsControl(0xA, payload))
      } else if ((first & 0x0f) === 0x8) {
        try { socket.end() } catch {}
      }
    }
  })
}

function startFakeUpstream() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
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
      attachWsAutoPong(socket)
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

test('静态文件：管理页 /admin 变体统一可达', async () => {
  // /admin、/admin/、/admin/index.html 三个入口都落到 admin.html(查询串如 ?token= 自然保留)
  for (const v of ['/admin', '/admin/', '/admin/index.html']) {
    const res = await fetch(`${base}${v}?token=${TOKEN}`)
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /DSH Remote · 管理/)
    assert.match(text, /src="\.\.\/admin\.js"/)
  }
  // 管理 API 与页面同前缀, 仍需 Bearer 鉴权
  const noToken = await fetch(`${base}/admin/api/state`)
  assert.equal(noToken.status, 401)
  const ok = await fetch(`${base}/admin/api/state`, { headers: authHeaders() })
  assert.equal(ok.status, 200)
})

test('设备列表：同 IP 多通道/多键聚合为一行 + admin 过滤 + 计数同源', async () => {
  // 构造同 IP 的三类内部键: 无 clientId 的普通请求(键=ip) + 两条带 clientId 的
  // WS 流(键=ip|clientId, devA 同时开 mux/host 两通道) —— 0.6.9 旧行为会拆成
  // 3 行, 修复后 deviceViews 按 IP 聚合成 1 行, mux/host 合并进 channels。
  const openWs = (channel, clientId) => new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    let done = false
    sock.setTimeout(5000)
    sock.on('timeout', () => { if (!done) { done = true; sock.destroy(); reject(new Error('ws upgrade timeout')) } })
    sock.on('error', (e) => { if (!done) { done = true; reject(e) } })
    sock.on('data', (d) => {
      buf += d.toString('binary')
      if (!done && buf.includes('101 Switching Protocols')) { done = true; resolve(sock) }
    })
    sock.write(
      `GET /api/events.${channel}?token=${TOKEN}&clientId=${clientId} HTTP/1.1\r\n` +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    )
  })
  const socks = []
  try {
    await fetch(`${base}/fs/list`, { headers: authHeaders({ 'x-dsh-remote-client': 'app' }) })
    socks.push(await openWs('mux', 'devA'))
    socks.push(await openWs('host', 'devA'))
    socks.push(await openWs('mux', 'devB'))
    await new Promise((r) => setTimeout(r, 200)) // 等网关记账完成

    // 1) 管理页请求带 app 标记: 裸 IP 行仍计入, 与 WS 行合并为一行
    const st1 = await (await fetch(`${base}/admin/api/state`, { headers: authHeaders({ 'x-dsh-remote-client': 'app' }) })).json()
    assert.equal(st1.deviceCount, 1, '同 IP 多键聚合为一行')
    assert.equal(st1.onlineCount, 1)
    assert.equal(st1.devices.length, 1)
    const r1 = st1.devices[0]
    assert.equal(r1.ip, '127.0.0.1')
    assert.equal(r1.kind, 'app', '聚合种类取最像真实客户端的(app > browser)')
    assert.ok(r1.channels.mux && r1.channels.host, 'mux/host 通道合并')
    assert.ok(r1.requests >= 4, '请求数跨键合并(fs + 3 条 WS)')
    assert.equal(r1.clientId, 'devA', '输出保留内部 clientId')

    // 2) 管理页请求带 admin 标记(生产行为): 裸 IP 行被过滤, WS 行仍在 → 仍 1 行
    const st2 = await (await fetch(`${base}/admin/api/state`, { headers: authHeaders({ 'x-dsh-remote-client': 'admin' }) })).json()
    assert.equal(st2.deviceCount, 1, 'admin 过滤后计数与列表一致')
    assert.equal(st2.devices.length, 1)
    assert.notEqual(st2.devices[0].kind, 'admin')
    const ips = st2.devices.map((d) => d.ip)
    assert.equal(new Set(ips).size, ips.length, '列表无重复 IP')
  } finally {
    for (const s of socks) { try { s.destroy() } catch {} }
  }
})

test('设备列表：两台设备各一行 + 轮换令牌后旧 401 / 新 token 重连计数不变', async (t) => {
  const lanIP = (() => {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it.family === 'IPv4' && !it.internal) return it.address
      }
    }
    return null
  })()
  const port2 = await getFreePort()
  const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-gateway-dev-'))
  const tokenFile = path.join(devRoot, 'token')
  fs.writeFileSync(tokenFile, 'rotate-test-token\n')
  const child2 = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: devRoot,
      USERPROFILE: devRoot,
      PORT: String(port2),
      HOST: '0.0.0.0',
      DSH_UPSTREAM: `http://127.0.0.1:${fakeUpstreamPort}`,
      TOKEN_FILE: tokenFile,
      DSH_REMOTE_FS_ROOT: devRoot,
      DSH_REMOTE_NOTES: path.join(devRoot, 'notes.json'),
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
  child2.stdout.on('data', () => {})
  child2.stderr.on('data', () => {})
  const base2 = `http://127.0.0.1:${port2}`
  const appAuth = { authorization: 'Bearer rotate-test-token', 'x-dsh-remote-client': 'app' }
  const adminAuth = { authorization: 'Bearer rotate-test-token', 'x-dsh-remote-client': 'admin' }
  try {
    await waitForHealth(base2, 10000)
    // 设备1: 127.0.0.1
    await fetch(`${base2}/fs/list`, { headers: appAuth })
    // 设备2: 本机 LAN IP(无 LAN IP 或连不通时退化为单设备断言)
    let second = null
    if (lanIP) {
      try {
        const r = await fetch(`http://${lanIP}:${port2}/fs/list`, { headers: appAuth, signal: AbortSignal.timeout(2000) })
        if (r.ok) second = lanIP
      } catch {}
    }
    if (!second) t.diagnostic('no reachable LAN IP, 双设备断言跳过(仍验证单设备+轮换)')

    const before = await (await fetch(`${base2}/admin/api/state`, { headers: adminAuth })).json()
    const expectCount = second ? 2 : 1
    assert.equal(before.deviceCount, expectCount, '设备计数与列表同源')
    assert.equal(before.devices.length, expectCount)
    const ips = before.devices.map((d) => d.ip)
    assert.equal(new Set(ips).size, ips.length, '无重复 IP')
    if (second) assert.ok(ips.includes('127.0.0.1') && ips.includes(second))

    // 轮换令牌: 旧 token 立即 401, 新 token 可用, 计数不变
    const rot = await (await fetch(`${base2}/admin/api/token/rotate`, { method: 'POST', headers: adminAuth })).json()
    assert.equal(rot.ok, true)
    assert.ok(rot.token && rot.token !== 'rotate-test-token')
    const oldReq = await fetch(`${base2}/fs/list`, { headers: appAuth })
    assert.equal(oldReq.status, 401, '旧 token 立即失效')
    const newAuth = { authorization: 'Bearer ' + rot.token, 'x-dsh-remote-client': 'app' }
    const newReq = await fetch(`${base2}/fs/list`, { headers: newAuth })
    assert.equal(newReq.status, 200, '新 token 可用')
    const after = await (await fetch(`${base2}/admin/api/state`, { headers: { ...newAuth, 'x-dsh-remote-client': 'admin' } })).json()
    assert.equal(after.deviceCount, before.deviceCount, '轮换后重连计数仍与列表一致')
    assert.equal(after.devices.length, before.devices.length)
  } finally {
    if (child2.exitCode === null) child2.kill('SIGTERM')
    await Promise.race([
      once(child2, 'exit').then(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
    fs.rmSync(devRoot, { recursive: true, force: true })
  }
})

test('插件 admin 302 重定向: LAN Host 头不硬编码 127.0.0.1', async () => {
  // t9 评审 I2 回归: 局域网浏览器经 http://192.168.x.x:3080 访问时,
  // 302 目标应指向同一可达地址的网关端口, 而不是访问者自己的 127.0.0.1。
  const { pathToFileURL } = require('node:url')
  const mod = await import(pathToFileURL(path.join(ROOT, 'packages', 'plugin', 'index.mjs')).href)
  const prevGw = process.env.DSH_REMOTE_GATEWAY
  const prevPort = process.env.DSH_REMOTE_GATEWAY_PORT
  try {
    delete process.env.DSH_REMOTE_GATEWAY
    process.env.DSH_REMOTE_GATEWAY_PORT = '8787'
    // 局域网访问: 用请求 Host 的 hostname + 网关端口
    assert.equal(mod.adminRedirectBase({ headers: { host: '192.168.1.5:3080' } }), 'http://192.168.1.5:8787')
    assert.equal(mod.adminRedirectBase({ headers: { host: '10.0.0.8' } }), 'http://10.0.0.8:8787')
    // 本机访问行为不变(Host 头天然一致)
    assert.equal(mod.adminRedirectBase({ headers: { host: '127.0.0.1:3080' } }), 'http://127.0.0.1:8787')
    assert.equal(mod.adminRedirectBase({ headers: { host: 'localhost:3080' } }), 'http://localhost:8787')
    // IPv6 字面量保留 [::1] 形式
    assert.equal(mod.adminRedirectBase({ headers: { host: '[::1]:3080' } }), 'http://[::1]:8787')
    // 无 Host 头兜底 127.0.0.1
    assert.equal(mod.adminRedirectBase({ headers: {} }), 'http://127.0.0.1:8787')
    // DSH_REMOTE_GATEWAY 显式配置时仍以其为准
    process.env.DSH_REMOTE_GATEWAY = 'http://gw.example.com'
    assert.equal(mod.adminRedirectBase({ headers: { host: '192.168.1.5:3080' } }), 'http://gw.example.com')
  } finally {
    if (prevGw === undefined) delete process.env.DSH_REMOTE_GATEWAY
    else process.env.DSH_REMOTE_GATEWAY = prevGw
    if (prevPort === undefined) delete process.env.DSH_REMOTE_GATEWAY_PORT
    else process.env.DSH_REMOTE_GATEWAY_PORT = prevPort
  }
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
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'capacitor://localhost')

  const deniedOrigin = await fetch(`${base}/fs/list`, {
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

// 说明：版本比较函数 cmpVersion/parseVersion 位于 public/app.js（浏览器端），
// 不在 gateway.js 进程内；按任务约束不为它引入 vm/DOM 模拟，因此这里只覆盖
// 网关侧的 /update.json 版本兼容输出（rc 后缀剥离逻辑）。
