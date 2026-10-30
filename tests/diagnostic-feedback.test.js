'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm')
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events'),readline=require('node:readline'),http=require('node:http')
const {createDiagnostics,createDiagnosticSchema}=require('../public/diagnostics.js')
const {createRealisticStack}=require('./fixtures/realistic-stack.cjs')
const schema=createDiagnosticSchema(),root=path.resolve(__dirname,'..')
class Hasher{constructor(){this.value=crypto.createHash('sha256')}update(bytes){this.value.update(bytes);return this}hex(){return this.value.digest('hex')}}
function logger(backing=new Map(),options={}){
  const data=options.data||new Map(),session=new Map(),handlers={}
  const quota=()=>Object.assign(new Error('PRIVATE storage full'),{name:'QuotaExceededError'})
  const localStorage={get length(){return data.size},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem:(k,v)=>{if(options.full)throw quota();data.set(k,v)},removeItem:k=>data.delete(k)}
  const db={close(){},transaction(name,mode){
    const tx={abort(){tx.aborted=true;tx.error={name:'AbortError'};tx.onabort?.()}},request={};let pending
    tx.objectStore=()=>({get:()=>{request.result=backing.get('latest');return request},put:value=>{pending=value;return request}})
    setImmediate(()=>{if(tx.aborted)return;if(options.abort&&mode==='readwrite'){tx.error={name:'QuotaExceededError'};tx.onabort?.();return}request.onsuccess?.();if(mode==='readwrite')backing.set('latest',pending);tx.oncomplete?.()})
    return tx
  }}
  const env={crypto:crypto.webcrypto,SHA256:Hasher,localStorage,sessionStorage:{getItem:k=>session.get(k)??null,setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)},navigator:{onLine:true},
    indexedDB:{open:()=>{const request={result:db};setImmediate(()=>request.onsuccess?.());return request}},setTimeout,clearTimeout,addEventListener:(k,v)=>{handlers[k]=v},
    document:{visibilityState:'visible',getElementById:()=>null,addEventListener(){}}}
  const d=createDiagnostics(env);d.build({version:'0.8.1',buildId:'b'.repeat(64)})
  return {d,data,session,backing,env,handlers}
}

test('Old failures survive heavy normal traffic and storage inventory exposes pressure without exporting cached content',async()=>{
  const data=new Map([['historyCacheV1','PRIVATE_BODY'.repeat(1000)],['historyCacheV2:abc','SECRET_BODY'.repeat(1000)],['sessionsCacheV2:abc','PRIVATE_SESSION']])
  const h=logger(new Map(),{data})
  await h.d.ready
  h.d.record('storage.write',{phase:'failed',storageKey:'history',errorName:'QuotaExceededError',category:'storage',token:'SECRET',value:'PRIVATE_BODY'})
  for(let i=0;i<1200;i++)h.d.record('rpc',{phase:'complete',method:'session.list',count:i})
  await h.d.flush()
  const report=h.d.report()
  assert.equal(report.events.length,160);assert.ok(report.events.some(row=>row.errorName==='QuotaExceededError'))
  assert.equal(report.snapshot.legacyCacheKeys,2);assert.ok(report.snapshot.legacyCacheChars>10000);assert.ok(report.snapshot.droppedEvents>0)
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE|SECRET|CacheV2:abc/)
  assert.ok(JSON.stringify(report).length<=schema.MAX_BYTES)
})

test('A full localStorage retains a quota failure in IndexedDB across a new logger instance',async()=>{
  const backing=new Map(),h=logger(backing,{full:true})
  await h.d.ready
  h.d.storageFailure('announcementHistoryV1',Object.assign(new Error('PRIVATE'),{name:'QuotaExceededError'}))
  await h.d.flush()
  assert.equal(h.d.report().persistence.local,'failed');assert.equal(h.d.report().persistence.indexeddb,'saved')
  assert.ok(backing.get('latest').events.some(row=>row.kind==='storage.write'&&row.errorName==='QuotaExceededError'))
  const restored=logger(backing,{full:true})
  restored.d.record('client.lifecycle',{status:'visible'})
  await restored.d.flush()
  assert.ok(restored.d.report().events.some(row=>row.kind==='storage.write'))
  assert.ok(backing.get('latest').events.some(row=>row.kind==='storage.write'),'initial lifecycle flush must not overwrite restored failures')
  restored.d.clear();await restored.d.flush()
  assert.equal(backing.get('latest').events.length,0)
})

