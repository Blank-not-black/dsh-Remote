/* Small transport policy and independent fallback channels. No dependencies. */
'use strict';
;(function(root){
  let measuredLatency=0
  function mode(){try{return ['auto','weak','normal'].includes(root.localStorage.getItem('dshNetworkModeV1'))?root.localStorage.getItem('dshNetworkModeV1'):'auto'}catch{return 'auto'}}
  function profile(){
    const selected=mode(),connection=root.navigator?.connection
    const weak=selected==='weak'||selected==='auto'&&(!!connection?.saveData||/^(slow-2g|2g|3g)$/.test(connection?.effectiveType||'')||connection?.rtt>=500||connection?.downlink>0&&connection.downlink<0.8||measuredLatency>=800)
    return {weak,historyPageSize:weak?20:60,readTimeout:weak?90000:45000,pingTimeout:weak?12000:6000,pollTimeout:weak?45000:30000}
  }
  function setMode(value){if(!['auto','weak','normal'].includes(value))return;try{root.localStorage.setItem('dshNetworkModeV1',value)}catch{};return profile()}
  class PollLoop {
    constructor(options){this.options=options;this.jobs={};this.setTimer=options.setTimer||setTimeout;this.clearTimer=options.clearTimer||clearTimeout}
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
    let row=root.document.getElementById('network-preferences')
    if(!row){
      row=root.document.createElement('div');row.id='network-preferences';row.className=panel.classList.contains('ds-settings')?'ds-setting-row':'setting-row'
      const copy=root.document.createElement('div'),title=root.document.createElement('div'),detail=root.document.createElement('div'),select=root.document.createElement('select')
      title.dataset.networkTitle='';detail.dataset.networkDetail='';detail.className='muted';select.id='network-mode';select.className='setting-select'
      for(const value of ['auto','weak','normal']){const option=root.document.createElement('option');option.value=value;select.append(option)}
      copy.append(title,detail);row.append(copy,select);panel.append(row)
      select.addEventListener('change',()=>{setMode(select.value);root.enhanceCustomSelect?.(select)})
    }
    const english=root.I18N?.lang==='en'
    row.querySelector('[data-network-title]').textContent=english?'Network mode':'网络模式'
    row.querySelector('[data-network-detail]').textContent=english?'Weak mode loads fewer history entries and allows longer read waits. Sending is never retried automatically.':'弱网模式减少每页历史条数、延长读取等待；发送操作不会自动重试。'
    const select=row.querySelector('select');select.setAttribute('aria-label',english?'Network mode':'网络模式');['auto','weak','normal'].forEach((v,i)=>select.options[i].textContent=(english?['Automatic','Weak network','Standard']:['自动判断','弱网优先','标准模式'])[i]);select.value=mode();root.enhanceCustomSelect?.(select);root.syncCustomSelect?.(select)
  }
  const api={profile,setMode,PollLoop,observeLatency:ms=>{if(Number.isFinite(ms))measuredLatency=ms},preferences}
  if(typeof module!=='undefined'&&module.exports)module.exports=api
  else{root.DshNetwork=api;root.document.addEventListener('DOMContentLoaded',()=>{preferences();new MutationObserver(preferences).observe(root.document.documentElement,{attributes:true,attributeFilter:['lang']})})}
})(typeof window==='undefined'?globalThis:window)
