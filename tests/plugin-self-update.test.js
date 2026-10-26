'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawn } = require('node:child_process'), { once } = require('node:events')
const { getFreePort } = require('./fixtures/realistic-stack.cjs')
const ROOT = path.join(__dirname, '..'), TOKEN = 'isolated-remote-self-update-token'
const VERSION = require('../package.json').version, TARGET = '99.0.0-selftest.1'
const NAME = 'dsh-remote-plugin', ID = 'remote-self-update-12345678'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function lock(version) {
  return `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-remote-plugin:\n        specifier: ${version}\n        version: ${version}\npackages:\n  'dsh-remote-plugin@${version}': {}\n`
}
async function until(check, message) {
  let last
  for (let i = 0; i < 250; i++) {
    try { const value = await check(); if (value) return value } catch (error) { last = error }
    await pause(50)
  }
  throw Error(message + (last ? ': ' + last.message : ''))
}
async function fixture(t, { legacy = false, wrongToken = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-self-update-'))
  const dir = path.join(home, 'profiles/web'), remote = path.join(dir, 'node_modules', NAME), staged = path.join(home, 'staged')
  const runtime = path.join(home, 'carrier'), cli = path.join(runtime, 'lib/bin.js'), configDir = path.join(home, '.dsh-remote')
  const gatewayPort = await getFreePort(), dshPort = await getFreePort()
  fs.mkdirSync(configDir, { recursive: true }); fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'token'), TOKEN)
  fs.cpSync(path.join(ROOT, 'packages/plugin'), remote, { recursive: true, filter: file => !file.endsWith('.apk') })
  fs.cpSync(remote, staged, { recursive: true })
  const pkg = JSON.parse(fs.readFileSync(path.join(staged, 'package.json'))); pkg.version = TARGET
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(path.join(staged, 'public/version.json'), JSON.stringify({ version: TARGET }))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [NAME]: VERSION }, dsh: { profile: { bundles: [NAME] } } }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock(VERSION))
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 0\n')
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'commonjs' }))
  fs.copyFileSync(path.join(__dirname, 'fixtures/self-update-host.cjs'), cli)
  fs.writeFileSync(path.join(home, 'self-update.json'), JSON.stringify({ dir, staged, target: TARGET, targetLock: lock(TARGET), gatewayPort, dshPort }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/proxy|^DSH_|^TOKEN(?:_FILE)?$|^HOST$|^PORT$|^UPDATE_|^npm_config_minimum_release_age/i.test(key)) delete env[key]
  const emptyBin = path.join(home, 'empty-bin'); fs.mkdirSync(emptyBin)
  Object.assign(env, { HOME: home, USERPROFILE: home, DSH_HOME: home, DSH_REMOTE_FS_ROOT: home, TOKEN,
    TOKEN_FILE: path.join(configDir, 'token'), DSH_REMOTE_GATEWAY_PORT: String(gatewayPort), DSH_REMOTE_GATEWAY_HOST: '127.0.0.1',
    DSH_REMOTE_AUTOSTART: '1', PATH: emptyBin, UPDATE_CHECK_URL: 'http://127.0.0.1:1/update', UPDATE_INTERVAL_MS: '3600000',
    LEGACY_TEST_TOKEN: wrongToken ? TOKEN + '-other' : TOKEN, NO_PROXY: '*' })
  const base = 'http://127.0.0.1:' + gatewayPort, dshBase = 'http://127.0.0.1:' + dshPort
  const headers = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }
  const children = []; let host, logs = ''
  const launch = async mode => {
    const child = spawn(process.execPath, [cli, mode], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    child.on('message', message => { if (message.ready) child.ready = true })
    children.push(child)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-10000) })
    await until(() => child.exitCode !== null ? assert.fail('Fixture exited: ' + logs) : child.connected && child.ready, 'Fixture not ready: ' + logs)
    return child
  }
  const stopChild = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const done = once(child, 'exit'); child.kill(); await done
  }
  const readJob = (id = ID) => JSON.parse(fs.readFileSync(path.join(dir, '.remote-plugin-center/job-' + id + '.json')))
  t.after(async () => {
    fs.writeFileSync(path.join(home, 'allow-replacement'), '')
    for (const child of children) await stopChild(child)
    try { await fetch(base + '/admin/api/shutdown', { method: 'POST', headers, signal: AbortSignal.timeout(1000) }) } catch {}
    await pause(350)
    // Only fixture-owned PIDs from this temporary profile, never the real HOME.
    for (const file of ['plugin-gateway.pid']) {
      try { const pid = Number(fs.readFileSync(path.join(configDir, file))); if (Number.isInteger(pid) && pid > 1) process.kill(pid) } catch {}
    }
    const storage = path.join(dir, '.remote-plugin-center'), ownerFile = path.join(storage, 'lock.json')
    if (fs.existsSync(ownerFile)) {
      const owner = JSON.parse(fs.readFileSync(ownerFile))
      for (const pid of [owner.cliPid, owner.workerPid]) if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid) } catch {} }
      await pause(100)
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })
  const legacyChild = legacy ? await launch('--legacy') : null
  host = await launch('--host')
  const health = async () => (await fetch(base + '/health?probe=live', { signal: AbortSignal.timeout(1000) })).json()
  const ready = version => until(async () => { const h = await health(); return h.version === version && h.upstreamOk && h.events?.mux?.connected && h.events?.host?.connected && h }, 'Gateway did not activate ' + version + '\n' + logs)
  const api = async (sub, body, status = body ? 202 : 200) => {
    const res = await fetch(base + '/remote/api/plugins/' + sub, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data
  }
  return { home, dir, remote, base, dshBase, headers, legacyChild, health, ready, api, readJob,
    release() { fs.writeFileSync(path.join(home, 'allow-replacement'), '') },
    async stopHost() { await stopChild(host) }, async restartHost() { await stopChild(host); host = await launch('--host') },
    async prepare() {
      const state = await api('state')
      const body = { id: ID, action: 'update', name: NAME, version: TARGET, revision: state.revision, confirmSelfUpdate: true }
      const { plan } = await api('preflight', body)
      assert.equal(plan.baselineWarning, '')
      return { ...body, preflightKey: plan.key }
    },
  }
}

