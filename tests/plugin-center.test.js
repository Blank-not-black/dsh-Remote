'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const modulePromise = import('../packages/plugin/plugin-center.mjs')
const id = '12345678-1234-1234-1234-123456789abc'

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-plugin-center-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const dir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(dir, { recursive: true })
  const manifest = { dependencies: { 'example-plugin': '1.0.0' }, dsh: { profile: { bundles: ['core', 'example-plugin'] } } }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  const pkgDir = path.join(dir, 'node_modules', 'example-plugin')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'example-plugin', version: '1.0.0', dsh: { bundle: { patch: './patch.yml' } } }))
  const profile = { dir, name: 'web', home, cli: path.join(home, 'cli.cjs') }
  return { home, dir, manifest, profile }
}

test('plugin center binds to verified root profile; unknown launch stays read-only', async t => {
  const { detectProfile, createPluginCenter } = await modulePromise
  const { home, dir } = fixture(t)
  const root = path.join(home, 'dsh')
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  const cli = path.join(root, 'lib', 'bin.js'); fs.writeFileSync(cli, '')
  const ctx = { root: { baseUrl: pathToFileURL(dir + path.sep).href } }
  assert.equal(detectProfile(ctx, cli).dir, fs.realpathSync(dir))
  assert.equal(detectProfile(ctx, cli).cli, cli)
  assert.equal(detectProfile({}, cli), null)
  const center = createPluginCenter({}, { profile: null })
  assert.equal((await center.inventory()).writable, false)
  await assert.rejects(center.submit({}), /read-only/)
})

test('plugin operations reject injection, protected packages, stale revisions and non-bundles', async t => {
  const { createPluginCenter } = await modulePromise
  const { profile } = fixture(t)
  let launches = 0
  const center = createPluginCenter({}, { profile, details: async () => ({ bundle: false }), launch: async () => launches++ })
  const revision = (await center.inventory()).revision
  for (const name of ['x & calc', '../x', '--help', 'github:user/repo', 'a@1.0.0', 'a\nb', 'evil\n']) {
    await assert.rejects(center.submit({ id, name, action: 'install', version: '1.0.0', revision }))
  }
  await assert.rejects(center.submit({ id, name: 'dsh-remote-plugin', action: 'remove', revision }), /核心/)
  await assert.rejects(center.submit({ id, name: 'example-plugin', action: 'disable', revision: 'old' }), /刷新/)
  await assert.rejects(center.submit({ id, name: 'other-plugin', action: 'install', version: '1.0.0', revision }), /bundle/)
  assert.equal(launches, 0)
})

