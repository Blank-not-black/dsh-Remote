'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')

function classifier(source, titleMarker, goalMarker) {
  const start = source.indexOf(titleMarker)
  const from = source.indexOf('function isTopLevelSession', start)
  const end = source.indexOf(goalMarker, from)
  assert.notEqual(from, -1)
  assert.notEqual(end, -1)
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${source.slice(from, end)}\nthis.check = isTopLevelSession`, context)
  return context.check
}

test('顶层会话判定同时识别 parentSessionId 与 subagent origin', () => {
  for (const check of [
    classifier(mobile, 'function titleOf(', 'const GOAL_TERMINAL_PHASES'),
    classifier(desktop, 'function titleOf(', 'const GOAL_TERMINAL_PHASES'),
  ]) {
    assert.equal(check({ sessionId: 'root' }), true)
    assert.equal(check({ sessionId: 'child-by-parent', parentSessionId: 'root' }), false)
    assert.equal(check({ sessionId: 'child-by-origin', origin: 'subagent' }), false)
    assert.equal(check(null), false)
  }
})

test('移动端和桌面端都为未命名会话显示友好名称并保留短标识', () => {
  assert.match(mobile, /function sessionTitleValue\(s\)/)
  assert.match(mobile, /function titleOf\(s\) \{ return sessionTitleValue\(s\) \|\| \(s\?\.sessionId \? t\('session\.untitled'\)/)
  assert.match(mobile, /return `\$\{title\} · \$\{String\(s\.sessionId\)\.slice\(-8\)\}`/)
  assert.match(mobile, /const title = sessionLabelOf\(s\)/)
  assert.match(desktop, /function sessionTitleValue\(s\)/)
  assert.match(desktop, /function titleOf\(s\) \{ return sessionTitleValue\(s\) \|\| \(s\?\.sessionId \? t\('ds\.sessionUntitled'\)/)
})

test('手机和桌面的主列表、工作区树与主页统计统一使用顶层会话', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /function topLevelSessions\(\) \{ return state\.sessions\.filter\(isVisibleSession\) \}/)
    assert.match(source, /function sortedSessions\(\) \{\s*const items = topLevelSessions\(\)/)
    assert.match(source, /map\(sid => state\.byId\.get\(sid\)\)\.filter\(isVisibleSession\)/)
    assert.match(source, /const topSessions = topLevelSessions\(\)\s*const running = topSessions\.filter\(s => s\.running\)\.length/)
  }
  assert.match(mobile, /const running = topLevelSessions\(\)\.filter\(s => s\.running\)\.length/)
})

test('子代理功能仍由主会话卡片提供，不删除子会话数据', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /state\.sessions = v\.items \|\| \[\]/)
    assert.match(source, /state\.byId = new Map\(state\.sessions\.map/)
    assert.match(source, /subagent\.list', \{ parentSessionId: sessionId \}/)
  }
})

test('空会话只在历史成功确认为空时可清理', () => {
  const start = mobile.indexOf('function sessionHistoryHasContent')
  const end = mobile.indexOf('function reasoningStreamKey', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${mobile.slice(start, end)}\nthis.check = isEmptySessionHistory`, context)
  assert.equal(context.check({ loaded: true, visible: [], partialReasoning: new Map() }), true)
  assert.equal(context.check({ loaded: false, visible: [], partialReasoning: new Map() }), false)
  assert.equal(context.check({ loaded: true, visible: [{ event: { type: 'user/message' } }], partialReasoning: new Map() }), false)
  assert.equal(context.check({ loaded: true, visible: [], partialReasoning: new Map([['turn:step', { text: 'thinking' }]]) }), false)
  assert.match(mobile, /while \(state\.current === sessionId && state\.history\.loading/)
  assert.match(mobile, /removeLocalSessionRecord\(sessionId\)/)
})

test('移动端返回空会话时会从本地列表清理该会话', async () => {
  const removeStart = mobile.indexOf('function removeLocalSessionRecord')
  const removeEnd = mobile.indexOf('function proj', removeStart)
  const closeStart = mobile.indexOf('function sessionHasPendingActivity')
  const closeEnd = mobile.indexOf('/* Android', closeStart)
  const emptyStart = mobile.indexOf('function sessionHistoryHasContent')
  const emptyEnd = mobile.indexOf('function reasoningStreamKey', emptyStart)
  for (const index of [removeStart, removeEnd, closeStart, closeEnd, emptyStart, emptyEnd]) assert.notEqual(index, -1)

  const context = {
    CACHE: { sessions: 'sessions' },
    captureConnection: () => ({valid:()=>true}),
    historyCacheScope: () => 'fixture', window: {DshHistory:{cacheRemove:async()=>{}}}, LS: {del:()=>{}},
    state: {
      current: 'empty-session',
      sessions: [{ sessionId: 'empty-session' }],
      byId: new Map([['empty-session', { sessionId: 'empty-session' }]]),
      pendingProjections: new Map(), sessionActivity: new Set(), pendingPrompts: new Set(),
      queues: {}, jobs: {}, history: { loaded: true, visible: [], partialReasoning: new Map() },
    },
    rpc: async (method) => method === 'session.history' ? { events: [], hasMore: false } : { archivedSessionIds: ['empty-session'] },
    refreshSessions: async () => {},
    cacheRead: () => ({}), cacheWrite: () => {}, writeHistoryCache: () => {},
    readHistoryCache: () => ({}), emptyHistory: () => ({ loaded: false, visible: [], partialReasoning: new Map() }),
    setComposerFullscreen: () => {}, clearComposerImages: () => {}, setSessionRecovery: () => {},
    hideComposerMenu: () => {}, renderSessionPending: () => {}, renderSessions: () => {},
    renderWorkbench: () => {}, showView: () => {}, document: { body: { classList: { remove: () => {} } } },
    $: () => ({ classList: { add: () => {} } }),
  }
  vm.createContext(context)
  vm.runInContext(`${mobile.slice(mobile.indexOf('const emptySessionCleanup'), mobile.indexOf('async function openSession'))}\n${mobile.slice(removeStart, removeEnd)}\n${mobile.slice(closeStart, closeEnd)}\n${mobile.slice(emptyStart, emptyEnd)}`, context)
  await context.closeSession()
  assert.equal(context.state.current, null)
  assert.deepEqual(context.state.sessions, [])
  assert.equal(context.state.byId.has('empty-session'), false)
})

