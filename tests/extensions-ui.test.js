'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const names=['@linxin666/dsh-client-ui-skill-explorer','dsh-cost-meter','dsh-context']
const snapshot=(selected=names)=>({ok:true,runtimeAvailable:true,items:selected.map(name=>({name,enabled:true})),runtime:selected.map(name=>({name,phase:'active',enabled:true}))})
class Element{
 constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.className='';this.dataset={};this.attributes={};this.classList={add:name=>{this.className+=' '+name},remove:name=>{this.className=this.className.split(' ').filter(x=>x!==name).join(' ')},contains:name=>this.className.split(' ').includes(name)}}
 append(...els){this.children.push(...els)}
 replaceChildren(...els){this.children=els}
 addEventListener(name,fn){this.listeners[name]=fn}
 click(){this.listeners.click?.()}
 setAttribute(key,value){this.attributes[key]=value}
 contains(el){return el===this||this.all().includes(el)}
 focus(){if(this.ownerDocument)this.ownerDocument.activeElement=this}
 querySelectorAll(){return this.all().filter(el=>el.attributes.role==='menuitem'&&!el.disabled)}
 all(){return this.children.flatMap(el=>[el,...el.all()])}
}
function fixture(fetchImpl){
 const calls=[],scroller={scrollTop:150},modules={DshSkillsCenter:{close(){},back:()=>false,mount:(...args)=>calls.push(['skills',...args])},DshPluginCenter:{close(){},mount:(...args)=>calls.push(['manage',...args]),pause:()=>calls.push(['pause']),resume:()=>calls.push(['resume'])},DshInsights:{close(){},mount:(...args)=>calls.push(['insights',...args])}}
 const doc={scrollingElement:scroller,listeners:{},addEventListener(name,fn){(this.listeners[name]||=[]).push(fn)},createElement(tag){const el=new Element(tag);el.ownerDocument=this;return el}}
 const c=vm.createContext({window:modules,URL,Date,AbortController,AbortSignal,fetch:fetchImpl|| (async()=>({ok:true,text:async()=>JSON.stringify(snapshot())})),document:doc})
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/extensions.js'),'utf8'),c)
 let valid=true
 const target=new Element('section'),config={connection:{server:'http://host:8787',token:'test-only',valid:()=>valid},valid:()=>valid,url:p=>'http://host:8787'+p,headers:{},getSession:()=>({sessionId:'A'}),openContext:()=>calls.push(['context']),scrollTop:()=>{scroller.scrollTop=0}}
 return {api:c.window.DshExtensions,target,config,calls,modules,scroller,doc,setValid:value=>{valid=value},find:label=>target.all().find(e=>e.textContent===label)}
}

test('topbar shortcuts discover active adapted plugins, gate session context and open exact routes', async () => {
 const all=[...names,'@nanmicoder/dsh-agent-teams','@linxin666/dsh-client-ui-task-board'],raw=snapshot(all)
 raw.runtime.find(row=>row.name===all[4]).phase='failed'
 let reads=0,session=false;const opened=[],h=fixture(async()=>{reads++;return{ok:true,text:async()=>JSON.stringify(raw)}})
 const trigger=h.doc.createElement('button'),menu=h.doc.createElement('div');menu.className='hidden'
 h.api.bindShortcuts({trigger,menu,config:()=>h.config,connected:()=>true,hasSession:()=>session,open:route=>opened.push(route)})
 trigger.click();await tick()
 assert.equal(menu.classList.contains('hidden'),false,'first capability request must not close the menu')
 const items=menu.all().filter(el=>el.dataset.pluginShortcut)
 assert.deepEqual(items.map(el=>el.dataset.pluginShortcut),['skills','teams','cost','context'])
 assert.equal(items.find(el=>el.dataset.pluginShortcut==='context').disabled,true)
 items.find(el=>el.dataset.pluginShortcut==='cost').click();assert.deepEqual(opened,['cost']);assert.equal(menu.classList.contains('hidden'),true)
 session=true;trigger.click();await tick();assert.equal(reads,1,'reuse the existing bounded inventory cache')
 menu.all().find(el=>el.dataset.pluginShortcut==='context').click();assert.equal(opened.at(-1),'context')
})