test('desktop discovery binds the carrier to the running Electron host and its exact profile', async t => {
  const { detectProfile, createPluginCenter } = await modulePromise
  const { home, dir } = fixture(t)
  const desktop = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(desktop); fs.copyFileSync(path.join(dir, 'package.json'), path.join(desktop, 'package.json'))
  const runtimeDir = path.join(home, 'resources', 'app.asar', 'dsh')
  const hostRoot = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  fs.mkdirSync(path.join(hostRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.0-rc.2' }))
  const hostManifest = path.join(hostRoot, 'package.json')
  const host = { name: '@deepseek-ai/dsh-desktop-host', version: '0.2.0-rc.2' }
  fs.writeFileSync(hostManifest, JSON.stringify(host))
  const entry = path.join(hostRoot, 'lib', 'index.js'), carrier = path.join(hostRoot, 'lib', 'cli.js')
  fs.writeFileSync(entry, ''); fs.writeFileSync(carrier, '')
  const ctx = { root: { baseUrl: pathToFileURL(desktop + path.sep).href } }
  const runtime = { versions: { electron: '40.0.0' }, argv: ['electron', entry, runtimeDir, desktop] }
  const detected = detectProfile(ctx, entry, runtime)
  assert.equal(detected.cli, carrier); assert.equal(detected.cliMode, 'desktop')
  assert.equal((await createPluginCenter(ctx, { profile: detected }).inventory()).writable, true)
  assert.equal(detectProfile(ctx, entry, { ...runtime, versions: {} }).cli, null)
  assert.equal(detectProfile(ctx, entry, { ...runtime, argv: ['electron', entry, runtimeDir, dir] }).cli, null)
  assert.equal(detectProfile(ctx, entry, { ...runtime, argv: ['electron', entry, home, desktop] }).cli, null)
  assert.equal(detectProfile(ctx, carrier, runtime).cli, null)
  fs.writeFileSync(hostManifest, JSON.stringify({ ...host, version: 'other' }))
  assert.equal(detectProfile(ctx, entry, runtime).cli, null)
  fs.writeFileSync(hostManifest, JSON.stringify(host)); fs.unlinkSync(carrier)
  const missing = detectProfile(ctx, entry, runtime)
  assert.equal(missing.cli, null)
  assert.match((await createPluginCenter(ctx, { profile: missing }).inventory()).reason, /桌面安装/)
})

test('desktop CLI uses Electron Node mode and keeps the profile and package arguments separate', async t => {
  const { cliInvocation, createPluginCenter } = await modulePromise
  const { profile } = fixture(t)
  const runtime = { execPath: 'C:/Program Files/DSH/DeepSeek Harness.exe', env: { PATH: 'original' } }
  const args = ['plugin', '--profile', 'desktop', 'add', 'example-plugin@1.0.0', '--ignore-scripts']
  const desktop = cliInvocation('C:/Program Files/DSH/app.asar/cli.js', args, profile.dir, 'desktop', runtime)
  assert.equal(desktop.command, runtime.execPath)
  assert.deepEqual(desktop.args, ['--expose-internals', 'C:/Program Files/DSH/app.asar/cli.js', ...args])
  assert.equal(desktop.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(desktop.env.DSH_HOME, profile.home); assert.equal(desktop.env.npm_config_ignore_scripts, 'true')
  assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(cliInvocation(profile.cli, args, profile.dir, 'node', runtime).env.ELECTRON_RUN_AS_NODE, undefined)
  assert.throws(() => cliInvocation(profile.cli, args, profile.dir, 'shell', runtime), /Unsupported/)
  let launched
  const center = createPluginCenter({}, { profile: { ...profile, cliMode: 'desktop' }, launch: async args => { launched = args } })
  await center.submit({ id, name: 'example-plugin', action: 'disable', revision: (await center.inventory()).revision })
  assert.deepEqual(launched, [profile.dir, profile.cli, id, 'desktop'])
})

test('same operation id is idempotent and concurrent mutations cannot cross the lock', async t => {
  const { createPluginCenter, runWorker } = await modulePromise
  const { profile, dir } = fixture(t)
  let launches = 0
  const center = createPluginCenter({}, { profile, launch: async () => launches++ })
  const revision = (await center.inventory()).revision
  const body = { id, name: 'example-plugin', action: 'disable', revision }
  assert.equal((await center.submit(body)).phase, 'queued')
  await center.submit(body)
  assert.equal(launches, 1)
  await assert.rejects(center.submit({ ...body, action: 'remove' }), /already used/)
  await assert.rejects(center.submit({ ...body, id: id + '2' }), /任务/)
  await runWorker(dir, profile.cli, id)
  const state = await center.inventory()
  assert.equal(state.busy, false)
  assert.equal(state.pendingRestart, true)
  assert.equal(state.items.find(item => item.name === 'example-plugin').enabled, false)
  assert.equal(state.operations[0].phase, 'complete')
  assert.ok(fs.existsSync(path.join(dir, '.remote-plugin-center', 'backup-' + id, 'package.json')))
})

test('update preserves disabled bundles and verifies installed package version', async t => {
  const { createPluginCenter, runWorker } = await modulePromise
  const { profile, dir } = fixture(t)
  const center = createPluginCenter({}, { profile, details: async () => ({ bundle: true }), launch: async () => {} })
  await center.submit({ id, action: 'disable', name: 'example-plugin', revision: (await center.inventory()).revision })
  await runWorker(dir, profile.cli, id)
  await center.submit({ id: id + '2', action: 'update', name: 'example-plugin', version: '2.0.0', revision: (await center.inventory()).revision })
  await runWorker(dir, profile.cli, id + '2', async (cli, args) => {
    assert.ok(args.includes('--ignore-scripts'))
    assert.ok(args.includes('example-plugin@2.0.0'))
    const p = path.join(dir, 'package.json'), data = JSON.parse(fs.readFileSync(p))
    data.dependencies['example-plugin'] = '2.0.0'; data.dsh.profile.bundles.push('example-plugin')
    fs.writeFileSync(p, JSON.stringify(data))
    const installed = path.join(dir, 'node_modules', 'example-plugin', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(installed)); pkg.version = '2.0.0'; fs.writeFileSync(installed, JSON.stringify(pkg))
  })
  const state = await center.inventory()
  assert.equal(state.items.find(row => row.name === 'example-plugin').version, '2.0.0')
  assert.equal(state.items.find(row => row.name === 'example-plugin').enabled, false)
  assert.equal(state.operations[0].phase, 'complete')
})

test('failed install records failure, preserves backup and releases lock without claiming rollback', async t => {
  const { createPluginCenter, runWorker } = await modulePromise
  const { profile, dir } = fixture(t)
  const center = createPluginCenter({}, { profile, details: async () => ({ bundle: true }), launch: async () => {} })
  await center.submit({ id, action: 'install', name: 'new-plugin', version: '1.0.0', revision: (await center.inventory()).revision })
  await runWorker(dir, profile.cli, id, async () => { throw new Error('registry unavailable') })
  const state = await center.inventory()
  assert.equal(state.operations[0].phase, 'failed')
  assert.equal(state.operations[0].message, 'registry unavailable')
  assert.equal(state.busy, false)
  assert.ok(fs.existsSync(path.join(dir, '.remote-plugin-center', 'backup-' + id, 'package.json')))
})

test('real detached worker persists results across manager recreation', async t => {
  const { createPluginCenter } = await modulePromise
  const { profile } = fixture(t)
  const center = createPluginCenter({}, { profile })
  await center.submit({ id, name: 'example-plugin', action: 'disable', revision: (await center.inventory()).revision })
  const reopened = createPluginCenter({}, { profile })
  let state
  for (let i = 0; i < 100; i++) {
    state = await reopened.inventory()
    if (state.operations[0]?.phase === 'complete') break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(state.operations[0]?.phase, 'complete')
  assert.equal(state.items.find(item => item.name === 'example-plugin').enabled, false)
})

test('worker refuses a profile changed after operation acceptance', async t => {
  const { createPluginCenter, runWorker } = await modulePromise
  const { profile, dir, manifest } = fixture(t)
  const center = createPluginCenter({}, { profile, launch: async () => {} })
  await center.submit({ id, name: 'example-plugin', action: 'remove', revision: (await center.inventory()).revision })
  manifest.description = 'changed outside Remote'
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  let executed = false
  await runWorker(dir, profile.cli, id, async () => { executed = true })
  assert.equal(executed, false)
  assert.equal((await center.inventory()).operations[0].phase, 'failed')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).description, manifest.description)
})

test('crashed worker recovery waits for its live CLI child and preserves partial changes', async t => {
  const { createPluginCenter } = await modulePromise
  const { profile, dir } = fixture(t)
  fs.writeFileSync(profile.cli, `const fs = require('node:fs'); const p = 'package.json'; const data = JSON.parse(fs.readFileSync(p)); data.description = 'partially changed'; fs.writeFileSync(p, JSON.stringify(data)); setInterval(() => {}, 1000)`)
  let worker, cliPid
  t.after(async () => {
    if (worker?.exitCode === null && worker?.signalCode === null) { const done = once(worker, 'exit'); worker.kill(); await done }
    if (cliPid) { try { process.kill(cliPid) } catch {} }
  })
  const env = { ...process.env, HOME: profile.home, USERPROFILE: profile.home, DSH_HOME: profile.home, DSH_REMOTE_FS_ROOT: profile.home, TOKEN: 'plugin-worker-test-token' }
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key]
  const center = createPluginCenter({}, { profile, details: async () => ({ bundle: true }), launch: async args => {
    worker = spawn(process.execPath, [path.join(__dirname, '../packages/plugin/plugin-center.mjs'), '--worker', ...args], { env, stdio: 'ignore' })
    await once(worker, 'spawn'); return worker.pid
  } })
  await center.submit({ id, action: 'update', name: 'example-plugin', version: '2.0.0', revision: (await center.inventory()).revision })
  const lockPath = path.join(dir, '.remote-plugin-center', 'lock.json')
  for (let i = 0; i < 100; i++) {
    const owner = JSON.parse(fs.readFileSync(lockPath))
    if (owner.cliPid && JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).description === 'partially changed') { cliPid = owner.cliPid; break }
    await new Promise(r => setTimeout(r, 30))
  }
  assert.ok(cliPid)
  // Some Windows runners terminate descendants with their parent. A known live
  // process recorded as CLI owner exercises the same conservative liveness gate.
  const owner = JSON.parse(fs.readFileSync(lockPath))
  fs.writeFileSync(lockPath, JSON.stringify({ ...owner, cliPid: process.pid }))
  const exited = once(worker, 'exit'); worker.kill(); await exited
  const reopened = createPluginCenter({}, { profile })
  assert.equal((await reopened.inventory()).busy, true, 'a live package-manager process must keep its lock')
  try { process.kill(cliPid) } catch (error) { if (error.code !== 'ESRCH') throw error }
  fs.writeFileSync(lockPath, JSON.stringify({ ...owner, cliPid }))
  let state
  for (let i = 0; i < 100; i++) {
    state = await reopened.inventory()
    if (!state.busy) break
    await new Promise(r => setTimeout(r, 30))
  }
  assert.equal(state.busy, false)
  assert.equal(state.operations[0].phase, 'interrupted')
  assert.match(state.operations[0].message, /未执行自动回滚/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).description, 'partially changed')
  const next = createPluginCenter({}, { profile, launch: async () => {} })
  assert.equal((await next.submit({ id: id + '2', action: 'disable', name: 'example-plugin', revision: state.revision })).phase, 'queued')
})

