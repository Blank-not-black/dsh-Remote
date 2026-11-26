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
  let network = async () => ({ ok: true, json: async () => ({ e2ee: { allowed: true, enabled: true } }) })
  const pairs = new Map(); let modeFailure = false
  const nodes = [], document = { addEventListener() {}, createElement(tag) {
    const node = { tag, dataset: {}, events: {}, append() {}, setAttribute() {}, addEventListener(name, fn) { this.events[name] = fn }, click() {} }; nodes.push(node); return node
  } }
  class Socket { static OPEN = 1; constructor(...args) { calls.push(['ws', ...args]) } }
  class Xhr { open(...args) { calls.push(['xhr', ...args]) } }
  const root = { location: { href: 'https://localhost/' }, URL, Request, AbortController, AbortSignal, document, confirm: () => true, WebSocket: Socket, XMLHttpRequest: Xhr,
    fetch: async (...args) => { calls.push(['fetch', ...args]); return network(...args) }, NativeE2ee: {
      info: base => { const state=pairs.get(new URL(base).origin);return JSON.stringify({configured:!!state,encrypted:state?.encrypted!==false,fingerprint:state?.fingerprint||''}) },
      configure: value => { calls.push(['configure', value]);const pair=JSON.parse(value),origin=new URL(pair.relayUrl).origin;pairs.set(origin,{fingerprint:pair.fingerprint,encrypted:pairs.get(origin)?.encrypted!==false});return JSON.stringify({origin}) },
      setEncryption: (origin,enabled,pin,ack) => {
        calls.push(['setEncryption',origin,enabled,pin,ack]);const state=pairs.get(origin)
        if(modeFailure||!state||state.fingerprint!==pin||!enabled&&!ack)return JSON.stringify({error:'E2EE_MODE_CHANGE_FAILED'})
        state.encrypted=enabled;return JSON.stringify({origin,encrypted:enabled})
      },
      resolve(value) {
        if (value.includes('paired.test')) {
          if (failed) return JSON.stringify({ error: 'E2EE_TRANSPORT_UNAVAILABLE' })
          const url = new URL(value)
          return JSON.stringify({ url: loopback.replace(/^http/, url.protocol === 'wss:' ? 'ws' : 'http') + url.pathname + url.search, secure: pairs.get(url.origin)?.encrypted!==false, paired:true })
        }
        return JSON.stringify({ url: value, secure: false })
      },
    } }
  vm.runInNewContext(source, { window: root, document, URL, Promise, Error, JSON, Headers, Response, setTimeout })
  return { root, calls, nodes, loopback, pairs, pair:(encrypted=true,origin='https://paired.test')=>pairs.set(origin,{fingerprint:'a'.repeat(64),encrypted}),modeFailure:()=>{modeFailure=true},network: fn => { network = fn }, fail: () => { failed = true } }
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

test('E2EE diagnostics distinguish a returned HTTP status and a rejected fetch without changing the request', async () => {
  const h = harness(), events = []
  h.root.NativeE2ee.httpDiagnostics = () => '[]'
  let localCalls = 0
  h.root.NativeE2ee.localHttpState = () => {
    const before = localCalls++ === 0
    return JSON.stringify({ relayProxyId: 5, relayAcceptCount: before ? 8 : 9, relayListener: 'open',
      relaySlotLimit: 64, relaySlotsUsed: before ? 64 : 63, relayBusyCount: before ? 0 : 1, secret: 'private' })
  }
  h.root.DshDiagnostics = {
    start: (kind, fields) => ({ end: result => events.push({ kind, ...fields, ...result }) }),
    errorFacts: error => ({ errorName: error.name }),
  }
  const endpoint = 'https://paired.test/api/session.list'
  const options = { method: 'POST', body: 'private-body' }
  h.network(async () => ({ ok: false, status: 503 }))
  assert.equal((await h.root.fetch(endpoint, options)).status, 503)
  const failure = new TypeError('private network detail')
  h.network(async () => { throw failure })
  await assert.rejects(h.root.fetch(endpoint, options), error => error === failure)
  h.fail()
  await assert.rejects(h.root.fetch(endpoint, options), /E2EE_TRANSPORT_UNAVAILABLE/)
  assert.equal(h.calls.length, 2)
  assert.ok(h.calls.every(([, url, init]) => url === h.loopback + '/api/session.list' && init.body === options.body))
  assert.deepEqual(events.map(row => [row.relayStage, row.httpStatus, row.errorName]), [
    ['response', 503, undefined], ['fetch-failed', undefined, 'TypeError'], ['resolve-failed', undefined, 'Error'],
  ])
  assert.deepEqual(events.map(row => [row.relayProxyId, row.relayAcceptBefore, row.relayAcceptAfter]), [
    [5, 8, 9], [5, 9, 9], [undefined, undefined, undefined],
  ])
  assert.deepEqual(events.map(row => [row.relaySlotLimit, row.relaySlotsUsedBefore, row.relaySlotsUsedAfter, row.relayBusyBefore, row.relayBusyAfter]), [
    [64, 64, 63, 0, 1], [64, 63, 63, 1, 1], [undefined, undefined, undefined, undefined, undefined],
  ])
  assert.doesNotMatch(JSON.stringify(events), /private|paired\.test/)
})

