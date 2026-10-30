'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { setImmediate: next } = require('node:timers/promises')
const source = fs.readFileSync(path.join(__dirname,'../public/relay-settings.js'),'utf8')
class Element {
  constructor(tag) {this.tag=tag;this.children=[];this.dataset={};this.events={};this.classList={add(){}};this.hidden=false;this.value='';this.textContent=''}
  append(...nodes){this.children.push(...nodes)}
  get firstChild(){return this.children[0]}
  setAttribute(name,value){this[name]=value}
  addEventListener(name,handler){this.events[name]=handler}
  getClientRects(){return [{}]}
}
function harness(fetch) {
  const target=new Element('div'),timers=[]
  let host='a',generation=0
  const connection=()=>{const captured=generation,current=host;return {url:route=>'https://'+current+'.test'+route,headers:{authorization:'Bearer '+current+'-mock'},valid:()=>captured===generation}}
  const root={fetch,I18N:{lang:'zh'},navigator:{clipboard:{writeText:async()=>{}}}}
  const storage={setItem(){throw Error('Relay secrets must never enter browser storage')}}
  vm.runInNewContext(source,{window:root,document:{createElement:tag=>new Element(tag),hidden:false},URL,AbortController,Date,JSON,Error,Object,Number,String,setInterval:fn=>{timers.push(fn);return 1},clearInterval(){},setTimeout,clearTimeout,localStorage:storage,sessionStorage:storage})
  const component=root.DshRelaySettings.mount(target,{connection})
  const descendants=node=>[node,...node.children.flatMap(descendants)]
  return {root,target,component,nodes:()=>descendants(target),tick:()=>timers.forEach(fn=>fn()),switchHost:()=>{host='b';generation++;timers.forEach(fn=>fn())}}
}
const response = (body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body})
const initial={supported:true,configured:false,enabled:false,phase:'disabled',canManage:true}
test('relay settings clears secrets, never retries a POST, and ignores stale activation results after switching hosts',async()=>{
  const calls=[];let resolvePost
  const h=harness(async(url,options)=>{
    calls.push({url,options})
    if(options.method==='POST')return new Promise(resolve=>{resolvePost=resolve})
    return response(initial)
  })
  await next();await next()
  const key=h.nodes().find(node=>node.name==='relay-key'),form=h.nodes().find(node=>node.tag==='form')
  key.value='dsrp_1122334455667788.'+'a'.repeat(43)
  form.events.submit({preventDefault(){}})
  assert.equal(key.value,'')
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1)
  assert.ok(calls.at(-1).url.startsWith('https://a.test'))
  key.value='leftover secret';h.switchHost()
  assert.equal(key.value,'')
  resolvePost(response({...initial,configured:true,enabled:true,publicUrl:'https://old.test',phase:'online'}))
  await next();await next()
  assert.ok(!h.nodes().some(node=>node.href==='https://old.test'))
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1)
  h.component.destroy()
})
test('relay settings shows server-enforced daily quota and requires an explicit admin token only for management',async()=>{
  const calls=[]
  const h=harness(async(url,options)=>{calls.push({url,options});return response({...initial,canManage:false,configured:true,enabled:true,phase:'quota-exceeded',publicUrl:'https://alpha.test',fingerprint:'abcdef0123456789',daily:{limitBytes:5e9,usedBytes:5e9,remainingBytes:0,exhausted:true}})})
  await next();await next()
  assert.ok(h.nodes().some(node=>String(node.textContent).includes('5.00 / 5.00 GB')))
  assert.ok(h.nodes().some(node=>node.textContent==='今日流量已用完'))
  const admin=h.nodes().find(node=>node.name==='relay-admin'),toggle=h.nodes().find(node=>node.tag==='button'&&node.textContent==='停用中转')
  admin.value='one-operation-mock-admin';toggle.events.click()
  assert.equal(admin.value,'')
  await next()
  assert.equal(calls.at(-1).options.headers.authorization,'Bearer one-operation-mock-admin')
  h.component.destroy()
})

test('relay status distinguishes expired credentials, missing routes and invalid responses, then recovers on refresh',async()=>{
  for(const [status,body,message] of [[401,{error:'unauthorized'},'访问令牌无效'],[404,{},'升级到'],[200,{},'尚不支持云中转']]){
    let healthy=false
    const h=harness(async()=>response(healthy?initial:body,healthy?200:status))
    await next();await next()
    assert.ok(h.nodes().some(node=>node.textContent.includes(message)),String(status))
    assert.ok(h.nodes().some(node=>node.textContent==='状态读取失败'))
    assert.ok(!h.nodes().some(node=>node.textContent==='尚未开通'))
    healthy=true;await h.component.refresh()
    assert.ok(h.nodes().some(node=>node.textContent==='已停用'))
    assert.ok(!h.nodes().some(node=>node.textContent.includes(message)))
    h.component.destroy()
  }
})

test('failed relay reads back off; successful state is preserved during a later outage',async()=>{
  let available=true,calls=0
  const h=harness(async()=>{calls++;if(!available)throw Error('offline');return response({...initial,phase:'online',configured:true})})
  await next();await next();assert.equal(calls,1)
  available=false;await h.component.refresh();assert.equal(calls,2)
  assert.ok(h.nodes().some(node=>node.textContent==='已连接'))
  assert.ok(h.nodes().some(node=>node.textContent.includes('暂时无法连接主机')))
  for(let i=0;i<10;i++)h.tick()
  assert.equal(calls,2)
  available=true;await h.component.refresh();assert.equal(calls,3)
  h.component.destroy()
})

test('relay settings distinguishes service-month quota from the legacy daily allowance',async()=>{
  const h=harness(async()=>response({...initial,configured:true,phase:'quota-exceeded',daily:{period:'month',usedBytes:5e9,limitBytes:5e9,remainingBytes:0,exhausted:true}}))
  await next();await next()
  assert.ok(h.nodes().some(node=>node.textContent==='本月流量已用完'))
  assert.ok(h.nodes().some(node=>node.textContent.includes('本月已用 5.00 / 5.00 GB')))
  assert.ok(!h.nodes().some(node=>node.textContent.includes('零点')||node.textContent.includes('每天 00:00')))
  h.component.destroy()
})
