'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),net=require('node:net'),{spawn}=require('node:child_process'),{once}=require('node:events')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'gateway.js'),'utf8')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port}
async function fixture(t,{enabled=true,preload=false}={}){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-crash-test-')),port=await freePort(),token='isolated-crash-token',payloads=[]
 let accept=false
 const collector=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{payloads.push(JSON.parse(raw));res.writeHead(accept?200:503,{'content-type':'application/json'});res.end(JSON.stringify({ok:accept}))})});collector.listen(0,'127.0.0.1');await once(collector,'listening')
 const env={...process.env,HOME:tmp,USERPROFILE:tmp,TOKEN:token,TOKEN_FILE:path.join(tmp,'token'),DSH_REMOTE_FS_ROOT:tmp,PORT:String(port),HOST:'127.0.0.1',DSH_UPSTREAM:'http://127.0.0.1:1',DSH_REMOTE_AUTO_RESTART:enabled?'1':'0',DSH_REMOTE_DSH_CONTROL_MODE:'disabled',DSH_REMOTE_FEEDBACK_URL:'http://127.0.0.1:'+collector.address().port+'/submit',DSH_REMOTE_ANNOUNCEMENTS_URL:'',UPDATE_CHECK_URL:'http://127.0.0.1:1'}
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_OPTIONS','NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','DSH_REMOTE_SUPERVISED','DSH_REMOTE_SUPERVISOR_PID','DSH_REMOTE_CRASH_LOG_FILE'])delete env[key]
 if(preload){const helper=path.join(tmp,'preload.cjs');fs.writeFileSync(helper,`const fs=require('node:fs');if(process.env.DSH_REMOTE_SUPERVISED==='1'&&!fs.existsSync(${JSON.stringify(path.join(tmp,'once'))})){setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(tmp,'once'))},'1');throw new TypeError('secret-token /private/conversation/password')},800)}`);env.NODE_OPTIONS='--require='+JSON.stringify(helper)}
 const child=spawn(process.execPath,[path.join(root,'gateway.js'),'--supervise'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c)
 const base='http://127.0.0.1:'+port,headers={authorization:'Bearer '+token,'content-type':'application/json'}
 const health=async()=>{try{return await (await fetch(base+'/health',{signal:AbortSignal.timeout(500)})).json()}catch{return null}}
 const wait=async predicate=>{for(let i=0;i<150;i++){const h=await health();if(h&&await predicate(h))return h;await pause(100)}throw Error('Gateway wait timed out: '+logs)}
 t.after(async()=>{
  try{await fetch(base+'/admin/api/shutdown',{method:'POST',headers,signal:AbortSignal.timeout(1000)})}catch{}
  for(let i=0;i<30&&child.exitCode===null;i++)await pause(100)
  if(child.exitCode===null){try{const h=await health();if(h?.pid)process.kill(h.pid)}catch{}child.kill()}
  await new Promise(r=>collector.close(r));fs.rmSync(tmp,{recursive:true,force:true})
 })
 const first=await wait(()=>true)
 return {tmp,env,child,base,headers,first,health,wait,payloads,accept:()=>{accept=true},logs:()=>logs}
}
test('Supervised gateway logs fatal exception, recovers, survives worker kill; manual shutdown stays stopped',{timeout:25000},async t=>{
 const h=await fixture(t,{preload:true}),first=h.first
 assert.equal(first.runtime.recovery.supervised,true);assert.equal(first.runtime.recovery.supervisorPid,h.child.pid)
 const recovered=await h.wait(v=>v.pid!==first.pid);assert.notEqual(recovered.pid,first.pid)
 process.kill(recovered.pid)
 const again=await h.wait(v=>v.pid!==recovered.pid)
 const rows=await (await fetch(h.base+'/crash-logs',{headers:h.headers})).json()
 assert.ok(rows.records.some(r=>r.kind==='fatal'&&r.errorName==='TypeError'));assert.ok(rows.records.filter(r=>r.kind==='restart').length>=2)
 assert.doesNotMatch(JSON.stringify(rows),/secret-token|private|conversation|password/)
 assert.equal((await fetch(h.base+'/crash-logs')).status,401)
 await fetch(h.base+'/admin/api/shutdown',{method:'POST',headers:h.headers})
 await once(h.child,'exit');await pause(1200);assert.equal(await h.health(),null);assert.equal(h.child.exitCode,0)
 assert.equal(fs.existsSync(path.join(h.tmp,'.dsh-remote','gateway-supervisor-'+new URL(h.base).port+'.json')),false)
})
test('Recovery can be disabled; normal process exit never restarts',{timeout:15000},async t=>{
 const h=await fixture(t,{enabled:false});process.kill(h.first.pid);await once(h.child,'exit');await pause(1200);assert.equal(await h.health(),null)
 const records=fs.readFileSync(path.join(h.tmp,'.dsh-remote','crashes.jsonl'),'utf8');assert.doesNotMatch(records,/"kind":"restart"/)
})
test('Crash upload is opt-in, uses existing collector and bounded safe serverInfo compatible with deployed server',{timeout:15000},async t=>{
 const h=await fixture(t)
 const file=path.join(h.tmp,'.dsh-remote','crashes.jsonl');fs.appendFileSync(file,JSON.stringify({at:Date.now(),component:'gateway',kind:'fatal',errorName:'TypeError',code:'TOKEN_SECRET',message:'never-upload',token:'private-token',path:'C:/private/path',frames:[{file:'gateway.js',line:123,column:4},{file:'/private/path',line:5,column:1}]})+'\n')
 let response=await fetch(h.base+'/feedback',{method:'POST',headers:h.headers,body:JSON.stringify({type:'bug',message:'test',includeCrashLogs:false})});assert.equal(response.status,502);assert.equal(h.payloads[0].serverInfo,undefined)
 const preview=await (await fetch(h.base+'/crash-logs',{headers:h.headers})).json()
 h.accept();response=await fetch(h.base+'/feedback',{method:'POST',headers:h.headers,body:JSON.stringify({type:'bug',message:'test',includeCrashLogs:true,crashLogs:'untrusted-private-content'})});assert.equal(response.status,200)
 const uploaded=h.payloads[1].serverInfo;assert.ok(uploaded.length<=500);assert.deepEqual(JSON.parse(uploaded),preview.upload);assert.match(uploaded,/TypeError/);assert.doesNotMatch(uploaded,/private|never-upload|TOKEN_SECRET|untrusted/)
 // A string value is not consent.
 assert.match(source,/payload\.includeCrashLogs === true/)
})
test('Android/Capacitor crash preview supports authenticated cross-origin GET and preflight, stays read-only',{timeout:15000},async t=>{
 const h=await fixture(t),origin='https://localhost'
 let response=await fetch(h.base+'/crash-logs',{method:'OPTIONS',headers:{origin,'access-control-request-method':'GET','access-control-request-headers':'authorization'}})
 assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.match(response.headers.get('access-control-allow-headers'),/authorization/)
 response=await fetch(h.base+'/crash-logs',{headers:{...h.headers,origin}});assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),origin)
 response=await fetch(h.base+'/crash-logs',{method:'POST',headers:h.headers});assert.equal(response.status,405)
 response=await fetch(h.base+'/crash-logs',{headers:{...h.headers,origin:'https://untrusted.invalid'}});assert.equal(response.headers.get('access-control-allow-origin'),null)
})
test('Duplicate supervisor lease cannot spawn a second worker',{timeout:15000},async t=>{
 const h=await fixture(t),other=spawn(process.execPath,[path.join(root,'gateway.js'),'--supervise'],{cwd:root,env:h.env,windowsHide:true,stdio:'ignore'})
 const [code]=await once(other,'exit');assert.equal(code,78);assert.equal((await h.health()).pid,h.first.pid)
})
test('Crash identity rejects normal disappearance, stale PID, unrelated executable and old events',()=>{
 const start=source.indexOf('function matchingDesktopCrash('),end=source.indexOf('async function desktopCrashEvidence',start),ctx=vm.createContext({path,Date,Number})
 vm.runInContext(source.slice(start,end),ctx)
 const started=new Date(Date.now()-30000).toISOString(),config={executable:path.resolve('Desktop.exe'),desktop:{root:{pid:1,started},host:{pid:2,started}}},event={pid:'0x1',executable:config.executable,at:new Date().toISOString()}
 assert.equal(ctx.matchingDesktopCrash(config,[event]),true)
 for(const changed of [{pid:3},{executable:path.resolve('Other.exe')},{at:new Date(Date.now()-180000).toISOString()},{at:'invalid'}])assert.equal(ctx.matchingDesktopCrash(config,[{...event,...changed}]),false)
 assert.equal(ctx.matchingDesktopCrash(config,[]),false)
})
test('DSH retry budget stops crash loops and intentional owned child exits are ignored',()=>{
 const start=source.indexOf('const recoveryAttempts='),end=source.indexOf('function matchingDesktopCrash(',start),records=[],timers=[]
 const ctx=vm.createContext({Map,Date,AUTO_RESTART:true,recordCrash:(...args)=>records.push(args),setTimeout:fn=>{timers.push(fn);return timers.length},dshControlOperation:null})
 vm.runInContext(source.slice(start,end)+';this.maps={recoveryAttempts,recoveryTimers}',ctx)
 for(let i=0;i<6;i++){ctx.maps.recoveryTimers.clear();ctx.scheduleDshRecovery('desktop','identity',42,'start')}
 assert.equal(timers.length,5);assert.equal(records.at(-1)[1],'restart-limit')
 const {EventEmitter}=require('node:events'),child=new EventEmitter();child.pid=42;ctx.desktopChildren=new Map();ctx.intentionalDshStops=new WeakSet([child]);ctx.watchDshChild(child,'desktop');child.emit('exit',1,'SIGTERM');assert.equal(records.length,6)
})
test('Both clients reset log consent and provide an accessible preview',()=>{
 for(const [js,html]of [['app.js','index.html'],['desktop/desktop.js','desktop/desktop.html']]){
  const script=fs.readFileSync(path.join(root,'public',js),'utf8'),page=fs.readFileSync(path.join(root,'public',html),'utf8')
  assert.match(script,/\$\('fb-include-crashes'\)\.checked = false/);assert.match(script,/includeCrashLogs/);assert.match(page,/<details id="fb-crash-details"/);assert.doesNotMatch(page,/id="fb-include-crashes"[^>]*checked/)
 }
})
