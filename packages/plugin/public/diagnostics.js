/* Bounded support evidence. No message bodies, credentials or dependencies. */
'use strict'
function createDiagnosticSchema() {
  const MAX_EVENTS=160,MAX_CRITICAL=40,MAX_BYTES=48000
  const kinds=new Set(['rpc','history.load','history.cache','history.render','history.row','session.open','session.back','stream.state','stream.retry','poll.state','client.lifecycle','client.error','feedback.submit','announcement.storage','announcement.fetch','announcement.show','announcement.close','announcement.vote','storage.write','diagnostics.persist'])
  const enums={phase:['start','response','prepared','rendered','complete','failed','navigate','cleanup','hit','miss','retry'],channel:['mux','host'],status:['open','closed','connecting','poll','ws','visible','hidden','online','offline','running','stopped','starting','disabled','start-failed','timeout','error','unknown','granted','denied','default'],category:['authentication','timeout','network','render','syntax','upstream','unknown'],errorName:['Error','TypeError','RangeError','SyntaxError','ReferenceError','AbortError','TimeoutError','NetworkError']}
  enums.serviceState=['starting','running','stopped','disabled','start-failed','system-timeout','auth-expired']
  enums.storageKey=['seen','history','votes']
  enums.storageBackend=['session','memory']
  enums.storageBackend.push('local','indexeddb')
  enums.storageKey.push('settings','session-list','diagnostics','approvals','receipts')
  enums.phase.push('received','shown','dismissed','acknowledged','skipped')
  enums.category.push('storage','validation')
  enums.errorName.push('QuotaExceededError','SecurityError','InvalidStateError','DataError','UnknownError')
  enums.reason=['already-open','already-read','version-warning','empty','http','network','invalid-json','too-large','unavailable']
  const numbers=['durationMs','httpStatus','closeCode','attempt','delayMs','count','rawCount','renderedCount','renderErrors','lastSuccessAt','intervalMin','apiLevel','storageChars','storageKeys','legacyCacheChars','legacyCacheKeys','historyCacheChars','sessionCacheChars','announcementChars','diagnosticChars','droppedEvents']
  const booleans=['reset','cached','loading','loaded','hasMore','online','enabled','serviceRunning','loginExpired','powerSave','ignoreBatteryOptimizations','notificationsEnabled','persisted','indexedDbAvailable','storageAvailable']
  const methods=new Set(['session.list','session.history','session.create','session.prompt','session.fork','session.cancel','session.rename','session.selectModel','session.updateQueue','session.getModels','session.getQueue','session.getCompactionStatus','workspace.list','workspace.create','workspace.archiveSession','host.describe','subagent.list','subagent.interrupt','goal.edit','goal.pause','goal.resume','goal.complete','goal.clear'])
  for(const method of ['session.models','llm.discoverModels','llm.providers','credentials.describe','credentials.set','credentials.unset','settings.describe','settings.mutate','settings.openDocument'])methods.add(method)
  const hex=(v,n)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v)?v:undefined
  const version=v=>typeof v==='string'&&/^\d+\.\d+\.\d+(?:[.-][a-zA-Z0-9.-]{1,30})?$/.test(v)?v:'unknown'
  function facts(input={}) {
    const out={}
    for(const [key,values]of Object.entries(enums))if(values.includes(input[key]))out[key]=input[key]
    for(const key of numbers)if(typeof input[key]==='number'&&Number.isFinite(input[key])&&input[key]>=0)out[key]=Math.min(input[key],Number.MAX_SAFE_INTEGER)
    for(const key of booleans)if(typeof input[key]==='boolean')out[key]=input[key]
    if(methods.has(input.method))out.method=input.method
    for(const key of ['sessionRef','serverRef','announcementRef'])if(hex(input[key],16))out[key]=input[key]
    if(hex(input.traceId,24))out.traceId=input.traceId
    if(Array.isArray(input.frames))out.frames=input.frames.slice(0,3).filter(f=>['app.js','desktop.js','history.js','activity.js','turn-results.js','network.js','operations.js','diagnostics.js'].includes(f?.file)&&Number.isSafeInteger(f.line)&&f.line>0&&Number.isSafeInteger(f.column)&&f.column>0).map(f=>({file:f.file,line:f.line,column:f.column}))
    return out
  }
  const critical=row=>row.kind==='client.error'||row.phase==='failed'
  function retain(events) {
    const errors=events.filter(critical).slice(-MAX_CRITICAL),keep=new Set([...events.slice(-(MAX_EVENTS-errors.length)),...errors])
    return events.filter(row=>keep.has(row))
  }
  function shrink(events,budget) {
    while(events.length&&JSON.stringify(events).length>budget){const index=events.findIndex(row=>!critical(row));events.splice(index<0?0:index,1)}
    return events
  }
  function sanitizeReport(input) {
    if(!input||input.schema!==1||!Array.isArray(input.events))return null
    const report={schema:1,reportId:hex(input.reportId,24)||'000000000000000000000000',capturedAt:typeof input.capturedAt==='number'&&Number.isFinite(input.capturedAt)?input.capturedAt:0,
      client:{version:version(input.client?.version),buildId:hex(input.client?.buildId,64)||'unknown',surface:['mobile','desktop'].includes(input.client?.surface)?input.client.surface:'mobile'},
      snapshot:facts(input.snapshot),events:[]}
    for(const item of input.events)if(item&&kinds.has(item.kind)&&typeof item.at==='number'&&Number.isFinite(item.at))report.events.push({at:item.at,kind:item.kind,...facts(item)})
    report.events=retain(report.events)
    if(input.persistence&&typeof input.persistence==='object'){
      report.persistence={}
      for(const key of ['local','session','indexeddb'])if(['unknown','saved','failed','unavailable','pending'].includes(input.persistence[key]))report.persistence[key]=input.persistence[key]
    }
    while(JSON.stringify(report).length>MAX_BYTES&&report.events.length){const index=report.events.findIndex(row=>!critical(row));report.events.splice(index<0?0:index,1)}
    return report
  }
  return {MAX_EVENTS,MAX_CRITICAL,MAX_BYTES,kinds,facts,sanitizeReport,retain,shrink,
    definition:{MAX_EVENTS,MAX_CRITICAL,MAX_BYTES,kinds:[...kinds],enums,numbers,booleans,methods:[...methods]}}
}
;(function(root){
  const schema=createDiagnosticSchema()
  function createDiagnostics(env) {
    const KEY='dshRemoteDiagnosticsV1',SALT_KEY=KEY+'Salt',MAX_AGE=86400000
    let rows=[],timer,config={},metadata={},sequence=0,sheet,exportTimer,droppedEvents=0,epoch=0
    let database,backupJob,pendingBackup,storageAt=0,storageInventory={}
    const persistence={local:'unknown',session:'unknown',indexeddb:'unknown'}
    const random=()=>{const bytes=new Uint8Array(12);env.crypto?.getRandomValues?.(bytes);return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')}
    let salt=random(),run=random()
    try{salt=env.localStorage.getItem(SALT_KEY)||salt;env.localStorage.setItem(SALT_KEY,salt)}catch{}
    for(const storage of [env.localStorage,env.sessionStorage])try{const saved=schema.sanitizeReport(JSON.parse(storage.getItem(KEY)||'null'));if(saved)rows.push(...saved.events)}catch{}
    rows=[...new Map(rows.map(row=>[JSON.stringify(row),row])).values()].sort((a,b)=>a.at-b.at)
    const now=()=>Date.now()
    const pseudonym=value=>{if(!value||!env.SHA256)return undefined;try{return new env.SHA256().update(new TextEncoder().encode(salt+'\0'+value)).hex().slice(0,16)}catch{return undefined}}
    const trim=()=>{const before=rows.length;rows=schema.shrink(schema.retain(rows.filter(row=>row.at>now()-MAX_AGE&&row.at<=now()+60000)),schema.MAX_BYTES-3000);droppedEvents+=before-rows.length}
    function storageFacts(force=false){
      if(!force&&storageAt&&now()-storageAt<30000)return storageInventory
      const value={storageChars:0,storageKeys:0,legacyCacheChars:0,legacyCacheKeys:0,historyCacheChars:0,sessionCacheChars:0,announcementChars:0,diagnosticChars:0,indexedDbAvailable:!!env.indexedDB,storageAvailable:false}
      try{const storage=env.localStorage;if(typeof storage.length!=='number')throw Error('storage unavailable');for(let i=0;i<storage.length;i++){
        const key=storage.key(i),size=key.length+(storage.getItem(key)||'').length;value.storageKeys++;value.storageChars+=size
        if(/^historyCache/.test(key)){value.historyCacheChars+=size;if(!key.includes(':session:')&&!key.endsWith(':cache-index')){value.legacyCacheChars+=size;value.legacyCacheKeys++}}
        else if(/^sessionsCache/.test(key))value.sessionCacheChars+=size
        else if(/^(?:seenAnnouncements|announcementHistory|announcementVotes)V1$/.test(key))value.announcementChars+=size
        else if(key===KEY)value.diagnosticChars+=size
      }value.storageAvailable=true}catch{}
      storageAt=now();storageInventory=value;return value
    }
    function snapshot(force=false){let value={};try{value=config.snapshot?.()||{}}catch{};return schema.facts({...value,...storageFacts(force),droppedEvents,sessionRef:pseudonym(value.sessionId),serverRef:pseudonym(value.server||env.location?.origin),online:env.navigator?.onLine!==false})}
    function makeReport(force=false){trim();return schema.sanitizeReport({schema:1,reportId:random(),capturedAt:now(),client:{...metadata,surface:config.surface||'mobile'},snapshot:snapshot(force),persistence,events:rows})}
    const report=()=>makeReport(true)
    function openDatabase(){
      if(database)return database
      if(!env.indexedDB)return Promise.resolve(null)
      database=new Promise(resolve=>{
        let settled=false,request
        const done=value=>{if(settled){value?.close();return}settled=true;env.clearTimeout?.(deadline);resolve(value)}
        const deadline=env.setTimeout?.(()=>done(null),1500)
        try{request=env.indexedDB.open('dshRemoteDiagnosticsV1',1);request.onupgradeneeded=()=>request.result.createObjectStore('reports')
          request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();database=null};done(request.result)}
          request.onerror=request.onblocked=()=>done(null)
        }catch{done(null)}
      })
      return database
    }
    function transaction(db,mode,value){return new Promise(resolve=>{
      let tx,result,settled=false
      const done=value=>{if(settled)return;settled=true;env.clearTimeout?.(deadline);resolve(value)}
      const deadline=env.setTimeout?.(()=>{done({ok:false,error:{name:'TimeoutError'}});try{tx?.abort()}catch{}},2000)
      try{tx=db.transaction('reports',mode);const store=tx.objectStore('reports'),request=mode==='readonly'?store.get('latest'):store.put(value,'latest')
        request.onsuccess=()=>{result=request.result}
        tx.oncomplete=()=>done({ok:true,value:result});tx.onerror=tx.onabort=()=>done({ok:false,error:tx.error||{name:'UnknownError'}})
      }catch(error){done({ok:false,error})}
    })}
    function persistFailure(backend,error){rows.push({at:now(),kind:'diagnostics.persist',phase:'failed',storageBackend:backend,...errorFacts(error)});trim()}
    const restoredEpoch=epoch
    const ready=openDatabase().then(async db=>{
      if(!db){persistence.indexeddb='unavailable';return}
      const saved=await transaction(db,'readonly')
      if(saved.ok&&restoredEpoch===epoch){const previous=schema.sanitizeReport(saved.value),unique=new Map();for(const row of [...(previous?.events||[]),...rows])unique.set(JSON.stringify(row),row);rows=[...unique.values()].sort((a,b)=>a.at-b.at);trim()}
    }).catch(()=>{persistence.indexeddb='failed'})
    function backup(value){
      pendingBackup=value
      if(!backupJob)backupJob=(async()=>{
        await ready;const db=await openDatabase()
        if(!db){pendingBackup=null;persistence.indexeddb='unavailable';return}
        while(pendingBackup){const value=makeReport();pendingBackup=null;const result=await transaction(db,'readwrite',value),previous=persistence.indexeddb;persistence.indexeddb=result.ok?'saved':'failed'
          if(!result.ok&&previous!=='failed'){persistFailure('indexeddb',result.error);flush(false)}
        }
      })().catch(()=>{persistence.indexeddb='failed'}).finally(()=>{backupJob=null})
      return backupJob
    }
    function flush(withBackup=true){
      if(timer)env.clearTimeout?.(timer);timer=null
      const previous=persistence.local
      try{persistence.local='saved';const value=JSON.stringify(makeReport());env.localStorage.setItem(KEY,value);if(env.localStorage.getItem(KEY)!==value)throw Error('storage write unconfirmed');persistence.session='unknown';try{env.sessionStorage?.removeItem(KEY)}catch{}}
      catch(error){persistence.local='failed';if(previous!=='failed')persistFailure('local',error)
        try{persistence.session='saved';env.sessionStorage.setItem(KEY,JSON.stringify(makeReport()))}catch{persistence.session=env.sessionStorage?'failed':'unavailable'}
      }
      return withBackup?backup(makeReport()):Promise.resolve()
    }
    function record(kind,fields={}) {
      if(!schema.kinds.has(kind))return
      const row={at:now(),kind,...schema.facts({...fields,sessionRef:fields.sessionRef||pseudonym(fields.sessionId),serverRef:fields.serverRef||pseudonym(fields.server||env.location?.origin),announcementRef:fields.announcementRef||pseudonym(fields.announcementId)})};rows.push(row);trim()
      if(fields.phase==='failed'||kind==='client.error'||fields.phase==='start'&&['session.open','session.back','history.load','history.render','history.cache'].includes(kind))flush()
      else if(!timer)timer=env.setTimeout?.(flush,500)
      return row
    }
    function errorFacts(error){
      const message=typeof error==='string'?error:String(error?.message||''),category=/quota|storage|indexeddb/i.test(message+' '+error?.name)?'storage':/auth|ticket|401|403/i.test(message)?'authentication':/timeout|abort/i.test(message+' '+error?.name)?'timeout':/network|fetch|socket/i.test(message)?'network':/invalid.*payload|validation|schema/i.test(message)?'validation':error?.name==='SyntaxError'?'syntax':'unknown',frames=[]
      for(const line of String(error?.stack||'').split('\n').slice(1,8)){const match=line.match(/(?:[/\\])(app|desktop|history|activity|turn-results|network|operations|diagnostics)\.js(?:\?[^\s:]*)?:(\d+):(\d+)\)?$/);if(match)frames.push({file:match[1]+'.js',line:Number(match[2]),column:Number(match[3])})}
      return schema.facts({category,errorName:error?.name,frames,...(/^HTTP \d{3}$/.test(message)?{httpStatus:Number(message.slice(5))}:{})})
    }
    function start(kind,fields={}){const begun=now(),traceId=run.slice(0,12)+(++sequence).toString(16).padStart(12,'0');record(kind,{...fields,phase:'start',traceId});return {traceId,end:value=>record(kind,{...fields,...value,traceId,durationMs:now()-begun}),fail:error=>record(kind,{...fields,...errorFacts(error),phase:'failed',traceId,durationMs:now()-begun})}}
    function nativeSnapshot(){try{const value=JSON.parse(env.NativeBackground?.getBackgroundConfig?.()||'{}');return schema.facts({...value,httpStatus:value.lastHttpStatus})}catch{return {}}}
    function configure(value){config=value;record('client.lifecycle',{status:env.document?.visibilityState==='hidden'?'hidden':'visible',...nativeSnapshot()});mount()}
    function clear(){epoch++;rows=[];droppedEvents=0;flush();refreshPreview()}
    function storageFailure(key,error,backend='local'){const category=/^historyCache/.test(key)?'history':/^sessionsCache/.test(key)?'session-list':key==='seenAnnouncementsV1'?'seen':key==='announcementHistoryV1'?'history':key==='announcementVotesV1'?'votes':/^dshApprovalRecordsV1/.test(key)?'approvals':'settings';storageFacts(true);return record('storage.write',{phase:'failed',storageKey:category,storageBackend:backend,...errorFacts(error)})}
    function text(){return JSON.stringify(report(),null,2)}
    const label=(zh,en)=>env.I18N?.lang==='en'?en:zh
    const $=id=>env.document?.getElementById(id)
    function refreshPreview(){const node=$('fb-client-log-preview');if(node)node.textContent=text()}
    function exportStatus(attempt=0){
      const status=$('fb-client-log-status');let phase='error'
      try{phase=env.NativeFile.getDiagnosticExportStatus()}catch{}
      if(status)status.textContent=phase==='saved'?label('日志已保存','Report saved'):phase==='cancelled'?label('已取消保存','Save cancelled'):phase==='picking'?label('请在系统文件选择器中保存日志','Save the report in the system file picker'):label('导出失败，请复制日志。','Export failed. Copy the report instead.')
      if(phase==='picking'&&attempt<120)exportTimer=env.setTimeout(()=>exportStatus(attempt+1),1000)
    }
    function download(){try{
      if(env.NativeFile?.exportDiagnostics){if(!env.NativeFile.exportDiagnostics(text()))throw Error('export unavailable');if(exportTimer)env.clearTimeout(exportTimer);exportStatus();return}
      if(env.NativeBackground)throw Error('native export unavailable')
      const blob=new env.Blob([text()],{type:'application/json'}),url=env.URL.createObjectURL(blob),a=env.document.createElement('a');a.href=url;a.download='dsh-diagnostics-'+now()+'.json';env.document.body.append(a);a.click();a.remove();env.setTimeout(()=>env.URL.revokeObjectURL(url),1000)
    }catch{const status=$('fb-client-log-status');if(status)status.textContent=label('导出失败，请复制日志。','Export failed. Copy the report instead.')}}
    function show(){if(!sheet)return;const status=$('fb-client-log-status');if(status)status.textContent='';refreshPreview();$('fb-client-log-details').open=true;if(!sheet.open)sheet.showModal()}
    function mount(){
      const details=$('fb-client-log-details');if(!details||details.dataset.bound)return;details.dataset.bound='1'
      const panel=details.closest('.client-diagnostics'),entry=env.document.createElement('button');entry.type='button';entry.className='workflow-button';entry.dataset.logLabel='entry';panel.parentNode.insertBefore(entry,panel);entry.addEventListener('click',show)
      sheet=env.document.createElement('dialog');sheet.className='client-log-dialog';sheet.setAttribute('aria-labelledby','client-log-title')
      const head=env.document.createElement('div');head.className='client-log-head';const title=env.document.createElement('h2');title.id='client-log-title';title.dataset.logLabel='title';const close=env.document.createElement('button');close.type='button';close.dataset.logLabel='close';close.addEventListener('click',()=>sheet.close());head.append(title,close);sheet.append(head,panel);env.document.body.append(sheet)
      const labels={entry:['查看本地操作日志','View local operation logs'],title:['本地操作日志','Local operation logs'],close:['关闭','Close'],privacy:['操作日志默认保存在此设备。提交反馈时勾选诊断选项可附带脱敏日志，也可复制或导出。','Logs stay on this device by default. Select diagnostics when submitting feedback to attach a sanitized report, or copy/export it.'],details:['查看详细记录','View detailed records'],refresh:['刷新预览','Refresh preview'],copy:['复制日志','Copy report'],export:['导出日志','Export report'],clear:['清除日志','Clear report']}
      const translate=()=>{for(const node of env.document.querySelectorAll('[data-log-label]')){const pair=labels[node.dataset.logLabel];if(pair)node.textContent=label(...pair)}}
      translate();if(env.MutationObserver)new env.MutationObserver(translate).observe(env.document.documentElement,{attributes:true,attributeFilter:['lang']})
      details.addEventListener('toggle',()=>{if(details.open)refreshPreview()})
      $('fb-log-preview')?.addEventListener('click',refreshPreview)
      $('fb-log-copy')?.addEventListener('click',async()=>{const status=$('fb-client-log-status');let ok=false;try{ok=!!await config.copy?.(text())}catch{};if(status)status.textContent=ok?label('已复制脱敏日志','Report copied'):label('复制失败，请导出日志。','Copy failed. Export the report instead.')})
      $('fb-log-export')?.addEventListener('click',download)
      $('fb-log-clear')?.addEventListener('click',clear)
    }
    env.addEventListener?.('error',event=>{
      const facts=errorFacts(event.error||event.message),file=String(event.filename||'').split(/[\\/]/).at(-1).split('?')[0]
      if(!facts.frames?.length&&['app.js','desktop.js','history.js','activity.js','turn-results.js','network.js','operations.js','diagnostics.js'].includes(file)&&Number.isSafeInteger(event.lineno)&&event.lineno>0&&Number.isSafeInteger(event.colno)&&event.colno>0)facts.frames=[{file,line:event.lineno,column:event.colno}]
      record('client.error',{...facts,phase:'failed'})
    })
    env.addEventListener?.('unhandledrejection',event=>record('client.error',{...errorFacts(event.reason),phase:'failed'}))
    for(const status of ['online','offline'])env.addEventListener?.(status,()=>record('client.lifecycle',{status,online:status==='online'}))
    env.document?.addEventListener('visibilitychange',()=>{record('client.lifecycle',{status:env.document.visibilityState==='visible'?'visible':'hidden',...nativeSnapshot()});flush()})
    env.addEventListener?.('pagehide',flush)
    function build(value){metadata={version:value?.version,buildId:value?.buildId}}
    return {record,start,errorFacts,report,text,flush,clear,configure,show,download,build,nativeSnapshot,storageFailure,storageFacts,ready}
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={createDiagnostics,createDiagnosticSchema}
  else {
    root.DshDiagnostics=createDiagnostics(root)
    try{const url=new URL('build.json',root.document.currentScript.src);void root.fetch(url,{cache:'no-store',signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():{}).then(value=>root.DshDiagnostics.build(value)).catch(()=>{})}catch{}
  }
})(typeof window==='undefined'?globalThis:window)
