'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {LinkCheck,PulseVisual}=require('../public/link-check.js')
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve()}
function fixture(){
 let now=0,serial=0,visible=true,configured=true,online=true,requests=0,repairs=0
 const timers=new Map(),emitted=[],channels={dsh:false,mux:false,host:false};let probe=async()=>({gateway:true}),checker
 const options={now:()=>now,setTimer:(fn,delay)=>{const id=++serial;timers.set(id,{fn,at:now+delay});return id},clearTimer:id=>timers.delete(id),active:()=>visible,configured:()=>configured,online:()=>online,
  snapshot:()=>({gateway:checker?.model.gateway===true,dsh:checker?.model.gateway===true&&channels.dsh,mux:checker?.model.gateway===true&&channels.mux,host:checker?.model.gateway===true&&channels.host}),repair:()=>{repairs++},probe:signal=>{requests++;return probe(signal)},changed:model=>emitted.push(structuredClone(model))}
 checker=new LinkCheck(options)
 const tick=async ms=>{const target=now+ms;while(true){const next=[...timers].filter(([,item])=>item.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await settle()}now=target;await settle()}
 return {checker,channels,tick,timers,emitted,probe:fn=>{probe=fn},requests:()=>requests,repairs:()=>repairs,visible:value=>{visible=value},configured:value=>{configured=value},online:value=>{online=value}}
}
test('First open shows checking, retries transient errors and settles as each channel arrives',async()=>{
 const f=fixture();f.probe(async()=>{if(f.requests()===1)throw Error('temporary');return {gateway:true}});f.checker.start();assert.equal(f.checker.model.phase,'checking');await settle();assert.equal(f.requests(),1)
 await f.tick(1999);assert.equal(f.requests(),1);await f.tick(1);assert.equal(f.requests(),2);assert.equal(f.checker.model.phase,'checking')
 f.channels.dsh=f.channels.mux=true;f.checker.observe();assert.equal(f.checker.model.phase,'checking');f.channels.host=true;f.checker.observe();assert.equal(f.checker.model.phase,'ready');assert.ok(Object.values(f.checker.model.checks).every(Boolean))
})
test('Repeated refreshes coalesce; persistent failure leaves checking after grace and retries in background',async()=>{
 const f=fixture();let release;f.probe(()=>new Promise(resolve=>{release=resolve}));f.checker.start();f.checker.start(true);f.checker.start(true);await settle();assert.equal(f.requests(),1);release({gateway:false});await settle()
 await f.tick(20000);assert.equal(f.checker.model.phase,'degraded');assert.ok(f.requests()<10,'retry storm');release({gateway:false});await settle();const before=f.requests();await f.tick(30000);assert.equal(f.requests(),before+1)
})
test('Healthy foreground overview is checked periodically; hidden and offline pages stop checks',async()=>{
 const f=fixture();Object.assign(f.channels,{dsh:true,mux:true,host:true});f.checker.start();await settle();assert.equal(f.checker.model.phase,'ready');await f.tick(30000);assert.equal(f.requests(),2)
 f.visible(false);f.checker.pause();const count=f.requests();await f.tick(120000);assert.equal(f.requests(),count)
 f.visible(true);f.online(false);f.checker.start(true);assert.equal(f.checker.model.phase,'offline');await f.tick(60000);assert.equal(f.requests(),count)
 f.online(true);f.checker.start(true);await settle();assert.equal(f.checker.model.phase,'ready')
})
test('Identity switch aborts old check; late A cannot overwrite B or clear B job',async()=>{
 const f=fixture(),pending=[];f.probe(signal=>new Promise(resolve=>pending.push({signal,resolve})));f.checker.start();await settle();f.checker.pause();f.checker.start(true);await settle();assert.equal(pending[0].signal.aborted,true)
 pending[0].resolve({gateway:true});await settle();assert.equal(f.checker.model.gateway,null);assert.equal(f.checker.model.probing,true);pending[1].resolve({gateway:false});await settle();assert.equal(f.checker.model.gateway,false)
})
test('Going offline during an in-flight request changes status immediately and ignores late success',async()=>{
 const f=fixture();let release;f.probe(()=>new Promise(resolve=>{release=resolve}));f.checker.start();await settle();f.online(false);f.checker.start(true);assert.equal(f.checker.model.phase,'offline');release({gateway:true});await settle();assert.equal(f.checker.model.phase,'offline')
})
for(const file of ['public/app.js','public/desktop/desktop.js']){
 const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),desktop=file.includes('desktop')
 test(file+': repair preserves healthy/connecting sockets and honors channel backoff',()=>{
  const a=source.indexOf('function repairMissingStreams()'),b=source.indexOf('async function probeOverviewLinks',a),calls=[]
  const ctx=vm.createContext({state:{token:'test',selectingServer:false,streamMode:'ws'},navigator:{onLine:true},overviewStarting:false,streams:{mux:{readyState:1},host:{readyState:0}},streamMeta:{mux:{retryTimer:null},host:{retryTimer:null}},WebSocket:{CLOSED:3},onMuxFrame:()=>{},onHostFrame:()=>{},openStream:kind=>calls.push(kind),tryRestoreWs:()=>calls.push('poll')})
  vm.runInContext(source.slice(a,b),ctx);ctx.repairMissingStreams();assert.deepEqual(calls,[]);ctx.streams.host=null;ctx.streamMeta.host.retryTimer=1;ctx.repairMissingStreams();assert.deepEqual(calls,[]);ctx.streamMeta.host.retryTimer=null;ctx.repairMissingStreams();assert.deepEqual(calls,['host']);ctx.state.streamMode='poll';ctx.repairMissingStreams();assert.equal(calls.at(-1),'poll')
 })
 test(file+': host metadata requests reject stale token/ABA responses without suppressing current probe',async()=>{
  const name=desktop?'refreshHostDescriptionDesktop':'refreshHostDescription',a=source.indexOf('let hostDescribePromise'),b=source.indexOf(desktop?'function uuid':'function authFailure',a),pending=[];let generation=1
  const ctx=vm.createContext({state:{token:'a',server:'same',hostInfo:null},captureConnection:()=>{const captured=generation;return {valid:()=>generation===captured}},rpc:()=>new Promise(resolve=>pending.push(resolve)),activeGatewayHealth:()=>null,$:()=>null,t:()=>'',renderOverview:()=>{},renderOverviewDesktop:()=>{},authFailure:()=>{},toast:()=>{},setTimeout:()=>1,clearTimeout:()=>{}})
  vm.runInContext(source.slice(a,b),ctx)
  const first=ctx[name]();generation++;ctx.state.token='b';const second=ctx[name]();assert.equal(pending.length,2);pending[0]({version:'old'});await first;assert.equal(ctx.state.hostInfo,null);pending[1]({version:'new'});await second;assert.equal(ctx.state.hostInfo.version,'new')
 })
 test(file+': local WS alone cannot falsely report gateway collector online',()=>{
  const a=source.indexOf('function overviewChecks()'),b=source.indexOf('function repairMissingStreams()',a),health={events:{mux:{connected:false},host:{connected:true}}}
  const ctx=vm.createContext({state:{token:'test',server:'',streamsOk:{mux:true,host:true}},location:{protocol:'http:'},overviewDetector:{model:{gateway:true}},activeGatewayHealth:()=>health,dshReachable:()=>true})
  vm.runInContext(source.slice(a,b),ctx);assert.equal(ctx.overviewChecks().gateway,true);assert.equal(ctx.overviewChecks().mux,false);assert.equal(ctx.overviewChecks().host,true);ctx.overviewDetector.model.gateway=false;assert.ok(Object.values(ctx.overviewChecks()).every(value=>!value))
 })
}
test('Two overview layouts use pending animation with reduced-motion fallback and live status',()=>{
 for(const [html,css,prefix]of [['public/index.html','public/styles.css',''],['public/desktop/desktop.html','public/desktop/desktop.css','ds-']]){
  const page=fs.readFileSync(path.join(__dirname,'..',html),'utf8'),style=fs.readFileSync(path.join(__dirname,'..',css),'utf8');assert.match(page,/link-check\.js/);assert.ok(page.includes('id="'+prefix+'overview-status" aria-live="polite"'));assert.match(style,/pulse-sweep.*overview-scan/);assert.match(style,/prefers-reduced-motion:reduce[\s\S]*animation:none/);assert.equal((page.match(/data-pulse-link=/g)||[]).length,4)
 }
})

