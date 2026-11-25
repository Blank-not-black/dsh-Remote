'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8')
test('background startup failures are reported instead of claiming the receiver is running',()=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{checked:true,value:'0.5',options:[],textContent:'',classList:{toggle(){},add(){}},removeAttribute(){}});return nodes.get(id)}
 const c=vm.createContext({$:get,state:{server:'http://fixture',token:'fixture'},location:{origin:'http://fixture'},CLIENT_ID:'test',window:{NativeBackground:{saveBackgroundConfig:()=>false,getBackgroundConfig:()=>JSON.stringify({enabled:true,serviceRunning:false,serviceState:'start-failed',notifyTaskDone:true})}},I18N:{lang:'zh'},t:k=>k,syncCustomSelect(){}})
 vm.runInContext(source.slice(source.indexOf('function bgBridge()'),source.indexOf('/* ---------------- 预设提示词')),c)
 assert.equal(c.saveBgConfig(true),false);c.applyBgConfigFromNative();assert.match(get('bg-auth-status').textContent,/未运行|start-failed/)
 c.window.NativeBackground.getBackgroundConfig=()=>JSON.stringify({enabled:true,loginExpired:true});c.applyBgConfigFromNative();assert.equal(get('bg-auth-status').textContent,'settings.bgAuthFailed')
})
test('native receiver restores enabled settings at foreground entry and hands off before WebView pause',()=>{
 const activity=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/MainActivity.java'),'utf8'),service=fs.readFileSync(path.join(__dirname,'../android/app/src/main/java/com/dshremote/app/RemotePollService.java'),'utf8')
 assert.match(activity,/public void onStart\(\)[\s\S]*?RemotePollService.restoreIfEnabled/)
 assert.match(activity,/public void onPause\(\)[\s\S]*?RemotePollService.restoreIfEnabled[\s\S]*?super.onPause/)
 assert.match(service,/getBoolean\(KEY_LOGIN_EXPIRED, false\)/);assert.match(service,/onTimeout\(int startId, int foregroundServiceType\)/)
 assert.match(service,/if \(stopped \|\| !prefs.getBoolean\(KEY_ENABLED/)
})

test('Android replaces stale realtime sockets once after backgrounding and preserves fallback poll cursors', async () => {
  const listeners = {}, appListeners = {}, sockets = [], ticketRequests = [], probes = [], timers = new Set()
  const polls = []
  let supportsContinuity = false
  const state = { server: 'https://relay.test', token: 'fixture', servers: [], streamMode: 'ws' }
  class WebSocket {
    static OPEN = 1
    static CONNECTING = 0
    constructor(url) { this.url = url; this.readyState = WebSocket.CONNECTING; sockets.push(this) }
    close() { this.readyState = 3 }
  }
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn },
    body: { classList: { toggle() {} } }, querySelector: () => null }
  let historyReads = 0
  const c = vm.createContext({
    state, document, WebSocket, AbortSignal, AbortController, crypto: require('node:crypto').webcrypto,
    CLIENT_ID: '', navigator: { onLine: true },
    CAP: { isNativePlatform: () => true, Plugins: { App: { addListener: (name, fn) => { appListeners[name] = fn } } } },
    window: {
      addEventListener: (name, fn) => { listeners[name] = fn }, scrollTo() {},
      DshNetwork: { PollLoop: class {
        tick() { polls.push(this) }
        stop() { this.stopped = true }
      } }
    },
    captureConnection: () => ({ token: state.token, valid: () => true }), apiUrl: route => state.server + route,
    $: () => ({ classList: { contains: () => false } }), clientIdHeaders: () => ({}),
    activeGatewayCapability: name => name === 'streamContinuity' ? supportsContinuity : true, connectionHealthProbe: null,
    refreshConnectionHealth() {}, applyNativeInsets() {}, updateConn() {}, openPendingNavigation() {},
    repairMissingStreams() {}, setInterval: () => 1, setTimeout(fn) { timers.add(fn); return fn },
    clearTimeout: fn => timers.delete(fn), clearInterval() {}, onMuxFrame() {}, onHostFrame() {},
    recoverSessionHistory: () => { historyReads++ },
    fetch: url => {
      if (url.includes('wsProbe=')) { probes.push(new URL(url)); return Promise.resolve({ status: 204 }) }
      return new Promise(resolve => ticketRequests.push(ticket => resolve({ ok: true, json: async () => ({ ticket, expiresAt: 1 }) })))
    }
  })
  const streamsStart = source.indexOf('const streams = {}')
  const pageshow = source.indexOf("window.addEventListener('pageshow', onResume)", streamsStart)
  vm.runInContext(source.slice(streamsStart, source.indexOf('\n', pageshow)), c)
  for (const [start, end] of [['let wsTicketPromise = null', 'function updateBase()'], ['function bindNativeBack()', '\n}']]) {
    const from = source.indexOf(start)
    const to = source.indexOf(end, from) + (end === '\n}' ? 2 : 0)
    vm.runInContext(source.slice(from, to), c)
  }
  c.bindNativeBack()
  c.openStreams()
  assert.equal(ticketRequests.length, 1)
  ticketRequests.shift()('initial')
  await new Promise(setImmediate)
  const [oldMux, oldHost] = sockets
  oldMux.readyState = oldHost.readyState = WebSocket.OPEN

  // A ticket request started before suspension may still be pending on return.
  const oldTicket = c.getWsTicket()
  const settleOldTicket = ticketRequests.shift()
  document.visibilityState = 'hidden'
  listeners.visibilitychange()
  appListeners.appStateChange({ isActive: false })
  appListeners.appStateChange({ isActive: true })
  assert.equal(oldMux.readyState, WebSocket.OPEN, 'wait until the WebView is visible')
  document.visibilityState = 'visible'
  listeners.visibilitychange()
  assert.equal(oldMux.readyState, 3, 'a half-open mux must be retired')
  assert.equal(oldHost.readyState, 3, 'a half-open host stream must be retired')
  assert.equal(ticketRequests.length, 1, 'resume must issue a fresh request even with an old ticket pending')
  assert.ok(historyReads > 0)
  listeners.pageshow()
  appListeners.appStateChange({ isActive: true })
  assert.equal(ticketRequests.length, 1, 'overlapping foreground events share one ticket request')
  ticketRequests.shift()('foreground')
  await new Promise(setImmediate)
  assert.equal(sockets.length, 4)
  assert.ok(sockets.slice(2).every(socket => new URL(socket.url).searchParams.get('ticket') === 'foreground'))
  settleOldTicket('stale')
  await assert.rejects(oldTicket, /stale ws ticket/)
  assert.equal(state.wsTicket.value, 'foreground')
  oldMux.onclose({ code: 1006 })
  assert.equal(sockets.length, 4, 'a delayed close on the old socket cannot disturb the replacement')

  state.streamMode = 'poll'
  state.pollSeq = { mux: 7, host: 13, muxEpoch: 'previous' }
  c.startPolling()
  appListeners.appStateChange({ isActive: false })
  appListeners.appStateChange({ isActive: true })
  assert.equal(polls.length, 2, 'the foreground poll starts without waiting for the old request')
  assert.equal(polls[0].stopped, true)
  assert.notEqual(polls[0], polls[1])
  assert.deepEqual(state.pollSeq, { mux: 7, host: 13, muxEpoch: 'previous' })
  ticketRequests.shift()('after-poll')
  await new Promise(setImmediate)

  supportsContinuity = true
  state.streamMode = 'ws'
  const [mux, host] = sockets.slice(-2)
  mux.readyState = host.readyState = WebSocket.OPEN
  appListeners.appStateChange({ isActive: false })
  appListeners.appStateChange({ isActive: true })
  assert.equal(mux.readyState, WebSocket.OPEN)
  assert.equal(host.readyState, 3)
  assert.equal(probes[0].searchParams.get('stream'), new URL(mux.url).searchParams.get('stream'))
  mux.onmessage({ data: JSON.stringify({ type: 'relay/ws-probe', nonce: probes[0].searchParams.get('wsProbe') }) })
  assert.equal(timers.size, 0)
  assert.equal(mux.readyState, WebSocket.OPEN, 'acknowledgement keeps the original mux')
  ticketRequests.shift()('host-only')
  await new Promise(setImmediate)
  assert.equal(sockets.at(-1).url.includes('/api/events.host?'), true)

  appListeners.appStateChange({ isActive: false })
  appListeners.appStateChange({ isActive: true })
  assert.equal(probes.length, 2)
  await new Promise(setImmediate)
  assert.equal(mux.readyState, WebSocket.OPEN, 'HTTP 204 did not prove the socket could receive')
  timers.values().next().value()
  assert.equal(mux.readyState, 3, 'the missing WebSocket acknowledgement retires a half-open mux')
  ticketRequests.shift()('replace-both')
  await new Promise(setImmediate)
  assert.ok(sockets.slice(-2).every(socket => new URL(socket.url).searchParams.get('ticket') === 'replace-both'))
})

