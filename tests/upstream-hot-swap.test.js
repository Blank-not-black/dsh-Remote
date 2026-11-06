'use strict'
// DSH desktop restarts on a new random loopback port. The plugin asks a live gateway
// to repoint its upstream instead of restarting it, so the relay control channel and
// the public path stay connected. This test proves the in-place switch and its guards.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs'), http = require('node:http'), net = require('node:net'), os = require('node:os'), path = require('node:path')

const ROOT = path.join(__dirname, '..'), GATEWAY = path.join(ROOT, 'gateway.js'), TOKEN = 'upstream-hot-swap-token'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}
function fakeUpstream(name) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name, url: req.url }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}
async function until(check, message, timeout = 12000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error(message + (last ? ': ' + last.message : ''))
}

test('a live gateway repoints its upstream without restarting', { timeout: 45000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upstream-swap-'))
  const first = await fakeUpstream('A'), second = await fakeUpstream('B')
  const port = await freePort()
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/proxy|^DSH_|^TOKEN(?:_FILE)?$|^HOST$|^PORT$/i.test(key)) delete env[key]
  Object.assign(env, {
    HOME: home, USERPROFILE: home, DSH_HOME: home, TOKEN, PORT: String(port), HOST: '127.0.0.1',
    DSH_UPSTREAM: 'http://127.0.0.1:' + first.port, DSH_REMOTE_AUTOSTART: '0',
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update', NO_PROXY: '*',
  })
  const child = spawn(process.execPath, [GATEWAY], { env, stdio: ['ignore', 'ignore', 'ignore'] })
  t.after(() => {
    try { child.kill() } catch {}
    first.server.close(); second.server.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }
  const health = await until(async () => {
    const res = await fetch(base + '/health')
    const body = await res.json().catch(() => ({}))
    return body.ok && body.version ? body : null
  }, 'gateway did not start')
  assert.equal(health.upstream, 'http://127.0.0.1:' + first.port)

  const unauthorized = await fetch(base + '/admin/api/upstream', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:' + second.port }),
  })
  assert.equal(unauthorized.status, 401)
  for (const url of ['http://example.com/remote', 'file:///tmp/x', 'not a url']) {
    const rejected = await fetch(base + '/admin/api/upstream', { method: 'POST', headers, body: JSON.stringify({ url }) })
    assert.equal(rejected.status, 400, url)
  }

  const swapped = await (await fetch(base + '/admin/api/upstream', {
    method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:' + second.port }),
  })).json()
  assert.deepEqual(swapped, { ok: true, upstream: 'http://127.0.0.1:' + second.port })

  const proxied = await until(async () => {
    const res = await fetch(base + '/api/hot-swap-probe', { method: 'POST', headers, body: '{}' })
    const body = await res.json().catch(() => null)
    return body?.name === 'B' ? body : null
  }, 'proxy did not reach the new upstream')
  assert.equal(proxied.url, '/api/hot-swap-probe')
  const after = await (await fetch(base + '/health')).json()
  assert.equal(after.pid, health.pid)
  assert.equal(after.upstream, 'http://127.0.0.1:' + second.port)
})
