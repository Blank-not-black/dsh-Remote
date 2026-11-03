'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const moduleTask = import('../packages/plugin/approval-summary.mjs')
const request = { sessionId:'s', approvalId:'wire-id', callId:'call-1', consent:true }
function host(stream) {
  const calls = []
  const session = { id:'s', log:[
    { type:'turn/start' },
    { type:'tool/call', data:{ callId:'call-1', arguments:'PRIVATE_TOOL_ARGUMENTS' } },
    { type:'approval/asked', data:{ id:'audit-id', callId:'call-1', toolName:'pwsh',
      reason:'Auto review denied tool "pwsh": This command will delete files. token=SECRET_TOKEN https://example.test/run?key=SECRET_QUERY' } }
  ], requestHeader:() => ({ config:{ provider:'fixture-provider', model:'fixture-model' } }) }
  const ctx = { agents:{ get:id => id === 's' ? { session } : undefined }, get:name => name === 'llm' ? { stream:options => {
    calls.push(options); return stream ? stream(options) : (async function* () {
      yield { type:'text-delta', index:0, text:'该操作将删除文件，需确认删除范围。' }
      yield { type:'block-end', index:0, block:{ type:'text', text:'该操作将删除文件，需确认删除范围。' } }
      yield { type:'finish', reason:{ kind:'stop' } }
    })()
  } } : undefined }
  return { ctx, session, calls }
}
test('摘要只用主机的待审批理由与会话模型，限长并脱敏，不发对话或工具参数', async () => {
  const { readApprovalSummary } = await moduleTask, h = host()
  const result = await readApprovalSummary(h.ctx, request)
  assert.equal(result.status,200); assert.equal(result.body.summary,'该操作将删除文件，需确认删除范围。')
  const options = h.calls[0]
  assert.equal(options.provider,'fixture-provider'); assert.equal(options.model,'fixture-model')
  assert.equal(options.maxTokens,512); assert.equal(options.messages.length,1); assert.equal(options.tools,undefined)
  assert.doesNotMatch(JSON.stringify(options.messages),/SECRET_|PRIVATE_TOOL_ARGUMENTS/)
  assert.equal(h.session.log.length,3,'summary never logs a prompt or approval decision')
})
test('重复与并发请求复用生成结果，审批完结后拒绝读取或重新生成', async () => {
  const { readApprovalSummary } = await moduleTask, h = host()
  const results = await Promise.all(Array.from({length:4},() => readApprovalSummary(h.ctx,request)))
  assert.ok(results.every(result => result.status===200)); assert.equal(h.calls.length,1)
  h.session.log.push({type:'approval/decided',data:{id:'audit-id',outcome:'allowed-once'}})
  assert.equal((await readApprovalSummary(h.ctx,request)).status,409); assert.equal(h.calls.length,1)
})
test('缺少明确同意、伪造正文、未知会话和非自动审查请求不会调用模型', async () => {
  const { readApprovalSummary } = await moduleTask, h = host()
  for (const value of [{...request,consent:false},{...request,reason:'caller text'},{...request,sessionId:'other'},
    {...request,callId:'missing'},{...request,provider:'external'}]) assert.notEqual((await readApprovalSummary(h.ctx,value)).status,200)
  h.session.log[2].data.reason='ordinary permission escalation'
  assert.equal((await readApprovalSummary(h.ctx,request)).status,409); assert.equal(h.calls.length,0)
})
test('失败及超时被缓存，流错误不返回内部报错，不接受截断或非中文摘要', async () => {
  const { readApprovalSummary } = await moduleTask
  for (const stream of [
    async function*(){throw Object.assign(Error('SECRET_PROVIDER_ERROR'), { code:'SECRET_PROVIDER_ERROR',status:418 })},
    async function*(){yield {type:'text-delta',index:0,text:'English only'};yield {type:'finish',reason:{kind:'stop'}}},
    async function*(){yield {type:'text-delta',index:0,text:'中文'};yield {type:'finish',reason:{kind:'length'}}},
    async function*(){yield {type:'text-delta',index:0,text:'长'.repeat(241)};yield {type:'finish',reason:{kind:'stop'}}},
    async function*(){await new Promise(resolve=>setTimeout(resolve,25));yield {type:'finish',reason:{kind:'stop'}}}
  ]) {
    const h=host(stream), result=await readApprovalSummary(h.ctx,request,{timeoutMs:5})
    assert.notEqual(result.status,200); assert.doesNotMatch(JSON.stringify(result),/SECRET_PROVIDER_ERROR/)
    assert.deepEqual(await readApprovalSummary(h.ctx,request),result); assert.equal(h.calls.length,1)
  }
})
test('生成时被审批或切换模型的请求不再返回摘要', async () => {
  const { readApprovalSummary } = await moduleTask
  for (const change of [h=>h.session.log.push({type:'approval/decided',data:{id:'audit-id'}}),
    h=>h.session.requestHeader=()=>({config:{provider:'changed',model:'new-model'}})]) {
    let release
    const wait=new Promise(resolve=>release=resolve), h=host(async function*(){await wait;yield {type:'text-delta',index:0,text:'仅供参考的中文'};yield {type:'finish',reason:{kind:'stop'}}})
    const task=readApprovalSummary(h.ctx,request); change(h); release()
    assert.equal((await task).status,409)
  }
})
test('主机限制并发和每小时新生成次数，缓存命中不占次数', async () => {
  const { readApprovalSummary } = await moduleTask, h=host()
  for(let i=0;i<20;i++){
    h.session.log[2]={type:'approval/asked',data:{id:'audit-'+i,callId:'call-1',toolName:'pwsh',reason:'Auto review denied tool "pwsh": Risk '+i}}
    assert.equal((await readApprovalSummary(h.ctx,request)).status,200)
  }
  assert.equal((await readApprovalSummary(h.ctx,request)).status,200)
  h.session.log[2]={type:'approval/asked',data:{id:'audit-new',callId:'call-1',reason:'Auto review denied tool "pwsh": New'}}
  assert.equal((await readApprovalSummary(h.ctx,request)).status,429); assert.equal(h.calls.length,20)
  let release
  const gate=new Promise(resolve=>release=resolve), slow=host(async function*(){await gate;yield {type:'text-delta',index:0,text:'中文摘要'};yield {type:'finish',reason:{kind:'stop'}}})
  const tasks=[]
  for(let i=0;i<2;i++){slow.session.log.push({type:'approval/asked',data:{id:'parallel-'+i,reason:'Auto review denied tool "pwsh": Risk'}});tasks.push(readApprovalSummary(slow.ctx,{...request,approvalId:'parallel-'+i,callId:undefined}))}
  slow.session.log.push({type:'approval/asked',data:{id:'parallel-new',reason:'Auto review denied tool "pwsh": Risk'}})
  assert.equal((await readApprovalSummary(slow.ctx,{...request,approvalId:'parallel-new',callId:undefined})).status,429)
  release();await Promise.all(tasks)
})

