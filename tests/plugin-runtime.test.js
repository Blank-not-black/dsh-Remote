'use strict'

/**
 * 把插件真正 apply 到一个最小 DSH ctx + HTTP 服务中，
 * 验证路由挂载、管理回退、端口持久化和 commands/agents 桥接。
 * 网关自启在测试中显式关闭，所有 HOME 数据均位于临时目录。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'packages/plugin/index.mjs')
const TOKEN = 'plugin-runtime-test-token'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

test('插件运行时：真实挂载 /remote 并执行管理与命令链路', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-plugin-runtime-'))
  const configDir = path.join(tmpHome, '.dsh-remote')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'token'), TOKEN + '\n', { mode: 0o600 })

  const oldEnv = {}
  for (const key of ['HOME', 'USERPROFILE', 'DSH_REMOTE_AUTOSTART', 'DSH_REMOTE_GATEWAY']) oldEnv[key] = process.env[key]
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  process.env.DSH_REMOTE_AUTOSTART = '0'
  process.env.DSH_REMOTE_GATEWAY = `http://127.0.0.1:${await getFreePort()}`

  let route = null
  const disposers = []
  const eventHandlers = new Map()
  const commandCalls = []
  const skillProviders = []
  const ctx = {
    connection: {},
    webServer: {
      host: '127.0.0.1',
      port: 0,
      register(definition) {
        route = definition
        return () => { route = null }
      },
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    skills: {
      registerProvider(create) {
        const provider = create({ signal: new AbortController().signal, invalidate() {} })
        skillProviders.push(provider)
        return () => {}
      },
    },
    on(name, handler) {
      eventHandlers.set(name, handler)
      return () => eventHandlers.delete(name)
    },
    agents: {
      list() { return [{ id: 'live-session' }, { id: 'other-session' }] },
      get(sessionId) {
        return sessionId === 'live-session' ? { id: 'live-agent' } : undefined
      },
      async resume({ resumeSessionId }) {
        return resumeSessionId === 'resume-session' ? { agent: { id: 'resumed-agent' } } : null
      },
    },
    commands: {
      async list() { return [{ name: 'status' }, { name: 'stop' }] },
      async execute(agent, line, images, signal) {
        assert.deepEqual(images, [])
        assert.equal(signal.aborted, false)
        commandCalls.push({ agent: agent.id, line, images, signal: signal.constructor.name })
        // 新版 DSH 命令成功时返回 void；这不能让客户端把 /status 回退成文本。
        return undefined
      },
    },
  }

  const server = http.createServer((req, res) => {
    if (!route || !req.url.startsWith(route.path)) {
      res.writeHead(404)
      res.end('not mounted')
      return
    }
    Promise.resolve(route.handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(err?.stack || err))
    })
  })

  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
    await new Promise((resolve) => server.close(resolve))
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  ctx.webServer.port = server.address().port
  const base = `http://127.0.0.1:${ctx.webServer.port}`

  const plugin = await import(pathToFileURL(PLUGIN).href + `?test=${Date.now()}`)
  assert.equal(plugin.name, 'dsh-remote')
  assert.deepEqual(plugin.inject, ['webServer', 'commands', 'agents', 'connection'])
  plugin.apply(ctx)
  const launchEndpoint = base + '/remote/admin/api/browser-launch'
  const launchHeaders = { 'x-dsh-remote-client': 'entry' }
  assert.equal((await fetch(launchEndpoint)).status, 405)
  assert.equal((await fetch(launchEndpoint, { method: 'POST' })).status, 403)
  assert.equal((await fetch(launchEndpoint, { method: 'POST', headers: launchHeaders })).status, 503)
  ctx.connection.authorizeIndex = (req, res) => {
    if (req.headers.cookie === 'browser-fixture') return true
    res.writeHead(401); res.end('unauthorized'); return false
  }
  ctx.connection.authenticatedUrl = input => { const url = new URL(input); url.searchParams.set('token', 'fixture-launch'); return url.href }
  assert.equal((await fetch(launchEndpoint, { method: 'POST', headers: launchHeaders })).status, 401)
  const launch = await fetch(launchEndpoint, { method: 'POST', headers: { ...launchHeaders, cookie: 'browser-fixture', host: 'untrusted.invalid' } })
  assert.equal(launch.status, 200)
  assert.equal(launch.headers.get('cache-control'), 'no-store')
  assert.equal(launch.headers.get('referrer-policy'), 'no-referrer')
  const launchData = await launch.json()
  const landing = new URL(launchData.url)
  assert.equal(landing.origin, base)
  assert.equal(landing.hash, '#dsh-remote-connect')
  assert.equal(landing.searchParams.get('token'), 'fixture-launch')
  assert.doesNotMatch(JSON.stringify(launchData), new RegExp(TOKEN))
  assert.equal((await fetch(launchEndpoint + '?url=https://other.invalid', { method: 'POST', headers: launchHeaders })).status, 400)
  assert.equal(plugin.browserLaunchUrl({ ...ctx, webServer: { host: '::', port: 12345, protocol: 'https:' } }).startsWith('https://[::1]:12345/'), true)
  assert.equal(plugin.browserLaunchUrl({ ...ctx, webServer: { host: '192.0.2.1', port: 12345 } }), null)
  assert.equal(plugin.browserLaunchUrl({ ...ctx, connection: { authenticatedUrl: () => 'https://other.invalid/' } }), null)
  delete ctx.connection.authenticatedUrl
  delete ctx.connection.authorizeIndex
  assert.equal(skillProviders.length, 1, 'doctor skill provider is registered once')
  const doctorProvider = skillProviders[0]
  assert.equal(doctorProvider.name, 'dsh-remote-doctor')
  const doctorCandidates = await doctorProvider.list({})
  assert.equal(doctorCandidates.length, 1)
  assert.equal(doctorCandidates[0].name, 'dsh-remote-doctor')
  assert.equal(doctorCandidates[0].source, 'bundled')
  assert.equal(doctorCandidates[0].invocation.userInvocable, true)
  const doctor = await doctorProvider.get(doctorCandidates[0], {})
  assert.match(doctor.content, /Read-only by default/)
  assert.match(doctor.content, /Never print secrets/)
  assert.match(doctor.content, /反馈草稿/)
  assert.doesNotMatch(doctor.content, /^---/)
  assert.equal(route?.kind, 'prefix')
  assert.equal(route?.path, '/remote')
  assert.ok(eventHandlers.has('session/event'))
  assert.equal((await fetch(`${base}/remote/api/host-description`)).status, 401)
  const costResponse = await fetch(`${base}/remote/admin/api/cost`)
  assert.equal(costResponse.status, 200); assert.equal(costResponse.headers.get('cache-control'), 'no-store')
  assert.equal((await costResponse.json()).code, 'not-installed', 'missing cost-meter is explicit and does not require a running gateway')
  assert.equal((await fetch(`${base}/remote/admin/api/cost`, { method: 'POST' })).status, 405)
  const hostResponse = await fetch(`${base}/remote/api/host-description`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(hostResponse.headers.get('cache-control'), 'no-store')
  const host = await hostResponse.json()
  assert.equal(host.cwd, process.cwd())
  assert.equal(host.attachedSessions, 2)
  assert.equal(host.version, null, 'unknown launch must not use the Remote version')
  assert.equal(host.metadataOnly, true)
  assert.equal((await fetch(`${base}/remote/api/host-description`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405)
  assert.equal((await fetch(`${base}/remote/api/plugins/state`)).status, 401)
  const pluginState = await fetch(`${base}/remote/api/plugins/state`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(pluginState.status, 200)
  assert.equal((await pluginState.json()).writable, false, 'unknown profile must never default to web')
  assert.equal((await fetch(`${base}/remote/api/plugins/operations`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{broken' })).status, 400)

  const redirect = await fetch(`${base}/remote`, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/remote/')

  const page = await fetch(`${base}/remote/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') || '', /text\/html/)
  assert.match(await page.text(), /DSH Remote/i)

  // Desktop 在抽屉内由状态面板进入管理页；两页及相对资源均须可访问。
  for (const routePath of ['/remote/plugin.html', '/remote/admin/']) {
    const response = await fetch(base + routePath)
    assert.equal(response.status, 200, routePath)
    const html = await response.text()
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      const assetUrl = new URL(match[1], response.url)
      assert.equal((await fetch(assetUrl)).status, 200, assetUrl.pathname)
    }
  }

  const malformed = await fetch(`${base}/remote/%E0%A4%A`)
  assert.equal(malformed.status, 404)

  await t.test('首次安装可直接从插件下载 APK，网关关闭时仍可用', async () => {
    const localApk = path.join(ROOT, 'packages/plugin/apk/dsh-remote.apk')
    const head = await fetch(`${base}/remote/dsh-remote.apk`, { method: 'HEAD' })
    if (fs.existsSync(localApk)) {
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('content-type'), 'application/vnd.android.package-archive')
      assert.match(head.headers.get('content-disposition'), /attachment; filename="dsh-remote.apk"/)
      assert.equal(Number(head.headers.get('content-length')), fs.statSync(localApk).size)
      assert.equal((await head.arrayBuffer()).byteLength, 0)
      const response = await fetch(`${base}/remote/dsh-remote.apk`)
      assert.equal(response.status, 200)
      const hash = require('node:crypto').createHash('sha256')
      for await (const chunk of response.body) hash.update(chunk)
      assert.equal(hash.digest('hex'), require('node:crypto').createHash('sha256').update(fs.readFileSync(localApk)).digest('hex'))
    } else assert.equal(head.status, 404, '没有 APK 的插件明确报告缺失')
    assert.equal((await fetch(`${base}/remote/dsh-remote.apk`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/remote/apk/dsh-remote.apk`)).status, 404)
    assert.equal((await fetch(`${base}/remote/package.json`)).status, 404)
  })

  const stateRes = await fetch(`${base}/remote/admin/api/state`)
  assert.equal(stateRes.status, 200)
  const state = await stateRes.json()
  assert.equal(state.mode, 'plugin')
  assert.equal(state.token, TOKEN)
  assert.equal(state.host, '127.0.0.1')
  assert.equal(state.port, ctx.webServer.port)
  assert.equal(state.platform, process.platform)
  assert.equal(state.events.mux.connected, false)
  assert.equal(state.events.host.connected, false)

  const stats = await fetch(`${base}/remote/admin/api/stats/summary?days=7`)
  assert.equal(stats.status, 502)

  let configRes = await fetch(`${base}/remote/admin/api/config`)
  assert.equal(configRes.status, 200)
  let config = await configRes.json()
  assert.equal(config.port, 8787)
  assert.equal(config.running, false)

  const invalidPort = await fetch(`${base}/remote/admin/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: 70000 }),
  })
  assert.equal(invalidPort.status, 400)

  configRes = await fetch(`${base}/remote/admin/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: 18787 }),
  })
  assert.equal(configRes.status, 200)
  config = await configRes.json()
  assert.equal(config.effectivePort, 18787)
  assert.equal(config.running, false)
  assert.equal(fs.readFileSync(path.join(configDir, 'gateway-port'), 'utf8').trim(), '18787')

  const unauthorized = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/status' }),
  })
  assert.equal(unauthorized.status, 401)

  const live = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/status' }),
  })
  assert.equal(live.status, 202)
  const liveBody = await live.json()
  assert.equal(liveBody.ok, true)
  assert.equal(liveBody.executed, true)
  assert.equal(liveBody.accepted, true)
  assert.equal(liveBody.debug.resolvePath, 'live')
  assert.deepEqual(liveBody.debug.commandNames, ['status', 'stop'])

  const unknown = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/not-a-command keep-as-text' }),
  })
  assert.equal(unknown.status, 200)
  const unknownBody = await unknown.json()
  assert.equal(unknownBody.ok, true)
  assert.equal(unknownBody.executed, false)
  assert.equal(unknownBody.debug.reason, 'unknown-command')

  ctx.commands.execute = async function executeLegacy(agent, line, signal) {
    assert.equal(signal.aborted, false)
    commandCalls.push({ agent: agent.id, line, signal: signal.constructor.name })
    // 旧版三参数签名同样允许 void 成功。
    return undefined
  }
  const resumed = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'resume-session', line: '/stop' }),
  })
  assert.equal(resumed.status, 202)
  const resumedBody = await resumed.json()
  assert.equal(resumedBody.executed, true)
  assert.equal(resumedBody.accepted, true)
  assert.equal(resumedBody.debug.resolvePath, 'resume')

  ctx.commands.execute = async function executeModernDefault(agent, line, images = [], signal) {
    assert.deepEqual(images, [])
    assert.equal(signal.aborted, false)
    commandCalls.push({ agent: agent.id, line, images, signal: signal.constructor.name, arity: this.execute.length })
    return undefined
  }
  const modernDefault = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/status' }),
  })
  assert.equal(modernDefault.status, 202)
  assert.equal((await modernDefault.json()).executed, true)
  assert.deepEqual(commandCalls, [
    { agent: 'live-agent', line: '/status', images: [], signal: 'AbortSignal' },
    { agent: 'resumed-agent', line: '/stop', signal: 'AbortSignal' },
    { agent: 'live-agent', line: '/status', images: [], signal: 'AbortSignal', arity: 2 },
  ])

  let finishCompact
  ctx.commands.list = async () => [{ name: 'compact' }]
  ctx.commands.execute = function executeCompact(agent, line, images, signal) {
    assert.equal(agent.id, 'live-agent')
    assert.equal(line, '/compact')
    assert.deepEqual(images, [])
    assert.equal(signal.aborted, false)
    return new Promise(resolve => { finishCompact = () => resolve({ result: { kind: 'success', text: 'Compacted 2 history items.' } }) })
  }
  const compact = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/compact' }),
  })
  assert.equal(compact.status, 202)
  const compactBody = await compact.json()
  assert.equal(compactBody.accepted, true)
  assert.equal(compactBody.compact.active, true)

  const compactRunning = await fetch(`${base}/remote/api/command-status?sessionId=live-session`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal((await compactRunning.json()).compact.active, true)
  finishCompact()
  await new Promise(resolve => setTimeout(resolve, 0))
  const compactFinished = await fetch(`${base}/remote/api/command-status?sessionId=live-session`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const compactFinishedBody = await compactFinished.json()
  assert.equal(compactFinishedBody.compact.active, false)
  assert.equal(compactFinishedBody.compact.phase, 'complete')

  let finishSlow
  ctx.commands.list = async () => [{ name: 'slow' }]
  ctx.commands.execute = function executeSlow(agent, line, images, signal) {
    assert.equal(agent.id, 'live-agent')
    assert.equal(line, '/slow')
    assert.deepEqual(images, [])
    assert.equal(signal.aborted, false)
    return new Promise(resolve => { finishSlow = () => resolve({ result: { kind: 'success', text: 'slow command complete' } }) })
  }
  const slow = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/slow' }),
  })
  assert.equal(slow.status, 202)
  const slowBody = await slow.json()
  assert.equal(slowBody.operation.command, 'slow')
  assert.equal(slowBody.operation.active, true)
  finishSlow()
  await new Promise(resolve => setTimeout(resolve, 0))
  const commandStatus = async () => (await fetch(`${base}/remote/api/command-status?sessionId=live-session`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json()
  const completed = (await commandStatus()).operation
  assert.equal(completed.id, slowBody.operation.id)
  assert.equal(completed.executed, true)
  assert.equal(completed.phase, 'complete')
  assert.equal(completed.message, 'slow command complete')

  for (const result of [false, { executed: false }, { result: { kind: 'error', text: 'C:\\private\\secret.txt' } }]) {
    ctx.commands.execute = async () => result
    const response = await fetch(`${base}/remote/api/command`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'live-session', line: '/slow', async: true }),
    })
    assert.equal(response.status, 202)
    const accepted = await response.json()
    await new Promise(resolve => setTimeout(resolve, 0))
    const terminal = (await commandStatus()).operation
    assert.equal(terminal.id, accepted.operation.id)
    assert.notEqual(terminal.id, completed.id)
    assert.equal(terminal.phase, 'failed')
    assert.equal(terminal.executed, result?.result?.kind === 'error')
    assert.doesNotMatch(terminal.message, /private|secret/)
  }
  ctx.commands.execute = async () => { throw new Error('C:\\private\\secret.txt') }
  const thrown = await fetch(`${base}/remote/api/command`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/slow', async: true }),
  })
  assert.equal(thrown.status, 202)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await commandStatus()).operation.message, 'command-failed')
  const oversized = await fetch(`${base}/remote/api/command`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'live-session', line: '/slow ' + '中'.repeat(24000) }),
  })
  assert.equal(oversized.status, 413)
  await oversized.text()

  const line = '/slow 中文😀'
  ctx.commands.execute = async (_agent, actual) => { assert.equal(actual, line); return false }
  const bytes = Buffer.from(JSON.stringify({ sessionId: 'live-session', line, async: true }))
  const cut = bytes.indexOf(Buffer.from('😀')) + 1
  const fragmented = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/remote/api/command`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.write(bytes.subarray(0, cut))
    setTimeout(() => req.end(bytes.subarray(cut)), 10)
  })
  assert.equal(fragmented, 202)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await commandStatus()).operation.executed, false)

  ctx.agents.resume = async () => { throw new Error('C:\\private\\session.json') }
  const failedResume = await fetch(`${base}/remote/api/command`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'missing-session', line: '/slow', async: true }),
  })
  assert.equal(failedResume.status, 200)
  assert.doesNotMatch(await failedResume.text(), /private|session\.json/)
})
