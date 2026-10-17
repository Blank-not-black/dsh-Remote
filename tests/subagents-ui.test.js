'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.events={};this.textContent=''}
  append(...nodes){for(const n of nodes){n.remove();this.children.push(n);n.parent=this}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null}
  replaceChildren(){for(const n of [...this.children])n.remove()}
  setAttribute(k,v){this.attrs[k]=v}
  addEventListener(k,v){this.events[k]=v}
  querySelectorAll(){return this.all().filter(n=>n.dataset.subFocus)}
  all(){return this.children.flatMap(n=>[n,...n.all()])}
  focus(){}
  showModal(){this.open=true}
  close(){this.open=false;this.events.close?.()}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
function setup(read,clock=Date,entryOnly=false){
  const window={},document={createElement:tag=>new Element(tag),body:new Element('body')},target=new Element('div'),opened=[],remembered=[],stopped=[]
  vm.runInNewContext(fs.readFileSync('public/subagents.js','utf8'),{window,document,Date:clock})
  let active=true
  const options={sessionId:'parent',valid:()=>active,read,remember:(e,p)=>remembered.push([e.id,p]),open:(e,p)=>opened.push([e.id,p]),interrupt:(id,p)=>stopped.push([id,p])}
  if(entryOnly)window.DshSubagents.configure(target,options)
  else window.DshSubagents.mount(target,options)
  const click=label=>{const b=[...target.all(),...document.body.all()].find(n=>n.tag==='button'&&n.textContent===label);assert.ok(b,label);b.events.click()}
  const nodes=()=>[...target.all(),...document.body.all()]
  const select=label=>{const b=nodes().find(n=>n.className==='subtree-node'&&n.all().some(c=>c.tag==='strong'&&c.textContent===label));assert.ok(b,label);b.events.click()}
  const toggle=label=>{const b=nodes().find(n=>n.attrs['aria-label']===label);assert.ok(b,label);b.events.click()}
  const search=query=>{const el=nodes().find(n=>n.tag==='input');el.value=query;el.events.input();return el}
  const detail=()=>nodes().find(n=>n.className==='subtree-detail')
  return {window,target,document,opened,remembered,stopped,options,click,nodes,select,toggle,search,detail,leave:()=>{active=false}}
}
test('tree loads only expanded levels, opens grandchild with immediate parent and fences diagnostics',async()=>{
  const calls=[]
  const f=setup(async id=>{calls.push(id);return {parentAvailable:true,entries:id==='parent'?[{id:'child',label:'Child',mode:'continuable',activity:'running',hasChildren:true},{kind:'diagnostic',id:'bad',reason:'corrupt'}]:[{id:'leaf',label:'Leaf',mode:'one-shot',hasChildren:false},{id:'parent',label:'Cycle'}]}})
  await flush();assert.deepEqual(calls,['parent'])
  f.select('Child');assert.deepEqual(calls,['parent']);assert.deepEqual(f.opened,[],'selecting shows details without changing conversations')
  f.toggle('展开 Child');await flush();assert.deepEqual(calls,['parent','child'])
  f.select('Leaf');f.click('打开只读记录 ↗');assert.deepEqual(f.opened,[['leaf','child']])
  f.select('bad');assert.ok(!f.detail().all().some(n=>n.className?.includes('subtree-primary')))
  f.select('Cycle');assert.ok(!f.detail().all().some(n=>n.className?.includes('subtree-primary')))
  assert.ok(!f.remembered.some(([id,parent])=>id==='parent'&&parent==='child'),'cyclic catalogs cannot rewrite an ancestor address')
  f.select('Child');f.click('中断任务');assert.deepEqual(f.stopped,[['child','parent']])
  f.window.DshSubagents.mount(f.target,f.options);assert.deepEqual(calls,['parent','child'],'card rerenders reuse the catalog')
  f.click('刷新');await flush();assert.deepEqual(calls,['parent','child','parent','child'])
  f.click('收起分支');f.click('刷新');await flush()
  assert.deepEqual(calls,['parent','child','parent','child','parent'],'collapsed descendants are not refreshed')
})
test('tree retry recovers and late responses cannot expose a previous connection catalog',async()=>{
  let count=0
  const f=setup(async()=>{if(++count===1)throw new Error('offline');return {entries:[]}})
  await flush();f.click('重试');await flush()
  assert.ok(f.target.all().some(n=>n.textContent==='暂无子代理'))
  let resolve
  const late=setup(()=>new Promise(r=>{resolve=r}));late.leave();late.window.DshSubagents.reset()
  resolve({entries:[{id:'secret',label:'Secret'}]});await flush()
  assert.ok(!late.target.all().some(n=>n.textContent==='Secret'))
})
test('session updates refresh an expired root catalog without refetching on every render',async()=>{
  let now=0,count=0
  const f=setup(async()=>({entries:[{id:String(++count),hasChildren:false}]}),{now:()=>now})
  await flush();f.window.DshSubagents.mount(f.target,f.options);await flush();assert.equal(count,1)
  now=10001;f.window.DshSubagents.mount(f.target,f.options);await flush();assert.equal(count,2)
})
test('chat entry does not load or render a tree; full page owns it and closes before opening a record',async()=>{
  let count=0,paused=0,resumed=0
  const f=setup(async()=>{count++;return {entries:[{id:'child',label:'Child',hasChildren:false}]}},Date,true)
  f.options.onShow=()=>paused++;f.options.onClose=()=>resumed++
  assert.equal(count,0);assert.equal(f.target.children.length,0)
  f.target.onclick();await flush()
  const page=f.document.body.children[0]
  assert.equal(page.tag,'dialog');assert.equal(page.open,true);assert.equal(count,1);assert.equal(paused,1)
  assert.equal(f.target.children.length,0,'the chat entry never receives tree DOM')
  f.select('Child');assert.equal(page.open,true);f.click('打开只读记录 ↗');assert.equal(page.open,false);assert.equal(resumed,1);assert.deepEqual(f.opened,[['child','parent']])
  f.target.onclick();await flush();assert.equal(page.open,true)
  page.close();assert.equal(resumed,2,'Android back and Escape use the same close handler')
})

