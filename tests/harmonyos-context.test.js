'use strict'
// Run the production ArkTS controller methods with Node's built-in type erasure.
// This verifies request/timer behavior, not ArkUI rendering or device lifecycle delivery.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const root = path.join(__dirname, '../harmonyos/entry/src/main/ets')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  assert.ok(first >= 0 && last > first, `Missing production section: ${start}`)
  return source.slice(first, last)
}
const appSource = read('services/AppState.ets')
const connectionMethods = section(appSource, '  connectionContext()', '  servers:')
  + section(appSource, '  private applyActiveServer(', '  private startRealtime(')
function server(id = 'A', url = `http://fixture-${id}`, token = `fixture-token-${id}`) {
  return { id, token, normalizedUrl: () => url }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
function environment(api = {}) {
  const timers = new Map(), calls = [], storage = new Map()
  let timerId = 0
  const context = vm.createContext({
    I18n: { t: text => text }, Logger: { warn() {} }, Edge: { Bottom: 'bottom' },
    Constants: { STEER_HOLD_MS: 450, STEER_SLOW_MS: 3000 },
    TouchType: { Down: 0, Move: 1, Up: 2, Cancel: 3 },
    util: { generateRandomUUID: () => 'fixture-operation-id' },
    AppStorage: { setOrCreate: (key, value) => storage.set(key, value) },
    GatewayApi: {
      rpc: async (base, token, method, payload) => { calls.push({ base, token, method, payload }); return { accepted: true } },
      pluginsState: async () => ({ revision: 'same-revision', writable: true }),
      pluginsOperations: async (base, token, body) => { calls.push({ base, token, body }); return { ok: true } },
      ...api,
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout: id => timers.delete(id),
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearInterval: id => timers.delete(id),
  })
  function run(code) { vm.runInContext(stripTypeScriptTypes(code), context) }
  run(`class Connection {
    constructor() { this.server=null; this.servers=[]; this.connectionGeneration=0 }
    refreshHealth() {} refreshSessions() {} startRealtime() {}
    putHandoff() {} discardEmptySession() {}
    ${connectionMethods}
  }
  globalThis.app = new Connection()`)
  const app = context.app
  function select(value) { app.servers = value ? [value] : []; app.applyActiveServer(value?.id ?? '', false) }
  select(server())
  function fire(ms) {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() }
  }
  return { context, run, app, select, timers, calls, storage, fire }
}
const pluginSource = read('pages/PluginCenterPage.ets')
function plugins(api) {
  const h = environment(api)
  h.run(pluginSource.slice(0, pluginSource.indexOf('@Component')).replace(/^import .*\r?\n/gm, '').replace(/export /g, ''))
  const methods = section(pluginSource, '  private bindingContext()', '  private surface()')
    + section(pluginSource, '  aboutToAppear()', '  /** 详情页安装/更新按钮')
  h.run(`class Controller {
    constructor(app) {
      this.appState=app; this.pageActive=true; this.pageGeneration=0;
      this.stateSeq=0; this.stateAppliedSeq=0; this.searchSeq=0; this.detailSeq=0; this.pollTimer=-1;
      this.tab='installed'; this.marketQuery=''; this.pendingMutation=false;
      this.confirmInfo=null; this.detail=null; this.items=[]; this.jobs=[];
      this.pcMessage=''; this.pcMsgError=false;
      this.revision='same-revision'; this.writable=true; this.busy=false;
      this.stateContext=this.bindingContext();
    }
    ${methods}
  }
  globalThis.controller = new Controller(app)`)
  h.c = h.context.controller
  h.switch = value => { h.select(value); h.c.onConnectionChanged() }
  return h
}
const chatSource = read('pages/ChatView.ets')
function chat(api) {
  const h = environment(api)
  const methods = section(chatSource, '  private composerContext()', '  private loadSteerPrefs()')
    + section(chatSource, '  private async submitSteer(', '  /** 绑定会话')
    + section(chatSource, '  aboutToDisappear()', '  /** 打开重命名')
    + section(chatSource, '  private async send(', '  /** 拍照发图')
  h.run(`class Controller {
    constructor(app) {
      this.appState=app; this.sessionId='session-A'; this.composerGeneration=0;
      this.composerActive=true; this.running=true; this.steerEnabled=true;
      this.busySendMode='queue'; this.inputText='fixture draft'; this.attachments=[];
      this.sending=false; this.steeringInFlight=new Set(); this.steerSlowTimer=-1;
      this.steerFeedback=''; this.steerFeedbackMsg=''; this.pendingNote='';
      this.holdTimer=-1; this.holdCancelled=false; this.pressActive=false; this.pressGeneration=0;
      this.holdReady=false; this.suppressClickUntil=0; this.scroller={scrollEdge(){}};
    }
    attachSession() {} loadSteerPrefs() {} async trySlashCommand() { return false }
    ${methods}
  }
  globalThis.controller = new Controller(app)`)
  h.c = h.context.controller
  h.switch = value => { h.select(value); h.c.onConnectionChanged() }
  h.touch = (type, x = 0, y = 0) => h.c.onSendTouch({ type, touches: type === 0 || type === 1 ? [{ windowX: x, windowY: y }] : [] })
  return h
}

test('Harmony connection generation distinguishes A→B→A and same-id URL/token replacements', () => {
  const h = environment(), first = h.app.connectionContext()
  h.select(server('B')); h.select(server())
  assert.notEqual(h.app.connectionContext(), first)
  assert.equal(h.storage.get('connectionGeneration'), 3)
  const current = h.app.connectionContext()
  h.app.server = server('A', 'http://changed', 'fixture-token-A')
  assert.notEqual(h.app.connectionContext(), current)
  h.app.server = server('A', 'http://fixture-A', 'changed-token')
  assert.notEqual(h.app.connectionContext(), current)
})

for (const variation of ['switch', 'ABA', 'url', 'token', 'disappear']) {
  test(`Harmony plugin confirmation cannot cross ${variation}`, async () => {
    const h = plugins()
    h.c.mutate('remove', 'example-plugin', '')
    const info = h.c.confirmInfo
    assert.ok(info)
    if (variation === 'switch') h.select(server('B'))
    if (variation === 'ABA') { h.select(server('B')); h.select(server()) }
    if (variation === 'url') h.app.server = server('A', 'http://changed')
    if (variation === 'token') h.app.server = server('A', 'http://fixture-A', 'changed-token')
    if (variation === 'disappear') h.c.aboutToDisappear()
    // Even before ArkUI dispatches Watch, submission must verify the origin.
    h.c.confirmInfo = info
    await h.c.executeMutation()
    assert.equal(h.calls.length, 0)
    assert.equal(h.c.confirmInfo, null)
  })
}

test('Harmony plugin retry on the original connection retains id and revision', async () => {
  const requests = []
  const h = plugins({ pluginsOperations: async (base, token, body) => {
    requests.push({ base, id: body.id, revision: body.revision })
    if (requests.length === 1) throw new Error('fixture timeout')
  } })
  h.c.mutate('disable', 'example-plugin', '')
  await h.c.executeMutation(); await tick()
  assert.ok(h.c.confirmInfo)
  await h.c.executeMutation()
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[0].base, 'http://fixture-A')
  assert.equal(h.c.confirmInfo, null)
})

