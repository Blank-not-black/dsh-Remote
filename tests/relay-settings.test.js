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
function harness(fetch, options = {}) {
  const target=new Element('div'),timers=[]
  let host='a',generation=0
  const connection=()=>{const captured=generation,current=host;return {url:route=>'https://'+current+'.test'+route,headers:{authorization:'Bearer '+current+'-mock'},valid:()=>captured===generation}}
  const root={fetch,crypto:globalThis.crypto,I18N:{lang:'zh'},navigator:{clipboard:{writeText:async()=>{}}},NativeBackground:options.bridge}
  const storage={setItem(){throw Error('Relay secrets must never enter browser storage')}}
  const context=vm.createContext({window:root,document:{createElement:tag=>new Element(tag),querySelector:()=>null,querySelectorAll:()=>[],hidden:false},URL,AbortController,Date,JSON,Error,Object,Number,String,setInterval:fn=>{timers.push(fn);return 1},clearInterval(){},setTimeout,clearTimeout,localStorage:storage,sessionStorage:storage})
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/sponsor-entry.js'),'utf8'),context)
  vm.runInContext(source,context)
  const component=root.DshRelaySettings.mount(target,{connection,...options})
  const descendants=node=>[node,...node.children.flatMap(descendants)]
  return {root,target,component,nodes:()=>descendants(target),tick:()=>timers.forEach(fn=>fn()),switchHost:()=>{host='b';generation++;timers.forEach(fn=>fn())}}
}
const response = (body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body})
const initial={supported:true,configured:false,enabled:false,phase:'disabled',canManage:true}

test('relay activation imports on either surface and retains manual setup after an invalid or rejected file', async () => {
  const activation = { type: 'dsh-remote-relay-activation', version: 1, code: 'dsra_' + 'a'.repeat(16) + '.' + 'b'.repeat(43), expiresAt: Date.now() + 60000 }
  for (const service of [false, true]) {
    let reject = true
    const posts = [], h = harness(async (_url, options) => {
      if (options.method !== 'POST') return response({ ...initial, activationImport: true, canPairLocally: true })
      posts.push(JSON.parse(options.body))
      return reject ? response({ error: 'ACTIVATION_FILE_EXPIRED' }, 409) :
        response({ ...initial, activationImport: true, canPairLocally: true, enabled: true, activationId: 'a'.repeat(32) })
    }, { service })
    await next(); await next()
    const picker = h.nodes().find(node => node.name === 'relay-activation')
    const select = async value => {
      const contents = JSON.stringify(value)
      picker.files = [{ size: contents.length, text: async () => contents }]
      await picker.events.change()
    }
    await select({ ...activation, server: 'https://other.test' })
    assert.equal(posts.length, 0)
    await select(activation)
    assert.deepEqual(posts, [{ action: 'activate-file', activation }])
    assert.equal(h.nodes().find(node => node.tag === 'details').open, true)
    assert.ok(h.nodes().some(node => node.textContent.includes('激活文件已过期')))
    assert.equal(h.nodes().find(node => node.name === 'relay-key').disabled, false)
    reject = false
    await select(activation)
    assert.ok(h.nodes().some(node => node.textContent.includes('主机已绑定')))
    assert.equal(posts.length, 2)
    h.component.destroy()
  }
})

test('phone can await host approval, then offer manual setup when public verification fails', async () => {
  const requestId = 'a'.repeat(32)
  const activation = { type: 'dsh-remote-relay-activation', version: 1, code: 'dsra_' + 'a'.repeat(16) + '.' + 'b'.repeat(43), expiresAt: Date.now() + 60000 }
  let status = { ...initial, activationImport: true, canManage: false, canPairLocally: true }
  let syncCalls = 0
  const h = harness(async (_url, options) => {
    if (options.method === 'POST') status = { ...status, activationRequest: { id: requestId, phase: 'pending' } }
    return response(status)
  }, { service: true, syncActivation: async () => { syncCalls++; return { ok: false } } })
  await next(); await next()
  const picker = h.nodes().find(node => node.name === 'relay-activation')
  picker.files = [{ size: 200, text: async () => JSON.stringify(activation) }]
  await picker.events.change()
  assert.ok(h.nodes().some(node => node.textContent.includes('管理页确认')))
  assert.equal(syncCalls, 0)
  status = { ...status, activationId: requestId, enabled: true, activationRequest: { id: requestId, phase: 'bound' } }
  await h.component.refresh()
  await next()
  assert.equal(syncCalls, 1)
  assert.ok(h.nodes().some(node => node.textContent.includes('手机配置未完成')))
  assert.equal(h.nodes().find(node => node.tag === 'details').open, true)
  h.component.destroy()
})

