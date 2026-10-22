// Isolated source/packaged gateway smoke. No real profile, upstream, or credentials.
// Source: node scripts/smoke-gateway.mjs
// Binary: node scripts/smoke-gateway.mjs /absolute/path/to/dsh-remote
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const command = process.argv[2] ? resolve(process.argv[2]) : process.execPath
const args = process.argv.length > 2 ? process.argv.slice(3) : [join(root, 'gateway.js')]
const port = Number(process.env.DSH_GATEWAY_SMOKE_PORT || 18787)
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid smoke port')
// Refuse an occupied port before launching; never shut down another gateway.
await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
})
const temp = mkdtempSync(join(tmpdir(), 'dsh-gateway-smoke-'))
const log = join(temp, 'gateway.log'), logFd = openSync(log, 'w')
const token = 'isolated-gateway-smoke-token', base = `http://127.0.0.1:${port}`
const env = {}
// An allowlist also excludes every *_PROXY, NODE_OPTIONS, inherited profile and IPC override.
for (const name of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TMPDIR', 'LANG', 'LC_ALL']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
Object.assign(env, {
  HOME: temp, USERPROFILE: temp, DSH_HOME: temp, TEMP: temp, TMP: temp,
  DSH_REMOTE_FS_ROOT: temp, TOKEN: token, TOKEN_FILE: join(temp, 'token'),
  PORT: String(port), HOST: '127.0.0.1', DSH_UPSTREAM: 'http://127.0.0.1:1',
  DSH_REMOTE_AUTO_RESTART: '0', DSH_REMOTE_DSH_CONTROL_MODE: 'disabled',
  DSH_REMOTE_ANNOUNCEMENTS_URL: '', DSH_REMOTE_FEEDBACK_URL: 'http://127.0.0.1:1',
  UPDATE_CHECK_URL: 'http://127.0.0.1:1',
})
let child, result, workerPid, launchError, failure, failed = false
const request = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(1000) })
const waitForExit = async ms => {
  const deadline = Date.now() + ms
  while (!result && Date.now() < deadline) await delay(50)
  return result
}
const terminate = signal => {
  if (!child?.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else if (!result) {
      // TerminateProcess alone leaves an unverified/unresponsive worker orphaned.
      const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      if (stopped.error) throw stopped.error
      if (stopped.status !== 0) {
        try { process.kill(child.pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
        throw Error('cannot clean isolated gateway process tree')
      }
    } else if (workerPid) process.kill(workerPid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
try {
  // A separate process group lets failure cleanup remove supervisor AND worker on Unix.
  child = spawn(command, [...args, '--supervise'], {
    cwd: temp, env, detached: process.platform !== 'win32', windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.once('exit', (code, signal) => { result = { code, signal } })
  child.once('error', error => { launchError = error; result = { code: null, signal: null } })
  let health
  for (let attempt = 0; attempt < 30; attempt++) {
    if (result) throw launchError || Error(`supervisor exited before health: ${JSON.stringify(result)}`)
    let response
    try { response = await request('/health') } catch { /* Cold start: retry with a bounded request. */ }
    if (response?.ok) {
      health = await response.json()
      assert.equal(health.ok, true)
      assert.ok(Number.isSafeInteger(health.pid) && health.pid > 0)
      assert.equal(health.runtime?.recovery?.supervised, true)
      assert.equal(health.runtime.recovery.supervisorPid, child.pid, 'health must belong to this supervisor')
      assert.notEqual(health.pid, child.pid)
      workerPid = health.pid
      break
    }
    await delay(1000)
  }
  assert.ok(health, 'gateway health did not respond within 30 attempts')
  const page = await request('/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') || '', /text\/html/)
  assert.match(await page.text(), /<html\b/i)
  const script = await request('/app.js')
  assert.equal(script.status, 200)
  assert.ok((await script.text()).length > 100, 'bundled client JavaScript must be present')
  const shutdown = await request('/admin/api/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + token } })
  assert.equal(shutdown.status, 200)
  assert.equal((await shutdown.json()).ok, true)
  assert.ok(await waitForExit(10000), 'graceful shutdown timed out')
  assert.equal(result.code, 0, JSON.stringify(result))
  console.log(`SMOKE_OK port=${port} supervisor=${child.pid} worker=${workerPid} static=HTML+JS shutdown=0`)
} catch (error) {
  failed = true
  failure = error
  throw error
} finally {
  try {
    if (failed || (child && !result)) {
      terminate('SIGTERM')
      if (!await waitForExit(3000)) { terminate('SIGKILL'); assert.ok(await waitForExit(3000), 'smoke process cleanup timed out') }
      // A worker may outlive an already exited Unix supervisor; clear the entire owned group.
      if (process.platform !== 'win32') terminate('SIGKILL')
    }
  } finally {
    closeSync(logFd)
    if (failed) console.error(readFileSync(log, 'utf8'))
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()), 'cleanup must stay in the temporary directory')
    try { rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
    catch (error) { throw failure ? new AggregateError([failure, error], 'Gateway smoke failed; temporary cleanup also failed') : error }
  }
}
