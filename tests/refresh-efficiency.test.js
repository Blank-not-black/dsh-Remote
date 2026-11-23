'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const files=['public/app.js','public/desktop/desktop.js']
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8').replaceAll('\r\n','\n')
const section=(s,start)=>{const a=s.indexOf(start),b=s.indexOf('\n}',a);assert.ok(a>=0&&b>a,start);return s.slice(a,b+2)}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('mobile mux recovery schedules the active history immediately and coalesces rapid reconnects', () => {
  const state = { current: 'fixture', lastStreamResyncAt: 0 }, calls = []
  const context = vm.createContext({ state, Date: { now: () => 10000 }, scheduleSessionSync: (...args) => calls.push(args) })
  vm.runInContext(section(read(files[0]), 'function resyncAfterStreamOpen('), context)
  context.resyncAfterStreamOpen()
  context.resyncAfterStreamOpen()
  assert.deepEqual(calls, [['fixture', 0]])
})
test('mobile authentication errors keep the current page and only notify once until recovery', async () => {
  const source = read(files[0])
  const notices = []
  const badgeUpdates = []
  let generation = 0
  let rpc = async () => { throw new Error('AUTH') }
  const context = vm.createContext({
    rpc: (...args) => rpc(...args),
    captureConnection: () => {
      const captured = generation
      return { valid: () => captured === generation }
    },
    t: key => key,
    toast: message => notices.push(message),
    updateConn: () => badgeUpdates.push(context.activeConnectionIssue()),
    showView: () => assert.fail('An auth error replaced the active page'),
  })
  const start = source.indexOf('let connectionIssue = null')
  vm.runInContext(source.slice(start, source.indexOf('function newServerId(', start)), context)
  vm.runInContext(section(source, 'async function safeRpc('), context)

  assert.equal(await context.safeRpc('session.list', {}), null)
  assert.equal(await context.safeRpc('session.list', {}), null)
  assert.deepEqual(notices, ['conn.authNotice'])
  assert.deepEqual(badgeUpdates, [401])

  const stale = deferred()
  rpc = () => stale.promise
  const formerRequest = context.safeRpc('session.list', {})
  generation++
  assert.equal(context.activeConnectionIssue(), null)
  stale.resolve(Promise.reject(new Error('AUTH')))
  assert.equal(await formerRequest, null)
  assert.deepEqual(badgeUpdates, [401])

  rpc = async () => { throw Object.assign(new Error('HTTP 426'), { status: 426 }) }
  assert.equal(await context.safeRpc('session.list', {}), null)
  assert.deepEqual(notices, ['conn.authNotice', 'conn.pairingNotice'])
  assert.equal(context.activeConnectionIssue(), 426)

  const sessions = { items: [] }
  rpc = async () => sessions
  assert.equal(await context.safeRpc('session.list', {}), sessions)
  assert.deepEqual(badgeUpdates, [401, 426, null])
})