test('a paired WebView network error gets one native comparison for the exact read-only session list RPC', async () => {
  const h = harness(), probes = [], rows = []
  h.root.NativeE2ee.httpDiagnostics = () => '[]'
  h.root.NativeE2ee.startListProbe = (...args) => { probes.push(args); return 1 }
  h.root.NativeE2ee.pollHttpRequest = () => JSON.stringify({
    status: 200, outcome: 'native-response', body: '{"result":{"ok":true,"value":{"items":[]}}}',
  })
  h.root.NativeE2ee.cancelHttpRequest = () => {}
  h.root.DshDiagnostics = {
    start: () => ({ traceId: 'a'.repeat(24), end() {} }),
    record: (kind, row) => rows.push({ kind, ...row }),
    errorFacts: error => ({ errorName: error.name }),
  }
  const failure = new TypeError('failed to fetch')
  h.network(async () => { throw failure })
  const options = { method: 'POST', headers: { authorization: 'Bearer fixture', 'x-dsh-remote-client-id': 'fixture-id' },
    body: '{"type":"client-request","method":"session.list","rpcId":"fixture-rpc","payload":{}}' }
  const endpoint = 'https://paired.test/api/session.list'
  const result = await h.root.fetch(endpoint, options)
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).result.value.items, [])
  assert.deepEqual(probes, [[h.loopback + '/api/session.list', 'Bearer fixture', 'fixture-id', 'fixture-rpc']])
  assert.equal(rows[0].traceId, 'a'.repeat(24))
  assert.equal(rows[0].kind, 'relay.native')
  assert.equal(rows[0].httpStatus, 200)
  for (const url of ['https://paired.test/api/operations?id=fixture', 'http://lan.test/api/session.list', endpoint + '?test=1']) {
    await assert.rejects(h.root.fetch(url, options), error => error === failure)
  }
  await assert.rejects(h.root.fetch(endpoint, { ...options, body: options.body.replace('"payload":{}', '"payload":{"filter":"fixture"}') }), error => error === failure)
  h.network(async () => ({ status: 503, ok: false }))
  assert.equal((await h.root.fetch(endpoint, options)).status, 503)
  assert.equal(probes.length, 1)
  assert.doesNotMatch(JSON.stringify(rows), /Bearer|fixture|paired\.test|items/)
})

