'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto')
const source=fs.readFileSync(path.join(__dirname,'..','gateway.js'),'utf8')
function fixture(){
 const sockets=[],frames=[],intervals=[],timers=[];let now=100000
 const modernState={sessions:new Map(),sessionCursors:new Map(),assistantStreams:new Map(),pendingEvents:new Map(),sessionInterests:new Map(),followedSessions:new Set(),workspaces:{items:[],archivedSessionIds:[]}}
 class Socket{
  constructor(){this.readyState=0;this.sent=[];sockets.push(this)}
  open(){this.readyState=1;this.onopen()}
  send(raw){this.sent.push(JSON.parse(raw))}
  feed(streamId,value,type='item',error){this.onmessage({data:JSON.stringify({type,streamId,value,...error?{error}:{}})})}
  close(){this.readyState=3;this.onclose({code:1000,reason:''})}
 }
 const collectorReplay={mux:new Map(),host:new Map()},eventCollectors={mux:null,host:null},state=()=>({reconnects:0})
 const timer=(fn,ms,list)=>{const value={fn,ms,unref(){}};list.push(value);return value}
 const c=vm.createContext({modernState,collectorReplay,eventCollectors,crypto,Buffer,WebSocket:Socket,Date:{now:()=>now},
  UPSTREAM:new URL('http://127.0.0.1:1'),UPSTREAM_AUTHORITY:'127.0.0.1:1',WS_UPGRADE_TIMEOUT_MS:1000,
  eventCollectorState:{mux:state(),host:state()},dshUpstreamHeaders:()=>({}),legacyPush:(kind,payload)=>frames.push({kind,payload}),
  setInterval:(fn,ms)=>timer(fn,ms,intervals),clearInterval:value=>{value.cleared=true},
  setTimeout:(fn,ms)=>timer(fn,ms,timers),clearTimeout:value=>{if(value)value.cleared=true}})
 const start=source.indexOf('function requestModernSessionStream('),end=source.indexOf('async function startCompatibleEventCollectors(',start)
 assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),c)
 const collector=c.startModernEventCollector();eventCollectors.mux=collector;eventCollectors.host=collector
 const current=()=>sockets.at(-1)
 const requests=(socket=current(),endpoint='session/follow')=>socket.sent.filter(frame=>frame.type==='open'&&frame.endpoint===endpoint)
 const live=id=>modernState.sessions.set(id,{sessionId:id,agentAvailable:true,running:false})
 return {c,modernState,collector,collectorReplay,frames,sockets,intervals,current,requests,live,advance:ms=>{now+=ms},tick:()=>intervals[0].fn()}
}
test('issue 21: 990 cold and many already-live sessions cause no eager follow/job opens; approvals stay global',()=>{
 const h=fixture()
 for(let i=0;i<990;i++)h.modernState.sessions.set('cold-'+i,{sessionId:'cold-'+i,agentAvailable:false,running:false})
 for(let i=0;i<50;i++)h.live('live-'+i)
 h.current().open()
 assert.deepEqual(h.current().sent.map(frame=>frame.endpoint),['$events','session/control','workspace/follow'])
 h.c.requestModernSessionStream('cold-1');assert.equal(h.requests().length,0)
 h.current().feed('events',{type:'emit',event:'api-session/added',args:[{sessionId:'another-cold',agentAvailable:false}]})
 h.current().feed('events',{type:'emit',event:'api-session/added',args:[{sessionId:'another-live',agentAvailable:true}]})
 assert.equal(h.requests().length,0);assert.equal(h.requests(h.current(),'job/list').length,0)
 h.current().feed('events',{type:'waterfall',agentId:'live-49',eventId:'approval-1',event:'approval/request',request:{toolName:'fixture'}})
 assert.ok(h.frames.some(row=>row.payload.type==='approval/requested'&&row.payload.sessionId==='live-49'))
 h.c.requestModernSessionStream('live-1');h.c.requestModernSessionStream('live-1')
 h.current().feed('events',{type:'emit',event:'api-session/added',args:[{sessionId:'live-1',agentAvailable:true}]})
 assert.equal(h.requests().length,1);assert.equal(h.requests(h.current(),'job/list').length,1)
 assert.equal(h.modernState.followedSessions.size,1)
 h.collector.close();assert.equal(h.intervals[0].cleared,true)
})
test('interest cap/expiry cancel actual upstream invocations and discard stale reasoning/cursors; revisits use new stream ids',()=>{
 const h=fixture();h.current().open()
 for(let i=0;i<20;i++){h.live('s'+i);h.c.requestModernSessionStream('s'+i)}
 assert.equal(h.modernState.sessionInterests.size,8);assert.equal(h.modernState.followedSessions.size,8)
 assert.deepEqual([...h.modernState.followedSessions],Array.from({length:8},(_,i)=>'s'+(i+12)))
 assert.equal(h.current().sent.filter(frame=>frame.type==='cancel').length,24)
 const stream=h.requests().at(-1).streamId
 h.current().feed(stream,{type:'snapshot',cursor:9,records:[],assistantStream:{revision:1,activeAttempt:{attemptId:'a',nextIndex:0,stream:[]}}})
 assert.equal(h.modernState.sessionCursors.get('s19'),9);assert.ok(h.modernState.assistantStreams.has('s19'))
 h.collectorReplay.mux.set('session:s19','old');h.collectorReplay.mux.set('reasoning:s19','old');h.collectorReplay.mux.set('jobs:s19','old')
 h.advance(90001);h.tick()
 assert.equal(h.modernState.followedSessions.size,0);assert.equal(h.modernState.sessionInterests.size,0)
 assert.equal(h.modernState.sessionCursors.has('s19'),false);assert.equal(h.modernState.assistantStreams.has('s19'),false);assert.equal(h.collectorReplay.mux.size,0)
 h.c.requestModernSessionStream('s19');assert.notEqual(h.requests().at(-1).streamId,stream)
 const before=h.frames.length;h.current().feed(stream,{type:'event',event:{seq:99,type:'user/message'}})
 assert.equal(h.frames.length,before,'a late canceled stream cannot contaminate its replacement')
 h.collector.close()
})
test('demand survives reconnect without reobserving the catalog; old messages and delayed closes cannot change the new generation',()=>{
 const h=fixture();h.live('wanted');h.live('unwanted');h.current().open();h.c.requestModernSessionStream('wanted')
 const old=h.current();old.readyState=3 // Physical close can precede delivery of its callback.
 h.collector.reconnectNow();const current=h.current();current.open()
 assert.equal(h.requests(current).length,1);assert.equal(h.requests(current)[0].payload.args.request.address.sessionId,'wanted')
 const before=h.frames.length;old.feed('events',{type:'waterfall',eventId:'stale',event:'approval/request',agentId:'wanted',request:{}});old.onclose({code:1006})
 assert.equal(h.frames.length,before);assert.equal(h.modernState.followedSessions.has('wanted'),true)
 current.feed('events',{type:'emit',event:'api-session/removed',args:['wanted']})
 assert.equal(h.modernState.followedSessions.size,0);assert.equal(h.modernState.sessionInterests.size,0)
 assert.equal(current.sent.filter(frame=>frame.type==='cancel').length,2)
 h.collector.close()
})
test('observations never activate cold/subagent/migration sessions; external activation can satisfy existing demand',()=>{
 const h=fixture();h.current().open()
 for(const [id,summary]of [['cold',{agentAvailable:false}],['child',{agentAvailable:true,origin:'subagent'}],['old',{agentAvailable:true,formatStatus:'migration-required'}]]){
  h.modernState.sessions.set(id,{sessionId:id,...summary});h.c.requestModernSessionStream(id)
 }
 assert.equal(h.requests().length,0)
 h.current().feed('events',{type:'emit',event:'api-session/added',args:[{sessionId:'cold',agentAvailable:true}]})
 assert.equal(h.requests().length,1);assert.equal(h.requests()[0].payload.args.request.address.sessionId,'cold')
 // Older Hosts can announce a running Agent without the agentAvailable field.
 h.modernState.sessions.set('older',{sessionId:'older'});h.c.requestModernSessionStream('older')
 h.current().feed('events',{type:'emit',event:'api-session/status',args:['older',true]})
 assert.equal(h.requests().length,2)
 h.collector.close()
})
test('session failure cancels its real stream ids, backs off, then restores only the requested session',()=>{
 const h=fixture();h.current().open();h.live('s');h.c.requestModernSessionStream('s')
 const first=h.requests()[0],jobs=h.requests(h.current(),'job/list')[0]
 h.current().feed(jobs.streamId,null,'error',{code:'gateway/method-unavailable'})
 assert.equal(h.modernState.followedSessions.size,1,'an optional job namespace is isolated')
 h.current().feed(first.streamId,null,'error',{code:'server/error',message:'fixture failure'})
 assert.equal(h.modernState.followedSessions.size,0)
 assert.deepEqual(h.current().sent.filter(frame=>frame.type==='cancel').map(frame=>frame.streamId),[first.streamId,jobs.streamId])
 assert.ok(h.frames.some(row=>row.payload.type==='session/stream-error'&&row.payload.sessionId==='s'))
 h.c.requestModernSessionStream('s');assert.equal(h.requests().length,1)
 h.advance(60001);h.tick();assert.equal(h.requests().length,2)
 assert.notEqual(h.requests().at(-1).streamId,first.streamId)
 h.collector.close()
})
for (const kind of ['fallback', 'instruction-hint']) test('issue 18: '+kind+' migration failure leaves healthy events and global streams connected',()=>{
 const h=fixture();h.current().open()
 h.live('bad');h.live('healthy');h.c.requestModernSessionStream('bad');h.c.requestModernSessionStream('healthy')
 const bad=h.requests().find(row=>row.payload.args.request.address.sessionId==='bad')
 const good=h.requests().find(row=>row.payload.args.request.address.sessionId==='healthy')
 const badJobs=h.requests(h.current(),'job/list').find(row=>row.payload.args.request.sessionId==='bad')
 const socket=h.current()
 socket.feed(bad.streamId,null,'error',{code:'server/error',message:'cannot safely transform unclassified message source: '+kind+'; source v0 artifact remains unchanged'})
 assert.equal(h.modernState.followedSessions.has('bad'),false)
 assert.equal(h.modernState.followedSessions.has('healthy'),true)
 assert.deepEqual(socket.sent.filter(row=>row.type==='cancel').map(row=>row.streamId),[bad.streamId,badJobs.streamId])
 socket.feed(good.streamId,{type:'event',event:{seq:3,type:'user/message',time:1,data:{id:'healthy-message',content:[{type:'text',text:'still available'}]}}})
 assert.ok(h.frames.some(row=>row.payload.type==='session/event'&&row.payload.sessionId==='healthy'&&row.payload.event.seq===3))
 socket.feed('events',{type:'waterfall',agentId:'healthy',eventId:'approval-after-migration-error',event:'approval/request',request:{toolName:'fixture'}})
 assert.ok(h.frames.some(row=>row.payload.type==='approval/requested'&&row.payload.sessionId==='healthy'))
 assert.equal(h.sockets.length,1,'one bad session must not trigger a collector reconnect')
 assert.equal(socket.readyState,1)
 assert.ok(h.frames.some(row=>row.payload.type==='session/stream-error'&&row.payload.sessionId==='bad'&&row.payload.error.code==='session/migration-required'))
 h.c.requestModernSessionStream('bad');assert.equal(h.requests().length,2,'backoff prevents immediate repeated observation')
 h.collector.close()
})

