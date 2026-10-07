'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net')
const { once } = require('node:events'), { spawn } = require('node:child_process')
async function freePort() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p }
test('insights: authenticated real gateway/plugin bridge is read-only and preserves Fetch JSON on modern DSH', { timeout: 20000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-bridge-')), children = []
  t.after(async () => { for (const c of children.reverse()) if (c.exitCode === null) { const done = once(c, 'exit'); c.kill(); await done } fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const upstreamPort = await freePort(), port = await freePort(), base = 'http://127.0.0.1:' + port, master = 'insights-test-only'
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_|GATEWAY_|UPDATE_)/.test(key)) delete env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_DSH_COOKIE_FILE: path.join(home, 'cookie'), DSH_REMOTE_TOKEN: master, TOKEN: master, HOST: '127.0.0.1', PORT: String(port),
    TEST_UPSTREAM_PORT: String(upstreamPort), DSH_UPSTREAM: 'http://127.0.0.1:' + upstreamPort, DSH_REMOTE_GATEWAY: base,
    DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', DSH_REMOTE_ANNOUNCEMENTS_URL: '', UPDATE_CHECK_URL: 'http://127.0.0.1:1/update' })
  fs.writeFileSync(env.DSH_REMOTE_DSH_COOKIE_FILE, 'bridge-test=session')
  for (const file of ['tests/fixtures/insights-upstream.mjs', 'gateway.js']) children.push(spawn(process.execPath, [path.join(root, file)], { cwd: root, env, windowsHide: true, stdio: 'ignore' }))
  for (const url of [env.DSH_UPSTREAM, base + '/health']) { let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(url, { signal: AbortSignal.timeout(300) })).ok } catch {} if (ready) break; await new Promise(r => setTimeout(r, 50)) } assert.ok(ready) }
  const call = (route, token = master, body) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const created = await (await call('/admin/api/device-keys/create', master, { note: 'insights isolated device' })).json()
  await call('/admin/api/device-keys/mode', master, { enabled: true }); const device = created.entry.token
  assert.equal((await call('/remote/api/insights/cost', 'invalid')).status, 401)
  const response = await call('/remote/api/insights/cost?sessionId=insights-session', device)
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.text(); assert.doesNotMatch(body, /SECRET|apiKey|private\.invalid/); assert.equal(JSON.parse(body).session.own.apiCost, .18)
  assert.equal((await call('/remote/api/insights/cost', master, { method: 'updateConfig' })).status, 405)
  assert.equal((await call('/remote/api/insights/cost?method=updateConfig', device)).status, 400)
  assert.equal((await call('/remote/api/insights/cost?sessionId=one&sessionId=two', device)).status, 400)
  assert.equal((await call('/remote/api/insights/cost?sessionId=bad%0Avalue', device)).status, 400)
  await call('/api/session.list', device, { type: 'client-request', rpcId: 'probe', method: 'session.list', payload: {} })
  const detail = await call('/api/dsh-context/detail', device, { sessionId: 'insights-session' })
  assert.equal(detail.status, 200); const payload = await detail.json(); assert.equal(payload.receivedSessionId, 'insights-session'); assert.equal(payload.value.rev, 7)
  assert.equal((await call('/api/dsh-context/detail', 'invalid', { sessionId: 'insights-session' })).status, 401)
})
