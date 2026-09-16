'use strict'

// Opt-in integration against the installed DSH, never the user's profile.
// DSH_TEST_CLI_ROOT points to the @deepseek-ai/dsh package directory.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const net = require('node:net')
const crypto = require('node:crypto')

test('installed DSH: isolated Web boot and Remote RPC compatibility', { skip: !process.env.DSH_TEST_CLI_ROOT, timeout: 90000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-installed-'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'), DSH_REMOTE_FS_ROOT: home, DSH_REMOTE_TOKEN: 'installed-dsh-test-token', DSH_REMOTE_AUTOSTART: '0' }
  for (const key of Object.keys(env)) if (/proxy|api[_-]?key|secret/i.test(key)) delete env[key]
  const children = []
  t.after(async () => {
    for (const child of children.reverse()) {
      if (child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const pluginPatch = path.join(home, 'remote.patch.yml')
  fs.writeFileSync(pluginPatch, JSON.stringify([{ insert: [{ id: 'remote-test', name: path.join(__dirname, '../packages/plugin/index.mjs').replace(/\\/g, '/') }] }]))
  const dsh = spawn(process.execPath, [path.join(process.env.DSH_TEST_CLI_ROOT, 'lib/bin.js'), '--profile', 'web', '--patch', pluginPatch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(dsh)
  let logs = ''
  for (const output of [dsh.stdout, dsh.stderr]) output.on('data', chunk => { logs += chunk })
  const deadline = Date.now() + 60000
  let url
  while (Date.now() < deadline && dsh.exitCode === null) {
    url = logs.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*/)?.[0]
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, logs.replace(/(token[=:])[^\s&]+/gi, '$1[redacted]'))
  t.diagnostic('DSH startup URL found')
  const response = await fetch(url, { redirect: 'manual' })
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const pluginPage = await fetch(new URL('/remote/', url), { headers: { cookie } })
  assert.equal(pluginPage.status, 200, 'Remote plugin mounted on the real DSH Web server')
  for (const asset of ['genui.js', 'genui.css', 'md.js']) {
    const served = await fetch(new URL('/remote/' + asset, url), { headers: { cookie } })
    assert.equal(served.status, 200)
    assert.equal(await served.text(), fs.readFileSync(path.join(__dirname, '../public', asset), 'utf8'), 'DSH serves current ' + asset)
  }
  const cookieFile = path.join(home, 'upstream.cookie')
  fs.writeFileSync(cookieFile, cookie, { mode: 0o600 })
  const reserve = net.createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const gateway = spawn(process.execPath, [path.join(__dirname, '../gateway.js')], { cwd: home, env: { ...env, HOST: '127.0.0.1', PORT: String(port), TOKEN: env.DSH_REMOTE_TOKEN, DSH_UPSTREAM: new URL(url).origin, DSH_REMOTE_DSH_COOKIE_FILE: cookieFile, UPDATE_CHECK_URL: 'http://127.0.0.1:1/update.json' }, windowsHide: true, stdio: 'ignore' })
  children.push(gateway)
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(base + '/health')).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready)
  const rpc = async (method, payload = {}) => {
    const res = await fetch(base + '/api/' + method, { method: 'POST', headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-' + method, method, payload }) })
    const body = await res.json()
    assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body)}`)
    return body.result.value
  }
  assert.ok(Array.isArray((await rpc('session.list')).items))
  const created = await rpc('session.create', { cwd: home })
  assert.ok(created.sessionId)
  for (const client of ['public/app.js', 'public/desktop/desktop.js']) {
    const disposable = await rpc('session.create', { cwd: home })
    const clientSource = fs.readFileSync(path.join(__dirname, '..', client), 'utf8')
    const code = clientSource.slice(clientSource.indexOf('const emptySessionCleanup'), clientSource.indexOf('async function openSession'))
    const context = { rpc, state: { current: disposable.sessionId, server: base, byId: new Map([[disposable.sessionId, disposable]]), queues: {} }, $: () => ({ value: '' }), refreshSessions: async () => { await rpc('workspace.list') } }
    require('node:vm').createContext(context)
    require('node:vm').runInContext(code, context)
    assert.equal(await context.archiveEmptySessionOnLeave(disposable.sessionId), true, client + ' archives actual DSH empty history')
    const refreshedWorkspaces = await rpc('workspace.list')
    assert.ok(refreshedWorkspaces.archivedSessionIds.includes(disposable.sessionId), 'cleanup persists after fresh upstream read')
  }
  const command = await fetch(new URL('/remote/api/command', url), { method: 'POST', headers: { cookie, authorization: `Bearer ${env.DSH_REMOTE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: created.sessionId, line: '/remote-compat-unknown' }) })
  const commandResult = await command.json()
  assert.equal(commandResult.ok, true, JSON.stringify(commandResult))
  assert.equal(commandResult.executed, false)
  assert.ok(commandResult.debug.commandNames.length, 'real agents/commands service is available')
  await rpc('session.rename', { sessionId: created.sessionId, title: 'Remote compatibility smoke' })
  const history = await rpc('session.history', { sessionId: created.sessionId, maxMessages: 60 })
  assert.ok(Array.isArray(history.events))
  assert.ok((await rpc('session.models', { sessionId: created.sessionId })).groups.length)
  assert.ok((await rpc('workspace.create', { path: home })).workspace.workspaceId)
  await rpc('settings.describe')
  await rpc('llm.providers')
  const health = await (await fetch(base + '/health')).json()
  t.diagnostic('Verified real DSH: session list/create/rename/history/models, workspace create, settings, providers')
  assert.ok(health.events)
  const polled = await (await fetch(base + '/api/events.poll?kind=mux&since=0', { headers: { authorization: `Bearer ${env.DSH_REMOTE_TOKEN}` } })).json()
  assert.ok(polled.events.some(entry => entry.event.payload.type === 'session/subscribed'), 'real remote.mux session snapshot reached Remote')
  assert.ok(polled.events.some(entry => entry.event.payload.type === 'session/reasoning'), 'new assistant-stream baseline reached Remote')
  const apk = path.join(__dirname, '../apk/dsh-remote.apk')
  if (fs.existsSync(apk)) {
    const downloaded = await fetch(base + '/dsh-remote.apk')
    assert.equal(downloaded.status, 200)
    const digest = crypto.createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex')
    const update = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/update.json')))
    assert.equal(digest, update.sha256, 'APK served by the real gateway matches update.json')
    t.diagnostic('Verified APK download SHA-256 against the published local update manifest')
  }
})
