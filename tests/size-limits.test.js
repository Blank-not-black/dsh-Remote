'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events')
const { createRealisticStack } = require('./fixtures/realistic-stack.cjs')
const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')
test('poll events preserve full long strings and arrays while evicting whole records by bytes', () => {
  const buffers = { mux: [], host: [] }, broadcast = []
  const c = vm.createContext({ Buffer, EVENT_STREAM_EPOCH: 'test', EVENT_BUFFER_MAX: 1000, EVENT_BUFFER_MAX_BYTES: 65536, eventBuffers: buffers, eventNextSeq: { mux: 1, host: 1 }, eventCollectorState: { mux: {} }, rememberCollectorReplay() {}, broadcastCollectorFrame: (kind, raw) => broadcast.push(JSON.parse(raw)), flushEventPollWaiters() {} })
  const start = source.indexOf('function pushEvent('), end = source.indexOf('\nfunction eventPollPayload(', start)
  vm.runInContext(source.slice(start, end), c)
  const frame = { payload: { type: 'session/event', sessionId: 'S', text: '中'.repeat(20000), items: Array.from({ length: 220 }, (_, i) => i) } }
  c.pushEvent('mux', frame)
  assert.equal(buffers.mux[0].event.payload.text, frame.payload.text); assert.equal(buffers.mux[0].event.payload.items.length, 220)
  assert.deepEqual(JSON.parse(JSON.stringify(buffers.mux[0].event)), broadcast[0])
  c.pushEvent('mux', { payload: { text: 'b'.repeat(40000) } })
  assert.equal(buffers.mux.length, 1); assert.equal(buffers.mux[0].seq, 2)
  c.pushEvent('mux', { payload: { text: 'x'.repeat(100000) } })
  assert.equal(buffers.mux.length, 1); assert.equal(buffers.mux[0].event.payload.text.length, 100000)
  assert.doesNotMatch(JSON.stringify(buffers.mux), /"bytes":/)
})
test('API body limits reject chunked UTF-8 bytes once and discard all later chunks', async () => {
  const c = vm.createContext({ Buffer })
  vm.runInContext(source.slice(source.indexOf('function readBody('), source.indexOf('\nfunction withRequestBody(')), c)
  const start = source.indexOf('function readApiRequest('), end = source.indexOf('\nasync function ', start)
  vm.runInContext(source.slice(start, end), c)
  const request = new EventEmitter(), pending = c.readApiRequest(request, 4)
  request.emit('data', Buffer.from('中文'))
  for (let i = 0; i < 100; i++) request.emit('data', Buffer.alloc(1000))
  request.emit('end')
  await assert.rejects(pending, error => error.status === 413 && error.code === 'body-too-large')
  const normal = new EventEmitter(), value = c.readApiRequest(normal, 6), bytes = Buffer.from('中文')
  normal.emit('data', bytes.subarray(0, 2)); normal.emit('data', bytes.subarray(2)); normal.emit('end')
  assert.equal(await value, '中文')
})
test('chunked responses are bounded by decoded wire bytes and cancelled at the limit', async () => {
  const c = vm.createContext({ Buffer }), start = source.indexOf('async function readResponseText('), end = source.indexOf('\nfunction ', start)
  vm.runInContext(source.slice(start, end), c)
  let cancelled = false, reads = 0
  const response = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(Buffer.from('中文')) }, cancel() { cancelled = true } }))
  await assert.rejects(c.readResponseText(response, 10), error => error.status === 413)
  assert.equal(cancelled, true); assert.ok(reads <= 3)
  assert.equal(await c.readResponseText(new Response('中文'), 6), '中文')
})
test('oversized operation and RPC requests return 413 without contacting DSH or crashing the gateway', async t => {
  const stack = await createRealisticStack(); t.after(() => stack.stop())
  const body = JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) })
  for (const route of ['/api/operations?id=body-limit-test-12345678', '/api/session.prompt']) {
    const response = await fetch(stack.base + route, { method: 'POST', headers: { authorization: 'Bearer ' + stack.token, 'content-type': 'application/json' }, body })
    assert.equal(response.status, 413, route); assert.equal((await response.json()).error, 'body-too-large')
  }
  assert.equal((await fetch(stack.base + '/health')).status, 200)
})
