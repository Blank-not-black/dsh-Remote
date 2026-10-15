'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
const md=require('../public/md.js')
function section(source,start){const a=source.indexOf(start),b=source.indexOf('\n}',a);assert.ok(a>=0&&b>a,start);return source.slice(a,b+2)}
for(const file of ['public/app.js','public/desktop/desktop.js']){
 test(file+': a long question has a short card, a whole-card answer entry, and full safe Markdown in its modal',()=>{
  const source=fs.readFileSync(file,'utf8').replaceAll('\r\n','\n'),desktop=file.includes('/desktop/')
  const question={rpcId:'rpc-long',sessionId:'S',questions:[{id:'choice',header:'选择能力',question:'**完整的问题** [差异表](团队/差异表.md)\n'+('长说明 '.repeat(300))+'<img src=x onerror=bad>',multiSelect:true,options:[{label:'能力一',description:'详细说明'},{label:'能力二'}]}]}
  const button={dataset:{sessionQuestion:'rpc-long'},addEventListener:(event,fn)=>button[event]=fn},els=new Map()
  const $=id=>{if(!els.has(id))els.set(id,{innerHTML:'',scrollTop:12,classList:{toggle(){},remove(){},add(){}},querySelectorAll:selector=>selector==='[data-session-question]'?[button]:[]});return els.get(id)}
  const ctx=vm.createContext({state:{current:'S',approvals:[],questions:[question]},$,window:{mdToHtml:md},esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),t:key=>key,fitQuestionViewport(){}})
  for(const fn of ['function questionSummary(','function questionMarkup(','function openQuestionModal(',desktop?'function renderSessionPendingDesktop(':'function renderSessionPending('])vm.runInContext(section(source,fn),ctx)
  ctx[desktop?'renderSessionPendingDesktop':'renderSessionPending']()
  const card=$('session-pending').innerHTML
  assert.match(card,/<button type="button"[^>]+data-session-question/);assert.ok(card.length<1000);assert.doesNotMatch(card,/onerror/)
  button.click();const body=$('question-body').innerHTML
  assert.match(body,/<strong>完整的问题<\/strong>/);assert.match(body,/data-dsh-file-path="团队\/差异表.md"/)
  assert.match(body,/type="checkbox"/);assert.match(body,/能力二/);assert.doesNotMatch(body,/<img/);assert.ok(body.length>question.questions[0].question.length)
  assert.equal($('question-body').scrollTop,0)
 })
}
test('question Markdown keeps embedded HTML/UI fences as source',()=>{
 for(const code of ['```html\n<button onclick="bad()">bad</button>\n```','```dsh-ui\n{"type":"text","content":"test"}\n```']){
  const html=md(code,{richContent:false});assert.match(html,/<pre><code>/);assert.doesNotMatch(html,/<iframe|class="genui/)
 }
})
test('a question resolved on another device closes only that question dialog',()=>{
 const source=fs.readFileSync('public/app.js','utf8').replaceAll('\r\n','\n'),hidden=[]
 const ctx=vm.createContext({state:{questions:[{rpcId:'old'},{rpcId:'new'}],questionModal:{rpcId:'new'}},$:id=>({classList:{add:()=>hidden.push(id)}}),clearPendingNotification(){},renderPending(){}})
 vm.runInContext(section(source,'function onMuxFrame('),ctx)
 ctx.onMuxFrame({payload:{type:'question/resolved',questionRpcId:'old'}});assert.equal(hidden.length,0);assert.equal(ctx.state.questions.length,1)
 ctx.onMuxFrame({payload:{type:'question/resolved',questionRpcId:'new'}});assert.deepEqual(hidden,['modal-question']);assert.equal(ctx.state.questionModal,null)
})
test('notification clicks select their own host and session, while stale async navigation cannot switch the user back',async()=>{
 const source=fs.readFileSync('public/app.js','utf8').replaceAll('\r\n','\n'),raw=JSON.stringify({identity:'identity-B',sessionId:'B'}),calls=[]
 let release,valid=true,pendingRaw=raw
 const state={server:'host-A',token:'token-A',servers:[{url:'host-B',token:'token-B',group:'g',id:'B'}],groupActive:{},byId:new Map([['B',{}]])}
 const bridge={getPendingNavigation:()=>pendingRaw,matchesPendingNavigation:(base,token,id)=>base==='host-B'&&token==='token-B'&&id==='identity-B',acknowledgePendingNavigation:()=>{calls.push('ack');pendingRaw=''}}
 const ctx=vm.createContext({state,window:{NativeBackground:bridge},pendingNavigationBusy:false,pendingNavigationReady:true,JSON,bgBase:()=>state.server,serverToken:s=>s.token,captureConnection:()=>({valid:()=>valid}),LS:{set(){}},saveServers(){},syncBgConfig(){},renderServers(){},openStreams:()=>calls.push('streams'),refreshSessions:()=>new Promise(r=>release=r),openSession:id=>calls.push(id),toast(){},t:key=>key,showView(){}})
 vm.runInContext(section(source,'async function openPendingNavigation('),ctx)
 const pending=ctx.openPendingNavigation();assert.equal(state.server,'host-B');assert.equal(state.token,'token-B');valid=false;release();await pending;assert.deepEqual(calls,['streams','ack'])
 valid=true;await ctx.openPendingNavigation();assert.deepEqual(calls,['streams','ack'])
 pendingRaw=raw;const next=ctx.openPendingNavigation();release();await next;assert.deepEqual(calls,['streams','ack','ack','B'])
})