test('legacy locks are recoverable only with the matching lock, revision and explicit process acknowledgement', async t => {
  const { createPluginCenter, runWorker } = await modulePromise
  const { profile, dir } = fixture(t)
  const center = createPluginCenter({}, { profile, launch: async () => {} })
  const initial = await center.inventory()
  await center.submit({ id, action: 'disable', name: 'example-plugin', revision: initial.revision })
  const lock = path.join(dir, '.remote-plugin-center', 'lock.json')
  await assert.rejects(center.handle('POST', '/recover', { id, revision: initial.revision, confirmNoRunningProcess: true }), /旧任务锁/)
  fs.writeFileSync(lock, JSON.stringify({ id }))
  const state = await center.inventory()
  assert.equal(state.busy, true)
  assert.equal(state.recovery.id, id)
  await assert.rejects(center.handle('POST', '/recover', { id, revision: state.revision }), /主机确认/)
  await assert.rejects(center.handle('POST', '/recover', { id: id + '2', revision: state.revision, confirmNoRunningProcess: true }), /旧任务锁/)
  await assert.rejects(center.handle('POST', '/recover', { id, revision: 'stale', confirmNoRunningProcess: true }), /刷新/)
  assert.ok(fs.existsSync(lock))
  await center.handle('POST', '/recover', { id, revision: state.revision, confirmNoRunningProcess: true })
  assert.equal((await center.inventory()).busy, false)
  assert.equal((await center.inventory()).operations[0].phase, 'interrupted')
  assert.ok(fs.existsSync(path.join(dir, '.remote-plugin-center', 'recovered-lock-' + id + '.json')))
  await center.submit({ id: id + '2', action: 'disable', name: 'example-plugin', revision: state.revision })
  await runWorker(dir, profile.cli, id + '2')
  assert.equal((await center.inventory()).items.find(item => item.name === 'example-plugin').enabled, false)
})
