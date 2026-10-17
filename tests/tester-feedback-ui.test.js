'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),vm=require('node:vm')
const mobile=fs.readFileSync('public/app.js','utf8').replaceAll('\r\n','\n')
function section(source,start){const a=source.indexOf(start),b=source.indexOf('\n}',a);assert.ok(a>=0&&b>a,start);return source.slice(a,b+2)}

test('Android back closes dialogs and settings subpages before returning home, and only exits from home',()=>{
  const hidden=new Set(['view-home','view-files','view-plugins','settings-home']),calls=[]
  let back,dialog=null,fullscreen=false,inSession=false
  const ctx={CAP:{isNativePlatform:()=>true,Plugins:{App:{addListener:(name,fn)=>{back=fn},exitApp:()=>calls.push('exit')}}},
    $:id=>({classList:{contains:name=>name==='fs'?fullscreen:hidden.has(id)}}),customSelectCurrent:null,
    groupDrawerOpen:()=>false,closeGroupDrawer(){},setComposerFullscreen:()=>{fullscreen=false;calls.push('fullscreen')},
    document:{querySelector:()=>dialog,querySelectorAll:()=>[],body:{classList:{contains:()=>inSession}}},
    showSettingsHome:()=>{hidden.delete('settings-home');calls.push('settings')},
    showView:id=>{hidden.delete(id);hidden.add('view-settings');calls.push(id)},closeSession:()=>calls.push('session'),state:{fs:{}}}
  vm.runInNewContext(section(mobile,'function bindNativeBack('),ctx);ctx.bindNativeBack()
  dialog={close:()=>{calls.push('dialog');dialog=null}};back();assert.deepEqual(calls,['dialog'])
  let imageOpen=true
  ctx.window={DshImagePreview:{isOpen:()=>imageOpen,close:()=>{imageOpen=false;calls.push('image')}}}
  back();assert.deepEqual(calls,['dialog','image'])
  back();assert.deepEqual(calls,['dialog','image','settings']);assert.ok(!calls.includes('exit'))
  back();assert.equal(calls.at(-1),'view-home')
  back();assert.equal(calls.at(-1),'exit')
  fullscreen=true;back();assert.equal(calls.at(-1),'fullscreen')
  inSession=true;back();assert.equal(calls.at(-1),'session')
})

