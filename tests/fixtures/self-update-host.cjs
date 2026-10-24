'use strict'
// An isolated DSH-shaped host/CLI. The plugin, gateway, detached worker and
// transaction code are real; only upstream RPC and package download are faked.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { createHash } = require('node:crypto'), { pathToFileURL } = require('node:url')
const home = process.env.DSH_HOME, config = JSON.parse(fs.readFileSync(path.join(home, 'self-update.json')))
const remote = path.join(config.dir, 'node_modules/dsh-remote-plugin')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

async function main() {
  if (process.argv[2] === 'plugin') {
    fs.appendFileSync(path.join(home, 'cli-calls'), JSON.stringify(process.argv.slice(2)) + '\n')
    fs.writeFileSync(path.join(home, 'cli-started'), String(process.pid))
    const deadline = Date.now() + 15000
    while (!fs.existsSync(path.join(home, 'allow-replacement'))) {
      if (Date.now() > deadline) throw Error('Test did not release package replacement')
      await pause(25)
    }
    // Use a real directory rename, including on Windows with a live gateway.
    fs.renameSync(remote, path.join(home, 'displaced-remote'))
    fs.cpSync(config.staged, remote, { recursive: true })
    const manifest = JSON.parse(fs.readFileSync(path.join(config.dir, 'package.json')))
    manifest.dependencies['dsh-remote-plugin'] = config.target
    fs.writeFileSync(path.join(config.dir, 'package.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(config.dir, 'pnpm-lock.yaml'), config.targetLock)
    if (fs.existsSync(path.join(home, 'fail-after-replacement'))) throw Error('Injected CLI failure after package replacement')
    return
  }
  if (process.argv[2] === '--legacy') {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/health')) return json(res, 200, {
        ok: true, service: 'dsh-remote', version: '0.7.0', probe: 'live', liveness: { ok: true, pid: process.pid },
      })
      if (req.headers.authorization !== 'Bearer ' + process.env.LEGACY_TEST_TOKEN) {
        fs.appendFileSync(path.join(home, 'legacy-audit'), 'rejected\n')
        return json(res, 401, { ok: false })
      }
      if (req.url === '/admin/api/shutdown' && req.method === 'POST') {
        fs.appendFileSync(path.join(home, 'legacy-audit'), 'authenticated-shutdown\n')
        json(res, 200, { ok: true, bye: true })
        server.close(() => process.exit(0)); server.closeAllConnections()
      } else json(res, 200, { ok: true })
    })
    await new Promise(resolve => server.listen(config.gatewayPort, '127.0.0.1', resolve))
    process.send?.({ ready: true })
    return
  }
  // Keep all registry metadata local. A real pnpm/DSH-carrier integration is
  // tested separately by plugin-transaction-pnpm.test.js.
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (url, options) => String(url).startsWith('https://registry.npmjs.org/')
    ? Promise.resolve(new Response(JSON.stringify({ name: 'dsh-remote-plugin', version: config.target, dsh: { bundle: { patch: './cordis.patch.yml' } } })))
    : nativeFetch(url, options)
  let route
  const effects = [], sockets = new Set()
  const ctx = {
    root: { baseUrl: pathToFileURL(config.dir + path.sep) },
    webServer: { host: '127.0.0.1', port: config.dshPort, register(value) { route = value; return () => { route = null } } },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose) },
    on() {}, agents: { get() {}, async resume() { return null } }, commands: { async list() { return [] }, async execute() {} },
  }
  const server = http.createServer((req, res) => {
    if (route && req.url.startsWith(route.path)) return void route.handler(req, res)
    if (req.url === '/') return json(res, 200, { ok: true })
    json(res, 200, { result: { ok: true, value: { items: [] } } })
  })
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    // Test runs are short, but answer RFC6455 ping frames if one arrives.
    socket.on('data', frame => { if ((frame[0] & 15) === 9) socket.write(Buffer.from([0x8a, 0])) })
  })
  await new Promise(resolve => server.listen(config.dshPort, '127.0.0.1', resolve))
  const plugin = await import(pathToFileURL(path.join(remote, 'index.mjs')))
  plugin.apply(ctx)
  process.send?.({ ready: true })
  process.on('message', message => {
    if (message !== 'stop') return
    for (const dispose of effects.reverse()) dispose()
    for (const socket of sockets) socket.destroy()
    server.close(() => process.exit(0)); server.closeAllConnections()
  })
}
main().catch(error => { console.error(error); process.exit(1) })
