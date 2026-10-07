'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net')
const { spawn } = require('node:child_process'), { once } = require('node:events')
test('installed DSH: real dsh-context and cost-meter read through isolated Remote', { skip: !process.env.DSH_TEST_CLI_ROOT || !process.env.DSH_TEST_INSIGHTS_ROOT, timeout: 90000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-installed-')), children = []
  const env = { ...process.env }; for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_|GATEWAY_|UPDATE_)/.test(key)) delete env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_TOKEN: 'installed-insights-test-only', TOKEN: 'installed-insights-test-only',
    DSH_REMOTE_DSH_COOKIE_FILE: path.join(home, 'cookie'), DSH_REMOTE_ANNOUNCEMENTS_URL: '', UPDATE_CHECK_URL: 'http://127.0.0.1:1/update' })
  t.after(async () => { for (const child of children.reverse()) if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done } fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const patch = path.join(home, 'insights.patch.yml')
  const source = name => path.resolve(process.env.DSH_TEST_INSIGHTS_ROOT, name, 'package/lib/index.js').replace(/\\/g, '/')
  fs.writeFileSync(patch, JSON.stringify([{ insert: [
    { id: 'context-test', name: source('dsh-context') },
    { id: 'cost-test', name: source('dsh-cost-meter') },
    { id: 'remote-test', name: path.join(root, 'packages/plugin/index.mjs').replace(/\\/g, '/') },
  ] }]))
  const dsh = spawn(process.execPath, [path.join(process.env.DSH_TEST_CLI_ROOT, 'lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(dsh); let logs = ''
  for (const pipe of [dsh.stdout, dsh.stderr]) pipe.on('data', b => { logs += b })
  let url
  for (let i = 0; i < 600 && dsh.exitCode === null; i++) { url = logs.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*/)?.[0]; if (url) break; await new Promise(r => setTimeout(r, 100)) }
  assert.ok(url, logs.replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
  const login = await fetch(url, { redirect: 'manual' }); assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); fs.writeFileSync(env.DSH_REMOTE_DSH_COOKIE_FILE, cookie)
  const reserve = net.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r))
  const base = 'http://127.0.0.1:' + port
  const gateway = spawn(process.execPath, [path.join(root, 'gateway.js')], { cwd: home, env: { ...env, HOST: '127.0.0.1', PORT: String(port), DSH_UPSTREAM: new URL(url).origin }, windowsHide: true, stdio: 'ignore' }); children.push(gateway)
  let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + '/health')).ok } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)) } assert.ok(ready)
  const headers = { authorization: 'Bearer ' + env.TOKEN, 'content-type': 'application/json' }
  const rpc = async (method, payload) => {
    const response = await fetch(base + '/api/' + method, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload }) })
    const data = await response.json(); assert.equal(data.result?.ok, true, JSON.stringify(data)); return data.result.value
  }
  const created = await rpc('session.create', { cwd: home }); assert.ok(created.sessionId)
  const details = await fetch(base + '/api/dsh-context/detail', { method: 'POST', headers, body: JSON.stringify({ sessionId: created.sessionId }) })
  assert.equal(details.status, 200); const detail = await details.json(); assert.equal(detail.ok, true); assert.ok(detail.value?.head?.current)
  const cost = await fetch(base + '/remote/api/insights/cost?sessionId=' + encodeURIComponent(created.sessionId), { headers })
  assert.equal(cost.status, 200); const text = await cost.text(), data = JSON.parse(text)
  assert.equal(data.available, true); assert.equal(data.today.apiCost, 0); assert.equal(data.source, 'dsh-cost-meter')
  assert.doesNotMatch(text, /apiKey|accessKey|headers|baseUrl|config|keySource/)
  for (const file of ['insights.js', 'insights.css']) assert.equal((await fetch(base + '/' + file)).status, 200)
  t.diagnostic('Real DSH 0.2.0-rc.2, dsh-context 0.64.0 and dsh-cost-meter 1.8.12; temporary HOME only, no model calls.')
})
