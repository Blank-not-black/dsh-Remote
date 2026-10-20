'use strict'
// Opt-in, real pnpm against a loopback registry. No network, user home or new dependencies.
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), zlib = require('node:zlib'), crypto = require('node:crypto')
const { spawn } = require('node:child_process'), { once } = require('node:events')
function tar(files) {
  const chunks = []
  for (const [name, value] of Object.entries(files)) {
    const body = Buffer.from(value), header = Buffer.alloc(512)
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    const sum = header.reduce((a, b) => a + b, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}
test('real pnpm: unrelated immature lock entry fails, reviewed exact exceptions allow update, then full snapshot restores a failed attempt', {
  skip: !process.env.DSH_TEST_PNPM, timeout: 60000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-real-pnpm-')), dir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_REMOTE_FS_ROOT: home, TOKEN: 'pnpm-transaction-only', CI: 'true', npm_config_userconfig: path.join(home, 'empty.npmrc'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache') }
  for (const key of Object.keys(env)) if (/proxy|^npm_config_minimum_release_age/i.test(key)) delete env[key]
  fs.writeFileSync(env.npm_config_userconfig, '')
  const children = [], packages = new Map(), now = new Date().toISOString()
  for (const [name, version, time] of [['example-plugin', '1.0.0', '2020-01-01T00:00:00Z'], ['example-plugin', '2.0.0', now], ['dsh-remote-plugin', '0.8.0-rc.4', now]]) {
    const manifest = { name, version, dsh: { bundle: { patch: './patch.yml' } } }
    packages.set(name + '@' + version, { manifest, time, archive: tar({ 'package/package.json': JSON.stringify(manifest), 'package/patch.yml': '[]\n', 'package/index.js': `export const version='${version}'` }) })
  }
  let base
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, base).pathname).slice(1)
    if (pathname.endsWith('.tgz')) {
      const data = packages.get(pathname.slice(0, -4)); if (!data) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(data.archive); return
    }
    const versions = {}, time = {}
    for (const [key, row] of packages) if (row.manifest.name === pathname) {
      versions[row.manifest.version] = { ...row.manifest, dist: { tarball: base + '/' + key + '.tgz', integrity: 'sha512-' + crypto.createHash('sha512').update(row.archive).digest('base64') } }
      time[row.manifest.version] = row.time
    }
    if (!Object.keys(versions).length) { res.writeHead(404); res.end('{}'); return }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: pathname, versions, time, 'dist-tags': { latest: Object.keys(versions).at(-1) } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  async function pnpm(args, output = () => {}, onSpawn = () => {}) {
    const command = args[0] === 'plugin' ? process.env.DSH_TEST_PLUGIN_CLI : process.env.DSH_TEST_PNPM
    const child = spawn(process.execPath, [command, ...args, '--registry=' + base, '--store-dir=' + path.join(home, 'store'), '--ignore-scripts'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child); child.once('spawn', () => onSpawn(child.pid))
    let logs = ''; for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { logs += chunk; output(String(chunk)) })
    const [code] = await once(child, 'exit'); if (code !== 0) throw Error(logs)
    return logs
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['example-plugin', 'dsh-remote-plugin'] } } }))
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nminimumReleaseAge: 0\n')
  await pnpm(['add', 'example-plugin@1.0.0', 'dsh-remote-plugin@0.8.0-rc.4', '--save-exact'])
  // Keep the young unrelated version genuinely unapproved. Newer pnpm releases
  // no longer necessarily reproduce the old first-duplicate-rule behavior.
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - dsh-remote-plugin@0.7.6\n')
  await assert.rejects(pnpm(['add', 'example-plugin@2.0.0', '--save-exact']), /MINIMUM_RELEASE_AGE_VIOLATION[\s\S]*dsh-remote-plugin@0.8.0-rc.4/)
  // Reproduce Desktop's built-in local plugin, which is not a registry dependency.
  const localPlugin = path.join(dir, 'local-plugins', 'dsh-experimental-auto-review')
  const localLink = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-experimental-auto-review')
  fs.mkdirSync(localPlugin, { recursive: true }); fs.mkdirSync(path.dirname(localLink), { recursive: true })
  fs.writeFileSync(path.join(localPlugin, 'index.mjs'), 'export const original = true')
  fs.symlinkSync(localPlugin, localLink, process.platform === 'win32' ? 'junction' : 'dir')
  const { createPluginCenter, runWorker } = await import('../packages/plugin/plugin-center.mjs')
  const profile = { dir, name: 'web', home, cli: 'fixture-pnpm' }
  const center = createPluginCenter({}, { profile, details: async () => ({ bundle: true }), publicationTimes: async name => Object.fromEntries([...packages.values()].filter(row => row.manifest.name === name).map(row => [row.manifest.version, row.time])), launch: async () => {} })
  const body = { id: 'real-pnpm-update-12345678', action: 'update', name: 'example-plugin', version: '2.0.0', revision: (await center.inventory()).revision }
  const plan = (await center.preflight(body)).plan
  assert.ok(plan.blockers.some(row => row.name === 'dsh-remote-plugin'))
  await center.submit({ ...body, preflightKey: plan.key, confirmReleasePolicy: true })
  const managedArgs = args => (process.env.DSH_TEST_PLUGIN_CLI ? args : args.slice(3)).filter(arg => !arg.startsWith('--registry='))
  await runWorker(dir, profile.cli, body.id, (_cli, args, _dir, output, onSpawn) => pnpm(managedArgs(args), output, onSpawn))
  const state = await center.inventory(), job = state.operations[0]
  assert.equal(job.phase, 'complete', job.message + '\n' + job.log)
  assert.equal(state.items.find(item => item.name === 'example-plugin').version, '2.0.0')
  assert.equal(fs.readFileSync(path.join(dir, '.remote-plugin-center', 'backup-' + body.id, 'local-plugins/dsh-experimental-auto-review/index.mjs'), 'utf8'), 'export const original = true')
  assert.equal(fs.realpathSync(localLink), fs.realpathSync(localPlugin))
  assert.match(fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'), /dsh-remote-plugin@0.7.6 \|\| 0.8.0-rc.4/)
  const failed = { id: 'real-pnpm-failed-12345678', action: 'update', name: 'example-plugin', version: '1.0.0', revision: state.revision }
  const retryPlan = (await center.preflight(failed)).plan
  await center.submit({ ...failed, preflightKey: retryPlan.key, confirmReleasePolicy: true })
  await runWorker(dir, profile.cli, failed.id, async (_cli, args, _dir, output, onSpawn) => {
    await pnpm(managedArgs(args), output, onSpawn)
    throw Error('Injected failure after a real package replacement')
  })
  const afterFailure = await center.inventory()
  assert.equal(afterFailure.operations.find(row => row.id === failed.id).canRestore, true)
  const restore = { id: 'real-pnpm-restore-12345678', action: 'restore', name: 'example-plugin', restoreFrom: failed.id, revision: afterFailure.revision, confirmRestore: true }
  await center.submit(restore); await runWorker(dir, profile.cli, restore.id)
  const recovered = await center.inventory()
  assert.equal(recovered.operations.find(row => row.id === restore.id).phase, 'complete')
  assert.equal(recovered.items.find(row => row.name === 'example-plugin').version, '2.0.0')
  assert.equal(fs.realpathSync(localLink), fs.realpathSync(localPlugin))
  assert.equal(fs.readFileSync(path.join(localPlugin, 'index.mjs'), 'utf8'), 'export const original = true')
  t.diagnostic('Actual pnpm whole-lock policy failure reproduced; reviewed update passed with a local registry and isolated HOME.')
  if (process.env.DSH_TEST_PLUGIN_CLI) t.diagnostic('Both managed install attempts used the actual installed DSH plugin CLI.')
})
