'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const backend=import('../packages/plugin/teams.mjs'),ui=require('../public/teams.js')
const team={teamId:'team-a',name:'团队 A',captainSessionId:'captain-a',workspace:'同名工作区',phase:'staged',deliverable:false,delivery:{ok:false,blockers:['等待人工检查']},members:[{id:'child-a',name:'开发',role:'实现',activity:'idle',executionPrompt:'SECRET PROMPT',provider:'p',model:'m'}],tasks:[{id:'task-a',subject:'验收',state:'blocked',status:'open',dependencies:['task-before']}],captainInbox:[{from:'开发',content:'待检查'}]}

test('mobile teams receives real workspaces and opens validated member records from the plugin page',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require('node:path').join(__dirname,'../public/app.js'),'utf8')
 const workspace={workspaceId:'selected',path:'/project',sessionIds:['captain']},state={wbProjects:[workspace],workspaceFilter:'selected',byId:new Map(),view:'view-plugins'};let config,remembered,opened
 const c=vm.createContext({state,window:{DshExtensions:{mount:value=>{config=value}}},$:()=>({classList:{contains:()=>state.view!=='view-plugins'}}),captureConnection:()=>({token:'fixture',valid:()=>true}),CAP:null,clientIdHeaders:()=>({}),
  workspaceItems:()=>state.wbProjects,workspaceById:id=>state.wbProjects.find(w=>w.workspaceId===id),workspaceForSession:()=>null,
  loadSessionSubagents:async()=>({entries:[{id:'child',mode:'one-shot'}]}),rememberSubagent:(entry,parent)=>{remembered={entry,parent}},openSession:async id=>{opened=id}})
 vm.runInContext(source.slice(source.indexOf('function openPluginPage(')),c)
 c.openPluginPage();assert.deepEqual(config.getWorkspaces(),[workspace]);assert.equal(config.getWorkspaceId(),'selected')
 await config.openTeamMember('child','captain');assert.equal(opened,'child');assert.equal(remembered.parent,'captain');assert.equal(remembered.entry.mode,'one-shot')
 opened=null;state.view='view-home';await config.openTeamMember('child','captain');assert.equal(opened,null)
})
test('workspace membership scopes identical titles and strips private plugin configuration',async()=>{
 const {summarizeTeams}=await backend
 const data=summarizeTeams({teams:[team,{...team,teamId:'other',captainSessionId:'captain-other'}],apiKey:'SECRET KEY'},{id:'w-a',title:'同名工作区',sessionIds:['captain-a']})
 assert.equal(data.teams.length,1);assert.equal(data.teams[0].teamId,'team-a');assert.doesNotMatch(JSON.stringify(data),/SECRET|executionPrompt|apiKey/)
 const html=ui.teamHtml(data.teams[0],0,false)
 assert.match(html,/受阻/);assert.match(html,/task-before/);assert.match(html,/交付尚未确认/);assert.match(html,/打开成员记录/)
 assert.doesNotMatch(ui.teamHtml(data.teams[0],0,true),/打开成员记录/)
})
test('teams bridge validates registered identity before fetching and refuses arbitrary paths or oversized responses',async()=>{
 const {readTeamInsights}=await backend,ctx={get:key=>key==='workspaceRegistry'?{list:()=>[{id:'w-a',sessionIds:['captain-a']}]}:undefined}
 let reads=0
 const fetchState=async()=>{reads++;return new Response(JSON.stringify({teams:[team]}))}
 for(const query of ['workspaceId=unknown','workspaceId=w-a&path=/private','workspaceId=w-a&workspaceId=other','workspaceId=w-a&archived=oops']){
  assert.ok((await readTeamInsights(ctx,new URLSearchParams(query),fetchState)).status>=400)
 }
 assert.equal(reads,0)
 const result=await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),fetchState);assert.equal(result.body.teams.length,1)
 assert.equal((await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),async()=>new Response('',{status:404}))).body.available,false)
 assert.equal((await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),async()=>new Response('',{status:404}))).body.code,'endpoint-missing')
 assert.equal((await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),async()=>new Response('',{status:401}))).body.code,'host-denied')
 assert.equal((await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),async()=>new Response('x'.repeat(2*1024*1024+1)))).status,502)
 assert.equal((await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),async()=>{throw Error('SECRET')})).body.code,'teams-unavailable')
})

