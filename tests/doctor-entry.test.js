'use strict'
const{test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')
function fixture(pluginMode=true){
 let options,live={hostname:'test',version:'0.8.0-rc.8'},sequence=0
 const calls=[],c=vm.createContext({window:{DshDoctor:{open:args=>{options=args}}},location:{host:'host',origin:'http://host'},crypto:{randomUUID:()=>String(++sequence)},AbortSignal,JSON,URL,URLSearchParams,Math,Date,
  fetch:async(url,init)=>{calls.push({url,init});return {ok:true,status:200,json:async()=>({result:{ok:true,value:{sessionId:'new'}}})}}
 })
 vm.runInContext(read('public/doctor-entry.js'),c);c.window.DshDoctorEntry.open({state:()=>live,pluginMode,token:()=>pluginMode?'':'test-token'})
 return{c,calls,options,invalidate:()=>{live={hostname:'other'}}}
}
test('opening management diagnosis creates no conversation; host calls preserve session.create request shape and DSH authentication',async()=>{
 const f=fixture();assert.equal(f.calls.length,0)
 await f.options.rpc('session.create',{cwd:'/fixture/plugin'})
 assert.equal(f.calls[0].url,'/api/session/create');assert.equal(f.calls[0].init.credentials,'same-origin')
 assert.equal(f.calls[0].init.headers.authorization,undefined)
 const body=JSON.parse(f.calls[0].init.body);assert.deepEqual(body.payload,{args:{request:{cwd:'/fixture/plugin'}}})
 await assert.rejects(f.options.rpc('workspace.create',{}),/Unsupported/)
 f.invalidate();await assert.rejects(f.options.rpc('session.prompt',{}),/changed/)
})
test('legacy host fallback only follows a missing endpoint; uncertain failures cannot duplicate creation',async()=>{
 const f=fixture();let count=0
 f.c.fetch=async()=>{count++;return count===1?{status:404,body:{cancel:async()=>{}}}:{status:200,ok:true,json:async()=>({result:{ok:true,value:{sessionId:'legacy'}}})}}
 assert.equal((await f.options.rpc('session.create',{cwd:'/fixture'})).sessionId,'legacy');assert.equal(count,2)
 count=0;f.c.fetch=async()=>{count++;return {status:500,ok:false,json:async()=>({})}}
 await assert.rejects(f.options.rpc('session.create',{}));assert.equal(count,1)
})
test('gateway entry keeps its existing authentication and reads the authenticated exact target route',async()=>{
 const f=fixture(false);await f.options.rpc('session.create',{cwd:'/fixture'})
 assert.equal(f.calls[0].url,'/api/session.create');assert.equal(f.calls[0].init.headers.authorization,'Bearer test-token')
 f.c.fetch=async(url,init)=>{f.calls.push({url,init});return {ok:true,text:async()=>JSON.stringify({ok:true})}}
 await f.options.loadTarget();assert.equal(f.calls.at(-1).url,'/remote/api/doctor/target')
})

test('modern diagnosis prompts include an idempotent request ID',async()=>{
 const f=fixture();await f.options.rpc('session.prompt',{sessionId:'new',mode:'queue',content:[{type:'text',text:'test'}]})
 const body=JSON.parse(f.calls[0].init.body)
 assert.equal(body.payload.args.request.requestId,body.rpcId)
 await f.options.rpc('session.prompt',{sessionId:'new',requestId:'explicit'})
 assert.equal(JSON.parse(f.calls[1].init.body).payload.args.request.requestId,'explicit')
})

function handoffFixture(){
 const f=fixture(false),storage=new Map(),assigned=[]
 f.c.window.parent=f.c.window
 f.c.window.sessionStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}
 Object.assign(f.c.location,{protocol:'http:',href:'http://host/?sessionId=new',assign:url=>assigned.push(url)})
 return {...f,storage,assigned,state:{servers:[],groups:['默认'],activeGroup:'默认',groupActive:{},autoSelect:{默认:true},server:'',token:''}}
}

test('gateway diagnosis hands off authentication once without putting credentials in the URL',async()=>{
 const f=handoffFixture();await f.options.openSession('new')
 assert.deepEqual(f.assigned,['/?sessionId=new'])
 assert.equal(f.storage.size,1)
 let saved=0
 assert.equal(f.c.window.DshDoctorEntry.restoreSessionConnection({state:f.state,newId:()=> 'new-server',persist:()=>saved++}),true)
 assert.equal(f.state.token,'test-token');assert.equal(f.state.server,'http://host')
 assert.equal(f.state.groupActive['默认'],'new-server');assert.equal(saved,1)
 assert.equal(f.state.autoSelect['默认'],true);assert.equal(f.storage.size,0)
 assert.equal(f.c.window.DshDoctorEntry.restoreSessionConnection({state:f.state}),false)
})

