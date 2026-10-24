import http from 'node:http'
import { apply } from '../../packages/plugin/index.mjs'
import data from './insights-data.cjs'
import teams from './teams-data.cjs'
import board from './task-board-data.cjs'
let route
const state = { ...data.state, config: { ...data.state.config, customBalances: [{ enabled: true, display: 'both' }], gatewayQuotas: { sources: [{ id: 'gateway-a', enabled: true, display: 'both' }] } },
  customBalances: [{ index: 0, label: '自定义渠道', unit: 'EUR', remaining: 12.5, status: 'ok', fetchedAt: Date.now(), message: 'SECRET' }],
  gatewayQuotas: [{ id: 'gateway-a', label: '代理账户', status: 'ok', fetchedAt: Date.now(), accounts: [{ label: 'a***', provider: 'codex', status: 'ok', windows: [{ label: '5h', percent: 25 }] }] }] }
const service = { async getState() { return state }, async getSessionCost() { return data.sessionCost } }
const ctx = { connection: {}, agents: {}, commands: {}, get: key => key === 'costMeter' ? service : key === 'taskBoard' ? { snapshot: () => board.snapshot, apply() { throw Error('MUTATION MUST NOT RUN') } } : key === 'workspaceRegistry' ? { list: () => [{ id: 'workspace-fixture', title: '同名工作区', sessionIds: ['insights-session'] }] } : undefined,
  webServer: { host: '127.0.0.1', port: Number(process.env.TEST_UPSTREAM_PORT), register(value) { route = value; return () => {} } },
  effect(fn) { fn() }, on() {} }
apply(ctx)
const session = { sessionId: 'insights-session', cwd: process.env.DSH_REMOTE_FS_ROOT, running: false,
  projections: { asOfSeq: 20, values: { title: '插件洞察 · 样例会话', contextTimeline: data.head,
    contextPressure: { pressureTokens: 38000, contextWindow: 128000 } } } }
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
http.createServer(async (req, res) => {
  if (req.url === '/') { res.end('ok'); return }
  if (req.headers.cookie !== 'bridge-test=session') return json(res, { error: 'unauthorized' }, 401)
  if (req.url.startsWith('/plugins/dsh-agent-teams/state')) return json(res, teams)
  if (req.url.startsWith('/api/')) {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body || '{}')
    if (req.url === '/api/dsh-context/detail') return json(res, { ok: true, value: data.detail, receivedSessionId: request.sessionId })
    let value = {}
    if (req.url === '/api/session/list') value = { items: [session] }
    else if (req.url === '/api/session/page') value = { events: [], throughSeq: 20, hasMore: false }
    else if (req.url === '/api/session/projections') value = { projections: session.projections }
    else if (req.url === '/api/session/modelCatalog') value = { groups: [], failures: [] }
    return json(res, { type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
  }
  if (!route || !req.url.startsWith(route.path)) return json(res, { error: 'not-found' }, 404)
  try { await route.handler(req, res) } catch { json(res, { error: 'fixture-failed' }, 500) }
}).listen(ctx.webServer.port, ctx.webServer.host)