test('teams bridge accepts an asynchronous workspace registry without bypassing membership validation',async()=>{
 const {readTeamInsights}=await backend
 const ctx={get:()=>({list:async()=>[{id:'w-a',sessionIds:['captain-a']}]})}
 const result=await readTeamInsights(ctx,new URLSearchParams('workspaceId=w-a'),async()=>new Response(JSON.stringify({teams:[team]})))
 assert.equal(result.body.teams[0].teamId,'team-a')
 const invalid={get:()=>({list:async()=>null})}
 assert.equal((await readTeamInsights(invalid,new URLSearchParams('workspaceId=w-a'),()=>{throw Error('must not fetch')})).body.code,'workspace-unavailable')
})
test('team labels, task content and messages stay text instead of executable markup',async()=>{
 const {summarizeTeams}=await backend
 const data=summarizeTeams({teams:[{...team,name:'<img src=x onerror=bad>',captainInbox:[{from:'"',content:'<script>bad</script>'}]}]},{id:'w',sessionIds:['captain-a']})
 const html=ui.teamHtml(data.teams[0],0,false);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/)
})
test('plan review, delivery blockers and warnings are distinct from a confirmed deliverable', async () => {
  const { summarizeTeams } = await backend
  const data = summarizeTeams({ teams: [{ ...team, planReviewState: 'awaiting_review', delivery: { ok: false, blockers: ['待补测试'], warnings: ['<script>warning</script>'] } }] }, { id: 'w', sessionIds: ['captain-a'] })
  const html = ui.teamHtml(data.teams[0], 0, false)
  assert.match(html, /<dt>计划审查<\/dt><dd>等待计划审查<\/dd>/); assert.match(html, /交付检查未通过/); assert.match(html, /交付警告/); assert.match(html, /待补测试/)
  assert.doesNotMatch(html, /<script>|插件报告可交付/)
  assert.match(ui.teamHtml({ ...data.teams[0], deliverable: true, delivery: { ok: true, warnings: ['提示'] } }, 0, false), /插件报告可交付/)
})

test('team member metadata has separate fields and repeated activity labels are collapsed', () => {
  const html = ui.teamHtml({...team,members:[{id:'child',name:'开发',activity:'idle',status:'idle',model:'model-long-id',currentTask:'检查布局\n保留原文换行'}]},0,false)
  assert.doesNotMatch(html,/未运行 · 未运行/)
  assert.match(html,/<dt>模型<\/dt><dd[^>]*>model-long-id<\/dd>/)
  assert.match(html,/<dt>当前任务<\/dt><dd[^>]*>检查布局\n保留原文换行<\/dd>/)
  assert.match(html,/<footer[^>]*><button[^>]*data-team-open="0"[^>]*data-team-member="child"/)
})

test('workspace switches abort old reads; stale responses and closed pages cannot replace another workspace',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),pending=[]
 class Element {
  constructor(){this.listeners={};this.children=new Map();this.innerHTML=''}
  querySelector(key){if(!this.children.has(key))this.children.set(key,new Element());return this.children.get(key)}
  querySelectorAll(){return []}
  addEventListener(key,fn){this.listeners[key]=fn}
  replaceChildren(){this.innerHTML=''}
 }
 const target=new Element(),root={},c=vm.createContext({window:root,document:{hidden:false},AbortController,AbortSignal,
  fetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})),setInterval:()=>1,clearInterval(){}})
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/teams.js'),'utf8'),c)
 const config={valid:()=>true,url:p=>p,headers:{},getWorkspaces:()=>[{workspaceId:'a'},{workspaceId:'b'}]}
 const first=root.DshTeams.mount(config,target),selector=target.querySelector('[data-teams-workspace]')
 selector.value='b';selector.listeners.change()
 assert.equal(pending[0].options.signal.aborted,true)
 pending[1].resolve({ok:true,text:async()=>JSON.stringify({ok:true,schema:1,available:true,workspaceId:'b',teams:[{...team,name:'Workspace B'}]})})
 await new Promise(r=>setImmediate(r))
 pending[0].resolve({ok:true,text:async()=>JSON.stringify({ok:true,schema:1,available:true,workspaceId:'a',teams:[{...team,name:'Workspace A'}]})})
 await first
 assert.match(target.querySelector('[data-teams-content]').innerHTML,/Workspace B/)
 assert.doesNotMatch(target.querySelector('[data-teams-content]').innerHTML,/Workspace A/)
 target.querySelector('[data-teams-refresh]').listeners.click()
 pending[2].resolve({ok:true,text:async()=>JSON.stringify({ok:true,schema:1,available:false})})
 await new Promise(r=>setImmediate(r));assert.equal(target.querySelector('[data-teams-content]').innerHTML,'')
 target.querySelector('[data-teams-refresh]').listeners.click()
 pending[3].resolve({ok:true,text:async()=>JSON.stringify({ok:true,schema:1,available:true,workspaceId:'b',teams:[{...team,name:'Workspace B'}]})})
 await new Promise(r=>setImmediate(r));assert.match(target.querySelector('[data-teams-content]').innerHTML,/Workspace B/,'Same data must reappear after service recovery')
 target.querySelector('[data-teams-refresh]').listeners.click();root.DshTeams.close()
 assert.equal(pending[4].options.signal.aborted,true)
})
