'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')
function cut(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,start);return source.slice(a,b)}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
for(const file of ['public/app.js','public/desktop/desktop.js']){
 const source=read(file)
 test(file+': a stalled ticket response body times out and cannot pin every reconnect attempt',async()=>{
  const timers=[],netContext=vm.createContext({module:{exports:{}},AbortController,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){}})
  vm.runInContext(read('public/network.js'),netContext)
  const stalled=deferred(),state={token:'test',server:'http://fixture',wsTicket:{value:''}};let calls=0
  const c=vm.createContext({state,Date,CAP:null,apiUrl:x=>x,clientIdHeaders:()=>({}),captureConnection:()=>({valid:()=>true}),activeGatewayCapability:()=>true,AbortSignal,DshNetwork:netContext.module.exports,
   fetch:async()=>({ok:true,json:()=>++calls===1?stalled.promise:Promise.resolve({ticket:'after-restart',expiresAt:Date.now()+90000})})})
  vm.runInContext(cut(source,'let wsTicketPromise = null','async function rpc('),c)
  const first=c.getWsTicket();await settle()
  assert.equal(timers.length,1,'the whole handshake read needs a deadline, including JSON')
  assert.equal(timers[0].ms,8000);timers[0].fn();await assert.rejects(first,/timed out/)
  assert.equal(await c.getWsTicket(),'after-restart')
  stalled.resolve({ticket:'stale',expiresAt:Date.now()+90000});await settle()
  assert.equal(state.wsTicket.value,'after-restart')
 })
 test(file+': completed ticket requests are never reused for a new connection attempt',async()=>{
  const state={token:'test',server:'http://fixture',wsTicket:{token:'test',server:'http://fixture',value:'exhausted',expiresAt:Date.now()+90000}};let calls=0
  const c=vm.createContext({state,Date,CAP:null,apiUrl:x=>x,clientIdHeaders:()=>({}),captureConnection:()=>({valid:()=>true}),activeGatewayCapability:()=>true,AbortSignal,
   fetch:async()=>({ok:true,json:async()=>({ticket:'fresh-'+(++calls),expiresAt:Date.now()+90000})})})
  vm.runInContext(cut(source,'let wsTicketPromise = null','async function rpc('),c)
  assert.equal(await c.getWsTicket(),'fresh-1');assert.equal(await c.getWsTicket(),'fresh-2')
 })
 test(file+': a stalled long-poll body is released so the next gateway epoch can recover',async()=>{
  const timers=[],netContext=vm.createContext({module:{exports:{}},AbortController,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){}})
  vm.runInContext(read('public/network.js'),netContext)
  const stalled=deferred(),state={token:'test',server:'http://fixture',streamMode:'poll',pollSeq:{mux:0,host:0}};let reads=0
  const c=vm.createContext({state,window:{DshNetwork:netContext.module.exports},DshNetwork:netContext.module.exports,AbortSignal,CAP:null,captureConnection:()=>({valid:()=>true}),clientIdHeaders:()=>({}),apiUrl:x=>x,
   fetch:async()=>({ok:true,status:200,json:()=>++reads===1?stalled.promise:Promise.resolve({epoch:'new-gateway',events:[],waitSupported:true})})})
  vm.runInContext(cut(source,'async function pollKind(','function tryRestoreWs('),c)
  const first=c.pollKind('mux',new AbortController().signal);await settle()
  assert.equal(timers.length,1,'polling must bound JSON decoding as well as response headers')
  timers[0].fn();assert.equal(await first,undefined)
  assert.equal(await c.pollKind('mux',new AbortController().signal),100)
  stalled.resolve({epoch:'old-gateway',events:[]});await settle()
  assert.equal(state.pollSeq.muxEpoch,'new-gateway')
 })
 test(file+': local host metadata never overrides failed upstream health',async()=>{
  const health={upstreamReachable:false,upstreamOk:false},state={token:'test',hostInfo:null},desktop=file.includes('desktop/')
  const c=vm.createContext({state,captureConnection:()=>({valid:()=>true}),rpc:async()=>({home:'fixture'}),activeGatewayHealth:()=>health,$:()=>null,t:()=>'',renderOverview:()=>{},renderOverviewDesktop:()=>{},setTimeout:()=>1,clearTimeout:()=>{}})
  vm.runInContext(cut(source,'let hostDescribePromise',desktop?'function uuid':'function authFailure'),c)
  await c[desktop?'refreshHostDescriptionDesktop':'refreshHostDescription']();assert.equal(health.upstreamReachable,false)
 })
 test(file+': closing records the actual CloseEvent rather than nonexistent socket fields',()=>{
  const streams={},meta={mux:{generation:0,attempt:0,failures:0}},records=[]
  class Socket { static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0}close(){} }
  const c=vm.createContext({state:{server:'http://fixture',token:'test',servers:[],streamMode:'ws',streamsOk:{}},streams,streamMeta:meta,CAP:null,CLIENT_ID:'fixture',WebSocket:Socket,Date,Math,navigator:{onLine:true},
   closeStream:kind=>{meta[kind].generation++},streamIsCurrent:(kind,ws,g)=>streams[kind]===ws&&meta[kind].generation===g,clearStreamTimers(){},markStreamInfo:(_kind,value)=>records.push(value),aggregateStreamFailures(){},updateConn(){},setReconnect(){},clearStreamRetry(){},setTimeout:()=>1})
  vm.runInContext(cut(source,'function openStream(kind,','/* ---------------- 轮询降级模式'),c)
  c.openStream('mux',()=>{},true,false,'ticket');streams.mux.onclose({code:1008,reason:'invalid ticket'})
  assert.equal(records[0].lastCloseCode,1008);assert.equal(records[0].lastCloseReason,'invalid ticket')
 })
}
function controlFixture(){
 const source=read('public/app.js'),state={token:'A',server:'http://A'},rendered=[],jobs=[],nodes=new Map();let generation=1
 const c=vm.createContext({state,Date,AbortSignal,crypto:require('node:crypto').webcrypto,window:{},setTimeout:fn=>{queueMicrotask(fn);return 1},
  $:id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',classList:{add(){},remove(){}}});return nodes.get(id)},t:x=>x,
  captureConnection:()=>{const token=state.token,server=state.server,g=generation;return {token,server,valid:()=>g===generation&&token===state.token&&server===state.server}},
  adminApiUrl:p=>state.server+p,activeGatewayCapability:()=>true,fetch:(url,options)=>{const job=deferred();jobs.push({url,options,...job});return job.promise},
  renderDshControlStatus:x=>rendered.push(x),renderDshControlOperation:x=>rendered.push(x),dshControlButtonsBusy(){},toast(){},authFailure(){},dshControlStageText:()=>'',dshControlFailureText:()=>'',uuid:()=>require('node:crypto').randomUUID()})
 vm.runInContext('let dshControlPollPromise=null;'+cut(source,'async function readDshControlResponse','function renderDshControlStatus(')+cut(source,'async function loadDshControl()','function renderLangBtn('),c)
 return {c,state,jobs,rendered,switch(){generation++;state.token='B';state.server='http://B'}}
}
const response=(body,status=200)=>({status,ok:status>=200&&status<300,text:async()=>JSON.stringify(body)})
const settle=()=>new Promise(setImmediate)
test('Lifecycle status ignores the old server response after a switch',async()=>{
 const h=controlFixture(),p=h.c.loadDshControl();h.switch();h.jobs[0].resolve(response({ok:true,running:true,mainPid:111}));await p;assert.equal(h.rendered.length,0)
})
test('Lifecycle accepted POST cannot start a poll against the newly selected server',async()=>{
 const h=controlFixture(),p=h.c.controlDsh('restart');h.switch();h.jobs[0].resolve(response({accepted:true,operationId:'A-operation',done:false},202));await p;assert.equal(h.jobs.length,1)
})
test('Lifecycle polling retries only GET after gateway replacement and network failures',async()=>{
 const h=controlFixture(),p=h.c.pollDshControlOperation('known',{done:false,deadlineAt:Date.now()+30000});await settle();h.jobs[0].resolve(response({code:'OPERATION_NOT_FOUND'},404));await settle()
 h.jobs[1].resolve(Promise.reject(Error('temporary')));await settle();h.jobs[2].resolve(response({done:true,ok:true,operationId:'known'}));assert.equal((await p).ok,true)
 assert.equal(h.jobs.length,3);assert.ok(h.jobs.every(j=>!j.options.method||j.options.method==='GET'))
})
test('Lifecycle polling stops after switching away without contacting the new server',async()=>{
 const h=controlFixture(),p=h.c.pollDshControlOperation('known',{done:false,deadlineAt:Date.now()+30000});h.switch();await p;assert.equal(h.jobs.length,0)
})
test('Lost POST response looks up the same request ID and does not repeat the command',async()=>{
 const h=controlFixture(),p=h.c.controlDsh('restart');const requestId=JSON.parse(h.jobs[0].options.body).requestId
 h.jobs[0].resolve(Promise.reject(Error('lost response')));await settle()
 assert.equal(h.jobs[1].url,'http://A/admin/api/dsh?operation='+requestId)
 h.jobs[1].resolve(response({operationId:requestId,done:true,ok:true}));await p
 assert.equal(h.jobs.filter(j=>j.options.method==='POST').length,1)
})
test('Repeated control clicks before the first POST responds share the busy guard',async()=>{
 const h=controlFixture(),p=h.c.controlDsh('restart');await h.c.controlDsh('restart');assert.equal(h.jobs.length,1)
 h.switch();h.jobs[0].resolve(response({accepted:true,operationId:'old'},202));await p
})
test('A completed durable receipt stays successful even after its execution deadline',async()=>{
 const h=controlFixture(),result=await h.c.pollDshControlOperation('known',{operationId:'known',done:true,ok:true,deadlineAt:Date.now()-10000})
 assert.equal(result.ok,true);assert.equal(h.jobs.length,0)
})
