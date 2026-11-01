'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const modulePromise = import('../packages/plugin/plugin-transaction.mjs'), centerPromise = import('../packages/plugin/plugin-center.mjs')
const id = 'transaction-test-1234567890'
function lock(dependencies) {
  return "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n" + Object.entries(dependencies).map(([name, version]) => `      '${name}':\n        specifier: ${version}\n        version: ${version}\n`).join('')
    + 'packages:\n' + Object.entries(dependencies).map(([name, version]) => `  '${name}@${version}': {}\n`).join('')
}
async function fixture(t, workspace = 'minimumReleaseAge: 1440\n') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-transaction-')), dir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(dir, { recursive: true })
  const previous = { ...process.env }
  for (const key of Object.keys(process.env)) if (/proxy|^npm_config_minimum_release_age/i.test(key)) delete process.env[key]
  Object.assign(process.env, { HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_REMOTE_FS_ROOT: home, TOKEN: 'transaction-test-token' })
  t.after(() => { for (const key of Object.keys(process.env)) if (!Object.hasOwn(previous, key)) delete process.env[key]; Object.assign(process.env, previous); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const manifest = { dependencies: { 'example-plugin': '1.0.0', 'dsh-remote-plugin': '0.8.0-rc.4' }, dsh: { profile: { bundles: ['example-plugin', 'dsh-remote-plugin'] } } }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock(manifest.dependencies))
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspace)
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const pkg = path.join(dir, 'node_modules', name); fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: { patch: './patch.yml' } } }))
    fs.writeFileSync(path.join(pkg, 'code.js'), 'original ' + name)
  }
  const profile = { dir, home, name: 'web', cli: path.join(home, 'cli.cjs') }
  const publishedTimes = async () => ({ '1.0.0': '2020-01-01T00:00:00Z', '2.0.0': new Date(Date.now() - 60000).toISOString(), '0.8.0-rc.4': new Date(Date.now() - 60000).toISOString() })
  const { createPluginCenter } = await centerPromise
  const center = createPluginCenter({}, { profile, publicationTimes: publishedTimes, details: async () => ({ bundle: true }), launch: async () => {} })
  const body = { id, action: 'update', name: 'example-plugin', version: '2.0.0', revision: (await center.inventory()).revision }
  const plan = (await center.preflight(body)).plan
  return { dir, home, profile, center, manifest, body: { ...body, preflightKey: plan.key }, plan }
}
function install(dir, version = '2.0.0') {
  const file = path.join(dir, 'package.json'), manifest = JSON.parse(fs.readFileSync(file))
  manifest.dependencies['example-plugin'] = version; fs.writeFileSync(file, JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock(manifest.dependencies))
  const pkg = path.join(dir, 'node_modules', 'example-plugin', 'package.json'), data = JSON.parse(fs.readFileSync(pkg)); data.version = version; fs.writeFileSync(pkg, JSON.stringify(data))
  fs.writeFileSync(path.join(dir, 'node_modules', 'example-plugin', 'code.js'), 'new code')
}
function installBatchTarget(dir, args) {
  const spec = args[args.indexOf('add') + 1], at = spec.lastIndexOf('@'), name = spec.slice(0, at), version = spec.slice(at + 1)
  const file = path.join(dir, 'package.json'), manifest = JSON.parse(fs.readFileSync(file))
  manifest.dependencies[name] = version
  if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
  fs.writeFileSync(file, JSON.stringify(manifest)); fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock(manifest.dependencies))
  const pkg = path.join(dir, 'node_modules', name, 'package.json'), data = JSON.parse(fs.readFileSync(pkg))
  data.version = version; fs.writeFileSync(pkg, JSON.stringify(data))
}
async function batch(h, targets = [{ name: 'dsh-remote-plugin', version: '0.8.1' }, { name: 'example-plugin', version: '2.0.0' }]) {
  const body = { id, name: 'all-plugins', action: 'update-all', targets, revision: (await h.center.inventory()).revision, confirmSelfUpdate: true }
  const plan = (await h.center.preflight(body)).plan
  return { body: { ...body, preflightKey: plan.key }, plan }
}

