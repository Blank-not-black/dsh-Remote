'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),vm=require('node:vm')
const {spawn}=require('node:child_process'),{once}=require('node:events'),{pathToFileURL}=require('node:url')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',r))
const close=async server=>{server.closeAllConnections?.();await new Promise(r=>server.close(r))}
const freePort=async()=>{const server=net.createServer();await listen(server);const port=server.address().port;await close(server);return port}
const root=path.resolve(__dirname,'..'),token='isolated-health-regression-token'
test('Health and admin stay fast during slow upstream/Desktop checks; probes coalesce and export downloads authenticate',{timeout:20000},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-health-regression-'));let child,rootRequests=0
 const upstream=http.createServer((q,r)=>{if(q.url==='/')rootRequests++;setTimeout(()=>r.end('fixture'),q.url==='/'?1000:0)})
 upstream.on('upgrade',(q,s)=>s.destroy());await listen(upstream)
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done}await close(upstream);fs.rmSync(tmp,{recursive:true,force:true})})
 const port=await freePort(),base='http://127.0.0.1:'+port,origin='http://127.0.0.1:'+upstream.address().port
 const launchFile=path.join(tmp,'launch.json'),dummy=path.join(tmp,'dummy.cjs');fs.writeFileSync(dummy,'')
 const env={...process.env,HOME:tmp,USERPROFILE:tmp,DSH_HOME:tmp,DSH_REMOTE_FS_ROOT:tmp,TOKEN:token,TOKEN_FILE:path.join(tmp,'token'),
  HOST:'127.0.0.1',PORT:String(port),DSH_UPSTREAM:origin,DSH_REMOTE_DSH_LAUNCH_FILE:launchFile,DSH_REMOTE_DSH_CONTROL_MODE:'process',
  DSH_REMOTE_AUTO_RESTART:'0',DSH_REMOTE_ANNOUNCEMENTS_URL:'',UPDATE_CHECK_URL:origin+'/update'}
 for(const key of Object.keys(env))if(/proxy/i.test(key))delete env[key]
 fs.writeFileSync(launchFile,JSON.stringify({version:1,executable:process.execPath,cwd:tmp,args:[dummy],upstream:origin}))
 child=spawn(process.execPath,[path.join(root,'gateway.js')],{env,stdio:'ignore'})
 if(process.platform==='win32')fs.writeFileSync(launchFile,JSON.stringify({kind:'desktop',version:1,profile:'desktop',executable:process.execPath,cwd:tmp,args:[],upstream:origin,
  desktop:{root:{pid:process.pid,started:'2026-10-09T01:00:00.000Z'},host:{pid:child.pid,started:'2026-10-09T01:00:01.000Z'},hostScript:path.join(tmp,'@deepseek-ai/dsh-desktop-host/lib/index.js'),profilePath:tmp}}))
 for(let i=0;i<100;i++){try{await fetch(base+'/health?probe=live',{signal:AbortSignal.timeout(300)});break}catch{}await pause(50)}
 const measurements=await Promise.all(Array.from({length:8},async(_,i)=>{const start=performance.now();const r=await fetch(base+(i%2?'/health':'/admin/api/state'),{headers:{authorization:'Bearer '+token}});const body=await r.json();return {ms:performance.now()-start,status:r.status,body}}))
 for(const result of measurements){assert.equal(result.status,200);assert.ok(result.ms<750,JSON.stringify({ms:result.ms}));assert.equal(result.body.ok,true)}
 const live=await (await fetch(base+'/health?probe=live')).json();assert.equal(live.pid,child.pid);assert.equal(live.upstream,origin);assert.ok(live.events.mux)
 await pause(1300);const warmed=await (await fetch(base+'/health')).json();assert.equal(warmed.upstreamOk,true);assert.equal(rootRequests,1,'concurrent readers and lifecycle description share one upstream probe')
 const timings=[]
 for(let i=0;i<8;i++){const start=performance.now();await (await fetch(base+'/health')).json();timings.push(Math.round((performance.now()-start)*10)/10)}
 t.diagnostic('Warm /health response milliseconds: '+timings.join(', '))
 const source=fs.readFileSync(path.join(root,'public/desktop/desktop.js'),'utf8');let download
 const c=vm.createContext({URL,AbortSignal,LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS:10000,state:{server:'',token},location:{href:base+'/desktop/',pathname:'/desktop/'},
  captureConnection:()=>({valid:()=>true}),apiUrl:p=>p,clientIdHeaders:()=>({}),sessionLogFilename:()=> 'session.zip',fetch,toast(){},t:x=>x,console,
  document:{body:{appendChild(){}},createElement:()=>({click(){download=fetch(this.href)},remove(){}})}})
 vm.runInContext(source.slice(source.indexOf('async function downloadSessionExport('),source.indexOf('async function runSlashCommand(')),c)
 await c.downloadSessionExport('fixture-session');assert.ok(download);const response=await download;assert.equal(response.status,200);await response.text()
})
test('Plugin coalesces live probes, preserves operation query and distinguishes slow responses from authentication failure',{timeout:20000},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-plugin-probe-regression-')),saved={},disposers=[],requests=[];let route,delay=0
 for(const key of ['HOME','USERPROFILE','DSH_HOME','DSH_REMOTE_FS_ROOT','TOKEN','TOKEN_FILE','DSH_REMOTE_AUTOSTART','DSH_REMOTE_GATEWAY'])saved[key]=process.env[key]
 Object.assign(process.env,{HOME:tmp,USERPROFILE:tmp,DSH_HOME:tmp,DSH_REMOTE_FS_ROOT:tmp,TOKEN:token,TOKEN_FILE:path.join(tmp,'token'),DSH_REMOTE_AUTOSTART:'0'})
 fs.writeFileSync(path.join(tmp,'token'),token)
 const gateway=http.createServer((q,r)=>{
  requests.push(q.url);const url=new URL(q.url,'http://x');r.setHeader('content-type','application/json')
  const body=url.pathname==='/health'?{service:'dsh-remote',pid:process.pid,version:require('../package.json').version,upstream:'http://127.0.0.1:3080',events:{mux:{},host:{}}}:
   url.pathname==='/admin/api/dsh'?{ok:true,done:true,operationId:url.searchParams.get('operation')}:{ok:true,mode:'gateway'}
  setTimeout(()=>r.end(JSON.stringify(body)),url.pathname==='/admin/api/state'?delay:url.pathname==='/health'?100:0)
 })
 await listen(gateway);process.env.DSH_REMOTE_GATEWAY='http://127.0.0.1:'+gateway.address().port
 const server=http.createServer((q,r)=>Promise.resolve(route.handler(q,r)).catch(e=>{r.statusCode=500;r.end(String(e))}));await listen(server)
 t.after(async()=>{for(const dispose of disposers.reverse())dispose();await close(server);await close(gateway);for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}fs.rmSync(tmp,{recursive:true,force:true})})
 const plugin=await import(pathToFileURL(path.join(root,'packages/plugin/index.mjs')).href+'?probe-regression='+Date.now())
 plugin.apply({connection:{},webServer:{host:'127.0.0.1',port:3080,register:def=>{route=def;return ()=>{}}},effect:fn=>{const dispose=fn();if(typeof dispose==='function')disposers.push(dispose)},on:()=>()=>{}})
 const base='http://127.0.0.1:'+server.address().port
 let response=await fetch(base+'/remote/admin/api/dsh?operation=known%20operation');assert.equal((await response.json()).operationId,'known operation')
 requests.length=0;process.env.DSH_REMOTE_AUTOSTART='1';response=await fetch(base+'/remote/admin/api/state');assert.equal((await response.json()).mode,'gateway')
 assert.equal(requests.filter(p=>p.startsWith('/health')).length,1);assert.ok(requests.includes('/health?probe=live'))
 process.env.DSH_REMOTE_AUTOSTART='0';delay=1700;response=await fetch(base+'/remote/admin/api/state');assert.equal((await response.json()).mode,'gateway')
 delay=6000;response=await fetch(base+'/remote/admin/api/state');assert.equal(response.status,504);const body=await response.json();assert.equal(body.code,'GATEWAY_TIMEOUT');assert.equal(body.gatewayAuthError,undefined)
})
test('Disabled Desktop control never queries crash event logs after the shell disappears',async()=>{
 const source=fs.readFileSync(path.join(root,'gateway.js'),'utf8');let scans=0
 const c=vm.createContext({AUTO_RESTART:true,DSH_CONTROL_SUPPORT:{supported:false},dshControlOperation:null,readDshLaunch:()=>({kind:'desktop',desktop:{root:{pid:101},host:{pid:102}}}),
  process:{kill:()=>{throw Object.assign(Error(),{code:'ESRCH'})}},recoveryTimers:new Map(),desktopCrashEvidence:async()=>{scans++;return false}})
 vm.runInContext(source.slice(source.indexOf('let desktopWatchBusy='),source.indexOf('function dshOperationStep(')),c)
 await c.checkDesktopCrash();await c.checkDesktopCrash();assert.equal(scans,0)
})
test('Normal Desktop quit stops event-log probes after the crash evidence window',async()=>{
 const source=fs.readFileSync(path.join(root,'gateway.js'),'utf8');let scans=0,now=1000
 const c=vm.createContext({AUTO_RESTART:true,DSH_CONTROL_SUPPORT:{supported:true},Date:{now:()=>now},dshControlOperation:null,
  readDshLaunch:()=>({kind:'desktop',desktop:{root:{pid:101,started:'birth'},host:{pid:102}}}),
  process:{kill:()=>{throw Object.assign(Error(),{code:'ESRCH'})}},recoveryTimers:new Map(),desktopCrashEvidence:async()=>{scans++;return false}})
 vm.runInContext(source.slice(source.indexOf('let desktopWatchBusy='),source.indexOf('function dshOperationStep(')),c)
 await c.checkDesktopCrash();now+=5000;await c.checkDesktopCrash();assert.equal(scans,2)
 now+=120000;await c.checkDesktopCrash();now+=5000;await c.checkDesktopCrash();assert.equal(scans,2)
})