test('桌面端归档会话开关使用会话列表事件代理，可正常触发重绘', () => {
  assert.match(desktop, /\$\('session-list'\)\.addEventListener\('click', \(e\) => \{[\s\S]{0,260}data-archived-toggle[\s\S]{0,260}renderSessions\(\)/)
  assert.match(desktop, /LS\.set\('dsShowArchivedV1', LS\.get\('dsShowArchivedV1', '0'\) === '1' \? '0' : '1'\)/)
})

test('DSH blank 空会话不进主列表、工作区树与统计', () => {
  for (const source of [mobile, desktop]) {
    const start = source.indexOf('function isTopLevelSession')
    const end = source.indexOf('const GOAL_TERMINAL_PHASES', start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    const context = { state: { sessions: [] } }
    vm.createContext(context)
    vm.runInContext(`${source.slice(start, end)}\nthis.check = isVisibleSession; this.top = topLevelSessions`, context)
    assert.equal(context.check({ sessionId: 'a' }), true)
    assert.equal(context.check({ sessionId: 'a', blank: false }), true)
    assert.equal(context.check({ sessionId: 'a', blank: true }), false)
    assert.equal(context.check({ sessionId: 'child', parentSessionId: 'a' }), false)
    assert.equal(context.check(null), false)
    context.state.sessions = [{ sessionId: 'a' }, { sessionId: 'b', blank: true }]
    assert.deepEqual(context.top().map(s => s.sessionId), ['a'])
  }
})

test('空会话开始首轮对话后，元数据更新会重新读取列表并恢复显示', async () => {
  for (const original of [mobile, desktop]) {
    const source = original.replaceAll('\r\n', '\n')
    const section = marker => {
      const start = source.indexOf(marker)
      const end = source.indexOf('\n}', start)
      assert.notEqual(start, -1)
      assert.notEqual(end, -1)
      return source.slice(start, end + 2)
    }
    const blank = { sessionId: 'new-session', blank: true }
    const regular = { sessionId: 'regular' }
    const child = { sessionId: 'child', parentSessionId: 'regular' }
    const sessions = [blank, regular, child]
    let requests = 0
    let resolveList
    const pendingList = new Promise(resolve => { resolveList = resolve })
    const rendered = []
    const context = {
      state: { sessions, byId: new Map(sessions.map(s => [s.sessionId, s])), current: null, pendingProjections: new Map() },
      captureConnection: () => ({ valid: () => true }),
      safeRpc: async method => { assert.equal(method, 'session.list'); requests++; return pendingList },
      t: key => key, CACHE: { sessions: 'sessions' }, cacheWrite: () => {},
      applyPendingProjections: () => {}, refreshWorkbench: () => {},
      scheduleWorkbenchRefresh: () => {}, renderOverviewDesktop: () => {},
      renderSessions: () => rendered.push(Array.from(context.topLevelSessions(), s => s.sessionId)),
      scheduleRefresh: () => { void context.refreshSessions() },
    }
    vm.createContext(context)
    const start = source.indexOf('function isTopLevelSession')
    const end = source.indexOf('const GOAL_TERMINAL_PHASES', start)
    vm.runInContext(`let sessionsRequest = 0\n${source.slice(start, end)}\n${section('function applyProjection(')}\n${section('async function refreshSessions()')}`, context)

    assert.deepEqual(Array.from(context.topLevelSessions(), s => s.sessionId), ['regular'])
    context.applyProjection('new-session', 'sessionListMetadata', { blank: false, lastPromptAt: 123 }, 1)
    assert.equal(requests, 1, '元数据事件触发列表刷新，无需用户手动刷新')
    resolveList({ items: [{ ...blank, blank: false }, regular, child] })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(rendered.at(-1), ['new-session', 'regular'])
    assert.equal(context.state.sessions.length, 3, '原始列表保留子会话数据')
    assert.equal(context.state.byId.has('child'), true)
  }
})
