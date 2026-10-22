'use strict'
// Opt-in, isolated real DSH: cold persistence records never belong to the user's profile.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{pathToFileURL}=require('node:url'),{spawn}=require('node:child_process'),{once}=require('node:events'),net=require('node:net')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const stress=process.env.DSH_TEST_OBSERVATION_STRESS==='1'
test('issue 21: real DSH keeps the cold catalog cold at gateway startup and history reads; selected live sessions still stream',{skip:!process.env.DSH_TEST_CLI_ROOT,timeout:stress?240000:90000},async t=>{
 const root=path.resolve(__dirname,'..'),cli=process.env.DSH_TEST_CLI_ROOT,home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-observation-')),children=[]
 const count=Number(process.env.DSH_TEST_COLD_SESSIONS||220),token='isolated-observation-token'
 assert.ok(Number.isInteger(count)&&count>0&&count<=1000)
 const env={}
 for(const name of ['PATH','SystemRoot','ComSpec','PATHEXT','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[name]!==undefined)env[name]=process.env[name]
 Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'appdata'),LOCALAPPDATA:path.join(home,'localappdata'),DSH_HOME:path.join(home,'.dsh'),DSH_REMOTE_FS_ROOT:home,TOKEN:token,DSH_REMOTE_TOKEN:token,TOKEN_FILE:path.join(home,'token'),DSH_REMOTE_AUTOSTART:'0',DSH_REMOTE_AUTO_RESTART:'0',DSH_REMOTE_DSH_CONTROL_MODE:'disabled',DSH_REMOTE_ANNOUNCEMENTS_URL:'',UPDATE_CHECK_URL:'http://127.0.0.1:1'})
 t.after(async()=>{for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done}fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
 const fixture=path.join(home,'observation.mjs'),patch=path.join(home,'patch.json')
 const sessionModule=pathToFileURL(path.join(cli,'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href
 fs.writeFileSync(fixture,`import {SESSION_FORMAT_VERSION} from ${JSON.stringify(sessionModule)};
export const inject=['sessionPersistence','sessions','agents','webServer'];
export async function apply(ctx){
 for(let i=0;i<${count};i++){const handle=await ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id:'issue21-cold-'+i,createdAt:Date.now(),cwd:${JSON.stringify(home)},isSeeded:false});if(i===0)await handle.append([{seq:0,time:Date.now(),type:'permission/preset',data:{preset:'auto'}}]);await handle.flush();await handle.close()}
 const metrics={reads:0,writes:[]},open=ctx.sessionPersistence.open.bind(ctx.sessionPersistence);
 ctx.sessionPersistence.open=async(...args)=>{const handle=await open(...args);if(String(args[0]).startsWith('issue21-cold-')){if(args[1]==='write')metrics.writes.push(args[0]);else metrics.reads++}return handle};
 ctx.effect(()=>ctx.webServer.register({path:'/issue21-metrics',handler:async(req,res)=>{
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const {sessionId,messageId='fixture-live-message'}=JSON.parse(raw);const session=ctx.sessions.get(sessionId);if(!session||String(sessionId).startsWith('issue21-cold-'))throw Error('fixture accepts only its explicitly created live session');session.append('user/message',{id:messageId,role:'user',source:{kind:'user'},content:[{type:'text',text:'live without a model'}]},{surfaceOp:'append'})}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({...metrics,coldAttached:ctx.sessions.list().filter(s=>String(s.id).startsWith('issue21-cold-')).length,attached:ctx.sessions.list().length,rss:process.memoryUsage().rss}))
 }}));
}`)
 fs.writeFileSync(patch,JSON.stringify([{insert:[{id:'observation-fixture',name:fixture.replaceAll('\\','/')},{id:'remote-test',name:path.join(root,'packages/plugin/index.mjs').replaceAll('\\','/')}]}]))
 const dsh=spawn(process.execPath,[path.join(cli,'lib/bin.js'),'--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],{cwd:home,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(dsh)
 let logs='';for(const stream of [dsh.stdout,dsh.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-20000)})
 let url
 for(let i=0;i<600&&!url&&dsh.exitCode===null;i++){url=logs.match(/http:\/\/127\.0\.0\.1:\d+[^\s\x1b]*/)?.[0];if(!url)await pause(100)}
 assert.ok(url,logs.replace(/(token[=:])[^\s&]+/gi,'$1[redacted]'))
 const login=await fetch(url,{redirect:'manual'}),cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie)
 const metrics=async()=>{const response=await fetch(new URL('/issue21-metrics',url),{headers:{cookie},signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);return response.json()}
 const before=await metrics();assert.equal(before.coldAttached,0);assert.equal(before.writes.length,0)
 const cookieFile=path.join(home,'upstream.cookie');fs.writeFileSync(cookieFile,cookie,{mode:0o600})
 const reserve=net.createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve))
 const gatewayFile=process.env.DSH_TEST_GATEWAY_FILE||path.join(root,'gateway.js')
 const streamMetricsFile=path.join(home,'gateway-streams.json'),preload=path.join(home,'stream-metrics.cjs')
 if(stress)fs.writeFileSync(preload,`const fs=require('node:fs'),Native=global.WebSocket,active=new Map(),seen=new Set();let opens=0,cancels=0,maxSessions=0;
function save(){const sessions=new Set([...active.values()].filter(v=>v.endpoint==='session/follow').map(v=>v.sessionId));maxSessions=Math.max(maxSessions,sessions.size);let fds=null;try{fds=fs.readdirSync('/proc/self/fd').length}catch{}const value={opens,cancels,maxSessions,active:[...active.values()],seen:[...seen],fds,rss:process.memoryUsage().rss};fs.writeFileSync(${JSON.stringify(streamMetricsFile)}+'.tmp',JSON.stringify(value));fs.renameSync(${JSON.stringify(streamMetricsFile)}+'.tmp',${JSON.stringify(streamMetricsFile)})}
global.WebSocket=class extends Native{constructor(...args){super(...args);this.owned=new Set();this.addEventListener('close',()=>{for(const id of this.owned)active.delete(id);save()})}send(raw){const result=super.send(raw);let frame;try{frame=JSON.parse(String(raw))}catch{return result}if(frame.type==='open'&&['session/follow','job/list'].includes(frame.endpoint)){if(seen.has(frame.streamId))throw Error('duplicate observation stream id');seen.add(frame.streamId);this.owned.add(frame.streamId);active.set(frame.streamId,{streamId:frame.streamId,endpoint:frame.endpoint,sessionId:frame.payload.args.request.sessionId||frame.payload.args.request.address?.sessionId});opens++}else if(frame.type==='cancel'){active.delete(frame.streamId);this.owned.delete(frame.streamId);cancels++}save();return result}};save();setInterval(save,5000).unref();`)
 const gatewayEnv={...env,PORT:String(port),HOST:'127.0.0.1',DSH_UPSTREAM:new URL(url).origin,DSH_REMOTE_DSH_COOKIE_FILE:cookieFile,...stress?{NODE_OPTIONS:'--require='+JSON.stringify(preload)}:{}}
 const gateway=spawn(process.execPath,[gatewayFile],{cwd:home,env:gatewayEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(gateway)
 let gatewayLogs='';for(const stream of [gateway.stdout,gateway.stderr])stream.on('data',chunk=>{gatewayLogs=(gatewayLogs+chunk).slice(-10000)})
 const base='http://127.0.0.1:'+port,headers={authorization:'Bearer '+token,'content-type':'application/json'}
 let health
 for(let i=0;i<150;i++){try{health=await(await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).json();if(health.events?.mux?.connected)break}catch{}await pause(100)}
 assert.equal(health?.events?.mux?.connected,true,gatewayLogs)
 await pause(700)
 const startup=await metrics();t.diagnostic(JSON.stringify({phase:'startup',sessions:count,coldAttached:startup.coldAttached,writeOpens:startup.writes.length,rssMiB:Math.round(startup.rss/1048576)}))
 assert.equal(startup.coldAttached,0,'gateway startup must not activate durable cold sessions')
 assert.equal(startup.writes.length,0,'gateway startup must not take cold session write ownership')
 const rpc=async(method,payload={})=>{const response=await fetch(base+'/api/'+method,{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:'observation-'+method,method,payload}),signal:AbortSignal.timeout(10000)});const body=await response.json();assert.equal(body.result?.ok,true,JSON.stringify(body));return body.result.value}
 assert.equal((await rpc('session.list')).items.filter(s=>s.sessionId.startsWith('issue21-cold-')).length,count)
 for(let i=0;i<Math.min(3,count);i++){
  const history=await rpc('session.history',{sessionId:'issue21-cold-'+i,maxMessages:1})
  if(i===0){assert.equal(history.events[0]?.event.type,'permission/preset');assert.equal(history.events[0]?.event.data.preset,'auto')}
  else assert.deepEqual(history.events,[])
 }
 await pause(300);const read=await metrics();assert.equal(read.writes.length,0);assert.equal(read.coldAttached,0)
 const live=await rpc('session.create',{cwd:home});await rpc('session.history',{sessionId:live.sessionId})
 const appended=await fetch(new URL('/issue21-metrics',url),{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({sessionId:live.sessionId})});assert.equal(appended.status,200)
 let polled
 for(let i=0;i<100;i++){polled=await(await fetch(base+'/api/events.poll?kind=mux&since=0',{headers,signal:AbortSignal.timeout(1000)})).json();if(polled.events.some(row=>row.event.payload.type==='session/event'&&row.event.payload.sessionId===live.sessionId&&row.event.payload.event.type==='user/message'))break;await pause(50)}
 assert.ok(polled.events.some(row=>row.event.payload.type==='session/subscribed'&&row.event.payload.sessionId===live.sessionId),'selected live session gets a follow snapshot')
 assert.ok(polled.events.some(row=>row.event.payload.type==='session/jobs'&&row.event.payload.sessionId===live.sessionId),'selected live session gets its job roster')
 assert.ok(polled.events.some(row=>row.event.payload.type==='session/event'&&row.event.payload.sessionId===live.sessionId&&row.event.payload.event.type==='user/message'),'live durable events still reach clients')
 const final=await metrics();assert.equal(final.coldAttached,0);assert.equal(final.writes.length,0)
 t.diagnostic(JSON.stringify({phase:'history+live',sessions:count,coldAttached:final.coldAttached,writeOpens:final.writes.length,attached:final.attached,rssMiB:Math.round(final.rss/1048576)}))
 if(stress){
  const streams=()=>JSON.parse(fs.readFileSync(streamMetricsFile,'utf8'))
  const waitUntil=async(predicate,timeout=5000)=>{const deadline=Date.now()+timeout;do{if(await predicate())return;await pause(100)}while(Date.now()<deadline);assert.fail('stress condition timed out')}
  await Promise.all(Array.from({length:100},(_,i)=>i).reduce((batches,i)=>{if(i%10===0)batches.push([]);batches.at(-1).push(i);return batches},[]).map(async batch=>{for(const i of batch){const rows=(await rpc('session.history',{sessionId:'issue21-cold-'+(i%count),maxMessages:1})).events;if(i%count===0)assert.equal(rows[0]?.event.data.preset,'auto');else assert.deepEqual(rows,[])}}))
  const afterCold=await metrics();assert.equal(afterCold.coldAttached,0);assert.equal(afterCold.writes.length,0)
  const liveSessions=[]
  for(let i=0;i<12;i++){const created=await rpc('session.create',{cwd:home});liveSessions.push(created.sessionId);await rpc('session.history',{sessionId:created.sessionId})}
  for(let round=0;round<5;round++)for(const sessionId of liveSessions)await rpc('session.history',{sessionId})
  await waitUntil(()=>streams().active.filter(row=>row.endpoint==='session/follow').length===8)
  const churn=streams();assert.ok(churn.maxSessions<=8);assert.equal(churn.active.filter(row=>row.endpoint==='job/list').length,8);assert.ok(churn.cancels>=8)
  t.diagnostic(JSON.stringify({phase:'observation-churn',sessions:count,coldReads:100,liveSessions:12,maxFollowed:churn.maxSessions,activeFollowed:8,opens:churn.opens,cancels:churn.cancels}))
  // No history refresh here: exercise the actual 90s TTL and 15s maintenance timer.
  const expiryStart=Date.now(),latencies=[]
  while(Date.now()-expiryStart<112000){const at=Date.now();const h=await(await fetch(base+'/health',{signal:AbortSignal.timeout(3000)})).json();latencies.push(Date.now()-at);assert.equal(h.ok,true);assert.equal(h.runtime.uncaughtExceptions,0);assert.equal(h.runtime.unhandledRejections,0);if(streams().active.length===0)break;await pause(1000)}
  assert.equal(streams().active.length,0,'expired interests must cancel follow and job streams using real elapsed time')
  const expired=await metrics();assert.equal(expired.coldAttached,0);assert.equal(expired.writes.length,0)
  const marker='after-expiry-'+Date.now(),sessionId=liveSessions[0],oldStreamIds=new Set(streams().seen)
  await rpc('session.history',{sessionId});await waitUntil(()=>streams().active.length===2)
  assert.ok(streams().active.every(row=>!oldStreamIds.has(row.streamId)),'revisit must use fresh upstream stream IDs')
  const append=await fetch(new URL('/issue21-metrics',url),{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({sessionId,messageId:marker})});assert.equal(append.status,200)
  await waitUntil(async()=>{const result=await(await fetch(base+'/api/events.poll?kind=mux&since=0',{headers,signal:AbortSignal.timeout(3000)})).json();return result.events.some(row=>row.event.payload.type==='session/event'&&row.event.payload.sessionId===sessionId&&row.event.payload.event.data?.id===marker)})
  t.diagnostic(JSON.stringify({phase:'real-expiry-and-revisit',elapsedMs:Date.now()-expiryStart,coldAttached:expired.coldAttached,writeOpens:expired.writes.length,activeFollowed:1,healthP95Ms:latencies.sort((a,b)=>a-b)[Math.floor(latencies.length*.95)],gatewayFds:streams().fds,gatewayRssMiB:Math.round(streams().rss/1048576),dshRssMiB:Math.round(expired.rss/1048576)}))
 }
 // Deliberately resolve only the synthetic broken Auto session: prove the
 // exact upstream error without changing its permission facts or using a model.
 const restore=await fetch(base+'/api/session.rename',{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:'auto-restore-fixture',method:'session.rename',payload:{sessionId:'issue21-cold-0',title:'isolated restore probe'}})})
 const failure=await restore.json()
 assert.equal(failure.result?.ok,false)
 assert.match(failure.result?.error?.message||'',/cannot restore preset "auto" without its active integration/)
 const fresh=await rpc('session.create',{cwd:home})
 assert.ok(fresh.sessionId)
 assert.ok(Array.isArray((await rpc('session.history',{sessionId:fresh.sessionId})).events))
 t.diagnostic('Exact Auto integration restore error reproduced in an isolated cold session; a separate new conversation still creates and loads successfully; permissions unchanged')
 })
