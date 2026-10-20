'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const read=f=>fs.readFileSync(path.join(__dirname,'../public',f),'utf8')
function harness() {
  const select={value:'',children:[],labels:[{}],append(el){this.children.push(el)},replaceChildren(){this.children=[]}},hint={}
  let valid=true
  const c=vm.createContext({window:{},document:{createElement:()=>({})},WeakMap,Set})
  vm.runInContext(read('session-presets.js'),c)
  return {select,hint,api:c.window.DshSessionPresets,connection:{valid:()=>valid},invalidate(){valid=false}}
}
test('host presets populate options, disable broken types and preserve default omission',async()=>{
  const h=harness(),calls=[]
  await h.api.open({...h,rpc:async(...args)=>{calls.push(args);return {presets:[{id:'standard',isDefault:true},{id:'ptc',name:'Code <script>',description:'Code tools'},{id:'broken',broken:'activation failed'}]}}})
  assert.equal(calls[0][0],'agentPresets.list');assert.equal(h.select.children.length,4)
  assert.equal(h.select.children[2].textContent,'Code <script>');assert.equal(h.select.children[3].disabled,true)
  assert.equal(JSON.stringify(h.api.selection(h.select)),JSON.stringify({valid:true,payload:{}}))
  h.select.value='ptc';h.select.onchange();assert.equal(h.hint.textContent,'Code tools')
  assert.equal(h.api.selection(h.select).payload.agentPreset,'ptc')
  h.select.value='broken';assert.equal(h.api.selection(h.select).valid,false)
  h.select.value='invented';assert.equal(h.api.selection(h.select).valid,false)
})
test('unsupported hosts use their own default; changed identities cannot reuse old selections',async()=>{
  const h=harness();await h.api.open({...h,rpc:async()=>{throw Error('404')}})
  assert.equal(h.select.disabled,true);assert.equal(h.api.selection(h.select).valid,true)
  assert.match(h.hint.textContent,/默认/);h.invalidate();assert.equal(h.api.selection(h.select).valid,false)
})
test('older catalog responses cannot replace a reopened form',async()=>{
  const h=harness();let respond
  const pending=h.api.open({...h,rpc:()=>new Promise(r=>{respond=r})})
  await h.api.open({...h,rpc:async()=>({presets:[{id:'new-host'}]})})
  respond({presets:[{id:'old-host'}]});await pending
  assert.deepEqual(h.select.children.map(x=>x.value),['','new-host'])
})
function section(source,name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert.ok(start>=0,name);const end=source.indexOf('\n}',start);return source.slice(start,end+2)}
for(const file of ['app.js','desktop/desktop.js']) {
  test(file+': create transmits the selected Agent preset and workspace in one request',async()=>{
    const source=read(file),calls=[],nodes=new Map([['new-session-workspace',{value:'workspace-1'}],['new-session-create',{}],['new-session-agent-preset',{}]])
    let live=true
    const c=vm.createContext({$ :id=>nodes.get(id),captureConnection:()=>({valid:()=>live}),workspaceById:()=>({workspaceId:'workspace-1'}),toast(){},t:x=>x,window:{DshSessionPresets:{selection:()=>({valid:true,payload:{agentPreset:'ptc'}})}},safeRpc:async(method,payload)=>{calls.push({method,payload});live=false;return {sessionId:'new'}}})
    vm.runInContext(section(source,'createSessionInWorkspace'),c);await c.createSessionInWorkspace()
    assert.equal(calls.length,1);assert.equal(calls[0].method,'session.create');assert.equal(calls[0].payload.workspaceId,'workspace-1');assert.equal(calls[0].payload.agentPreset,'ptc')
    assert.equal(nodes.get('new-session-create').disabled,false)
  })
  test(file+': one workspace still opens the mode chooser instead of auto-creating',async()=>{
    const source=read(file),opened=[]
    const c=vm.createContext({state:{token:'test',workspaceFilter:'workspace-1'},LS:{get:()=>''},workspaceById:()=>({workspaceId:'workspace-1'}),workspaceItems:()=>[{}],renderNewSessionWorkspace(){},loadSessionPresets:()=>opened.push('presets'),$:()=>({classList:{remove:()=>opened.push('form')}}),setTimeout(){},createSessionInWorkspace(){assert.fail('auto-created')}})
    const fn=file==='app.js'?'newSession':'openNewSessionModal';vm.runInContext(section(source,fn),c);await c[fn]();assert.deepEqual(opened,['presets','form'])
  })
}