test('a received inbox activation never changes the host until confirmed and remains retryable on failure', async () => {
  const activation = { type: 'dsh-remote-relay-activation', version: 1, code: 'dsra_' + 'a'.repeat(16) + '.' + 'b'.repeat(43), expiresAt: Date.now() + 60000 }
  const posts = []
  let accepts = false
  const connected = { ...initial, activationImport: true, canPairLocally: true }
  const h = harness(async (url, options) => {
    if (options.method !== 'POST') return response(connected)
    posts.push({ url, payload: JSON.parse(options.body) })
    return accepts ? response({ ...connected, enabled: true }) : response({ error: 'ENROLLMENT_CONNECTION_FAILED' }, 503)
  }, { service: true })
  await next(); await next()
  h.component.receiveActivation(JSON.stringify(activation))
  await next(); await next()
  assert.equal(posts.length, 0)
  assert.ok(h.nodes().some(node => node.textContent.includes('当前主机：a.test')))
  h.switchHost(); await next(); await next()
  assert.ok(h.nodes().some(node => node.textContent.includes('当前主机：b.test')))
  const apply = h.nodes().find(node => node.textContent === '应用到此主机')
  await apply.events.click()
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0], { url: 'https://b.test/relay', payload: { action: 'activate-file', activation } })
  assert.equal(h.nodes().find(node => node.tag === 'details').open, true)
  accepts = true
  await apply.events.click()
  assert.equal(posts.length, 2)
  assert.equal(h.nodes().find(node => node.className === 'relay-inbox-offer').hidden, true)
  h.component.destroy()
})

test('connection category uses the active route before the host relay plan', () => {
  const h = harness(async () => response(initial))
  const { connectionCategory } = h.root.DshRelaySettings
  const base = 'https://public.test'
  const status = {
    supported: true, publicUrl: base + '/', server: new URL(h.root.DshSponsor.applicationUrl).origin,
  }

  assert.equal(connectionCategory({ ...status, canPairLocally: true, quotaPeriod: 'month' }, 'http://127.0.0.1:8787'), 'direct')
  assert.equal(connectionCategory({ ...status, quotaPeriod: 'month' }, 'https://elsewhere.test'), 'unknown')
  assert.equal(connectionCategory({ ...status, quotaPeriod: 'month', displayPlan: 'early-test' }, base), 'basic')
  assert.equal(connectionCategory({ ...status, daily: { period: 'month' } }, base), 'basic')
  assert.equal(connectionCategory({ ...status, displayPlan: 'early-test' }, base), 'early-test')
  assert.equal(connectionCategory({ ...status, server: 'https://custom-control.test' }, base), 'self-hosted')
  assert.equal(connectionCategory(status, base), 'relay')
  assert.equal(connectionCategory({ supported: true, publicUrl: 'invalid' }, base), 'unknown')
  assert.equal(connectionCategory(null, base), 'unknown')
  h.component.destroy()
})

test('App hub distinguishes verified host binding from this device’s application status',async()=>{
 let registration='idle',reads=0,host=initial
 const opened=[]
 const bridge={cloudRelayRegistration:()=>registration,refreshCloudRelayRegistration(){reads++;registration='loading'},
  openCloudRelay(){opened.push('plans')},openCloudRelayManagement(){opened.push('management')}}
 const h=harness(async()=>response(host),{service:true,bridge})
 const find=value=>h.nodes().find(node=>!node.hidden&&node.textContent===value)
 const has=value=>!!find(value)
 assert.equal(reads,1)
 await next();await next()
 assert.ok(has('此主机未绑定'))
 assert.ok(!has('查看套餐并开通'))
 registration='submitted';h.tick()
 assert.ok(has('已提交 · 等待审核'))
 assert.ok(!has('查看套餐并开通'))
 assert.ok(has('查看审核进度'))
 registration='none';h.tick()
 assert.ok(has('查看套餐并开通'))
 assert.equal(find('续费 / 购买流量包').href,'https://relay-pilot.blankalwaysgoeson.site/sponsor/')
 for(const label of ['查看套餐并开通','续费 / 购买流量包'])find(label).events.click({preventDefault(){}})
 assert.deepEqual(opened,['plans','plans'])
 host={...initial,configured:true,enabled:true,displayPlan:'early-test',phase:'online'};await h.component.refresh()
 assert.ok(has('主机中转在线'))
 assert.ok(has('特殊先行测试用户'))
 assert.ok(!has('查看套餐并开通'))
 assert.equal(find('续费 / 购买流量包').href,'https://relay-pilot.blankalwaysgoeson.site/sponsor/')
 registration='renewable';h.tick()
 assert.ok(has('续费 / 购买流量包'))
 host={...initial,legacyAvailable:true};await h.component.refresh()
 assert.ok(has('已有登记的试用连接'))
 h.component.destroy()
})