test('Harmony plugin change clears snapshots and prevents arming from old revision', async () => {
  const d = deferred(), h = plugins({ pluginsState: () => d.promise })
  h.c.items = [{ name: 'old-plugin' }]; h.c.detail = { name: 'old-plugin' }
  h.c.mutate('remove', 'old-plugin', '')
  h.switch(server('B'))
  assert.equal(h.c.items.length, 0); assert.equal(h.c.detail, null)
  assert.equal(h.c.confirmInfo, null); assert.equal(h.c.writable, false)
  h.c.mutate('remove', 'old-plugin', '')
  assert.equal(h.c.confirmInfo, null)
  d.resolve({ revision: 'same-revision', writable: true }); await tick()
  h.c.mutate('disable', 'new-plugin', '')
  await h.c.executeMutation()
  assert.equal(h.calls[0].base, 'http://fixture-B')
})

test('Harmony plugin old state/market/details/error responses are discarded after ABA or exit', async () => {
  for (const request of ['state', 'market', 'details']) for (const reject of [false, true]) {
    const d = deferred(), h = plugins({ pluginsState: () => d.promise, pluginsMarket: () => d.promise, pluginsDetails: () => d.promise })
    h.c.tab = 'market'
    const pending = request === 'state' ? h.c.refreshState() : request === 'market' ? h.c.search() : h.c.showDetails('old-plugin', '')
    h.select(server('B')); h.select(server())
    h.c.pcMessage = 'new message'
    if (reject) d.reject(new Error('old error'))
    else d.resolve({ profile: 'old profile', revision: 'old revision', items: [{ name: 'old-plugin' }], item: { name: 'old-plugin' } })
    await pending
    assert.equal(h.c.pcMessage, 'new message')
    assert.equal(h.c.items.length, 0)
    assert.equal(h.c.marketItems?.length ?? 0, 0)
    assert.equal(h.c.detail, null)
  }
  const d = deferred(), h = plugins({ pluginsState: () => d.promise })
  const pending = h.c.refreshState(); h.c.aboutToDisappear()
  d.resolve({ writable: true, revision: 'old' }); await pending
  assert.equal(h.c.writable, false)
})