test('shortcut empty/offline states, keyboard closing and late responses never open the wrong host', async () => {
 let resolve;const opened=[],h=fixture(()=>new Promise(r=>{resolve=r})),trigger=h.doc.createElement('button'),menu=h.doc.createElement('div')
 h.api.bindShortcuts({trigger,menu,config:()=>h.config,connected:()=>true,hasSession:()=>true,open:route=>opened.push(route)})
 trigger.click();h.api.closeShortcuts();h.setValid(false)
 resolve({ok:true,text:async()=>JSON.stringify(snapshot())});await tick()
 assert.equal(menu.classList.contains('hidden'),true);assert.equal(menu.all().some(el=>el.dataset.pluginShortcut),false)
 h.setValid(true);h.api.remember(h.config,snapshot([]));trigger.click();await tick()
 assert.ok(menu.all().some(el=>el.textContent==='暂无可快捷打开的插件'))
 menu.listeners.keydown({key:'Escape',preventDefault(){},stopPropagation(){}})
 assert.equal(h.doc.activeElement,trigger);assert.equal(trigger.attributes['aria-expanded'],'false')
})
test('default page is plugin management and dedicated views return to the retained list and scroll',async()=>{
 const h=fixture();h.api.mount(h.config,h.target);await tick()
 assert.deepEqual(h.calls.map(c=>c[0]),['manage']);assert.equal(h.target.all().some(e=>e.className==='ext-card'),false)
 const manager=h.calls[0][2],onFeature=h.calls[0][1].onFeature
 await onFeature('skills');assert.equal(h.calls.at(-1)[0],'skills');assert.equal(h.calls.at(-1)[3].dedicated,true)
 h.modules.DshSkillsCenter.back=()=>true
 h.find('← 返回插件列表').click();await tick();assert.equal(h.scroller.scrollTop,150);assert.equal(h.calls.at(-1)[0],'resume');assert.equal(h.calls.filter(c=>c[0]==='manage').length,1)
 await onFeature('cost');assert.equal(h.calls.at(-1)[1].hostOverview,true);assert.deepEqual(Array.from(h.calls.at(-1)[1].allowedTabs),['cost']);assert.equal(h.calls[0][2],manager)
 h.api.close()
})

test('a direct shortcut mounts its dedicated interface first and loads management only on back', async () => {
 const h=fixture();h.api.remember(h.config,snapshot());h.api.mount(h.config,h.target,'skills');await tick()
 assert.equal(h.calls.filter(row=>row[0]==='manage').length,0)
 assert.equal(h.calls.at(-1)[0],'skills')
 h.find('← 返回插件列表').click();await tick()
 assert.equal(h.calls.at(-1)[0],'manage');h.api.close()
})
test('plugin navigation returns to More only from the manager, retaining nested back behavior',async()=>{
 const h=fixture();h.config.back=()=>h.calls.push(['more']);h.api.mount(h.config,h.target);await tick()
 const manager=h.calls.find(call=>call[0]==='manage'),back=h.find('← 返回更多')
 assert.ok(back);back.click();assert.equal(h.calls.at(-1)[0],'more')
 await manager[1].onFeature('skills');h.find('← 返回插件列表').click();await tick()
 assert.equal(h.calls.at(-1)[0],'resume');assert.equal(h.calls.filter(call=>call[0]==='more').length,1)
 h.setValid(false);h.find('← 返回更多').click();assert.equal(h.calls.at(-1)[0],'resume')
 h.api.close()
})
test('availability requires exact installed package, enabled config, and confirmed active runtime',()=>{
 const h=fixture(),raw=snapshot();assert.deepEqual({...h.api.capabilitiesOf(raw)},{known:true,skills:true,cost:true,context:true,teams:false,tasks:false})
 for(const change of [s=>{s.runtimeAvailable=false},s=>{s.runtime=[]},s=>{s.items.forEach(r=>r.enabled=false)},s=>{s.runtime.forEach(r=>r.phase='pending')},s=>{s.runtime.forEach(r=>r.phase='failed')}]){
  const s=snapshot();change(s);assert.equal(h.api.featuresFor(s,{name:names[0]}).length,0)
 }
 assert.equal(h.api.featuresFor(raw,{name:'dsh-other-skill-explorer'}).length,0)
 assert.equal(h.api.featuresFor(raw,{name:names[2]},false).length,0)
 assert.equal(h.api.featuresFor(raw,{name:names[2]},true)[0].id,'context')
 assert.equal(h.api.capabilitiesOf({ok:true,items:[]}).known,false)
 assert.deepEqual({...h.api.capabilitiesOf(snapshot([names[1]]))},{known:true,skills:false,cost:true,context:false,teams:false,tasks:false})
 const s=snapshot();s.items[0].runtime=[{phase:'disposed'}];assert.equal(h.api.capabilitiesOf(s).skills,false)
})
test('adapter diagnostics distinguish lifecycle and read evidence without polling feature contents', async () => {
  let reads = 0
  const h = fixture(async () => { reads++; throw Error('No feature fetch allowed') }), raw = snapshot([names[1]]), item = raw.items[0]
  h.api.remember(h.config, raw)
  const code = () => h.api.diagnosticsFor(raw, item, h.config)[0].code
  assert.equal(code(), 'unverified')
  h.api.reportAvailability(h.config, 'cost', { ok: true }); assert.equal(code(), 'available')
  h.api.reportAvailability(h.config, 'cost', { code: 'timeout', error: 'SECRET' }); assert.equal(code(), 'timeout')
  assert.doesNotMatch(JSON.stringify(h.api.diagnosticsFor(raw, item, h.config)), /SECRET/)
  raw.adaptations = { cost: { supported: false } }; assert.equal(code(), 'unsupported'); assert.equal(h.api.capabilitiesOf(raw).cost, false)
  delete raw.adaptations; item.version = 'new'; assert.equal(code(), 'unverified')
  item.enabled = false; assert.equal(code(), 'disabled'); item.enabled = true
  raw.runtime[0].phase = 'failed'; assert.equal(code(), 'runtime-failed')
  raw.runtime[0].phase = 'pending'; assert.equal(code(), 'waiting')
  raw.runtimeAvailable = false; assert.equal(code(), 'runtime-unknown')
  raw.pendingRestart = true; raw.operations = [{ name: names[1], phase: 'complete', restartRequired: true }]; assert.equal(code(), 'restart-required')
  h.api.invalidateCapabilities(); h.api.reportAvailability(h.config, 'cost', { ok: true }); assert.equal(reads, 0)
})
test('context uses session action and stale manager callbacks cannot open a view on another host',async()=>{
 const h=fixture();h.api.mount(h.config,h.target);await tick();const old=h.calls[0][1].onFeature
 await old('context');assert.equal(h.calls.at(-1)[0],'context')
 h.api.mount({...h.config,connection:{...h.config.connection,server:'http://other'}},h.target);await tick()
 const before=h.calls.length;await old('skills');assert.equal(h.calls.length,before);h.api.close()
})
test('capability requests coalesce, reject old host responses, and cannot overwrite a fresher inventory',async()=>{
 const pending=[],h=fixture((url,init)=>new Promise(resolve=>pending.push({url,init,resolve})))
 const p1=h.api.getCapabilities(h.config),p2=h.api.getCapabilities(h.config);assert.equal(pending.length,1)
 h.api.remember(h.config,snapshot([names[1]]));pending[0].resolve({ok:true,text:async()=>JSON.stringify(snapshot())})
 assert.equal((await p1).skills,false);assert.equal((await p2).cost,true)
 h.api.invalidateCapabilities();const old=h.api.getCapabilities(h.config)
 const other={...h.config,connection:{...h.config.connection,server:'http://other'},url:p=>'http://other'+p}
 const fresh=h.api.getCapabilities(other);assert.equal(pending[1].init.signal.aborted,true)
 pending[1].resolve({ok:true,text:async()=>JSON.stringify(snapshot())});pending[2].resolve({ok:true,text:async()=>JSON.stringify(snapshot([]))})
 assert.equal((await old).known,false);assert.equal((await fresh).skills,false)
})
test('unknown, unreachable and disabled plugins never mount a promoted feature or fetch their data',async()=>{
 for(const body of [null,snapshot([]),{...snapshot(),runtimeAvailable:false}]){
  let reads=0;const h=fixture(async url=>{reads++;assert.ok(url.endsWith('/plugins/state'));if(body===null)throw Error('offline');return{ok:true,text:async()=>JSON.stringify(body)}})
  h.api.mount(h.config,h.target,'skills');await tick();await tick();assert.equal(h.calls.some(c=>c[0]==='skills'),false);assert.equal(reads,1);h.api.close()
 }
})