test('paired Android operation submits once by native HTTP and checks the same receipt after a lost response', async () => {
  const h = harness(), requests = [], diagnostics = [], stored = new Map()
  h.root.crypto = require('node:crypto').webcrypto
  h.root.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }
  h.root.DshDiagnostics = { record: (kind, fields) => diagnostics.push({ kind, ...fields }) }
  h.root.NativeE2ee.startOperationRequest = (...args) => requests.push(args)
  h.root.NativeE2ee.pollHttpRequest = id => JSON.stringify(id === 1
    ? { status: 0, outcome: 'native-network', body: '' }
    : { status: 200, outcome: 'native-response', body: '{"phase":"complete","result":{"ok":true}}' })
  h.root.NativeE2ee.cancelHttpRequest = () => {}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/operations.js'), 'utf8'), {
    window: h.root, URL, TextEncoder, AbortSignal, setTimeout,
  })
  const payload = { sessionId: 'private-session', mode: 'queue', content: [{ type: 'text', text: '测试' }] }
  const result = await h.root.DshOperations.execute({ method: 'session.prompt', payload,
    url: route => 'https://paired.test' + route, headers: { authorization: 'Bearer fixture', 'x-dsh-remote-client-id': 'fixture-app' },
    valid: () => true,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(requests.map(row => row[1]), ['POST', 'GET'])
  assert.match(requests[0][0], /\/api\/operations\?id=[A-Za-z0-9_-]{16,80}$/)
  assert.equal(requests[0][0], requests[1][0])
  assert.deepEqual(requests[0].slice(2), ['Bearer fixture', 'fixture-app', JSON.stringify({ method: 'session.prompt', payload })])
  assert.equal(requests[1][4], null)
  assert.equal(h.calls.length, 0)
  assert.equal(h.root.DshOperations.pending().length, 0)
  assert.deepEqual(diagnostics.map(row => [row.httpMethod, row.relayStage, row.httpStatus]), [
    ['POST', 'native-network', undefined], ['GET', 'native-response', 200],
  ])
  assert.doesNotMatch(JSON.stringify(diagnostics), /Bearer|private-session|fixture-app|测试/)
})

test('native operation transport preserves status and abort and keeps other connections on fetch', async () => {
  const h = harness(), starts = [], cancels = []
  h.root.NativeE2ee.startOperationRequest = (...args) => starts.push(args)
  h.root.NativeE2ee.pollHttpRequest = () => JSON.stringify({ status: 409, outcome: 'native-response', body: '{"error":"operation-conflict"}' })
  h.root.NativeE2ee.cancelHttpRequest = id => cancels.push(id)
  const route = '/api/operations?id=fixture-id-012345', url = 'https://paired.test' + route
  const response = await h.root.fetch(url, { method: 'POST', body: '{}' })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'operation-conflict')
  const aborted = new AbortController(), reason = Error('aborted')
  aborted.abort(reason)
  await assert.rejects(h.root.fetch(url, { signal: aborted.signal }), error => error === reason)
  const inFlight = new AbortController()
  h.root.NativeE2ee.pollHttpRequest = () => ''
  const receipt = h.root.fetch(url, { signal: inFlight.signal })
  inFlight.abort(reason)
  await assert.rejects(receipt, error => error === reason)
  assert.deepEqual(cancels, [1, 2])
  assert.equal(h.calls.length, 0)
  await h.root.fetch('http://lan.test' + route, { method: 'POST', body: '{}' })
  h.pair(false)
  await h.root.fetch(url, { method: 'POST', body: '{}' })
  assert.equal(starts.length, 2)
  assert.equal(h.calls.length, 2)
})

