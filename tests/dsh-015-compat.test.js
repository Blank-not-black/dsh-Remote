'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const zlib = require('node:zlib')
const { StatsStore } = require('../gateway-stats.cjs')
const gateway = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')

function streamBridge() {
  const frames = []
  const modernState = { assistantStreams: new Map(), sessionCursors: new Map() }
  const context = vm.createContext({ modernState, legacyPush: (_, frame) => frames.push(frame) })
  vm.runInContext(gateway.slice(gateway.indexOf('function modernReasoningValue'), gateway.indexOf('function resolveModernPendingEvent')), context)
  return { frames, modernState, feed: (value) => context.applyModernSessionFrame('session', value) }
}

test('DSH 0.1.5 cursorless stream: snapshot, duplicate, retry, end and durable cursor', () => {
  const { feed, frames, modernState } = streamBridge()
  feed({ type: 'snapshot', cursor: 18, records: [], assistantStream: { revision: 3, activeAttempt: { attemptId: 'a', turn: 1, step: 2, nextIndex: 2, stream: [{ type: 'reasoning-chunks', index: 0, texts: ['已', '恢复'] }] } } })
  assert.equal(frames.find(f => f.type === 'session/reasoning').partialReasoning[0].text, '已恢复')
  const chunk = { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a', revision: 4, index: 2, chunk: { type: 'reasoning-delta', index: 0, text: '继续' } } }
  feed(chunk)
  feed(chunk)
  assert.equal(frames.at(-1).partialReasoning[0].text, '已恢复继续')
  assert.equal(modernState.sessionCursors.get('session'), 18)
  feed({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a', revision: 5, index: 3, outcome: { kind: 'abandoned' } } })
  assert.equal(frames.at(-1).partialReasoning.length, 0)
  feed({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'b', revision: 6, turn: 1, step: 2 } })
  feed({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'b', revision: 7, index: 0, chunk: { type: 'reasoning-delta', index: 0, text: '重试' } } })
  assert.equal(frames.at(-1).partialReasoning[0].text, '重试')
  feed({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'b', revision: 9, index: 2, chunk: { type: 'reasoning-delta', index: 0, text: '丢帧' } } })
  assert.equal(frames.at(-1).partialReasoning.length, 0)
  feed({ type: 'event', event: { type: 'assistant/message', seq: 19, data: {} } })
  assert.equal(modernState.sessionCursors.get('session'), 19)
})

test('both clients replace modern reasoning baselines and clear failed attempts', () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const state = { history: { partialReasoning: new Map() } }
    const context = vm.createContext({ state })
    vm.runInContext(source.slice(source.indexOf('function reasoningStreamKey'), source.indexOf('let reasoningRenderTimer')), context)
    const items = [{ turn: 1, step: 2, index: 0, text: 'test' }]
    context.applyReasoningBaseline(items)
    context.applyReasoningBaseline(items)
    assert.equal(state.history.partialReasoning.size, 1)
    context.applyReasoningStreamEvent({ type: 'assistant/attempt', data: { turn: 1, step: 2 } })
    assert.equal(state.history.partialReasoning.size, 0)
    context.applyReasoningBaseline(items)
    context.applyReasoningBaseline([])
    assert.equal(state.history.partialReasoning.size, 0)
  }
})

test('both clients display and escape generic file attachment metadata', () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const start = source.indexOf('function blockHtml')
    const end = source.indexOf('\nfunction ', start + 1)
    const context = vm.createContext({ esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;'), LS: { get: () => '1' } })
    vm.runInContext(source.slice(start, end), context)
    const html = context.blockHtml({ type: 'file', attachment: { name: '<img src=x onerror=alert(1)>.pdf', bytes: 42 } })
    assert.ok(html.includes('&lt;img'))
    assert.ok(html.includes('42'))
    assert.ok(!html.includes('<img'))
  }
})

function usage(seq, id, input = 10) {
  return { type: 'assistant/message', seq, time: Date.UTC(2026, 8, 14, 2), data: { usage: { inputTokens: input }, message: { id, source: { model: 'test-model' } } } }
}
function log(file, version, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = [JSON.stringify({ type: 'session', id: 's', version }), ...events.map(e => JSON.stringify(e))].join('\n') + '\n'
  fs.writeFileSync(file, file.endsWith('.zstd') ? zlib.zstdCompressSync(Buffer.from(text)) : text)
}

test('stats selects V3 generation, deduplicates migrated seqs and resumes after restart', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v3-stats-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, 'sessions')
  const session = path.join(root, 'project', 's')
  const old = path.join(session, 'session.jsonl')
  log(old, 0, [usage(0, 'old')])
  let store = new StatsStore(path.join(home, 'stats'))
  assert.equal((await store.scanAll(root)).processed, 1)
  const next = path.join(session, 'session.v3.jsonl')
  log(next, 3, [{ type: 'system/message', seq: 0, data: {} }, usage(1, 'old'), usage(2, 'new', 20)])
  log(path.join(session, 'session.v03.jsonl'), 3, [usage(3, 'invalid', 999)])
  assert.deepEqual(await store.scanAll(root), { files: 1, processed: 1 })
  store = new StatsStore(path.join(home, 'stats'))
  assert.equal((await store.scanAll(root)).processed, 0)
  assert.equal(store.detail('2026-09-14').hours[10].total.input, 30)
  log(next, 3, [{ type: 'system/message', seq: 0, data: {} }, usage(1, 'old'), usage(2, 'new', 20), usage(3, 'last', 5)])
  assert.equal((await store.scanAll(root)).processed, 1)
  assert.equal(store.detail('2026-09-14').hours[10].total.input, 35)
})

test('stats supports native zstd V3 and does not advance on corrupt input', { skip: typeof zlib.zstdCompressSync !== 'function' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v3-zstd-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, 's', 'session.v3.jsonl.zstd')
  const store = new StatsStore(path.join(home, 'stats'))
  log(file, 3, [usage(0, 'a')])
  assert.equal((await store.scanFile(file)).processed, 1)
  fs.writeFileSync(file, Buffer.from('broken'))
  assert.ok((await store.scanFile(file)).error)
  assert.equal(store._cursor('s').lastSeq, 0)
  assert.equal(store.detail('2026-09-14').hours[10].total.input, 10)
})

test('stats refuses migration with missing predecessor instead of double counting', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v3-missing-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, 's', 'session.v3.jsonl')
  const store = new StatsStore(path.join(home, 'stats'))
  store.processEvent('s', usage(0, 'old'))
  log(file, 3, [usage(1, 'old')])
  assert.equal((await store.scanFile(file)).error, 'stats-migration-source-missing')
  assert.equal(store.detail('2026-09-14').hours[10].total.input, 10)
})