test('Browser timer APIs keep their native invocation context',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/link-check.js'),'utf8');
 const ctx=vm.createContext({globalThis:{},module:{exports:{}},setTimeout:function(){assert.notEqual(this?.constructor?.name,'LinkCheck');return 1},clearTimeout:function(){assert.notEqual(this?.constructor?.name,'LinkCheck')},AbortController});
 vm.runInContext(source,ctx);const checker=new ctx.module.exports.LinkCheck({active:()=>true,configured:()=>false,online:()=>true,snapshot:()=>({}),changed:()=>{}});checker.start();checker.schedule(100);checker.pause();
})

function pulseFixture(){
 const timers=new Map();let serial=0,active=true,reduced=false;const segments=['gateway','dsh','mux','host'].map(name=>({name,confirmed:null,getAttribute:()=>name,setAttribute(_key,value){this.confirmed=value}}));
 const card={dataset:{},querySelectorAll:()=>segments};const pulse=new PulseVisual({card,active:()=>active,reduced:()=>reduced,setTimer:fn=>{const id=++serial;timers.set(id,fn);return id},clearTimer:id=>timers.delete(id)});
 return {pulse,card,timers,active:value=>{active=value},reduced:value=>{reduced=value},finish:()=>{for(const [id,fn]of timers){timers.delete(id);fn()}}}
}
test('Scan settles without delaying detection; rapid recheck cancels the old stop and preserves sweep phase',()=>{
 const f=pulseFixture();f.pulse.setChecking(true);assert.equal(f.card.dataset.pulseRunning,'true');f.pulse.setChecking(false);assert.equal(f.card.dataset.pulseRunning,'true');assert.equal(f.timers.size,1);f.pulse.setChecking(true);assert.equal(f.timers.size,0);f.finish();assert.equal(f.card.dataset.pulseRunning,'true');f.pulse.setChecking(false);f.finish();assert.equal(f.card.dataset.pulseRunning,'false');
})
test('Hidden and reduced-motion views stop continuous scans and cancel pending settle work',()=>{
 const f=pulseFixture();f.pulse.setChecking(true);f.pulse.setChecking(false);f.active(false);f.pulse.setChecking(true);assert.equal(f.timers.size,0);assert.equal(f.card.dataset.pulseRunning,'false');f.active(true);f.reduced(true);f.pulse.setChecking(true);assert.equal(f.card.dataset.pulseRunning,'false');
})
test('Text interruption keeps the latest truth, cancels old motion and cleans inaccessible echoes',async()=>{
 const f=pulseFixture(),echoes=[],animations=[];function animation(){let resolve;const finished=new Promise(r=>{resolve=r}),a={finished,cancelled:false,cancel(){this.cancelled=true;resolve()},finish:resolve};animations.push(a);return a}
 const node={textContent:'checking',style:{},offsetLeft:0,offsetTop:0,offsetWidth:120,animate:animation,parentElement:{appendChild:echo=>echoes.push(echo)},cloneNode:()=>({style:{},classList:{add(){}},removeAttribute(){},setAttribute(key,value){this[key]=value},remove(){this.removed=true},animate:animation})};
 f.pulse.text(node,'3/4');assert.equal(node.textContent,'3/4');assert.equal(echoes[0]['aria-hidden'],'true');const count=animations.length;f.pulse.text(node,'3/4');assert.equal(animations.length,count);f.pulse.text(node,'ready');assert.equal(node.textContent,'ready');assert.equal(animations[0].cancelled,true);assert.equal(echoes[0].removed,true);await settle();assert.equal(f.pulse.textJobs.size,1,'old completion must not clear current transition');animations.at(-2).finish();animations.at(-1).finish();await settle();assert.equal(f.pulse.textJobs.size,0);assert.equal(echoes.at(-1).removed,true);f.reduced(true);f.pulse.text(node,'offline');assert.equal(node.textContent,'offline');assert.equal(animations.length,4);
})
