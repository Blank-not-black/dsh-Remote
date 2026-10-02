'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')

function bridge() {
  const frames = []
  const modernState = { sessions: new Map(), sessionCursors: new Map(), assistantStreams: new Map(), workspaces: { items: [], archivedSessionIds: [] } }
  const context = vm.createContext({ crypto, modernState, legacyPush: (kind, payload) => frames.push({ kind, payload }),
    callUpstreamRemote: async () => ({ status: 200, body: { result: { ok: true, value: { archivedSessionIds: ['s'] } } } }),
    modernResponseNeedsLegacyFallback: () => false,
  })
  vm.runInContext(source.slice(source.indexOf('function legacyEnvelope('), source.indexOf('function modernResponseNeedsLegacyFallback('))
    + source.slice(source.indexOf('async function translateModernRpc('), source.indexOf('/** 递归截断'))
    + source.slice(source.indexOf('function openModernSessionStream('), source.indexOf('function resolveModernPendingEvent(')), context)
  return { frames, modernState, context }
}

test('DSH 0.2: committed archive receipt is visible before workspace stream delivery', async () => {
  const { context, modernState } = bridge()
  modernState.workspaces.items = [{ workspaceId: 'keep' }]
  await context.translateModernRpc('workspace.archiveSession', { sessionId: 's' }, 'archive')
  const listed = await context.translateModernRpc('workspace.list', {}, 'list')
  assert.deepEqual(Array.from(listed.result.value.archivedSessionIds), ['s'])
  assert.equal(listed.result.value.items[0].workspaceId, 'keep')
})

test('DSH 0.2: Inbox baseline, replacement and clearing preserve queue identity and content', () => {
  const { context, frames } = bridge()
  const queued = { id: 'q', content: [{ type: 'text', text: '排队内容' }], source: { kind: 'user' } }
  const steer = { id: 'steer', content: [{ type: 'image', data: 'AA==' }] }
  context.applyModernControlFrame({ type: 'baseline', value: { projections: { s: { asOfSeq: 8, values: { inbox: { 'next-turn': [queued], 'next-step': [steer] } } } } } })
  let items = frames.at(-1).payload.items
  assert.equal(items[0].id, 'q')
  assert.equal(items[0].placement, 'queued')
  assert.equal(items[0].message.content[0].text, '排队内容')
  assert.equal(items[1].placement, 'context')
  context.applyModernSessionFrame('s', { type: 'snapshot', cursor: 9, records: [], projections: { asOfSeq: 9, values: { inbox: { 'next-turn': [queued], 'next-step': [] } } } })
  assert.equal(frames.at(-1).payload.items.length, 1)
  context.applyModernControlFrame({ type: 'projection', sessionId: 's', key: 'inbox', value: { 'next-turn': [], 'next-step': [] }, seq: 10 })
  assert.equal(frames.at(-1).payload.items.length, 0)
  context.applyModernControlFrame({ type: 'queue', sessionId: 'old', items: [{ id: 'legacy' }] })
  assert.equal(frames.at(-1).payload.items[0].id, 'legacy', 'older control queue frames still work')
})

test('DSH 0.2: one job roster per ordinary session, replacement and empty rows reach clients', () => {
  const { context, modernState, frames } = bridge()
  const sent = []
  const ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) }
  context.openModernSessionStream(ws, 's')
  assert.equal(sent[1].endpoint, 'job/list')
  assert.equal(sent[1].payload.args.request.sessionId, 's')
  modernState.sessions.set('child', { origin: 'subagent' })
  context.openModernSessionStream(ws, 'child')
  assert.equal(sent.length, 2, 'subagent follow remains fenced')
  context.applyModernJobFrame('s', { type: 'rows', jobs: [{ id: 'bash-1', status: 'running' }] })
  assert.equal(frames.at(-1).payload.jobs[0].status, 'running')
  context.applyModernJobFrame('s', { type: 'rows', jobs: [] })
  assert.equal(frames.at(-1).payload.jobs.length, 0)
})

test('late clients replay only the newest queue and job rosters, including clearing', () => {
  const collectorReplay = { mux: new Map(), host: new Map() }
  const context = vm.createContext({ collectorReplay })
  vm.runInContext(source.slice(source.indexOf('function rememberCollectorReplay('), source.indexOf('function broadcastCollectorFrame(')), context)
  for (const type of ['session/queue', 'session/jobs']) {
    for (const items of [[{ id: 'pending' }], []]) {
      const payload = { type, sessionId: 's', ...(type === 'session/queue' ? { items } : { jobs: items }) }
      const frame = { payload }
      context.rememberCollectorReplay('mux', frame, JSON.stringify(frame))
    }
  }
  assert.equal(collectorReplay.mux.size, 2)
  assert.equal(JSON.parse(collectorReplay.mux.get('queue:s')).payload.items.length, 0)
  assert.equal(JSON.parse(collectorReplay.mux.get('jobs:s')).payload.jobs.length, 0)
})

test('DSH 0.2: removed subagent list reads durable projections and preserves diagnostics', async () => {
  const { context, modernState } = bridge()
  const requests = []
  let oldAvailable = false
  context.modernResponseNeedsLegacyFallback = response => response.status === 404
  context.callUpstreamRemote = async (endpoint, args) => {
    requests.push({ endpoint, args })
    if (endpoint === 'subagents/list') return oldAvailable
      ? { status: 200, body: { result: { ok: true, value: { entries: [{ id: 'old' }] } } } }
      : { status: 404 }
    if (endpoint === 'session/list') return { status: 200, body: { result: { ok: true, value: { items: [] } } } }
    const sessionId = args.request.sessionId
    const values = sessionId === 'parent' ? { subagentCatalog: [{ id: 'child', mode: 'continuable' }, { id: 'unknown', mode: 'unknown' }, { id: 'missing', mode: 'one-shot' }, { id: 'broken', mode: 'one-shot' }] }
      : sessionId === 'child' ? { subagent: { mode: 'continuable', label: '工作子代理' }, subagentCatalog: [{ id: 'grandchild' }] }
        : sessionId === 'broken' ? { subagent: null } : null
    return { status: 200, body: { result: { ok: true, value: values && { values } } } }
  }
  context.refreshModernSessions = async () => {
    modernState.sessions.set('child', { running: true })
    modernState.sessions.set('parent', { agentAvailable: true })
  }
  const result = await context.translateModernRpc('subagent.list', { parentSessionId: 'parent' }, 'list')
  const value = result.result.value
  assert.equal(value.parentAvailable, true)
  assert.equal(value.entries[0].label, '工作子代理')
  assert.equal(value.entries[0].activity, 'running')
  assert.equal(value.entries[0].hasChildren, true)
  assert.deepEqual(Array.from(value.entries.slice(1), entry => entry.reason), ['unsupported', 'unavailable', 'corrupt'])
  assert.equal(requests[1].args.request.sessionId, 'parent')
  oldAvailable = true
  const old = await context.translateModernRpc('subagent.list', { parentSessionId: 'parent' }, 'old-list')
  assert.equal(old.result.value.entries[0].id, 'old', 'old generated Hosts retain their own catalog semantics')
})