test('An aborted backup is reported as a failure rather than a successful durable write',async()=>{
  const h=logger(new Map(),{full:true,abort:true});await h.d.ready
  h.d.record('client.error',{phase:'failed',errorName:'TypeError'})
  await h.d.flush()
  assert.equal(h.backing.size,0);assert.equal(h.d.report().persistence.indexeddb,'failed')
  assert.ok(h.d.report().events.some(row=>row.kind==='diagnostics.persist'&&row.storageBackend==='indexeddb'))
  assert.ok(h.session.has('dshRemoteDiagnosticsV1'))
})

const python=(process.platform==='win32'?['python','python3']:['python3','python']).find(command=>spawnSync(command,['--version'],{encoding:'utf8',timeout:3000,windowsHide:true}).status===0)
async function collector(t){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-feedback-diagnostics-'))
  const code=`import importlib.util,sys,os\nspec=importlib.util.spec_from_file_location('collector',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nm.DATA_DIR=sys.argv[2];m.DATA_FILE=os.path.join(m.DATA_DIR,'feedback.jsonl');m.RATE_LIMIT_SEC=0\nserver=m.ThreadingHTTPServer(('127.0.0.1',0),m.Handler)\nprint(server.server_address[1],flush=True)\nserver.serve_forever()`
  const env={...process.env,HOME:tmp,USERPROFILE:tmp,DSH_REMOTE_FS_ROOT:tmp,PYTHONDONTWRITEBYTECODE:'1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:''};delete env.NODE_USE_ENV_PROXY
  const child=spawn(python,['-u','-c',code,path.join(root,'ops/feedback-collector/server.py'),tmp],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk})
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit')}fs.rmSync(tmp,{recursive:true,force:true})})
  const lines=readline.createInterface({input:child.stdout})
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('collector startup timed out '+stderr)),5000);lines.once('line',line=>{clearTimeout(timer);resolve(Number(line))});child.once('exit',()=>{clearTimeout(timer);reject(Error(stderr))})})
  return {url:'http://127.0.0.1:'+port+'/submit',file:path.join(tmp,'feedback.jsonl')}
}
function report(){
  const value={schema:1,reportId:'a'.repeat(24),capturedAt:Date.now(),client:{version:'0.8.1',buildId:'b'.repeat(64),surface:'mobile',token:'PRIVATE'},snapshot:{storageChars:5242622,legacyCacheChars:4839966,legacyCacheKeys:2,server:'PRIVATE'},events:[]}
  value.events.push({at:Date.now(),kind:'storage.write',phase:'failed',storageKey:'history',errorName:'QuotaExceededError',message:'PRIVATE',frames:[{file:'app.js',line:14,column:1}]})
  for(let i=0;i<159;i++)value.events.push({at:Date.now(),kind:'rpc',phase:'complete',method:'session.history',traceId:i.toString(16).padStart(24,'0'),sessionRef:'c'.repeat(16),serverRef:'d'.repeat(16),durationMs:10,httpStatus:200})
  return value
}

test('Opt-in report survives the real gateway and Python collector and receives a report-specific disk receipt',{skip:!python},async t=>{
  const service=await collector(t),stack=await createRealisticStack({feedbackUrl:service.url});t.after(()=>stack.stop())
  const client=report(),payload={type:'bug',message:'Diagnostic regression',includeDiagnostics:true,includeCrashLogs:true,clientDiagnostics:client}
  assert.ok(JSON.stringify(payload).length>16384)
  const response=await fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token,'content-type':'application/json'},body:JSON.stringify(payload)})
  assert.equal(response.status,200);const receipt=await response.json();assert.deepEqual(receipt.diagnostics,{reportId:client.reportId,saved:true})
  const saved=JSON.parse(fs.readFileSync(service.file,'utf8').trim())
  assert.deepEqual(saved.clientDiagnostics,schema.sanitizeReport(client));assert.equal(saved.diagnostics.schema,1)
  assert.ok(saved.clientDiagnostics.events.some(row=>row.errorName==='QuotaExceededError'));assert.equal(saved.clientDiagnostics.snapshot.legacyCacheChars,4839966)
  assert.ok(saved.serverInfo.length<=500);assert.doesNotMatch(JSON.stringify(saved),/PRIVATE/)
})

