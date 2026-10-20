'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),net=require('node:net'),{spawn}=require('node:child_process'),{once}=require('node:events')
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'gateway.js'),'utf8')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port}
async function fixture(t,{enabled=true,preload=false,lease}={}){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-crash-test-')),port=await freePort(),token='isolated-crash-token',payloads=[]
 let accept=false
 const collector=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{payloads.push(JSON.parse(raw));res.writeHead(accept?200:503,{'content-type':'application/json'});res.end(JSON.stringify({ok:accept}))})});collector.listen(0,'127.0.0.1');await once(collector,'listening')
 const env={...process.env,HOME:tmp,USERPROFILE:tmp,TOKEN:token,TOKEN_FILE:path.join(tmp,'token'),DSH_REMOTE_FS_ROOT:tmp,PORT:String(port),HOST:'127.0.0.1',DSH_UPSTREAM:'http://127.0.0.1:1',DSH_REMOTE_AUTO_RESTART:enabled?'1':'0',DSH_REMOTE_DSH_CONTROL_MODE:'disabled',DSH_REMOTE_FEEDBACK_URL:'http://127.0.0.1:'+collector.address().port+'/submit',DSH_REMOTE_ANNOUNCEMENTS_URL:'',UPDATE_CHECK_URL:'http://127.0.0.1:1'}
 for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_OPTIONS','NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','DSH_REMOTE_SUPERVISED','DSH_REMOTE_SUPERVISOR_PID','DSH_REMOTE_CRASH_LOG_FILE'])delete env[key]
 if(preload){const helper=path.join(tmp,'preload.cjs');fs.writeFileSync(helper,`const fs=require('node:fs');if(process.env.DSH_REMOTE_SUPERVISED==='1'&&!fs.existsSync(${JSON.stringify(path.join(tmp,'once'))})){setTimeout(()=>{fs.writeFileSync(${JSON.stringify(path.join(tmp,'once'))},'1');throw new TypeError('secret-token /private/conversation/password')},800)}`);env.NODE_OPTIONS='--require='+JSON.stringify(helper)}
 if(typeof lease==='function')lease=await lease(tmp,env)
 if(lease!==undefined){fs.mkdirSync(path.join(tmp,'.dsh-remote'),{recursive:true});fs.writeFileSync(path.join(tmp,'.dsh-remote','gateway-supervisor-'+port+'.json'),typeof lease==='string'?lease:JSON.stringify(lease))}
 let logs='';const children=[],exited=new WeakSet(),start=()=>{
  const child=spawn(process.execPath,[path.join(root,'gateway.js'),'--supervise'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  children.push(child);child.once('exit',()=>exited.add(child));child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);return child
 }
 const child=start()
 const base='http://127.0.0.1:'+port,headers={authorization:'Bearer '+token,'content-type':'application/json'}
 const health=async()=>{try{return await (await fetch(base+'/health',{signal:AbortSignal.timeout(500)})).json()}catch{return null}}
 const wait=async predicate=>{for(let i=0;i<150;i++){const h=await health();if(h&&await predicate(h))return h;if(children.every(c=>exited.has(c)))throw Error('Supervisor exited before gateway recovered: '+logs);await pause(100)}throw Error('Gateway wait timed out: '+logs)}
 t.after(async()=>{
  try{await fetch(base+'/admin/api/shutdown',{method:'POST',headers,signal:AbortSignal.timeout(1000)})}catch{}
  for(let i=0;i<30&&children.some(c=>!exited.has(c));i++)await pause(100)
  if(children.some(c=>!exited.has(c))){try{const h=await health();if(h?.pid)process.kill(h.pid)}catch{}for(const c of children)if(!exited.has(c))c.kill('SIGKILL')}
  for(let i=0;i<30&&children.some(c=>!exited.has(c));i++)await pause(100)
  assert.ok(children.every(c=>exited.has(c)),'all isolated supervisors must exit before removing the temporary directory')
  await new Promise(r=>collector.close(r));fs.rmSync(tmp,{recursive:true,force:true})
 })
 const first=await wait(()=>true)
 return {tmp,env,child,start,exited,base,headers,first,health,wait,payloads,accept:()=>{accept=true},logs:()=>logs}
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
 const h=await fixture(t),file=path.join(h.tmp,'.dsh-remote','gateway-supervisor-'+new URL(h.base).port+'.json'),before=fs.readFileSync(file,'utf8'),other=h.start()
 const [code]=await once(other,'exit');assert.equal(code,78);assert.equal((await h.health()).pid,h.first.pid)
 assert.equal(fs.readFileSync(file,'utf8'),before,'a losing contender must not overwrite or remove the owner lease')
 const records=JSON.parse((await (await fetch(h.base+'/crash-logs',{headers:h.headers})).text())).records
 assert.ok(records.some(r=>r.kind==='lease-conflict'&&r.code==='SUPERVISOR_ALREADY_RUNNING'&&r.exitCode===78))
})