test('unfollowed history reads an exact fresh projection cut; observer I/O cannot turn a successful page into a failed read',async()=>{
 const h=fixture(),requests=[]
 vm.runInContext(source.slice(source.indexOf('function legacyEnvelope('),source.indexOf('function modernResponseNeedsLegacyFallback('))
  +source.slice(source.indexOf('async function translateModernRpc('),source.indexOf('/** 递归截断')),h.c)
 h.c.modernResponseNeedsLegacyFallback=()=>false
 h.c.legacyHistoryValue=value=>value
 h.c.callUpstreamRemote=async(endpoint,args)=>{requests.push({endpoint,args});return {status:200,body:{result:{ok:true,value:endpoint==='session/projections'?{asOfSeq:3,values:{}}:{records:[],hasMore:false}}}}}
 h.current().open();h.modernState.sessions.set('cold',{sessionId:'cold',agentAvailable:false,projections:{asOfSeq:999}});h.modernState.sessionCursors.set('cold',999)
 const cold=await h.c.translateModernRpc('session.history',{sessionId:'cold'},'cold')
 assert.equal(cold.result.ok,true);assert.equal(requests[0].endpoint,'session/projections');assert.equal(requests[1].args.request.throughSeq,3)
 assert.equal(h.requests().length,0);assert.equal(h.modernState.sessionInterests.has('cold'),true)
 h.live('live');h.current().send=()=>{throw Error('socket closed during send')}
 const live=await h.c.translateModernRpc('session.history',{sessionId:'live'},'live')
 assert.equal(live.result.ok,true);assert.equal(h.modernState.followedSessions.size,0)
 h.collector.close()
})
