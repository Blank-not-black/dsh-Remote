'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net')
const { once } = require('node:events'), { spawn } = require('node:child_process')
const root = path.join(__dirname, '..')
const master = 'bridge-master-test-token'
async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening')
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port
}
test('device keys cannot read credentials or mutate admin state through the real plugin bridge', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-bridge-auth-')), children = []
  t.after(async () => {
    for (const child of children.reverse()) if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const gatewayPort = await freePort(), upstreamPort = await freePort(), base = 'http://127.0.0.1:' + gatewayPort
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/proxy/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_|GATEWAY_|UPDATE_)/.test(key)) delete env[key]
  Object.assign(env, { HOME: temp, USERPROFILE: temp, DSH_HOME: path.join(temp, '.dsh'),
    DSH_REMOTE_FS_ROOT: temp, TOKEN: master, DSH_REMOTE_TOKEN: master,
    HOST: '127.0.0.1', PORT: String(gatewayPort), TEST_UPSTREAM_PORT: String(upstreamPort),
    DSH_UPSTREAM: 'http://127.0.0.1:' + upstreamPort, DSH_REMOTE_GATEWAY: base,
    DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', DSH_REMOTE_ANNOUNCEMENTS_URL: '',
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update', DSH_REMOTE_DSH_COOKIE_FILE: path.join(temp, 'upstream.cookie') })
  fs.writeFileSync(env.DSH_REMOTE_DSH_COOKIE_FILE, 'bridge-test=session')
  for (const file of ['tests/fixtures/plugin-bridge-upstream.mjs', 'gateway.js']) children.push(spawn(process.execPath, [path.join(root, file)], { cwd: root, env, stdio: 'ignore' }))
  for (const url of [env.DSH_UPSTREAM, base + '/health?probe=live']) {
    let ready = false
    for (let i = 0; i < 120; i++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(300) })).ok) { ready = true; break } } catch {} await new Promise(r => setTimeout(r, 50)) }
    assert.ok(ready, url)
  }
  async function request(route, token = master, body) {
    return fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  }
  const created = await (await request('/admin/api/device-keys/create', master, { note: 'isolated device' })).json()
  const device = created.entry?.token
  assert.ok(device)
  await request('/admin/api/device-keys/mode', master, { enabled: true })
  const state = await (await request('/remote/admin/api/state')).json()
  assert.equal(state.token, master, 'master can still manage the host when device-key mode is on')
  for (const route of ['/admin/api/state', '/remote/admin/api/state', '/remote/admin/api/config', '/remote/admin/api/device-keys/create', '/remote/admin/api/token/rotate', '/remote/admin/api/gateway', '/remote/admin%2fapi/state', '/remote/%61dmin/api/state']) {
    const res = await request(route, device, route.endsWith('create') || route.endsWith('rotate') || route.endsWith('gateway') ? { action: 'stop' } : undefined)
    assert.equal(res.status, 401, route)
    assert.doesNotMatch(await res.text(), new RegExp(master))
  }
  assert.equal((await request('/remote/api/plugins/state', device)).status, 200, 'device plugin-management capability stays available')
  assert.equal((await request('/remote/api/plugins/state', master)).status, 200)
  assert.equal((await request('/remote/api/plugins/state', 'invalid')).status, 401)
})
