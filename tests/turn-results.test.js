'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const turns = require('../public/turn-results.js')
const activity = require('../public/activity.js')
const row = (seq, type, data = {}, time = 1720000000000 + seq) => ({ seq, event: { seq, type, data, time } })
const answer = (seq, text, usage, turn = 1) => row(seq, 'assistant/message', { turn, usage, message: { content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text }] } })
const history = () => [row(0, 'turn/start', { turn: 1 }), row(1, 'user/message'), answer(2, 'Checking', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 100 }), row(3, 'tool/call', { callId: 'a' }), row(4, 'tool/result', { callId: 'a' }), answer(5, '**Final answer**', { inputTokens: 30, outputTokens: 40, cacheWriteTokens: 200, reasoningTokens: 25 }), row(6, 'turn/end', { turn: 1 })]

test('a completed turn copies the last answer and counts disjoint usage without mutating events', () => {
  const raw = history(), saved = JSON.stringify(raw)
  const result = turns.summarize(raw, 'parent').get(6)
  assert.equal(result.text, '**Final answer**')
  assert.equal(result.total, 400)
  assert.equal(result.partial, false)
  assert.equal(result.time, raw.at(-1).event.time)
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 60, cacheReadTokens: 100, cacheWriteTokens: 200 })
  const decorated = turns.decorate(activity.group(activity.prepare(raw)), raw, { sessionId: 'parent', canFork: true })
  assert.equal(decorated.filter(e => e.view?.turnResult).length, 1)
  assert.equal(decorated.find(e => e.view?.turnResult).seq, 6)
  assert.equal(JSON.stringify(raw), saved)
  assert.doesNotMatch(JSON.stringify(result), /private thought/)
})

test('running turns have no toolbar; completed earlier turns remain at their exact boundaries', () => {
  const raw = history()
  assert.equal(turns.summarize(raw.slice(0, -1), 's').size, 0)
  raw.push(row(7, 'turn/start', { turn: 2 }), row(8, 'user/message'), answer(9, 'Second', { inputTokens: 2, outputTokens: 3 }, 2))
  assert.deepEqual([...turns.summarize(raw, 's').keys()], [6])
  raw.push(row(10, 'turn/end', { turn: 2 }))
  const results = turns.summarize(raw, 's')
  assert.equal(results.get(6).text, '**Final answer**')
  assert.equal(results.get(10).text, 'Second')
  assert.equal(results.get(10).total, 5)
})

test('partial pages, missing usage and absent timestamps never look like complete zero totals', () => {
  const tail = history().slice(5), result = turns.summarize(tail, 's').get(6)
  assert.equal(result.partial, true)
  assert.match(turns.html(result), /已知用量/)
  const raw = [row(0, 'turn/start', { turn: 1 }), answer(1, 'No usage'), row(2, 'turn/end', { turn: 1 }, 'bad-date')]
  const absent = turns.summarize(raw, 's').get(2)
  assert.equal(absent.total, null)
  assert.equal(absent.time, null)
  assert.match(turns.html(absent), /时间未知/)
  raw[1].event.data.usage = { inputTokens: 0, outputTokens: 0 }
  assert.equal(turns.summarize(raw, 's').get(2).total, 0)
  raw[1].event.data.usage = { inputTokens: -1, outputTokens: '30' }
  assert.equal(turns.summarize(raw, 's').get(2).total, null)
})

test('authoritative total includes caches once, duplicate seqs do not inflate it, empty turns stay hidden', () => {
  const raw = [row(0, 'turn/start', { turn: 1 }), answer(1, 'ok', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 50, totalTokens: 80 }), row(2, 'turn/end', { turn: 1 })]
  assert.equal(turns.summarize([raw[0], raw[1], raw[1], raw[2]], 's').get(2).total, 80)
  assert.equal(turns.summarize([raw[0], raw[2]], 's').size, 0)
  assert.equal(turns.summarize([raw[0], raw[1], row(2, 'turn/end', { turn: 9 })], 's').size, 0)
})

