/* Device-local operation evidence. No message bodies, uploads or dependencies. */
'use strict'
function createDiagnosticSchema() {
  const MAX_EVENTS=160,MAX_BYTES=48000
  const kinds=new Set(['rpc','history.load','history.cache','history.render','history.row','session.open','session.back','stream.state','stream.retry','poll.state','client.lifecycle','client.error','feedback.submit'])
  const enums={phase:['start','response','prepared','rendered','complete','failed','navigate','cleanup','hit','miss','retry'],channel:['mux','host'],status:['open','closed','connecting','poll','ws','visible','hidden','online','offline','running','stopped','starting','disabled','start-failed','timeout','error','unknown','granted','denied','default'],category:['authentication','timeout','network','render','syntax','upstream','unknown'],errorName:['Error','TypeError','RangeError','SyntaxError','ReferenceError','AbortError','TimeoutError','NetworkError']}
  enums.serviceState=['starting','running','stopped','disabled','start-failed','system-timeout','auth-expired']
  const numbers=['durationMs','httpStatus','closeCode','attempt','delayMs','count','rawCount','renderedCount','renderErrors','lastSuccessAt','intervalMin','apiLevel']
  const booleans=['reset','cached','loading','loaded','hasMore','online','enabled','serviceRunning','loginExpired','powerSave','ignoreBatteryOptimizations','notificationsEnabled']
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
    for(const key of ['sessionRef','serverRef'])if(hex(input[key],16))out[key]=input[key]
    if(hex(input.traceId,24))out.traceId=input.traceId
    if(Array.isArray(input.frames))out.frames=input.frames.slice(0,3).filter(f=>['app.js','desktop.js','history.js','activity.js','turn-results.js','network.js','operations.js','diagnostics.js'].includes(f?.file)&&Number.isSafeInteger(f.line)&&f.line>0&&Number.isSafeInteger(f.column)&&f.column>0).map(f=>({file:f.file,line:f.line,column:f.column}))
    return out
  }
  function sanitizeReport(input) {
    if(!input||input.schema!==1||!Array.isArray(input.events))return null
    const report={schema:1,reportId:hex(input.reportId,24)||'000000000000000000000000',capturedAt:typeof input.capturedAt==='number'&&Number.isFinite(input.capturedAt)?input.capturedAt:0,
      client:{version:version(input.client?.version),buildId:hex(input.client?.buildId,64)||'unknown',surface:['mobile','desktop'].includes(input.client?.surface)?input.client.surface:'mobile'},
      snapshot:facts(input.snapshot),events:[]}
    for(const item of input.events.slice(-MAX_EVENTS))if(item&&kinds.has(item.kind)&&typeof item.at==='number'&&Number.isFinite(item.at))report.events.push({at:item.at,kind:item.kind,...facts(item)})
    while(JSON.stringify(report).length>MAX_BYTES&&report.events.length)report.events.shift()
    return report
  }
  return {MAX_EVENTS,MAX_BYTES,kinds,facts,sanitizeReport}
}
;(function(root){
  const schema=createDiagnosticSchema()
  function createDiagnostics(env) {
    const KEY='dshRemoteDiagnosticsV1',SALT_KEY=KEY+'Salt',MAX_AGE=86400000
    let rows=[],timer,config={},metadata={},sequence=0,sheet,exportTimer
    const random=()=>{const bytes=new Uint8Array(12);env.crypto?.getRandomValues?.(bytes);return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('')}
    let salt=random(),run=random()
    try{salt=env.localStorage.getItem(SALT_KEY)||salt;env.localStorage.setItem(SALT_KEY,salt);const saved=JSON.parse(env.localStorage.getItem(KEY)||'null');rows=schema.sanitizeReport(saved)?.events||[]}catch{}
    const now=()=>Date.now()
    const pseudonym=value=>{if(!value||!env.SHA256)return undefined;try{return new env.SHA256().update(new TextEncoder().encode(salt+'\0'+value)).hex().slice(0,16)}catch{return undefined}}
    const trim=()=>{rows=rows.filter(row=>row.at>now()-MAX_AGE&&row.at<=now()+60000).slice(-schema.MAX_EVENTS);while(JSON.stringify(rows).length>schema.MAX_BYTES-3000)rows.shift()}
    function snapshot(){let value={};try{value=config.snapshot?.()||{}}catch{};return schema.facts({...value,sessionRef:pseudonym(value.sessionId),serverRef:pseudonym(value.server||env.location?.origin),online:env.navigator?.onLine!==false})}
    function report(){trim();return schema.sanitizeReport({schema:1,reportId:random(),capturedAt:now(),client:{...metadata,surface:config.surface||'mobile'},snapshot:snapshot(),events:rows})}
    function flush(){if(timer)env.clearTimeout?.(timer);timer=null;try{env.localStorage.setItem(KEY,JSON.stringify(report()))}catch{}}
    function record(kind,fields={}) {
      if(!schema.kinds.has(kind))return
      const row={at:now(),kind,...schema.facts({...fields,sessionRef:fields.sessionRef||pseudonym(fields.sessionId),serverRef:fields.serverRef||pseudonym(fields.server||env.location?.origin)})};rows.push(row);trim()
      if(fields.phase==='failed'||kind==='client.error'||fields.phase==='start'&&['session.open','session.back','history.load','history.render','history.cache'].includes(kind))flush()
      else if(!timer)timer=env.setTimeout?.(flush,500)
      return row
    }
    function errorFacts(error){
      const message=String(error?.message||''),category=/auth|ticket|401|403/i.test(message)?'authentication':/timeout|abort/i.test(message+' '+error?.name)?'timeout':/network|fetch|socket/i.test(message)?'network':error?.name==='SyntaxError'?'syntax':'unknown',frames=[]
      for(const line of String(error?.stack||'').split('\n').slice(1,8)){const match=line.match(/(?:[/\\])(app|desktop|history|activity|turn-results|network|operations|diagnostics)\.js(?:\?[^\s:]*)?:(\d+):(\d+)\)?$/);if(match)frames.push({file:match[1]+'.js',line:Number(match[2]),column:Number(match[3])})}
      return schema.facts({category,errorName:error?.name,frames,...(/^HTTP \d{3}$/.test(message)?{httpStatus:Number(message.slice(5))}:{})})
    }
    function start(kind,fields={}){const begun=now(),traceId=run.slice(0,12)+(++sequence).toString(16).padStart(12,'0');record(kind,{...fields,phase:'start',traceId});return {traceId,end:value=>record(kind,{...fields,...value,traceId,durationMs:now()-begun}),fail:error=>record(kind,{...fields,...errorFacts(error),phase:'failed',traceId,durationMs:now()-begun})}}
    function nativeSnapshot(){try{const value=JSON.parse(env.NativeBackground?.getBackgroundConfig?.()||'{}');return schema.facts({...value,httpStatus:value.lastHttpStatus})}catch{return {}}}
    function configure(value){config=value;record('client.lifecycle',{status:env.document?.visibilityState==='hidden'?'hidden':'visible',...nativeSnapshot()});mount()}
    function clear(){rows=[];flush();refreshPreview()}
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
      const labels={entry:['查看本地操作日志','View local operation logs'],title:['本地操作日志','Local operation logs'],close:['关闭','Close'],privacy:['操作日志仅保存在此设备，记录操作阶段、耗时、错误位置与连接状态。可复制或导出后自行反馈。','Operation logs stay on this device and include stages, durations, error locations and connection status. Copy or export them to share feedback yourself.'],details:['查看详细记录','View detailed records'],refresh:['刷新预览','Refresh preview'],copy:['复制日志','Copy report'],export:['导出日志','Export report'],clear:['清除日志','Clear report']}
      const translate=()=>{for(const node of env.document.querySelectorAll('[data-log-label]')){const pair=labels[node.dataset.logLabel];if(pair)node.textContent=label(...pair)}}
      translate();if(env.MutationObserver)new env.MutationObserver(translate).observe(env.document.documentElement,{attributes:true,attributeFilter:['lang']})
      details.addEventListener('toggle',()=>{if(details.open)refreshPreview()})
      $('fb-log-preview')?.addEventListener('click',refreshPreview)
      $('fb-log-copy')?.addEventListener('click',async()=>{const status=$('fb-client-log-status');let ok=false;try{ok=!!await config.copy?.(text())}catch{};if(status)status.textContent=ok?label('已复制脱敏日志','Report copied'):label('复制失败，请导出日志。','Copy failed. Export the report instead.')})
      $('fb-log-export')?.addEventListener('click',download)
      $('fb-log-clear')?.addEventListener('click',clear)
    }
    env.addEventListener?.('error',event=>record('client.error',{...errorFacts(event.error),phase:'failed'}))
    env.addEventListener?.('unhandledrejection',event=>record('client.error',{...errorFacts(event.reason),phase:'failed'}))
    for(const status of ['online','offline'])env.addEventListener?.(status,()=>record('client.lifecycle',{status,online:status==='online'}))
    env.document?.addEventListener('visibilitychange',()=>{record('client.lifecycle',{status:env.document.visibilityState==='visible'?'visible':'hidden',...nativeSnapshot()});flush()})
    env.addEventListener?.('pagehide',flush)
    function build(value){metadata={version:value?.version,buildId:value?.buildId}}
    return {record,start,errorFacts,report,text,flush,clear,configure,show,download,build,nativeSnapshot}
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={createDiagnostics,createDiagnosticSchema}
  else {
    root.DshDiagnostics=createDiagnostics(root)
    try{const url=new URL('build.json',root.document.currentScript.src);void root.fetch(url,{cache:'no-store',signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():{}).then(value=>root.DshDiagnostics.build(value)).catch(()=>{})}catch{}
  }
})(typeof window==='undefined'?globalThis:window)
