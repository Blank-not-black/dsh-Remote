'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

test('Embedded admin proxies login startup through the authenticated gateway without exposing commands', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-login-'))
  fs.mkdirSync(path.join(home, '.dsh-remote'))
  fs.writeFileSync(path.join(home, '.dsh-remote', 'token'), 'plugin-login-token')
  const oldEnv = {}
  for (const name of ['HOME', 'USERPROFILE', 'DSH_REMOTE_AUTOSTART', 'DSH_REMOTE_GATEWAY']) oldEnv[name] = process.env[name]
  const calls = [], effects = []
  let route
  const gateway = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, supported: true, enabled: req.method === 'POST' }))
    })
  })
  const server = http.createServer((req, res) => Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(error.message) }))
  t.after(async () => {
    for (const cleanup of effects.reverse()) cleanup?.()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => gateway.close(resolve))])
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(home, { recursive: true, force: true })
  })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  Object.assign(process.env, { HOME: home, USERPROFILE: home, DSH_REMOTE_AUTOSTART: '0', DSH_REMOTE_GATEWAY: `http://127.0.0.1:${gateway.address().port}` })
  const plugin = await import(pathToFileURL(path.join(__dirname, '../packages/plugin/index.mjs')).href + '?login=' + Date.now())
  plugin.apply({ connection: {}, webServer: { host: '127.0.0.1', port: server.address().port, register(value) { route = value } },
    agents: {}, commands: {}, on() {}, effect(fn) { effects.push(fn()) } })
  const url = `http://127.0.0.1:${server.address().port}/remote/admin/api/autostart`
  const read = await fetch(url)
  assert.equal(read.status, 200)
  assert.equal((await read.json()).enabled, false)
  const update = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' })
  assert.equal(update.status, 200)
  assert.equal((await update.json()).enabled, true)
  assert.deepEqual(calls, [
    { method: 'GET', path: '/admin/api/autostart', auth: 'Bearer plugin-login-token', body: '' },
    { method: 'POST', path: '/admin/api/autostart', auth: 'Bearer plugin-login-token', body: '{"enabled":true}' },
  ])
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 405)
  assert.equal(calls.length, 2)
})