test('foreground fallback polling resolves a delivered batch before its baseline and requests',async()=>{
 const calls=[],frame=(type,id)=>({rpcId:id,payload:{type,approvalId:id,sessionId:'S'}})
 const baseline=frame('approval/requested','closed'),requested=frame('approval/requested','closed'),resolved=frame('approval/resolved','closed')
 const bridge={handlePendingEvent:(_base,_token,json,enabled)=>calls.push({frame:JSON.parse(json),enabled})}
 const c=vm.createContext({state:{streamMode:'poll',token:'fixture',pollSeq:{mux:10}},CAP:null,AbortSignal,
  window:{NativeBackground:bridge},captureConnection:()=>({valid:()=>true}),clientIdHeaders:()=>({}),apiUrl:value=>value,bgBase:()=> 'http://fixture',
  fetch:async()=>({ok:true,status:200,json:async()=>({latestSeq:13,baseline:[baseline],events:[{seq:5,event:frame('approval/resolved','old')},{seq:11,event:requested},{seq:12,event:resolved},{seq:13,event:frame('approval/requested','open')}]})}),
  onMuxFrame:value=>bridge.handlePendingEvent('http://fixture','fixture',JSON.stringify(value),true),onHostFrame(){},renderPending(){},scheduleRefresh(){},updateConn(){}})
 const start=source.indexOf('async function pollKind('),end=source.indexOf('\nfunction tryRestoreWs(',start)
 vm.runInContext(source.slice(start,end),c);await c.pollKind('mux')
 assert.equal(calls[0].frame.payload.type,'approval/resolved');assert.equal(calls[0].frame.payload.approvalId,'closed');assert.equal(calls[0].enabled,false)
 assert.equal(calls.some(value=>value.frame.payload.approvalId==='old'),false,'ignore resolutions below the active cursor')
 assert.equal(calls[1].frame.payload.type,'approval/requested');assert.equal(c.state.pollSeq.mux,13)
 assert.equal(c.state.pollSeq.muxReady,true)
})
