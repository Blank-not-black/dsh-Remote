/* Compact, shared conversation activity. Durable events remain untouched. */
'use strict';
;(function(root){
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
  const text=(zh,en)=>root.I18N?.lang==='en'?en:zh
  const json=value=>{try{return typeof value==='string'?value:JSON.stringify(value,null,2)??''}catch{return String(value)}}
  const cut=(value,length)=>{const source=String(value??'');return source.length>length?source.slice(0,length)+'…':source}
  const brief=value=>cut(String(value??'').replace(/\s+/g,' ').trim(),100)
  const icon=kind=>`<svg class="activity-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${kind==='reasoning'?'m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z':'m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18'}"/></svg>`
  function argumentHint(value){
    if(typeof value==='string'){try{value=JSON.parse(value)}catch{return brief(value)}}
    if(!value||typeof value!=='object')return ''
    for(const key of ['description','command','cmd','path','file_path','pattern','query','url','line'])if(typeof value[key]==='string')return brief(value[key])
    return ''
  }
  function shell(kind,key,title,hint,state,body,live=false,error=false){
    return `<details class="chat-activity activity-${kind}${live?' is-live':''}${error?' is-error':''}" data-activity-key="${esc(key)}"><summary>${icon(kind)}<span class="activity-copy"><span class="activity-title">${esc(title)}</span>${hint?`<span class="activity-hint">${esc(hint)}</span>`:''}</span><span class="activity-state">${live?'<i aria-hidden="true"></i>':''}${esc(state)}</span><span class="activity-chevron" aria-hidden="true"></span></summary><div class="activity-body">${body}</div></details>`
  }
  function reasoning(value={}){
    const source=String(value.text??'')
    const hint=brief(source.split('\n').filter(line=>line.trim()).at(-1)||'')
    return shell('reasoning',value.key,text(value.live?'思考中':'思考过程',value.live?'Thinking':'Reasoning'),hint,value.live?text('进行中','Live'):'',`<div class="activity-reasoning-text">${esc(cut(source,12000))}</div>`,!!value.live)
  }
  const errorOf=data=>!!(data?.error||data?.ok===false||data?.isError===true)
  function tool(value={}){
    const args=value.args,returned=Object.hasOwn(value,'result'),error=!!value.error
    const section=(title,content)=>`<section><h4>${esc(title)}</h4><pre>${esc(cut(json(content),12000))}</pre></section>`
    const body=(args===undefined?'':section(text('参数','Arguments'),args))+(returned?section(text('结果','Result'),value.result):`<p class="activity-note">${esc(text('当前记录中尚无对应结果。','No matching result in the loaded history.'))}</p>`)
    return shell('tool',value.key,value.name||text(returned?'工具结果':'工具调用',returned?'Tool result':'Tool call'),argumentHint(args),text(error?'返回错误':returned?'已返回':'已调用',error?'Error':returned?'Returned':'Called'),body,false,error)
  }
  const dataOf=entry=>entry.event?.data||{}
  const callId=data=>data.callId||data.message?.source?.callId
  const resultOf=data=>data.error??data.result??data.output??data.message??data.text??data.content??data
  const pairs=new WeakMap()
  function prepare(entries){
    const pending=new Map(),matched=new Map(),consumed=new Set()
    for(const entry of entries){
      const data=dataOf(entry),id=callId(data)
      if(!id)continue
      if(entry.event?.type==='tool/call'){const queue=pending.get(id)||[];queue.push(entry);pending.set(id,queue)}
      else if(entry.event?.type==='tool/result'){
        const queue=pending.get(id)||[]
        const index=queue.findLastIndex(call=>data.turn==null||dataOf(call).turn==null||data.turn===dataOf(call).turn)
        if(index>=0){const [call]=queue.splice(index,1);matched.set(call,entry);consumed.add(entry)}
      }
    }
    return entries.filter(entry=>!consumed.has(entry)).map(entry=>{
      if(entry.event?.type!=='tool/call')return entry
      const result=matched.get(entry)
      if(!result)return entry
      const cached=pairs.get(entry)
      if(cached?.result===result)return cached.entry
      const data=dataOf(entry),output=dataOf(result)
      const next={...entry,view:{...entry.view,toolActivity:{key:'tool:'+entry.seq,name:data.name||data.toolName,args:data.arguments??data.args??data.input,result:resultOf(output),error:errorOf(output)}}}
      pairs.set(entry,{result,entry:next});return next
    })
  }
  function toolEvent(entry){
    if(entry.view?.toolActivity)return tool(entry.view.toolActivity)
    const data=dataOf(entry),isResult=entry.event?.type==='tool/result'
    return tool({key:'tool:'+entry.seq,name:data.name||data.toolName||(isResult?text('工具结果','Tool result'):undefined),...(isResult?{result:resultOf(data),error:errorOf(data)}:{args:data.arguments??data.args??data.input})})
  }
  function reasoningKind(block){return block&&typeof block==='object'&&(block.type==='thinking'||block.type==='reasoning')}
  function messageBlocks(entry){
    const data=entry?.event?.data||{},message=data.message||{}
    const blocks=Array.isArray(message.content)?message.content:(Array.isArray(data.content)?data.content:null)
    return blocks?{data,message,blocks}:null
  }
  function stripReasoning(entry,rest){
    const parts=messageBlocks(entry)
    const data={...parts.data}
    if(Array.isArray(parts.message.content))data.message={...parts.message,content:rest}
    else data.content=rest
    return {...entry,event:{...entry.event,data}}
  }
  /**
   * Collapse a turn's process — every tool activity plus the reasoning blocks that would
   * otherwise occupy a row inside each assistant message — into one disclosure.
   * A user message starts a new turn; a turn without enough items keeps its original rows.
   */
  function group(entries){
    const isTool=entry=>{const type=entry?.event?.type;return type==='tool/call'||type==='tool/result'}
    // Only a human message starts a new turn; injected system-reminder user events do not.
    const isTurnStart=entry=>{
      if(entry?.event?.type!=='user/message')return false
      const data=entry.event.data||{},source=data.source??data.message?.source
      return !source||source.kind==='user'
    }
    const out=[]
    const emit=segment=>{
      const items=[],stripped=new Map()
      for(const entry of segment){
        if(isTool(entry)){items.push({kind:'tool',seq:entry.seq,entry});continue}
        const parts=messageBlocks(entry)
        if(!parts)continue
        const reasoning=parts.blocks.filter(reasoningKind)
        if(!reasoning.length)continue
        const rest=parts.blocks.filter(block=>!reasoningKind(block))
        const copy=stripReasoning(entry,rest)
        stripped.set(entry,{copy,empty:rest.length===0})
        reasoning.forEach((block,index)=>items.push({kind:'reasoning',seq:Number(entry.seq)+(index+1)/1000,text:String(block.text??block.content??''),key:'reasoning:'+entry.seq+':'+index}))
      }
      if(items.length>1){
        let emitted=false
        for(const entry of segment){
          const decorated=stripped.get(entry)
          if((isTool(entry)||decorated)&&!emitted){out.push({seq:items[0].seq,event:{type:'activity/group'},view:{activityGroup:{items}}});emitted=true}
          if(isTool(entry))continue
          if(decorated){if(!decorated.empty)out.push(decorated.copy);continue}
          out.push(entry)
        }
      }else out.push(...segment)
    }
    let segment=[]
    for(const entry of entries){
      if(isTurnStart(entry)){emit(segment);segment=[];out.push(entry)}
      else segment.push(entry)
    }
    emit(segment)
    return out
  }
  function reasoningKey(data,index,fallback){return data?.turn!=null&&data?.step!=null?'reasoning:'+JSON.stringify([data.turn,data.step,index]):fallback}
  function failure(event) {
    if(event?.type==='turn/end' && event.data?.reason?.kind==='error')return event.data.reason.error
    if(event?.type==='assistant/attempt') {
      const stream=Array.isArray(event.data?.stream)?event.data.stream:[]
      const finish=stream.findLast(record=>record.type==='chunk'&&record.chunk?.type==='finish')?.chunk
      if(finish?.reason?.kind==='error')return finish.reason.failure
    }
    return null
  }
  function failureHtml(value,attempt=false) {
    if(!value)return ''
    const message=typeof value==='string'?value:value.message
    const facts=[value.code,value.status?`HTTP ${value.status}`:''].filter(item=>typeof item==='string'&&item)
    return `<div class="chat-runtime-error" role="status"><strong>${esc(text(attempt?'模型请求失败':'运行出错',attempt?'Model request failed':'Run failed'))}</strong><div>${esc(cut(message||text('主机未提供错误详情','The host did not provide error details'),4000))}</div>${facts.length?`<small>${esc(facts.join(' · '))}</small>`:''}</div>`
  }
  const failureGroups=new WeakMap()
  function groupFailures(entries) {
    const out=[]
    let pending=[],count=0,last=-1
    const emit=()=>{
      if(count>1){
        const items=pending.slice(0,last+1),first=items[0],cached=failureGroups.get(first)
        let grouped=cached
        if(!cached||cached.view.failureGroup.items.length!==items.length||!items.every((entry,index)=>entry===cached.view.failureGroup.items[index])){
          grouped={seq:first.seq,event:{type:'failure/group'},view:{failureGroup:{items,count}}}
          failureGroups.set(first,grouped)
        }
        out.push(grouped,...pending.slice(last+1))
      }else out.push(...pending)
      pending=[];count=0;last=-1
    }
    for(const entry of entries){
      if(failure(entry.event)){pending.push(entry);count++;last=pending.length-1}
      // Retry lifecycle markers may sit between failures; messages/tools/success end a run.
      else if(pending.length&&['turn/start','agent/status'].includes(entry.event?.type))pending.push(entry)
      else{emit();out.push(entry)}
    }
    emit()
    return out
  }
  function failureGroupHtml(group,renderEntry) {
    const latest=failure(group.items.at(-1)?.event)
    const hint=typeof latest==='string'?latest:latest?.message
    return shell('error','failure-group:'+group.items[0].seq,text(`连续报错 · ${group.count} 条`,`${group.count} consecutive errors`),brief(hint),text('详情','Details'),group.items.map(renderEntry).join(''),false,true)
  }
  function attemptHtml(event) {
    const blocks=new Map(),data=event?.data||{}
    for(const record of Array.isArray(data.stream)?data.stream:[]) {
      const chunk=record.type==='chunk'?record.chunk:null,index=chunk?.index??record.index
      if(!Number.isSafeInteger(index)||index<0||index>=64)continue
      if(record.type==='reasoning-chunks')blocks.set(index,cut((blocks.get(index)||'')+(record.texts||[]).join(''),12000))
      else if(chunk?.type==='reasoning-delta')blocks.set(index,cut((blocks.get(index)||'')+String(chunk.text||''),12000))
      else if(chunk?.type==='block-end'&&chunk.block?.type==='reasoning')blocks.set(index,cut(chunk.block.text??chunk.block.content??'',12000))
    }
    return [...blocks].filter(([,value])=>value).map(([index,value])=>reasoning({text:value,key:`attempt:${event.seq}:${index}`})).join('')+failureHtml(failure(event),true)
  }
  const streamNotice=()=>`<div class="activity-note" role="status">${esc(text('弱网精简已隐藏实时思考，完成后可查看；可在网络设置中关闭精简。','Live reasoning is hidden in weak-network mode. View it after completion or disable trimming in network settings.'))}</div>`
  const api={prepare,tool,toolEvent,reasoning,reasoningKey,group,failure,failureHtml,groupFailures,failureGroupHtml,attemptHtml,streamNotice}
  if(typeof module!=='undefined'&&module.exports)module.exports=api
  else root.DshActivity=api
})(typeof window==='undefined'?globalThis:window)