test('batch preflight includes every exact target in release-age consent and binds the entire list', async t => {
  const h = await fixture(t)
  const { body, plan } = await batch(h, [{ name: 'example-plugin', version: '2.0.0' }])
  assert.ok(plan.blockers.some(row => row.name === 'example-plugin' && row.version === '2.0.0'))
  assert.ok(plan.blockers.some(row => row.name === 'dsh-remote-plugin'), 'the whole old lockfile is still checked')
  assert.equal(plan.workspace, undefined, 'private configuration is not returned')
  await assert.rejects(h.center.handle('POST', '/operations', body), /明确批准/)
  await assert.rejects(h.center.handle('POST', '/operations', { ...body, confirmReleasePolicy: true, targets: [{ name: 'example-plugin', version: '3.0.0' }] }), /完整预检列表/)
  await assert.rejects(h.center.handle('POST', '/operations', { ...body, preflightKey: undefined }), /先预检/)
  assert.equal((await h.center.inventory()).operations.length, 0)
})

test('batch rejects local, core, missing, duplicate, non-plugin, downgrade and incomparable targets before launch', async t => {
  const h = await fixture(t, 'minimumReleaseAge: 0\n')
  for (const targets of [[], [{ name: 'missing', version: '2.0.0' }], [{ name: '@deepseek-ai/core', version: '2.0.0' }],
    [{ name: 'example-plugin', version: '1.0.0' }], [{ name: 'example-plugin', version: '0.9.9' }],
    [{ name: 'example-plugin', version: '2.0.0' }, { name: 'example-plugin', version: '3.0.0' }], [{ name: 'example-plugin', version: '2.0.0;bad' }]]) {
    await assert.rejects(batch(h, targets))
  }
  h.manifest.dependencies['example-plugin'] = 'file:../example.tgz'; fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify(h.manifest))
  await assert.rejects(batch(h, [{ name: 'example-plugin', version: '2.0.0' }]), /registry/)
  h.manifest.dependencies['example-plugin'] = '1.0.0'; fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify(h.manifest))
  const pkg = path.join(h.dir, 'node_modules', 'example-plugin', 'package.json')
  fs.writeFileSync(pkg, JSON.stringify({ version: 'custom-build', dsh: { bundle: { patch: 'patch.yml' } } }))
  await assert.rejects(batch(h, [{ name: 'example-plugin', version: '2.0.0' }]), /未知版本/)
  fs.writeFileSync(pkg, JSON.stringify({ version: '1.0.0' }))
  h.manifest.dsh.profile.bundles = ['dsh-remote-plugin']; fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify(h.manifest))
  await assert.rejects(batch(h, [{ name: 'example-plugin', version: '2.0.0' }]), /registry/)
})

test('batch runs sequentially with Remote last, preserves disabled state and supports identical request retry', async t => {
  const h = await fixture(t, 'minimumReleaseAge: 0\n'), { runWorker } = await centerPromise
  h.manifest.dsh.profile.bundles = ['dsh-remote-plugin']; fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify(h.manifest))
  const { body, plan } = await batch(h)
  assert.deepEqual(plan.targets.map(row => row.name), ['example-plugin', 'dsh-remote-plugin'])
  await assert.rejects(h.center.handle('POST', '/operations', { ...body, confirmSelfUpdate: false }), /Remote 本体/)
  await h.center.handle('POST', '/operations', body)
  const calls = []
  await runWorker(h.dir, h.profile.cli, id, async (cli, args, dir) => {
    const job = (await h.center.inventory()).operations[0]
    assert.equal(job.targets[calls.length].phase, 'running')
    if (calls.length) assert.equal(job.targets[0].phase, 'complete')
    calls.push(args[args.indexOf('add') + 1]); assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--save-exact'))
    installBatchTarget(dir, args)
  })
  assert.deepEqual(calls, ['example-plugin@2.0.0', 'dsh-remote-plugin@0.8.1'])
  const state = await h.center.inventory(), job = state.operations[0]
  assert.equal(job.phase, 'complete', job.message); assert.ok(job.targets.every(row => row.phase === 'complete'))
  assert.equal(state.items.find(row => row.name === 'example-plugin').enabled, false)
  assert.ok(fs.existsSync(path.join(h.dir, '.remote-plugin-center', 'backup-' + id, 'transaction.json')))
  assert.equal((await h.center.handle('POST', '/operations', body)).operation.id, id)
  await assert.rejects(h.center.handle('POST', '/operations', { ...body, targets: body.targets.slice(1) }), /id already used/)
})

