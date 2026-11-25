'use strict'
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const sessionCache = require(path.join(ROOT, 'public/session-cache.js'))

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed))
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    dump() { return Object.fromEntries(values) },
  }
}

beforeEach(() => {
  global.localStorage = memoryStorage()
})

test('canonical key is shared across clients and legacy key keeps the desktop shape', () => {
  const keys = sessionCache.keys('historyCacheV2:abc123')
  assert.equal(keys.canonical, 'sessionsCacheV2:abc123')
  assert.equal(keys.legacy, 'historyCacheV2:abc123:sessions')
})

test('missing canonical key migrates a valid legacy list without deleting it', () => {
  const legacy = [{ sessionId: 'old', title: 'A' }]
  global.localStorage = memoryStorage({ 'historyCacheV2:abc:sessions': JSON.stringify(legacy) })
  assert.deepEqual(sessionCache.read('historyCacheV2:abc'), legacy)
  assert.deepEqual(JSON.parse(global.localStorage.getItem('sessionsCacheV2:abc')), legacy)
  assert.deepEqual(JSON.parse(global.localStorage.getItem('historyCacheV2:abc:sessions')), legacy)
})

test('a valid empty canonical list wins over a stale legacy list', () => {
  global.localStorage = memoryStorage({
    'sessionsCacheV2:abc': '[]',
    'historyCacheV2:abc:sessions': JSON.stringify([{ sessionId: 'old' }]),
  })
  assert.deepEqual(sessionCache.read('historyCacheV2:abc'), [])
  assert.deepEqual(JSON.parse(global.localStorage.getItem('historyCacheV2:abc:sessions')), [{ sessionId: 'old' }])
})

test('corrupt canonical data falls back to legacy and repairs the canonical key', () => {
  const legacy = [{ sessionId: 'restored' }]
  global.localStorage = memoryStorage({
    'sessionsCacheV2:abc': '{bad json',
    'historyCacheV2:abc:sessions': JSON.stringify(legacy),
  })
  assert.deepEqual(sessionCache.read('historyCacheV2:abc'), legacy)
  assert.deepEqual(JSON.parse(global.localStorage.getItem('sessionsCacheV2:abc')), legacy)
})

test('write always fills the canonical key and mirrors only an existing legacy copy', () => {
  sessionCache.write('historyCacheV2:fresh', [{ sessionId: 'new' }])
  assert.deepEqual(JSON.parse(global.localStorage.getItem('sessionsCacheV2:fresh')), [{ sessionId: 'new' }])
  assert.equal(global.localStorage.getItem('historyCacheV2:fresh:sessions'), null)

  global.localStorage.setItem('historyCacheV2:upgraded:sessions', '[]')
  const list = Array.from({ length: 90 }, (_, index) => ({ sessionId: 's' + index }))
  sessionCache.write('historyCacheV2:upgraded', list)
  assert.equal(JSON.parse(global.localStorage.getItem('sessionsCacheV2:upgraded')).length, 80)
  assert.equal(JSON.parse(global.localStorage.getItem('historyCacheV2:upgraded:sessions')).length, 80)
})

test('clear removes both copies for one connection and leaves other scopes alone', () => {
  const storage = memoryStorage({
    'sessionsCacheV2:a': JSON.stringify([{ sessionId: 'a' }]),
    'historyCacheV2:a:sessions': JSON.stringify([{ sessionId: 'a' }]),
    'sessionsCacheV2:b': JSON.stringify([{ sessionId: 'b' }]),
    'token': 'keep',
  })
  global.localStorage = storage
  assert.equal(sessionCache.clear('historyCacheV2:a'), true)
  assert.deepEqual(storage.dump(), { 'sessionsCacheV2:b': JSON.stringify([{ sessionId: 'b' }]), token: 'keep' })
})

test('clearAll removes every session-list copy and keeps credentials and settings', () => {
  const storage = memoryStorage({
    'sessionsCacheV2:a': '[]',
    'historyCacheV2:a:sessions': '[]',
    'sessionsCacheV2:b': '[]',
    'historyCacheV2:b:sessions': '[]',
    'historyCacheV2:b': JSON.stringify({ events: [] }),
    'token': 'keep',
    'servers-v2': '{"servers":[]}',
    'preference': 'keep',
  })
  global.localStorage = storage
  assert.equal(sessionCache.clearAll(), true)
  assert.deepEqual(storage.dump(), {
    'historyCacheV2:b': JSON.stringify({ events: [] }),
    token: 'keep',
    'servers-v2': '{"servers":[]}',
    preference: 'keep',
  })
})

test('storage failures degrade to null/false without throwing', () => {
  global.localStorage = {
    get length() { throw new Error('blocked') },
    key() { throw new Error('blocked') },
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  assert.equal(sessionCache.read('historyCacheV2:abc'), null)
  assert.equal(sessionCache.write('historyCacheV2:abc', []), false)
  assert.equal(sessionCache.clear('historyCacheV2:abc'), false)
  assert.equal(sessionCache.clearAll(), false)
})

test('browser script exposes DshSessionCache on window', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/session-cache.js'), 'utf8')
  const window = { localStorage: memoryStorage() }
  const context = vm.createContext({ window, JSON, Map, Set })
  vm.runInContext(source, context)
  assert.equal(typeof window.DshSessionCache.read, 'function')
  assert.equal(window.DshSessionCache.keys('historyCacheV2:browser').canonical, 'sessionsCacheV2:browser')
  assert.equal(window.DshSessionCache.write('historyCacheV2:browser', [{ sessionId: 'b' }]), true)
  assert.deepEqual(window.DshSessionCache.read('historyCacheV2:browser'), [{ sessionId: 'b' }])
})
