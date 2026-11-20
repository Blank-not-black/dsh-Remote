'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const management = require('../public/session-management.js')
const ROOT = path.join(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'session-management.js'), 'utf8')
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'session-management.css'), 'utf8')

function fixture(options = {}) {
  const host = {
    workspaces: [
      { workspaceId: 'ws-alpha', path: '/work/alpha', title: 'Alpha 项目', sessionIds: ['s-loaded', 's-remote', 's-archived'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { workspaceId: 'ws-beta', path: '/work/beta', title: 'Beta 项目', sessionIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ],
    sessions: [
      { sessionId: 's-loaded', cwd: '/work/alpha', projections: { values: { title: '已加载会话' } } },
      { sessionId: 's-remote', cwd: '/work/alpha', projections: { values: { title: '未加载历史' } } },
      { sessionId: 's-archived', cwd: '/work/alpha', projections: { values: { title: '归档会话' } } },
      { sessionId: 's-other', cwd: '/work/other', projections: { values: { title: '其他会话' } } },
    ],
    archived: options.archived || ['s-archived'],
    pinned: options.pinned || ['s-loaded'],
  }
  const calls = []
  const confirmations = []
  const toasts = []
  const refreshes = []
  const data = { host, calls, confirmations, toasts, refreshes, confirmResult: options.confirmResult !== false }
  const handlers = {
    'workspace.pinSession'(payload) {
      if (!host.pinned.includes(payload.sessionId)) host.pinned = [payload.sessionId, ...host.pinned]
      return { pinnedSessionIds: host.pinned.slice() }
    },
    'workspace.unpinSession'(payload) {
      host.pinned = host.pinned.filter(id => id !== payload.sessionId)
      return { pinnedSessionIds: host.pinned.slice() }
    },
    'workspace.unarchiveSession'(payload) {
      host.archived = host.archived.filter(id => id !== payload.sessionId)
      return { archivedSessionIds: host.archived.slice() }
    },
    'workspace.rename'(payload) {
      host.workspaces = host.workspaces.map(workspace =>
        workspace.workspaceId === payload.workspaceId ? { ...workspace, title: payload.title } : workspace)
      return { workspace: host.workspaces.find(workspace => workspace.workspaceId === payload.workspaceId) }
    },
    'workspace.delete'(payload) {
      host.workspaces = host.workspaces.filter(workspace => workspace.workspaceId !== payload.workspaceId)
      return { deleted: true }
    },
    ...(options.handlers || {}),
  }
  const adapter = {
    rpc: async (method, payload, rpcOptions) => {
      calls.push({ method, payload, options: rpcOptions })
      const handler = handlers[method]
      if (!handler) throw Object.assign(new Error('unexpected method ' + method), { code: 'gateway/internal' })
      return handler(payload, host)
    },
    workspaces: () => host.workspaces,
    sessions: () => host.sessions,
    archivedSessionIds: () => host.archived.slice(),
    pinnedSessionIds: () => host.pinned.slice(),
    refresh: async scope => { refreshes.push(scope) },
    confirm: async request => { confirmations.push(request); return data.confirmResult },
    toast: (message, kind) => toasts.push({ message, kind }),
    onState: () => {},
  }
  if (options.readOnly) adapter.readOnly = () => true
  if (options.noConfirm) delete adapter.confirm
  if (options.promptTitle) adapter.promptTitle = options.promptTitle
  const manager = management.createManager(adapter)
  return { manager, adapter, calls, confirmations, toasts, refreshes, host, data }
}

test('置顶写入主机并刷新，状态只在主机确认后改变', async () => {
  const ctx = fixture({ pinned: [] })
  assert.equal(ctx.host.pinned.includes('s-loaded'), false)
  const result = await ctx.manager.pin('s-loaded')
  assert.equal(result.ok, true)
  assert.deepEqual(ctx.calls.map(call => call.method), ['workspace.pinSession'])
  assert.deepEqual(ctx.calls[0].payload, { sessionId: 's-loaded' })
  assert.equal(ctx.manager.isPinned('s-loaded'), true)
  assert.equal(ctx.host.pinned.includes('s-loaded'), true)
  assert.deepEqual(ctx.refreshes, ['workspaces'])
  assert.equal(ctx.toasts.filter(toast => toast.kind === 'ok').length, 1)
  assert.doesNotMatch(SOURCE, /localStorage/, '置顶必须写主机，不能只写本地存储')
})

test('写失败不显示成功：失败/未确认时状态与提示都不乐观', async () => {
  const ctx = fixture({
    pinned: [],
    handlers: {
      'workspace.pinSession'() { throw Object.assign(new Error('boom'), { code: 'gateway/internal' }) },
    },
  })
  const result = await ctx.manager.pin('s-loaded')
  assert.equal(result.ok, false)
  assert.equal(ctx.manager.isPinned('s-loaded'), false)
  assert.equal(ctx.toasts.filter(toast => toast.kind === 'ok').length, 0)
  assert.equal(ctx.toasts.filter(toast => toast.kind === 'err').length, 1)
})

test('写超时先核对主机状态、不盲目重试；核对成功才显示成功', async () => {
  let applied = false
  const ctx = fixture({
    pinned: [],
    handlers: {
      'workspace.pinSession'(payload, host) {
        applied = true
        host.pinned = [payload.sessionId]
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError', code: 'timeout' })
      },
    },
  })
  const result = await ctx.manager.pin('s-loaded')
  assert.equal(applied, true)
  assert.equal(result.ok, true)
  assert.equal(result.reconciled, true)
  assert.equal(ctx.calls.length, 1, '超时后不能重发写请求')
  assert.deepEqual(ctx.refreshes, ['workspaces'])
  assert.equal(ctx.manager.isPinned('s-loaded'), true)
})

test('超时且核对未生效时报告未知且不显示成功', async () => {
  const ctx = fixture({
    pinned: [],
    handlers: {
      'workspace.pinSession'() { throw Object.assign(new Error('timeout'), { name: 'TimeoutError', code: 'timeout' }) },
    },
  })
  const result = await ctx.manager.pin('s-loaded')
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, management.kinds.TIMEOUT)
  assert.equal(result.error.ambiguous, true)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.manager.isPinned('s-loaded'), false)
  assert.equal(ctx.toasts.filter(toast => toast.kind === 'ok').length, 0)
})

test('取消归档写入主机并回到正常列表', async () => {
  const ctx = fixture()
  assert.equal(ctx.manager.isArchived('s-archived'), true)
  const result = await ctx.manager.unarchive('s-archived')
  assert.equal(result.ok, true)
  assert.deepEqual(ctx.calls[0], {
    method: 'workspace.unarchiveSession',
    payload: { sessionId: 's-archived' },
    options: { timeoutMs: 12000 },
  })
  assert.equal(ctx.manager.isArchived('s-archived'), false)
  assert.deepEqual(ctx.refreshes, ['sessions'], '取消归档后刷新会话列表，让其回到正常列表')
  assert.match(ctx.toasts.find(toast => toast.kind === 'ok').message, /取消归档|正常列表/)
})

test('取消归档失败时保持归档状态且不提示成功', async () => {
  const ctx = fixture({
    handlers: {
      'workspace.unarchiveSession'() { throw Object.assign(new Error('boom'), { code: 'gateway/internal' }) },
    },
  })
  const result = await ctx.manager.unarchive('s-archived')
  assert.equal(result.ok, false)
  assert.equal(ctx.manager.isArchived('s-archived'), true)
  assert.equal(ctx.toasts.filter(toast => toast.kind === 'ok').length, 0)
})

test('归档会话不能置顶：本地拒绝，不发起主机写请求', async () => {
  const ctx = fixture()
  const result = await ctx.manager.pin('s-archived')
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, management.kinds.ARCHIVED_SESSION)
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.manager.isPinned('s-archived'), false)
})