test('search and status filters preserve loaded ancestors and never fetch hidden branches',async()=>{
  const calls=[]
  const f=setup(async id=>{calls.push(id);return {entries:id==='parent'?[{id:'idle',label:'Idle parent',activity:'inactive',hasChildren:true},{id:'unread',label:'Unloaded branch',hasChildren:true}]:[{id:'worker',label:'Running worker',activity:'running',hasChildren:false}]}})
  await flush();f.toggle('展开 Idle parent');await flush()
  f.click('收起分支');const input=f.search('worker')
  assert.ok(f.nodes().some(n=>n.tag==='strong'&&n.textContent==='Idle parent'))
  assert.ok(f.nodes().some(n=>n.tag==='strong'&&n.textContent==='Running worker'))
  assert.equal(f.nodes().find(n=>n.tag==='input'),input,'typing retains its input node and caret')
  f.search('');f.click('运行中')
  assert.ok(f.nodes().some(n=>n.tag==='strong'&&n.textContent==='Idle parent'),'non-running ancestors preserve the branch context')
  assert.ok(!f.nodes().some(n=>n.tag==='strong'&&n.textContent==='Unloaded branch'))
  assert.deepEqual(calls,['parent','idle'])
  f.search('no-match');assert.ok(f.nodes().some(n=>n.textContent==='已读取目录中没有匹配项'))
  f.click('清除筛选');assert.ok(f.nodes().some(n=>n.textContent==='Unloaded branch'))
})

test('refresh reordering retains the selected node and unavailable parents cannot interrupt',async()=>{
  let reversed=false
  const f=setup(async()=>({parentAvailable:false,entries:(reversed?[{id:'b',label:'B'},{id:'a',label:'A',mode:'continuable',activity:'running'}]:[{id:'a',label:'A',mode:'continuable',activity:'running'},{id:'b',label:'B'}])}))
  await flush();f.select('A');reversed=true;f.click('刷新');await flush()
  assert.equal(f.detail().all().find(n=>n.tag==='h3').textContent,'A')
  assert.ok(!f.detail().all().some(n=>n.textContent==='中断任务'))
  f.click('打开只读记录 ↗');assert.deepEqual(f.opened,[['a','parent']])
})

test('refresh failures preserve loaded rows and untrusted labels remain text',async()=>{
  let fail=false
  const label='<img src=x onerror=alert(1)>'
  const f=setup(async()=>{if(fail)throw new Error('offline');return {entries:[{id:'a',label,activity:'inactive',hasChildren:false}]}})
  await flush();f.select(label);fail=true;f.click('刷新');await flush()
  assert.ok(f.nodes().some(n=>n.textContent==='刷新失败，保留上次目录'))
  assert.ok(f.nodes().some(n=>n.tag==='strong'&&n.textContent===label))
  assert.ok(!f.nodes().some(n=>n.tag==='img'||n.tag==='script'))
  f.search('absent');assert.ok(f.nodes().some(n=>n.textContent==='刷新失败，保留上次目录'),'filtering must not hide a read failure or its retry action')
})
