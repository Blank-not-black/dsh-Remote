'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const activity=require('../public/activity.js')
const read=file=>fs.readFileSync(path.join(__dirname,'../public',file),'utf8')
function fn(source,name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0,name);const end=source.indexOf('\nfunction ',start+1);return source.slice(start,end<0?undefined:end)}
const failed={seq:20,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{message:'provider timed out <script>',code:'TIMEOUT',status:504,secret:'never render'}}}}
const failureRow=seq=>({seq,event:{...failed,seq}})
const attemptRow=seq=>({seq,event:{seq,type:'assistant/attempt',data:{stream:[{type:'reasoning-chunks',index:0,texts:['retry reasoning '+seq]},{type:'chunk',chunk:{type:'finish',reason:{kind:'error',failure:{message:'provider timed out <script>',code:'TIMEOUT',status:504}}}}]}}})

test('consecutive failures collapse without altering durable history; appended retries reuse the disclosure key',()=>{
 const first=attemptRow(1),second=attemptRow(2),end=failureRow(3),tail={seq:4,event:{type:'turn/start'}}
 const rows=[first,second,end,tail],before=JSON.stringify(rows),grouped=activity.groupFailures(rows)
 assert.equal(grouped.length,2);assert.equal(grouped[1],tail)
 assert.deepEqual(grouped[0].view.failureGroup.items,[first,second,end]);assert.equal(grouped[0].view.failureGroup.count,3)
 assert.equal(JSON.stringify(rows),before)
 assert.equal(activity.groupFailures(rows)[0],grouped[0],'unchanged groups retain identity for the history renderer')
 const grown=activity.groupFailures([...rows,attemptRow(5)])[0]
 assert.equal(grown.seq,grouped[0].seq);assert.equal(grown.view.failureGroup.count,4)
 const html=activity.failureGroupHtml(grouped[0].view.failureGroup,entry=>activity.attemptHtml(entry.event)||activity.failureHtml(activity.failure(entry.event)))
 const next=activity.failureGroupHtml(grown.view.failureGroup,()=> '')
 assert.match(html,/连续报错 · 3 条/);assert.match(html,/data-activity-key="failure-group:1"/);assert.match(next,/data-activity-key="failure-group:1"/)
 assert.doesNotMatch(html,/<details[^>]*\sopen(?:\s|>)|<script>|never render/)
 assert.match(html,/retry reasoning 1/);assert.match(html,/retry reasoning 2/);assert.match(html,/&lt;script&gt;/)
})

test('grouping bridges only retry lifecycle markers and keeps single failures, successful replies and user boundaries intact',()=>{
 const first=failureRow(1),status={seq:2,event:{type:'agent/status',data:{running:true}}},start={seq:3,event:{type:'turn/start'}},second=failureRow(4)
 const grouped=activity.groupFailures([first,status,start,second])
 assert.equal(grouped.length,1);assert.deepEqual(grouped[0].view.failureGroup.items,[first,status,start,second]);assert.equal(grouped[0].view.failureGroup.count,2)
 for(const type of ['user/message','assistant/message','tool/call','tool/result','turn/end','assistant/attempt','question/asked']){
  const boundary={seq:2,event:{type,data:{reason:{kind:'completed'}}}},last=failureRow(3)
  assert.deepEqual(activity.groupFailures([first,boundary,last]),[first,boundary,last],type)
 }
 assert.deepEqual(activity.groupFailures([first]),[first]);assert.deepEqual(activity.groupFailures([]),[])
 const different=failureRow(5);different.event={...different.event,data:{reason:{kind:'error',error:{message:'rate limited',code:'RATE_LIMIT',status:429}}}}
 const mixed=activity.groupFailures([first,different])[0].view.failureGroup
 const html=activity.failureGroupHtml(mixed,entry=>activity.failureHtml(activity.failure(entry.event)))
 assert.match(html,/TIMEOUT/);assert.match(html,/RATE_LIMIT/);assert.match(html,/HTTP 429/)
})

