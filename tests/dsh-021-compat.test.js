'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto')
const gateway=fs.readFileSync('gateway.js','utf8')
function section(source,start){const a=source.indexOf(start),b=source.indexOf('\n}',a);assert.ok(a>=0&&b>a,start);return source.slice(a,b+2)}
function bridge(){
 const modernState={sessions:new Map(),sessionCursors:new Map(),assistantStreams:new Map(),workspaces:{items:[],archivedSessionIds:[]}}
 const c=vm.createContext({crypto,modernState,modernResponseNeedsLegacyFallback:r=>r.status===404,recordCompatibility(){},legacyPush(){}})
 vm.runInContext(gateway.slice(gateway.indexOf('function legacyEnvelope('),gateway.indexOf('function modernResponseNeedsLegacyFallback('))+section(gateway,'function updateModernSessions(')+gateway.slice(gateway.indexOf('async function translateModernRpc('),gateway.indexOf('/** 递归截断'))+section(gateway,'function openModernSessionStream('),c)
 c.legacyHistoryValue=(value,summary)=>({...value,projections:summary?.projections})
 c.modernReasoningValue=()=>({})
 return {c,modernState}
}
test('DSH 0.2.1: cached watermarks never become connected history cursors',async()=>{
 const {c,modernState}=bridge(),requests=[]
 modernState.sessionCursors.set('cold',8)
 c.updateModernSessions([{sessionId:'cold',projections:{kind:'cached',asOfSeq:900,values:{title:'cached'}}}])
 assert.equal(modernState.sessionCursors.get('cold'),8)
 c.callUpstreamRemote=async(endpoint,args)=>{requests.push({endpoint,args});return {status:200,body:{result:{ok:true,value:endpoint==='session/projections'?{kind:'sequenced',asOfSeq:3,values:{title:'current'}}:{records:[],hasMore:false}}}}}
 const result=await c.translateModernRpc('session.history',{sessionId:'cold'},'history')
 assert.equal(requests[0].endpoint,'session/projections')
 assert.equal(requests[1].args.request.throughSeq,3)
 assert.equal(result.result.value.projections.kind,'sequenced')
 assert.equal(result.result.value.projections.values.title,'current')
})
test('DSH 0.2.1: migration-required sessions remain non-activating and return a useful error',async()=>{
 const {c,modernState}=bridge()
 modernState.sessions.set('old',{sessionId:'old',formatStatus:'migration-required',projections:{kind:'cached',asOfSeq:800}})
 c.callUpstreamRemote=()=>assert.fail('Migration must not be triggered by a history read')
 const result=await c.translateModernRpc('session.history',{sessionId:'old'},'history')
 assert.equal(result.result.error.code,'session/migration-required')
 c.openModernSessionStream({readyState:1,send:()=>assert.fail('Do not follow or start jobs for an unmigrated session')},'old')
 modernState.sessions.set('old',{sessionId:'old',projections:{kind:'cached',asOfSeq:800}})
 c.callUpstreamRemote=async()=>({status:200,body:{result:{ok:true,value:{kind:'migration-required',values:{}}}}})
 assert.equal((await c.translateModernRpc('session.history',{sessionId:'old'},'race')).result.error.code,'session/migration-required')
})
test('DSH 0.2.1: catalogs distinguish migration and external children from corrupted records',async()=>{
 const {c,modernState}=bridge(),requests=[]
 modernState.sessions.set('parent',{agentAvailable:true});c.refreshModernSessions=async()=>{}
 c.callUpstreamRemote=async(endpoint,args)=>{
  requests.push({endpoint,args})
  if(endpoint==='subagents/list')return {status:404}
  const value=args.request.sessionId==='parent'?{kind:'sequenced',asOfSeq:4,values:{subagentCatalog:[{id:'old',label:'Older child',mode:'continuable'},{id:'external',label:'External task',mode:'external'}]}}:{kind:'migration-required',values:{subagent:{mode:'continuable'}}}
  return {status:200,body:{result:{ok:true,value}}}
 }
 const result=await c.translateModernRpc('subagent.list',{parentSessionId:'parent'},'catalog')
 assert.equal(result.result.value.entries[0].reason,'migration-required');assert.equal(result.result.value.entries[0].label,'Older child')
 assert.equal(result.result.value.entries[1].reason,'external');assert.equal(result.result.value.entries[1].label,'External task')
 assert.ok(!requests.some(r=>r.args?.request?.sessionId==='external'))
 c.callUpstreamRemote=async(endpoint)=>endpoint==='subagents/list'?{status:404}:{status:200,body:{result:{ok:true,value:{kind:'migration-required',values:{subagentCatalog:[]}}}}}
 assert.equal((await c.translateModernRpc('subagent.list',{parentSessionId:'parent'},'parent')).result.error.code,'session/migration-required')
})
for(const file of ['public/app.js','public/desktop/desktop.js']){
 const source=fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')
 test(file+': sequenced projections replace cached cuts even when the cache watermark is larger',()=>{
  const session={sessionId:'s',projections:{kind:'cached',asOfSeq:1000,values:{title:'stale'}}},state={current:'other',byId:new Map([['s',session]])}
  const c=vm.createContext({state,window:{},renderSessions(){},scheduleRefresh(){},scheduleSessionsRefresh(){}})
  vm.runInContext(section(source,'function hydrateSessionProjections(')+'\n'+section(source,'function applyProjection('),c)
  c.hydrateSessionProjections('s',{kind:'sequenced',asOfSeq:3,values:{title:'live'}})
  assert.equal(session.projections.asOfSeq,3);assert.equal(session.projections.values.title,'live')
  c.hydrateSessionProjections('s',{kind:'cached',asOfSeq:2000,values:{title:'old again'}})
  assert.equal(session.projections.values.title,'live')
  session.projections={kind:'cached',asOfSeq:1000,values:{title:'cached'}}
  c.applyProjection('s','title','stream',2)
  assert.equal(session.projections.asOfSeq,2);assert.equal(session.projections.values.title,'stream')
  c.applyProjection('s','title','out of order',1);assert.equal(session.projections.values.title,'stream')
 })
 test(file+': migration failures preserve the RPC code and show a translated recovery instruction',async()=>{
  const c=vm.createContext({state:{token:'test'},window:{},CAP:null,AbortSignal,uuid:()=>'',clientIdHeaders:()=>({}),apiUrl:()=>'',t:key=>key==='session.migrationRequired'?'Open the original session first':key,
   fetch:async()=>({ok:true,status:200,json:async()=>({result:{ok:false,error:{code:'session/migration-required',message:'raw server error'}}})})})
  vm.runInContext(section(source,'async function rpc('),c)
  await assert.rejects(c.rpc('session.history',{sessionId:'old'}),e=>e.code==='session/migration-required'&&e.message==='Open the original session first')
 })
}