test('20000-character feedback with worst-case JSON escaping and diagnostics is saved verbatim',{skip:!python},async t=>{
  const service=await collector(t),stack=await createRealisticStack({feedbackUrl:service.url});t.after(()=>stack.stop())
  const message='\u0001'.repeat(20000),client=report(),payload={type:'bug',message,includeDiagnostics:true,clientDiagnostics:client}
  assert.ok(Buffer.byteLength(JSON.stringify(payload))>96*1024)
  const response=await fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token,'content-type':'application/json'},body:JSON.stringify(payload)})
  assert.equal(response.status,200);assert.equal((await response.json()).diagnostics.saved,true)
  assert.equal(JSON.parse(fs.readFileSync(service.file,'utf8').trim()).message,message)
  const tooLong=await fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token},body:JSON.stringify({type:'bug',message:'x'.repeat(20001)})})
  assert.equal(tooLong.status,400);assert.equal((await tooLong.json()).max,20000)
})
test('collector and browser limits count emoji consistently as UTF-16 units',{skip:!python},async t=>{
  const service=await collector(t),message='😀'.repeat(10000)
  let response=await fetch(service.url,{method:'POST',body:JSON.stringify({type:'bug',message})})
  assert.equal(response.status,200);assert.equal((await response.json()).messageSha256,crypto.createHash('sha256').update(message).digest('hex'))
  response=await fetch(service.url,{method:'POST',body:JSON.stringify({type:'bug',message:message+'x'})})
  assert.equal(response.status,400);assert.equal((await response.json()).max,20000)
  response=await fetch(service.url,{method:'POST',body:JSON.stringify({type:'poll',message:'x'.repeat(2001)})})
  assert.equal(response.status,400);assert.equal((await response.json()).max,2000)
  const preserved='\u0085\u001c正文\u0085'
  response=await fetch(service.url,{method:'POST',body:JSON.stringify({type:'bug',message:preserved})})
  assert.equal(response.status,200);assert.equal((await response.json()).messageSha256,crypto.createHash('sha256').update(preserved).digest('hex'))
})
test('legacy collector length rejection and mismatched content receipts are explicit and never truncate or resend',async t=>{
  for(const mismatch of [false,true]){
    const received=[],server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push(JSON.parse(raw));res.setHeader('content-type','application/json');res.writeHead(mismatch?200:400);res.end(JSON.stringify(mismatch?{ok:true,messageSha256:'bad'}:{ok:false,error:'message required, <=2000 chars'}))})
    server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)))
    const stack=await createRealisticStack({feedbackUrl:'http://127.0.0.1:'+server.address().port+'/submit'});t.after(()=>stack.stop())
    const message='report'.repeat(600),response=await fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token},body:JSON.stringify({type:'bug',message})})
    assert.equal(response.status,mismatch?502:413);assert.equal((await response.json()).error,mismatch?'feedback-content-unconfirmed':'collector-message-limit')
    assert.equal(received.length,1);assert.equal(received[0].message,message)
  }
})

test('A legacy collector gets the bounded root-cause summary and cannot falsely acknowledge the complete report',async t=>{
  const stack=await createRealisticStack();t.after(()=>stack.stop());const client=report()
  const response=await fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token},body:JSON.stringify({type:'bug',message:'test',includeDiagnostics:true,clientDiagnostics:client})})
  assert.equal(response.status,200);assert.equal((await response.json()).diagnostics.saved,false)
  const summary=JSON.parse(stack.records.feedback[0].serverInfo)
  assert.equal(summary.storage.legacy,4839966);assert.equal(summary.reportId,client.reportId);assert.ok(stack.records.feedback[0].serverInfo.length<=500)
})

test('A deployed 16 KB collector gets exactly one accepted summary after explicitly rejecting the large report',async t=>{
  const accepted=[];let rejected=0
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk
    res.setHeader('content-type','application/json')
    if(Buffer.byteLength(raw)>16384){rejected++;res.writeHead(400);res.end(JSON.stringify({ok:false,error:'bad body size'}));return}
    const body=JSON.parse(raw);accepted.push({message:body.message,serverInfo:body.serverInfo,hasFullClient:!!body.clientDiagnostics})
    res.end(JSON.stringify({ok:true}))
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)))
  const stack=await createRealisticStack({feedbackUrl:'http://127.0.0.1:'+server.address().port+'/submit'});t.after(()=>stack.stop())
  const response=await fetch(stack.base+'/feedback',{method:'POST',headers:{authorization:'Bearer '+stack.token},body:JSON.stringify({type:'bug',message:'legacy size regression',includeDiagnostics:true,clientDiagnostics:report()})})
  assert.equal(response.status,200);assert.equal((await response.json()).diagnostics.saved,false)
  assert.equal(rejected,1);assert.equal(accepted.length,1);assert.equal(accepted[0].hasFullClient,false)
  assert.equal(JSON.parse(accepted[0].serverInfo).storage.legacy,4839966)
})

