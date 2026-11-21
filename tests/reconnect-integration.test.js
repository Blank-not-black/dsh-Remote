'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),crypto=require('node:crypto')
const {createRealisticStack}=require('./fixtures/realistic-stack.cjs')
function handshake(base,ticket){return new Promise((resolve,reject)=>{
 const req=http.request(new URL(base+'/api/events.mux?ticket='+encodeURIComponent(ticket)),{headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64')}})
 req.setTimeout(3000,()=>req.destroy(Error('timeout')));req.once('upgrade',(r,socket)=>{socket.destroy();resolve(r.statusCode)});req.once('response',r=>{r.resume();resolve(r.statusCode)});req.once('error',reject);req.end()
})}
test('Both frontends repeatedly reconnect using fresh gateway tickets, beyond the four-use limit',async t=>{
 const stack=await createRealisticStack();t.after(()=>stack.stop())
 for(const file of ['public/app.js','public/desktop/desktop.js']){
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8'),start=source.indexOf('let wsTicketPromise = null'),end=source.indexOf('async function rpc(',start)
  const state={server:stack.base,token:stack.token,wsTicket:{value:'previous-instance',expiresAt:Date.now()+90000,token:stack.token,server:stack.base}}
  const c=vm.createContext({state,Date,fetch,AbortSignal,CAP:null,apiUrl:p=>stack.base+p,clientIdHeaders:()=>({}),activeGatewayCapability:()=>true,captureConnection:()=>({valid:()=>true})})
  vm.runInContext(source.slice(start,end),c)
  const tickets=new Set()
  for(let i=0;i<8;i++){const ticket=await c.getWsTicket();tickets.add(ticket);assert.equal(await handshake(stack.base,ticket),101)}
  assert.equal(tickets.size,8)
 }
})
test('Explicit fresh probe reports an upstream outage rather than the prior healthy cache',async t=>{
 const stack=await createRealisticStack();t.after(()=>stack.stop())
 const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8')
 const state={server:stack.base,token:stack.token,gatewayHealth:{},streamMode:'ws',streamsOk:{mux:true},pollSeq:{},errCount:0}
 const c=vm.createContext({state,fetch,AbortSignal,navigator:{onLine:true},reconnectInfo:null,captureConnection:()=>({server:stack.base,valid:()=>true}),updateConn(){}})
 for(const [start,end] of [['let connectionHealthProbe = null','async function selectFastestServer'],['function mobileConnectionStatus()','function updateConn()']]){
  vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),c)
 }
 assert.equal(c.mobileConnectionStatus(),'conn.checking')
 const healthy=await c.refreshConnectionHealth();assert.equal(healthy.upstreamOk,true)
 state.streamMode='poll';assert.equal(c.mobileConnectionStatus(),'conn.checking')
 state.pollSeq.muxReady=true;assert.equal(c.mobileConnectionStatus(),'conn.poll')
 await stack.dsh.close()
 const failed=await c.refreshConnectionHealth();assert.equal(failed.upstreamOk,false);assert.equal(failed.upstreamReachable,false);assert.equal(failed.readiness.ok,false)
 assert.equal(c.mobileConnectionStatus(),'conn.dshOffline','gateway polling cannot mask a DSH outage')
 state.streamMode='ws';assert.equal(c.mobileConnectionStatus(),'conn.dshOffline','an open client socket cannot mask a DSH outage')
 assert.ok(failed.upstreamCheckedAt>=healthy.upstreamCheckedAt)
 await stack.dsh.restart()
 await c.refreshConnectionHealth()
 state.streamMode='poll'
 assert.equal(c.mobileConnectionStatus(),'conn.poll')
})
