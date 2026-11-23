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
  const modernState = { sessions: new Map(), sessionCursors: new Map(), assistantStreams: new Map(), sessionInterests: new Map(), followedSessions: new Set(), workspaces: { items: [], archivedSessionIds: [] } }
  const context = vm.createContext({ crypto, modernState, AbortSignal, UPSTREAM: new URL('http://127.0.0.1:1'), UPSTREAM_REQUEST_TIMEOUT_MS: 1000, eventCollectors: { mux: null }, legacyPush: (kind, payload) => frames.push({ kind, payload }),
    callUpstreamRemote: async () => ({ status: 200, body: { result: { ok: true, value: { archivedSessionIds: ['s'] } } } }),
    modernResponseNeedsLegacyFallback: () => false,
  })
  vm.runInContext(source.slice(source.indexOf('function legacyEnvelope('), source.indexOf('function modernResponseNeedsLegacyFallback('))
    + source.slice(source.indexOf('async function readModernSessionPage('), source.indexOf('async function refreshModernSessions('))
    + source.slice(source.indexOf('function modernInboxItems('), source.indexOf('async function readModernQueue('))
    + source.slice(source.indexOf('async function translateModernRpc('), source.indexOf('function wsAccept('))
    + source.slice(source.indexOf('function requestModernSessionStream('), source.indexOf('function resolveModernPendingEvent(')), context)
  return { frames, modernState, context }
}

test('DSH 0.2: child history uses its durable parent address and a fresh projection cursor', async () => {
  const { context, modernState } = bridge(), requests = []
  context.legacyHistoryValue = value => value
  modernState.sessions.set('child', { origin: 'subagent', projections: { asOfSeq: 1 } })
  modernState.sessions.set('fork', { origin: 'fork', parentSessionId: 'parent', projections: { asOfSeq: 3 } })
  context.callUpstreamRemote = async (endpoint, args) => {
    requests.push({ endpoint, args })
    return { status: 200, body: { result: { ok: true, value: endpoint === 'session/projections' ? { asOfSeq: 9 } : { records: [], hasMore: false } } } }
  }
  await context.translateModernRpc('session.history', { sessionId: 'child', parentSessionId: 'parent', subagentMode: 'one-shot', maxMessages: 60 }, 'child')
  assert.equal(requests[0].endpoint, 'session/projections')
  assert.equal(requests[1].endpoint, 'session/events')
  const request = requests[1].args.request
  assert.equal(request.throughSeq, 9)
  assert.deepEqual(JSON.parse(JSON.stringify(request.address)), { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'one-shot' })
  await context.translateModernRpc('session.history', { sessionId: 'fork', parentSessionId: 'parent' }, 'fork')
  assert.equal(requests.at(-1).args.request.address.kind, 'session', 'ordinary forks are not subagents')
  context.callUpstreamRemote = async () => ({ status: 200, body: { result: { ok: true, value: {} } } })
  const missing = await context.translateModernRpc('session.history', { sessionId: 'child', parentSessionId: 'parent', subagentMode: 'one-shot' }, 'missing')
  assert.equal(missing.result.ok, false, 'a missing cursor must not become an empty successful page')
})

test('history falls back only when the events method is missing', async () => {
  const { context } = bridge(), calls = []
  let status = 404
  context.modernResponseNeedsLegacyFallback = response => response.status === 404 && !response.body?.result
  context.callUpstreamRemote = async endpoint => {
    calls.push(endpoint)
    return endpoint === 'session/events' ? { status } : { status: 200, body: { result: { ok: true } } }
  }
  await context.readModernSessionPage({}, 'read')
  assert.deepEqual(calls.splice(0), ['session/events', 'session/page'])
  status = 403
  await context.readModernSessionPage({}, 'read')
  assert.deepEqual(calls, ['session/events'])
})