for(const file of ['public/app.js','public/desktop/desktop.js']){
  const source=fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')
  test(file+': subagents have an open action, retain their parent, and return without archiving',async()=>{
    const state={current:'parent',server:'host',byId:new Map([['parent',{sessionId:'parent',cwd:'/work'}]])},opened=[]
    const ctx={state,openSession:id=>{state.current=id;opened.push(id)},
      setComposerFullscreen(){},clearComposerImages(){},hideComposerMenu(){},
      archiveEmptySessionOnLeave:()=>assert.fail('Child must not be archived on back')}
    vm.runInNewContext(section(source,'function rememberSubagent(')+'\n'+section(source,'async function openSubagentSession(')+'\n'+section(source,'async function closeSession('),ctx)
    await ctx.openSubagentSession('child','parent')
    assert.equal(state.byId.get('child').parentSessionId,'parent');assert.equal(state.byId.get('child').cwd,'/work')
    assert.deepEqual(opened,['child'])
    Object.assign(ctx,{captureConnection:()=>({valid:()=>true}),sessionsRequest:0,safeRpc:async()=>({items:[{sessionId:'parent'}]}),
      t:x=>x,applyPendingProjections(){},cacheWrite(){},CACHE:{},renderSessions(){},refreshWorkbench(){},
      scheduleWorkbenchRefresh(){},renderOverviewDesktop(){},LS:{set(){}},historyCacheScope:()=>''})
    vm.runInNewContext(section(source,'async function refreshSessions('),ctx)
    await ctx.refreshSessions()
    assert.equal(state.byId.get('child').parentSessionId,'parent','A list without the child must not break its back navigation')
    ctx.safeRpc=async()=>({items:[{sessionId:'parent'},{sessionId:'child',origin:'subagent',running:true}]})
    await ctx.refreshSessions()
    assert.equal(state.byId.get('child').parentSessionId,'parent','A compact child summary must retain its durable address')
    await ctx.closeSession();assert.deepEqual(opened,['child','parent'])
    state.current='elsewhere';await ctx.openSubagentSession('child','parent');assert.equal(opened.length,2)
    assert.match(source,/DshSubagents\?\.configure/);assert.match(source,/openSubagentSession\(entry.id, parentId, entry, sessionId\)/)
    state.current='parent';await ctx.openSubagentSession('grandchild','child',{mode:'one-shot'},'parent')
    assert.equal(state.byId.get('grandchild').parentSessionId,'child')
    assert.equal(state.byId.get('grandchild').subagentMode,'one-shot')
  })
  test(file+': empty subagents are never automatically archived',async()=>{
    const state={current:'child',server:'host',byId:new Map([['child',{sessionId:'child',parentSessionId:'parent',origin:'subagent'}]])}
    const ctx={state,captureConnection:()=>({valid:()=>true}),rpc:()=>assert.fail('Child archive must be skipped')}
    vm.runInNewContext(source.slice(source.indexOf('const emptySessionCleanup'),source.indexOf('async function openSession')),ctx)
    assert.equal(await ctx.archiveEmptySessionOnLeave('child'),false)
  })
}

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.events={};this.open=false;this.textContent=''}
  append(...nodes){for(const node of nodes){node.remove();this.children.push(node);node.parent=this}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);this.parent=null}
  replaceChildren(...nodes){for(const node of [...this.children])node.remove();this.append(...nodes)}
  contains(node){return this===node||this.children.some(child=>child.contains(node))}
  setAttribute(){} removeAttribute(){}
  querySelector(selector){return this.children.flatMap(child=>[child,...child.all()]).find(child=>selector==='h2'?child.tag==='h2':child.className===selector.slice(1))}
  querySelectorAll(){return []}
  all(){return this.children.flatMap(child=>[child,...child.all()])}
  addEventListener(event,handler){this.events[event]=handler}
  showModal(){this.open=true} close(){this.open=false;this.events.close?.()}
}
test('approvals and questions use the live list in the receipts dialog and restore it when leaving',async()=>{
  const source=fs.readFileSync('public/workflow.js','utf8'),nodes=new Map(),root={I18N:{lang:'zh'}}
  const attention=new Element('section'),list=new Element('div'),sheet=new Element('dialog'),body=new Element('div')
  body.className='workflow-sheet-body';sheet.append(new Element('h2'),body);attention.append(list)
  nodes.set('overview-attention-list',list)
  const document={createElement:tag=>new Element(tag),getElementById:id=>nodes.get(id),querySelectorAll:()=>[]}
  const config={desktop:false,operations:()=>({})},receipts=[]
  root.DshOperations={restore:async()=>{},pending:()=>receipts}
  const ctx=vm.createContext({window:root,document})
  vm.runInContext(source.replace('root.DshWorkflow={','root.testSetup=(c,s,a)=>{config=c;sheet=s;attention=a};root.testOpen=openSheet;root.DshWorkflow={'),ctx)
  root.testSetup(config,sheet,attention)
  const approval=new Element('button');approval.events.click=()=>receipts.push('clicked');list.append(approval)
  await root.DshWorkflow.showOperations()
  assert.equal(sheet.open,true);assert.ok(body.contains(list));assert.ok(!attention.contains(list))
  approval.events.click();assert.deepEqual(receipts,['clicked']);receipts.length=0
  const question=new Element('button');list.append(question);assert.ok(body.contains(question),'New pending events update the same visible list')
  root.testOpen('Models',new Element('div'));assert.ok(attention.contains(list));assert.ok(!body.contains(list))
  await root.DshWorkflow.showOperations();root.DshWorkflow.close();assert.equal(sheet.open,false);assert.ok(attention.contains(list))
})
