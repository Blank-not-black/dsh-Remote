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
 const c=vm.createContext({state,fetch,AbortSignal,navigator:{onLine:true},reconnectInfo:null,activeConnectionIssue:()=>null,captureConnection:()=>({server:stack.base,valid:()=>true}),updateConn(){}})
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

test('Mobile checks gateway liveness after a failed readiness probe and keeps the message receipt capability', async t => {
  const stack = await createRealisticStack()
  t.after(() => stack.stop())
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
  const state = { server: stack.base, token: stack.token, gatewayHealth: {}, streamMode: 'ws', streamsOk: { mux: true } }
  const probes = []
  let reachable = true
  const c = vm.createContext({
    state, AbortSignal, navigator: { onLine: true }, activeConnectionIssue: () => null,
    captureConnection: () => ({ server: stack.base, valid: () => true }), updateConn() {},
    fetch: (url, options) => {
      const probe = new URL(url).searchParams.get('probe')
      probes.push(probe)
      // Simulate a proxy timeout for the request that waits for the DSH upstream.
      return probe === 'fresh' || !reachable ? new Response(null, { status: 504 }) : fetch(url, options)
    }
  })
  for (const [start, end] of [['function activeGatewayCapability', 'async function selectFastestServer'], ['function mobileConnectionStatus()', 'function updateConn()']]) {
    vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), c)
  }

  await c.refreshConnectionHealth()
  assert.deepEqual(probes, ['fresh', 'live'])
  assert.equal(c.mobileConnectionStatus(), 'conn.on')
  assert.equal(c.activeGatewayCapability('operations'), true)

  reachable = false
  await c.refreshConnectionHealth()
  assert.equal(c.mobileConnectionStatus(), 'conn.gatewayOffline')
  assert.equal(c.activeGatewayHealth(), null)
  assert.equal(c.activeGatewayCapability('operations'), true, 'transient probe failure must not make a retry bypass receipt tracking')

  reachable = true
  await c.refreshConnectionHealth()
  assert.equal(c.mobileConnectionStatus(), 'conn.on')
})

test('An authenticated continuity probe reaches only the named mux socket', async t => {
  const stack = await createRealisticStack()
  t.after(() => stack.stop())
  const stream = crypto.randomBytes(16).toString('hex'), otherStream = crypto.randomBytes(16).toString('hex')
  const nonce = crypto.randomBytes(16).toString('hex')
  const headers = { authorization: 'Bearer ' + stack.token }
  async function connect(id) {
    const res = await fetch(stack.base + '/api/ws-ticket', { method: 'POST', headers })
    const { ticket } = await res.json()
    const ws = new WebSocket(stack.base.replace(/^http/, 'ws') + '/api/events.mux?' + new URLSearchParams({ stream: id, ticket }))
    t.after(() => ws.close())
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return ws
  }
  const [target, other] = await Promise.all([connect(stream), connect(otherStream)])
  const received = [], otherFrames = []
  const record = frames => ({ data }) => {
    const frame = JSON.parse(data)
    if (frame.type === 'relay/ws-probe') frames.push(frame.nonce)
  }
  target.addEventListener('message', record(received))
  other.addEventListener('message', record(otherFrames))
  const probe = (id, auth) => fetch(stack.base + '/api/events.poll?' + new URLSearchParams({ kind: 'mux', stream: id, wsProbe: nonce }), { headers: auth })
  assert.equal((await probe(stream, {})).status, 401)
  assert.equal((await probe(crypto.randomBytes(16).toString('hex'), headers)).status, 404)
  assert.equal((await probe(stream, headers)).status, 204)
  for (let i = 0; i < 40 && !received.length; i++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(received, [nonce])
  assert.deepEqual(otherFrames, [])
})