test('legacy takeover and remote self-update survive host exit, package replacement and restart', { timeout: 45000 }, async t => {
  const f = await fixture(t, { legacy: true }), before = await f.ready(VERSION)
  await until(() => f.legacyChild.exitCode === 0, 'Old gateway did not exit gracefully')
  assert.equal(fs.readFileSync(path.join(f.home, 'legacy-audit'), 'utf8'), 'authenticated-shutdown\n')
  const firstTicket = await (await fetch(f.base + '/api/ws-ticket', { method: 'POST', headers: f.headers })).json()
  const body = await f.prepare()
  await f.api('operations', { ...body, confirmSelfUpdate: false }, 409)
  await f.api('operations', body)
  await until(() => fs.existsSync(path.join(f.home, 'cli-started')), 'Detached CLI did not start')
  assert.equal((await f.health()).pid, before.pid)
  await f.stopHost() // Client loses the upstream while the independent worker is installing.
  f.release()
  await until(() => ['complete', 'failed'].includes(f.readJob().phase), 'Update did not finish with host stopped')
  const job = f.readJob(); assert.equal(job.phase, 'complete', job.message + '\n' + job.log); assert.equal(job.restartRequired, true)
  const backup = path.join(f.dir, '.remote-plugin-center', 'backup-' + ID)
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'node_modules', NAME, 'package.json'))).version, VERSION)
  assert.ok(fs.existsSync(path.join(f.dir, '.remote-plugin-center', 'worker-' + ID + '.mjs')))
  assert.equal((await f.health()).pid, before.pid, 'Package replacement alone must not claim a new running version')
  await f.restartHost()
  const after = await f.ready(TARGET)
  assert.notEqual(after.pid, before.pid)
  const state = await f.api('state')
  assert.equal(state.items.find(row => row.name === NAME).version, TARGET)
  assert.equal(state.operations.find(row => row.id === ID).phase, 'complete')
  assert.equal(state.pendingRestart, false); assert.equal(state.busy, false)
  // A retry of the same request after reconnect returns the persisted result.
  assert.equal((await f.api('operations', body)).operation.phase, 'complete')
  assert.equal(fs.readFileSync(path.join(f.home, 'cli-calls'), 'utf8').trim().split('\n').length, 1)
  const ticketRes = await fetch(f.base + '/api/ws-ticket', { method: 'POST', headers: f.headers })
  assert.equal(ticketRes.status, 200); assert.notEqual((await ticketRes.json()).ticket, firstTicket.ticket)
  t.diagnostic('Real gateway PID/version replaced; detached update completed while host was dead; same pairing and durable job recovered after actual host restart.')
})