test('DSH structured turn failures and unsuccessful attempts retain escaped provider facts and reasoning',()=>{
 const html=activity.failureHtml(activity.failure(failed))
 assert.match(html,/provider timed out &lt;script&gt;/);assert.match(html,/TIMEOUT/);assert.match(html,/HTTP 504/);assert.doesNotMatch(html,/never render|<script>/)
 assert.equal(activity.failure({type:'turn/end',data:{reason:{kind:'aborted'}}}),null)
 const event={seq:19,type:'assistant/attempt',data:{stream:[{type:'reasoning-chunks',index:0,texts:['先','分析']},{type:'chunk',chunk:{type:'reasoning-delta',index:0,text:'问题'}},{type:'chunk',chunk:{type:'finish',reason:{kind:'error',failure:{message:'timeout',code:'TIMEOUT'}}}}]}}
 assert.match(activity.attemptHtml(event),/先分析问题/);assert.match(activity.attemptHtml(event),/timeout/)
 event.data.stream.push({type:'chunk',chunk:{type:'block-end',index:0,block:{type:'reasoning',text:'完整思考'}}})
 assert.match(activity.attemptHtml(event),/完整思考/);assert.doesNotMatch(activity.attemptHtml(event),/先分析问题/)
})

for(const file of ['app.js','desktop/desktop.js']) {
 const source=read(file)
 test(file+': an unrelated Auto permission restore failure never reports that the new conversation failed',()=>{
  const notices=[],saved=new Map(),state={current:'new',byId:new Map([['old',{running:false}],['new',{running:false}]])}
  const c=vm.createContext({state,rememberRuntimeError:(id,msg)=>saved.set(id,msg),toast:(...args)=>notices.push(args),t:(_key,p)=>p?.msg||'',renderSessionSub(){},updateSessionStatus(){},renderQueue(){},updateComposerStatus(){}})
  vm.runInContext(fn(source,'onHostFrame'),c)
  const message='resume failed for session "old": Error: permission: cannot restore preset "auto" without its active integration'
  c.onHostFrame({payload:{type:'host/agent-error',sessionId:'old',message}})
  assert.equal(saved.get('old'),message);assert.equal(state.byId.get('old').error,true)
  assert.equal(notices.length,0)
  c.onHostFrame({payload:{type:'host/agent-error',sessionId:'new',message:'current session failure'}})
  assert.equal(notices.length,1)
 })
 test(file+': errors remain visible with or without a turn footer; attempts survive event filtering',()=>{
  const c=vm.createContext({window:{DshActivity:activity,DshTurnResults:{html:()=>'<footer>usage</footer>'}}})
  vm.runInContext(fn(source,'eventHtml'),c)
  assert.match(c.eventHtml({seq:20,event:failed}),/TIMEOUT/)
  assert.match(c.eventHtml({seq:20,event:failed,view:{turnResult:{}}}),/TIMEOUT[\s\S]*<footer>/)
  assert.equal(c.eventHtml({event:{type:'turn/end',data:{reason:{kind:'completed'}}}}),'')
  const start=source.indexOf('const INTERESTING_EVENTS'),end=source.indexOf('function messageSource',start)
  vm.runInContext(source.slice(start,end)+';this.types=INTERESTING_EVENTS',c)
  assert.ok(c.types.has('assistant/attempt'))
 })
 test(file+': grouped errors preserve individual details, reasoning and turn actions behind one closed disclosure',()=>{
  const c=vm.createContext({window:{DshActivity:activity,DshTurnResults:{html:()=>'<footer>usage</footer>'}}})
  vm.runInContext(fn(source,'eventHtml'),c)
  const end={...failureRow(3),view:{turnResult:{}}},rows=[attemptRow(1),attemptRow(2),end]
  const html=c.eventHtml(activity.groupFailures(rows)[0])
  assert.equal((html.match(/data-activity-key="failure-group:/g)||[]).length,1)
  assert.match(html,/连续报错 · 3 条/);assert.match(html,/retry reasoning 1/);assert.match(html,/retry reasoning 2/)
  assert.match(html,/TIMEOUT[\s\S]*<footer>usage<\/footer>/);assert.doesNotMatch(html,/<script>|never render|<details[^>]*\sopen(?:\s|>)/)
  // Exercise the actual history pipeline so a missing hook cannot silently leave grouping unused.
  let prepared
  c.state={current:'a',history:{visible:rows},byId:new Map()};c.weakStreamTrim=()=>false;c.filteredEntries=()=>rows
  c.$=()=>({textContent:''});c.t=()=>'';c.canForkTurnResult=()=>false;c.bindTurnResultActions=()=>{}
  c.partialReasoningHtml=()=>'';c.getConversationView=()=>({set:entries=>{prepared=entries}})
  c.window.DshTurnResults.decorate=entries=>entries
  vm.runInContext(fn(source,'renderHistory'),c);c.renderHistory()
  assert.equal(prepared.length,1);assert.equal(prepared[0].view.failureGroup.count,3)
 })
 function scheduler(){
  let valid=true,calls=0,rendered=0;const tasks=[]
  const state={current:'a',token:'test',history:{loading:false},byId:new Map([['a',{running:true}],['b',{running:true}]])}
  const c=vm.createContext({state,Date,Map,navigator:{onLine:true},document:{visibilityState:'visible'},captureConnection:()=>({valid:()=>valid}),setTimeout:(run,delay)=>{tasks.push({run,delay});return tasks.length},resyncCurrentSession:async()=>{calls++},renderHistory:()=>rendered++})
  for(const name of ['scheduleSessionSync','sessionSyncTick','rememberRuntimeError'])vm.runInContext(fn(source,name),c)
  return {c,state,tasks,step:()=>tasks.shift()?.run(),calls:()=>calls,rendered:()=>rendered,invalidate:()=>{valid=false}}
 }
 test(file+': missed reply recovery coalesces activity signals, waits for loading and rejects stale sessions/identities',()=>{
  const h=scheduler();h.state.history.loading=true
  h.c.scheduleSessionSync('b');assert.equal(h.tasks.length,0)
  h.c.scheduleSessionSync('a');h.c.scheduleSessionSync('a');assert.equal(h.tasks.length,1)
  h.step();assert.equal(h.calls(),0);assert.equal(h.tasks.length,1)
  h.state.history.loading=false;h.step();assert.equal(h.calls(),1)
  h.c.scheduleSessionSync('a');h.state.current='b';h.step();assert.equal(h.calls(),1)
  h.state.current='a';h.c.scheduleSessionSync('a');h.invalidate();h.step();assert.equal(h.calls(),1)
 })
 test(file+': an OPEN socket cannot prevent periodic history repair; hidden/offline/recent reads skip it',()=>{
  const h=scheduler();h.c.sessionSyncTick();h.step();assert.equal(h.calls(),1)
  h.state.history.lastSyncAt=Date.now();h.c.sessionSyncTick();assert.equal(h.tasks.length,0)
  h.state.history.lastSyncAt=0;h.c.document.visibilityState='hidden';h.c.sessionSyncTick();assert.equal(h.tasks.length,0)
  h.c.document.visibilityState='visible';h.c.navigator.onLine=false;h.c.sessionSyncTick();assert.equal(h.tasks.length,0)
  h.c.navigator.onLine=true;h.state.history.lastSyncAt=Date.now();h.c.scheduleSessionSync();assert.ok(h.tasks[0].delay>=1500)
 })
 test(file+': host-only failures are retained per conversation instead of depending on a toast',()=>{
  const h=scheduler();h.c.rememberRuntimeError('b','other timeout');assert.equal(h.rendered(),0)
  h.c.rememberRuntimeError('a','provider timeout');assert.equal(h.state.runtimeErrors.get('a'),'provider timeout');assert.equal(h.rendered(),1)
  assert.equal(h.state.runtimeErrors.get('b'),'other timeout')
  const host=fn(source,'onHostFrame');assert.match(host,/host\/agent-error/);assert.match(host,/rememberRuntimeError/)
  for(const name of ['renderQueue','updateComposerStatus','renderSessionSub','updateSessionStatus','renderSessionCards','updateCancelBtn','renderSessions','renderOverviewDesktop','renderOverview','toast'])h.c[name]=()=>{}
  h.c.t=key=>key
  vm.runInContext(host,h.c)
  h.c.onHostFrame({payload:{type:'host/agent-error',sessionId:'a',message:'host failure'}})
  assert.equal(h.state.byId.get('a').running,false);assert.equal(h.state.byId.get('a').error,true)
  assert.equal(h.state.runtimeErrors.get('a'),'host failure')
  h.c.onHostFrame({payload:{type:'host/session-status',sessionId:'a',running:true}})
  assert.equal(h.state.runtimeErrors.has('a'),false);assert.equal(h.state.byId.get('a').error,false)
  const c=vm.createContext({state:{history:{partialReasoning:new Map([['x',{text:'thinking'}]])}},window:{DshActivity:activity},weakStreamTrim:()=>true})
  vm.runInContext(fn(source,'partialReasoningHtml'),c);assert.match(c.partialReasoningHtml(),/弱网精简/)
 })
}
