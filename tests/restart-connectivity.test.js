'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const crypto=require('node:crypto')
const {createRealisticStack}=require('./fixtures/realistic-stack.cjs')

test('isolated gateway replacement preserves pairing, refreshes tickets and resets event epochs',async t=>{
 const stack=await createRealisticStack();t.after(()=>stack.stop())
 const headers={authorization:'Bearer '+stack.token,'content-type':'application/json',connection:'close'}
 const health=async()=>{const response=await fetch(stack.base+'/health',{headers:{connection:'close'}});assert.equal(response.status,200);return response.json()}
 const ticket=async()=>{const response=await fetch(stack.base+'/api/ws-ticket',{method:'POST',headers});assert.equal(response.status,200);return response.json()}
 const poll=async query=>{const response=await fetch(stack.base+'/api/events.poll?kind=mux&wait=0'+query,{headers});assert.equal(response.status,200);return response.json()}
 const rpc=async(method,payload)=>{const response=await fetch(stack.base+'/api/'+method,{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload})});assert.equal(response.status,200);const body=await response.json();assert.equal(body.result.ok,true);return body.result.value}
 const before=await health(),firstTicket=await ticket(),firstPoll=await poll('')
 const child=await rpc('session.fork',{sessionId:'session-1',atSeq:5})
 assert.ok(child.sessionId);const restartedPid=await stack.restartGateway()
 const after=await health(),secondTicket=await ticket(),secondPoll=await poll('&since='+firstPoll.latestSeq+'&epoch='+encodeURIComponent(firstPoll.epoch))
 assert.notEqual(after.pid,before.pid);assert.equal(after.pid,restartedPid)
 assert.equal(after.upstreamOk,true);assert.equal(after.events.mux.connected,true);assert.equal(after.events.host.connected,true)
 assert.notEqual(firstTicket.ticket,secondTicket.ticket);assert.notEqual(firstPoll.epoch,secondPoll.epoch);assert.equal(secondPoll.reset,true)
 const list=await rpc('session.list',{})
 assert.ok(list.items.some(row=>row.sessionId===child.sessionId),'the confirmed branch survives the gateway restart')
 t.diagnostic('Actual isolated gateway PID replaced; existing Bearer pairing, new WS tickets, changed epoch and confirmed fork all recovered')
})

test('upstream restart reconnects both collectors without replacing the gateway or its pairing',{timeout:15000},async t=>{
 const stack=await createRealisticStack();t.after(()=>stack.stop())
 const before=await (await fetch(stack.base+'/health')).json()
 await stack.dsh.restart()
 const deadline=Date.now()+10000;let after
 do {
  after=await (await fetch(stack.base+'/health')).json()
  if(after.events.mux.connected&&after.events.host.connected)break
  await new Promise(resolve=>setTimeout(resolve,50))
 }while(Date.now()<deadline)
 assert.equal(after.pid,before.pid);assert.equal(after.events.mux.connected,true);assert.equal(after.events.host.connected,true)
 const ticket=await fetch(stack.base+'/api/ws-ticket',{method:'POST',headers:{authorization:'Bearer '+stack.token}})
 assert.equal(ticket.status,200)
 t.diagnostic('Actual fake-upstream HTTP/WS listener closed and reopened; both gateway collectors reconnected with the original pairing')
})