test('Stale legacy supervisor lease pointing at an unrelated live PID recovers without killing that process',{timeout:15000},async t=>{
 const h=await fixture(t,{lease:{pid:process.pid,nonce:'old-owner'}})
 assert.equal(h.first.runtime.recovery.supervisorPid,h.child.pid)
 assert.doesNotThrow(()=>process.kill(process.pid,0))
 const lease=JSON.parse(fs.readFileSync(path.join(h.tmp,'.dsh-remote','gateway-supervisor-'+new URL(h.base).port+'.json'),'utf8'))
 assert.equal(lease.pid,h.child.pid);assert.notEqual(lease.nonce,'old-owner')
 const records=fs.readFileSync(path.join(h.tmp,'.dsh-remote','crashes.jsonl'),'utf8');assert.match(records,/"kind":"lease-recovered"/)
})

test('Malformed leases and invalid PID values cannot permanently block supervisor startup',{timeout:20000},async t=>{
 for(const lease of ['{truncated',null,{pid:0,nonce:'bad'},{pid:-1,nonce:'bad'},{pid:'123',nonce:'bad'},{version:2,pid:process.pid,nonce:'dead-v2'}]){
  await t.test(JSON.stringify(lease),async t=>{const h=await fixture(t,{lease});assert.equal(h.first.runtime.recovery.supervisorPid,h.child.pid)})
 }
})

test('A live legacy supervisor keeps its lease during migration',{timeout:15000},async t=>{
 let legacy,leaseFile
 await assert.rejects(fixture(t,{lease:async(tmp,env)=>{
  leaseFile=path.join(tmp,'.dsh-remote','gateway-supervisor-'+env.PORT+'.json')
  const script=path.join(tmp,'gateway.cjs');fs.writeFileSync(script,'setInterval(()=>{},1000)')
  legacy=spawn(process.execPath,[script,'--supervise'],{cwd:tmp,env,windowsHide:true,stdio:'ignore'})
  await once(legacy,'spawn')
  t.after(async()=>{const done=once(legacy,'exit');legacy.kill('SIGKILL');await done})
  return {pid:legacy.pid,nonce:'genuine-legacy'}
 }}),/supervisor already running/)
 assert.equal(legacy.exitCode,null);assert.doesNotThrow(()=>process.kill(legacy.pid,0))
 assert.deepEqual(JSON.parse(fs.readFileSync(leaseFile,'utf8')),{pid:legacy.pid,nonce:'genuine-legacy'})
})

test('Lease write failures record a safe startup diagnostic instead of disappearing behind exit 78',{timeout:15000},async t=>{
 let crashFile
 await assert.rejects(fixture(t,{lease:async(tmp,env)=>{
  fs.mkdirSync(path.join(tmp,'.dsh-remote','gateway-supervisor-'+env.PORT+'.json'),{recursive:true})
  crashFile=path.join(tmp,'.dsh-remote','crashes.jsonl')
 }}),/cannot acquire supervisor lease/)
 const record=JSON.parse(fs.readFileSync(crashFile,'utf8').trim())
 assert.equal(record.kind,'lease-failed');assert.equal(record.exitCode,78)
 assert.doesNotMatch(JSON.stringify(record),/dsh-crash-test|token|command/i)
})

