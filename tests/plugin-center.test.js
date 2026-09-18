'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
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