test('Harmony plugin old completion cannot clear a new in-flight operation', async () => {
  const old = deferred(), newer = deferred()
  const h = plugins({ pluginsOperations: base => base.endsWith('A') ? old.promise : newer.promise })
  h.c.mutate('disable', 'old-plugin', '')
  const first = h.c.executeMutation()
  h.switch(server('B')); await tick()
  h.c.mutate('enable', 'new-plugin', '')
  const second = h.c.executeMutation(), info = h.c.confirmInfo
  old.resolve({ ok: true }); await first
  assert.equal(h.c.pendingMutation, true); assert.equal(h.c.confirmInfo, info)
  assert.notEqual(h.c.pcMessage, '已受理，可在操作记录查看结果。')
  newer.resolve({ ok: true }); await second
  assert.equal(h.c.pendingMutation, false)
})

test('Harmony plugin polling accepts slow responses but never overwrites a newer result', async () => {
  for (const newerFirst of [false, true]) {
    const first = deferred(), second = deferred()
    let count = 0
    const h = plugins({ pluginsState: () => ++count === 1 ? first.promise : second.promise })
    const a = h.c.refreshState(), b = h.c.refreshState()
    if (newerFirst) {
      second.resolve({ revision: 'new' }); await b
      first.resolve({ revision: 'old' }); await a
      assert.equal(h.c.revision, 'new')
    } else {
      first.resolve({ revision: 'old' }); await a
      assert.equal(h.c.revision, 'old', 'An outstanding later poll must not starve slow responses')
      second.resolve({ revision: 'new' }); await b
      assert.equal(h.c.revision, 'new')
    }
  }
})

for (const enabled of [false, true]) for (const variation of ['switch', 'ABA', 'url', 'token', 'session', 'disappear']) {
  test(`Harmony ${enabled ? 'long press' : 'ordinary press'} cancels on ${variation}`, async () => {
    const h = chat(); h.c.steerEnabled = enabled
    h.touch(0); h.fire(450)
    if (variation === 'switch') h.select(server('B'))
    if (variation === 'ABA') { h.select(server('B')); h.select(server()) }
    if (variation === 'url') h.app.server = server('A', 'http://changed')
    if (variation === 'token') h.app.server = server('A', 'http://fixture-A', 'changed-token')
    if (variation === 'session') h.c.sessionId = 'session-B'
    if (variation === 'disappear') h.c.aboutToDisappear()
    h.touch(2); await tick()
    assert.equal(h.calls.length, 0)
    assert.equal(h.c.inputText, 'fixture draft')
    assert.equal(h.c.pressActive, false); assert.equal(h.timers.size, 0)
  })
}

test('Harmony gestures preserve tap, alternate long press, idle/off, movement and cancel behavior', async () => {
  for (const variant of ['tap', 'long', 'reverse', 'idle', 'off', 'move', 'cancel', 'no-down']) {
    const h = chat()
    if (variant === 'reverse') h.c.busySendMode = 'steer'
    if (variant === 'idle') h.c.running = false
    if (variant === 'off') h.c.steerEnabled = false
    if (variant !== 'no-down') h.touch(0)
    if (variant !== 'tap') h.fire(450)
    if (variant === 'move') h.touch(1, 30)
    if (variant === 'cancel') h.touch(3)
    h.touch(2); h.touch(2); await tick()
    if (['move', 'cancel', 'no-down'].includes(variant)) assert.equal(h.calls.length, 0)
    else {
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0].payload.mode, variant === 'long' ? 'steer' : 'queue')
    }
  }
})

test('Harmony cancelled press timer cannot arm a subsequent press early', async () => {
  const h = chat()
  h.touch(0)
  const oldTimer = [...h.timers.values()][0].fn
  h.touch(3); h.touch(0)
  const newTimer = h.c.holdTimer
  oldTimer()
  assert.equal(h.c.holdReady, false); assert.equal(h.c.holdTimer, newTimer)
  h.touch(2); await tick()
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.mode, 'queue')
})

