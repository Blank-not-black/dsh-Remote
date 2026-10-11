'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')
const desktop=read('public/desktop/desktop.js')
const cut=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function fixture(){
 const input={value:'/custom'},sent=[],compactions=[],closed=[]
 const state={server:'http://A',token:'token-A',current:'A',wsTicket:{},sessionActivity:new Set(),pendingCommands:{},archivedIds:[]}
 const c=vm.createContext({String,Set,Date,URL,AbortSignal,console,setTimeout,
  state,$:()=>input,location:{href:'http://gateway/desktop/',pathname:'/desktop/'},CAP:null,
  captureConnection:()=>{const {server,token}=state;return {valid:()=>server===state.server&&token===state.token}},
  apiUrl:p=>(state.server||'')+p,clientIdHeaders:()=>({}),activeGatewayCapability:()=>true,
  SLASH_COMMAND_TIMEOUT_MS:8000,LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS:30000,NO_FALLBACK_SLASH_COMMANDS:new Set(['compact','export']),
  slashCommandName:s=>s.slice(1).split(' ')[0],safeRpc:async(method,payload)=>{sent.push({method,payload});return {ok:true}},
  setSessionRecovery(){},noteSessionTurnTime(){},renderSessions(){},refreshSessions:async()=>{},toast(){},t:x=>x,confirm:()=>true,
  setCompactionStatus:(id,v)=>compactions.push({id,v}),refreshCompactionStatus(){},downloadSessionExport:async()=>{},
  closeSession:async()=>closed.push(state.current)
 })
 return {c,input,state,sent,compactions,closed}
}
test('Desktop slash fallback cannot send to another session or clear its draft',async()=>{
 const h=fixture(),job=deferred();h.c.fetch=()=>job.promise
 vm.runInContext(cut(desktop,'async function runSlashCommand(','async function cancelSession('),h.c)
 const sending=h.c.sendMessage();h.state.current='B';h.input.value='new B draft'
 job.resolve({status:200,ok:true,json:async()=>({ok:true,executed:false})});await sending
 assert.equal(h.sent.length,0);assert.equal(h.input.value,'new B draft')
})
test('Desktop compact result belongs to the original session and preserves edited input',async()=>{
 const h=fixture(),job=deferred();h.c.fetch=()=>job.promise;h.input.value='/compact'
 vm.runInContext(cut(desktop,'async function runSlashCommand(','async function cancelSession('),h.c)
 const sending=h.c.sendMessage();h.state.current='B';h.input.value='B draft'
 job.resolve({status:200,ok:true,json:async()=>({ok:true,executed:true,accepted:true,operation:{}})});await sending
 assert.equal(h.compactions[0].id,'A');assert.equal(h.input.value,'B draft');assert.equal(h.sent.length,0)
})
test('Desktop failed or unaccepted send preserves the draft, successful send clears only its own draft',async()=>{
 for(const accepted of [false,true])for(const edited of [false,true]){
  const h=fixture(),job=deferred();h.input.value='original draft';h.c.runSlashCommand=async()=>false
  h.c.safeRpc=()=>job.promise
  vm.runInContext(cut(desktop,'async function sendMessage(','async function cancelSession('),h.c)
  const p=h.c.sendMessage();await Promise.resolve()
  assert.equal(h.input.value,'original draft');if(edited)h.input.value='edited draft'
  job.resolve(accepted?{accepted:true}:null);await p
  assert.equal(h.input.value,edited?'edited draft':accepted?'':'original draft')
 }
})
test('Desktop repeated send while pending submits only once, and switching session permits a new send',async()=>{
 const h=fixture(),jobs=[];h.input.value='draft';h.state.history={};h.c.runSlashCommand=async()=>false
 h.c.safeRpc=()=>{const job=deferred();jobs.push(job);return job.promise}
 vm.runInContext(cut(desktop,'async function sendMessage(','async function cancelSession('),h.c)
 const old=h.c.sendMessage();await h.c.sendMessage();assert.equal(jobs.length,1)
 h.state.current='B';h.state.history={};h.input.value='B draft';const current=h.c.sendMessage();await new Promise(setImmediate);assert.equal(jobs.length,2)
 jobs[0].resolve({accepted:true});await old;assert.equal(h.input.value,'B draft')
 jobs[1].resolve({accepted:true});await current;assert.equal(h.input.value,'')
})
test('Archive completion cannot close another session or mutate another server',async()=>{
 for(const switchServer of [false,true]){
  const h=fixture(),job=deferred();h.c.safeRpc=()=>job.promise
  vm.runInContext(cut(desktop,'async function archiveCurrentSession(','function updateComposerStatus('),h.c)
  const archiving=h.c.archiveCurrentSession();h.state.current='B';if(switchServer)h.state.server='http://B'
  job.resolve({archivedSessionIds:['A']});await archiving
  assert.equal(h.closed.length,0);assert.deepEqual(h.state.archivedIds,switchServer?[]:['A'])
 }
})
for(const file of ['public/app.js','public/desktop/desktop.js']){
 test(file+': in-flight WS ticket requests are isolated and old completion cannot clear the new request',async()=>{
  const h=fixture(),jobs=[];h.c.fetch=()=>{const job=deferred();jobs.push(job);return job.promise}
  vm.runInContext(cut(read(file),'let wsTicketPromise = null','async function rpc('),h.c)
  const old=h.c.getWsTicket().catch(e=>e.message);h.state.server='http://B';h.state.token='token-B'
  const current=h.c.getWsTicket();assert.equal(jobs.length,2)
  jobs[0].resolve({ok:true,json:async()=>({ticket:'ticket-A',expiresAt:Date.now()+60000})});assert.equal(await old,'stale ws ticket')
  const shared=h.c.getWsTicket();assert.equal(jobs.length,2)
  jobs[1].resolve({ok:true,json:async()=>({ticket:'ticket-B',expiresAt:Date.now()+60000})})
  assert.equal(await current,'ticket-B');assert.equal(await shared,'ticket-B');assert.equal(h.state.wsTicket.server,'http://B')
 })
}
test('Desktop exports authenticate same-origin gateway downloads, preserve plugin cookies and ignore stale preflight',async()=>{
 for(const pathname of ['/desktop/','/remote/desktop/']){
  const h=fixture(),anchors=[];h.state.server='';h.c.location.pathname=pathname
  h.c.sessionLogFilename=()=> 'session.zip';h.c.fetch=async()=>({status:200,ok:true})
  h.c.document={body:{appendChild(){}},createElement:()=>({click(){anchors.push(this.href)},remove(){}})}
  vm.runInContext(cut(desktop,'async function downloadSessionExport(','async function runSlashCommand('),h.c)
  await h.c.downloadSessionExport('A');assert.equal(anchors.length,1)
  assert.equal(new URL(anchors[0]).searchParams.has('token'),!pathname.startsWith('/remote/'))
  const job=deferred();h.c.fetch=()=>job.promise;const exporting=h.c.downloadSessionExport('A');h.state.token='other'
  job.resolve({status:200,ok:true});await exporting;assert.equal(anchors.length,1)
 }
})
test('Desktop gateway badge targets loopback instead of the protocol hostname',()=>{
 const source=read('public/admin.js');let handler,url
 const c=vm.createContext({$:()=>({addEventListener:(_,fn)=>{handler=fn}}),lastState:{mode:'gateway',port:8787},shownToken:'fixture',token:'',
  location:{protocol:'dsh-app:',hostname:'app'},window:{open:v=>{url=v}},t:x=>x,toast(){}})
 vm.runInContext(cut(source,"$('conn-badge').addEventListener", "\n$('") ,c);handler()
 assert.equal(new URL(url).hostname,'127.0.0.1')
})
test('Admin polls coalesce and an old token response cannot overwrite current state',async()=>{
 const source=read('public/admin.js'),jobs=[],rendered=[]
 const c=vm.createContext({token:'A',pluginMode:false,API:'/admin/api',AbortSignal,adminHeaders:()=>({}),
  fetch:()=>{const job=deferred();jobs.push(job);return job.promise},render:v=>rendered.push(v.id),toast(){},t:x=>x,logout(){throw Error('stale logout')}})
 vm.runInContext(cut(source,'let stateLoadJob = null','function render(st)'),c)
 const old=c.loadState(),shared=c.loadState();assert.equal(jobs.length,1)
 c.token='B';const current=c.loadState();assert.equal(jobs.length,2)
 jobs[1].resolve({status:200,ok:true,json:async()=>({id:'B'})});await current
 jobs[0].resolve({status:401,ok:false});await Promise.all([old,shared]);assert.deepEqual(rendered,['B'])
})
