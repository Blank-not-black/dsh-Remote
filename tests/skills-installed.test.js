'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net')
const { spawn } = require('node:child_process'), { once } = require('node:events')
test('installed DSH and published skill explorer serve scoped read-only skills through Remote', { skip: !process.env.DSH_TEST_CLI_ROOT || !process.env.DSH_TEST_SKILL_EXPLORER_MODULE, timeout: 90000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-installed-')), children = []
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key) || /^(TOKEN|TOKEN_FILE|DSH_|GATEWAY_|UPDATE_)/.test(key)) delete env[key]
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_AGENTS_HOME: path.join(home, '.agents'), DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_TOKEN: 'skills-installed-test-only', TOKEN: 'skills-installed-test-only',
    DSH_REMOTE_DSH_COOKIE_FILE: path.join(home, 'cookie'), DSH_REMOTE_ANNOUNCEMENTS_URL: '', UPDATE_CHECK_URL: 'http://127.0.0.1:1/update' })
  t.after(async () => { for (const child of children.reverse()) if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done } fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const skillDir = path.join(env.DSH_HOME, 'skills', 'remote-test-skill'); fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: remote-test-skill\ndescription: Isolated skill for Remote test\ndisable-model-invocation: true\n---\n# Remote test\n<script>this is text</script>')
  const patch = path.join(home, 'skills.patch.json')
  const hostPackage = path.join(home, 'remote-host'); fs.mkdirSync(hostPackage)
  for (const file of ['index.mjs', 'plugin-center.mjs', 'insights.mjs', 'skills.mjs', 'session-file.mjs']) fs.copyFileSync(path.join(root, 'packages/plugin', file), path.join(hostPackage, file))
  // Test the host chain independently of client-module packaging; avoid the
  // source repository's root dsh.client metadata when the loader resolves paths.
  fs.writeFileSync(path.join(hostPackage, 'package.json'), JSON.stringify({ name: 'remote-skills-host-test', type: 'module' }))
  const nativePackage = path.join(home, 'native-skills'); fs.mkdirSync(nativePackage)
  fs.writeFileSync(path.join(nativePackage, 'package.json'), JSON.stringify({ name: 'native-skills-host-test', type: 'module' }))
  fs.copyFileSync(require('node:url').fileURLToPath(process.env.DSH_TEST_SKILL_EXPLORER_MODULE), path.join(nativePackage, 'index.mjs'))
  const native = path.join(nativePackage, 'index.mjs').replace(/\\/g, '/')
  fs.writeFileSync(patch, JSON.stringify([{ insert: [{ id: 'native-skills-test', name: native }, { id: 'remote-skills-test', name: path.join(hostPackage, 'index.mjs').replace(/\\/g, '/') }] }]))
  const dsh = spawn(process.execPath, [path.join(process.env.DSH_TEST_CLI_ROOT, 'lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(dsh); let logs = ''
  for (const pipe of [dsh.stdout, dsh.stderr]) pipe.on('data', chunk => { logs += chunk })
  let url
  for (let i = 0; i < 500 && dsh.exitCode === null; i++) { url = logs.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*/)?.[0]; if (url) break; await new Promise(r => setTimeout(r, 100)) }
  assert.ok(url, logs.replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
  const login = await fetch(url, { redirect: 'manual' }); assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); fs.writeFileSync(env.DSH_REMOTE_DSH_COOKIE_FILE, cookie)
  const reserve = net.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r))
  const base = 'http://127.0.0.1:' + port
  const gateway = spawn(process.execPath, [path.join(root, 'gateway.js')], { cwd: home, env: { ...env, HOST: '127.0.0.1', PORT: String(port), DSH_UPSTREAM: new URL(url).origin }, windowsHide: true, stdio: 'ignore' }); children.push(gateway)
  let ready = false; for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + '/health')).ok } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)) } assert.ok(ready)
  const headers = { authorization: 'Bearer ' + env.TOKEN }
  const result = await fetch(base + '/remote/api/skills/list', { headers }), listed = await result.json()
  assert.equal(result.status, 200, JSON.stringify(listed)); assert.equal(listed.available, true, JSON.stringify(listed))
  const skill = listed.items.find(row => row.name === 'remote-test-skill'); assert.ok(skill); assert.equal(skill.modelInvocable, false)
  const detail = await fetch(base + '/remote/api/skills/read?id=' + skill.id, { headers }); assert.equal(detail.status, 200)
  assert.match((await detail.json()).content, /# Remote test/)
  assert.equal((await fetch(base + '/remote/api/skills/read?path=private', { headers })).status, 400)
  assert.equal((await fetch(base + '/remote/api/skills/list', { method: 'POST', headers })).status, 405)
  t.diagnostic('Real DSH CLI + published skill explorer 0.4.6 + Remote host adapter and gateway; temporary HOME, no model calls. Client composition excluded.')
})
