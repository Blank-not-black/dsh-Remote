'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const activity=require('../public/activity.js')
const row=(seq,type,data)=>({seq,event:{type,data}})
test('only the Host-selected failure gets a continuation action and it submits once', async () => {
  const failed = seq => row(seq, 'turn/end', { reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'Timeout' } } })
  const entries = [failed(4), failed(8)]
  let click, accept, submitted = [], rendered
  const box = { contains: () => true, addEventListener: (_, handler) => { click = handler } }
  const options = { history: {}, ending: 8, valid: () => true,
    render: () => { rendered = activity.withContinuation(box, entries, options) },
    submit: ending => { submitted.push(ending); return new Promise(resolve => { accept = resolve }) },
    failed: error => { throw error } }
  options.render()
  assert.equal(rendered[0], entries[0])
  assert.match(activity.failureHtml(activity.failure(entries[1].event), false, rendered[1].view.continuation), /继续生成/)
  const grouped = activity.groupFailures(rendered)[0].view.failureGroup
  const groupHtml = activity.failureGroupHtml(grouped, entry => activity.failureHtml(activity.failure(entry.event), false, entry.view?.continuation))
  assert.match(groupHtml, /<\/details><button[^>]+data-continue-generation="8"/)
  const event = { target: { closest: () => ({ dataset: { continueGeneration: '8' } }) } }
  const pending = click(event)
  await click(event)
  assert.deepEqual(submitted, [8])
  assert.equal(rendered[1].view.continuation.pending, true)
  accept({ accepted: true })
  await pending
  assert.equal(rendered[1], entries[1])
  await click(event)
  assert.deepEqual(submitted, [8])
})
test('tool calls and results form one disclosure while original history and other messages stay intact',()=>{
 const call=row(1,'tool/call',{callId:'a',name:'read_file',arguments:{path:'/work/readme.md'}}),message=row(2,'assistant/message',{content:[]}),result=row(3,'tool/result',{callId:'a',output:'contents'})
 const original=[call,message,result],prepared=activity.prepare(original)
 assert.deepEqual(original,[call,message,result]);assert.equal(original.length,3);assert.equal(prepared.length,2)
 assert.equal(prepared[1],message);assert.equal(prepared[0].seq,call.seq);assert.equal(prepared[0].event,call.event)
 assert.equal(prepared[0].view.toolActivity.result,'contents');assert.equal(activity.prepare(original)[0],prepared[0])
 assert.match(activity.toolEvent(prepared[0]),/read_file/);assert.match(activity.toolEvent(prepared[0]),/contents/)
})
test('interleaved calls pair by identity and turn; orphan and unidentifiable results remain visible',()=>{
 const a=row(1,'tool/call',{callId:'same',turn:1,name:'first'}),b=row(2,'tool/call',{callId:'same',turn:2,name:'second'}),other=row(3,'tool/call',{callId:'parallel',name:'parallel'})
 const old=row(4,'tool/result',{callId:'same',turn:1,output:'older'}),fresh=row(5,'tool/result',{callId:'same',turn:2,error:'denied'}),orphan=row(6,'tool/result',{callId:'unknown',output:'orphan'}),noId=row(7,'tool/result',{output:'unidentified'})
 const list=activity.prepare([a,b,other,old,fresh,orphan,noId])
 assert.equal(list.length,5);assert.equal(list[0].view.toolActivity.result,'older');assert.equal(list[1].view.toolActivity.result,'denied');assert.equal(list[1].view.toolActivity.error,true)
 assert.equal(list[2],other);assert.equal(list[3],orphan);assert.equal(list[4],noId)
 const mismatch=row(8,'tool/result',{callId:'parallel',turn:4,output:'different turn'})
 other.event.data.turn=3;assert.deepEqual(activity.prepare([other,mismatch]),[other,mismatch])
})
test('an updated result replaces the derived view without mutating or falsely completing its call',()=>{
 const call=row(1,'tool/call',{callId:'a',name:'shell'}),old=row(2,'tool/result',{callId:'a',output:'old'}),fresh=row(2,'tool/result',{callId:'a',output:'fresh'})
 assert.equal(activity.prepare([call])[0],call)
 const first=activity.prepare([call,old])[0],second=activity.prepare([call,fresh])[0]
 assert.notEqual(first,second);assert.equal(second.view.toolActivity.result,'fresh');assert.equal(call.view,undefined)
 assert.match(activity.toolEvent(call),/已调用/);assert.doesNotMatch(activity.toolEvent(call),/已完成|成功/)
})
test('activity escapes names, summaries, keys, tool output and reasoning instead of interpreting HTML',()=>{
 const payload='<img src=x onerror="alert(1)">',html=activity.tool({key:'" onclick="bad',name:payload,args:{command:payload},result:payload,error:true})
 assert.doesNotMatch(html,/<img| onclick="bad/);assert.match(html,/&lt;img/);assert.match(html,/is-error/)
 const reasoning=activity.reasoning({text:payload,key:'stream',live:true})
 assert.doesNotMatch(reasoning,/<img|<details[^>]*\sopen(?:\s|>)/);assert.match(reasoning,/is-live/);assert.match(reasoning,/&lt;img/)
})
test('live and persisted reasoning share an identity so expansion can survive message handoff',()=>{
 const key=activity.reasoningKey({turn:3,step:2},0,'fallback')
 assert.equal(key,activity.reasoningKey({turn:3,step:2},0,'message-200'))
 assert.notEqual(key,activity.reasoningKey({turn:3,step:2},1,'fallback'))
 assert.equal(activity.reasoningKey({},0,'message-200'),'message-200')
 assert.doesNotMatch(activity.reasoning({key,text:'Long thought\nA brief next step'}),/<details[^>]*\sopen(?:\s|>)/)
})
test('consecutive tools stay before their own reply, and later tools start a new group',()=>{
 const a=row(1,'tool/call',{callId:'a',name:'read_file'}),b=row(2,'tool/result',{callId:'a',output:'x'}),c=row(3,'tool/call',{callId:'b',name:'run_tests'}),msg=row(4,'assistant/message',{content:[{type:'text',text:'Progress'}]}),d=row(5,'tool/call',{callId:'d',name:'grep'}),user=row(6,'user/message',{content:[]})
 const prepared=activity.prepare([a,b,c])
 assert.equal(prepared.length,2,'call and its result merge before grouping')
 const grouped=activity.group(prepared)
 assert.equal(grouped.length,1)
 assert.equal(grouped[0].seq,1)
 assert.equal(grouped[0].event.type,'activity/group')
 assert.deepEqual(grouped[0].view.activityGroup.items.map(item=>item.entry.seq),[1,3])
 const acrossMessage=activity.group(activity.prepare([a,b,c,msg,d]))
 assert.deepEqual(acrossMessage.map(entry=>entry.event.type),['activity/group','assistant/message','activity/group'])
 assert.deepEqual(acrossMessage[0].view.activityGroup.items.map(item=>item.entry.seq),[1,3])
 assert.deepEqual(acrossMessage[2].view.activityGroup.items.map(item=>item.entry.seq),[5])
 const nextTurn=activity.group(activity.prepare([a,b,c,msg,user,d]))
 assert.deepEqual(nextTurn.map(entry=>entry.event.type),['activity/group','assistant/message','user/message','activity/group'])
})
test('reasoning blocks move into the group and leave the message without duplicate rows',()=>{
 const first=row(1,'assistant/message',{message:{role:'assistant',content:[{type:'reasoning',text:'先读配置'},{type:'text',text:'开始检查。'}]}})
 const call=row(2,'tool/call',{callId:'a',name:'read_file'}),result=row(3,'tool/result',{callId:'a',output:'ok'})
 const grouped=activity.group(activity.prepare([first,call,result]))
 assert.equal(grouped.length,3)
 assert.equal(grouped[0].event.type,'activity/group')
 const items=grouped[0].view.activityGroup.items
 assert.deepEqual(items.map(item=>item.kind),['reasoning'])
 assert.deepEqual(grouped[2].view.activityGroup.items.map(item=>item.kind),['tool'])
 assert.equal(items[0].text,'先读配置')
 assert.equal(grouped[1].event.type,'assistant/message')
 const blocks=grouped[1].event.data.message.content
 assert.deepEqual(blocks.map(block=>block.type),['text'],'message keeps only its visible text block')
 const original=first.event.data.message.content
 assert.equal(original.length,2,'the source entry is untouched for cache and export')
 const onlyReasoning=row(4,'assistant/message',{message:{role:'assistant',content:[{type:'reasoning',text:'只思考'}]}})
 const cleaned=activity.group(activity.prepare([onlyReasoning,row(5,'tool/call',{callId:'b',name:'grep'})]))
 assert.deepEqual(cleaned.map(entry=>entry.event.type),['activity/group'],'an empty message is dropped after extracting its reasoning')
})
test('a single tool has the same parent disclosure and grouping never mutates its input',()=>{
 const single=row(1,'tool/call',{callId:'a',name:'read'}),msg=row(2,'assistant/message',{content:[{type:'text',text:'Reply'}]})
 const prepared=activity.prepare([single,msg])
 const grouped=activity.group(prepared)
 assert.deepEqual(grouped.map(entry=>entry.event.type),['activity/group','assistant/message'])
 assert.equal(grouped[0].view.activityGroup.items[0].entry,single)
 assert.deepEqual(prepared.map(entry=>entry.event.type),['tool/call','assistant/message'])
})

test('grouped reasoning drops only blank text remnants and preserves every non-text block',()=>{
 for(const value of ['', ' \n ', '\u200b\u200c\u200d\u2060\ufeff']){
  const message=row(1,'assistant/message',{content:[{type:'reasoning',text:'保留思考'},{type:'text',text:value}]})
  const raw=[message,row(2,'tool/call',{callId:'a',name:'read'})],before=JSON.stringify(raw)
  const grouped=activity.group(raw)
  assert.deepEqual(grouped.map(entry=>entry.event.type),['activity/group']);assert.equal(JSON.stringify(raw),before)
 }
 for(const block of [{type:'image',data:'AA=='},{type:'file',name:'report.pdf'},{type:'unknown',data:'keep'}]){
  const raw=[row(1,'assistant/message',{content:[{type:'reasoning',text:'思考'},{type:'text',text:'\u200b'},block]}),row(2,'tool/call',{callId:'a',name:'read'})]
  const grouped=activity.group(raw);assert.equal(grouped.length,3)
  assert.ok(grouped[1].event.data.content.includes(block),'non-text blocks must be left to their renderer')
 }
})
test('live reasoning stays with the open process and reuses its key after the reply arrives',()=>{
 const thought={turn:2,step:1,index:0,text:'Waiting'}
 const marker=row(1,'turn/start',{turn:2})
 const live=activity.group([marker],{liveReasoning:[thought],running:true})[1].view.activityGroup
 const stored=activity.group([marker,row(2,'assistant/message',{turn:2,step:1,content:[{type:'reasoning',text:'Done'},{type:'text',text:'Reply'}]})])[1].view.activityGroup
 assert.equal(live.items[0].key,stored.items[0].key)
 assert.equal(live.running,true);assert.equal(stored.running,false)
 assert.match(activity.groupHtml(live,activity.toolEvent),/思考中/)
})
test('PTC dispatched tools nest under their owning tool and orphan output stays available',()=>{
 const entries=[row(1,'tool/call',{turn:1,callId:'p',name:'ptc'}),row(2,'tool/ptc-dispatch-start',{turn:1,parentCallId:'p',subCallId:'a',name:'read'}),row(3,'tool/ptc-dispatch',{turn:1,parentCallId:'p',subCallId:'a',content:'file text'}),row(4,'tool/ptc-dispatch',{turn:1,parentCallId:'missing',subCallId:'b',content:'orphan'})]
 const prepared=activity.prepare(entries)
 assert.deepEqual(prepared.map(e=>e.seq),[1,4])
 assert.match(activity.toolEvent(prepared[0]),/activity-nested-tools.*read.*file text/)
 assert.match(activity.toolEvent(prepared[1]),/orphan/)
})
test('completed turn summarizes reasoning and calls before its first process and keeps replies in place',()=>{
 const events=[row(1,'turn/start',{turn:1}),row(2,'tool/call',{turn:1,callId:'a',name:'read'}),row(3,'assistant/message',{turn:1,content:[{type:'reasoning',text:'Check both results'},{type:'text',text:'First reply'}]}),row(4,'tool/call',{turn:1,callId:'b',name:'shell'}),row(5,'assistant/message',{turn:1,content:[{type:'text',text:'Last reply'}]}),row(6,'turn/end',{turn:1,reason:{kind:'completed'}})]
 events[0].event.time=1000;events.at(-1).event.time=3500
 const view=activity.group(events)
 assert.deepEqual(view.map(e=>e.event.type),['turn/start','activity/turn','activity/group','assistant/message','activity/group','assistant/message','turn/end'])
 assert.deepEqual(view[1].view.activityTurn,{id:1,duration:3,thoughts:1,calls:2})
 assert.equal(view[2].view.activityGroup.summaryTurn,1)
 assert.equal(view[4].view.activityGroup.summaryTurn,1)
 const summary=activity.turnHtml(view[1].view.activityTurn)
 assert.match(summary,/本轮过程.*1 段思考 · 2 次工具调用.*耗时 3 秒/)
 assert.doesNotMatch(activity.turnHtml(activity.group(events,{showTools:false})[1].view.activityTurn),/工具调用/)
 assert.doesNotMatch(activity.turnHtml({id:1,duration:null,calls:1}),/耗时|思考/)
 const interrupted=structuredClone(events);interrupted.at(-1).event.data.reason.kind='aborted'
 assert.ok(!activity.group(interrupted).some(e=>e.view?.activityTurn))
})
test('the turn summary counts a paired tool and each nested dispatch once',()=>{
 const events=[row(1,'turn/start',{turn:1}),row(2,'tool/call',{turn:1,callId:'parent',name:'ptc'}),row(3,'tool/ptc-dispatch-start',{turn:1,parentCallId:'parent',subCallId:'child',name:'read'}),row(4,'tool/ptc-dispatch',{turn:1,parentCallId:'parent',subCallId:'child',content:'file text'}),row(5,'tool/result',{turn:1,callId:'parent',output:'ok'}),row(6,'turn/end',{turn:1,reason:{kind:'completed'}})]
 const summary=activity.group(activity.prepare(events)).find(entry=>entry.view?.activityTurn).view.activityTurn
 assert.deepEqual(summary,{id:1,duration:null,thoughts:0,calls:2})
})