test('toolbar escapes attributes, preserves exact timestamp and hides fork on read-only records', () => {
  const result = turns.summarize(history(), '\"><img onerror=x>').get(6)
  const html = turns.html(result)
  assert.doesNotMatch(html, /<img|data-turn-action="fork"/)
  assert.match(html, /aria-label="复制结果"/)
  assert.match(html, /datetime="2024-/)
  assert.match(turns.html({ ...result, canFork: true }), /data-turn-action="fork"/)
})

function actions() {
  let click, valid = true, copies = [], forks = [], opens = [], status = { textContent: '' }
  let source = history()
  const box = { dataset: {}, contains: () => true, addEventListener: (name, fn) => { click = fn } }
  const context = () => ({ entries: source, sessionId: 's', key: 'connection', canFork: true, valid: () => valid })
  const host = { capture: context, copy: async value => { copies.push(value); return true }, fork: async payload => { forks.push(payload); return { sessionId: 'child' } }, open: async id => { opens.push(id) } }
  turns.bind(box, host)
  const fire = action => {
    const row = { dataset: { turnSeq: '6', turnSession: 's' }, querySelector: () => status }
    const button = { dataset: { turnAction: action }, closest: () => row }
    return click({ target: { closest: () => button } })
  }
  return { host, copies, forks, opens, status, fire, invalidate: () => { valid = false }, changeSource: value => { source = value } }
}

test('delegated copy uses raw final Markdown and branch sends only sessionId plus inclusive atSeq', async () => {
  const ui = actions()
  await ui.fire('copy')
  assert.deepEqual(ui.copies, ['**Final answer**'])
  assert.equal(ui.status.textContent, '已复制')
  await ui.fire('fork')
  assert.deepEqual(ui.forks, [{ sessionId: 's', atSeq: 6 }])
  assert.deepEqual(ui.opens, ['child'])
})

test('duplicate branch clicks execute once; a late reply cannot open a child after switching sessions', async () => {
  const ui = actions()
  let resolve
  ui.host.fork = payload => { ui.forks.push(payload); return new Promise(done => { resolve = done }) }
  const pending = ui.fire('fork')
  await ui.fire('fork')
  assert.equal(ui.forks.length, 1)
  ui.invalidate(); resolve({ sessionId: 'child' }); await pending
  assert.deepEqual(ui.opens, [])
  await ui.fire('copy'); assert.deepEqual(ui.copies, [])
})

test('failure reports an error without opening anything; stale history cannot invoke actions', async () => {
  const ui = actions()
  ui.host.fork = async () => { throw Error('Result unconfirmed') }
  await ui.fire('fork')
  assert.match(ui.status.textContent, /unconfirmed/)
  assert.deepEqual(ui.opens, [])
  ui.changeSource([]); await ui.fire('copy'); assert.deepEqual(ui.copies, [])
})

test('both actual render pipelines retain boundary events and put the toolbar after the completed answer', () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    const entries = history(), state = { current: 's', history: { visible: entries }, byId: new Map([['s', { running: false }]]) }
    let rendered
    const runtime = vm.createContext({ window: { DshActivity: activity, DshTurnResults: turns }, state,
      filteredEntries: () => entries, weakStreamTrim: () => false, canForkTurnResult: () => true, bindTurnResultActions() {},
      $: () => ({}), t: key => key, getConversationView: () => ({ set: value => { rendered = value } }), partialReasoningHtml: () => '' })
    const start = source.indexOf('function renderHistory('), end = source.indexOf('\nwindow.applyStreamPreference', start)
    vm.runInContext(source.slice(start, end), runtime)
    runtime.renderHistory()
    assert.equal(rendered.at(-1).view.turnResult.atSeq, 6, file)
    const eventsStart = source.indexOf('const INTERESTING_EVENTS'), eventsEnd = source.indexOf('function messageSource(', eventsStart)
    vm.runInContext(source.slice(eventsStart, eventsEnd) + '\nglobalThis.interesting = INTERESTING_EVENTS', runtime)
    assert.ok(runtime.interesting.has('turn/start'))
    assert.ok(runtime.interesting.has('turn/end'))
  }
})

test('both hosts put a confirmed branch in the list even when roster refresh has not caught up', async () => {
  for (const file of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    for (const scenario of ['late-roster', 'offline-roster', 'listed', 'changed']) {
      let host, valid = true, opened = [], renders = 0
      const parent = { sessionId: 'parent', blank: false }
      const state = { current: 'parent', sessions: [parent], byId: new Map([['parent', parent]]), history: { visible: history() } }
      const context = vm.createContext({ window: { DshTurnResults: { bind: (_, value) => { host = value } } }, state, $: () => ({}),
        activeGatewayCapability: () => true, captureConnection: () => ({ valid: () => valid }), copyText() {}, rpc() {},
        refreshSessions: async () => {
          if (scenario === 'offline-roster') throw Error('offline')
          if (scenario === 'changed') valid = false
          if (scenario === 'listed') { const child = { sessionId: 'child', parentSessionId: 'parent' }; state.sessions.push(child); state.byId.set('child', child) }
        }, renderSessions: () => { renders++ }, openSession: async id => { opened.push(id) } })
      vm.runInContext(source.slice(source.indexOf('function canForkTurnResult'), source.indexOf('function renderHistory(')), context)
      context.bindTurnResultActions()
      const capture = host.capture()
      await host.open('child', capture)
      assert.equal(state.sessions.filter(item => item.sessionId === 'child').length, scenario === 'changed' ? 0 : 1, file + scenario)
      assert.deepEqual(opened, scenario === 'changed' ? [] : ['child'])
      assert.equal(renders, ['late-roster', 'offline-roster'].includes(scenario) ? 1 : 0)
    }
  }
})
