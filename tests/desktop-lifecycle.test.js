'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm')
const {EventEmitter}=require('node:events')
const source=fs.readFileSync(path.join(__dirname,'../gateway.js'),'utf8')
const backend=source.slice(source.indexOf('function readDesktopLaunch('),source.indexOf('function dshPortOccupied('))
function fixture(){
 const config={kind:'desktop',version:1,profile:'desktop',executable:path.resolve('Desktop.exe'),args:[],cwd:path.resolve('.'),upstream:'http://127.0.0.1:19387',env:{DSH_HOME:'fixture'},desktop:{root:{pid:101,started:'2026-10-09T01:00:00.000Z'},host:{pid:102,started:'2026-10-09T01:00:01.000Z'},hostScript:path.resolve('runtime/@deepseek-ai/dsh-desktop-host/lib/index.js'),profilePath:path.resolve('profiles/desktop')}}
 const rows=[{pid:101,executable:config.executable,started:config.desktop.root.started,command:'Desktop.exe'}, {pid:102,parent:101,executable:config.executable,started:config.desktop.host.started,command:config.desktop.hostScript+' '+config.desktop.profilePath}]
 let evidence={rows,owners:[102]}, occupied=true
 const commands=[],launches=[]
 const context=vm.createContext({path,fs,UPSTREAM:new URL(config.upstream),UPSTREAM_PORT:19387,process:{platform:'win32',env:{ELECTRON_RUN_AS_NODE:'1',NODE_CHANNEL_FD:'3',NODE_CHANNEL_SERIALIZATION_MODE:'json',NODE_OPTIONS:'--inspect',KEEP:'yes'}},delay:async()=>{},Date,JSON,
  execFileResult:async(file,args)=>{commands.push({file,args});if(args.at(-1).includes('$p.Kill()')){evidence={rows:[],owners:[]};occupied=false;return {ok:true,stdout:''}}return {ok:true,stdout:JSON.stringify(evidence)}},
  dshPortOccupied:async()=>occupied,intentionalDshStops:new WeakSet(),desktopChildren:new Map(),watchDshChild:()=>{},
  spawn:(exe,args,options)=>{launches.push({exe,args,options});const child=new EventEmitter();child.pid=103;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child},
 })
 vm.runInContext(backend+';this.api={verifyDesktopEvidence,dshDesktopStatus,executeDshDesktopAction,readDesktopLaunch}',context)
 return {config,rows,commands,launches,api:context.api,setEvidence:value=>{evidence=value;occupied=value.owners.length>0}}
}
test('Desktop admission checks executable, birth time, Host ancestry and listener ownership',async()=>{
 const h=fixture(), status=await h.api.dshDesktopStatus(h.config)
 assert.equal(status.manager,'desktop');assert.equal(status.canRestart,true)
 for(const mutate of [rows=>rows[0].started='2026-10-09T02:00:00.000Z',rows=>rows[0].executable=path.resolve('other.exe'),rows=>rows[1].parent=999,rows=>rows[1].command='other-profile']){
  const rows=structuredClone(h.rows);mutate(rows);h.setEvidence({rows,owners:[102]})
  const result=await h.api.executeDshDesktopAction('restart',h.config)
  assert.equal(result.code,'EXTERNAL_PROCESS');assert.equal(h.launches.length,0);assert.equal(h.commands.some(c=>c.args.at(-1).includes('$p.Kill()')),false)
 }
 h.setEvidence({rows:h.rows,owners:[999]});assert.equal((await h.api.executeDshDesktopAction('start',h.config)).code,'EXTERNAL_PROCESS')
})
test('Desktop restart targets only verified root, waits for Host exit and clears inherited Node IPC',async()=>{
 const h=fixture(), result=await h.api.executeDshDesktopAction('restart',h.config)
 assert.equal(result.ok,true);assert.equal(result.pid,103);assert.equal(h.launches.length,1)
 const kill=h.commands.find(c=>c.args.at(-1).includes('$p.Kill()')).args.at(-1)
 assert.match(kill,/Get-Process -Id 101/);assert.match(kill,/StartTime/);assert.doesNotMatch(kill,/taskkill|\/T|Stop-Process/)
 const env=h.launches[0].options.env
 for(const key of ['ELECTRON_RUN_AS_NODE','NODE_CHANNEL_FD','NODE_CHANNEL_SERIALIZATION_MODE','NODE_OPTIONS'])assert.equal(env[key],undefined)
 assert.equal(env.KEEP,'yes');assert.equal(h.launches[0].options.shell,false);assert.equal(h.launches[0].options.detached,true)
})
test('Desktop start does not duplicate running shell; missing shell starts without stopping anything',async()=>{
 const h=fixture();assert.equal((await h.api.executeDshDesktopAction('start',h.config)).code,'ALREADY_RUNNING');assert.equal(h.launches.length,0)
 h.setEvidence({rows:[],owners:[]});const result=await h.api.executeDshDesktopAction('start',h.config)
 assert.equal(result.ok,true);assert.equal(h.launches.length,1);assert.equal(h.commands.some(c=>c.args.at(-1).includes('$p.Kill()')),false)
})
test('Desktop launch validation accepts empty GUI args and rejects malformed ownership records',t=>{
 const h=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-desktop-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 h.config.executable=path.join(dir,'Desktop.exe');fs.writeFileSync(h.config.executable,'fixture');h.config.cwd=dir
 assert.equal(h.api.readDesktopLaunch(h.config).kind,'desktop')
 for(const change of [c=>c.args=['unexpected'],c=>c.desktop.root.pid=-1,c=>c.desktop.host.pid=c.desktop.root.pid,c=>c.profile='web',c=>c.upstream='http://remote.invalid:19387',c=>c.desktop.hostScript=path.join(dir,'other.js')]){
  const candidate=structuredClone(h.config);change(candidate);assert.throws(()=>h.api.readDesktopLaunch(candidate))
 }
})