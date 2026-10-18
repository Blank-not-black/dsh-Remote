'use strict'
// `/health?probe=fresh` bypasses the health cache by design, so its response is bounded
// only by the server probe budget. If the clients abort sooner than that ceiling, a slow
// (but reachable) upstream is reported to the user as a failed probe.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const CLIENT_FILES = ['public/app.js', 'public/desktop/desktop.js']

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** Parse `durationEnv('DSH_PROBE_TIMEOUT_MS', <fallback>, <min>, <max>)` from the gateway source. */
function probeBudget() {
  const source = fs.readFileSync(GATEWAY, 'utf8')
  const match = source.match(/const DSH_PROBE_TIMEOUT_MS = durationEnv\('DSH_PROBE_TIMEOUT_MS',\s*(\d+),\s*(\d+),\s*(\d+)\)/)
  assert.ok(match, 'gateway must define DSH_PROBE_TIMEOUT_MS through durationEnv')
  return { fallback: Number(match[1]), min: Number(match[2]), ceiling: Number(match[3]) }
}

/** Every client abort budget paired with the request it guards. */
function clientAbortBudgets() {
  const budget = ms => {
    const match = ms.match(/(\d+)\s*\)?/)
    assert.ok(match, `unparsable abort budget: ${ms}`)
    return Number(match[1])
  }
  const budgets = []
  for (const file of CLIENT_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const line of source.split('\n')) {
      if (!line.includes('probe=fresh')) continue
      const local = line.match(/AbortSignal\.timeout\((\d+)\)/)
      if (local) budgets.push({ file, ms: Number(local[1]), kind: 'signal' })
    }
    // probeOverviewLinks guards the same request with a manual timer + AbortController.
    const timer = source.match(/timer\s*=\s*setTimeout\(cancel,\s*(\d+)\)/)
    if (timer) budgets.push({ file, ms: Number(timer[1]), kind: 'timer' })
  }
  return budgets
}

test('explicit fresh probes stay inside the clients abort budget', () => {
  const { fallback, ceiling } = probeBudget()
  const budgets = clientAbortBudgets()
  assert.ok(fallback <= ceiling, 'default probe budget must not exceed its own ceiling')
  assert.ok(ceiling > 0)
  for (const file of CLIENT_FILES) assert.ok(budgets.some(b => b.file === file), `${file} must guard its fresh probe with a budget`)
  for (const { file, ms, kind } of budgets) {
    assert.ok(ms > ceiling, `${file} (${kind} ${ms}ms) must exceed the ${ceiling}ms server probe ceiling, else a slow upstream looks like a failed probe`)
  }
})

test('a hanging upstream is cut off at the configured probe budget instead of the client budget', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-budget-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const port = await freePort()
  // An upstream that accepts the connection and never answers: the probe must time out
  // on its own budget rather than waiting for the client to give up.
  const blackhole = http.createServer(() => {})
  // Sockets that were accepted but never answered keep server.close() (and the test run)
  // waiting, so they are destroyed explicitly during teardown.
  const sockets = new Set()
  blackhole.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const blackholePort = await freePort()
  await new Promise(resolve => blackhole.listen(blackholePort, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy()
    blackhole.close(() => resolve())
  }))

  const budget = 700
  const env = {
    ...process.env,
    HOME: tmp, USERPROFILE: tmp, PORT: String(port), HOST: '127.0.0.1',
    TOKEN: 'probe-budget-token', TOKEN_FILE: path.join(tmp, 'token'),
    DSH_UPSTREAM: `http://127.0.0.1:${blackholePort}`, DSH_REMOTE_FS_ROOT: tmp,
    DSH_REMOTE_NOTES: path.join(tmp, 'notes.json'), DSH_REMOTE_ANNOUNCEMENTS_URL: '',
    DSH_PROBE_TIMEOUT_MS: String(budget),
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update', UPDATE_INTERVAL_MS: '3600000',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
  }
  delete env.NODE_USE_ENV_PROXY
  const gateway = spawn(process.execPath, [GATEWAY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  gateway.stdout.on('data', chunk => { logs += chunk })
  gateway.stderr.on('data', chunk => { logs += chunk })
  t.after(() => gateway.kill('SIGKILL'))

  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${base}/health?probe=live`, { signal: AbortSignal.timeout(400) })
      if (response.ok) break
    } catch {}
    if (i === 79) assert.fail(`gateway did not start\n${logs}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }

  const started = Date.now()
  const response = await fetch(`${base}/health?probe=fresh`, { signal: AbortSignal.timeout(6000) })
  const elapsed = Date.now() - started
  const health = await response.json()
  assert.equal(response.status, 200)
  assert.equal(health.upstreamOk, false, 'a hanging upstream must be reported as unreachable')
  // Generous upper bound: proves the server honours its own budget and never leans on the
  // client abort (which is 6500ms) to end the request.
  assert.ok(elapsed < 5000, `fresh probe took ${elapsed}ms, expected it to stop near the ${budget}ms budget`)
})
