'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {createDiagnostics,createDiagnosticSchema}=require('../public/diagnostics.js'),schema=createDiagnosticSchema()
class Hasher{constructor(){this.value=crypto.createHash('sha256')}update(bytes){this.value.update(bytes);return this}hex(){return this.value.digest('hex')}}
function fixture(storage=new Map()){
 const handlers={},nodes=new Map(),env={crypto:crypto.webcrypto,SHA256:Hasher,navigator:{onLine:true},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>1,clearTimeout(){},addEventListener:(name,fn)=>handlers[name]=fn,document:{visibilityState:'visible',getElementById:id=>nodes.get(id),addEventListener:(name,fn)=>handlers[name]=fn}}
 const d=createDiagnostics(env);return {d,env,storage,handlers,nodes}
}
test('Client report excludes credentials, raw identity, payloads and arbitrary error strings before persistence and export',()=>{
 const h=fixture();h.d.build({version:'0.8.0-rc.4',buildId:'a'.repeat(64)})
 h.d.configure({surface:'mobile',snapshot:()=>({sessionId:'PRIVATE_SESSION',server:'https://user:SECRET@private.example/?token=TOKEN',token:'TOKEN',content:'PRIVATE_MESSAGE'})})
 const op=h.d.start('history.load',{sessionId:'PRIVATE_SESSION',server:'PRIVATE_SERVER',content:'PRIVATE_MESSAGE',method:'session.history'});op.end({phase:'rendered',count:60})
 const error=new TypeError('SECRET PRIVATE_MESSAGE C:/private/token.txt');error.stack='TypeError: SECRET\n at render (https://private.example/C:/private/history.js:123:4)\n at unknown (C:/private/token.txt:5:6)';h.handlers.error({error})
 h.d.record('arbitrary-secret',{message:'PRIVATE_MESSAGE'});h.d.flush()
 const text=h.d.text(),persisted=[...h.storage.values()].join('\n');assert.doesNotMatch(text+persisted,/PRIVATE|SECRET|TOKEN|private\.example|token\.txt/)
 const report=h.d.report();assert.equal(report.client.buildId,'a'.repeat(64));assert.match(report.snapshot.sessionRef,/^[a-f0-9]{16}$/);assert.equal(report.events.find(r=>r.kind==='history.load').sessionRef,report.snapshot.sessionRef)
 assert.deepEqual(report.events.at(-1).frames,[{file:'history.js',line:123,column:4}]);assert.equal(report.events.at(-1).errorName,'TypeError');assert.equal(report.events.filter(r=>r.traceId===op.traceId).length,2)
})
test('Bounded persistent ring survives reload and quota errors; expired or poisoned storage is sanitized',()=>{
 const h=fixture();for(let i=0;i<1000;i++)h.d.record('rpc',{phase:'complete',method:'session.history',count:i});h.d.flush();assert.equal(h.d.report().events.length,160);assert.ok(h.d.text().length<48000)
 const restored=fixture(h.storage);assert.equal(restored.d.report().events.at(-1).count,999)
 const poisoned=JSON.parse(h.storage.get('dshRemoteDiagnosticsV1'));poisoned.events.push({at:Date.now()-3*86400000,kind:'rpc',method:'session.history',token:'SECRET'});poisoned.events[0].message='SECRET';h.storage.set('dshRemoteDiagnosticsV1',JSON.stringify(poisoned));const clean=fixture(h.storage);assert.doesNotMatch(clean.d.text(),/SECRET/);assert.ok(clean.d.report().events.every(r=>r.at>Date.now()-86400000))
 clean.env.localStorage.setItem=()=>{throw Error('quota')};assert.doesNotThrow(()=>{clean.d.record('client.error',{phase:'failed'});clean.d.flush()});clean.d.clear();assert.equal(clean.d.report().events.length,0)
})

test('The last interactive stage persists before a render can freeze the JS thread',()=>{
 const h=fixture();h.d.record('history.render',{phase:'start',count:63});const reopened=fixture(h.storage);assert.equal(reopened.d.report().events.at(-1).kind,'history.render');assert.equal(reopened.d.report().events.at(-1).count,63)
})
test('Local export works offline, uses the Android system picker and reports the actual save outcome',()=>{
 const h=fixture(),status={textContent:''};h.nodes.set('fb-client-log-status',status);h.env.navigator.onLine=false;let exported
 h.env.NativeFile={exportDiagnostics:json=>{exported=JSON.parse(json);return true},getDiagnosticExportStatus:()=> 'saved'}
 h.d.record('session.back',{phase:'navigate',sessionId:'PRIVATE'});h.d.download();assert.equal(exported.snapshot.online,false);assert.equal(exported.events.at(-1).kind,'session.back');assert.doesNotMatch(JSON.stringify(exported),/PRIVATE/);assert.match(status.textContent,/已保存/)
 h.env.NativeFile.exportDiagnostics=()=>false;h.d.download();assert.match(status.textContent,/导出失败/)
 h.env.NativeFile.exportDiagnostics=()=>true;h.env.NativeFile.getDiagnosticExportStatus=()=> 'cancelled';h.d.download();assert.match(status.textContent,/已取消/)
})

