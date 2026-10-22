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
    state, Date, Number, Map, Set, Math, AbortController, clearTimeout,
    window: {
      DshNetwork: require('../public/network.js'),
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
    collectApprovalEvent: () => false, renderApprovalRecords: () => {}, renderApprovalRecordsDesktop: () => {},
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
    reject: error => reject(error),
    setThrow: value => {
      throwDuringProcessing = value
      context.window.DshHistory = value
        ? Object.assign({}, H, { reconcile: () => { throw new TypeError('malformed history entry') } })
        : H
    },
  }
}

for (const file of ['app.js', 'desktop/desktop.js']) {
  test(file + ': history RPC forwards the cancellation signal to its transport', async () => {
    const h=loaderFixture(file),source=fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),controller=new AbortController()
    let signal
    Object.assign(h.context,{CAP:null,uuid:()=>'',clientIdHeaders:()=>({}),apiUrl:x=>x,
      fetch:async(url,opts)=>{signal=opts.signal;return {ok:true,status:200,json:async()=>({result:{ok:true,value:{events:[]}}})}}})
    vm.runInContext(source.slice(source.indexOf('async function rpc('),source.indexOf('async function respond(')),h.context)
    await h.context.rpc('session.history',{sessionId:'a'},45000,controller.signal)
    assert.equal(signal,controller.signal)
  })
  test(file + ': a late cache cannot replace an authoritative response', async () => {
    const h=loaderFixture(file),source=fs.readFileSync(path.join(__dirname,'../public',file),'utf8');let release
    h.state.history.visible=[]
    Object.assign(h.context,{historyCacheScope:()=>'',LS:{get:()=>''},hasSessionTitle:()=>true})
    h.context.window.DshHistory={...H,cacheLoad:()=>new Promise(resolve=>{release=resolve})}
    vm.runInContext(source.slice(source.indexOf('async function restoreCachedHistory('),source.indexOf('function trimVisible(')),h.context)
    const cache=h.context.restoreCachedHistory(),remote=h.load(true)
    h.resolve({events:[{event:{seq:50,type:'assistant/message'}}],hasMore:false});await remote
    release({events:entries(1,2)});assert.equal(await cache,false)
    assert.equal(h.state.history.visible.at(-1).seq,50)
  })
  test(file + ': cache arriving during a network read remains visible if that read fails', async () => {
    const h=loaderFixture(file),source=fs.readFileSync(path.join(__dirname,'../public',file),'utf8');let release
    h.state.history.visible=[]
    Object.assign(h.context,{historyCacheScope:()=>'',LS:{get:()=>''},hasSessionTitle:()=>true})
    h.context.window.DshHistory={...H,cacheLoad:()=>new Promise(resolve=>{release=resolve})}
    vm.runInContext(source.slice(source.indexOf('async function restoreCachedHistory('),source.indexOf('function trimVisible(')),h.context)
    const cache=h.context.restoreCachedHistory(),remote=h.load(true)
    release({events:entries(1,2)});assert.equal(await cache,true)
    h.reject(Error('offline'));await remote
    assert.equal(h.state.history.visible.length,2);assert.equal(h.state.recovery,'cached')
  })
  test(file + ': resuming cancels a stuck read; its late result cannot replace recovered history', async () => {
    const h=loaderFixture(file),jobs=[]
    h.context.rpc=(_,payload,timeout,signal)=>new Promise(resolve=>jobs.push({resolve,signal}))
    h.context.scheduleSessionSync=()=>h.load(true)
    const source=fs.readFileSync(path.join(__dirname,'../public',file),'utf8')
    vm.runInContext(source.slice(source.indexOf('function cancelHistoryLoad('),source.indexOf('async function loadHistory(')),h.context)
    const old=h.load(true),oldController=h.state.history.loadController
    h.context.recoverSessionHistory();assert.equal(jobs.length,2)
    assert.equal(oldController.signal.aborted,true);assert.equal(jobs[0].signal.aborted,true)
    await old
    assert.equal(h.state.history.loading,true,'old finally must not unlock the newer read')
    jobs[1].resolve({events:[{event:{seq:50,type:'assistant/message'}}],hasMore:false})
    await new Promise(setImmediate)
    assert.equal(h.state.history.loading,false);assert.equal(h.state.history.visible.at(-1).seq,50)
    jobs[0].resolve({events:[{event:{seq:3,type:'assistant/message'}}],hasMore:false})
    await new Promise(setImmediate)
    assert.equal(h.state.history.visible.at(-1).seq,50)
  })
  test(file + ': a read that never settles times out into a retryable state', async () => {
    const h=loaderFixture(file)
    h.context.window.DshNetwork={...require('../public/network.js'),profile:()=>({historyPageSize:20,readTimeout:10})}
    h.context.rpc=()=>new Promise(()=>{})
    await h.load(true)
    assert.equal(h.state.history.loading,false);assert.equal(h.state.recovery,'cached')
    h.state.history.visible=[];await h.load(true)
    assert.equal(h.state.recovery,'error');assert.equal(typeof h.context.retry,'function')
  })
  test(file + ': a preparation exception releases the read lock and allows retry', async () => {
    const h=loaderFixture(file),getView=h.context.getConversationView;let first=true
    h.context.getConversationView=()=>{if(first){first=false;throw Error('view unavailable')}return getView()}
    await h.load(true);assert.equal(h.state.history.loading,false)
    const retry=h.load(true);h.resolve({events:[],hasMore:false});await retry
    assert.equal(h.state.recovery,'ready')
  })
  test(file + ': a completion signal during paging recovers the missing reply without reopening the session', async () => {
    const h=loaderFixture(file),source=fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),timers=[]
    h.context.setTimeout=run=>{timers.push(run);return timers.length}
    h.context.resyncCurrentSession=()=>h.load(true)
    const start=source.indexOf('function scheduleSessionSync('),end=source.indexOf('function sessionSyncTick(',start)
    vm.runInContext(source.slice(start,end),h.context)
    const paging=h.load(false)
    h.context.scheduleSessionSync('a');timers.shift()()
    assert.equal(h.calls.length,1,'the recovery signal must wait for the in-flight read')
    h.resolve({events:[],hasMore:false});await paging
    timers.shift()()
    assert.equal(h.calls.length,2);assert.equal(h.calls[1].beforeSeq,undefined,'recovery must read the tail rather than another older page')
    h.resolve({events:[{event:{seq:20,type:'assistant/message',data:{content:[{type:'text',text:'Reply already generated on DSH'}]}}}],hasMore:false})
    await new Promise(setImmediate)
    assert.equal(h.state.history.visible.at(-1).event.data.content[0].text,'Reply already generated on DSH')
    assert.equal(h.state.history.loading,false)
  })
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
    const later = h.load(false)
    assert.equal(h.calls.length, before + 1, 'a later page request must still reach the host: ' + file)
    h.resolve({ events: [], hasMore: false }); await later
  })
}
