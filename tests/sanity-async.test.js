'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const files = ['public/app.js', 'public/desktop/desktop.js']
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => { resolve=r; reject=j }); return { promise, resolve, reject } }
function section(source, start) {
  const a=source.indexOf(start), b=source.indexOf('\n}', a)
  assert.ok(a>=0 && b>a, start); return source.slice(a,b+2)
}
function fixture(file) {
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8').replaceAll('\r\n','\n')
  const els=new Map(), calls=[], notices=[]
  const $=id=>{ if(!els.has(id))els.set(id,{value:'work-A',disabled:false,innerHTML:'',textContent:'',hidden:false,classList:{add(){els.get(id).hidden=true},remove(){els.get(id).hidden=false}},querySelectorAll:()=>[],querySelector:()=>({value:'answer'})});return els.get(id) }
  const state={server:'A',token:'token-A',current:'A',models:{loaded:false,loading:false,groups:[],current:{provider:'p',model:'old'}},history:{},byId:new Map(),questions:[],approvals:[],fs:{},activeGroup:'group-A',selectingServer:false,autoSelect:{'group-A':true},groupActive:{},servers:[],serverLatency:{}}
  const c=vm.createContext({state,$,console,Set,Map,Array,String,Date,URL,setTimeout,clearTimeout,AbortSignal,
    location:{origin:'http://origin'},CAP:null,
    captureConnection:()=>{const {server,token}=state;return {valid:()=>state.server===server&&state.token===token}},
    rpc:async()=>({}),safeRpc:async()=>({}),t:key=>key,toast:(...v)=>notices.push(v),authFailure:()=>calls.push('auth'),
    renderModelMenu(){},renderEffortMenu(){},renderPending(){},renderNotifStack(){},renderWorkbench(){},renderSessions(){},renderSessionCards(){},
    confirm:()=>true,prompt:()=> 'edited',goalOf:()=>({id:'goal-A',revision:1}),setGoalPhaseLocal:()=>calls.push('phase'),
    refreshSessions:async()=>{},scheduleRefresh:()=>calls.push('refresh'),openSession:id=>calls.push(id),workspaceById:id=>({workspaceId:id}),
    LS:{set:()=>calls.push('stored')},closeNewSessionModal:()=>calls.push('closed'),fsApiUrl:()=>state.server+'/fs/list',fsHeaders:()=>({}),
    wbJoin:(root,name)=>root+'/'+name,esc:x=>x,desktopFsIconSvg:()=>'',closeWorkbenchModal:()=>calls.push('closed'),refreshWorkbench:async()=>{},
  })
  return {c,source,state,$,calls,notices}
}
for(const file of files){
  test(file+': stale successful RPC cannot affect a new connection',async()=>{
    const h=fixture(file), job=deferred();h.c.rpc=()=>job.promise
    vm.runInContext(section(h.source,'async function safeRpc('),h.c)
    const p=h.c.safeRpc('session.create',{});h.state.server='B';job.resolve({sessionId:'old'});assert.equal(await p,null)
  })
  test(file+': model loading and session creation still succeed on the same connection',async()=>{
    const h=fixture(file);h.c.rpc=async()=>({groups:[{id:'p'}],current:{model:'current'}})
    vm.runInContext(section(h.source,'async function loadSessionModels('),h.c);await h.c.loadSessionModels()
    assert.equal(h.state.models.current.model,'current');assert.equal(h.state.models.loaded,true);assert.equal(h.state.models.loading,false)
    h.c.safeRpc=async()=>({sessionId:'created'})
    vm.runInContext(section(h.source,'async function createSessionInWorkspace('),h.c);await h.c.createSessionInWorkspace()
    assert.ok(h.calls.includes('created'));assert.equal(h.$('new-session-create').disabled,false)
  })
  test(file+': late speed test cannot replace a manually selected host or use another group',async()=>{
    for(const changed of ['server','group']){
      const h=fixture(file),job=deferred();h.c.serverCandidates=()=>[{id:'old',url:'http://old'}];h.c.pingServer=()=>job.promise
      vm.runInContext(section(h.source,'async function selectFastestServer('),h.c)
      const p=h.c.selectFastestServer({silent:true});if(changed==='server')h.state.server='B';else h.state.activeGroup='group-B'
      job.resolve(10);assert.equal(await p,null);assert.equal(h.state.server,changed==='server'?'B':'A');assert.equal(h.state.selectingServer,false)
    }
  })
  test(file+': a newer speed test runs while an older group test is pending',async()=>{
    const h=fixture(file),jobs=[],renders=[]
    h.c.serverCandidates=()=>[];h.c.serverToken=()=>h.state.token;h.c.serverKey=s=>s.url;h.c.renderServers=()=>renders.push(h.state.activeGroup);h.c.maybeWarnAppBehindGateway=async()=>{}
    // Pause the empty measurements without requiring any network or mutating the chosen host.
    h.c.Promise={all:()=>{const job=deferred();jobs.push(job);return job.promise}}
    vm.runInContext(section(h.source,'async function selectFastestServer('),h.c)
    const old=h.c.selectFastestServer({silent:true});h.state.activeGroup='group-B';h.state.autoSelect['group-B']=true
    const current=h.c.selectFastestServer({silent:true});assert.equal(jobs.length,2)
    jobs[0].resolve([]);await old;assert.equal(h.state.selectingServer,true)
    jobs[1].resolve([]);await current;assert.equal(h.state.selectingServer,false);assert.deepEqual(renders,['group-B'])
  })
  test(file+': late model load and selection cannot overwrite a newly opened session',async()=>{
    for(const method of ['loadSessionModels','selectSessionModel','selectSessionEffort']){
      const h=fixture(file),job=deferred();h.c.rpc=h.c.safeRpc=()=>job.promise
      vm.runInContext(section(h.source,'async function '+method+'('),h.c)
      const p=h.c[method]('p','new');const next={loaded:false,loading:true,groups:[],current:null};h.state.current='B';h.state.models=next
      job.resolve({groups:[{id:'old'}],current:{model:'old'},selected:{model:'old'}});await p
      assert.equal(next.current,null);assert.equal(next.loading,true);assert.equal(next.groups.length,0)
    }
  })
  test(file+': model selections keep the latest request when replies arrive out of order',async()=>{
    const h=fixture(file),jobs=[];h.c.safeRpc=()=>{const job=deferred();jobs.push(job);return job.promise}
    vm.runInContext(section(h.source,'async function selectSessionModel('),h.c)
    const first=h.c.selectSessionModel('p','one'),second=h.c.selectSessionModel('p','two')
    jobs[1].resolve({selected:{model:'two'}});await second;jobs[0].resolve({selected:{model:'one'}});await first
    assert.equal(h.state.models.current.model,'two')
  })
  test(file+': new session cannot navigate after changing host during create or list refresh',async()=>{
    for(const stage of ['create','refresh']){
      const h=fixture(file),job=deferred(),reached=deferred()
      h.c.safeRpc=async()=>{if(stage==='create'){reached.resolve();return job.promise}return {sessionId:'new-A'}}
      h.c.refreshSessions=async()=>{reached.resolve();await job.promise}
      vm.runInContext(section(h.source,'async function createSessionInWorkspace('),h.c)
      const p=h.c.createSessionInWorkspace();await reached.promise;h.state.server='B';job.resolve({sessionId:'new-A'});await p
      assert.ok(!h.calls.includes('new-A'));assert.equal(h.$('new-session-create').disabled,false)
      if(stage==='create')assert.equal(h.calls.length,0)
    }
  })
  test(file+': goal completion cannot change the phase of a different session',async()=>{
    const h=fixture(file),job=deferred();h.c.safeRpc=()=>job.promise
    vm.runInContext(section(h.source,'async function goalAction('),h.c)
    const p=h.c.goalAction('complete');h.state.current='B';job.resolve({ok:true});await p
    assert.ok(!h.calls.includes('phase'))
  })
  test(file+': question reply does not close a newer question modal',async()=>{
    const h=fixture(file),job=deferred();h.c.respond=()=>job.promise
    const old={rpcId:'old',sessionId:'A',questions:[{id:'answer'}]},next={rpcId:'new'}
    h.state.questionModal=old;h.state.questions=[old,next]
    vm.runInContext(section(h.source,'async function submitQuestion('),h.c)
    const p=h.c.submitQuestion();h.state.questionModal=next;job.resolve(true);await p
    assert.equal(h.$('modal-question').hidden,false);assert.equal(h.state.questions.length,1);assert.equal(h.state.questions[0],next)
  })
  test(file+': stale question or approval response cannot remove pending items or log out the new host',async()=>{
    for(const method of ['submitQuestion','approveApproval'])for(const failed of [false,true]){
      const h=fixture(file),job=deferred();h.c.respond=()=>job.promise
      const item={approvalId:'same',rpcId:'old',sessionId:'A',questions:[{id:'answer'}]}
      h.state.questionModal=item;h.state.questions=[item];h.state.approvals=[item]
      vm.runInContext(section(h.source,'async function '+method+'('),h.c)
      const p=h.c[method]('same',true);h.state.server='B'
      if(failed)job.reject(Error('AUTH'));else job.resolve(true);await p
      assert.equal(h.state.questions.length,1);assert.equal(h.state.approvals.length,1);assert.equal(h.calls.length,0);assert.equal(h.notices.length,0)
    }
  })
}
test('Desktop workbench binding stops before registering old directories on another host',async()=>{
  for(const stage of ['bind','list','register','refresh']){
    const h=fixture(files[1]),job=deferred(),reached=deferred(),mutations=[]
    async function pause(name,value){if(stage===name){reached.resolve();await job.promise}return value}
    h.c.wbGateway=()=>pause('bind',{path:'/A/root'})
    h.c.fetch=async()=>({ok:true,json:()=>pause('list',{entries:[{name:'project',type:'dir'}]})})
    h.c.rpc=async(method,payload)=>{mutations.push({host:h.state.server,path:payload.path});return pause('register',{})}
    h.c.refreshWorkbench=()=>pause('refresh',{})
    vm.runInContext(section(h.source,'async function bindWorkbench('),h.c)
    const p=h.c.bindWorkbench('/A/root');await reached.promise;h.state.server='B';job.resolve();await p
    assert.ok(mutations.every(m=>m.host==='A'));assert.equal(h.notices.length,0)
  }
})
test('Desktop workbench directory picker ignores reordered listings and closed modal requests',async()=>{
  const h=fixture(files[1]),jobs=[];h.c.fetch=()=>{const job=deferred();jobs.push(job);return job.promise}
  vm.runInContext("const wbFs={path:null,initial:null};this.wbFs=wbFs;"+section(h.source,'async function wbFsLoad(')+section(h.source,'function closeWorkbenchModal('),h.c)
  const first=h.c.wbFsLoad('/old'),second=h.c.wbFsLoad('/new')
  jobs[1].resolve({ok:true,json:async()=>({path:'/new',entries:[]})});await second
  jobs[0].resolve({ok:true,json:async()=>({path:'/old',entries:[]})});await first;assert.equal(h.c.wbFs.path,'/new')
  const pending=h.c.wbFsLoad('/closed');h.c.closeWorkbenchModal();jobs[2].resolve({ok:true,json:async()=>({path:'/closed',entries:[]})});await pending
  assert.equal(h.c.wbFs.path,'/new')
})
test('Desktop unbinding cannot erase the new host workbench',async()=>{
  const h=fixture(files[1]),job=deferred();h.c.wbGateway=()=>job.promise
  vm.runInContext(section(h.source,'async function unbindWorkbench('),h.c)
  const p=h.c.unbindWorkbench();h.state.server='B';const next={bound:true,path:'/B/root'};h.state.wb=next
  job.resolve({});await p;assert.equal(h.state.wb,next);assert.equal(h.notices.length,0)
})
test('Mobile goal editor keeps the session selected when the modal was opened',async()=>{
  const h=fixture(files[0]),sent=[];h.c.safeRpc=async(method,payload)=>{sent.push(payload);return {ok:true}}
  vm.runInContext(section(h.source,'function openGoalModal(')+section(h.source,'async function submitGoalEdit('),h.c)
  h.c.openGoalModal({id:'goal-A',revision:1});h.state.current='B';await h.c.submitGoalEdit();assert.equal(sent.length,0)
  h.c.openGoalModal({id:'goal-B',revision:1});await h.c.submitGoalEdit();assert.equal(sent[0].sessionId,'B')
})
test('Mobile model settings cannot request credentials or render old settings on a new host',async()=>{
  for(const stage of ['settings','credentials']){
    const h=fixture(files[0]),job=deferred(),reached=deferred(),methods=[]
    h.state.modelSettings={status:'idle'};h.c.renderModelSettings=()=>h.calls.push('render')
    h.c.modelObjectAt=()=>({});h.c.modelKeyRefFor=()=> 'KEY-A'
    h.c.rpc=async method=>{
      methods.push({method,host:h.state.server})
      if(method==='llm.providers')return {providers:[{provider:'p',settingsNs:'ns'}]}
      if((stage==='settings'&&method==='settings.describe')||(stage==='credentials'&&method==='credentials.describe')){reached.resolve();return job.promise}
      return {namespaces:[]}
    }
    vm.runInContext(section(h.source,'async function loadModelSettings('),h.c)
    const p=h.c.loadModelSettings();await reached.promise;h.state.server='B';const next={status:'idle'};h.state.modelSettings=next;job.resolve({});await p
    assert.ok(methods.every(v=>v.host==='A'));assert.equal(h.state.modelSettings,next);assert.deepEqual(h.calls,['render'])
  }
})
test('Mobile saving model configuration cannot write credentials to another host after settings.mutate',async()=>{
  for(const switched of [false,true]){
    const h=fixture(files[0]),job=deferred(),reached=deferred(),methods=[]
    h.state.modelSettings={writable:true};h.state.modelEditor={models:[],baseURLDirty:true,baseURL:'http://A',userProfile:{},keyDraft:'test-key',keyRef:'KEY-A',settingsNs:'ns',settingsPath:[],namespace:{revision:1}}
    Object.assign(h.c,{collectModelEditorForm(){},renderModelSettings(){},modelReasoningError:()=>'',MODEL_SETTINGS_FIELDS:['baseURL'],modelSettingsPathChanged:(a,b,k)=>a[k]!==b[k],loadModelSettings:async()=>{},setModelEditorError(){}})
    h.c.rpc=async method=>{methods.push({method,host:h.state.server});if(method==='settings.mutate'){reached.resolve();return job.promise}return {}}
    vm.runInContext(section(h.source,'async function saveModelEditor('),h.c)
    const p=h.c.saveModelEditor();await reached.promise;if(switched){h.state.server='B';h.state.modelEditor=null}job.resolve({revision:2});await p
    assert.ok(methods.every(v=>v.host==='A'))
    assert.deepEqual(methods.map(v=>v.method),switched?['settings.mutate']:['settings.mutate','credentials.set'])
  }
})
