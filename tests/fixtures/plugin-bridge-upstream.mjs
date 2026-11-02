import http from 'node:http'
import { apply } from '../../packages/plugin/index.mjs'
let route
const ctx = { connection: {}, agents: {}, commands: {},
  get(name) { return name === 'llm' ? { async *stream() {
    yield { type:'text-delta', index:0, text:'此操作涉及删除，需人工确认范围。' }
    yield { type:'finish', reason:{ kind:'stop' } }
  } } : undefined },
  webServer: { host: '127.0.0.1', port: Number(process.env.TEST_UPSTREAM_PORT), register(value) { route = value; return () => {} } },
  effect(fn) { fn() }, on() {},
}
const summarySession = { id:'summary-session', log:[
  { type:'turn/start' },
  { type:'approval/asked', data:{ id:'summary-audit', callId:'summary-call', toolName:'pwsh', reason:'Auto review denied tool "pwsh": Delete existing files' } }
], requestHeader:() => ({ config:{ provider:'fixture',model:'fixture' } }) }
ctx.agents.get = id => id === summarySession.id ? { session:summarySession } : undefined
apply(ctx)
http.createServer((req, res) => {
  if (req.url === '/') { res.end('ok'); return }
  if (req.headers.cookie !== 'bridge-test=session' || !route || !req.url.startsWith(route.path)) { res.writeHead(401); res.end(); return }
  Promise.resolve(route.handler(req, res)).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message) })
}).listen(ctx.webServer.port, ctx.webServer.host)