test('image lookup follows durable child history and passes only the stored reference upstream', async () => {
  const { context } = bridge(), calls = []
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 1, height: 1, bytes: 68 }
  const request = { sessionId: 'child', parentSessionId: 'parent', subagentMode: 'continuable', attachment: { ...ref, width: 9 } }
  context.callUpstreamRemote = async (endpoint, { request }) => {
    calls.push([endpoint, structuredClone(request)])
    if (endpoint === 'session/projections') return { status: 200, body: { result: { ok: true, value: { asOfSeq: 10 } } } }
    const event = request.beforeSeq ? { type: 'user/message', seq: 4, data: { content: [{ type: 'image', attachment: ref }] } }
      : { type: 'tool/call', seq: 7, data: { content: [{ type: 'image', attachment: ref }] } }
    const value = endpoint === 'session/attachment' ? { attachment: ref, data: 'aW1hZ2U=' }
      : { records: [{ event }], cursor: 10, hasMore: !request.beforeSeq }
    return { status: 200, body: { result: { ok: true, value } } }
  }
  const denied = await context.translateModernRpc('session.attachment', { ...request, attachment: { attachmentId: 'b'.repeat(64) } }, 'denied')
  assert.equal(denied.result.error.code, 'session/attachment-not-in-history')
  assert.deepEqual(calls.splice(0).map(([method]) => method), ['session/projections', 'session/events', 'session/events'])
  const result = await context.translateModernRpc('session.attachment', request, 'image')
  assert.equal(result.result.value.data, 'aW1hZ2U=')
  assert.deepEqual(calls.map(([method]) => method), ['session/projections', 'session/events', 'session/events', 'session/attachment'])
  assert.deepEqual(calls[1][1].address, { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' })
  assert.equal(calls[2][1].beforeSeq, 7)
  assert.equal(calls[1][1].throughSeq, 10)
  assert.deepEqual(calls[3][1].attachment, ref)
})

test('continue submits an empty queue prompt only for the Host-confirmed ending and uses the operation ID', async () => {
  const { context } = bridge(), calls = []
  context.callUpstreamRemote = async (endpoint, args) => {
    calls.push([endpoint, structuredClone(args)])
    const value = endpoint === 'session/projections' ? { kind: 'sequenced', values: { conversationContinuation: 9 } } : { accepted: true }
    return { status: 200, body: { result: { ok: true, value } } }
  }
  const direct = await context.translateModernRpc('session.continue', { sessionId: 's', ending: 9 }, 'direct')
  const stale = await context.translateModernRpc('session.continue', { sessionId: 's', ending: 8 }, 'stale', true)
  assert.equal(direct.result.ok, false)
  assert.equal(stale.result.ok, false)
  assert.deepEqual(calls.splice(0).map(([method]) => method), ['session/projections'])
  const continued = await context.translateModernRpc('session.continue', { sessionId: 's', ending: 9 }, 'receipt-id', true)
  assert.equal(continued.result.value.accepted, true)
  assert.deepEqual(calls[1], ['session/prompt', { request: { sessionId: 's', requestId: 'receipt-id', mode: 'queue', content: [] } }])
})

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
  const steer = { id: 'steer', content: [{ type: 'image', data: 'AA==' }], source: { kind: 'user' } }
  const pending = { id: 'context', content: [{ type: 'text', text: '待注入' }] }
  context.applyModernControlFrame({ type: 'baseline', value: { projections: { s: { asOfSeq: 8, values: { inbox: { 'next-turn': [queued], 'next-step': [steer, pending] } } } } } })
  let items = frames.at(-1).payload.items
  assert.equal(items[0].id, 'q')
  assert.equal(items[0].placement, 'queued')
  assert.equal(items[0].message.content[0].text, '排队内容')
  assert.equal(items[1].placement, 'steering')
  assert.equal(items[2].placement, 'context')
  assert.equal(frames.at(-1).payload.seq, 8)
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
  modernState.sessions.set('s', { agentAvailable: true })
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