test('paired history recovers after a WebView error and reconnect tickets use native HTTP directly', async () => {
  const h = harness(), native = []
  h.root.NativeE2ee.startHistoryRequest = (...args) => native.push(['history', ...args])
  h.root.NativeE2ee.startTicketRequest = (...args) => native.push(['ticket', ...args])
  h.root.NativeE2ee.cancelHttpRequest = () => {}
  h.root.NativeE2ee.pollHttpRequest = id => JSON.stringify({ status: 200, outcome: 'native-response',
    body: id === 1 ? '{"result":{"ok":true,"value":{"events":[]}}}' : '{"ticket":"fixture-ticket","expiresAt":100}' })
  h.network(async () => { throw new TypeError('WebView connection failed') })
  const body = '{"type":"client-request","method":"session.history","rpcId":"fixture","payload":{"sessionId":"fixture","beforeSeq":12}}'
  const options = { method: 'POST', body, headers: { authorization: 'Bearer fixture' } }
  const history = await h.root.fetch('https://paired.test/api/session.history', options)
  assert.deepEqual((await history.json()).result.value.events, [])
  const ticket = await h.root.fetch('https://paired.test/api/ws-ticket', { method: 'POST', headers: options.headers })
  assert.equal((await ticket.json()).ticket, 'fixture-ticket')
  assert.deepEqual(native, [
    ['history', h.loopback + '/api/session.history', 'Bearer fixture', '', body],
    ['ticket', h.loopback + '/api/ws-ticket', 'Bearer fixture', ''],
  ])
  assert.equal(h.calls.length, 1)
  h.network(async () => new Response('{}', { status: 401 }))
  assert.equal((await h.root.fetch('https://paired.test/api/session.history', options)).status, 401)
  assert.equal(native.length, 2)
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

async function modePanel(h, valid=()=>true) {
  const changes=[],ctx={valid,url:()=> 'https://paired.test/admin/api/relay',headers:{authorization:'Bearer fixture'}}
  h.root.DshE2eeTransport.mount({dataset:{},append(){}},{connection:()=>ctx,onModeChange:origin=>changes.push(origin)})
  await new Promise(resolve => setTimeout(resolve, 0))
  return {toggle:h.nodes.find(n=>n.dataset.e2eeToggle),status:h.nodes.find(n=>n.className==='relay-encryption-status'),changes}
}
test('E2EE mode defaults off, distinguishes pending pairing, and cancellation never changes the native setting', async()=>{
  const pending=harness(),first=await modePanel(pending)
  assert.equal(first.toggle.checked,false);assert.equal(first.toggle.disabled,true);assert.match(first.status.textContent,/待本地配对/)
  const h=harness();h.pair();let warning='';h.root.confirm=message=>{warning=message;return false}
  const panel=await modePanel(h);panel.toggle.checked=false;panel.toggle.events.change()
  assert.match(warning,/Remote 访问令牌/);assert.match(warning,/HTTPS/)
  assert.equal(panel.toggle.checked,true);assert.equal(h.calls.some(c=>c[0]==='setEncryption'),false)
})
test('E2EE explicit disable warns every time, preserves HTTPS routing, persists per host and can re-enable',async()=>{
  const h=harness();h.pair();h.pair(true,'https://other.paired.test');let warnings=0;h.root.confirm=()=>{warnings++;return true}
  const panel=await modePanel(h);panel.toggle.checked=false;panel.toggle.events.change()
  assert.equal(warnings,1);assert.equal(panel.toggle.checked,false);assert.match(panel.status.textContent,/仅有 HTTPS/)
  assert.equal(h.pairs.get('https://paired.test').encrypted,false);assert.equal(h.pairs.get('https://other.paired.test').encrypted,true)
  assert.equal(h.calls.find(c=>c[0]==='setEncryption')[4],true)
  await h.root.fetch('https://paired.test/api/read');assert.equal(h.calls.filter(c=>c[0]==='fetch').at(-1)[1],h.loopback+'/api/read')
  panel.toggle.checked=true;panel.toggle.events.change();assert.equal(panel.toggle.checked,true);assert.equal(warnings,1)
  panel.toggle.checked=false;panel.toggle.events.change();assert.equal(warnings,2);assert.equal(panel.changes.length,3)
})
test('E2EE mode change failure and stale confirmation preserve the original mode', async()=>{
  const h=harness();h.pair();h.modeFailure();const panel=await modePanel(h);panel.toggle.checked=false;panel.toggle.events.change()
  assert.equal(panel.toggle.checked,true);assert.equal(h.pairs.get('https://paired.test').encrypted,true)
  const stale=harness();stale.pair();let valid=true;stale.root.confirm=()=>{valid=false;return true}
  const second=await modePanel(stale,()=>valid);second.toggle.checked=false;second.toggle.events.change()
  assert.equal(stale.calls.some(c=>c[0]==='setEncryption'),false);assert.equal(second.toggle.checked,true)
})

test('the phone pairing card can open the existing scanner before a LAN connection exists', async()=>{
  const h=harness(),ctx={valid:()=>true,url:()=> '/relay',headers:{authorization:'Bearer '}}
  let opened=0
  h.root.DshE2eeTransport.mount({dataset:{},append(){}},{connection:()=>ctx,onScan:()=>{opened++}})
  await new Promise(resolve => setTimeout(resolve, 0))
  const scanner=h.nodes.find(node=>node.textContent==='扫描电脑连接码')
  assert.equal(scanner.hidden,false)
  scanner.events.click()
  assert.equal(opened,1)
})
