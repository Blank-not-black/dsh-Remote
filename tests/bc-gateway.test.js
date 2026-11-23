'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')

function section(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.notEqual(from, -1, `missing ${start}`)
  assert.notEqual(to, -1, `missing ${end}`)
  return source.slice(from, to)
}

function bridge() {
  const frames = []
  const modernState = {
    sessions: new Map(), sessionCursors: new Map(), assistantStreams: new Map(),
    sessionInterests: new Map(), followedSessions: new Set(),
    workspaces: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
  }
  const context = vm.createContext({
    crypto,
    modernState,
    eventCollectors: { mux: null },
    legacyPush: (kind, payload) => frames.push({ kind, payload }),
    callUpstreamRemote: async () => ({ status: 200, body: { result: { ok: true, value: {} } } }),
    modernResponseNeedsLegacyFallback: () => false,
    recordCompatibility() {},
  })
  vm.runInContext(
    section('function legacyEnvelope(', 'function modernResponseNeedsLegacyFallback(')
      + section('function applyModernWorkspaceFrame(', 'function modernReasoningValue(')
      + section('async function translateModernRpc(', 'function wsAccept('),
    context,
  )
  return { context, modernState, frames }
}

test('C3 网关：pin/unpin/unarchive 使用生成的 Host 方法并发布 pinned/archived 集合', async () => {
  const { context, modernState, frames } = bridge()
  const requests = []
  context.callUpstreamRemote = async (endpoint, args) => {
    requests.push({ endpoint, args })
    const value = endpoint === 'workspace/pinSession' || endpoint === 'workspace/unpinSession'
      ? { pinnedSessionIds: endpoint === 'workspace/pinSession' ? ['s'] : [] }
      : { archivedSessionIds: endpoint === 'workspace/unarchiveSession' ? [] : ['s'] }
    return { status: 200, body: { result: { ok: true, value } } }
  }
  const pin = await context.translateModernRpc('workspace.pinSession', { sessionId: 's' }, 'pin')
  assert.equal(pin.result.ok, true)
  assert.equal(requests[0].endpoint, 'workspace/pinSession')
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].args)), { request: { sessionId: 's' } })
  assert.deepEqual(Array.from(modernState.workspaces.pinnedSessionIds), ['s'])
  assert.equal(frames.at(-1).payload.type, 'host/pinned-sessions-changed')

  await context.translateModernRpc('workspace.unpinSession', { sessionId: 's' }, 'unpin')
  assert.deepEqual(Array.from(modernState.workspaces.pinnedSessionIds), [])
  assert.equal(requests[1].endpoint, 'workspace/unpinSession')

  await context.translateModernRpc('workspace.unarchiveSession', { sessionId: 's' }, 'unarchive')
  assert.equal(requests[2].endpoint, 'workspace/unarchiveSession')
  assert.deepEqual(Array.from(modernState.workspaces.archivedSessionIds), [])
  assert.equal(frames.at(-1).payload.type, 'host/archived-sessions-changed')

  const listed = await context.translateModernRpc('workspace.list', {}, 'list')
  assert.deepEqual(Array.from(listed.result.value.pinnedSessionIds), [])
  assert.deepEqual(Array.from(listed.result.value.archivedSessionIds), [])
})

test('C3 网关：rename/delete 立即更新 workspace.list 缓存，写后刷新不一致', async () => {
  const { context, modernState, frames } = bridge()
  modernState.workspaces.items = [{ workspaceId: 'w1', title: 'Old' }]
  context.callUpstreamRemote = async endpoint => ({
    status: 200,
    body: { result: { ok: true, value: endpoint === 'workspace/rename'
      ? { workspace: { workspaceId: 'w1', title: 'New' } }
      : { deleted: true } } },
  })
  await context.translateModernRpc('workspace.rename', { workspaceId: 'w1', title: 'New' }, 'rename')
  assert.equal(modernState.workspaces.items[0].title, 'New')
  assert.equal(frames.at(-1).payload.type, 'host/workspace-changed')

  await context.translateModernRpc('workspace.delete', { workspaceId: 'w1' }, 'delete')
  assert.equal(modernState.workspaces.items.length, 0)
  assert.equal(frames.at(-1).payload.type, 'host/workspace-removed')
})

test('B6 网关：命令、技能、文件引用和会话引用走生成的 Host RPC', async () => {
  const { context } = bridge()
  const requests = []
  context.callUpstreamRemote = async (endpoint, args) => {
    requests.push({ endpoint, args })
    const values = {
      'commands/list': [{ name: 'plan' }],
      'session/search': { items: [] },
      'skills/list': { skills: [{ name: 'review' }] },
      'fileReferences/list': [{ path: 'src/a.js', kind: 'file' }],
      'sessionReferenceResolver/candidates': [{ sessionId: 'other', mention: '@[Other](dsh-session:other)' }],
    }
    return { status: 200, body: { result: { ok: true, value: values[endpoint] } } }
  }
  await context.translateModernRpc('commands.list', { sessionId: 's' }, 'commands')
  await context.translateModernRpc('skills.list', { sessionId: 's' }, 'skills')
  await context.translateModernRpc('session.search', { query: 'needle' }, 'search')
  await context.translateModernRpc('fileReferences.list', { sessionId: 's', query: 'a' }, 'files')
  await context.translateModernRpc('sessionReferenceResolver.candidates', { sessionId: 's', query: 'o' }, 'sessions')
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { endpoint: 'commands/list', args: { agentId: 's' } },
    { endpoint: 'skills/list', args: { request: { sessionId: 's' } } },
    { endpoint: 'session/search', args: { request: { query: 'needle' } } },
    { endpoint: 'fileReferences/list', args: { agentId: 's', query: 'a' } },
    { endpoint: 'sessionReferenceResolver/candidates', args: { agentId: 's', query: 'o' } },
  ])
})

test('B6/C 网关：新方法进入自适应 RPC 白名单，写方法保留直连错误语义', () => {
  for (const method of ['workspace.pinSession', 'workspace.unpinSession', 'workspace.unarchiveSession',
    'commands.list', 'skills.list', 'fileReferences.list', 'sessionReferenceResolver.candidates']) {
    assert.match(source, new RegExp(`['"]${method.replace(/\./g, '\\.')}['"]`), method)
  }
  // C3 的超时核对由模块自身完成；不要把这些方法加入持久回执，否则旧主机的
  // 明确 404 会被统一收据层包装成“结果未确认”，丢失“不支持”的语义。
  const operations = fs.readFileSync(path.join(ROOT, 'public', 'operations.js'), 'utf8')
  for (const method of ['workspace.pinSession', 'workspace.unpinSession', 'workspace.unarchiveSession']) {
    assert.ok(!operations.includes(`'${method}'`), method)
  }
})
