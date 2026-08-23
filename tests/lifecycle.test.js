'use strict'

/**
 * 接近真实部署的生命周期黑盒测试：
 * - 一个可反复停启、保持同一端口的假 DSH HTTP + WebSocket 服务；
 * - 一个独立子进程网关，HOME/文件根/token/代理全部隔离；
 * - 一个保持 WebSocket 在线的手机客户端模拟器。
 *
 * 它专门验证常规单请求测试捕捉不到的 DSH 重启、网关重启和持久化恢复。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const TOKEN = 'lifecycle-test-token'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key || '') + WS_GUID).digest('base64')
}

function encodeWsFrame(opcode, payload, masked = false) {
  const body = Buffer.from(payload || '')
  assert.ok(body.length < 126, '生命周期测试帧应保持精简')
  if (!masked) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body])
  const mask = crypto.randomBytes(4)
  const encoded = Buffer.alloc(body.length)
  for (let i = 0; i < body.length; i++) encoded[i] = body[i] ^ mask[i % 4]
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | body.length]), mask, encoded])
}

function encodeWsText(value) {
  return encodeWsFrame(0x1, JSON.stringify(value))
}

function attachAutoPong(socket) {
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
      const opcode = first & 0x0f
      if (opcode === 0x9 && !socket.destroyed) socket.write(encodeWsFrame(0xA, payload))
      else if (opcode === 0x8) socket.end()
    }
  })
}

function createRestartableDsh(port) {
  let server = null
  let bootId = 0
  const sockets = new Set()

  return {
    get bootId() { return bootId },
    async start() {
      assert.equal(server, null)
      bootId++
      const currentBoot = bootId
      server = http.createServer(async (req, res) => {
        if (req.url === '/') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, bootId: currentBoot }))
          return
        }
        let body = ''
        for await (const chunk of req) body += chunk
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          bootId: currentBoot,
          path: req.url,
          method: req.method,
          authOk: req.headers.authorization === `Bearer ${TOKEN}`,
          body: body ? JSON.parse(body) : null,
          sessions: req.url.startsWith('/api/sessions.list') ? [{ id: 'session-1', title: `boot-${currentBoot}` }] : undefined,
        }))
      })
      server.on('upgrade', (req, socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        const accept = wsAccept(req.headers['sec-websocket-key'])
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        )
        attachAutoPong(socket)
        const kind = req.url.includes('events.host') ? 'host' : 'mux'
        const payload = kind === 'host'
          ? { type: 'host/session-status', sessionId: 'session-1', running: true, bootId: currentBoot }
          : { type: 'session/subscribed', sessionId: 'session-1', bootId: currentBoot }
        socket.write(encodeWsText({ rpcId: `${kind}-${currentBoot}`, payload }))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
    },
    async stop() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (!server) return
      const current = server
      server = null
      await new Promise((resolve) => current.close(resolve))
    },
  }
}

function createGatewayProcess(port, upstreamPort, tmpRoot) {
  let child = null
  let logs = ''
  const base = `http://127.0.0.1:${port}`

  return {
    base,
    async start() {
      assert.equal(child, null)
      const env = {
        ...process.env,
        HOME: tmpRoot,
        USERPROFILE: tmpRoot,
        PORT: String(port),
        HOST: '127.0.0.1',
        DSH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        TOKEN,
        TOKEN_FILE: path.join(tmpRoot, 'token'),
        DSH_REMOTE_FS_ROOT: tmpRoot,
        DSH_REMOTE_NOTES: path.join(tmpRoot, 'notes.json'),
        DSH_REMOTE_WORKBENCH: path.join(tmpRoot, 'workbench.json'),
        DSH_REMOTE_DSH_SERVICE: 'invalid lifecycle test service',
        GATEWAY_WS_UPGRADE_TIMEOUT_MS: '1000',
        GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
        GATEWAY_WS_PING_MS: '1000',
        GATEWAY_WS_PONG_TIMEOUT_MS: '3000',
        UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
        UPDATE_INTERVAL_MS: '3600000',
        UPDATE_PROXY: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: '*',
      }
      delete env.NODE_USE_ENV_PROXY
      delete env.http_proxy
      delete env.https_proxy
      delete env.all_proxy
      child = spawn(process.execPath, [GATEWAY], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const capture = (chunk) => { logs = (logs + chunk.toString()).slice(-8000) }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      child.once('error', capture)
      await waitFor(async () => {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
        return res.ok
      }, 5000, () => `gateway failed to start:\n${logs}`)
    },
    async stop() {
      if (!child) return
      const current = child
      child = null
      if (current.exitCode === null) current.kill('SIGTERM')
      await Promise.race([
        once(current, 'exit').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
    },
    logs() { return logs },
  }
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(typeof message === 'function' ? message(lastError) : message)
}

async function waitForHealth(base, predicate, timeoutMs = 10000) {
  let last
  return waitFor(async () => {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
    if (!res.ok) return false
    last = await res.json()
    return predicate(last) ? last : false
  }, timeoutMs, () => `health did not converge: ${JSON.stringify(last)}`)
}

async function connectMobile(base, kind = 'mux') {
  const ticketRes = await fetch(`${base}/api/ws-ticket`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-dsh-remote-client': 'app',
      'x-dsh-remote-client-id': 'lifecycle-phone',
    },
  })
  assert.equal(ticketRes.status, 200)
  const { ticket } = await ticketRes.json()
  assert.ok(ticket)
  const wsBase = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsBase}/api/events.${kind}?ticket=${encodeURIComponent(ticket)}&client=app&clientId=lifecycle-phone`)
  const messages = []
  const waiters = new Set()
  ws.addEventListener('message', (event) => {
    let parsed
    try { parsed = JSON.parse(String(event.data)) } catch { return }
    messages.push(parsed)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(parsed)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(parsed)
    }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mobile websocket open timeout')), 3000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('mobile websocket open failed')) }, { once: true })
  })
  return {
    ws,
    waitForMessage(predicate, timeoutMs = 5000) {
      const existing = messages.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`mobile event timeout; messages=${JSON.stringify(messages)}`))
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
    close() { try { ws.close() } catch {} },
  }
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

test('真实生命周期：DSH 多次重启不断手机通道，网关重启后恢复事件与文件', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-lifecycle-'))
  const dshPort = await getFreePort()
  const gatewayPort = await getFreePort()
  const dsh = createRestartableDsh(dshPort)
  const gateway = createGatewayProcess(gatewayPort, dshPort, tmpRoot)
  let mobile = null
  t.after(async () => {
    mobile?.close()
    await gateway.stop()
    await dsh.stop()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  await dsh.start()
  await gateway.start()
  await waitForHealth(gateway.base, (health) =>
    health.upstreamOk && health.events.mux.connected && health.events.host.connected
  )

  mobile = await connectMobile(gateway.base)
  await mobile.waitForMessage((event) => event.payload?.bootId === 1)

  const upload = await fetch(`${gateway.base}/fs/upload?path=${encodeURIComponent(tmpRoot)}&name=restart-proof.txt`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: 'persistent across gateway restart',
  })
  assert.equal(upload.status, 201)

  let proxied = await fetch(`${gateway.base}/api/sessions.list`, { headers: authHeaders() })
  assert.equal(proxied.status, 200)
  let proxyBody = await proxied.json()
  assert.equal(proxyBody.bootId, 1)
  // DSH 本机 /api 不需要网关 token，客户端密钥不得泄露给普通上游路由。
  assert.equal(proxyBody.authOk, false)

  for (let expectedBoot = 2; expectedBoot <= 4; expectedBoot++) {
    const reconnectsBefore = (await (await fetch(`${gateway.base}/health`)).json()).events.mux.reconnects
    await dsh.stop()
    await waitForHealth(gateway.base, (health) =>
      !health.events.mux.connected && !health.events.host.connected && health.events.mux.reconnects > reconnectsBefore
    )
    assert.equal(mobile.ws.readyState, WebSocket.OPEN, `DSH 第 ${expectedBoot - 1} 次停机不应断开手机与网关`)

    const unavailable = await fetch(`${gateway.base}/api/sessions.list`, { headers: authHeaders() })
    assert.equal(unavailable.status, 502)

    await dsh.start()
    await waitForHealth(gateway.base, (health) =>
      health.upstreamOk && health.events.mux.connected && health.events.host.connected
    )
    await mobile.waitForMessage((event) => event.payload?.bootId === expectedBoot)

    proxied = await fetch(`${gateway.base}/api/sessions.list`, { headers: authHeaders() })
    assert.equal(proxied.status, 200)
    proxyBody = await proxied.json()
    assert.equal(proxyBody.bootId, expectedBoot)
    assert.equal(proxyBody.authOk, false)
  }

  await gateway.stop()
  await waitFor(() => mobile.ws.readyState === WebSocket.CLOSED, 3000, '网关停止后手机 WS 未关闭')
  await gateway.start()
  await waitForHealth(gateway.base, (health) =>
    health.upstreamOk && health.events.mux.connected && health.events.host.connected
  )

  mobile = await connectMobile(gateway.base)
  await mobile.waitForMessage((event) => event.payload?.bootId === 4)
  const persisted = await fetch(`${gateway.base}/fs/file?path=${encodeURIComponent(path.join(tmpRoot, 'restart-proof.txt'))}`, {
    headers: authHeaders(),
  })
  assert.equal(persisted.status, 200)
  assert.equal(await persisted.text(), 'persistent across gateway restart')

  const finalHealth = await (await fetch(`${gateway.base}/health`)).json()
  assert.equal(finalHealth.runtime.uncaughtExceptions, 0, gateway.logs())
  assert.equal(finalHealth.runtime.unhandledRejections, 0, gateway.logs())
})
