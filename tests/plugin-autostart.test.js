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

test('插件自启：systemd-run 不可用时 fallback 网关可启动、管理并停止', async (t) => {
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
  })
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[key]

  let route = null
  const disposers = []
  const ctx = {
    webServer: {
      host: '127.0.0.1',
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
    if (req.url === '/') {
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
    await new Promise((resolve) => dshServer.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  await new Promise((resolve, reject) => {
    dshServer.once('error', reject)
    dshServer.listen(0, '127.0.0.1', resolve)
  })
  ctx.webServer.port = dshServer.address().port
  const dshBase = `http://127.0.0.1:${ctx.webServer.port}`
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`

  const plugin = await import(pathToFileURL(PLUGIN).href + `?autostart=${Date.now()}`)
  plugin.apply(ctx)

  const health = await waitFor(async () => {
    const res = await fetch(`${gatewayBase}/health`, { signal: AbortSignal.timeout(500) })
    if (!res.ok) return false
    const body = await res.json()
    return body.upstream === dshBase && body.upstreamOk ? body : false
  }, 7000, '插件未通过 fallback 拉起网关')
  assert.ok(health.pid > 1)
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
