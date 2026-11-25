'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n')
const mobileHtml = read('public/index.html')
const desktopHtml = read('public/desktop/desktop.html')
const config = read('public/e2ee-config.js')
const app = read('public/app.js')

const tag = (file, prefix = '') => `<script src="${prefix}${file}`
const order = (html, needle, before) => {
  const at = html.indexOf(needle)
  assert.ok(at >= 0, needle)
  const target = html.indexOf(before)
  assert.ok(target >= 0, before)
  assert.ok(at < target, `${needle} must load before ${before}`)
}

test('the release loads the kill switch but no E2EE transport or pairing scripts', () => {
  for (const [html, prefix] of [[mobileHtml, ''], [desktopHtml, '../']]) {
    assert.equal(html.includes(tag('e2ee-transport.js', prefix)), false)
    assert.equal(html.includes(tag('relay-autopair.js', prefix)), false)
    assert.equal(html.includes(tag('relay-devices.js', prefix)), false)
    assert.ok(html.includes(tag('e2ee-config.js', prefix)))
    order(html, tag('e2ee-config.js', prefix), tag('relay-settings.js', prefix))
  }
  assert.match(config, /DSH_REMOTE_E2EE_DISABLED\s*=\s*true/)
})

test('enabling the kill switch makes the transport and pairing modules inert', () => {
  const fetch = async () => ({ ok: true })
  const window = {
    DSH_REMOTE_E2EE_DISABLED: true,
    fetch,
    WebSocket: class NativeWebSocket {},
    XMLHttpRequest: class NativeXhr {},
    location: { origin: 'http://origin', href: 'http://origin/' },
    I18N: { lang: 'zh' },
  }
  const context = vm.createContext({ window, URL })
  vm.runInContext(config + '\n' + read('public/e2ee-transport.js') + '\n' + read('public/relay-autopair.js') + '\n' + read('public/relay-devices.js'), context)
  assert.equal(window.fetch, fetch)
  assert.equal(window.DshE2eeTransport.resolve('https://paired.test/api'), 'https://paired.test/api')
  assert.equal(window.DshE2eeTransport.mount(), undefined)
  assert.equal(window.DshRelayDevices.mount(), null)
  return window.DshRelayAutoPair.offer().then(result => {
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E2EE_DISABLED')
  })
})

test('relay settings hide device management and explain the disabled state', () => {
  const source = read('public/relay-settings.js')
  assert.match(source, /const e2eeOff = root\.DSH_REMOTE_E2EE_DISABLED === true/)
  assert.match(source, /if \(e2eeOff\) \{ deviceManagement = false; phonePairingCode = null \}/)
  assert.match(source, /此版本已停用端到端加密/)
})

test('startup cleanup removes only the auto-added encrypted public host', () => {
  const start = app.indexOf('function disableE2eeState()')
  const end = app.indexOf('\nfunction initToken()', start)
  assert.ok(start >= 0 && end > start)
  const cleared = []
  const state = {
    server: 'https://relay.example.test',
    token: 'token-a',
    servers: [
      { id: 'lan', url: 'http://lan.example.test', token: 'token-a', cacheRelayOrigin: 'https://relay.example.test', cacheRelayPin: 'f'.repeat(64) },
      { id: 'relay', url: 'https://relay.example.test', token: 'token-a', cacheRelayOrigin: 'https://relay.example.test', cacheRelayPin: 'f'.repeat(64) },
      { id: 'other', url: 'http://other.example.test', token: 'token-a' },
    ],
  }
  const saved = []
  const context = vm.createContext({
    state,
    window: { NativeE2ee: { clear: () => { cleared.push(true); return true } } },
    serverToken: entry => entry.token,
    saveServers: () => saved.push(true),
    LS: { set: () => {}, del: () => {} },
  })
  vm.runInContext(app.slice(start, end) + '\nthis.disable = disableE2eeState', context)
  context.disable()
  assert.equal(cleared.length, 1)
  assert.deepEqual(state.servers.map(server => server.id), ['lan', 'other'])
  assert.equal(state.servers[0].cacheRelayOrigin, undefined)
  assert.equal(state.servers[0].cacheRelayPin, undefined)
  assert.equal(state.server, 'http://lan.example.test')
  assert.equal(saved.length, 1)
})

test('startup cleanup clears the active credential when no host remains', () => {
  const start = app.indexOf('function disableE2eeState()')
  const end = app.indexOf('\nfunction initToken()', start)
  const state = {
    server: 'https://relay.example.test',
    token: 'token-a',
    servers: [
      { id: 'relay', url: 'https://relay.example.test', token: 'token-a', cacheRelayOrigin: 'https://relay.example.test', cacheRelayPin: 'f'.repeat(64) },
    ],
  }
  const removed = []
  const context = vm.createContext({
    state,
    window: { NativeE2ee: { clear: () => true } },
    serverToken: entry => entry.token,
    saveServers: () => {},
    LS: { set: () => {}, del: key => removed.push(key) },
  })
  vm.runInContext(app.slice(start, end) + '\nthis.disable = disableE2eeState', context)
  context.disable()
  assert.equal(state.servers.length, 0)
  assert.equal(state.server, '')
  assert.equal(state.token, '')
  assert.deepEqual(removed, ['token'])
})

test('app disables auto-pairing and peer cache reuse at every entry point', () => {
  assert.match(app, /function verifiedCachePeer\(server, token\) \{\s*if \(globalThis\.DSH_REMOTE_E2EE_DISABLED === true\) return ''/)
  assert.match(app, /function saveAutoPairedRelay\(origin, connection\) \{\s*if \(globalThis\.DSH_REMOTE_E2EE_DISABLED === true \|\| !connection\.valid\(\)\) return/)
  assert.match(app, /function offerLocalRelayPairing\([\s\S]{0,160}if \(globalThis\.DSH_REMOTE_E2EE_DISABLED === true\) return/)
  assert.match(app, /function syncRelayActivation\([\s\S]{0,160}if \(globalThis\.DSH_REMOTE_E2EE_DISABLED === true\) return/)
  assert.match(app, /globalThis\.DSH_REMOTE_E2EE_DISABLED === true \? undefined : saveAutoPairedRelay/)
})
