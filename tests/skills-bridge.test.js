'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net')
const { spawn } = require('node:child_process'), { once } = require('node:events')
async function port() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p }
test('skills: actual gateway and Remote bridge authorize device reads and reject paths and writes', { timeout: 20000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-bridge-')), children = []
  const upstreamPort = await port(), gatewayPort = await port(), base = 'http://127.0.0.1:' + gatewayPort, token = 'skills-bridge-test-only'
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_|GATEWAY_|UPDATE_)/.test(key)) delete env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home, TOKEN: token, DSH_REMOTE_TOKEN: token,
    HOST: '127.0.0.1', PORT: String(gatewayPort), TEST_UPSTREAM_PORT: String(upstreamPort), DSH_UPSTREAM: 'http://127.0.0.1:' + upstreamPort,
    DSH_REMOTE_GATEWAY: base, DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', DSH_REMOTE_ANNOUNCEMENTS_URL: '',
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update', DSH_REMOTE_DSH_COOKIE_FILE: path.join(home, 'cookie'),
    ...(process.env.DSH_TEST_SKILL_EXPLORER_MODULE ? { DSH_TEST_SKILL_EXPLORER_MODULE: process.env.DSH_TEST_SKILL_EXPLORER_MODULE } : {}) })
  const skillDir = path.join(env.DSH_HOME, 'skills', 'test-skill'); fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: Test skill\n---\n# Skill body\n<script>display as text</script>')
  fs.writeFileSync(env.DSH_REMOTE_DSH_COOKIE_FILE, 'skills-test=session')
  t.after(async () => { for (const c of children.reverse()) if (c.exitCode === null) { const done = once(c, 'exit'); c.kill(); await done } fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  for (const file of ['tests/fixtures/skills-upstream.mjs', 'gateway.js']) children.push(spawn(process.execPath, [path.join(root, file)], { cwd: home, env, windowsHide: true, stdio: 'ignore' }))
  for (const url of [env.DSH_UPSTREAM, base + '/health']) { let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(url, { signal: AbortSignal.timeout(300) })).ok } catch {} if (ready) break; await new Promise(r => setTimeout(r, 40)) } assert.ok(ready, url) }
  const call = (route, key = token, body) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const created = await (await call('/admin/api/device-keys/create', token, { note: 'skills-test' })).json(); await call('/admin/api/device-keys/mode', token, { enabled: true })
  const device = created.entry.token
  assert.equal((await call('/remote/api/skills/list', 'invalid')).status, 401)
  const response = await call('/remote/api/skills/list', device); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  const listed = await response.json(); assert.equal(listed.available, true); assert.equal(listed.items[0].name, 'test-skill'); assert.doesNotMatch(JSON.stringify(listed), /SKILL\.md/); assert.equal('path' in listed.items[0], false)
  const detail = await (await call('/remote/api/skills/read?id=' + listed.items[0].id, device)).json(); assert.match(detail.content, /Skill body/)
  assert.equal((await call('/remote/api/skills/read?path=C:/private', device)).status, 400)
  assert.equal((await call('/remote/api/skills/list', device, { action: 'delete' })).status, 405)
  for (const file of ['skills.js', 'skills.css']) assert.equal((await fetch(base + '/' + file)).status, 200)
  t.diagnostic(process.env.DSH_TEST_SKILL_EXPLORER_MODULE ? 'Published skill-explorer host module mounted; temporary skill files only.' : 'Contract fixture; run with DSH_TEST_SKILL_EXPLORER_MODULE for actual published plugin.')
})
