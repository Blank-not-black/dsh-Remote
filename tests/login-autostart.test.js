'use strict'

// The registry adapter is faked; even on Windows no login entry is installed.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const ROOT = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
const context = vm.createContext({ fs, path, crypto, Buffer })
vm.runInContext(source.slice(source.indexOf('// BEGIN LOGIN AUTOSTART'), source.indexOf('// END LOGIN AUTOSTART')), context)
const create = context.createLoginAutostart
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function fixture(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-login-中文 '空格-"))
  const cleanup = []
  t.after(async () => { for (const fn of cleanup) await fn(); fs.rmSync(home, { recursive: true, force: true }) })
  const sourceDir = path.join(home, 'plugin')
  fs.mkdirSync(path.join(sourceDir, 'public'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'gateway.js'), path.join(sourceDir, 'gateway.cjs'))
  fs.copyFileSync(path.join(ROOT, 'gateway-stats.cjs'), path.join(sourceDir, 'gateway-stats.cjs'))
  fs.writeFileSync(path.join(sourceDir, 'public', 'admin.html'), '<h1>isolated login gateway</h1>')
  fs.writeFileSync(path.join(sourceDir, 'public', 'version.json'), '{"version":"0.8.0-rc.4"}')
  const registry = { value: '', calls: [], fail: false }
  const options = { home, platform: 'win32', executable: process.execPath, script: path.join(sourceDir, 'gateway.cjs'),
    packaged: false, electron: false, sourceDir, env: { TOKEN: 'login-test-token', TOKEN_FILE: path.join(home, '.dsh-remote', 'token'),
      DSH_REMOTE_FS_ROOT: home, DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', DSH_REMOTE_ANNOUNCEMENTS_URL: '',
      DSH_REMOTE_AUTO_RESTART: '0', UPDATE_CHECK_URL: 'http://127.0.0.1:1', UPDATE_PROXY: '',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
      SECRET_UNRELATED: 'never-copy', NODE_OPTIONS: '--inspect', DSH_REMOTE_SUPERVISED: '1', DSH_REMOTE_SUPERVISOR_PID: '999' },
    port: 8787, host: '127.0.0.1', upstream: 'http://127.0.0.1:1',
    run: async code => {
      registry.calls.push(code)
      if (registry.fail) throw Error('denied')
      if (code.includes('.SetValue(')) registry.value = code.match(/\.SetValue\(\$name,'((?:[^']|'')*)'/)[1].replace(/''/g, "'")
      else if (code.includes('.DeleteValue(')) registry.value = ''
      return registry.value
    }, ...overrides }
  return { home, sourceDir, options, registry, manager: create(options), beforeCleanup: fn => cleanup.unshift(fn),
    config: () => JSON.parse(fs.readFileSync(path.join(home, '.dsh-remote', 'autostart', 'launch.json'), 'utf8')) }
}

test('Login startup is opt-in, rejects unsupported platforms and non-boolean changes', async t => {
  const f = fixture(t)
  assert.equal((await f.manager.status()).enabled, false)
  await f.manager.refresh()
  assert.equal(f.registry.calls.length, 1, 'no implicit registration or bundle preparation')
  assert.equal(fs.existsSync(path.join(f.home, '.dsh-remote', 'autostart')), false)
  await assert.rejects(f.manager.change('true'), { code: 'INVALID_ENABLED' })
  const linux = create({ ...f.options, platform: 'linux' })
  assert.equal((await linux.status()).supported, false)
  await assert.rejects(linux.change(true), { code: 'WINDOWS_ONLY' })
})

test('Enable and disable verify registry state; bundle survives plugin removal and excludes unrelated environment', async t => {
  const f = fixture(t)
  assert.equal((await f.manager.change(true)).enabled, true)
  assert.ok(f.registry.value.length <= 260)
  assert.doesNotMatch(f.registry.value, /login-test-token/)
  assert.match(f.registry.value, /-WindowStyle Hidden/)
  const c = f.config()
  assert.equal(c.env.PORT, '8787')
  assert.equal(c.env.TOKEN, 'login-test-token')
  assert.equal(c.env.DSH_UPSTREAM, f.options.upstream)
  for (const key of ['SECRET_UNRELATED', 'NODE_OPTIONS', 'DSH_REMOTE_SUPERVISED', 'DSH_REMOTE_SUPERVISOR_PID']) assert.equal(c.env[key], undefined)
  fs.rmSync(f.sourceDir, { recursive: true })
  assert.equal((await f.manager.status()).enabled, true)
  assert.ok(fs.existsSync(path.join(c.bundle, 'public', 'admin.html')))
  assert.equal((await f.manager.change(false)).enabled, false)
  assert.equal(f.registry.value, '')
})

