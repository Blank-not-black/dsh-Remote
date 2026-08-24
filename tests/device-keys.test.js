'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const ADMIN_TOKEN = 'device-key-admin-token'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return res.json()
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('gateway health timeout')
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ])
}

function auth(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra }
}

async function adminPost(base, action, body) {
  return fetch(`${base}/admin/api/device-keys/${action}`, {
    method: 'POST',
    headers: auth(ADMIN_TOKEN, { 'content-type': 'application/json', 'x-dsh-remote-client': 'admin' }),
    body: JSON.stringify(body),
  })
}

test('独立设备密钥：开关、备注、轮换、退出和重启持久化', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-device-keys-'))
  const gatewayPort = await freePort()
  const upstreamPort = await freePort()
  const deviceKeysFile = path.join(tmpRoot, 'device-keys.json')
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.url.startsWith('/api/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, authorization: req.headers.authorization || '' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(upstreamPort, '127.0.0.1', resolve)
  })

  let child = null
  const start = async () => {
    child = spawn(process.execPath, [GATEWAY], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: tmpRoot,
        USERPROFILE: tmpRoot,
        PORT: String(gatewayPort),
        HOST: '127.0.0.1',
        DSH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        TOKEN: ADMIN_TOKEN,
        TOKEN_FILE: path.join(tmpRoot, 'token'),
        DSH_REMOTE_DEVICE_KEYS: deviceKeysFile,
        DSH_REMOTE_FS_ROOT: tmpRoot,
        DSH_REMOTE_ANNOUNCEMENTS_URL: '',
        UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
        UPDATE_INTERVAL_MS: '3600000',
        UPDATE_PROXY: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        NO_PROXY: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.resume()
    child.stderr.resume()
    return waitForHealth(`http://127.0.0.1:${gatewayPort}`)
  }

  t.after(async () => {
    await stop(child)
    await new Promise(resolve => upstream.close(resolve))
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${gatewayPort}`
  const health = await start()
  assert.equal(health.protocol.version, 1)
  assert.equal(health.capabilities.deviceKeys, 1)
  assert.equal(health.capabilities.dshLifecycle, 2)

  let stateRes = await fetch(`${base}/admin/api/state`, { headers: auth(ADMIN_TOKEN, { 'x-dsh-remote-client': 'admin' }) })
  assert.equal(stateRes.status, 200)
  let state = await stateRes.json()
  assert.equal(state.deviceKeys.enabled, false)

  let res = await adminPost(base, 'mode', { enabled: true, note: '测试手机' })
  assert.equal(res.status, 200)
  let body = await res.json()
  assert.equal(body.deviceKeys.enabled, true)
  assert.equal(body.deviceKeys.entries.length, 1)
  const first = body.deviceKeys.entries[0]
  assert.equal(first.note, '测试手机')
  assert.ok(first.token.length >= 24)

  res = await fetch(`${base}/api/echo`, { headers: auth(ADMIN_TOKEN, { 'x-dsh-remote-client': 'app' }) })
  assert.equal(res.status, 401, '独立密钥开启后共享管理令牌不能继续控制客户端 API')

  res = await fetch(`${base}/api/echo`, { headers: auth(first.token, { 'x-dsh-remote-client': 'app' }) })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).authorization, '', '设备令牌不能泄露给普通 DSH 上游 API')

  res = await fetch(`${base}/admin/api/dsh`, { headers: auth(first.token, { 'x-dsh-remote-client': 'app' }) })
  assert.notEqual(res.status, 401, '独立设备密钥仍应允许手机执行已支持的 DSH 生命周期操作')

  stateRes = await fetch(`${base}/admin/api/state`, { headers: auth(first.token, { 'x-dsh-remote-client': 'admin' }) })
  assert.equal(stateRes.status, 401, '设备令牌不能读取包含其他明文令牌的管理状态')

  res = await adminPost(base, 'note', { id: first.id, note: '客厅平板' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).entry.note, '客厅平板')

  res = await adminPost(base, 'create', { note: '备用手机' })
  assert.equal(res.status, 201)
  const second = (await res.json()).entry
  assert.notEqual(second.token, first.token)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(second.token) })).status, 200)

  res = await adminPost(base, 'rotate', { id: first.id })
  assert.equal(res.status, 200)
  const rotated = (await res.json()).entry
  assert.notEqual(rotated.token, first.token)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(first.token) })).status, 401)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(rotated.token) })).status, 200)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(second.token) })).status, 200, '轮换单个设备不应影响其他设备')

  await stop(child)
  await start()
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(rotated.token) })).status, 200, '网关重启后独立密钥仍应有效')
  state = await (await fetch(`${base}/admin/api/state`, { headers: auth(ADMIN_TOKEN, { 'x-dsh-remote-client': 'admin' }) })).json()
  assert.equal(state.deviceKeys.enabled, true)
  assert.ok(state.deviceKeys.entries.some(entry => entry.id === first.id && entry.note === '客厅平板'))

  res = await adminPost(base, 'revoke', { id: second.id })
  assert.equal(res.status, 200)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(second.token) })).status, 401)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(rotated.token) })).status, 200)

  res = await adminPost(base, 'mode', { enabled: false })
  assert.equal(res.status, 200)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(rotated.token) })).status, 401)
  assert.equal((await fetch(`${base}/api/echo`, { headers: auth(ADMIN_TOKEN) })).status, 200)

  const persisted = JSON.parse(fs.readFileSync(deviceKeysFile, 'utf8'))
  assert.equal(persisted.enabled, false)
  assert.equal(persisted.keys.length, 1)
  assert.equal(persisted.keys[0].id, first.id)
})