test('batch stops on partial failure and guarded restore undoes all earlier successful updates', async t => {
  const h = await fixture(t, 'minimumReleaseAge: 0\n'), { runWorker } = await centerPromise
  const manifestPath = path.join(h.dir, 'package.json')
  h.manifest.dependencies['zebra-plugin'] = '1.0.0'; h.manifest.dsh.profile.bundles.push('zebra-plugin')
  fs.mkdirSync(path.join(h.dir, 'node_modules', 'zebra-plugin'))
  fs.writeFileSync(path.join(h.dir, 'node_modules', 'zebra-plugin', 'package.json'), JSON.stringify({ version: '1.0.0', dsh: { bundle: { patch: './patch.yml' } } }))
  fs.writeFileSync(manifestPath, JSON.stringify(h.manifest)); fs.writeFileSync(path.join(h.dir, 'pnpm-lock.yaml'), lock(h.manifest.dependencies))
  const { body } = await batch(h, [{ name: 'example-plugin', version: '2.0.0' }, { name: 'zebra-plugin', version: '2.0.0' }, { name: 'dsh-remote-plugin', version: '0.8.1' }])
  await h.center.handle('POST', '/operations', body)
  let calls = 0
  await runWorker(h.dir, h.profile.cli, id, async (cli, args, dir) => {
    if (++calls === 2) throw new Error('fixture second install failed')
    installBatchTarget(dir, args)
  })
  const job = (await h.center.inventory()).operations[0]
  assert.equal(calls, 2); assert.equal(job.phase, 'failed'); assert.equal(job.canRestore, true)
  assert.deepEqual(job.targets.map(row => row.phase), ['complete', 'failed', 'interrupted'])
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).dependencies['example-plugin'], '2.0.0')
  const restoreId = id + '-restore'
  await h.center.submit({ id: restoreId, name: 'all-plugins', action: 'restore', restoreFrom: id, confirmRestore: true, revision: (await h.center.inventory()).revision })
  await runWorker(h.dir, h.profile.cli, restoreId, async () => assert.fail('restoration must not install'))
  assert.equal((await h.center.inventory()).operations[0].phase, 'complete')
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath)).dependencies, h.manifest.dependencies)
})