test('compact old health with a different token is reported running and cannot be taken over', { timeout: 20000 }, async t => {
  const f = await fixture(t, { legacy: true, wrongToken: true })
  const state = await until(async () => {
    const data = await (await fetch(f.dshBase + '/remote/admin/api/state')).json()
    return data.gatewayAuthError && data
  }, 'Authentication mismatch was not reported')
  assert.equal(state.gatewayRunning, true); assert.equal(state.gatewayVersion, '0.7.0')
  assert.match(state.gatewayAuthError, /管理认证不可用/)
  assert.equal((await f.health()).liveness.pid, f.legacyChild.pid)
  assert.equal(f.legacyChild.exitCode, null)
  assert.doesNotMatch(fs.readFileSync(path.join(f.home, 'legacy-audit'), 'utf8'), /authenticated-shutdown/)
  assert.equal(fs.existsSync(path.join(f.home, '.dsh-remote/plugin-gateway.pid')), false)
})

test('remote self-update failure after replacing files keeps service and permits guarded explicit restore', { timeout: 45000 }, async t => {
  const f = await fixture(t), before = await f.ready(VERSION), body = await f.prepare()
  fs.writeFileSync(path.join(f.home, 'fail-after-replacement'), '')
  await f.api('operations', body); f.release()
  // worker 先保存终态再释放任务锁；终态本身不代表下一次写操作已经可以开始。
  const failed = await until(async () => { const state = await f.api('state'); return !state.busy && state.operations.find(row => row.id === ID)?.phase === 'failed' && state }, 'Failed CLI did not finish and release its operation lock')
  const job = failed.operations.find(row => row.id === ID)
  assert.equal(job.canRestore, true); assert.equal(job.restartRequired, true)
  assert.equal(failed.items.find(row => row.name === NAME).version, TARGET)
  assert.equal((await f.health()).pid, before.pid)
  const restoreId = ID + '-restore'
  await f.api('operations', { id: restoreId, action: 'restore', name: NAME, restoreFrom: ID, revision: failed.revision, confirmRestore: true })
  await until(() => {
    const job = f.readJob(restoreId)
    if (['failed', 'interrupted'].includes(job.phase)) throw Error(JSON.stringify(job))
    return job.phase === 'complete'
  }, 'Explicit restore did not complete')
  const restored = await f.api('state')
  assert.equal(restored.items.find(row => row.name === NAME).version, VERSION)
  assert.equal(restored.operations.find(row => row.id === ID).canRestore, false)
  assert.equal(restored.operations.find(row => row.id === ID).restoredBy, restoreId)
  assert.ok(fs.existsSync(path.join(f.dir, '.remote-plugin-center', 'backup-' + restoreId, 'failed-node_modules', NAME)))
  assert.equal(fs.readFileSync(path.join(f.home, 'cli-calls'), 'utf8').trim().split('\n').length, 1, 'Restore must not reinstall or retry the failed update')
  await f.restartHost(); await f.ready(VERSION)
  assert.equal((await f.api('state')).operations.find(row => row.id === restoreId).phase, 'complete')
  t.diagnostic('Injected post-replacement CLI failure was not reported as success; live gateway stayed available; snapshot restore preserved failed files and survived host restart.')
})
