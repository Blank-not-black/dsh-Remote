'use strict'

const { after, before, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const GATEWAY = path.join(ROOT, 'gateway.js')
const TOKEN = 'dsh-control-test-token'
const GATEWAY_SOURCE = fs.readFileSync(GATEWAY, 'utf8')

let tmpRoot
let stateFile
let gateway
let upstream
const upstreamSockets = new Set()
let base

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(err => err ? reject(err) : resolve(port))
    })
    server.on('error', reject)
  })
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve)
    server.on('error', reject)
  })
}

function close(server) {
  return new Promise(resolve => server?.close(() => resolve()))
}

async function waitReady(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('gateway did not become ready')
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

test('Windows 服务查询解析状态码和主进程 PID', () => {
  const start = GATEWAY_SOURCE.indexOf('const WINDOWS_SERVICE_STATE_NAMES')
  const end = GATEWAY_SOURCE.indexOf('function classifyWindowsServiceFailure', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${GATEWAY_SOURCE.slice(start, end)}\nthis.parseWindowsServiceQuery = parseWindowsServiceQuery`, context)
  assert.deepEqual(JSON.parse(JSON.stringify(context.parseWindowsServiceQuery([
    'SERVICE_NAME: dsh-web',
    '        STATE              : 4  RUNNING',
    '        PID                : 4210',
  ].join('\n')))), {
    stateCode: 4, stateName: 'RUNNING', pending: false, running: true, mainPid: 4210,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(context.parseWindowsServiceQuery([
    'SERVICE_NAME: dsh-web',
    '        STATE              : 1  STOPPED',
  ].join('\n')))), {
    stateCode: 1, stateName: 'STOPPED', pending: false, running: false, mainPid: 0,
  })
})

test('Windows DSH 控制使用 sc.exe 服务后端而不是 systemd 不支持分支', () => {
  assert.match(GATEWAY_SOURCE, /const WINDOWS_SC = String\(process\.env\.DSH_REMOTE_WINDOWS_SC \|\| 'sc\.exe'\)/)
  assert.match(GATEWAY_SOURCE, /function windowsServiceStatus\(\)/)
  assert.match(GATEWAY_SOURCE, /\['queryex', DSH_SERVICE\]/)
  assert.match(GATEWAY_SOURCE, /\['stop', DSH_SERVICE\]/)
  assert.match(GATEWAY_SOURCE, /\['start', DSH_SERVICE\]/)
  assert.doesNotMatch(GATEWAY_SOURCE, /Windows 暂不支持通过 systemd 远程控制 DSH/)
})

function setFakeState(value) {
  fs.writeFileSync(stateFile, JSON.stringify(value))
}

async function waitOperation(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/admin/api/dsh?operation=${encodeURIComponent(id)}`, { headers: authHeaders() })
    assert.equal(res.status, 200)
    value = await res.json()
    if (value.done) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`operation timed out: ${JSON.stringify(value)}`)
}

before(async () => {
  if (process.platform === 'win32') return
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-control-'))
  stateFile = path.join(tmpRoot, 'systemctl-state.json')
  setFakeState({ mode: 'running', pid: 4100 })
  const fakeSystemctl = path.join(tmpRoot, 'systemctl')
  fs.writeFileSync(fakeSystemctl, `#!/usr/bin/env node
const fs = require('node:fs')
const file = process.env.FAKE_SYSTEMCTL_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
if (args.includes('show')) {
  const missing = state.mode === 'missing'
  const failed = state.mode === 'failed'
  const active = !missing && !failed && state.mode !== 'stopped'
  process.stdout.write([
    'Id=' + (missing ? 'dsh-web.service' : 'dsh-web.service'),
    'LoadState=' + (missing ? 'not-found' : 'loaded'),
    'ActiveState=' + (failed ? 'failed' : active ? 'active' : 'inactive'),
    'SubState=' + (failed ? 'failed' : active ? 'running' : 'dead'),
    'UnitFileState=' + (missing ? '' : 'enabled'),
    'MainPID=' + (active ? String(state.pid || 4100) : '0'),
    'Result=' + (failed ? 'exit-code' : 'success'),
    'ExecMainStatus=' + (failed ? '1' : '0'),
  ].join('\\n') + '\\n')
  process.exit(0)
}
const action = args.find(value => value === 'start' || value === 'restart')
if (action) {
  if (state.mode === 'command-fail') {
    process.stderr.write('Job failed because the control process exited with error code.\\n')
    process.exit(1)
  }
  if (state.mode === 'command-slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  state.mode = 'running'
  state.pid = Number(state.pid || 4100) + 1
  fs.writeFileSync(file, JSON.stringify(state))
  process.exit(0)
}
process.stderr.write('unsupported fake systemctl call\\n')
process.exit(2)
`)
  fs.chmodSync(fakeSystemctl, 0o755)

  const upstreamPort = await freePort()
  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  upstream.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(String(key || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    upstreamSockets.add(socket)
    socket.on('close', () => upstreamSockets.delete(socket))
  })
  await listen(upstream, upstreamPort)

  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    HOME: tmpRoot,
    USERPROFILE: tmpRoot,
    HOST: '127.0.0.1',
    PORT: String(port),
    TOKEN,
    TOKEN_FILE: path.join(tmpRoot, 'token'),
    DSH_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    DSH_REMOTE_FS_ROOT: tmpRoot,
    DSH_REMOTE_DSH_SERVICE: 'dsh-web',
    DSH_REMOTE_SYSTEMCTL: fakeSystemctl,
    FAKE_SYSTEMCTL_STATE: stateFile,
    DSH_REMOTE_DSH_CONTROL_TIMEOUT_MS: '3000',
    DSH_REMOTE_DSH_CONTROL_POLL_MS: '50',
    DSH_REMOTE_ANNOUNCEMENTS_URL: '',
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update',
    UPDATE_INTERVAL_MS: '3600000',
    UPDATE_PROXY: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
    http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '*',
  }
  delete env.NODE_USE_ENV_PROXY
  gateway = spawn(process.execPath, [GATEWAY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  await waitReady(`${base}/health`)
})

after(async () => {
  if (gateway && !gateway.killed) gateway.kill('SIGTERM')
  for (const socket of upstreamSockets) socket.destroy()
  await close(upstream)
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('DSH 控制状态返回 systemd 单元、子状态和 PID', { skip: process.platform === 'win32' }, async () => {
  const res = await fetch(`${base}/admin/api/dsh`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true, JSON.stringify(body))
  assert.equal(body.supported, true)
  assert.equal(body.running, true)
  assert.equal(body.loadState, 'loaded')
  assert.equal(body.activeState, 'active')
  assert.equal(body.subState, 'running')
  assert.equal(body.mainPid, 4100)
})

test('DSH 重启异步报告检查、命令、服务、HTTP 和成功阶段', { skip: process.platform === 'win32' }, async () => {
  setFakeState({ mode: 'running', pid: 4200 })
  const accepted = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ action: 'restart' }),
  })
  assert.equal(accepted.status, 202)
  const initial = await accepted.json()
  assert.equal(initial.accepted, true)
  assert.match(initial.operationId, /^[a-f0-9-]+$/)

  const result = await waitOperation(initial.operationId)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.done, true)
  assert.equal(result.stage, 'complete')
  assert.equal(result.status.running, true)
  assert.equal(result.status.mainPid, 4201)
  assert.deepEqual(result.steps.map(step => step.stage), ['checking', 'command', 'waiting-service', 'waiting-upstream', 'waiting-events', 'complete'])
  assert.equal(result.events.mux.connected, true)
  assert.equal(result.events.host.connected, true)
  assert.equal(result.elapsedMs, result.steps.at(-1).elapsedMs)
  await new Promise(resolve => setTimeout(resolve, 100))
  const completedAgain = await fetch(`${base}/admin/api/dsh?operation=${encodeURIComponent(initial.operationId)}`, { headers: authHeaders() })
  assert.equal(completedAgain.status, 200)
  assert.equal((await completedAgain.json()).elapsedMs, result.elapsedMs)
})

