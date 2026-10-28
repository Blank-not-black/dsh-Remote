'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto')
const {createRealisticStack}=require('./fixtures/realistic-stack.cjs')
const source=fs.readFileSync(path.join(__dirname,'../gateway.js'),'utf8')
async function settled(s,id){
  for(let i=0;i<50;i++){
    const r=await fetch(s.base+'/api/operations?id='+id,{headers:{authorization:'Bearer '+s.token}})
    const body=await r.json()
    if(body.phase!=='running')return body
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  assert.fail('operation did not settle')
}
test('concurrent duplicate writes and result polling execute one upstream intent; conflicting reuse is rejected',async t=>{
  const s=await createRealisticStack();t.after(()=>s.stop())
  const id=crypto.randomUUID(),url=s.base+'/api/operations?id='+id
  const payload={sessionId:'session-1',mode:'queue',content:[{type:'text',text:'single intent'}]}
  const options={method:'POST',headers:{authorization:'Bearer '+s.token,'content-type':'application/json'},body:JSON.stringify({method:'session.prompt',payload})}
  const replies=await Promise.all(Array.from({length:8},()=>fetch(url,options)))
  assert.ok(replies.every(r=>[200,202].includes(r.status)))
  assert.equal((await settled(s,id)).phase,'complete');assert.equal(s.records.prompts.length,1)
  assert.equal(s.records.prompts[0].requestId,id)
  const replay=await fetch(url,options);assert.equal(replay.status,200);assert.equal(s.records.prompts.length,1)
  const conflict=await fetch(url,{...options,body:JSON.stringify({method:'session.prompt',payload:{...payload,mode:'steer'}})})
  assert.equal(conflict.status,409)
  const denied=await fetch(url);assert.equal(denied.status,401)
  const receiptDir=path.join(s.tmpRoot,'operations'),saved=fs.readFileSync(path.join(receiptDir,fs.readdirSync(receiptDir).find(n=>n.endsWith('.json'))),'utf8')
  assert.doesNotMatch(saved,/single intent|session-1.*content|realistic-user-flow-test-token/)
})
test('session creation receipts can be read after dropping the submit response',async t=>{
  const s=await createRealisticStack();t.after(()=>s.stop())
  const id=crypto.randomUUID(),options={method:'POST',headers:{authorization:'Bearer '+s.token,'content-type':'application/json'},body:JSON.stringify({method:'session.create',payload:{workspaceId:'workspace-1'}})}
  const response=await fetch(s.base+'/api/operations?id='+id,options);await response.body.cancel()
  const result=await settled(s,id);assert.equal(result.phase,'complete');assert.ok(result.result.result.value.sessionId)
  assert.equal(s.dsh.state.createdSessions,1)
  assert.equal((await fetch(s.base+'/api/operations?id='+id,options)).status,200)
  assert.equal(s.dsh.state.createdSessions,1)
})

test('branch receipts preserve the exact turn boundary and never create a second child on retry',async t=>{
  const s=await createRealisticStack();t.after(()=>s.stop())
  const id=crypto.randomUUID(),url=s.base+'/api/operations?id='+id
  const options={method:'POST',headers:{authorization:'Bearer '+s.token,'content-type':'application/json'},body:JSON.stringify({method:'session.fork',payload:{sessionId:'session-1',atSeq:6}})}
  assert.equal((await fetch(url,options)).status,202)
  const result=await settled(s,id)
  assert.equal(result.phase,'complete')
  assert.ok(result.result.result.value.sessionId.startsWith('session-fork-'))
  assert.equal((await fetch(url,options)).status,200)
  assert.equal(s.dsh.state.createdSessions,1)
  assert.equal(s.records.requests.filter(row=>row.body.method==='session.fork').length,1)
  assert.equal(s.records.requests.find(row=>row.body.method==='session.fork').body.payload.atSeq,6)
})
test('new epoch resets even when the restarted process sequence already passed the old cursor, restoring pending baseline',()=>{
  const start=source.indexOf('function eventPollPayload('),end=source.indexOf('\nfunction sendEventPollResponse(',start)
  const context=vm.createContext({EVENT_STREAM_EPOCH:'new-process',eventBuffers:{mux:Array.from({length:50},(_,i)=>({seq:i+1}))},collectorReplay:{mux:new Map([['approval',JSON.stringify({payload:{type:'approval/requested',approvalId:'A'}})]])}})
  vm.runInContext(source.slice(start,end),context)
  const result=context.eventPollPayload('mux',20,true,'old-process')
  assert.equal(result.reset,true);assert.equal(result.events[0].seq,1);assert.equal(result.baseline[0].payload.approvalId,'A')
  const normal=context.eventPollPayload('mux',20,true,'new-process');assert.equal(normal.reset,false);assert.equal(normal.events[0].seq,21)
})

test('host lifecycle delivery IDs match WS and poll and do not confuse a reused upstream RPC ID with an event',()=>{
  const buffers={mux:[],host:[]},broadcasts=[]
  const context=vm.createContext({EVENT_STREAM_EPOCH:'process-epoch',EVENT_BUFFER_MAX:1000,eventBuffers:buffers,eventNextSeq:{mux:1,host:1},eventCollectorState:{host:{}},
    truncateEventValue:value=>JSON.parse(JSON.stringify(value)),rememberCollectorReplay(){},broadcastCollectorFrame:(kind,raw)=>broadcasts.push(JSON.parse(raw)),flushEventPollWaiters(){}})
  const start=source.indexOf('function pushEvent('),end=source.indexOf('\nfunction eventPollPayload(',start)
  vm.runInContext(source.slice(start,end),context)
  context.pushEvent('host',{rpcId:'shared-stream',remoteEventId:'untrusted',payload:{type:'host/session-status',sessionId:'S',running:true}})
  context.pushEvent('host',{rpcId:'shared-stream',payload:{type:'host/session-status',sessionId:'S',running:false}})
  assert.equal(buffers.host[0].event.remoteEventId,broadcasts[0].remoteEventId)
  assert.equal(buffers.host[1].event.remoteEventId,broadcasts[1].remoteEventId)
  assert.notEqual(broadcasts[0].remoteEventId,broadcasts[1].remoteEventId)
  assert.equal(broadcasts[0].remoteEventId,'process-epoch:host:1')
})
test('slow websocket client is bounded without delaying healthy subscribers',()=>{
  const start=source.indexOf('function broadcastCollectorFrame('),end=source.indexOf('\nfunction pushEvent(',start)
  const slow={writable:true,writableLength:1024,destroy(){this.destroyed=true},write(){assert.fail('slow client must not be written')}},seen=[]
  const fast={writable:true,writableLength:0,write:frame=>seen.push(frame)}
  const context=vm.createContext({WS_CLIENT_BUFFER_MAX:1000,collectorClients:{mux:new Set([slow,fast])},eventCollectorState:{mux:{framesBroadcast:0}},encodeWsText:raw=>Buffer.from(raw)})
  vm.runInContext(source.slice(start,end),context);context.broadcastCollectorFrame('mux','event')
  assert.equal(slow.destroyed,true);assert.equal(seen.length,1)
})
test('a receipt recovered after a gateway crash becomes unknown and is never forwarded again',()=>{
  const start=source.indexOf('function loadOperation('),end=source.indexOf('\nfunction operationSnapshot(',start),saved=[]
  const context=vm.createContext({operationJobs:new Map(),OPERATION_DIR:'tmp',OPERATION_TTL:86400000,path,
    fs:{readFileSync:()=>JSON.stringify({id:'operation',createdAt:Date.now(),phase:'running'})},saveOperation:(key,job)=>saved.push({...job})})
  vm.runInContext(source.slice(start,end),context)
  const result=context.loadOperation('key');assert.equal(result.phase,'unknown');assert.equal(saved[0].error,'gateway-restarted')
})
test('modern mutation 5xx is uncertain while an unavailable endpoint can use the legacy adapter',async()=>{
  const start=source.indexOf('async function translateModernRpc('),end=source.indexOf('\n/** 递归截断',start)
  let status=500
  const c=vm.createContext({callUpstreamRemote:async()=>({status,body:status===500?{result:{ok:false,error:{message:'server error'}}}:null}),
    imageAdmissionRejected:()=>false,modernResponseNeedsLegacyFallback:response=>response.status===404,legacyFallback:()=>({fallback:true})})
  vm.runInContext(source.slice(start,end),c)
  await assert.rejects(c.translateModernRpc('session.prompt',{requestId:'stable'},'stable',true),/upstream-uncertain/)
  status=404
  assert.equal((await c.translateModernRpc('session.prompt',{requestId:'stable'},'stable',true)).fallback,true)
})
test('client recovers a lost POST reply using only reads, then removes the local receipt',async()=>{
  const values=new Map(),calls=[]
  const root={crypto:crypto.webcrypto,localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    fetch:async(url,options)=>{calls.push(options.method);if(options.method==='POST')throw Error('reply lost');return {status:200,ok:true,json:async()=>({phase:'complete',result:{result:{ok:true,value:{accepted:true}}}})}}}
  const c=vm.createContext({window:root,module:{exports:{}},TextEncoder,Uint8Array,AbortSignal,Event,setTimeout:fn=>{queueMicrotask(fn);return 1}})
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/operations.js'),'utf8'),c)
  const result=await root.DshOperations.execute({method:'session.prompt',payload:{sessionId:'S',mode:'queue',content:[{type:'text',text:'private draft'}]},url:p=>'http://test'+p,headers:{authorization:'Bearer private-key'},valid:()=>true})
  assert.equal(result.result.value.accepted,true);assert.deepEqual(calls,['POST','GET'])
  assert.equal(JSON.parse(values.get('dshRemoteOperationReceiptsV1')).length,0)
})
test('LAN HTTP without SubtleCrypto or randomUUID can submit with the existing SHA-256 implementation',async()=>{
  const values=new Map(),calls=[]
  const root={crypto:{getRandomValues:bytes=>crypto.webcrypto.getRandomValues(bytes)},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    fetch:async(url,options)=>{calls.push({url,options});return {status:200,ok:true,json:async()=>({phase:'complete',result:{result:{ok:true,value:{accepted:true}}}})}}}
  const c=vm.createContext({window:root,module:{exports:{}},TextEncoder,Uint8Array,Uint32Array,AbortSignal,Event,setTimeout})
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/sha256.js'),'utf8')+'\nwindow.SHA256=SHA256',c)
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/operations.js'),'utf8'),c)
  const config={method:'session.prompt',payload:{sessionId:'S'},url:p=>'http://lan'+p,headers:{authorization:'Bearer secret'},valid:()=>true}
  await root.DshOperations.execute(config)
  assert.equal(calls.length,1);assert.match(calls[0].url,/id=[a-f0-9]{32}$/)
  assert.equal(JSON.parse(values.get('dshRemoteOperationReceiptsV1')).length,0)
})
test('reloading an uncertain client intent never creates a second POST and stores no draft or token',async()=>{
  const values=new Map(),calls=[]
  function client(){
    const root={crypto:crypto.webcrypto,localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
      fetch:async(url,options)=>{calls.push(options.method);return {status:200,ok:true,json:async()=>({phase:'unknown'})}}}
    const c=vm.createContext({window:root,module:{exports:{}},TextEncoder,Uint8Array,AbortSignal,Event,setTimeout:fn=>{queueMicrotask(fn);return 1}})
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/operations.js'),'utf8'),c);return root.DshOperations
  }
  const config={method:'session.prompt',payload:{sessionId:'S',mode:'queue',content:[{type:'text',text:'private draft'}]},url:p=>'http://test'+p,headers:{authorization:'Bearer private-key'},valid:()=>true}
  await assert.rejects(client().execute(config),/Result unconfirmed|结果未确认/)
  const saved=values.get('dshRemoteOperationReceiptsV1');assert.doesNotMatch(saved,/private draft|private-key/)
  await assert.rejects(client().execute(config),/Result unconfirmed|结果未确认/)
  assert.deepEqual(calls,['POST','GET'])
  const manual=client();await manual.restore(config)
  assert.equal(manual.dismiss(manual.pending()[0].id),true)
  await assert.rejects(manual.execute(config),/Result unconfirmed|结果未确认/)
  assert.deepEqual(calls,['POST','GET','POST'])
})
