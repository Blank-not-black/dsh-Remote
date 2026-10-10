'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const sources = ['public/app.js', 'public/desktop/desktop.js']
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function section(source, start, end = '\n}') {
  const a = source.indexOf(start); assert.ok(a >= 0, start)
  return source.slice(a, source.indexOf(end, a) + (end === '\n}' ? 2 : 0))
}
function fixture(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replaceAll('\r\n', '\n')
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: 'project', classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [] })
    return elements.get(id)
  }
  const store = new Map()
  const context = vm.createContext({ $, TextEncoder, Uint8Array, Uint32Array, Map, Set, clearTimeout, setTimeout,
    location: { origin: 'http://origin' }, window: {},
    LS: { get: (key, fallback) => store.get(key) ?? fallback, set: (key, value) => store.set(key, value), del: key => store.delete(key) },
    emptyHistory: () => ({ visible: [] }), emptyDesktopHistory: () => ({ visible: [] }), scheduleHistoryCacheSave() {},
    t: key => key, toast() {}, renderSessions() {}, renderOverviewDesktop() {}, applyPendingProjections() {}, refreshWorkbench() {}, scheduleWorkbenchRefresh() {},
    renderWorkspaceNavigation() {}, renderFs() {}, renderFsRootsDesktop() {}, fsPathInside: () => true,
    fsApiUrl: () => 'http://A/fs', fsHeaders: () => ({}), fsAuthError() {}, esc: value => value,
    closeWorkspaceModal() {}, loadFs: async () => {}, refreshSessions: async () => {}, openSession() {},
  })
  vm.runInContext(section(source, 'const state = {') + '\n' + section(source, '// Increment on every identity transition', file.includes('desktop') ? '\nconst streams' : '\nconst $') + '\nthis.state = state; this.captureConnection = captureConnection', context)
  context.state.server = 'http://A'; context.state.token = 'token-a'
  if (!file.includes('desktop')) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/sha256.js'), 'utf8') + '\n' + section(source, 'const CACHE = {', '\nconst state'), context)
  return { context, source, store, $ }
}
for (const file of sources) {
  test(file + ': connection generation rejects ABA and token-only changes', () => {
    const { context: c } = fixture(file)
    const first = c.captureConnection(); c.state.server = 'http://B'; c.state.server = 'http://A'
    assert.equal(first.valid(), false)
    const second = c.captureConnection(); c.state.token = 'new-token'
    assert.equal(second.valid(), false)
    assert.equal(c.captureConnection().valid(), true)
  })
  test(file + ': late session response cannot replace a new connection or a newer request', async () => {
    const { context: c, source } = fixture(file)
    const old = deferred(), newer = deferred(); let count = 0
    c.safeRpc = () => (++count === 1 ? old.promise : newer.promise)
    vm.runInContext(section(source, 'async function refreshSessions()'), c)
    const a = c.refreshSessions(); c.state.server = 'http://B'
    const b = c.refreshSessions(); newer.resolve({ items: [{ sessionId: 'B' }] }); await b
    old.resolve({ items: [{ sessionId: 'A' }] }); await a
    assert.equal(c.state.sessions[0].sessionId, 'B')
    count = 0; const first = deferred(), second = deferred()
    c.safeRpc = () => (++count === 1 ? first.promise : second.promise)
    const p1 = c.refreshSessions(), p2 = c.refreshSessions()
    second.resolve({ items: [{ sessionId: 'new' }] }); await p2
    first.resolve({ items: [{ sessionId: 'old' }] }); await p1
    assert.equal(c.state.sessions[0].sessionId, 'new')
  })
  test(file + ': file lists guard both response body delay and directory request order', async () => {
    const { context: c, source } = fixture(file)
    vm.runInContext(section(source, 'async function loadFs('), c)
    const body = deferred()
    c.fetch = async () => ({ ok: true, status: 200, json: () => body.promise })
    const p = c.loadFs('/A'); await Promise.resolve(); c.state.token = 'other-token'
    body.resolve({ path: '/A/private', roots: ['/A'], entries: [] }); await p
    assert.equal(c.state.fs.path, null)
    const first = deferred(), second = deferred(); let count = 0
    c.fetch = () => (++count === 1 ? first.promise : second.promise)
    const p1 = c.loadFs('/old'), p2 = c.loadFs('/new')
    second.resolve({ ok: true, status: 200, json: async () => ({ path: '/new', entries: [] }) }); await p2
    first.resolve({ ok: true, status: 200, json: async () => ({ path: '/old', entries: [] }) }); await p1
    assert.equal(c.state.fs.path, '/new')
  })
  for (const stage of ['mkdir', 'listing', 'workspace', 'session', 'refresh']) {
    test(file + ': workspace creation stops after connection switches during ' + stage, async () => {
      const { context: c, source, $ } = fixture(file)
      const pause = deferred(), reached = deferred(), calls = []
      async function step(name, value) {
        calls.push({ name, server: c.state.server })
        if (stage === name) { reached.resolve(); await pause.promise }
        return value
      }
      c.fetch = async () => step('mkdir', { ok: true, status: 201, json: async () => ({ path: '/A/project' }) })
      c.loadFs = async () => step('listing')
      c.rpc = async () => step('workspace', { workspace: { workspaceId: 'A-project' } })
      c.safeRpc = async () => step('session', { sessionId: 'A-session' })
      c.refreshSessions = async () => step('refresh')
      vm.runInContext(section(source, 'async function createWorkspace()'), c)
      const p = c.createWorkspace(); await reached.promise
      c.state.server = 'http://B'; pause.resolve(); await p
      assert.ok(calls.every(call => call.server === 'http://A'), JSON.stringify(calls))
      assert.equal(c.state.current, null)
      assert.equal($('workspace-create').disabled, false)
    })
  }
  test(file + ': workbench resync cannot register directories from a previous host', async () => {
    const { context: c, source } = fixture(file)
    const listing = deferred(), reached = deferred(), mutations = []
    c.state.wb = { bound: false, path: '' }
    const wb = { bound: true, path: '/A/root' }
    c.wbGateway = async () => wb
    c.fetch = async url => {
      if (url.includes('/workbench')) return { ok: true, json: async () => wb }
      reached.resolve(); return listing.promise
    }
    c.apiUrl = path => 'http://A' + path
    c.CAP = null; c.clientIdHeaders = () => ({})
    c.wbPathKey = value => value; c.wbJoin = (root, name) => root + '/' + name; c.wbStrictInside = () => true
    c.orderedWorkspaceItems = value => value; c.renderWorkbench = () => {}
    c.safeRpc = async () => ({ items: [] })
    c.rpc = async (method, payload) => {
      if (method === 'workspace.list') return { items: [] }
      mutations.push({ server: c.state.server, path: payload.path }); return { workspace: { workspaceId: 'created' } }
    }
    vm.runInContext(section(source, 'async function refreshWorkbench('), c)
    const resync = c.refreshWorkbench(); await reached.promise
    c.state.server = 'http://B'
    listing.resolve({ ok: true, json: async () => ({ entries: [{ name: 'old-project', type: 'dir' }] }) }); await resync
    assert.equal(mutations.length, 0)
    assert.equal(c.state.wb?.path || '', '')
  })
}
test('mobile session cache and history namespace partition by address and token', () => {
  const { context: c, store } = fixture('public/app.js')
  vm.runInContext("cacheWrite(CACHE.sessions, [{ sessionId: 'same', title: 'A' }]); this.originalScope = CACHE.history", c)
  c.state.server = 'http://B'
  assert.equal(vm.runInContext('cacheRead(CACHE.sessions, []).length', c), 0)
  assert.notEqual(vm.runInContext('CACHE.history', c), c.originalScope)
  c.state.server = 'http://A'; c.state.token = 'new-token'
  assert.equal(vm.runInContext('cacheRead(CACHE.sessions, []).length', c), 0)
  c.state.token = 'token-a'
  assert.equal(vm.runInContext('cacheRead(CACHE.sessions, [])[0].title', c), 'A')
  assert.ok([...store.keys()].every(key => !key.includes('token-a')))
})