test('explicit diagnosis navigation preserves other saved host identities and reuses an exact match',async()=>{
 const f=handoffFixture(),entry=f.c.window.DshDoctorEntry
 f.state.servers.push({id:'other-token',url:'http://host',token:'different',group:'默认'},{id:'other-host',url:'http://other',token:'other',group:'默认'})
 await f.options.openSession('new')
 assert.equal(entry.restoreSessionConnection({state:f.state,newId:()=> 'diagnosis'}),true)
 assert.equal(f.state.servers.length,3);assert.equal(f.state.servers[1].token,'different')
 f.state.servers[0].group='诊断';await f.options.openSession('new')
 assert.equal(entry.restoreSessionConnection({state:f.state,newId:()=>{throw Error('must reuse')}}),true)
 assert.equal(f.state.servers.length,3);assert.equal(f.state.activeGroup,'诊断');assert.ok(f.state.groups.includes('诊断'))
})

test('stale, foreign, malformed and mismatched diagnosis handoffs cannot change the connection',()=>{
 const cases=[null,[],{},'bad-json',
  {origin:'http://other'},{sessionId:'different'},{at:Date.now()-120001},{at:Date.now()+60000},{token:''},{token:'x'.repeat(4097)}]
 for(const override of cases){
  const f=handoffFixture(),record={origin:'http://host',sessionId:'new',token:'test-token',at:Date.now()}
  f.storage.set('dshRemoteDoctorHandoffV1',override==='bad-json'?'{':JSON.stringify(override===null||Array.isArray(override)?override:{...record,...override}))
  // An empty object is also an invalid stored record.
  if(override&&Object.keys(override).length===0)f.storage.set('dshRemoteDoctorHandoffV1','{}')
  assert.equal(f.c.window.DshDoctorEntry.restoreSessionConnection({state:f.state}),false)
  assert.equal(f.state.token,'');assert.equal(f.state.servers.length,0);assert.equal(f.storage.size,0)
 }
})

test('blocked handoff storage reports failure instead of navigating to an unauthenticated page',async()=>{
 const f=handoffFixture();f.c.window.sessionStorage.setItem=()=>{throw Error('blocked')}
 await assert.rejects(f.options.openSession('new'),/无法保存本次连接/)
 assert.deepEqual(f.assigned,[])
})

test('mobile bootstrap adopts the explicit diagnosis connection before choosing its initial view',async()=>{
 const f=handoffFixture();await f.options.openSession('new')
 Object.assign(f.c.location,{search:'?sessionId=new',pathname:'/'})
 Object.assign(f.c,{state:f.state,doctorSessionHandoff:false,LS:{get:()=>'',set(){}},loadServers(){},newServerId:()=> 'mobile-server',saveServers(){},$:()=>({}),t:key=>key})
 const source=read('public/app.js'),start=source.indexOf('function initToken()')
 vm.runInContext(source.slice(start,source.indexOf('let dshControlPollPromise',start)),f.c)
 f.c.initToken()
 assert.equal(f.c.doctorSessionHandoff,true);assert.equal(f.state.token,'test-token');assert.equal(f.state.server,'http://host')
 // A cached older entry module must not break ordinary startup.
 f.c.window.DshDoctorEntry={};f.c.initToken();assert.equal(f.c.doctorSessionHandoff,false)
})

test('desktop bootstrap keeps the explicit diagnosis host and resumes automatic selection on ordinary starts',async()=>{
 for(const handoff of [true,false,'cached-old-entry']){
  const f=handoffFixture();if(handoff===true)await f.options.openSession('new')
  if(handoff==='cached-old-entry'){f.storage.clear();f.c.window.DshDoctorEntry={}}
  let selections=0,streams=0
  Object.assign(f.c.location,{search:'?sessionId=new',pathname:'/desktop/desktop.html'})
  if(handoff!==true)f.state.token='previous-token'
  Object.assign(f.c,{state:f.state,doctorSessionHandoff:false,overviewStarting:true,LS:{set(){}},loadServers(){},newServerId:()=> 'desktop-server',saveServers(){},$:()=>({}),t:key=>key,
   renderServers(){},showView(){},bindUi(){},renderWorkbench(){},updateConn(){},checkNotesOnStart(){},selectFastestServer:async()=>selections++,openStreams:()=>streams++,refreshSessions:async()=>{},refreshHostDescriptionDesktop:async()=>{},refreshWorkbench(){},renderOverviewDesktop(){}})
  const source=read('public/desktop/desktop.js'),start=source.indexOf('async function start()')
  vm.runInContext(source.slice(start,source.indexOf('\nstart()',start)),f.c)
  await f.c.start()
  assert.equal(selections,handoff===true?0:1);assert.equal(streams,1)
  if(handoff===true){assert.equal(f.state.token,'test-token');assert.equal(f.state.server,'http://host')}
 }
})

test('missing diagnosis assets show a visible error without making a request',()=>{
 const f=fixture(false),notices=[];delete f.c.window.DshDoctor
 assert.equal(f.c.window.DshDoctorEntry.open({state:()=>({}),pluginMode:false,toast:(...args)=>notices.push(args)}),false)
 assert.match(notices[0][0],/诊疗组件未能加载/);assert.equal(f.calls.length,0)
})
test('host entry has no embedded frame or native session handoff',()=>{
 const client=read('packages/plugin/client.js')
 assert.doesNotMatch(client,/createElement\('iframe'|sidebar\.right\.pane\.tab|source: 'dsh-remote-host'/)
 assert.match(client,/sidebar\.panellist\.actions/)
})
