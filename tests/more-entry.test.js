'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../packages/plugin/client.js'), 'utf8')
function fixture({ desktop = false, more = true, storage = new Map(), hash = '', blocked = false } = {}) {
  const slots = new Map(), disposers = [], calls = [], opened = [], replaced = [], timers = []
  let plugin, state, store, queued = null
  const React = { useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: fn => { const cleanup = fn(); if (cleanup) disposers.push(cleanup) },
    createElement: (tag, props, ...children) => ({ tag, props, children }) }
  const c = vm.createContext({ Symbol, Set, URL, AbortController,
    location: { protocol: desktop ? 'dsh-app:' : 'http:', hash, replace: value => replaced.push(value) },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: { __ModuleLoader__: { load: module => { plugin = module.factory(name => {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-ui-primitives') throw Error('optional')
      return { defineStore: definition => { state = definition.init(); store = definition; return definition } }
    }) } }, open: (...args) => { opened.push(args); if (blocked) throw Error('open-denied'); return null } },
    fetch: async (...args) => { calls.push(args); return queued ? queued(...args) : { ok: true, json: async () => ({ ok: true, url: 'http://127.0.0.1:12345/?token=fixture#dsh-remote-connect' }) } },
    setTimeout: fn => { timers.push(fn); return timers.length }, clearTimeout() {},
  })
  vm.runInContext(source, c)
  const ctx = { effect: fn => { const cleanup = fn(); if (cleanup) disposers.push(cleanup) }, slots: {
    inject: (name, fn) => name === 'sidebar.panellist.actions' && !more ? () => {} : fn(),
    register: (options, component) => { const key = options.name; slots.set(key, { options, component }); return () => slots.delete(key) },
  } }
  plugin.apply(ctx)
  const actions = state ? Object.fromEntries(Object.entries(store.actions).map(([name, fn]) => [name, () => fn(state)])) : {}
  const props = name => ({ ...slots.get(name).options.inject(), actions, useStore: select => select(state), wide: true, onDismiss() {} })
  const render = name => slots.get(name).component(props(name))
  return { c, calls, opened, replaced, slots, state, storage, timers, actions, props, render,
    setFetch: fn => { queued = fn }, dispose: () => disposers.reverse().forEach(fn => fn()) }
}
const text = node => typeof node === 'string' ? node : (node?.children || []).flat(Infinity).map(text).join(' ')
test('More owns the entry; first-use notice explains its permanent path without requests or a session panel', () => {
  const f = fixture()
  assert.ok(f.slots.has('sidebar.panellist.actions'))
  assert.equal(f.render('sidebar.footer.action'), null)
  assert.equal(f.state.notice, true)
  assert.match(text(f.render('shell.overlay')), /更多 → 手机连接/)
  assert.equal(f.calls.length + f.opened.length, 0)
  assert.doesNotMatch(source, /sidebarRight|createElement\('iframe'|session\/list/)
  const notice = f.render('shell.overlay')
  notice.children.at(-1).children.at(-1).props.onClick()
  assert.equal(f.state.notice, false)
  assert.equal(fixture({ storage: f.storage }).state.notice, false)
  const old = fixture({ more: false })
  assert.ok(old.render('sidebar.footer.action'))
  assert.doesNotMatch(text(old.render('shell.overlay')), /更多 →/)
})
test('Web click opens synchronously despite noopener null; thrown failures remain retryable', async () => {
  const f = fixture()
  await f.props('sidebar.panellist.actions').openConsole(f.actions)
  assert.deepEqual(f.opened, [['/remote/admin/#remote/devices', '_blank', 'noopener,noreferrer']])
  assert.equal(f.calls.length, 0)
  assert.equal(f.state.notice, false)
  const blocked = fixture({ blocked: true })
  await blocked.props('sidebar.panellist.actions').openConsole(blocked.actions)
  assert.equal(blocked.state.error, true)
  assert.equal(blocked.state.notice, true)
  assert.equal(blocked.storage.size, 0)
})
test('Desktop asks the authenticated host only on click and accepts external-handler null without storing credentials', async () => {
  const f = fixture({ desktop: true })
  await f.props('sidebar.panellist.actions').openConsole(f.actions)
  assert.equal(f.calls[0][0], '/remote/admin/api/browser-launch')
  assert.equal(f.calls[0][1].method, 'POST')
  assert.equal(f.calls[0][1].credentials, 'same-origin')
  assert.equal(f.calls[0][1].headers['x-dsh-remote-client'], 'entry')
  assert.equal(f.opened.length, 1)
  assert.equal(f.state.error, false)
  assert.deepEqual([...f.storage.values()], ['1'])
  for (const url of ['javascript:alert(1)', 'https://other.invalid/#dsh-remote-connect', 'http://127.0.0.1:12/other#dsh-remote-connect']) {
    const bad = fixture({ desktop: true })
    bad.setFetch(async () => ({ ok: true, json: async () => ({ ok: true, url }) }))
    await bad.props('sidebar.panellist.actions').openConsole(bad.actions)
    assert.equal(bad.opened.length, 0); assert.equal(bad.state.notice, true)
  }
})
test('repeated launches coalesce; unload aborts and ignores a late host response', async () => {
  const f = fixture({ desktop: true }); let resolve
  f.setFetch(() => new Promise(done => { resolve = done }))
  const launch = f.props('sidebar.panellist.actions').openConsole(f.actions)
  await f.props('sidebar.panellist.actions').openConsole(f.actions)
  assert.equal(f.calls.length, 1)
  f.dispose()
  assert.equal(f.calls[0][1].signal.aborted, true)
  resolve({ ok: true, json: async () => ({ ok: true, url: 'http://127.0.0.1:12345/?token=fixture#dsh-remote-connect' }) })
  await launch
  assert.equal(f.opened.length, 0); assert.equal(f.storage.size, 0)
})
test('only the exact authenticated browser landing navigates to the fixed console', () => {
  const f = fixture({ hash: '#dsh-remote-connect' })
  assert.deepEqual(f.replaced, ['/remote/admin/#remote/devices'])
  assert.equal(f.slots.size, 0)
  assert.equal(fixture({ hash: '#dsh-remote-connect-other' }).replaced.length, 0)
  assert.equal(fixture({ desktop: true, hash: '#dsh-remote-connect' }).replaced.length, 0)
})