test('accepted batch finishes in a real detached worker after the manager is recreated', async t => {
  const h = await fixture(t, 'minimumReleaseAge: 0\n'), { createPluginCenter } = await centerPromise
  fs.writeFileSync(h.profile.cli, `const fs = require('node:fs'), path = require('node:path');\n${lock.toString()}\n${installBatchTarget.toString()}\nif (!process.argv.includes('--ignore-scripts')) process.exit(2);\ninstallBatchTarget(process.cwd(), process.argv.slice(2));\n`)
  let center = createPluginCenter({}, { profile: h.profile, details: async () => ({ bundle: true }) })
  const { body } = await batch({ ...h, center })
  await center.handle('POST', '/operations', body)
  center = createPluginCenter({}, { profile: h.profile })
  const deadline = Date.now() + 15000
  let state
  do {
    state = await center.inventory()
    if (!state.busy && state.operations[0]?.phase === 'complete') break
    if (!state.busy && state.operations[0]?.phase === 'failed') assert.fail(state.operations[0].message + '\n' + state.operations[0].log)
    await new Promise(resolve => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  const workerLog = path.join(h.dir, '.remote-plugin-center', 'worker-' + id + '.log')
  assert.equal(state.operations[0].phase, 'complete', JSON.stringify(state.operations[0]) + '\n' + (fs.existsSync(workerLog) ? fs.readFileSync(workerLog, 'utf8') : 'No worker startup log'))
  assert.ok(state.operations[0].targets.every(target => target.phase === 'complete'))
  assert.equal(state.items.find(item => item.name === 'example-plugin').version, '2.0.0')
  assert.equal(state.items.find(item => item.name === 'dsh-remote-plugin').version, '0.8.1')
})

test('precise rule merging preserves unrelated settings and handles scoped/prerelease duplicate unions', async () => {
  const { mergeReleaseRules, releasePolicy } = await modulePromise
  const raw = 'packages:\r\n  - .\r\nminimumReleaseAge: 1440\r\nminimumReleaseAgeExclude:\r\n  - dsh-remote-plugin@0.7.6 || 0.8.0-rc.2\r\n  - dsh-remote-plugin@0.8.0-rc.4\r\n  - "@scope/plugin@1.0.0"\r\nnodeLinker: hoisted\r\n'
  const merged = mergeReleaseRules(raw, [{ name: '@scope/plugin', version: '1.0.1' }])
  assert.match(merged.raw, /0.7.6 \|\| 0.8.0-rc.2 \|\| 0.8.0-rc.4/)
  assert.match(merged.raw, /@scope\/plugin@1.0.0 \|\| 1.0.1/)
  assert.equal((merged.raw.match(/  - "dsh-remote-plugin@/g) || []).length, 1)
  assert.match(merged.raw, /minimumReleaseAge: 1440\r\n/); assert.match(merged.raw, /nodeLinker: hoisted\r\n/)
  assert.equal(releasePolicy(merged.raw, {}).minutes, 1440)
  assert.equal(mergeReleaseRules(merged.raw).raw, merged.raw)
  for (const source of ['minimumReleaseAgeExclude: [bad]\n', 'minimumReleaseAgeExclude:\n  - dsh-*@1.0.0\n', 'minimumReleaseAgeExclude:\n  - x@^1.0.0\n', 'minimumReleaseAge: -1\n', 'minimumReleaseAge: 0\nminimumReleaseAge: 2\n']) assert.throws(() => releasePolicy(source, {}))
  assert.throws(() => mergeReleaseRules('minimumReleaseAgeExclude:\n  - x@1.0.0\n  - x\n'), /混用/)
  assert.throws(() => releasePolicy('', { npm_config_minimum_release_age: '0' }), /环境变量/)
})

test('lockfile inspection includes unrelated packages and rejects unsupported identities', async () => {
  const { lockPackages } = await modulePromise
  assert.deepEqual(lockPackages(lock({ 'example-plugin': '1.0.0', '@scope/plugin': '1.0.0-rc.1' })), [{ name: 'example-plugin', version: '1.0.0' }, { name: '@scope/plugin', version: '1.0.0-rc.1' }])
  assert.throws(() => lockPackages('packages:\n  git+https://example.test/a: {}\n'))
  assert.deepEqual(lockPackages('packages: {}\n'), [])
})

test('large preflight budgets scale by batches, stay bounded and abort all lookups on failure', async t => {
  const h = await fixture(t), { prepareReleasePlan } = await modulePromise
  const original = global.setTimeout, budgets = []
  global.setTimeout = (fn, ms, ...args) => { budgets.push(ms); return original(fn, ms, ...args) }
  t.after(() => { global.setTimeout = original })
  const dependencies = Object.fromEntries(Array.from({ length: 182 }, (_, i) => ['fixture-dependency-' + i, '1.0.0']))
  fs.writeFileSync(path.join(h.dir, 'pnpm-lock.yaml'), lock(dependencies))
  let active = 0, peak = 0, calls = 0
  await prepareReleasePlan(h.dir, { action: 'remove', name: 'example-plugin' }, async () => {
    calls++; active++; peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve)); active--
    return { '1.0.0': '2020-01-01T00:00:00Z' }
  }, {})
  assert.equal(calls, 182); assert.equal(peak, 6); assert.equal(budgets[0], 120000)
  let signal
  await assert.rejects(prepareReleasePlan(h.dir, { action: 'remove', name: 'example-plugin' }, async (name, current) => {
    signal = current; throw new Error('fixture failure')
  }, {}), /fixture failure/)
  assert.equal(signal.aborted, true)
})

test('local tarball lock entries are exempt from registry-age lookup but their installed versions are verified', async t => {
  const h = await fixture(t), { lockPackages, verifyInstalled, prepareReleasePlan } = await modulePromise
  const manifest = { dependencies: { 'example-plugin': 'file:D:/fixtures/example.tgz', 'dsh-remote-plugin': '0.8.0-rc.4' }, dsh: h.manifest.dsh }
  fs.writeFileSync(path.join(h.dir, 'package.json'), JSON.stringify(manifest))
  const raw = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      example-plugin:\n        specifier: file:D:/fixtures/example.tgz\n        version: file:D:/fixtures/example.tgz\n      dsh-remote-plugin:\n        specifier: 0.8.0-rc.4\n        version: 0.8.0-rc.4\npackages:\n  'example-plugin@file:D:/fixtures/example.tgz':\n    resolution: {tarball: file:D:/fixtures/example.tgz}\n    version: 1.0.0\n  dsh-remote-plugin@0.8.0-rc.4: {}\n"
  fs.writeFileSync(path.join(h.dir, 'pnpm-lock.yaml'), raw)
  assert.deepEqual(lockPackages(raw), [{ name: 'dsh-remote-plugin', version: '0.8.0-rc.4' }])
  assert.doesNotThrow(() => verifyInstalled(h.dir, h.body))
  const queried = []
  await prepareReleasePlan(h.dir, { action: 'remove', name: 'example-plugin' }, async name => { queried.push(name); return { '0.8.0-rc.4': '2020-01-01T00:00:00Z' } }, {})
  assert.deepEqual(queried, ['dsh-remote-plugin'])
  fs.writeFileSync(path.join(h.dir, 'node_modules/example-plugin/package.json'), JSON.stringify({ name: 'example-plugin', version: '9.0.0' }))
  assert.throws(() => verifyInstalled(h.dir, h.body), /不一致/)
})

test('preflight identifies the entire lockfile, includes first-match blockers and requires explicit approval', async t => {
  const h = await fixture(t, 'minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - dsh-remote-plugin@0.7.6\n  - dsh-remote-plugin@0.8.0-rc.4\n')
  assert.deepEqual(h.plan.blockers.map(row => row.name), ['dsh-remote-plugin', 'example-plugin'])
  assert.equal(Object.hasOwn(h.plan, 'workspace'), false)
  assert.match(h.plan.ruleChanges[0], /dsh-remote-plugin@0.7.6 \|\| 0.8.0-rc.4/)
  assert.match(fs.readFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'utf8'), /  - dsh-remote-plugin@0.7.6\n  - dsh-remote/)
  await assert.rejects(h.center.handle('POST', '/operations', { ...h.body, preflightKey: undefined }), /预检/)
  await assert.rejects(h.center.submit(h.body), /明确批准/)
  assert.equal((await h.center.inventory()).busy, false)
  await h.center.handle('POST', '/operations', { ...h.body, confirmReleasePolicy: true })
  assert.equal((await h.center.inventory()).operations[0].phase, 'queued')
})

test('review is bound to profile configuration, target version, expiry and operation identity', async t => {
  const h = await fixture(t)
  await assert.rejects(h.center.submit({ ...h.body, version: '3.0.0', confirmReleasePolicy: true }), /预检/)
  const planFile = path.join(h.dir, '.remote-plugin-center', 'preflight-' + h.plan.key + '.json'), record = JSON.parse(fs.readFileSync(planFile))
  fs.writeFileSync(planFile, JSON.stringify({ ...record, expiresAt: 0 }))
  await assert.rejects(h.center.submit({ ...h.body, confirmReleasePolicy: true }), /过期/)
  fs.writeFileSync(planFile, JSON.stringify(record))
  fs.appendFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  await assert.rejects(h.center.submit({ ...h.body, confirmReleasePolicy: true }), /配置已变化/)
})

test('approved worker snapshots the full tree, merges exact rules, and verifies manifest/lockfile/modules', async t => {
  const { runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  let attempts = 0
  await runWorker(h.dir, h.profile.cli, id, async () => { attempts++; install(h.dir); fs.appendFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), '  - example-plugin@2.0.0\n') })
  const job = (await h.center.inventory()).operations[0]
  assert.equal(job.phase, 'complete', job.message); assert.equal(attempts, 1)
  const backup = path.join(h.dir, '.remote-plugin-center', 'backup-' + id)
  assert.equal(fs.readFileSync(path.join(backup, 'node_modules/dsh-remote-plugin/code.js'), 'utf8'), 'original dsh-remote-plugin')
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'transaction.json'))).files['pnpm-workspace.yaml'], 'minimumReleaseAge: 1440\n')
  assert.equal((fs.readFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'utf8').match(/example-plugin@2.0.0/g) || []).length, 1)
})