test('只读/配对设备禁止所有管理写入', async () => {
  const ctx = fixture({ readOnly: true })
  const results = await Promise.all([
    ctx.manager.pin('s-remote'),
    ctx.manager.unpin('s-loaded'),
    ctx.manager.unarchive('s-archived'),
    ctx.manager.renameWorkspace('ws-alpha', '新名称'),
    ctx.manager.removeWorkspace('ws-alpha'),
  ])
  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(result.error.kind, management.kinds.READ_ONLY)
  }
  assert.equal(ctx.calls.length, 0)
  assert.equal(ctx.confirmations.length, 0)
  assert.equal(ctx.manager.canWrite(), false)
})

test('工作区重命名写主机、校验空名/重名/未变化，失败时保留旧名称', async () => {
  const ctx = fixture()
  assert.equal(ctx.manager.validateWorkspaceTitle('   ', 'ws-alpha').error, 'blank')
  assert.equal(ctx.manager.validateWorkspaceTitle('Beta 项目', 'ws-alpha').error, 'conflict')
  assert.equal(ctx.manager.validateWorkspaceTitle('Alpha 项目', 'ws-alpha').error, 'unchanged')
  assert.equal(ctx.calls.length, 0, '本地校验失败不发 RPC')

  const result = await ctx.manager.renameWorkspace('ws-alpha', '  Alpha 新名字  ')
  assert.equal(result.ok, true)
  assert.equal(ctx.calls[0].method, 'workspace.rename')
  assert.deepEqual(ctx.calls[0].payload, { workspaceId: 'ws-alpha', title: 'Alpha 新名字' })
  assert.equal(ctx.manager.workspaces.find(workspace => workspace.workspaceId === 'ws-alpha').title, 'Alpha 新名字')
  assert.deepEqual(ctx.refreshes, ['workspaces'])

  const failing = fixture({
    handlers: {
      'workspace.rename'() { throw Object.assign(new Error('no'), { code: 'gateway/internal' }) },
    },
  })
  const failed = await failing.manager.renameWorkspace('ws-alpha', '另一个名字')
  assert.equal(failed.ok, false)
  assert.equal(failing.manager.workspaces.find(workspace => workspace.workspaceId === 'ws-alpha').title, 'Alpha 项目')
})

