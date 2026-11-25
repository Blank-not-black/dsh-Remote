'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8').replaceAll('\r\n', '\n')
const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8').replaceAll('\r\n', '\n')

function sessionCacheBlock(source) {
  const start = source.indexOf('function readSessionCache(')
  const end = source.indexOf('let conversationView = null', start)
  assert.ok(start >= 0 && end > start, 'session cache helpers')
  return source.slice(start, end)
}

function versionBlock(source) {
  const start = source.indexOf('async function loadLocalVersion()')
  const end = source.indexOf('\n/* ---------------- 远程公告', start)
  assert.ok(start >= 0 && end > start, 'loadLocalVersion')
  return source.slice(start, end)
}

function cacheFixture(source, cached = null) {
  const state = { sessions: [], byId: new Map() }
  const renders = []
  const context = vm.createContext({
    state,
    DshSessionCache: { read: () => cached },
    cacheRead: () => null,
    cacheWrite: () => true,
    LS: { get: () => null, del: () => {} },
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
    historyCacheScope: () => 'historyCacheV2:test',
    renderSessions: () => renders.push(state.sessions.map(item => item.sessionId)),
  })
  vm.runInContext(sessionCacheBlock(source) + '\nthis.restore = restoreCachedSessionList', context)
  return { context, state, renders }
}

test('mobile restore renders even when the new connection has no cache', () => {
  const { context, state, renders } = cacheFixture(mobile)
  context.restore()
  assert.equal(state.sessions.length, 0)
  assert.equal(renders.length, 1)
  assert.equal(renders[0].length, 0)
})

test('desktop restore renders even when the new connection has no cache', () => {
  const { context, state, renders } = cacheFixture(desktop)
  context.restore()
  assert.equal(state.sessions.length, 0)
  assert.equal(renders.length, 1)
  assert.equal(renders[0].length, 0)
})

test('restore uses the cached list for both clients and rebuilds byId', () => {
  const cached = [{ sessionId: 'cached', title: 'Cached' }]
  for (const source of [mobile, desktop]) {
    const { context, state, renders } = cacheFixture(source, cached)
    context.restore()
    assert.deepEqual(Array.from(state.sessions), cached)
    assert.equal(state.byId.get('cached').title, 'Cached')
    assert.equal(renders.length, 1)
    assert.deepEqual(Array.from(renders[0]), ['cached'])
  }
})

test('restore filters malformed cache entries instead of rendering them', () => {
  for (const source of [mobile, desktop]) {
    const { context, state } = cacheFixture(source, [{ sessionId: 'ok' }, null, { title: 'no id' }])
    context.restore()
    assert.deepEqual(state.sessions.map(item => item.sessionId), ['ok'])
  }
})

test('loadLocalVersion bounds version.json with 1.5s and reads the body', async () => {
  const state = { localVersion: '' }
  let observedTimeout = 0
  let bodyRead = false
  const context = vm.createContext({
    state,
    fetch: async () => ({ ok: true, json: async () => { bodyRead = true; return { version: '1.2.3' } } }),
    DshNetwork: { readWithDeadline: async (read, timeout) => { observedTimeout = timeout; return read(new AbortController().signal) } },
    AbortController,
    setTimeout,
    clearTimeout,
    CAP: { isNativePlatform: () => false },
    window: {},
    $: () => ({ textContent: '' }),
    t: key => key,
  })
  vm.runInContext(versionBlock(mobile) + '\nthis.load = loadLocalVersion', context)
  assert.equal(await context.load(), '1.2.3')
  assert.equal(observedTimeout, 1500)
  assert.equal(bodyRead, true)
  assert.equal(state.localVersion, '1.2.3')
})

test('loadLocalVersion falls back to the Android installed version after a failed read', async () => {
  const state = { localVersion: '' }
  const context = vm.createContext({
    state,
    fetch: async () => { throw new Error('offline') },
    DshNetwork: { readWithDeadline: async () => { throw new TypeError('Read timed out') } },
    AbortController,
    setTimeout,
    clearTimeout,
    CAP: { isNativePlatform: () => true },
    window: { NativeUpdate: { getInstalledVersion: () => '2.0.0.rc.5' } },
    $: () => ({ textContent: '' }),
    t: key => key,
  })
  vm.runInContext(versionBlock(mobile) + '\nthis.load = loadLocalVersion', context)
  assert.equal(await context.load(), '2.0.0-rc.5')
  assert.equal(state.localVersion, '2.0.0-rc.5')
})

test('concurrent loadLocalVersion calls share one version request', async () => {
  const state = { localVersion: '' }
  let requests = 0
  let release
  const body = new Promise(resolve => { release = resolve })
  const context = vm.createContext({
    state,
    fetch: async () => { requests++; return { ok: true, json: async () => { await body; return { version: '3.0.0' } } } },
    DshNetwork: { readWithDeadline: async read => read(new AbortController().signal) },
    AbortController,
    setTimeout,
    clearTimeout,
    CAP: { isNativePlatform: () => false },
    window: {},
    $: () => ({ textContent: '' }),
    t: key => key,
  })
  vm.runInContext(versionBlock(mobile) + '\nthis.load = loadLocalVersion', context)
  const first = context.load()
  const second = context.load()
  release()
  assert.deepEqual(await Promise.all([first, second]), ['3.0.0', '3.0.0'])
  assert.equal(requests, 1)
})
