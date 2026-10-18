'use strict'
// A throw while processing a successfully-fetched history page leaves history.loading=true
// forever: every later loadHistory() bails on its own guard, and the back button waits on
// that flag through shouldDiscardEmptySession(). These tests pin the recovery behaviour.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const H = require('../public/history.js')

function entries(start, count) {
  return Array.from({ length: count }, (_, i) => ({ seq: start + i, event: { type: 'assistant/message', data: { text: 'm' + (start + i) } } }))
}

/** Same slice-and-run harness used by tests/history-ui.test.js. */
function loaderFixture(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8')
  const start = source.indexOf('async function loadHistory(')
  const end = source.indexOf(file === 'app.js' ? 'function insertLiveEvent(' : 'const INTERESTING_EVENTS', start)
  const state = { byId: new Map(), current: 'a', history: { visible: entries(10, 3), minSeq: 10, partialReasoning: new Map(), reasoningVersion: 0, hasMore: true } }
  const calls = [], renders = []
  let resolve, reject, valid = true, throwDuringProcessing = false
  const context = vm.createContext({
    state, Date, Number, Map, Set, Math,
    window: {
      DshHistory: throwDuringProcessing
        ? Object.assign({}, H, { reconcile: () => { throw new TypeError('malformed history entry') } })
        : H,
    },
    captureConnection: () => ({ valid: () => valid }),
    getConversationView: () => ({ more: {}, options: { loadingLabel: () => '' } }),
    rpc: (_, payload) => { calls.push(payload); return new Promise((a, b) => { resolve = a; reject = b }) },
    historySource: value => { state.history.source = value },
    setSessionRecovery: phase => { state.recovery = phase }, hydrateSessionProjections: () => {}, applyReasoningStreamEvent: () => {},
    noteSessionTurnTime: () => {}, shouldShowEvent: type => !['session/title', 'title'].includes(type),
    trimVisible: () => {}, applyReasoningBaseline: () => {}, renderSessionTitle: () => {},
    renderSessionSub: () => {}, renderSessionCards: () => {}, updateSessionActions: () => {},
    renderHistory: (...args) => renders.push(args), scheduleHistoryCacheSave: () => {},
    document: { createElement: () => ({ addEventListener: (_, fn) => { context.retry = fn } }) },
    $: () => ({ innerHTML: '', textContent: '', append: () => {} }),
    t: () => '', esc: x => x, authFailure: () => {},
  })
  context.conversationView = { reading: true }
  vm.runInContext(source.slice(source.indexOf('function trimVisible('), start) + source.slice(start, end), context)
  return {
    state, calls, renders, context,
    load: context.loadHistory,
    resolve: value => resolve(value),
    setThrow: value => {
      throwDuringProcessing = value
      context.window.DshHistory = value
        ? Object.assign({}, H, { reconcile: () => { throw new TypeError('malformed history entry') } })
        : H
    },
  }
}

for (const file of ['app.js', 'desktop/desktop.js']) {
  test(file + ': final render failure shows a retryable error and never reports synced', async () => {
    const h=loaderFixture(file);h.state.history.visible=[]
    h.context.renderHistory=()=>{throw Error('render failed')}
    const pending=h.load(true)
    h.resolve({events:[{event:{seq:1,type:'assistant/message'}}],hasMore:false})
    await assert.doesNotReject(pending)
    assert.equal(h.state.history.loading,false);assert.equal(h.state.recovery,'error');assert.notEqual(h.state.history.source,'synced');assert.equal(typeof h.context.retry,'function')
    h.context.renderHistory=()=>{};h.context.retry();h.resolve({events:[{event:{seq:1,type:'assistant/message'}}],hasMore:false});await new Promise(setImmediate)
    assert.equal(h.state.recovery,'ready')
  })
  test(file + ': a throw while processing a page does not strand the loading flag', async () => {
    const h = loaderFixture(file)
    h.setThrow(true)
    const pending = h.load(true).catch(error => error)
    h.resolve({ events: [{ event: { seq: 1, type: 'assistant/message' } }], hasMore: false })
    const outcome = await pending
    // The failure is contained and rendered as a retryable state, not thrown at the caller.
    assert.equal(outcome, undefined, 'processing failures must be contained, not rethrown: ' + file)
    assert.equal(h.state.history.loading, false, 'loading must be cleared even when processing throws: ' + file)
    assert.equal(h.state.history.retryAfter > Date.now(), true, 'the retry backoff must be armed: ' + file)
  })

  test(file + ': a stranded loading flag blocks every later paging attempt', async () => {
    const h = loaderFixture(file)
    h.setThrow(true)
    const pending = h.load(true).catch(() => {})
    h.resolve({ events: [{ event: { seq: 1, type: 'assistant/message' } }], hasMore: false })
    await pending
    // Reproduce the symptom the user saw: paging and the back button both wait on this flag.
    h.setThrow(false)
    h.state.history.retryAfter = 0
    const before = h.calls.length
    void h.load(false)
    assert.equal(h.calls.length, before + 1, 'a later page request must still reach the host: ' + file)
  })
}