test('Harmony steer retains normal success, unconfirmed/rejection and edited draft behavior', async () => {
  for (const outcome of ['accepted', 'unconfirmed', 'rejected', 'timeout', 'edited', 'slash']) {
    const d = deferred(), calls = []
    const h = chat({ rpc: (...args) => { calls.push(args); return d.promise } })
    if (outcome === 'slash') h.c.inputText='/fixture'
    const pending = h.c.send(true)
    if (outcome === 'slash') {
      await pending; assert.equal(calls.length, 0); assert.equal(h.c.steerFeedback, 'error')
      continue
    }
    assert.equal(calls.length, 1); assert.equal(calls[0][3].mode, 'steer')
    h.fire(3000); assert.equal(h.c.steerFeedback, 'slow')
    if (outcome === 'edited') h.c.inputText='edited draft'
    if (outcome === 'rejected') d.reject(Object.assign(new Error('fixture rejection'), { rpcRejected: true }))
    else if (outcome === 'timeout') d.reject(new Error('fixture timeout'))
    else d.resolve(outcome === 'unconfirmed' ? {} : { accepted: true })
    await pending
    assert.equal(calls.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.c.sending, false)
    assert.equal(h.c.steerFeedback, outcome === 'rejected' ? 'error' : ['timeout', 'unconfirmed'].includes(outcome) ? 'unknown' : 'accepted')
    assert.equal(h.c.inputText, outcome === 'edited' ? 'edited draft' : outcome === 'accepted' ? '' : 'fixture draft')
  }
})

for (const outcome of ['accepted', 'unconfirmed', 'rejected', 'timeout']) {
  test(`Harmony stale steer ${outcome} and slow timer cannot affect a new request`, async () => {
    const old = deferred(), newer = deferred()
    const h = chat({ rpc: base => base.endsWith('A') ? old.promise : newer.promise })
    const first = h.c.send(true)
    const oldTimer = [...h.timers.values()][0].fn
    h.switch(server('B'))
    h.c.inputText = 'new draft'
    const second = h.c.send(true), newTimer = h.c.steerSlowTimer
    oldTimer()
    assert.equal(h.c.steerFeedback, 'pending')
    if (outcome === 'accepted') old.resolve({ accepted: true })
    if (outcome === 'unconfirmed') old.resolve({})
    if (outcome === 'rejected') old.reject(Object.assign(new Error('old rejection'), { rpcRejected: true }))
    if (outcome === 'timeout') old.reject(new Error('old timeout'))
    await first
    assert.equal(h.c.steerFeedback, 'pending'); assert.equal(h.c.sending, true)
    assert.equal(h.c.inputText, 'new draft'); assert.ok(h.timers.has(newTimer))
    h.fire(3000); assert.equal(h.c.steerFeedback, 'slow')
    newer.resolve({ accepted: true }); await second
    assert.equal(h.c.steerFeedback, 'accepted'); assert.equal(h.c.inputText, '')
    assert.equal(h.c.sending, false); assert.equal(h.timers.size, 0)
  })
}

test('Harmony steer completion after exit/reentry or session ABA stays invalid', async () => {
  for (const change of ['page', 'session', 'connection']) {
    const d = deferred(), h = chat({ rpc: () => d.promise })
    const sending = h.c.send(true)
    if (change === 'page') { h.c.aboutToDisappear(); h.c.aboutToAppear() }
    if (change === 'session') { h.c.sessionId='session-B'; h.c.onSessionIdChange(); h.c.sessionId='session-A'; h.c.onSessionIdChange() }
    if (change === 'connection') { h.select(server('B')); h.select(server()) }
    h.c.steerFeedback=''; h.c.inputText='new draft'
    h.fire(3000); d.resolve({ accepted: true }); await sending
    assert.equal(h.c.steerFeedback, ''); assert.equal(h.c.inputText, 'new draft')
  }
})

test('Harmony queue/command late completion cannot clear another connection draft or send fallback', async () => {
  for (const slash of [false, true]) {
    const d = deferred(), h = chat({ rpc: () => d.promise })
    if (slash) { h.c.inputText='/fixture'; h.c.trySlashCommand=()=>d.promise }
    const pending = h.c.send(false)
    h.switch(server('B')); h.c.inputText='new draft'; h.c.sending=true
    d.resolve(slash ? false : { accepted: true }); await pending
    assert.equal(h.c.inputText, 'new draft'); assert.equal(h.c.sending, true)
    assert.equal(h.calls.length, 0)
  }
})
