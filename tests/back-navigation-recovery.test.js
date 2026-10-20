'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8')
function fixture(){
 const state={current:'a',byId:new Map([['a',{}],['b',{}]]),history:{loaded:true,visible:[],partialReasoning:new Map()},sessionActivity:new Set(),pendingPrompts:new Set(),queues:{},composerImages:[]},views=[],removed=[];let finish
 const c=vm.createContext({cancelHistoryLoad(){},state,captureConnection:()=>({valid:()=>true}),isEmptySessionHistory:h=>h.loaded&&h.visible.length===0&&!h.partialReasoning.size,
  archiveEmptySessionOnLeave:()=>new Promise(resolve=>{finish=resolve}),removeLocalSessionRecord:id=>removed.push(id),emptyHistory:()=>({loaded:false,visible:[]}),
  renderSessionPending(){},setComposerFullscreen(){},clearComposerImages(){},setSessionRecovery(){},hideComposerMenu(){},renderSessions(){},renderWorkbench(){},
  showView:id=>views.push(id),document:{body:{classList:{remove(){}}}},$:()=>({value:'',classList:{add(){}}})})
 vm.runInContext(source.slice(source.indexOf('function sessionHasPendingActivity('),source.indexOf('/* Android 手势返回')),c)
 return {c,state,views,removed,finish:value=>finish(value)}
}
test('Back navigates immediately while cleanup is pending; a later back is independent',async()=>{
 const h=fixture(),first=h.c.closeSession();assert.equal(h.state.current,null);assert.deepEqual(h.views,['view-home'])
 h.state.current='b';h.state.history={loaded:false,loading:true,visible:[]};await h.c.closeSession();assert.equal(h.state.current,null);assert.equal(h.views.length,2)
 h.finish(true);await first;assert.deepEqual(h.removed,['a'])
})
test('Unloaded or failed history is never treated as an empty disposable session',async()=>{
 const h=fixture();h.state.history={loaded:true,loading:false,renderError:true,visible:[],partialReasoning:new Map()};await h.c.closeSession();assert.equal(h.views.length,1);assert.equal(h.removed.length,0)
})

test('Back still leaves the chat after automatic server selection cleared the session id',async()=>{
 const h=fixture();h.state.current=null;h.state.history={loaded:false,loading:false,visible:[]}
 await h.c.closeSession();assert.deepEqual(h.views,['view-home']);assert.deepEqual(h.removed,[])
})

test('Desktop return navigates before a pending cleanup and does not overwrite a new session',async()=>{
 const s=fs.readFileSync(require('node:path').join(__dirname,'../public/desktop/desktop.js'),'utf8'),state={current:'a',byId:new Map(),history:{loaded:true}},views=[];let finish
 const c=vm.createContext({cancelHistoryLoad(){},state,archiveEmptySessionOnLeave:()=>new Promise(resolve=>{finish=resolve}),emptyDesktopHistory:()=>({loaded:false}),setSessionRecovery(){},renderQueue(){},renderSessionPendingDesktop(){},updateComposerStatus(){},updateSessionActions(){},showView:id=>views.push(id),$:()=>({})})
 vm.runInContext(s.slice(s.indexOf('async function closeSession('),s.indexOf('function restoreCachedSessionList(')),c)
 const pending=c.closeSession();assert.equal(state.current,null);assert.deepEqual(views,['view-sessions'])
 state.current='b';await c.closeSession();assert.equal(state.current,null);assert.equal(views.length,2)
 state.current='c';finish(true);await pending;assert.equal(state.current,'c')
})

for(const file of ['app.js','desktop/desktop.js'])test(file+': a failed cache render still fetches remote history',async()=>{
 const s=fs.readFileSync(require('node:path').join(__dirname,'../public',file),'utf8'),state={current:null,byId:new Map(),history:{}},calls=[]
 const empty=()=>({loaded:false,visible:[]}),noop=()=>{}
 const c=vm.createContext({cancelHistoryLoad(){},state,captureConnection:()=>({valid:()=>true}),emptyHistory:empty,emptyDesktopHistory:empty,getConversationView:()=>({reset:noop}),setSessionRecovery:noop,showView:noop,renderSessionTitle:noop,renderSessionSub:noop,updateCancelBtn:noop,updateSessionStatus:noop,updateSessionActions:noop,renderSessionCards:noop,renderQueue:noop,renderSessionPending:noop,renderSessionPendingDesktop:noop,updateComposerStatus:noop,refreshCompactionStatus:noop,renderSessions:noop,refreshSessions:noop,titleOf:()=>'',t:()=>'',document:{body:{classList:{add:noop}}},$:()=>({classList:{remove:noop,toggle:noop}}),
  restoreCachedHistory:async()=>{state.history.loaded=true;state.history.visible=['invalid cache'];throw Error('bad cache render')},loadHistory:async()=>{calls.push(state.history);assert.equal(state.history.loaded,false);assert.equal(state.history.visible.length,0)}})
 vm.runInContext(s.slice(s.indexOf('async function openSession('),s.indexOf(file==='app.js'?'function sessionHasPendingActivity(':'async function closeSession(')),c)
 await c.openSession('a');assert.equal(calls.length,1)
})
