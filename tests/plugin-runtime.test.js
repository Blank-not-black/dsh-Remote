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
  const ctx = {
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
    on(name, handler) {
      eventHandlers.set(name, handler)
      return () => eventHandlers.delete(name)
    },
    agents: {
      get(sessionId) {
        return sessionId === 'live-session' ? { id: 'live-agent' } : undefined
      },
      async resume({ resumeSessionId }) {
        return resumeSessionId === 'resume-session' ? { agent: { id: 'resumed-agent' } } : null
      },
    },
    commands: {
      async list() { return [{ name: 'status' }, { name: 'stop' }] },
      async execute(agent, line) {
        commandCalls.push({ agent: agent.id, line })
        return { ok: true }
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
  assert.deepEqual(plugin.inject, ['webServer', 'commands', 'agents'])
  plugin.apply(ctx)
  assert.equal(route?.kind, 'prefix')
  assert.equal(route?.path, '/remote')
  assert.ok(eventHandlers.has('session/event'))

  const redirect = await fetch(`${base}/remote`, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/remote/')

  const page = await fetch(`${base}/remote/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') || '', /text\/html/)
  assert.match(await page.text(), /DSH Remote/i)

  const malformed = await fetch(`${base}/remote/%E0%A4%A`)
  assert.equal(malformed.status, 404)

  const stateRes = await fetch(`${base}/remote/admin/api/state`)
  assert.equal(stateRes.status, 200)
  const state = await stateRes.json()
  assert.equal(state.mode, 'plugin')
  assert.equal(state.token, TOKEN)
  assert.equal(state.host, '127.0.0.1')
  assert.equal(state.port, ctx.webServer.port)

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
  assert.equal(live.status, 200)
  const liveBody = await live.json()
  assert.equal(liveBody.ok, true)
  assert.equal(liveBody.executed, true)
  assert.equal(liveBody.debug.resolvePath, 'live')
  assert.deepEqual(liveBody.debug.commandNames, ['status', 'stop'])

  const resumed = await fetch(`${base}/remote/api/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'resume-session', line: '/stop' }),
  })
  assert.equal(resumed.status, 200)
  assert.equal((await resumed.json()).debug.resolvePath, 'resume')
  assert.deepEqual(commandCalls, [
    { agent: 'live-agent', line: '/status' },
    { agent: 'resumed-agent', line: '/stop' },
  ])
})