test('App hub does not label a refused status lookup or a quota cap as unbound',async()=>{
 const bridge={cloudRelayRegistration:()=> 'none',refreshCloudRelayRegistration(){}}
 for(const [status,body,label] of [[401,{error:'unauthorized'},'状态读取失败'],[429,{daily:{period:'month',unavailable:true}},'本月流量已用完']]){
  const h=harness(async()=>response(body,status),{service:true,bridge})
  await next();await next()
  const labels=h.nodes().map(node=>node.textContent)
  assert.ok(labels.includes(label))
  assert.ok(!labels.includes('查看套餐并开通'))
  assert.ok(!labels.includes('此主机未绑定'))
  h.component.destroy()
 }
})
test('App hub shows the inbox count independently of host availability and opens the private inbox',async()=>{
 let unread=2,opened=0
 const bridge={cloudRelayRegistration:()=> 'unavailable',refreshCloudRelayRegistration(){},cloudRelayUnreadMessages:()=>unread,openCloudRelayInbox(){opened++}}
 const h=harness(async()=>response({error:'unauthorized'},401),{service:true,bridge})
 await next();await next()
 const inbox=h.nodes().find(node=>node.textContent==='站内消息 · 2 条未读')
 assert.equal(inbox.hidden,false)
 inbox.events.click()
 assert.equal(opened,1)
 unread=0;h.tick()
 assert.equal(inbox.textContent,'站内消息')
 h.component.destroy()
})
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
  assert.ok(h.nodes().some(node=>node.textContent==='主机中转在线'))
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

test('basic plan restrictions are visible before the first cloud usage update',async()=>{
  const h=harness(async()=>response({...initial,configured:true,phase:'connecting',quotaPeriod:'month',monthlyLimitBytes:5e9,fileTransfer:false,quotaPending:true}))
  await next();await next()
  assert.ok(h.nodes().some(node=>!node.hidden&&node.textContent.includes('一个服务月 5GB')&&node.textContent.includes('不含文件传输')))
  assert.ok(h.nodes().some(node=>node.textContent.includes('等待云端确认')))
  h.component.destroy()
})

test('early tester shows a replacement plan and authorized expiry',async()=>{
  const h=harness(async()=>response({...initial,configured:true,quotaPeriod:'day',displayPlan:'early-test',
    fingerprint:'abcdef0123456789',expiresAt:Date.parse('2028-12-31T23:59:00+08:00')}))
  await next();await next()
  assert.ok(h.nodes().some(node=>!node.hidden&&node.textContent==='特殊先行测试用户'))
  assert.ok(h.nodes().some(node=>node.textContent.includes('有效期至')&&node.textContent.includes('2028')))
  assert.ok(!h.nodes().some(node=>!node.hidden&&node.textContent.includes('基础中转 ·')))
  h.component.destroy()
})

test('host guide follows only the displayed connection code and clears it on a host change',async()=>{
  let setupId,activity=[]
  const h=harness(async()=>response({...initial,configured:true,enabled:true,phase:'online',
    canManageDevices:true,e2ee:{configured:true},pairingActivity:activity}),{
    phonePairingCode:async id=>{setupId=id;return '<svg></svg>'},deviceManagement:false,
  })
  await next()
  const add=h.nodes().find(node=>node.textContent==='添加手机并显示连接码')
  await add.events.click()
  await next()
  assert.match(setupId,/^[a-f0-9]{32}$/)
  const progress=h.nodes().find(node=>node.textContent==='等待手机扫码并确认…')
  const createdAt=Date.now()
  activity=[{setupId:'f'.repeat(32),createdAt,firstPublicAccessAt:createdAt}]
  await h.component.refresh()
  assert.match(progress.textContent,/等待手机扫码/)
  activity.push({setupId,createdAt,firstPublicAccessAt:null})
  await h.component.refresh()
  assert.match(progress.textContent,/电脑已收到配对/)
  activity.at(-1).firstPublicAccessAt=createdAt
  await h.component.refresh()
  assert.match(progress.textContent,/手机已从公网访问/)
  h.switchHost()
  assert.equal(progress.textContent,'')
  assert.equal(add.disabled,false)
  h.component.destroy()
})
