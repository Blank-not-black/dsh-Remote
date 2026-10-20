/* Small transport policy and independent fallback channels. No dependencies. */
'use strict';
;(function(root){
  let measuredLatency=0
  const sharedReads=new Map()
  // Bound the whole read (including response bodies), even if WebView fetch
  // does not reject promptly after a network handoff or an abort.
  function readWithDeadline(read,timeoutMs,signal){
    const controller=new AbortController()
    return new Promise((resolve,reject)=>{
      let timer,settled=false
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(error)reject(error);else resolve(value)}
      const cancel=()=>{controller.abort();finish(Object.assign(new Error('Read cancelled'),{name:'AbortError'}))}
      signal?.addEventListener('abort',cancel,{once:true})
      if(signal?.aborted){cancel();return}
      timer=setTimeout(()=>{controller.abort();finish(Object.assign(new Error('Read timed out'),{name:'TimeoutError'}))},timeoutMs)
      try{Promise.resolve(read(controller.signal)).then(value=>finish(null,value),error=>finish(error))}catch(error){finish(error)}
    })
  }
  function shareRead(key,read){
    if(sharedReads.has(key))return sharedReads.get(key)
    const job=Promise.resolve().then(read).finally(()=>{if(sharedReads.get(key)===job)sharedReads.delete(key)})
    sharedReads.set(key,job);return job
  }
  function mode(){try{return ['auto','weak','normal'].includes(root.localStorage.getItem('dshNetworkModeV1'))?root.localStorage.getItem('dshNetworkModeV1'):'auto'}catch{return 'auto'}}
  function profile(){
    const selected=mode(),connection=root.navigator?.connection
    const weak=selected==='weak'||selected==='auto'&&(!!connection?.saveData||/^(slow-2g|2g|3g)$/.test(connection?.effectiveType||'')||connection?.rtt>=500||connection?.downlink>0&&connection.downlink<0.8||measuredLatency>=800)
    return {weak,historyPageSize:weak?20:60,readTimeout:weak?90000:45000,pingTimeout:weak?12000:6000,pollTimeout:weak?45000:30000}
  }
  function setMode(value){if(!['auto','weak','normal'].includes(value))return;try{root.localStorage.setItem('dshNetworkModeV1',value)}catch{};return profile()}
  // 弱网下可选关闭流式输出：只保留已完成的消息与工具结果。
  const STREAM_KEY='dshWeakStreamOff'
  function streamSetting(){try{return root.localStorage.getItem(STREAM_KEY)!=='0'}catch{return true}}
  function streamTrimmed(){return streamSetting()&&profile().weak}
  class PollLoop {
    constructor(options){this.options=options;this.jobs={};this.setTimer=options.setTimer||((fn,ms)=>setTimeout(fn,ms));this.clearTimer=options.clearTimer||(timer=>clearTimeout(timer))}
    stop(){for(const job of Object.values(this.jobs)){job.controller.abort();this.clearTimer(job.timer)}this.jobs={}}
    tick(){
      if(!this.options.active()){this.stop();return Promise.resolve()}
      const pending=[]
      for(const kind of ['mux','host']){
        const previous=this.jobs[kind]
        if(previous?.identity.valid())continue
        previous?.controller.abort();this.clearTimer(previous?.timer)
        const job={identity:this.options.capture(),controller:new AbortController(),failures:0}
        this.jobs[kind]=job;pending.push(this.run(kind,job))
      }
      return Promise.all(pending)
    }
    async run(kind,job){
      let delay
      try{delay=await this.options.read(kind,job.controller.signal)}catch{}
      if(this.jobs[kind]!==job||!job.identity.valid()||!this.options.active()||job.controller.signal.aborted)return
      if(Number.isFinite(delay)){job.failures=0;delay=Math.max(100,delay)}
      else{job.failures++;delay=Math.min(30000,4000*2**Math.min(job.failures-1,3))}
      job.timer=this.setTimer(()=>{job.timer=null;if(this.jobs[kind]===job&&job.identity.valid()&&this.options.active())void this.run(kind,job)},delay)
      job.timer?.unref?.()
    }
  }
  function preferences(){
    const panel=root.document?.getElementById('settings-page-general');if(!panel)return
    const desktop=panel.classList.contains('ds-settings')
    let row=root.document.getElementById('network-preferences')
    if(!row){
      row=root.document.createElement('div');row.id='network-preferences';row.className=desktop?'ds-setting-row':'setting-row'
      const copy=root.document.createElement('div'),title=root.document.createElement('div'),detail=root.document.createElement('div'),select=root.document.createElement('select')
      title.dataset.networkTitle='';detail.dataset.networkDetail='';title.className=desktop?'ds-setting-name':'setting-name';detail.className=desktop?'ds-setting-desc':'setting-desc';select.id='network-mode';select.className='setting-select'
      for(const value of ['auto','weak','normal']){const option=root.document.createElement('option');option.value=value;select.append(option)}
      copy.append(title,detail);row.append(copy,select)
      const target=panel.querySelector('[data-workflow-settings-slot="input"]')||panel
      target.append(row)
      const section=target.closest?.('.workflow-settings-section');if(section)section.hidden=false
      select.addEventListener('change',()=>{setMode(select.value);root.applyStreamPreference?.();root.enhanceCustomSelect?.(select)})
    }
    let streamRow=root.document.getElementById('network-stream-preferences')
    if(!streamRow){
      streamRow=root.document.createElement('div');streamRow.id='network-stream-preferences';streamRow.className=desktop?'ds-setting-row':'setting-row'
      const copy=root.document.createElement('div'),title=root.document.createElement('div'),detail=root.document.createElement('div'),label=root.document.createElement('label'),input=root.document.createElement('input'),slider=root.document.createElement('span')
      title.dataset.streamTitle='';detail.dataset.streamDetail='';title.className=desktop?'ds-setting-name':'setting-name';detail.className=desktop?'ds-setting-desc':'setting-desc'
      input.type='checkbox';input.id='opt-weak-stream-off';label.className=desktop?'ds-switch':'switch';slider.className=desktop?'ds-slider':'slider'
      label.append(input,slider);copy.append(title,detail);streamRow.append(copy,label)
      const target=panel.querySelector('[data-workflow-settings-slot="input"]')||panel
      target.append(streamRow)
      const section=target.closest?.('.workflow-settings-section');if(section)section.hidden=false
      input.addEventListener('change',()=>{try{root.localStorage.setItem(STREAM_KEY,input.checked?'1':'0')}catch{};root.applyStreamPreference?.()})
    }
    const english=root.I18N?.lang==='en'
    row.querySelector('[data-network-title]').textContent=english?'Network mode':'网络模式'
    row.querySelector('[data-network-detail]').textContent=english?'Weak mode loads fewer history entries and allows longer read waits. Sending is never retried automatically.':'弱网模式减少每页历史条数、延长读取等待；发送操作不会自动重试。'
    const select=row.querySelector('select');select.setAttribute('aria-label',english?'Network mode':'网络模式');['auto','weak','normal'].forEach((v,i)=>select.options[i].textContent=(english?['Automatic','Weak network','Standard']:['自动判断','弱网优先','标准模式'])[i]);select.value=mode();root.enhanceCustomSelect?.(select);root.syncCustomSelect?.(select)
    const streamInput=streamRow.querySelector('input');if(streamInput){streamInput.checked=streamSetting();streamInput.setAttribute('aria-label',english?'Disable streaming on weak networks':'弱网时关闭流式输出')}
    const streamTitle=streamRow.querySelector('[data-stream-title]'),streamDetail=streamRow.querySelector('[data-stream-detail]')
    if(streamTitle)streamTitle.textContent=english?'No streaming on weak networks':'弱网时关闭流式输出'
    if(streamDetail)streamDetail.textContent=english?'Show only finished messages and tool results on weak networks; live thinking and calls that have not returned stay hidden.':'弱网下只显示已完成的消息和工具结果，隐藏流式思考和尚未返回的工具调用；标准网络不受影响。'
  }
  const api={profile,setMode,PollLoop,shareRead,readWithDeadline,observeLatency:ms=>{if(Number.isFinite(ms))measuredLatency=ms},preferences,streamTrimmed}
  if(typeof module!=='undefined'&&module.exports)module.exports=api
  else{root.DshNetwork=api;root.document.addEventListener('DOMContentLoaded',()=>{preferences();new MutationObserver(preferences).observe(root.document.documentElement,{attributes:true,attributeFilter:['lang']})})}
})(typeof window==='undefined'?globalThis:window)