for(const file of files){
 test(file+': concurrent subagent queries share one RPC, then refresh normally',async()=>{
  const s=read(file),state={server:'A',token:'one'},jobs=[],calls=[]
  const c=vm.createContext({state,captureConnection:()=>{const {server,token}=state;return {valid:()=>state.server===server&&state.token===token}},rpc:(method,payload)=>{calls.push(payload);const j=deferred();jobs.push(j);return j.promise}})
  vm.runInContext('let sessionSubagentsJob=null;'+section(s,'async function loadSessionSubagents('),c)
  const all=Array.from({length:30},()=>c.loadSessionSubagents('same'));assert.equal(calls.length,1)
  jobs[0].resolve({entries:[{id:'child'}]});assert.ok((await Promise.all(all)).every(value=>value.entries[0].id==='child'))
  const next=c.loadSessionSubagents('same');assert.equal(calls.length,2);jobs[1].resolve({entries:[]});await next
 })
 test(file+': old subagent requests cannot block or clear the new connection request',async()=>{
  const s=read(file),state={server:'A',token:'one'},jobs=[]
  const c=vm.createContext({state,captureConnection:()=>{const {server,token}=state;return {valid:()=>state.server===server&&state.token===token}},rpc:()=>{const j=deferred();jobs.push(j);return j.promise}})
  vm.runInContext('let sessionSubagentsJob=null;'+section(s,'async function loadSessionSubagents('),c)
  const old=c.loadSessionSubagents('same');state.server='B';const current=c.loadSessionSubagents('same');assert.equal(jobs.length,2)
  jobs[0].resolve({entries:[{id:'A'}]});assert.equal(await old,null)
  const shared=c.loadSessionSubagents('same');assert.equal(jobs.length,2);jobs[1].resolve({entries:[{id:'B'}]})
  assert.equal((await current).entries[0].id,'B');assert.equal((await shared).entries[0].id,'B')
 })
 test(file+': event refresh bursts coalesce without postponing the first deadline',()=>{
  const s=read(file),timers=new Map(),calls=[],state={server:'A',refreshTimer:null};let seq=0
  const c=vm.createContext({state,captureConnection:()=>{const server=state.server;return {valid:()=>state.server===server}},
   setTimeout:(fn,delay)=>{const id=++seq;timers.set(id,{fn,delay});return id},clearTimeout:id=>timers.delete(id),refreshAll:()=>calls.push('refresh'),refreshSessions:()=>calls.push('refresh')})
  const name=file.includes('desktop')?'scheduleSessionsRefresh':'scheduleRefresh'
  vm.runInContext(section(s,'function '+name+'('),c)
  c[name]();const first=[...timers.values()][0];for(let i=0;i<100;i++)c[name]()
  assert.equal(timers.size,1);assert.equal([...timers.values()][0],first);first.fn();assert.deepEqual(calls,['refresh'])
  timers.clear();c[name]();state.server='B';[...timers.values()][0].fn();assert.equal(calls.length,1)
 })
 test(file+': late poll bodies and auth errors cannot update a new connection or restored WS',async()=>{
  const s=read(file)
  for(const switched of ['connection','ws'])for(const response of ['auth','events']){
   const state={server:'A',token:'one',streamMode:'poll',pollSeq:{mux:0,host:0}},job=deferred(),calls=[]
   const c=vm.createContext({state,AbortSignal,window:{},CAP:null,clientIdHeaders:()=>({}),apiUrl:p=>state.server+p,
    captureConnection:()=>{const {server,token}=state;return {valid:()=>state.server===server&&state.token===token}},fetch:()=>job.promise,
    authFailure:()=>calls.push('auth'),toast:()=>calls.push('auth'),t:x=>x,onMuxFrame:()=>calls.push('frame')})
   vm.runInContext(section(s,'async function pollKind('),c)
   const p=c.pollKind('mux');if(switched==='connection')state.server='B';else state.streamMode='ws'
   job.resolve(response==='auth'?{status:401}:{status:200,ok:true,json:async()=>({events:[{seq:2,event:{}}]})});await p
   assert.equal(state.pollSeq.mux,0);assert.equal(calls.length,0)
  }
 })
 test(file+': a new host begins polling immediately and old completion cannot unlock its pending batch',async()=>{
  const s=read(file),state={server:'A',token:'one',streamMode:'poll',pollSeq:{}},jobs=[]
  const Network=require('../public/network.js')
  class TestLoop extends Network.PollLoop { constructor(opts){super({...opts,setTimer:()=>1,clearTimer(){}})} }
  const c=vm.createContext({state,AbortController,window:{DshNetwork:{PollLoop:TestLoop}},captureConnection:()=>{const server=state.server;return {valid:()=>state.server===server}},pollKind:(kind,signal)=>{const j=deferred();jobs.push({...j,signal});return j.promise}})
  vm.runInContext('let pollInFlight=null;'+section(s,'async function pollOnce('),c)
  const old=c.pollOnce();assert.equal(jobs.length,2);await c.pollOnce();assert.equal(jobs.length,2)
  state.server='B';state.pollSeq={};const current=c.pollOnce();assert.equal(jobs.length,4);assert.equal(jobs[0].signal.aborted,true)
  jobs[0].resolve();jobs[1].resolve();await old;await c.pollOnce();assert.equal(jobs.length,4)
  jobs[2].resolve();jobs[3].resolve();await current
 })
}