function linkedPlugin(h, target = path.join(h.dir, 'local-plugins', 'dsh-experimental-auto-review')) {
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'index.mjs'), 'export const original = true')
  const link = path.join(h.dir, 'node_modules', '@deepseek-ai', 'dsh-experimental-auto-review')
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return { target, link }
}

test('Desktop local-plugin junctions are snapshotted independently and allow a managed update', async t => {
  const h = await fixture(t), { target } = linkedPlugin(h)
  const { runWorker } = await centerPromise, { treeDigest } = await modulePromise
  const before = treeDigest(path.join(h.dir, 'node_modules'))
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  let attempts = 0
  await runWorker(h.dir, h.profile.cli, id, async () => { attempts++; install(h.dir) })
  const job = (await h.center.inventory()).operations[0]
  assert.equal(job.phase, 'complete', job.message); assert.equal(attempts, 1)
  const backup = path.join(h.dir, '.remote-plugin-center', 'backup-' + id)
  assert.equal(fs.readFileSync(path.join(backup, 'local-plugins/dsh-experimental-auto-review/index.mjs'), 'utf8'), 'export const original = true')
  fs.writeFileSync(path.join(target, 'index.mjs'), 'user edited the linked source')
  assert.equal(treeDigest(path.join(backup, 'node_modules'), { localRoot: path.join(h.dir, 'local-plugins'), localSnapshotRoot: path.join(backup, 'local-plugins'), linkIdentityRoot: path.join(h.dir, 'node_modules') }), before)
  assert.notEqual(treeDigest(path.join(h.dir, 'node_modules')), before)
})

