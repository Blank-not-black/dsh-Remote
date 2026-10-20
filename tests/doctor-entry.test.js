'use strict'
const{test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')
function fixture(pluginMode=true){
 let options,live={hostname:'test',version:'0.8.0-rc.8'},sequence=0
 const calls=[],c=vm.createContext({window:{DshDoctor:{open:args=>{options=args}}},location:{host:'host',origin:'http://host'},crypto:{randomUUID:()=>String(++sequence)},AbortSignal,JSON,URL,Math,Date,
  fetch:async(url,init)=>{calls.push({url,init});return {ok:true,status:200,json:async()=>({result:{ok:true,value:{sessionId:'new'}}})}}
 })
 vm.runInContext(read('public/doctor-entry.js'),c);c.window.DshDoctorEntry.open({state:()=>live,pluginMode,token:()=>pluginMode?'':'test-token'})
 return{c,calls,options,invalidate:()=>{live={hostname:'other'}}}
}
test('opening management diagnosis creates no conversation; host calls preserve session.create request shape and DSH authentication',async()=>{
 const f=fixture();assert.equal(f.calls.length,0)
 await f.options.rpc('session.create',{cwd:'/fixture/plugin'})
 assert.equal(f.calls[0].url,'/api/session/create');assert.equal(f.calls[0].init.credentials,'same-origin')
 assert.equal(f.calls[0].init.headers.authorization,undefined)
 const body=JSON.parse(f.calls[0].init.body);assert.deepEqual(body.payload,{args:{request:{cwd:'/fixture/plugin'}}})
 await assert.rejects(f.options.rpc('workspace.create',{}),/Unsupported/)
 f.invalidate();await assert.rejects(f.options.rpc('session.prompt',{}),/changed/)
})
test('legacy host fallback only follows a missing endpoint; uncertain failures cannot duplicate creation',async()=>{
 const f=fixture();let count=0
 f.c.fetch=async()=>{count++;return count===1?{status:404,body:{cancel:async()=>{}}}:{status:200,ok:true,json:async()=>({result:{ok:true,value:{sessionId:'legacy'}}})}}
 assert.equal((await f.options.rpc('session.create',{cwd:'/fixture'})).sessionId,'legacy');assert.equal(count,2)
 count=0;f.c.fetch=async()=>{count++;return {status:500,ok:false,json:async()=>({})}}
 await assert.rejects(f.options.rpc('session.create',{}));assert.equal(count,1)
})
test('gateway entry keeps its existing authentication and reads the authenticated exact target route',async()=>{
 const f=fixture(false);await f.options.rpc('session.create',{cwd:'/fixture'})
 assert.equal(f.calls[0].url,'/api/session.create');assert.equal(f.calls[0].init.headers.authorization,'Bearer test-token')
 f.c.fetch=async(url,init)=>{f.calls.push({url,init});return {ok:true,text:async()=>JSON.stringify({ok:true})}}
 await f.options.loadTarget();assert.equal(f.calls.at(-1).url,'/remote/api/doctor/target')
})
test('native handoff accepts only its own same-origin iframe and never creates or prompts a session',()=>{
 let exports,drawer,listener;const trusted={postMessage:payload=>acks.push(payload)},acks=[],opened=[],closed=[]
 const React={useRef:value=>({current:value}),useEffect:fn=>fn(),createElement:(tag,props,...children)=>{if(tag==='iframe')props.ref.current={contentWindow:trusted};return{tag,props,children}}}
 const c=vm.createContext({window:{location:{protocol:'dsh-app:'},__ModuleLoader__:{load:module=>{exports=module.factory(name=>name==='react'?React:{defineStore:()=>({})})}},addEventListener:(name,fn)=>{if(name==='message')listener=fn},removeEventListener(){}},location:{origin:'dsh-app://app'}})
 vm.runInContext(read('packages/plugin/client.js'),c)
 const ctx={effect:fn=>fn(),get(){throw Error('undeclared')},inject(names,fn){assert.deepEqual(Array.from(names),['uiWorkspace']);fn({get:()=>({openSession:id=>opened.push(id)}),effect:factory=>factory()})},slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{if(options.id==='dsh-remote-drawer')drawer={options,component};return()=>{}}}}
 exports.apply(ctx);drawer.component({useStore:()=>true,actions:{close:()=>closed.push(true)},...drawer.options.inject()})
 const event={origin:'dsh-app://app',source:trusted,data:{source:'dsh-remote-admin',type:'open-session',sessionId:'session-fixture',requestId:'request'}}
 listener({...event,origin:'https://other.invalid'});listener({...event,source:{}});listener({...event,data:{...event.data,sessionId:'../bad'}})
 assert.equal(opened.length,0);listener(event)
 assert.deepEqual(opened,['session-fixture']);assert.equal(closed.length,1);assert.equal(acks[0].opened,true)
})
