'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto')
const source=fs.readFileSync(path.join(__dirname,'../gateway.js'),'utf8')
function cut(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)}
const settle=()=>new Promise(setImmediate)
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-lifecycle-handoff-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 const now=Date.now(),config={kind:'desktop',executable:path.resolve('fixture.exe'),desktop:{profilePath:path.resolve('fixture-profile'),root:{pid:202,started:new Date(now+10).toISOString()}}}
 function context(){
  let clock=now,commands=0
  const c=vm.createContext({fs,path,crypto,process,DSH_CONTROL_DIR:dir,DSH_LAUNCH_FILE:path.join(dir,'launch.json'),UPSTREAM:new URL('http://127.0.0.1:1111'),Date:class extends Date{static now(){return clock}},
   fsSamePath:(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase(),readDshLaunch:()=>config,
   dshServiceStatus:async()=>({supported:true,running:true,manager:'desktop',mainPid:202,canRestart:true}),probeDshUpstream:async()=>({ok:true,status:200}),dshEventChannelStatus:()=>({ok:true,mux:{connected:true},host:{connected:true}}),
   delay:async()=>{clock+=500},DSH_CONTROL_POLL_MS:50,executeDshServiceAction:()=>{commands++;throw Error('must not replay')}})
  vm.runInContext(cut('let dshControlOperation = null','// Owned children expose')+cut('function dshOperationStep(','function failDshOperation(')+`;this.api={save:saveDshControlRecord,read:readDshControlRecord,restore:restoreDshControl,reconcile:reconcileDshControl,handoff:desktopHandoffPending,snapshot:dshControlSnapshot,owner:dshControlOwner,get:()=>dshControlOperation}`,c)
  return {c,api:c.api,commands:()=>commands}
 }
 const first=context(),operation={operationId:crypto.randomUUID(),owner:first.api.owner,action:'restart',startedAt:now,deadlineAt:now+2000,updatedAt:now,done:false,ok:false,stage:'waiting-service',steps:[],commandIssued:true,
  target:{manager:'desktop',executable:config.executable,profilePath:config.desktop.profilePath,pid:101,started:new Date(now-10000).toISOString(),expectedPid:202}}
 return {dir,config,first,context,operation}
}
test('New gateway resumes the same durable task and confirms fresh Desktop/HTTP/streams without replay',async t=>{
 const h=fixture(t);h.first.api.save(h.operation);const second=h.context();second.api.restore();await settle()
 const result=second.api.get();assert.equal(result.operationId,h.operation.operationId);assert.equal(result.ok,true);assert.equal(result.done,true);assert.equal(second.commands(),0)
 const snapshot=second.api.snapshot(result);assert.equal(snapshot.target,undefined);assert.equal(snapshot.owner,undefined);assert.equal(snapshot.status.mainPid,202)
 assert.throws(()=>h.first.api.save(h.operation),e=>e.code==='CONTROL_HANDED_OFF')
})
test('Wrong Desktop identity cannot complete a recovered task and never issues commands',async t=>{
 const h=fixture(t);h.first.api.save(h.operation);h.config.executable=path.resolve('unrelated.exe');const second=h.context();second.api.restore();await settle()
 assert.equal(second.api.get().code,'RESULT_UNKNOWN');assert.equal(second.api.get().ok,false);assert.equal(second.commands(),0)
})
test('Crash before command submission remains unknown instead of replaying start/restart',async t=>{
 const h=fixture(t);h.operation.commandIssued=false;h.first.api.save(h.operation);const second=h.context();second.api.restore();await settle()
 assert.equal(second.api.get().stage,'unknown');assert.equal(second.commands(),0)
})
test('Journal IDs cannot traverse the filesystem and snapshots preserve completed timing',t=>{
 const h=fixture(t);assert.equal(h.first.api.read('../token'),null);h.operation.done=true;h.operation.elapsedMs=321;h.first.api.save(h.operation)
 assert.equal(h.first.api.snapshot(h.first.api.read(h.operation.operationId)).elapsedMs,321)
})
test('Old gateway recognizes a verified Desktop port change as handoff rather than failed restart',t=>{
 const h=fixture(t);fs.writeFileSync(path.join(h.dir,'launch.json'),JSON.stringify({...h.config,version:1,upstream:'http://127.0.0.1:2222'}))
 assert.equal(h.first.api.handoff(h.operation),true)
 h.operation.target.expectedPid=999;assert.equal(h.first.api.handoff(h.operation),false)
})
test('A valid but not yet persisted request cannot execute when durable storage fails',async()=>{
 let scheduled=0,status,body
 const c=vm.createContext({controlAuthorized:()=>true,touchDevice:()=>{},cors:()=>{},restoreDshControl:()=>{},dshControlOperation:null,
  readBody:async()=>JSON.stringify({action:'restart',requestId:crypto.randomUUID()}),validDshOperationId:()=>true,readDshControlRecord:()=>null,crypto,Date,DSH_SERVICE:'fixture',DSH_CONTROL_TIMEOUT_MS:1000,dshControlOwner:'fixture',
  saveDshControlRecord:()=>{throw Error('disk unavailable')},setImmediate:()=>scheduled++})
 vm.runInContext(cut('async function serveDshControl(','// ---------- 事件轮询缓冲'),c)
 await c.serveDshControl({method:'POST'},{writeHead:n=>{status=n},end:text=>{body=JSON.parse(text)}},new URL('http://fixture/admin/api/dsh'))
 assert.equal(status,503);assert.equal(body.code,'RECEIPT_UNAVAILABLE');assert.equal(scheduled,0)
})