test('recovery preserves Desktop local-plugin junctions and their original source directory', async t => {
  const h = await fixture(t), { target, link } = linkedPlugin(h), { runWorker } = await centerPromise
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); throw Error('injected install failure') })
  const state = await h.center.inventory()
  assert.equal(state.operations[0].canRestore, true)
  const body = { id: id + '-restore', action: 'restore', name: 'example-plugin', restoreFrom: id, revision: state.revision, confirmRestore: true }
  await h.center.submit(body); await runWorker(h.dir, h.profile.cli, body.id)
  const job = (await h.center.inventory()).operations.find(row => row.id === body.id)
  assert.equal(job.phase, 'complete', job.message)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
  assert.equal(fs.realpathSync(link), fs.realpathSync(target))
  assert.equal(fs.readFileSync(path.join(target, 'index.mjs'), 'utf8'), 'export const original = true')
  assert.equal(fs.readFileSync(path.join(h.dir, 'node_modules/example-plugin/code.js'), 'utf8'), 'original example-plugin')
})

test('a failed installer changing linked local sources cannot cause recovery to overwrite them', async t => {
  const h = await fixture(t), { target } = linkedPlugin(h), { runWorker } = await centerPromise
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => {
    install(h.dir); fs.writeFileSync(path.join(target, 'index.mjs'), 'changed during install'); throw Error('injected failure')
  })
  const state = await h.center.inventory()
  const body = { id: id + '-restore', action: 'restore', name: 'example-plugin', restoreFrom: id, revision: state.revision, confirmRestore: true }
  await h.center.submit(body); await runWorker(h.dir, h.profile.cli, body.id)
  const job = (await h.center.inventory()).operations.find(row => row.id === body.id)
  assert.equal(job.phase, 'failed'); assert.match(job.message, /本地插件源码或其备份已变化/)
  assert.equal(fs.readFileSync(path.join(target, 'index.mjs'), 'utf8'), 'changed during install')
  assert.equal(fs.readFileSync(path.join(h.dir, 'node_modules/example-plugin/code.js'), 'utf8'), 'new code')
})