test('Forced supervisor death releases the kernel lock and concurrent replacements elect one owner',{timeout:15000},async t=>{
 const h=await fixture(t),file=path.join(h.tmp,'.dsh-remote','gateway-supervisor-'+new URL(h.base).port+'.json'),old=fs.readFileSync(file,'utf8')
 const dead=once(h.child,'exit');h.child.kill('SIGKILL');await dead
 assert.equal(fs.readFileSync(file,'utf8'),old,'forced termination must leave the stale lease for this regression')
 try{process.kill(h.first.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error} // Windows may already have terminated the process tree.
 for(let i=0;i<50&&await h.health();i++)await pause(50)
 assert.equal(await h.health(),null)
 const contenders=[h.start(),h.start(),h.start()]
 const recovered=await h.wait(v=>v.pid!==h.first.pid),owner=contenders.find(c=>c.pid===recovered.runtime.recovery.supervisorPid)
 assert.ok(owner)
 for(let i=0;i<50&&contenders.filter(c=>h.exited.has(c)).length<2;i++)await pause(50)
 assert.deepEqual(contenders.filter(c=>c!==owner).map(c=>c.exitCode),[78,78])
 const lease=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(lease.pid,owner.pid);assert.equal(lease.version,2)
 assert.equal((await h.health()).pid,recovered.pid)
})

test('Legacy identity requires a supervisor command born before the lease; lookup failures fail closed',async()=>{
 const start=source.indexOf('async function legacyGatewaySupervisorAlive('),end=source.indexOf('async function lockGatewaySupervisor(',start),now=Date.now()
 let identity={command:'"C:\\Node\\node.exe" "C:\\plugin\\gateway.cjs" --supervise',started:new Date(now-5000).toISOString()},failure=null,lookups=0
 const c=vm.createContext({path,Buffer,process:{platform:'win32',execPath:'C:\\Node\\node.exe',env:{},kill:(_pid,signal)=>assert.equal(signal,0)},execFile:(_file,_args,options,done)=>{lookups++;assert.equal(options.windowsHide,true);assert.equal(options.timeout,5000);done(failure,JSON.stringify(identity))}})
 vm.runInContext(source.slice(start,end),c)
 assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},now),true)
 assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},now-10000),false,'a reused PID can run the same command but was born after the lease')
 identity.command='wslhost.exe --supervise';assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},now),false)
 identity.command='node.exe gateway.cjs';assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},now),false)
 const before=lookups;for(const pid of [0,-1,'42',undefined])assert.equal(await c.legacyGatewaySupervisorAlive({pid},now),false);assert.equal(lookups,before)
 failure=Object.assign(Error('private command path'),{code:'EACCES'})
 await assert.rejects(c.legacyGatewaySupervisorAlive({pid:42},now),{code:'SUPERVISOR_IDENTITY_UNAVAILABLE',message:'cannot verify legacy supervisor identity'})
 c.process.kill=()=>{throw Object.assign(Error(),{code:'ESRCH'})};assert.equal(await c.legacyGatewaySupervisorAlive({pid:42},now),false)
})

test('Supervisor IPC keeps Node 18 compatibility and uses kernel-cleaned endpoints when supported',async()=>{
 const start=source.indexOf('async function lockGatewaySupervisor('),end=source.indexOf('async function runGatewaySupervisor(',start),{EventEmitter}=require('node:events')
 for(const [platform,node,prefix]of [['win32','18.0.0','\\\\.\\pipe\\'],['linux','18.20.0',os.tmpdir()],['linux','20.7.0',os.tmpdir()],['linux','20.8.0','\0'],['linux','22.0.0','\0'],['darwin','22.0.0',os.tmpdir()]]){
  let endpoint
  class Server extends EventEmitter{listen(value){endpoint=value;queueMicrotask(()=>this.emit('listening'))}}
  const c=vm.createContext({fs:{realpathSync:()=>root},path,os,crypto:require('node:crypto'),process:{platform,versions:{node}},net:{createServer:()=>new Server()}})
  vm.runInContext(source.slice(start,end),c);await c.lockGatewaySupervisor(path.join(root,'lease.json'))
  assert.ok(endpoint.startsWith(prefix),platform+' Node '+node)
 }
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
