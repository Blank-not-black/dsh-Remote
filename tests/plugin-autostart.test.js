'use strict'

/**
 * 插件网关自启的黑盒测试。通过临时 HOME、随机端口和空 PATH
 * 隔离真实 systemd，迫使插件走 detached spawn fallback；最后通过
 * 网关的鉴权 shutdown 和精确 PID 双重清理。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const { createHash } = require('node:crypto')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'packages/plugin/index.mjs')
const TOKEN = 'plugin-autostart-test-token'

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

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${message}${lastError ? ': ' + lastError.message : ''}`)
}

for (const listenHost of ['0.0.0.0', '::']) {
test(`插件自启：${listenHost} 上游认证、HTTP 和 WS 使用回环地址`, async (t) => {
  const connectHost = listenHost === '::' ? '::1' : '127.0.0.1'
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-plugin-autostart-'))
  const emptyBin = path.join(tmpHome, 'empty-bin')
  const configDir = path.join(tmpHome, '.dsh-remote')
  fs.mkdirSync(emptyBin, { recursive: true })
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'token'), TOKEN + '\n', { mode: 0o600 })
  const gatewayPort = await getFreePort()

  const envKeys = [
    'HOME', 'USERPROFILE', 'PATH', 'DSH_REMOTE_AUTOSTART', 'DSH_REMOTE_GATEWAY_PORT',
    'DSH_REMOTE_FS_ROOT', 'TOKEN_FILE', 'UPDATE_CHECK_URL', 'UPDATE_INTERVAL_MS',
    'UPDATE_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY',
    'DSH_REMOTE_DSH_COOKIE_FILE', 'DSH_REMOTE_GATEWAY', 'DSH_REMOTE_TOKEN', 'TOKEN',
    'HOST', 'DSH_REMOTE_GATEWAY_HOST',
  ]
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PATH: emptyBin,
    DSH_REMOTE_AUTOSTART: '1',
    DSH_REMOTE_GATEWAY_PORT: String(gatewayPort),
    DSH_REMOTE_FS_ROOT: tmpHome,
    TOKEN_FILE: path.join(configDir, 'token'),
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
    UPDATE_INTERVAL_MS: '3600000',
    UPDATE_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
    DSH_REMOTE_DSH_COOKIE_FILE: path.join(configDir, 'dsh-upstream.cookie'),
    DSH_REMOTE_GATEWAY: `http://127.0.0.1:${gatewayPort}`,
    DSH_REMOTE_GATEWAY_HOST: listenHost,
  })
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[key]
  delete process.env.TOKEN
  delete process.env.DSH_REMOTE_TOKEN
  delete process.env.HOST

  let route = null
  const disposers = []
  const dshCookie = 'dsh-browser-plugin-test=authenticated'
  const authBases = []
  const ctx = {
    connection: {
      authenticatedUrl(baseUrl) { authBases.push(baseUrl); return `${baseUrl}/?token=plugin-process-token` },
    },
    webServer: {
      host: listenHost,
      port: 0,
      register(definition) {
        route = definition
        return () => { route = null }
      },
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on() {},
    agents: { get() {}, async resume() { return null } },
    commands: { async list() { return [] }, async execute() {} },
  }

  const dshServer = http.createServer((req, res) => {
    const authority = `${connectHost === '::1' ? '[::1]' : connectHost}:${ctx.webServer.port}`
    if (req.headers.host !== authority) {
      res.writeHead(403)
      res.end('untrusted host')
      return
    }
    if (req.url === '/?token=plugin-process-token') {
      res.writeHead(303, { location: '/', 'set-cookie': `${dshCookie}; Path=/; HttpOnly; SameSite=Strict` })
      res.end()
      return
    }
    if (req.url === '/' || req.url === '/api/upstream-test') {
      if (req.headers.cookie !== dshCookie) {
        res.writeHead(401)
        res.end('authentication required')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (route && req.url.startsWith(route.path)) {
      try {
        Promise.resolve(route.handler(req, res)).catch((err) => {
          if (!res.headersSent) res.writeHead(500)
          res.end(String(err?.stack || err))
        })
      } catch (err) {
        if (!res.headersSent) res.writeHead(500)
        res.end(String(err?.stack || err))
      }
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  const wsSockets = new Set()
  dshServer.on('upgrade', (req, socket) => {
    const authority = `${connectHost === '::1' ? '[::1]' : connectHost}:${ctx.webServer.port}`
    if (req.headers.host !== authority || req.headers.cookie !== dshCookie) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    wsSockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => wsSockets.delete(socket))
  })

  async function emergencyStop() {
    try {
      await fetch(`http://127.0.0.1:${gatewayPort}/admin/api/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(1000),
      })
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      const pid = Number(fs.readFileSync(path.join(configDir, 'plugin-gateway.pid'), 'utf8').trim())
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
    } catch {}
  }

  t.after(async () => {
    await emergencyStop()
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    for (const socket of wsSockets) socket.destroy()
    await new Promise((resolve) => dshServer.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  await new Promise((resolve, reject) => {
    dshServer.once('error', reject)
    dshServer.listen({ port: 0, host: listenHost, ipv6Only: listenHost === '::' }, resolve)
  })
  ctx.webServer.port = dshServer.address().port
  const dshBase = `http://${connectHost === '::1' ? '[::1]' : connectHost}:${ctx.webServer.port}`
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`

  const plugin = await import(pathToFileURL(PLUGIN).href + `?autostart=${Date.now()}`)
  plugin.apply(ctx)

  let observedHealth = null
  let health
  try {
    health = await waitFor(async () => {
      const res = await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(500) })
      if (!res.ok) return false
      const body = await res.json()
      observedHealth = body
      return body.upstream === dshBase && body.upstreamOk && body.events.mux.connected && body.events.host.connected ? body : false
    }, 7000, '插件未通过 fallback 拉起网关')
  } catch (err) {
    err.message += `；最后健康状态=${JSON.stringify(observedHealth)}`
    throw err
  }
  assert.ok(health.pid > 1)
  assert.ok(authBases.length > 0)
  assert.ok(authBases.every(base => base === dshBase))
  const apiResponse = await fetch(`${gatewayBase}/api/upstream-test`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(apiResponse.status, 200)
  assert.deepEqual(await apiResponse.json(), { ok: true })
  const cookieFile = path.join(configDir, 'dsh-upstream.cookie')
  assert.equal(fs.readFileSync(cookieFile, 'utf8').trim(), dshCookie)
  // Windows reports synthesized POSIX mode bits; chmod does not set its ACL.
  if (process.platform !== 'win32') assert.equal(fs.statSync(cookieFile).mode & 0o777, 0o600)
  await waitFor(() => {
    try {
      return fs.readFileSync(path.join(configDir, 'gateway.enabled'), 'utf8').trim() === 'on'
        && Number(fs.readFileSync(path.join(configDir, 'plugin-gateway.pid'), 'utf8').trim()) === health.pid
    } catch {
      return false
    }
  }, 3000, '网关启动后未持久化 enabled/PID 状态')

  const stateRes = await fetch(`${dshBase}/remote/admin/api/state`)
  assert.equal(stateRes.status, 200)
  const state = await stateRes.json()
  assert.equal(state.mode, 'gateway')
  assert.equal(state.via, 'gateway')
  assert.equal(state.port, gatewayPort)
  assert.equal(state.host, listenHost)
  if (listenHost === '::') {
    assert.equal((await fetch(`http://[::1]:${gatewayPort}/health`)).status, 200)
  }

  // issue #13: 文件删除后，状态查询恢复原令牌，运行中进程和鉴权不变。
  const tokenFile = path.join(configDir, 'token')
  fs.unlinkSync(tokenFile)
  const recovered = await (await fetch(`${dshBase}/remote/admin/api/state`)).json()
  assert.equal(recovered.mode, 'gateway')
  assert.equal(recovered.token, TOKEN)
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), TOKEN)
  assert.equal((await (await fetch(`${gatewayBase}/health`)).json()).pid, health.pid)

  // 已存在的错误令牌不能覆盖；界面数据报告运行中且认证失败，启动不能假成功。
  fs.writeFileSync(tokenFile, 'wrong-token\n')
  const mismatch = await (await fetch(`${dshBase}/remote/admin/api/state`)).json()
  assert.equal(mismatch.gatewayRunning, true)
  assert.match(mismatch.gatewayAuthError, /手动重启/)
  assert.equal(mismatch.token, '')
  for (const action of ['start', 'stop']) {
    const out = await (await fetch(`${dshBase}/remote/admin/api/gateway`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
    })).json()
    assert.equal(out.ok, false)
    assert.equal(out.running, true)
  }
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), 'wrong-token')
  fs.writeFileSync(tokenFile, TOKEN + '\n')

  const stopRes = await fetch(`${dshBase}/remote/admin/api/gateway`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  })
  assert.equal(stopRes.status, 200)
  assert.equal((await stopRes.json()).ok, true)
  await waitFor(async () => {
    try {
      await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(300) })
      return false
    } catch {
      return true
    }
  }, 3000, '停止后网关进程仍可达')
  assert.equal(fs.readFileSync(path.join(configDir, 'gateway.enabled'), 'utf8').trim(), 'off')
})
}

test('上游地址保留明确的主机，规范化 IPv6 通配地址与括号', async () => {
  const { upstreamUrlForListener } = await import(pathToFileURL(PLUGIN).href)
  for (const [host, expected] of [
    ['0.0.0.0', '127.0.0.1'], ['::', '[::1]'], ['[::]', '[::1]'],
    ['0:0:0:0:0:0:0:0', '[::1]'], ['127.0.0.1', '127.0.0.1'],
    ['192.168.1.10', '192.168.1.10'], ['dsh.local', 'dsh.local'],
    ['::1', '[::1]'], ['[::1]', '[::1]'], ['2001:db8::10', '[2001:db8::10]'],
  ]) {
    assert.equal(upstreamUrlForListener({ host, port: 3080 }), `http://${expected}:3080`)
  }
})
