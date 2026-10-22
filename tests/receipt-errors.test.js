'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'gateway.js'),'utf8')
const {createRealisticStack}=require('./fixtures/realistic-stack.cjs')
function executor({error,body,legacy=false}={}) {
  const logs=[],saved=[]
  const context=vm.createContext({URL,Buffer,UPSTREAM:new URL('http://isolated'),detectUpstreamApiFlavor:async()=>legacy?'legacy':'modern',
    translateModernRpc:async()=>{if(error)throw error;return body},forwardLegacyRpc:async()=>({status:200,raw:JSON.stringify(body)}),
    saveOperation:(_,job)=>saved.push(JSON.parse(JSON.stringify(job))),recordCompatibility:(...args)=>logs.push(args),console:{warn:(...args)=>logs.push(args)}})
  vm.runInContext(source.slice(source.indexOf('function operationSnapshot('),source.indexOf('async function serveOperations(')),context)
  return {context,logs,saved,run:async()=>{const job={id:'isolated-receipt-id',method:'session.prompt',createdAt:Date.now()-5};await context.executeOperation('key',job,{content:[{type:'text',text:'PRIVATE_PROMPT'}]});return context.operationSnapshot(job)}}
}
for(const [name,error,category,status]of[
  ['500',Object.assign(Error('PRIVATE upstream body'),{httpStatus:500,receiptCategory:'upstream-http'}),'upstream-http',500],
  ['network',Object.assign(Error('PRIVATE_TOKEN /private/path'),{cause:{code:'ECONNRESET'}}),'network',undefined],
  ['timeout',Object.assign(Error('PRIVATE timeout'),{name:'TimeoutError'}),'timeout',undefined],
  ['bad-body',Object.assign(Error('PRIVATE_BODY'),{receiptCategory:'invalid-response',httpStatus:200}),'invalid-response',200],
]) test('uncertain receipt preserves safe diagnostic category: '+name,async()=>{
  const f=executor({error}),row=await f.run()
  assert.equal(row.phase,'unknown');assert.equal(row.error,'result-unconfirmed')
  assert.equal(row.diagnostic.category,category);assert.equal(row.diagnostic.httpStatus,status)
  assert.ok(row.diagnostic.durationMs>=0)
  assert.doesNotMatch(JSON.stringify([row,f.logs,f.saved]),/PRIVATE|private\/path|isolated.*content/)
  assert.ok(f.logs.length>0)
})
test('vision preparation rejection retains actionable safe guidance',async()=>{
  const f=executor({body:{result:{ok:false,error:{code:'image-vision-failed',message:'PRIVATE_BODY',details:{reason:'VISION_PLUGIN_MISSING'}}}}}),r=await f.run()
  assert.equal(r.phase,'rejected');assert.match(r.result.result.error.message,/视觉|图片/)
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_BODY/)
})
test('malformed result cannot be reported as a confirmed rejection',async()=>{
  const r=await executor({body:{result:{error:{message:'bad'}}}}).run()
  assert.equal(r.phase,'unknown');assert.equal(r.diagnostic.category,'invalid-response')
})
test('unknown result guidance never hides a confirmed upstream rejection behind an object prototype',async()=>{
  const r=await executor({body:{result:{ok:false,error:{code:'toString',details:{reason:'__proto__'}}}}}).run()
  assert.equal(typeof r.result.result.error.message,'string')
  assert.match(r.result.result.error.message,/主机拒绝/)
})
for(const [status,body,category]of[[500,{error:'PRIVATE_UPSTREAM_BODY'},'upstream-http'],[200,{result:{error:{message:'PRIVATE_UPSTREAM_BODY'}}},'invalid-response']])test('real gateway persists safe '+category+' receipt and never repeats its upstream mutation',async t=>{
  const s=await createRealisticStack({rpcResponse:request=>request.method==='session.prompt'?{status,body}:null});t.after(()=>s.stop())
  const id=crypto.randomUUID(),url=s.base+'/api/operations?id='+id,headers={authorization:'Bearer '+s.token,'content-type':'application/json'}
  const options={method:'POST',headers,body:JSON.stringify({method:'session.prompt',payload:{sessionId:'session-1',mode:'queue',content:[{type:'text',text:'PRIVATE_PROMPT'}]}})}
  assert.equal((await fetch(url,options)).status,202)
  let row
  for(let i=0;i<80;i++){row=await(await fetch(url,{headers})).json();if(row.phase!=='running')break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(row.phase,'unknown');assert.equal(row.diagnostic.category,category);assert.equal(row.diagnostic.httpStatus,status)
  assert.equal(s.records.requests.filter(r=>r.body.method==='session.prompt').length,1)
  assert.equal((await fetch(url,options)).status,200)
  await s.restartGateway()
  const restored=await(await fetch(url,{headers})).json()
  assert.equal(restored.phase,'unknown');assert.deepEqual(restored.diagnostic,row.diagnostic)
  assert.equal((await fetch(url,options)).status,200)
  assert.equal(s.records.requests.filter(r=>r.body.method==='session.prompt').length,1)
  const receiptDir=path.join(s.tmpRoot,'operations'),disk=fs.readdirSync(receiptDir).map(n=>fs.readFileSync(path.join(receiptDir,n),'utf8')).join('')
  assert.doesNotMatch(disk+s.logs(),/PRIVATE_PROMPT|PRIVATE_UPSTREAM_BODY/)
  assert.match(s.logs(),/\[operation\]/)
})
for(const file of ['app.js','desktop/desktop.js']) test(file+': uncertain operation does not gain a send-failed prefix',async()=>{
  const src=fs.readFileSync(path.join(root,'public',file),'utf8'),notices=[]
  const c=vm.createContext({captureConnection:()=>({valid:()=>true}),rpc:async()=>{throw Object.assign(Error('消息可能已写入，请先核对会话'),{operationPending:true})},toast:(...args)=>notices.push(args),authFailure(){},t:k=>k})
  vm.runInContext(src.slice(src.indexOf('async function safeRpc('),src.indexOf('let hostDescribePromise',src.indexOf('async function safeRpc('))),c)
  assert.equal(await c.safeRpc('session.prompt',{},'发送失败'),null)
  assert.equal(notices[0][0],'消息可能已写入，请先核对会话')
})
