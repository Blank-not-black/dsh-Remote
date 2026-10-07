import http from 'node:http'
import { apply } from '../../packages/plugin/index.mjs'
let route
const ctx = { connection: {}, agents: {}, commands: {},
  webServer: { host: '127.0.0.1', port: Number(process.env.TEST_UPSTREAM_PORT), register(value) { route = value; return () => {} } },
  effect(fn) { fn() }, on() {},
}
apply(ctx)
http.createServer((req, res) => {
  if (req.url === '/') { res.end('ok'); return }
  if (req.headers.cookie !== 'bridge-test=session' || !route || !req.url.startsWith(route.path)) { res.writeHead(401); res.end(); return }
  Promise.resolve(route.handler(req, res)).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message) })
}).listen(ctx.webServer.port, ctx.webServer.host)
