'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process')
const read=file=>fs.readFileSync(path.join(__dirname,'../',file),'utf8')
test('HTML build cache keys converge, track content and preserve inline JS/query semantics',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-cache-build-'))
 try{
  for(const dir of ['public','scripts','android/app/src/main/java'])fs.mkdirSync(path.join(root,dir),{recursive:true})
  fs.copyFileSync(path.join(__dirname,'../scripts/prepare-diagnostics-build.mjs'),path.join(root,'scripts/prepare-diagnostics-build.mjs'))
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'test'}))
  fs.writeFileSync(path.join(root,'public/index.html'),'<head><script>var separator="?"</script><link href="a.css?mode=1"><script src="a.js"></script></head>')
  fs.writeFileSync(path.join(root,'public/admin.html'),'<head><script src="../a.js"></script></head>')
  fs.writeFileSync(path.join(root,'public/a.js'),'const a=1');fs.writeFileSync(path.join(root,'public/a.css'),'body{}')
  const run=()=>{const r=spawnSync(process.execPath,['scripts/prepare-diagnostics-build.mjs'],{cwd:root,env:{...process.env,HOME:root,USERPROFILE:root,DSH_REMOTE_FS_ROOT:root},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return JSON.parse(fs.readFileSync(path.join(root,'public/build.json'))).buildId}
  const first=run(),html=fs.readFileSync(path.join(root,'public/index.html'),'utf8')
  assert.match(html,/var separator="\?"/);assert.ok(html.includes('a.css?mode=1&dsr-build='+first));assert.ok(html.includes('a.js?dsr-build='+first))
  assert.ok(fs.readFileSync(path.join(root,'public/admin.html'),'utf8').includes('../a.js?dsr-build='+first))
  assert.equal(run(),first);assert.equal(fs.readFileSync(path.join(root,'public/index.html'),'utf8'),html)
  fs.appendFileSync(path.join(root,'public/a.js'),';const b=2');assert.notEqual(run(),first)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
function watcher(){
 let reloads=0,safe=false,next='b'.repeat(64),notice
 const values=new Map(),requests=[]
 const node=()=>({style:{},setAttribute(){},append(){},addEventListener(type,fn){this[type]=fn}})
 const doc={currentScript:{src:'https://host/remote/cache-upgrade.js?dsr-build='+ 'a'.repeat(64)},querySelector:()=>({content:'a'.repeat(64)}),createElement:node,body:{append(value){notice=value}},addEventListener(){}}
 const root={document:doc,fetch:async(url,opts)=>{requests.push({url,opts});return {ok:true,json:async()=>({buildId:next})}},location:{pathname:'/remote/',reload(){reloads++}},sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},setTimeout(){},setInterval(){},addEventListener(){}}
 const c=vm.createContext({window:root,URL,AbortSignal,Date})
 vm.runInContext(read('public/cache-upgrade.js'),c)
 root.DshCacheUpgrade.mount({safe:()=>safe,scopes:()=>[]})
 return {api:root.DshCacheUpgrade,requests,reloads:()=>reloads,notice:()=>notice,idle:()=>safe=true,invalid:()=>next='bad'}
}
test('a changed build warns without interrupting a draft; idle reload happens once, never on an invalid ID',async()=>{
 const w=watcher();await w.api.check();assert.equal(w.reloads(),0);assert.ok(w.notice())
 assert.equal(w.requests[0].opts.cache,'no-store')
 w.idle();await w.api.check();await w.api.check();assert.equal(w.reloads(),1)
 const invalid=watcher();invalid.invalid();invalid.idle();await invalid.api.check();assert.equal(invalid.reloads(),0);assert.equal(invalid.notice(),undefined)
})
function history(quota=false){
 const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem(key,value){if(quota)throw Error('quota');data.set(key,String(value))},removeItem:key=>data.delete(key)}
 const proxy=new Proxy(storage,{ownKeys:()=>[...data.keys()],getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})})
 const c=vm.createContext({module:{exports:{}},localStorage:proxy,Date,JSON,Map,Set,WeakMap,setTimeout,clearTimeout,globalThis:{}})
 vm.runInContext(read('public/history.js'),c)
 return {data,api:c.module.exports}
}
const scope='historyCacheV2:'+ 'a'.repeat(64),entry=n=>({seq:n,event:{type:'assistant/message',data:{content:[{type:'text',text:'cached'}]}}})
test('legacy migration preserves identity, credentials and newer cache; removes container only after success',async()=>{
 const h=history();h.data.set('token','credential');h.data.set('dshTheme','fish');h.data.set('dsh-e2ee','private-pairing')
 h.data.set(scope,JSON.stringify({s:{events:[entry(1)]}}));h.data.set('dsh-remote-history-old','ambiguous old cache')
 h.data.set(scope+':session:s',JSON.stringify({events:[entry(9)]}))
 const r=await h.api.migrateLegacy([scope]);assert.equal(r.reclaimed,2)
 assert.equal(JSON.parse(h.data.get(scope+':session:s')).events[0].seq,9)
 assert.equal(h.data.get('token'),'credential');assert.equal(h.data.get('dshTheme'),'fish');assert.equal(h.data.get('dsh-e2ee'),'private-pairing')
})
test('failed storage migration keeps original data and never imports a different identity',async()=>{
 const h=history(true),raw=JSON.stringify({s:{events:[entry(1)]}})
 h.data.set(scope,raw);const result=await h.api.migrateLegacy([scope])
 assert.equal(result.pending,1);assert.equal(h.data.get(scope),raw)
 const other=history();other.data.set(scope,raw);await other.api.migrateLegacy(['historyCacheV2:'+'b'.repeat(64)])
 assert.equal(other.data.get(scope),raw);assert.equal(other.data.has(scope+':session:s'),false)
})