function browser(fetcher) {
  let valid=true, confirms=0, allowed=true
  const item={sessionId:'s',approvalId:'wire-id',callId:'call-1',reason:'Auto review denied tool "pwsh": Risk',arguments:{cmd:'PRIVATE_ARGUMENT'}}
  let items=[item]
  const context=vm.createContext({window:{I18N:{lang:'zh'},confirm:()=>{confirms++;return allowed},fetch:fetcher},AbortController,setTimeout,clearTimeout})
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/approval-summary.js'),'utf8'),context)
  const api=context.window.DshApprovalSummary
  api.mount({capture:()=>({valid:()=>valid}),items:()=>items,url:(_,path)=>'https://fixture.test'+path,headers:()=>({authorization:'Bearer FIXTURE'})})
  return {api,item,confirms:()=>confirms,cancel:()=>allowed=false,invalidate:()=>valid=false,resolve:()=>items=[]}
}
test('前端默认零调用、取消不调用、重复点击及重绘复用摘要，输出作为纯文本', async () => {
  const calls=[],b=browser(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,summary:'中文 <img src=x onerror=bad()> 参考'})}})
  assert.match(b.api.html(b.item),/消耗 token/);assert.equal(calls.length,0)
  await Promise.all([b.api.generate(b.item),b.api.generate(b.item)])
  assert.equal(calls.length,1);assert.equal(b.confirms(),1)
  assert.doesNotMatch(calls[0].options.body,/PRIVATE_ARGUMENT|Risk/)
  assert.match(b.api.html(b.item),/仅供参考/);assert.match(b.api.html(b.item),/&lt;img/);assert.doesNotMatch(b.api.html(b.item),/<img/)
  await b.api.generate(b.item);assert.equal(calls.length,1)
  const canceled=browser(()=>{throw Error('must not call')});canceled.cancel()
  await canceled.api.generate(canceled.item);assert.equal(canceled.confirms(),1)
  assert.equal(canceled.api.html({...canceled.item,reason:'normal approval'}),'')
})
test('前端错误不自动重试，已解决审批及失效连接不发送或展示旧摘要', async () => {
  let calls=0
  const b=browser(async()=>{calls++;throw Error('network lost')})
  await b.api.generate(b.item);await b.api.generate(b.item)
  assert.equal(calls,1);assert.match(b.api.html(b.item),/不会自动重试/)
  const stale=browser(()=>{throw Error('must not call')});stale.resolve()
  await stale.api.generate(stale.item);assert.equal(stale.confirms(),0)
  const invalid=browser(()=>{throw Error('must not call')});invalid.invalidate()
  await invalid.api.generate(invalid.item);assert.equal(invalid.confirms(),0)
  b.api.reset();assert.doesNotMatch(b.api.html(b.item),/摘要未生成/)
})
