/* Compact, shared conversation activity. Durable events remain untouched. */
'use strict';
;(function(root){
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
  const text=(zh,en)=>root.I18N?.lang==='en'?en:zh
  // Test a copy only: joiners remain significant inside real words and emoji.
  const hasVisibleText=value=>String(value??'').replace(/[\u200b-\u200d\u2060\ufeff]/g,'').trim().length>0
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
  function shell(kind,key,title,hint,state,body,live=false,error=false,lazy=false){
    const render=typeof body==='function'?body:()=>String(body??'')
    const content=lazy?lazyBody(key,render):`<div class="activity-body">${render()}</div>`
    return `<details class="chat-activity activity-${kind}${live?' is-live':''}${error?' is-error':''}" data-activity-key="${esc(key)}"><summary>${icon(kind)}<span class="activity-copy"><span class="activity-title">${esc(title)}</span>${hint?`<span class="activity-hint">${esc(hint)}</span>`:''}</span><span class="activity-state">${live?'<i aria-hidden="true"></i>':''}${esc(state)}</span><span class="activity-chevron" aria-hidden="true"></span></summary>${content}</details>`
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
    const translated=returned?root.DshApprovalRecords?.feedbackHtml(value.result):''
    const body=()=>(args===undefined?'':section(text('参数','Arguments'),args))+(returned?(translated||section(text('结果','Result'),value.result)):`<p class="activity-note">${esc(text('当前记录中尚无对应结果。','No matching result in the loaded history.'))}</p>`)
      +(value.children?.length?`<div class="activity-nested-tools">${value.children.map(tool).join('')}</div>`:'')
    return shell('tool',value.key,value.name||text(returned?'工具结果':'工具调用',returned?'Tool result':'Tool call'),argumentHint(args),text(error?'返回错误':returned?'已返回':'已调用',error?'Error':returned?'Returned':'Called'),body,false,error,true)
  }
  const dataOf=entry=>entry.event?.data||{}
  const callId=data=>data.callId||data.message?.source?.callId
  const resultOf=data=>data.error??data.result??data.output??data.message??data.text??data.content??data
  const isDispatch=type=>type==='tool/ptc-dispatch-start'||type==='tool/ptc-dispatch'
  // Collapsed activity blocks keep their body out of the DOM until the user opens them.
  // Closures capture the raw values so JSON/escape work happens on demand, not during
  // history load or on every streamed update.
  const lazyBodies=new Map()
  let lazyBound=false
  function lazyBody(key,render,className='activity-body'){
    const id=String(key)
    lazyBodies.delete(id)
    lazyBodies.set(id,render)
    if(lazyBodies.size>800)lazyBodies.delete(lazyBodies.keys().next().value)
    return `<div class="${className}" data-activity-lazy="${esc(id)}"></div>`
  }
  function renderLazy(key){
    const render=lazyBodies.get(String(key))
    return render?render():''
  }
  function hydrate(details){
    const hydrated=[]
    if(!details||typeof details.querySelectorAll!=='function')return hydrated
    for(const box of details.querySelectorAll('[data-activity-lazy]')){
      if(box.closest&&box.closest('details')!==details)continue
      if(!lazyBodies.has(box.dataset.activityLazy))continue
      try{box.innerHTML=renderLazy(box.dataset.activityLazy)}catch{box.textContent=''}
      delete box.dataset.activityLazy
      hydrated.push(box)
    }
    return hydrated
  }
  function bindLazy(){
    if(lazyBound||typeof document==='undefined'||typeof document.addEventListener!=='function')return
    lazyBound=true
    // Toggle does not bubble: listen in the capture phase at the document.
    document.addEventListener('toggle',event=>{const detail=event.target;if(detail&&detail.open)hydrate(detail)},true)
  }
  bindLazy()
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
    const paired=entries.filter(entry=>!consumed.has(entry)).map(entry=>{
      if(entry.event?.type!=='tool/call')return entry
      const result=matched.get(entry)
      if(!result)return entry
      const cached=pairs.get(entry)
      if(cached?.result===result)return cached.entry
      const data=dataOf(entry),output=dataOf(result)
      const next={...entry,view:{...entry.view,toolActivity:{key:'tool:'+entry.seq,name:data.name||data.toolName,args:data.arguments??data.args??data.input,result:resultOf(output),error:errorOf(output)}}}
      pairs.set(entry,{result,entry:next});return next
    })
    if(!paired.some(entry=>isDispatch(entry.event?.type)))return paired
    const nodes=new Map(), children=new Map(), handled=new Set(), detached=new Map()
    const key=(data,id)=>JSON.stringify([data.turn??null,id])
    for(const entry of paired){
      const data=dataOf(entry),type=entry.event?.type
      if(type==='tool/call'&&callId(data))nodes.set(key(data,callId(data)),{entry,tool:toolFacts(entry)})
      if(!isDispatch(type)||!data.subCallId||!data.parentCallId)continue
      const id=key(data,data.subCallId),parent=key(data,data.parentCallId)
      if(id===parent)continue
      const previous=nodes.get(id)
      if(previous && previous.parent!==parent)continue
      nodes.set(id,{entry,parent,tool:{key:'tool:'+ (previous?.entry.seq??entry.seq),name:data.name??previous?.tool.name,args:data.arguments??previous?.tool.args,
        ...(type==='tool/ptc-dispatch'?{result:resultOf(data),error:errorOf(data)}:{})}})
      handled.add(entry)
    }
    for(const [id,item] of nodes){
      if(!item.parent)continue
      const ancestors=new Set([id]);let ancestor=item.parent
      while(ancestor&&nodes.has(ancestor)&&!ancestors.has(ancestor)&&ancestors.size<=16){ancestors.add(ancestor);ancestor=nodes.get(ancestor).parent}
      if(ancestor){detached.set(item.entry,id);continue}
      const nested=children.get(item.parent)||[];nested.push(id);children.set(item.parent,nested)
    }
    const nest=id=>({...nodes.get(id).tool,children:(children.get(id)||[]).map(nest)})
    const roots=new Map([...nodes].filter(([,item])=>!item.parent).map(([id,item])=>[item.entry,id]))
    return paired.filter(entry=>!handled.has(entry)||detached.has(entry)).map(entry=>{
      const id=roots.get(entry)||detached.get(entry)
      return id&&(detached.has(entry)||children.has(id))?{...entry,view:{...entry.view,toolActivity:nest(id)}}:entry
    })
  }
  function toolFacts(entry){
    if(entry.view?.toolActivity)return entry.view.toolActivity
    const data=dataOf(entry),type=entry.event?.type,isResult=type==='tool/result'||type==='tool/ptc-dispatch'
    return {key:'tool:'+entry.seq,name:data.name||data.toolName||(isResult?text('工具结果','Tool result'):undefined),...(isResult?{result:resultOf(data),error:errorOf(data)}:{args:data.arguments??data.args??data.input})}
  }
  const toolEvent=entry=>tool(toolFacts(entry))
  const isToolEvent=type=>type==='tool/call'||type==='tool/result'||isDispatch(type)
  function reasoningKind(block){return block&&typeof block==='object'&&(block.type==='thinking'||block.type==='reasoning')}
  function messageBlocks(entry){
    const data=entry?.event?.data||{},message=data.message||{}
    const blocks=Array.isArray(message.content)?message.content:(Array.isArray(data.content)?data.content:null)
    return blocks?{data,message,blocks}:null
  }
  function replaceBlocks(entry,rest){
    const parts=messageBlocks(entry)
    const data={...parts.data}
    if(Array.isArray(parts.message.content))data.message={...parts.message,content:rest}
    else data.content=rest
    return {...entry,event:{...entry.event,data}}
  }
  // Each consecutive run of reasoning and tool activity precedes its own reply.
  function group(entries, { liveReasoning = [], running = false, suppressBlockTools = false, showTools = true } = {}){
    const isBlockTool=block=>block?.type==='tool-call'||block?.type==='tool-result'
    const separateCalls=new Set(entries.filter(entry=>entry.event?.type==='tool/call').map(entry=>callId(dataOf(entry))).filter(Boolean))
    const out=[]
    let items=[], turn
    function flush(active=false){
      if(!items.length)return
      out.push({seq:items[0].seq,event:{type:'activity/group'},view:{activityGroup:{items,running:active,turn}}})
      items=[]
    }
    for(const entry of entries){
      const event=entry.event||{},data=dataOf(entry)
      if(data.turn!=null && turn!=null && data.turn!==turn)flush()
      if(data.turn!=null)turn=data.turn
      if(isToolEvent(event.type)){
        if(showTools)items.push({kind:'tool',seq:entry.seq,entry})
        continue
      }
      const parts=event.type==='assistant/message'?messageBlocks(entry):null
      if(parts){
        const reply=[]
        for(const [index,block] of parts.blocks.entries()){
          const seq=Number(entry.seq)+(index+1)/1000
          if(reasoningKind(block)){
            const value=String(block.text??block.content??'')
            if(hasVisibleText(value))items.push({kind:'reasoning',seq,text:value,key:reasoningKey(data,index,'reasoning:'+entry.seq+':'+index)})
          }else if(isBlockTool(block)){
            const id=block.callId??block.id
            if(showTools&&!(id?separateCalls.has(id):suppressBlockTools)){
              const result=block.type==='tool-result'
              items.push({kind:'embedded-tool',seq,tool:{key:'block:'+entry.seq+':'+index,id,name:block.name||block.toolName,
                ...(result?{result:resultOf(block),error:errorOf(block)}:{args:block.arguments??block.args??block.input})}})
            }
          }else if(block && (block.type!=='text'||hasVisibleText(block.text)))reply.push(block)
        }
        if(reply.length){flush();out.push(reply.length===parts.blocks.length?entry:replaceBlocks(entry,reply))}
        continue
      }
      flush()
      out.push(entry)
    }
    const tail=Number(entries.at(-1)?.seq)||0
    for(const [index,item] of liveReasoning.entries()){
      if(!hasVisibleText(item.text))continue
      if(item.turn!=null && turn!=null && item.turn!==turn)flush()
      if(item.turn!=null)turn=item.turn
      items.push({kind:'reasoning',seq:tail+(index+1)/1000,text:item.text,key:reasoningKey(item,item.index,'live-reasoning:'+index),live:true})
    }
    flush(running || liveReasoning.length>0)
    const turns=new Map(), summaries=new Map()
    let current
    for(const entry of out){
      const {type,time}=entry.event
      const id=entry.event.data?.turn??entry.view?.activityGroup?.turn
      if(type==='turn/start')current=id
      if(type==='user/message'&&current!=null){
        const data=dataOf(entry), source=data.source??data.message?.source
        const record=turns.get(current)
        if(record?.groups.length&&(!source||source.kind==='user'))record.interleaved=true
      }
      if(id==null)continue
      if(type==='turn/start')turns.set(id,{start:time,groups:[],interleaved:false})
      const record=turns.get(id)
      if(!record)continue
      if(type==='activity/group')record.groups.push(entry)
      if(type==='turn/end'&&record.groups.length&&!record.interleaved&&['completed','complete'].includes(entry.event.data?.reason?.kind)){
        const first=record.groups[0]
        const duration=Number.isFinite(record.start)&&Number.isFinite(time)?Math.max(1,Math.round((time-record.start)/1000)):null
        let thoughts=0, calls=0
        const counted=new Set()
        for(const row of record.groups){
          const group=row.view.activityGroup
          group.summaryTurn=id
          for(const item of group.items){
            if(item.kind==='reasoning')thoughts++
            else calls+=countToolTree(item.tool||item.entry?.view?.toolActivity,counted,item.tool?.id??(item.entry&&callId(dataOf(item.entry))))
          }
        }
        summaries.set(first,{seq:first.seq-0.0001,event:{type:'activity/turn'},view:{activityTurn:{id,duration,thoughts,calls}}})
      }
      if(type==='turn/end')current=undefined
    }
    return out.flatMap(entry=>summaries.has(entry)?[summaries.get(entry),entry]:[entry])
  }
  function groupHtml(group, renderEntry){
    const {items,running}=group
    const tools=items.filter(item=>item.kind!=='reasoning')
    const thoughts=items.length-tools.length
    const failed=tools.some(item=>item.tool?.error||item.entry?.view?.toolActivity?.error||errorOf(item.entry?.event?.data))
    const counts=[thoughts?text('思考','Reasoning'):'',tools.length?text(`${tools.length} 次工具调用`,`${tools.length} tool ${tools.length===1?'call':'calls'}`):''].filter(Boolean)
    const title=running?text(items.at(-1).kind==='reasoning'?'思考中':'正在使用工具',items.at(-1).kind==='reasoning'?'Thinking':'Using tools'):counts.join(' · ')
    const key='activity-group:'+(items[0].key||items[0].seq)
    const body=()=>items.map(item=>item.kind==='reasoning'?reasoning(item):item.kind==='embedded-tool'?tool(item.tool):renderEntry(item.entry)).join('')
    const owner=group.summaryTurn==null?'':` data-activity-turn="${esc(group.summaryTurn)}"`
    return `<details class="chat-activity-group${failed?' is-error':''}${running?' is-running':''}" data-activity-key="${esc(key)}"${owner}><summary><span class="activity-chevron" aria-hidden="true"></span>${icon(thoughts?'reasoning':'tool')}<span class="activity-group-title">${esc(title)}</span></summary>${lazyBody(key,body,'activity-group-body')}</details>`
  }
  function countToolTree(value,counted,id=value?.key){
    if(id!=null){
      if(counted.has(id))return 0
      counted.add(id)
    }
    return 1+(value?.children||[]).reduce((count,child)=>count+countToolTree(child,counted),0)
  }
  function turnHtml({id,duration,thoughts,calls}){
    const facts=[
      thoughts&&text(`${thoughts} 段思考`,`${thoughts} reasoning ${thoughts===1?'block':'blocks'}`),
      calls&&text(`${calls} 次工具调用`,`${calls} tool ${calls===1?'call':'calls'}`),
    ].filter(Boolean)
    const elapsed=duration==null?'':text(`耗时 ${duration} 秒`,`${duration}s elapsed`)
    return `<details class="chat-activity-turn" data-activity-summary="${esc(id)}" data-activity-key="activity-turn:${esc(id)}"><summary><span class="activity-chevron" aria-hidden="true"></span><span class="activity-turn-title">${esc(text('本轮过程','Run details'))}</span>${facts.length?`<span class="activity-turn-facts">${esc(facts.join(' · '))}</span>`:''}${elapsed?`<span class="activity-turn-time">${esc(elapsed)}</span>`:''}</summary></details>`
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
  function continuationHtml(continuation) {
    if (!continuation) return ''
    const label = continuation.pending ? text('正在确认…','Confirming…') : text('继续生成','Continue generating')
    return `<button type="button" class="history-page-control" data-continue-generation="${continuation.ending}"${continuation.pending?' disabled':''}>${esc(label)}</button>`
  }
  function failureHtml(value,attempt=false,continuation) {
    if(!value)return ''
    const message=typeof value==='string'?value:value.message
    const facts=[value.code,value.status?`HTTP ${value.status}`:''].filter(item=>typeof item==='string'&&item)
    return `<div class="chat-runtime-error" role="status"><strong>${esc(text(attempt?'模型请求失败':'运行出错',attempt?'Model request failed':'Run failed'))}</strong><div>${esc(cut(message||text('主机未提供错误详情','The host did not provide error details'),4000))}</div>${facts.length?`<small>${esc(facts.join(' · '))}</small>`:''}${continuationHtml(continuation)}</div>`
  }
  const continuationViews = new WeakMap()
  function withContinuation(box, entries, options) {
    let view = continuationViews.get(box)
    if (!view) {
      view = { histories: new WeakMap(), decorated: new WeakMap() }
      continuationViews.set(box, view)
      box.addEventListener('click', async event => {
        const button = event.target.closest?.('[data-continue-generation]')
        if (!button || !box.contains(button) || button.disabled) return
        const current = view.options, ending = Number(button.dataset.continueGeneration)
        if (!current.valid() || current.ending !== ending) return
        const previous = view.histories.get(current.history)
        if (previous?.ending === ending) return
        const operation = { ending, pending: true }
        view.histories.set(current.history, operation)
        current.render()
        try {
          if (!(await current.submit(ending))?.accepted) throw new Error(text('主机未接受续跑请求','The Host did not accept continuation'))
          operation.pending = false
        } catch (error) {
          if (view.histories.get(current.history) === operation) view.histories.delete(current.history)
          current.failed(error)
        } finally {
          if (current.valid()) current.render()
        }
      })
    }
    view.options = options
    const { ending, history } = options
    if (!Number.isSafeInteger(ending) || ending < 0) return entries
    const operation = view.histories.get(history)
    const pending = operation?.ending === ending && operation.pending
    if (operation?.ending === ending && !pending) return entries
    return entries.map(entry => {
      if (entry.seq !== ending || entry.event?.type !== 'turn/end' || !failure(entry.event)) return entry
      const decorated = view.decorated.get(entry)
      if (decorated?.view.continuation.pending === pending) return decorated
      const row = { ...entry, view: { ...entry.view, continuation: { ending, pending } } }
      view.decorated.set(entry, row)
      return row
    })
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
    const selected = group.items.find(entry => entry.view?.continuation)
    const body = group.items.map(entry => renderEntry(entry === selected ? { ...entry, view: { ...entry.view, continuation: undefined } } : entry)).join('')
    return shell('error','failure-group:'+group.items[0].seq,text(`连续报错 · ${group.count} 条`,`${group.count} consecutive errors`),brief(hint),text('详情','Details'),body,false,true) + continuationHtml(selected?.view.continuation)
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
  const api={hasVisibleText,prepare,tool,toolEvent,isToolEvent,reasoning,reasoningKey,group,groupHtml,turnHtml,failure,failureHtml,groupFailures,failureGroupHtml,attemptHtml,streamNotice,withContinuation,hydrate,renderLazy}
  if(typeof module!=='undefined'&&module.exports)module.exports=api
  else root.DshActivity=api
})(typeof window==='undefined'?globalThis:window)