test('DSH 控制在已有操作时返回明确冲突与当前进度', { skip: process.platform === 'win32' }, async () => {
  setFakeState({ mode: 'command-slow', pid: 4250 })
  const first = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ action: 'restart' })
  })
  assert.equal(first.status, 202)
  const operation = await first.json()

  const conflict = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ action: 'start' })
  })
  assert.equal(conflict.status, 409)
  const body = await conflict.json()
  assert.equal(body.code, 'OPERATION_IN_PROGRESS')
  assert.equal(body.operation.operationId, operation.operationId)
  assert.equal((await waitOperation(operation.operationId)).ok, true)
})

test('DSH 控制区分服务不存在、命令失败和操作不存在', { skip: process.platform === 'win32' }, async () => {
  setFakeState({ mode: 'missing', pid: 0 })
  let res = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ action: 'start' })
  })
  assert.equal(res.status, 202)
  let result = await waitOperation((await res.json()).operationId)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SERVICE_NOT_FOUND', JSON.stringify(result))
  assert.equal(result.stage, 'failed')
  assert.match(result.message, /dsh-web/)

  setFakeState({ mode: 'command-fail', pid: 4300 })
  res = await fetch(`${base}/admin/api/dsh`, {
    method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ action: 'restart' })
  })
  result = await waitOperation((await res.json()).operationId)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'COMMAND_FAILED')
  assert.match(result.detail, /control process exited/)

  res = await fetch(`${base}/admin/api/dsh?operation=does-not-exist`, { headers: authHeaders() })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).code, 'OPERATION_NOT_FOUND')
})