test('Refresh follows port/config changes, refreshes changed bundles and honors disabling', async t => {
  const f = fixture(t)
  await f.manager.change(true)
  const first = f.config()
  const moved = create({ ...f.options, port: 9876, upstream: 'http://127.0.0.1:3333', electron: true })
  await moved.refresh()
  assert.equal(f.config().bundle, first.bundle)
  assert.equal(f.config().env.PORT, '9876')
  assert.equal(f.config().env.DSH_UPSTREAM, 'http://127.0.0.1:3333')
  assert.equal(f.config().env.ELECTRON_RUN_AS_NODE, '1')
  fs.appendFileSync(f.options.script, '\n// updated plugin\n')
  await moved.refresh()
  assert.notEqual(f.config().bundle, first.bundle)
  await moved.change(false)
  const before = fs.readFileSync(path.join(f.home, '.dsh-remote', 'autostart', 'launch.json'), 'utf8')
  await f.manager.refresh()
  assert.equal(fs.readFileSync(path.join(f.home, '.dsh-remote', 'autostart', 'launch.json'), 'utf8'), before)
})

test('Missing files are reported and can be repaired or disabled; foreign entries and system failures are preserved', async t => {
  const f = fixture(t)
  await f.manager.change(true)
  fs.unlinkSync(f.config().args[0])
  assert.equal((await f.manager.status()).code, 'STARTUP_FILES_MISSING')
  // Repair must rebuild a damaged bundle, even when the source fingerprint is unchanged.
  assert.equal((await f.manager.change(true)).enabled, true)
  assert.equal((await f.manager.status()).code, undefined)
  fs.unlinkSync(f.config().args[0])
  assert.equal((await f.manager.change(false)).enabled, false)
  f.registry.value = 'some-other-application.exe'
  await assert.rejects(f.manager.change(true), { code: 'STARTUP_CONFLICT' })
  await assert.rejects(f.manager.change(false), { code: 'STARTUP_CONFLICT' })
  assert.equal(f.registry.value, 'some-other-application.exe')
  f.registry.value = ''
  f.registry.fail = true
  await assert.rejects(f.manager.change(true), /denied/)
  assert.equal(f.registry.value, '')
})

test('Overlapping settings changes do not register twice', async t => {
  const f = fixture(t)
  const first = f.manager.change(true)
  await assert.rejects(f.manager.change(false), { code: 'STARTUP_BUSY' })
  await first
  assert.equal(f.registry.calls.filter(code => code.includes('.SetValue(')).length, 1)
})

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('Windows login launcher cold-starts independent gateway with DSH offline and no plugin directory', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = fixture(t, { port: await freePort() })
  await f.manager.change(true) // Only the fake registry changes.
  const launcher = path.join(f.home, '.dsh-remote', 'autostart', 'launch.ps1')
  const config = f.config()
  // Parse the real PowerShell registration code, without executing registry operations.
  for (const code of f.registry.calls) {
    const encoded = Buffer.from(code, 'utf8').toString('base64')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$e=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$null,[ref]$e);if($e.Count){exit 1}`], { windowsHide: true })
  }
  fs.rmSync(f.sourceDir, { recursive: true })
  let gatewayPid = null
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher],
    { windowsHide: true, cwd: f.home, env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, stdio: 'ignore' })
  f.beforeCleanup(async () => {
    if (gatewayPid) { try { process.kill(gatewayPid) } catch {} }
    child.kill()
    await Promise.race([once(child, 'exit'), pause(1000)])
    const lease = path.join(f.home, '.dsh-remote', `gateway-supervisor-${config.env.PORT}.json`)
    try { process.kill(JSON.parse(fs.readFileSync(lease)).pid) } catch {}
    await pause(300)
  })
  const base = 'http://127.0.0.1:' + config.env.PORT
  let health
  for (let i = 0; i < 100; i++) {
    try { health = await (await fetch(base + '/health', { signal: AbortSignal.timeout(200) })).json(); if (health.pid) break } catch {}
    await pause(100)
  }
  assert.ok(health?.pid, 'standalone gateway must start from persisted login launcher')
  gatewayPid = health.pid
  assert.equal(health.upstreamReachable, false)
  assert.equal((await fetch(base + '/admin')).status, 200)
  assert.match(await (await fetch(base + '/admin')).text(), /isolated login gateway/)
  assert.equal((await fetch(base + '/admin/api/autostart')).status, 401)
  const headers = { authorization: 'Bearer login-test-token', 'content-type': 'application/json' }
  assert.equal((await fetch(base + '/admin/api/autostart', { method: 'POST', headers, body: '{"enabled":"yes"}' })).status, 400)
  assert.equal((await fetch(base + '/admin/api/autostart', { method: 'POST', headers, body: '{"enabled":true,"command":"evil"}' })).status, 400)
  assert.equal((await fetch(base + '/admin/api/autostart', { method: 'DELETE', headers })).status, 405)
  assert.equal((await fetch(base + '/admin/api/autostart', { method: 'POST', headers, body: 'x'.repeat(1200) })).status, 413)
  const state = await (await fetch(base + '/admin/api/autostart', { headers })).json()
  assert.equal(state.ok, true)
  assert.equal(state.enabled, false, 'the real Windows login entry is never installed by this test')
  assert.doesNotMatch(JSON.stringify(state), /login-test-token|launch.json/)
})