test('junctions outside local-plugins remain blocked before CLI execution or policy edits', async t => {
  const h = await fixture(t)
  linkedPlugin(h, path.join(h.home, 'outside-profile'))
  const { runWorker } = await centerPromise
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  let attempts = 0
  await runWorker(h.dir, h.profile.cli, id, async () => { attempts++ })
  const job = (await h.center.inventory()).operations[0]
  assert.equal(job.phase, 'failed'); assert.match(job.message, /快照路径越界/); assert.equal(attempts, 0)
  assert.equal(fs.readFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'utf8'), 'minimumReleaseAge: 1440\n')
})

test('local-plugin snapshots reject nested junction escapes', async t => {
  const h = await fixture(t), { target } = linkedPlugin(h), { treeDigest } = await modulePromise
  const outside = path.join(h.home, 'outside-profile'); fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(target, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => treeDigest(path.join(h.dir, 'node_modules')), /快照路径越界/)
})

test('relative local-plugin symlinks retain their meaning through snapshot staging and restore', { skip: process.platform === 'win32' }, async t => {
  const h = await fixture(t), { target, link } = linkedPlugin(h), { runWorker } = await centerPromise
  fs.unlinkSync(link)
  fs.symlinkSync(path.relative(path.dirname(link), target), link, 'dir')
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); throw Error('injected failure') })
  const state = await h.center.inventory()
  assert.equal(state.operations[0].canRestore, true)
  const body = { id: id + '-restore', action: 'restore', name: 'example-plugin', restoreFrom: id, revision: state.revision, confirmRestore: true }
  await h.center.submit(body); await runWorker(h.dir, h.profile.cli, body.id)
  const job = (await h.center.inventory()).operations.find(row => row.id === body.id)
  assert.equal(job.phase, 'complete', job.message)
  assert.equal(fs.realpathSync(link), fs.realpathSync(target))
})

test('a success exit with mismatched lockfile is failed and offers guarded recovery', async t => {
  const { runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); fs.writeFileSync(path.join(h.dir, 'pnpm-lock.yaml'), lock({ ...h.manifest.dependencies })) })
  const job = (await h.center.inventory()).operations[0]
  assert.equal(job.phase, 'failed'); assert.match(job.message, /不一致/); assert.equal(job.canRestore, true)
})

test('failed install recovery restores all plugins, rules and lockfile, preserves the failed tree and cannot be replayed', async t => {
  const { runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); fs.writeFileSync(path.join(h.dir, 'node_modules/dsh-remote-plugin/code.js'), 'transitive mutation'); throw Error('network failure') })
  const state = await h.center.inventory(); assert.equal(state.operations[0].canRestore, true)
  const body = { id: id + '-restore', action: 'restore', name: 'example-plugin', restoreFrom: id, revision: state.revision, confirmRestore: true }
  await h.center.submit(body)
  await runWorker(h.dir, h.profile.cli, body.id, async () => { throw Error('restore must not execute CLI') })
  const jobs = (await h.center.inventory()).operations
  assert.equal(jobs.find(row => row.id === body.id).phase, 'complete')
  assert.equal(jobs.find(row => row.id === id).canRestore, false)
  assert.equal(fs.readFileSync(path.join(h.dir, 'node_modules/dsh-remote-plugin/code.js'), 'utf8'), 'original dsh-remote-plugin')
  assert.equal(fs.readFileSync(path.join(h.dir, 'node_modules/example-plugin/code.js'), 'utf8'), 'original example-plugin')
  assert.equal(fs.readFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'utf8'), 'minimumReleaseAge: 1440\n')
  assert.equal(fs.readFileSync(path.join(h.dir, 'pnpm-lock.yaml'), 'utf8'), lock(h.manifest.dependencies))
  assert.equal(fs.readFileSync(path.join(h.dir, '.remote-plugin-center', 'backup-' + body.id, 'failed-node_modules/example-plugin/code.js'), 'utf8'), 'new code')
  await assert.rejects(h.center.submit({ ...body, id: body.id + '-again', revision: (await h.center.inventory()).revision }), /没有可安全恢复/)
})