test('AgentTeams entry requires the exact active package and returns to the retained manager',async()=>{
 const h=fixture(),name='@nanmicoder/dsh-agent-teams',raw=snapshot([name])
 assert.equal(h.api.capabilitiesOf(raw).teams,true)
 assert.equal(h.api.featuresFor(raw,{name})[0].id,'teams')
 assert.equal(h.api.featuresFor(raw,{name:'dsh-agent-teams'}).length,0)
 h.modules.DshTeams={mount:()=>h.calls.push(['teams']),close:()=>{}}
 h.api.remember(h.config,raw);h.api.mount(h.config,h.target);await tick()
 const manager=h.calls.find(row=>row[0]==='manage')
 await manager[1].onFeature('teams');assert.equal(h.calls.at(-1)[0],'teams')
 h.find('← 返回插件列表').click();await tick();assert.equal(h.calls.at(-1)[0],'resume')
 h.api.close()
})
test('task board is an optional installed-plugin view with retained manager navigation', async () => {
  const h = fixture(), name = '@linxin666/dsh-client-ui-task-board', raw = snapshot([name])
  assert.equal(h.api.capabilitiesOf(raw).tasks,true)
  h.modules.DshTasks = { mount:()=>h.calls.push(['tasks']),close:()=>{} }
  h.api.remember(h.config,raw);h.api.mount(h.config,h.target);await tick()
  await h.calls.find(row=>row[0]==='manage')[1].onFeature('tasks')
  assert.equal(h.calls.at(-1)[0],'tasks')
  h.find('← 返回插件列表').click();await tick();assert.equal(h.calls.at(-1)[0],'resume');h.api.close()
})
