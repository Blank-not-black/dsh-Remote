'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../public/e2ee-transport.js'), 'utf8')

function harness() {
  const calls = [], loopback = 'http://127.0.0.1:31337/e2ee-' + 'a'.repeat(48)
  let failed = false
  let network = async () => ({ ok: true })
  const nodes = [], document = { addEventListener() {}, createElement(tag) {
    const node = { tag, dataset: {}, events: {}, append() {}, setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn }, click() {} }; nodes.push(node); return node
  } }
  class Socket { static OPEN = 1; constructor(...args) { calls.push(['ws', ...args]) } }
  class Xhr { open(...args) { calls.push(['xhr', ...args]) } }
  const root = { location: { href: 'https://localhost/' }, URL, Request, AbortController, AbortSignal, document, confirm: () => true, WebSocket: Socket, XMLHttpRequest: Xhr,
    fetch: async (...args) => { calls.push(['fetch', ...args]); return network(...args) }, NativeE2ee: {
      info: () => JSON.stringify({ configured: false, fingerprint: '' }),
      configure: value => { calls.push(['configure', value]); return JSON.stringify({ origin: 'https://paired.test' }) },
      resolve(value) {
        if (value.includes('paired.test')) {
          if (failed) return JSON.stringify({ error: 'E2EE_TRANSPORT_UNAVAILABLE' })
          const url = new URL(value)
          return JSON.stringify({ url: loopback.replace(/^http/, url.protocol === 'wss:' ? 'ws' : 'http') + url.pathname + url.search, secure: true })
        }
        return JSON.stringify({ url: value, secure: false })
      },
    } }
  vm.runInNewContext(source, { window: root, document, URL, Promise, Error, JSON })
  return { root, calls, nodes, loopback, network: fn => { network = fn }, fail: () => { failed = true } }
}

test('E2EE WebUI routes fetch, Request, XHR and WS to the native adapter and preserves request semantics', async () => {
  const h = harness(), controller = new AbortController()
  await h.root.fetch('https://paired.test/api/prompt', { method: 'POST', body: 'private-body', signal: controller.signal, headers: { authorization: 'Bearer fixture' } })
  assert.equal(h.calls[0][1], h.loopback + '/api/prompt')
  assert.equal(h.calls[0][2].body, 'private-body'); assert.equal(h.calls[0][2].signal.aborted, false)
  controller.abort(); assert.equal(h.calls[0][2].signal.aborted, false) // Completed requests release their caller listener.
  const request = new Request('https://paired.test/api/read', { method: 'POST', body: 'request-body', headers: { authorization: 'Bearer fixture' } })
  await h.root.fetch(request)
  assert.equal(h.calls[1][1].url, h.loopback + '/api/read'); assert.equal(await h.calls[1][1].text(), 'request-body')
  assert.equal(h.calls[1][1].headers.get('authorization'), 'Bearer fixture')
  new h.root.WebSocket('wss://paired.test/api/events.mux?ticket=fixture')
  assert.equal(h.calls[2][1], h.loopback.replace(/^http/, 'ws') + '/api/events.mux?ticket=fixture')
  assert.equal(h.root.WebSocket.OPEN, 1)
  new h.root.XMLHttpRequest().open('POST', 'https://paired.test/fs/upload', true)
  assert.equal(h.calls[3][2], h.loopback + '/fs/upload')
})

test('E2EE transport failure never calls network APIs on the original paired URL', async () => {
  const h = harness(); h.fail()
  await assert.rejects(h.root.fetch('https://paired.test/api/prompt', { method: 'POST', body: 'do-not-retry' }), /E2EE_TRANSPORT_UNAVAILABLE/)
  assert.throws(() => new h.root.WebSocket('wss://paired.test/api/events.host'), /E2EE_TRANSPORT_UNAVAILABLE/)
  assert.throws(() => new h.root.XMLHttpRequest().open('GET', 'https://paired.test/fs/file'), /E2EE_TRANSPORT_UNAVAILABLE/)
  assert.equal(h.calls.length, 0)
})

test('E2EE preserves ordinary LAN requests and leaves browsers without the native bridge unchanged', async () => {
  const h = harness(); await h.root.fetch('http://192.168.1.2:8787/health')
  assert.equal(h.calls[0][1], 'http://192.168.1.2:8787/health')
  const fetch = () => {}; const root = { fetch }
  vm.runInNewContext(source, { window: root }); assert.equal(root.fetch, fetch)
})

test('E2EE preserves cancellation of an in-flight request', async () => {
  const h = harness(), controller = new AbortController()
  h.network((_, options) => new Promise((resolve,reject) => options.signal.addEventListener('abort', () => reject(Error('cancelled')))))
  const request = h.root.fetch('https://paired.test/api/events.poll', { signal: controller.signal })
  controller.abort(); await assert.rejects(request, /cancelled/)
  assert.equal(h.calls.length, 1)
})

for (const sameHost of [false,true]) test('E2EE import reuses a credential only with authenticated host identity proof: ' + sameHost, async () => {
  const h = harness(), connected = [], pin = 'a'.repeat(64)
  h.network(async () => ({ ok: true, json: async () => ({ publicUrl: 'https://paired.test', e2ee: { fingerprint: sameHost ? pin : 'b'.repeat(64) } }) }))
  const ctx = { valid: () => true, url: () => 'http://192.168.1.2:8787/admin/api/relay', headers: { authorization: 'Bearer current-host-fixture' } }
  h.root.DshE2eeTransport.mount({ dataset: {}, append() {} }, { connection: () => ctx, onConnect: value => connected.push(value) })
  const input = h.nodes.find(node => node.tag === 'input')
  input.files = [{ size: 200, text: async () => JSON.stringify({ relayUrl: 'https://paired.test/relay/v1/e2ee', fingerprint: pin }) }]
  await input.events.change()
  assert.equal(h.calls.filter(call => call[0] === 'configure').length, 1)
  assert.deepEqual(connected, sameHost ? ['https://paired.test'] : [])
  assert.ok(h.calls.filter(call => call[0] === 'fetch').every(call => call[1].startsWith('http://192.168.1.2:8787/')))
})
