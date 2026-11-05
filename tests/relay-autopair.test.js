'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const source=fs.readFileSync(path.join(__dirname,'../public/relay-autopair.js'),'utf8')
function setup({local='http://192.168.1.2:8787',confirm=true,old={},failure='',canPair=true}={}) {
  const calls=[],saved=[],notices=[],pin='a'.repeat(64),origin='https://public.example.test'
  let valid=true,state={...old}
  const host={enabled:true,canPairLocally:canPair,publicUrl:origin,e2ee:{enabled:true,configured:true,fingerprint:pin}}
  const pairing={fingerprint:pin,relayUrl:origin+'/relay/v1/e2ee',deviceId:'b'.repeat(32),expiresAt:Date.now()+86400000}
  const root={URL,location:{href:'https://localhost/'},AbortSignal,setTimeout:fn=>{fn()},
    confirm:message=>{calls.push(['confirm',message]);return confirm},NativeE2ee:{
      info:()=>JSON.stringify(state),supported:()=>true,
      configure:(json,expected)=>{calls.push(['configure',expected]);state={...JSON.parse(json),configured:true};return JSON.stringify({origin})},
    },fetch:async(url,options)=>{
      calls.push([options.method||'GET',url,options])
      if(options.method==='POST') {
        if(failure==='stale')valid=false
        if(failure==='post')throw Error('uncertain')
        return {ok:true,json:async()=>({pairing:failure==='mismatch'?{...pairing,relayUrl:'https://wrong.example.test/relay/v1/e2ee'}:pairing})}
      }
      if(url.startsWith(origin)&&failure==='verify')throw Error('offline')
      return {ok:true,json:async()=>host}
    }}
  vm.runInNewContext(source,{window:root,URL,Date,JSON,Set,Promise,Error})
  const options={connection:()=>({url:()=>local+'/relay',headers:{authorization:'Bearer isolated-fixture-token'},valid:()=>valid}),onPaired:(...args)=>saved.push(args),onStatus:(...args)=>notices.push(args)}
  return {root,calls,saved,notices,options,host,pairing,offer:()=>root.DshRelayAutoPair.offer(options)}
}
test('LAN bootstrap confirms once, creates an independent device, verifies its public identity then saves the address',async()=>{
  const h=setup();await h.offer();await h.offer()
  assert.deepEqual(h.calls.map(c=>c[0]),['GET','confirm','POST','configure','GET'])
  assert.equal(h.calls[2][1],'http://192.168.1.2:8787/relay/pair')
  assert.equal(h.calls[2][2].redirect,'error');assert.equal(h.saved.length,1)
  assert.equal(h.saved[0][0],'https://public.example.test')
  assert.equal(h.root.DshRelayAutoPair.pairedOrigin('http://192.168.1.2:8787/admin/api/relay'),'https://public.example.test')
  assert.match(h.notices.at(-1)[0],/局域网连接保留/)
})
test('cancellation, public URLs, browsers and untrusted connection sources never create a device',async()=>{
  for(const options of [{confirm:false},{local:'https://public.example.test'},{local:'http://192.168.1.2.attacker.test'},{canPair:false}]) {
    const h=setup(options);await h.offer();assert.equal(h.calls.some(c=>c[0]==='POST'),false);assert.equal(h.saved.length,0)
  }
  const h=setup();delete h.root.NativeE2ee.configure;await h.offer();assert.equal(h.calls.length,0)
})
test('unknown POST outcomes never retry; changed context and mismatched pairing never configure or save',async()=>{
  for(const failure of ['post','stale','mismatch']) {
    const h=setup({failure});await h.offer();await h.offer()
    assert.equal(h.calls.filter(c=>c[0]==='POST').length,1)
    assert.equal(h.calls.some(c=>c[0]==='configure'),false);assert.equal(h.saved.length,0)
  }
})
test('failed verification keeps the address unsaved; retry uses saved pairing without creating another device',async()=>{
  const h=setup({failure:'verify'});await h.offer()
  assert.equal(h.saved.length,0);assert.equal(h.calls.filter(c=>c[0]==='POST').length,1)
  await h.root.DshRelayAutoPair.offer({...h.options,force:true})
  assert.equal(h.calls.filter(c=>c[0]==='POST').length,1)
  assert.equal(h.calls.filter(c=>c[0]==='configure').length,1)
})
test('existing valid pairing verifies and restores the address without replacing identity or encryption choice',async()=>{
  const h=setup({old:{configured:true,fingerprint:'a'.repeat(64),deviceId:'b'.repeat(32),expiresAt:Date.now()+86400000,encrypted:false}})
  await h.offer();assert.deepEqual(h.calls.map(c=>c[0]),['GET','GET']);assert.equal(h.saved.length,1)
})
test('certificate changes require confirmation and bind the replacement to the previous fingerprint',async()=>{
  const h=setup({old:{configured:true,fingerprint:'c'.repeat(64)}})
  await h.offer();assert.match(h.calls.find(c=>c[0]==='confirm')[1],/主机证书已改变/)
  assert.equal(h.calls.find(c=>c[0]==='configure')[1],'c'.repeat(64))
})
