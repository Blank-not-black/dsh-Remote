import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../../packages/plugin/index.mjs'
const routes = []
const port = Number(process.env.TEST_UPSTREAM_PORT)
const ctx = { connection: {}, commands: {}, agents: {},
  webServer: { host: '127.0.0.1', port, register(route) { routes.push(route); return () => {} } },
  effect(fn) { fn() }, get() {}, on() {} }
apply(ctx)
if (process.env.DSH_TEST_SKILL_EXPLORER_MODULE) {
  const native = await import(process.env.DSH_TEST_SKILL_EXPLORER_MODULE)
  Object.assign(ctx, { sessions: { list: () => [{ header: { cwd: process.env.DSH_REMOTE_FS_ROOT } }] }, skills: { snapshot: async () => ({ complete: true, skills: [] }) }, logger: { warn() {} } })
  native.apply(ctx, { dshHome: process.env.DSH_HOME, agentsHome: join(process.env.HOME, '.agents') })
}
http.createServer(async (req, res) => {
  if (req.url === '/') return res.end('ok')
  if (req.headers.cookie !== 'skills-test=session') { res.writeHead(401); return res.end() }
  if (!process.env.DSH_TEST_SKILL_EXPLORER_MODULE && req.url.startsWith('/api/dsh-skill-explorer/')) {
    res.setHeader('content-type', 'application/json')
    const file = join(process.env.DSH_HOME, 'skills', 'test-skill', 'SKILL.md')
    if (req.url.endsWith('/list')) return res.end(JSON.stringify({ complete: true, groups: [{ key: 'user-dsh', skills: [{ name: 'test-skill', description: 'Test skill', path: file, modelInvocable: true }] }] }))
    return res.end(JSON.stringify({ name: 'test-skill', path: file, content: readFileSync(file, 'utf8') }))
  }
  const route = routes.find(route => route.kind === 'exact' ? req.url.split('?')[0] === route.path : req.url.startsWith(route.path))
  if (!route) { res.writeHead(404); return res.end() }
  try { await route.handler(req, res) } catch { res.writeHead(500); res.end() }
}).listen(port, '127.0.0.1')
