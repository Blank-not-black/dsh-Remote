/* Active overview checks. Reuses the existing WS reconnect policy; no extra heartbeat frames. */
'use strict';
;(function(root){
  class LinkCheck {
    constructor(options){
      this.options=options;this.timer=null;this.graceTimer=null;this.epoch=0;this.job=null;this.abort=null;this.attempt=0
      this.model={phase:'idle',gateway:null,probing:false,checks:{gateway:false,dsh:false,mux:false,host:false}}
      this.now=options.now||Date.now;this.setTimer=options.setTimer||((fn,delay)=>setTimeout(fn,delay));this.clearTimer=options.clearTimer||(id=>clearTimeout(id))
    }
    emit(){this.options.changed?.(this.model)}
    clearTimers(){this.clearTimer(this.timer);this.clearTimer(this.graceTimer);this.timer=this.graceTimer=null}
    pause(){this.epoch++;this.clearTimers();this.abort?.abort();this.abort=null;this.job=null;this.model.probing=false;this.model.phase='idle'}
    start(force=false){
      if(!this.options.active()){this.pause();return}
      if(!force&&this.model.phase!=='idle'){this.observe();return}
      if(force&&this.model.probing&&this.options.configured()&&this.options.online())return
      this.pause();this.attempt=0;this.deadline=this.now()+20000;this.model.gateway=null
      this.model.phase=!this.options.configured()?'unconfigured':!this.options.online()?'offline':'checking'
      this.model.checks=this.options.snapshot();this.emit()
      if(this.model.phase!=='checking')return
      const epoch=this.epoch
      this.graceTimer=this.setTimer(()=>{if(epoch!==this.epoch)return;this.graceTimer=null;if(this.model.phase==='checking'){this.model.phase='degraded';this.emit()}},20000)
      void this.run()
    }
    observe(){
      if(!this.options.active())return
      const checks=this.options.snapshot(),key=JSON.stringify(checks),previous=JSON.stringify(this.model.checks)
      this.model.checks=checks
      if(this.options.configured()&&this.options.online()&&Object.values(checks).every(Boolean)){
        if(this.model.phase!=='ready'){this.model.phase='ready';this.clearTimer(this.graceTimer);this.graceTimer=null;if(!this.model.probing)this.schedule(30000);this.emit()}
        else if(key!==previous)this.emit()
      }else if(this.model.phase==='ready'){
        this.start(true)
      }else if(key!==previous)this.emit()
    }
    schedule(delay){this.clearTimer(this.timer);const epoch=this.epoch;this.timer=this.setTimer(()=>{this.timer=null;if(epoch===this.epoch)void this.run()},delay)}
    async run(){
      if(!this.options.active()){this.pause();return}
      if(!this.options.configured()||!this.options.online()){this.start(true);return}
      if(this.job)return this.job
      const epoch=this.epoch,abort=new AbortController();this.abort=abort;this.model.probing=true;this.emit()
      const job=Promise.resolve().then(async()=>{
        try{
          this.options.repair()
          const result=await this.options.probe(abort.signal)
          if(epoch!==this.epoch)return
          this.model.gateway=result.gateway===true
        }catch{if(epoch===this.epoch)this.model.gateway=false}
        if(epoch!==this.epoch)return
        this.model.checks=this.options.snapshot()
        const complete=Object.values(this.model.checks).every(Boolean)
        this.model.phase=complete?'ready':this.now()<this.deadline?'checking':'degraded'
        this.model.probing=false;this.emit()
        if(complete){this.clearTimer(this.graceTimer);this.graceTimer=null}
        if(this.options.active())this.schedule(complete||this.model.phase==='degraded'?30000:[2000,5000,10000][Math.min(this.attempt++,2)])
      }).finally(()=>{if(epoch===this.epoch&&this.job===job){this.job=null;this.abort=null}})
      this.job=job;return job
    }
  }
  /* Visual feedback never delays or changes network state. CSS owns the continuous sweep. */
  class PulseVisual {
    constructor(options){
      this.card=options.card;this.active=options.active||(()=>!root.document?.hidden)
      this.reduced=options.reduced||(()=>!!root.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
      this.setTimer=options.setTimer||((fn,delay)=>setTimeout(fn,delay));this.clearTimer=options.clearTimer||(id=>clearTimeout(id))
      this.checking=false;this.settleTimer=null;this.textJobs=new Map()
      root.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change',event=>{if(event.matches)this.pause();else this.setChecking(this.card.classList.contains('status-checking'))})
    }
    setChecking(checking){
      if(!this.active()||this.reduced()){this.pause();return}
      if(checking===this.checking)return
      this.checking=checking;this.clearTimer(this.settleTimer);this.settleTimer=null
      if(checking)this.card.dataset.pulseRunning='true'
      else this.settleTimer=this.setTimer(()=>{this.settleTimer=null;this.card.dataset.pulseRunning='false'},240)
    }
    setLinks(checks){
      for(const segment of this.card.querySelectorAll('[data-pulse-link]'))segment.setAttribute('data-confirmed',String(checks[segment.getAttribute('data-pulse-link')]===true))
    }
    clearText(node){
      const previous=this.textJobs.get(node);if(!previous)return
      this.textJobs.delete(node);previous.enter?.cancel();previous.exit?.cancel();previous.echo?.remove()
    }
    text(node,value){
      if(!node||node.textContent===value)return
      const interrupted=this.textJobs.has(node),previous=node.textContent,style=root.getComputedStyle?.(node),opacity=style?.opacity||'1',transform=style?.transform||'none'
      this.clearText(node)
      const animate=!!previous&&previous!=='—'&&this.active()&&!this.reduced()&&typeof node.animate==='function'
      let echo
      if(animate){
        echo=node.cloneNode(false);echo.removeAttribute('id');echo.removeAttribute('aria-live');echo.removeAttribute('data-i18n');echo.setAttribute('aria-hidden','true');echo.classList.add('pulse-text-echo');echo.textContent=previous
        Object.assign(echo.style,{left:node.offsetLeft+'px',top:node.offsetTop+'px',width:node.offsetWidth+'px',margin:'0'})
        node.parentElement.appendChild(echo)
      }
      node.textContent=value
      if(!animate)return
      const timing={duration:240,easing:'cubic-bezier(0.23, 1, 0.32, 1)'},job={echo}
      job.enter=node.animate([{opacity:interrupted?opacity:0,transform:transform==='none'?'translateY(3px)':transform},{opacity:1,transform:'translateY(0)'}],timing)
      job.exit=echo.animate([{opacity,transform},{opacity:0,transform:'translateY(-3px)'}],timing)
      this.textJobs.set(node,job)
      Promise.all([job.enter.finished,job.exit.finished]).catch(()=>{}).finally(()=>{if(this.textJobs.get(node)===job){this.textJobs.delete(node);echo.remove()}})
    }
    pause(){
      this.clearTimer(this.settleTimer);this.settleTimer=null;this.checking=false;this.card.dataset.pulseRunning='false'
      for(const node of [...this.textJobs.keys()])this.clearText(node)
    }
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={LinkCheck,PulseVisual}
  else root.DshLinkCheck={LinkCheck,PulseVisual}
})(typeof window==='undefined'?globalThis:window)