test('recovery refuses new user file edits made after failure', async t => {
  const { runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); throw Error('failed') })
  const state = await h.center.inventory(), body = { id: id + '-restore', action: 'restore', name: 'example-plugin', restoreFrom: id, revision: state.revision, confirmRestore: true }
  await h.center.submit(body)
  fs.writeFileSync(path.join(h.dir, 'node_modules/example-plugin/code.js'), 'user edit after failure')
  await runWorker(h.dir, h.profile.cli, body.id)
  const job = (await h.center.inventory()).operations.find(row => row.id === body.id)
  assert.equal(job.phase, 'failed'); assert.match(job.message, /新改动/)
  assert.equal(fs.readFileSync(path.join(h.dir, 'node_modules/example-plugin/code.js'), 'utf8'), 'user edit after failure')
})

test('configuration drift after worker acceptance stops before installation or policy edits', async t => {
  const { runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  fs.appendFileSync(path.join(h.dir, 'pnpm-lock.yaml'), '# external edit\n')
  let called = false
  await runWorker(h.dir, h.profile.cli, id, async () => { called = true })
  const job = (await h.center.inventory()).operations[0]
  assert.equal(called, false); assert.equal(job.canRestore, false)
  assert.equal(fs.readFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'utf8'), 'minimumReleaseAge: 1440\n')
})

test('unknown publication data never grants a release exception or starts a task', async t => {
  const h = await fixture(t), { prepareReleasePlan } = await modulePromise
  await assert.rejects(prepareReleasePlan(h.dir, h.body, async () => ({}), {}), /无法核实/)
  assert.equal((await h.center.inventory()).operations.length, 0)
  assert.equal(fs.readFileSync(path.join(h.dir, 'pnpm-workspace.yaml'), 'utf8'), 'minimumReleaseAge: 1440\n')
})

test('a recovered dead transaction remains restorable and never replays the original install', async t => {
  const { createPluginCenter, runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); throw Error('interrupted') })
  const storage = path.join(h.dir, '.remote-plugin-center'), file = path.join(storage, 'job-' + id + '.json'), job = JSON.parse(fs.readFileSync(file))
  job.phase = 'running'; delete job.recoveryState; fs.writeFileSync(file, JSON.stringify(job))
  fs.writeFileSync(path.join(storage, 'lock.json'), JSON.stringify({ id, workerPid: 987654321 }))
  const reopened = createPluginCenter({}, { profile: h.profile, probeProcesses: async ids => new Map(ids.map(pid => [pid, 'dead'])) })
  const state = await reopened.inventory()
  assert.equal(state.busy, false); assert.equal(state.operations[0].phase, 'interrupted'); assert.equal(state.operations[0].canRestore, true)
})

test('a live DSH configuration lock blocks restore without changing installed files', async t => {
  const { runWorker } = await centerPromise, h = await fixture(t)
  await h.center.submit({ ...h.body, confirmReleasePolicy: true })
  await runWorker(h.dir, h.profile.cli, id, async () => { install(h.dir); throw Error('failed') })
  const state = await h.center.inventory(), body = { id: id + '-restore', action: 'restore', name: 'example-plugin', restoreFrom: id, revision: state.revision, confirmRestore: true }
  await h.center.submit(body)
  const lockFile = path.join(h.dir, 'package.json.lock'); fs.writeFileSync(lockFile, String(process.pid))
  await runWorker(h.dir, h.profile.cli, body.id)
  const job = (await h.center.inventory()).operations.find(row => row.id === body.id)
  assert.equal(job.phase, 'failed'); assert.match(job.message, /占用/)
  assert.equal(fs.readFileSync(path.join(h.dir, 'node_modules/example-plugin/code.js'), 'utf8'), 'new code')
  assert.equal(fs.readFileSync(lockFile, 'utf8'), String(process.pid))
})
