'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise(resolve => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = once(child, 'exit')
  child.kill()
  await done
}

test('plugin records CLI profile, home, arguments and port; never records Desktop', { skip: process.platform !== 'win32' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launch-record-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const profile = path.join(home, 'profiles', 'custom-web')
  const cli = path.join(home, 'cli', 'lib', 'bin.js')
  const output = path.join(home, 'launch.json')
  fs.mkdirSync(profile, { recursive: true })
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  fs.writeFileSync(path.join(home, 'cli', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  fs.writeFileSync(cli, '')
  const runner = path.join(home, 'record.mjs')
  fs.writeFileSync(runner, `
import { saveDshLaunchConfig } from ${JSON.stringify(pathToFileURL(path.join(__dirname, '../packages/plugin/index.mjs')).href)};
import assert from 'node:assert/strict';
process.argv = [process.execPath, ${JSON.stringify(cli)}, '--profile', 'custom-web', '--port', '31999', '--patch', './local.yml'];
const ctx = { root: { baseUrl: ${JSON.stringify(pathToFileURL(profile + path.sep).href)} }, webServer: { host: '0.0.0.0', port: 31999 } };
assert.equal(saveDshLaunchConfig(ctx), true);
Object.defineProperty(process.versions, 'electron', { value: '1' });
assert.equal(saveDshLaunchConfig(ctx), false);
`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_REMOTE_FS_ROOT: home, TOKEN: 'record-test', DSH_REMOTE_DSH_LAUNCH_FILE: output }
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key]
  const child = spawn(process.execPath, [runner], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stderr.on('data', b => { logs += b })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, logs)
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(saved.env.DSH_HOME, home)
  assert.equal(saved.profile, 'custom-web')
  assert.equal(saved.upstream, 'http://127.0.0.1:31999')
  assert.deepEqual(saved.args, [cli, '--profile', 'custom-web', '--port', '31999', '--patch', './local.yml', '--no-open'])
})

test('process lifecycle: safe start, complete readiness, owned restart, external protection and config validation', { timeout: 60000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-process-control-'))
  const launchFile = path.join(home, 'launch.json')
  const script = path.join(home, 'fake dsh.cjs')
  const pidFile = path.join(home, 'pid')
  let gateway, external, ownedPid
  t.after(async () => {
    await stop(gateway)
    await stop(external)
    if (ownedPid) { try { process.kill(ownedPid) } catch {} }
    await sleep(150)
    fs.rmSync(home, { recursive: true, force: true })
  })
  fs.writeFileSync(script, `
const http = require('node:http'), crypto = require('node:crypto'), fs = require('node:fs');
if (process.argv[4] === 'exit') process.exit(7);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = http.createServer((q,r) => { r.writeHead(process.argv[4] === 'bad' ? 503 : 200); r.end('ok'); });
server.on('upgrade', (q,s) => {
 if (process.argv[4] === 'no-ws') { s.destroy(); return; }
 const accept = crypto.createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');
 s.on('error',()=>{});
});
server.listen(Number(process.argv[2]), '127.0.0.1');
`)
  const upstreamPort = await freePort(), gatewayPort = await freePort()
  const base = `http://127.0.0.1:${gatewayPort}`
  const config = { version: 1, executable: process.execPath, args: [script, String(upstreamPort), 'placeholder', 'ok'], cwd: home, env: { HOME: home, USERPROFILE: home }, upstream: `http://127.0.0.1:${upstreamPort}` }
  const save = mode => { config.args[3] = mode; fs.writeFileSync(launchFile, JSON.stringify(config)) }
  // argv[4] is the mode; args consists of script, port, placeholder, mode.
  save('ok')
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_DSH_LAUNCH_FILE: launchFile, DSH_REMOTE_DSH_CONTROL_MODE: 'process',
    DSH_REMOTE_DSH_CONTROL_TIMEOUT_MS: '2500', DSH_REMOTE_DSH_CONTROL_POLL_MS: '50',
    HOST: '127.0.0.1', PORT: String(gatewayPort), DSH_UPSTREAM: config.upstream, TOKEN: 'process-test-token', TOKEN_FILE: path.join(home, 'token'),
    DSH_REMOTE_ANNOUNCEMENTS_URL: '', UPDATE_CHECK_URL: '', DSH_REMOTE_DSH_COOKIE_FILE: path.join(home, 'cookie'),
  }
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key]
  const headers = { authorization: 'Bearer process-test-token', 'content-type': 'application/json' }
  const get = async route => (await fetch(base + route, { headers, signal: AbortSignal.timeout(6000) })).json()
  async function startGateway(mode = 'process') {
    gateway = spawn(process.execPath, [path.join(__dirname, '..', 'gateway.js')], { env: { ...env, DSH_REMOTE_DSH_CONTROL_MODE: mode, DSH_REMOTE_DSH_SERVICE: 'dsh-test-service-does-not-exist' }, stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      try { await get('/health?probe=live'); return } catch {}
      await sleep(50)
    }
    throw new Error('gateway startup failed')
  }
  async function action(action) {
    const response = await fetch(base + '/admin/api/dsh', { method: 'POST', headers, body: JSON.stringify({ action }) })
    assert.equal(response.status, 202)
    const accepted = await response.json()
    for (let i = 0; i < 160; i++) {
      const result = await get('/admin/api/dsh?operation=' + accepted.operationId)
      if (result.done) return result
      await sleep(50)
    }
    throw new Error('operation timeout')
  }
  await startGateway(process.platform === 'win32' ? 'auto' : 'process')
  let result = await action('start')
  ownedPid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.events.ok, true)
  assert.equal(result.status.manager, 'process')
  assert.equal(result.status.canRestart, true)
  result = await action('start')
  assert.equal(result.ok, true)
  assert.equal(result.status.mainPid, ownedPid, 'start must not duplicate a running instance')
  result = await action('restart')
  const previousPid = ownedPid
  ownedPid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.notEqual(ownedPid, previousPid)
  await stop(gateway)
  await startGateway()
  result = await action('restart')
  assert.equal(result.code, 'EXTERNAL_PROCESS')
  assert.equal((await get('/health')).dshControl.canRestart, false)
  process.kill(ownedPid)
  ownedPid = null
  await sleep(150)
  external = spawn(process.execPath, [script, String(upstreamPort), 'placeholder', 'bad'], { env, stdio: 'ignore' })
  await sleep(300)
  result = await action('start')
  assert.equal(result.code, 'PORT_IN_USE')
  await stop(external)
  save('exit')
  result = await action('start')
  assert.equal(result.code, 'SERVICE_FAILED', JSON.stringify(result))
  assert.match(result.detail, /dsh-process\.log/)
  save('no-ws')
  result = await action('start')
  ownedPid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.equal(result.code, 'EVENTS_TIMEOUT', JSON.stringify(result))
  result = await action('start')
  assert.equal(result.ok, false, 'already-running is not enough when event channels fail')
  fs.unlinkSync(launchFile)
  assert.equal((await get('/health')).capabilities.dshLifecycle, 0)
  assert.equal((await get('/admin/api/dsh')).supported, false)
})