test('Background lifecycle snapshot retains service health and battery facts without native credentials',()=>{
 const h=fixture();h.env.NativeBackground={getBackgroundConfig:()=>JSON.stringify({enabled:true,serviceRunning:false,serviceState:'start-failed',lastHttpStatus:503,lastSuccessAt:1234,apiLevel:35,powerSave:true,ignoreBatteryOptimizations:false,notificationsEnabled:false,base:'PRIVATE',token:'SECRET',serviceError:'PRIVATE'})}
 h.env.document.visibilityState='hidden';h.handlers.visibilitychange();const row=h.d.report().events.at(-1);assert.equal(row.httpStatus,503);assert.equal(row.status,'hidden');assert.equal(row.serviceState,'start-failed');assert.equal(row.enabled,true);assert.equal(row.powerSave,true);assert.equal(row.notificationsEnabled,false);assert.doesNotMatch(h.d.text(),/PRIVATE|SECRET/)
})
test('Local schema drops poisoned report data',()=>{
 const result=schema.sanitizeReport({schema:1,reportId:'a'.repeat(24),client:{buildId:'b'.repeat(64),version:'0.8.0-rc.4',token:'SECRET'},snapshot:{server:'SECRET'},events:[{kind:'rpc',at:1,method:'session.history',payload:{text:'SECRET'},frames:[{file:'C:/PRIVATE',line:1,column:1}]}]});assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE|payload/)
})

test('Announcement storage failures retain only the affected record category and fallback backend',()=>{
 const h=fixture()
 h.d.record('announcement.storage',{phase:'failed',storageKey:'seen',storageBackend:'session',value:'PRIVATE',content:'SECRET'})
 h.d.record('announcement.storage',{phase:'failed',storageKey:'PRIVATE',storageBackend:'SECRET'})
 const report=h.d.report()
 assert.equal(report.events[0].storageKey,'seen');assert.equal(report.events[0].storageBackend,'session')
 assert.equal(report.events[1].storageKey,undefined);assert.equal(report.events[1].storageBackend,undefined)
 assert.doesNotMatch(h.d.text(),/PRIVATE|SECRET/)
})

test('Local log dialog opens independently; copy and browser export contain the same safe evidence, and clear updates the view',async()=>{
 const h=fixture();let shown=0,copied,blob,clicked=false
 const make=()=>({dataset:{},events:{},addEventListener(name,fn){this.events[name]=fn},setAttribute(){},append(){},showModal(){this.open=true;shown++},close(){this.open=false},click(){clicked=true},remove(){}})
 const panel=make();panel.parentNode={insertBefore(){}};const details=make();details.closest=()=>panel
 h.nodes.set('fb-client-log-details',details);for(const id of ['fb-client-log-preview','fb-client-log-status','fb-log-preview','fb-log-copy','fb-log-export','fb-log-clear'])h.nodes.set(id,make())
 h.env.document.createElement=make;h.env.document.body={append(){}};h.env.document.querySelectorAll=()=>[];h.env.Blob=Blob;h.env.URL={createObjectURL:value=>{blob=value;return 'blob:test'},revokeObjectURL(){}}
 h.env.navigator.onLine=false;h.d.configure({copy:async text=>{copied=JSON.parse(text);return true}});h.d.record('session.back',{phase:'navigate',sessionId:'PRIVATE'});h.d.show();assert.equal(shown,1);assert.equal(details.open,true)
 await h.nodes.get('fb-log-copy').events.click();assert.equal(copied.events.at(-1).kind,'session.back');assert.doesNotMatch(JSON.stringify(copied),/PRIVATE/)
 h.nodes.get('fb-log-export').events.click();assert.equal(clicked,true);const exported=JSON.parse(await blob.text());assert.equal(exported.snapshot.online,false);assert.deepEqual(exported.events,copied.events)
 h.nodes.get('fb-log-clear').events.click();assert.equal(JSON.parse(h.nodes.get('fb-client-log-preview').textContent).events.length,0)
})