test('移除工作区前明确会话归属影响，只移除登记且不删除磁盘内容', async () => {
  const ctx = fixture()
  const impact = ctx.manager.getWorkspaceImpact('ws-alpha')
  assert.equal(impact.total, 3)
  assert.deepEqual(impact.sessions.map(session => session.sessionId).sort(), ['s-archived', 's-loaded', 's-remote'])
  assert.equal(impact.archivedCount, 1)
  assert.equal(impact.pinnedCount, 1)

  const result = await ctx.manager.removeWorkspace('ws-alpha')
  assert.equal(result.ok, true)
  assert.equal(ctx.confirmations.length, 1)
  const confirmation = ctx.confirmations[0]
  assert.match(confirmation.message, /3 个会话/)
  assert.match(confirmation.message, /不再归属该工作区/)
  assert.match(confirmation.message, /只移除 DSH 中的工作区登记/)
  assert.match(confirmation.message, /不删除磁盘目录、文件或会话历史/)
  assert.match(confirmation.message, /会话本身不会被删除/)
  assert.equal(ctx.calls[0].method, 'workspace.delete')
  assert.deepEqual(ctx.calls[0].payload, { workspaceId: 'ws-alpha' })
  assert.equal(ctx.manager.workspaces.some(workspace => workspace.workspaceId === 'ws-alpha'), false)
  assert.deepEqual(ctx.refreshes, ['workspaces'])
  assert.doesNotMatch(SOURCE, /require\(['"]node:fs/, '前端模块不得删除磁盘文件')
  assert.doesNotMatch(SOURCE, /\bfetch\(/, '移除工作区不得自行发起文件接口请求')
})

test('取消移除确认、无确认能力、写失败时都不移除工作区', async () => {
  const cancelled = fixture({ confirmResult: false })
  const cancelledResult = await cancelled.manager.removeWorkspace('ws-alpha')
  assert.equal(cancelledResult.ok, false)
  assert.equal(cancelledResult.error.kind, management.kinds.CANCELLED)
  assert.equal(cancelled.calls.length, 0)
  assert.equal(cancelled.manager.workspaces.some(workspace => workspace.workspaceId === 'ws-alpha'), true)

  const noConfirm = fixture({ noConfirm: true })
  const noConfirmResult = await noConfirm.manager.removeWorkspace('ws-alpha')
  assert.equal(noConfirmResult.ok, false)
  assert.equal(noConfirmResult.error.kind, management.kinds.CONFIRMATION_UNAVAILABLE)
  assert.equal(noConfirm.calls.length, 0)

  const failing = fixture({
    handlers: { 'workspace.delete'() { throw Object.assign(new Error('boom'), { code: 'gateway/internal' }) } },
  })
  const failedResult = await failing.manager.removeWorkspace('ws-alpha')
  assert.equal(failedResult.ok, false)
  assert.equal(failing.manager.workspaces.some(workspace => workspace.workspaceId === 'ws-alpha'), true)
})

test('主机能力缺失（老版本网关）按不支持处理，不伪造成功', async () => {
  const ctx = fixture({
    handlers: {
      'workspace.pinSession'() { throw Object.assign(new Error('method-unavailable'), { code: 'method-unavailable', status: 404 }) },
    },
  })
  const result = await ctx.manager.pin('s-remote')
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, management.kinds.UNSUPPORTED)
  assert.equal(ctx.manager.isPinned('s-remote'), false)
})

test('结果校验拒绝未确认的主机回包', () => {
  assert.equal(management.applyPinResult({ pinnedSessionIds: ['other'] }, 's1', 'pin').ok, false)
  assert.equal(management.applyPinResult({ pinnedSessionIds: ['s1'] }, 's1', 'pin').ok, true)
  assert.equal(management.applyPinResult({ pinnedSessionIds: ['s1'] }, 's1', 'unpin').ok, false)
  assert.equal(management.applyUnarchiveResult({ archivedSessionIds: ['s1'] }, 's1').ok, false)
  assert.equal(management.applyUnarchiveResult({ archivedSessionIds: [] }, 's1').ok, true)
  assert.equal(management.applyRenameResult({ workspace: { workspaceId: 'w1', title: '新名' } }, 'w1', '新名').ok, true)
  assert.equal(management.applyRenameResult({ workspace: { workspaceId: 'w1', title: '旧名' } }, 'w1', '新名').ok, false)
  assert.equal(management.applyDeleteResult({ deleted: false }).ok, false)
  assert.equal(management.applyDeleteResult({ deleted: true }).ok, true)
  assert.equal(management.classifyManagementError({ code: 'AUTH' }).kind, management.kinds.AUTH)
  assert.equal(management.classifyManagementError({ code: 'workspace/name-conflict' }).kind, management.kinds.CONFLICT)
  assert.equal(management.classifyManagementError({ name: 'TimeoutError', code: 'timeout' }).ambiguous, true)
  assert.equal(management.classifyManagementError({ code: 'session/not-found' }).kind, management.kinds.NOT_FOUND)
})

test('管理 UI 标记出置顶/取消归档/重命名/移除，转义主机文本并标注只读', async () => {
  const ctx = fixture({ pinned: ['s-loaded'], readOnly: false })
  const state = ctx.manager.getState()
  const html = management.renderWorkspaceAdminHtml(state)
  assert.match(html, /Alpha 项目/)
  assert.match(html, /data-dr-session-admin-action="rename-workspace"/)
  assert.match(html, /data-dr-session-admin-action="remove-workspace"/)
  assert.match(html, /不删除磁盘目录、文件或会话历史/)

  const pinnedRow = management.renderSessionAdminActions({ sessionId: 's-loaded' }, state)
  assert.match(pinnedRow, /data-dr-session-admin-action="unpin-session"/)
  const unpinnedRow = management.renderSessionAdminActions({ sessionId: 's-remote' }, state)
  assert.match(unpinnedRow, /data-dr-session-admin-action="pin-session"/)
  const archivedRow = management.renderSessionAdminActions({ sessionId: 's-archived' }, state)
  assert.match(archivedRow, /data-dr-session-admin-action="unarchive-session"/)

  const readOnlyHtml = management.renderWorkspaceAdminHtml({ ...state, canWrite: false })
  assert.match(readOnlyHtml, /只读\/配对设备/)
  assert.match(readOnlyHtml, /disabled/)

  const escaped = management.renderWorkspaceAdminHtml({
    canWrite: true,
    workspaces: [{ workspaceId: 'w<script>', path: '/tmp/<x>', title: '<script>alert(1)</script>', sessionIds: [] }],
  })
  assert.doesNotMatch(escaped, /<script>alert/)
  assert.match(escaped, /&lt;script&gt;/)

  const confirmation = management.removeWorkspaceConfirmation(
    { workspaceId: 'w1', path: '/tmp/w1', title: 'W1' },
    { total: 0, sessions: [], archivedCount: 0, pinnedCount: 0 },
  )
  assert.match(confirmation.message, /当前没有会话登记到该工作区/)
  assert.match(confirmation.message, /不删除磁盘目录、文件或会话历史/)
})

test('DOM 绑定把按钮动作路由到 manager，并刷新视图', async () => {
  const ctx = fixture()
  const listeners = {}
  const element = {
    addEventListener: (type, fn) => { listeners[type] = fn },
    removeEventListener: () => {},
  }
  let redraws = 0
  management.bindWorkspaceAdmin(element, ctx.manager, { render: () => { redraws++ } })
  const target = {
    dataset: { drSessionAdminAction: 'pin-session', sessionId: 's-remote' },
    closest(selector) { return selector === '[data-dr-session-admin-action]' ? this : null },
  }
  await listeners.click({ target })
  assert.equal(ctx.manager.isPinned('s-remote'), true)
  assert.equal(redraws, 1)
})

test('mountWorkspaceAdmin 可注入容器渲染工作区管理区', () => {
  const ctx = fixture()
  const element = {
    className: '',
    innerHTML: '',
    parentNode: null,
    addEventListener() {},
    removeEventListener() {},
  }
  const container = { appendChild(node) { node.parentNode = container; container.node = node }, removeChild(node) { node.parentNode = null; container.node = null } }
  const document = { createElement: () => element }
  const mounted = management.mountWorkspaceAdmin(container, ctx.manager, { document })
  assert.equal(container.node, element)
  assert.match(element.innerHTML, /Alpha 项目/)
  assert.match(element.innerHTML, /data-dr-session-admin-action="remove-workspace"/)
  mounted.destroy()
  assert.equal(element.parentNode, null)
})

test('模块全局与 CommonJS 双出口、CSS 前缀，且不依赖 app.js 词法变量', () => {
  const context = { I18N: { lang: 'zh' }, navigator: { platform: 'Linux' }, console }
  vm.createContext(context)
  vm.runInContext(SOURCE, context)
  assert.equal(typeof context.DshSessionManagement.init, 'function')
  assert.equal(typeof context.DshSessionManagement.createManager, 'function')
  assert.doesNotMatch(SOURCE, /state\.byId/)
  assert.doesNotMatch(SOURCE, /state\.sessions/)
  assert.match(CSS, /\.dr-session-admin-workspace/)
  assert.match(CSS, /\.dr-session-admin-btn/)
  assert.match(SOURCE, /dr-session-admin-workspace/)
})