test('Collector strips poisoned fields and ignores diagnostic attachments without literal consent',{skip:!python},async t=>{
  const service=await collector(t),client=report()
  let response=await fetch(service.url,{method:'POST',body:JSON.stringify({type:'bug',message:'no attachments',includeDiagnostics:'true',clientDiagnostics:client,diagnostics:{schema:1,token:'PRIVATE'}})})
  assert.equal(response.status,200);assert.equal((await response.json()).clientDiagnosticsReceived,undefined)
  let saved=JSON.parse(fs.readFileSync(service.file,'utf8').trim());assert.equal(saved.clientDiagnostics,undefined);assert.equal(saved.diagnostics,undefined)
  client.events[0].frames.push({file:{PRIVATE:true},line:1,column:1})
  response=await fetch(service.url,{method:'POST',body:JSON.stringify({type:'bug',message:'poisoned',includeDiagnostics:true,clientDiagnostics:client})})
  assert.equal(response.status,200);assert.equal((await response.json()).clientDiagnosticsReceived,client.reportId)
  saved=JSON.parse(fs.readFileSync(service.file,'utf8').trim().split('\n').at(-1));assert.doesNotMatch(JSON.stringify(saved),/PRIVATE/)
})

for(const file of ['app.js','desktop/desktop.js'])test(file+': client report is attached only when selected, and a missing receipt is visible',async()=>{
  const source=fs.readFileSync(path.join(root,'public',file),'utf8'),start=source.indexOf('async function submitFeedback()'),end=source.indexOf('\nfunction ',start),nodes=new Map(),sent=[],toasts=[]
  let reports=0,opened=0,selected=false
  const context={state:{localVersion:'0.8.1',token:'test-token',feedbackType:'bug'},I18N:{lang:'zh'},t:k=>k,
    $:id=>{if(!nodes.has(id))nodes.set(id,{value:id==='fb-msg'?'test':'',checked:false,disabled:false,textContent:'',classList:{toggle(){}}});return nodes.get(id)},
    document:{querySelector:()=>({dataset:{fbType:'bug'}})},updateBase:()=>'',apiUrl:x=>x,
    DshDiagnostics:{report:()=>{reports++;return schema.sanitizeReport(report())},start:()=>({end(){},fail(){}})},
    fetch:async(url,options)=>{sent.push(JSON.parse(options.body));return {ok:true,status:200,json:async()=>({ok:true})}},
    closeFeedbackModal(){},openFeedbackSuccess(){opened++},toast:(text)=>toasts.push(text)}
  context.updateBase=()=> 'http://gateway.invalid';vm.createContext(context);vm.runInContext(source.slice(start,end),context)
  await context.submitFeedback();assert.equal(reports,0);assert.equal(sent[0].clientDiagnostics,undefined)
  context.$('fb-include-diagnostics').checked=true;await context.submitFeedback();assert.equal(reports,1);assert.equal(sent[1].clientDiagnostics.reportId,'a'.repeat(24))
  if(file==='app.js'){assert.equal(opened,2);assert.match(nodes.get('feedback-diagnostics-status').textContent,/未确认/)}else assert.match(toasts.at(-1),/未获保存确认/)
})

for(const file of ['app.js','desktop/desktop.js'])test(file+': feedback retains pasted over-limit text and sends 20000 characters without clipping',async()=>{
  const source=fs.readFileSync(path.join(root,'public',file),'utf8'),start=source.indexOf('async function submitFeedback()'),end=source.indexOf('\nfunction ',start),nodes=new Map(),sent=[]
  const context={state:{token:'test-token',feedbackType:'bug'},I18N:{lang:'zh'},t:k=>k,$:id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,classList:{toggle(){}}});return nodes.get(id)},document:{querySelector:()=>({dataset:{fbType:'bug'}})},updateBase:()=> 'http://gateway.invalid',apiUrl:x=>x,closeFeedbackModal(){},openFeedbackSuccess(){},toast(){},fetch:async(url,options)=>{sent.push(JSON.parse(options.body));return{ok:false,status:413,json:async()=>({error:'collector-message-limit',max:2000})}}}
  vm.createContext(context);vm.runInContext(source.slice(start,end),context)
  const field=context.$('fb-msg');field.value='汉'.repeat(20001);await context.submitFeedback();assert.equal(sent.length,0);assert.equal(field.value.length,20001)
  field.value='汉'.repeat(20000);await context.submitFeedback();assert.equal(sent[0].message,field.value);assert.equal(field.value.length,20000)
  const html=fs.readFileSync(path.join(root,'public',file==='app.js'?'index.html':'desktop/desktop.html'),'utf8')
  assert.doesNotMatch(html.match(/<textarea[^>]*id="fb-msg"[^>]*>/)[0],/maxlength/i)
})
