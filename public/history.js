/* Shared bounded conversation rendering and asynchronous local cache. No dependencies. */
'use strict';
;(function(root) {
  const WINDOW_SIZE = 180, WINDOW_STEP = 60, fingerprints = new WeakMap()
  function signature(entry) {
    if (!fingerprints.has(entry)) fingerprints.set(entry, JSON.stringify([entry.seq, entry.event, entry.view]))
    return fingerprints.get(entry)
  }
  function reconcile(previous, incoming, floor = -Infinity, retainOlder = true, ceiling = Infinity) {
    const old = new Map(previous.map(entry => [entry.seq, entry]))
    const next = new Map(previous.filter(entry => entry.seq >= ceiling || (retainOlder && entry.seq < floor)).map(entry => [entry.seq, entry]))
    for (const entry of incoming) {
      const existing = old.get(entry.seq)
      next.set(entry.seq, existing && signature(existing) === signature(entry) ? existing : entry)
    }
    return [...next.values()].sort((a,b) => a.seq-b.seq)
  }
  function insertSorted(entries, entry) {
    if (!entries.length || entries[entries.length-1].seq < entry.seq) { entries.push(entry); return }
    let low=0,high=entries.length
    while(low<high){const middle=(low+high)>>>1;if(entries[middle].seq<entry.seq)low=middle+1;else high=middle}
    if(entries[low]?.seq===entry.seq)entries[low]=entry
    else entries.splice(low,0,entry)
  }
  class HistoryView {
    constructor(box, options) {
      this.box=box; this.options=options; this.entries=[]; this.start=0; this.end=0; this.nodes=new Map(); this.disclosures=new Map(); this.reading=false; this.suppress=false; this.frame=0; this.pendingOlder=false
      this.more=document.createElement('button'); this.more.type='button'; this.more.className='history-page-control'; this.more.textContent=options.olderLabel()
      this.more.addEventListener('click',()=>this.older())
      this.empty=document.createElement('div'); this.empty.className='history-empty'
      this.retry=document.createElement('button');this.retry.type='button';this.retry.className='history-page-control';this.retry.textContent=options.retryLabel?.()||'Retry'
      this.retry.addEventListener('click',()=>options.retry?.())
      this.live=document.createElement('div'); this.live.className='history-live'
      box.addEventListener('toggle',event=>{const detail=event.target;if(detail?.dataset?.activityKey)this.rememberDisclosure(detail)},true)
      const intent=()=>{this.intentUntil=Date.now()+1200}
      const hold=()=>{intent();this.reading=true;this.options.changed?.(this)}
      box.addEventListener('wheel',event=>{intent();if(event.deltaY<0)hold()},{passive:true})
      box.addEventListener('touchstart',event=>{this.touchY=event.touches?.[0]?.clientY;this.lastScrollTop=box.scrollTop},{passive:true})
      box.addEventListener('touchmove',event=>{const y=event.touches?.[0]?.clientY;intent();if(y>this.touchY)hold();this.touchY=y},{passive:true})
      // Pressing a card or selecting text pauses following, but only when actually
      // scrolled away from the tail: tapping at the bottom must not fake "new content".
      box.addEventListener('pointerdown',()=>{this.lastScrollTop=box.scrollTop;this.intentUntil=0;if(!this.atBottom)this.reading=true;this.options.changed?.(this)},{passive:true})
      box.addEventListener('keydown',event=>{if(['ArrowUp','PageUp','Home'].includes(event.key))hold();else if(['ArrowDown','PageDown','End'].includes(event.key))intent()})
      box.addEventListener('scroll',()=>{
        if(this.suppress || this.frame)return
        this.frame=requestAnimationFrame(()=>{this.frame=0;this.onScroll()})
      },{passive:true})
    }
    anchor() {
      const top=this.box.getBoundingClientRect().top
      for(const node of this.box.querySelectorAll('.history-entry'))if(node.getBoundingClientRect().bottom>=top+1)return {seq:Number(node.dataset.historySeq),top:node.getBoundingClientRect().top}
      return null
    }
    get unread() {return Math.max(0,this.entries.length-this.end)}
    get hasPending() {return this.unread>0||(this.pendingLive||'')!==(this.liveHtml||'')}
    /** Real viewport position, not an intent flag: a stale `reading` must never keep the jump button up at the bottom. */
    get atBottom() {const box=this.box;return box.scrollHeight-box.scrollTop-box.clientHeight<=24}
    set(entries, {reset=false, follow=false, live='', hasMore=false, loading=false, emptyLabel=''}={}) {
      if(this.paused){this.pending={entries:entries.slice(),options:{reset,follow,live,hasMore,loading,emptyLabel}};return}
      // A stale flag is cleaned up only when no gesture is in progress: while the user is
      // actively scrolling up from the bottom a stream update must not clear `reading`,
      // otherwise every chunk snaps the view back to the tail.
      if(this.reading&&Date.now()>(this.intentUntil||0)&&this.atBottom&&this.end>=this.entries.length)this.reading=false
      this.pendingLive=live
      // Reading is explicit user intent. A stream update never changes it by proximity.
      if(this.reading&&!reset)live=this.liveHtml||''
      if(!reset&&!this.renderErrors&&entries.length===this.entries.length&&entries.every((entry,i)=>entry===this.entries[i])&&hasMore===this.hasMore&&loading===this.loading&&(this.end===entries.length?live:'')===this.liveHtml){this.more.disabled=loading;this.more.textContent=loading?this.options.loadingLabel():this.options.olderLabel();this.domChanged=false;this.options.changed?.(this);return}
      const oldWidth=this.end-this.start
      const anchor=this.anchor(), oldStart=this.entries[this.start]?.seq, oldEnd=this.entries[Math.max(this.start,this.end-1)]?.seq
      this.entries=entries.slice(); this.hasMore=hasMore; this.loading=loading
      if(reset || !this.end){this.end=entries.length;this.start=Math.max(0,this.end-WINDOW_SIZE);this.reading=false}
      else if(!this.reading && this.end>=this.previousLength){this.end=entries.length;this.start=Math.max(0,this.end-WINDOW_SIZE)}
      else {
        let start=entries.findIndex(e=>e.seq===oldStart),end=entries.findIndex(e=>e.seq===oldEnd)
        if(start<0)start=anchor?entries.findIndex(e=>e.seq===anchor.seq):0
        this.start=Math.max(0,start-(this.pendingOlder?WINDOW_STEP:0));this.end=Math.min(entries.length,Math.max(this.start+1,end+1,this.start+Math.min(WINDOW_SIZE,oldWidth)))
      }
      this.previousLength=entries.length
      this.emptyLabel=emptyLabel
      this.more.textContent=loading?this.options.loadingLabel():this.options.olderLabel();this.more.disabled=loading;this.more.hidden=this.start===0&&!hasMore
      this.liveHtml=this.reading&&!reset ? this.liveHtml||'' : this.end===entries.length?live:''
      this.render(anchor,reset || (!this.reading && this.end===entries.length))
    }
    rememberDisclosure(detail) {
      const key=detail.dataset.activityKey;if(!key)return
      this.disclosures.delete(key);this.disclosures.set(key,!!detail.open)
      if(this.disclosures.size>512)this.disclosures.delete(this.disclosures.keys().next().value)
    }
    captureDisclosures(node) {for(const detail of node.querySelectorAll('details[data-activity-key]'))this.rememberDisclosure(detail)}
    restoreDisclosures(node) {for(const detail of node.querySelectorAll('details[data-activity-key]'))if(this.disclosures.has(detail.dataset.activityKey))detail.open=this.disclosures.get(detail.dataset.activityKey)}
    render(anchor, bottom=false) {
      const box=this.box, slice=this.entries.slice(this.start,Math.min(this.end,this.start+WINDOW_SIZE)), desired=[]
      this.captureDisclosures(box)
      this.end=this.start+slice.length
      const rangeKey=this.start+':'+this.end
      let changed=rangeKey!==this.lastRange || this.live.innerHTML!==this.liveHtml
      this.lastRange=rangeKey
      this.renderErrors=0
      for(const entry of slice) {
        // Hidden events render an empty string; keeping their node would leave dead gaps.
        let html,key,failed=false
        try{html=this.options.html(entry);key=signature(entry)}catch(error){failed=true;this.renderErrors++;key='render-error';globalThis.DshDiagnostics?.record('history.row',{phase:'failed',...globalThis.DshDiagnostics.errorFacts(error),category:'render'})}
        if(!html&&!failed){if(this.nodes.delete(entry.seq))changed=true;continue}
        let cached=this.nodes.get(entry.seq)
        if(!cached || cached.key!==key){changed=true;const node=document.createElement('div');node.className='history-entry';node.dataset.historySeq=String(entry.seq);if(failed)node.textContent=this.options.errorLabel?.()||'This message could not be displayed. Retry loading history.';else{node.innerHTML=html;this.restoreDisclosures(node)}cached={key,node};this.nodes.set(entry.seq,cached)}
        desired.push(cached.node)
      }
      this.more.hidden=this.start===0&&!this.hasMore
      const keep=new Set(desired)
      this.suppress=true
      for(const child of [...box.children])if(child!==this.more && child!==this.live && child!==this.empty && child!==this.retry && !keep.has(child))child.remove()
      if(this.more.parentNode!==box)box.prepend(this.more)
      let cursor=this.more.nextSibling
      for(const node of desired){if(node===cursor)cursor=cursor.nextSibling;else box.insertBefore(node,cursor)}
      const empty=!desired.length&&!this.liveHtml, unreadable=empty&&slice.length>0
      this.empty.textContent=unreadable?(this.options.unreadableLabel?.()||this.emptyLabel):this.emptyLabel
      if(empty){if(this.empty.parentNode!==box)box.append(this.empty)}else this.empty.remove()
      if((unreadable||this.renderErrors)&&this.options.retry){if(this.retry.parentNode!==box)box.append(this.retry)}else this.retry.remove()
      if(this.live.innerHTML!==this.liveHtml){this.live.innerHTML=this.liveHtml;this.restoreDisclosures(this.live)}
      if(this.live.parentNode!==box)box.append(this.live)
      if(bottom)box.scrollTop=box.scrollHeight
      else if(anchor){const current=this.nodes.get(anchor.seq)?.node;if(current?.parentNode===box)box.scrollTop+=current.getBoundingClientRect().top-anchor.top}
      const active=new Set(slice.map(entry=>entry.seq));for(const seq of this.nodes.keys())if(!active.has(seq))this.nodes.delete(seq)
      cancelAnimationFrame(this.releaseFrame);this.releaseFrame=requestAnimationFrame(()=>{this.suppress=false})
      this.lastScrollTop=box.scrollTop
      this.domChanged=changed
      this.options.changed?.(this)
    }
    onScroll() {
      const box=this.box, atBottom=this.atBottom
      // Position wins over the intent flag: reaching the bottom always resumes following,
      // no matter whether the scroll came from a wheel, a drag, a rail jump or momentum.
      if(atBottom)this.reading=false
      else if(Date.now()<this.intentUntil&&box.scrollTop<(this.lastScrollTop??box.scrollTop))this.reading=true
      this.lastScrollTop=box.scrollTop
      if(box.scrollTop<80 && Date.now()<this.intentUntil)this.older()
      else if(box.scrollHeight-box.scrollTop-box.clientHeight<120 && this.end<this.entries.length && Date.now()<this.intentUntil){const anchor=this.anchor();this.end=Math.min(this.entries.length,this.end+WINDOW_STEP);this.start=Math.max(0,this.end-WINDOW_SIZE);this.liveHtml=this.end===this.entries.length?this.pendingLive||'':'';this.render(anchor,atBottom)}
      else if(atBottom&&this.end>=this.entries.length&&this.liveHtml!==(this.pendingLive||'')){this.liveHtml=this.pendingLive||'';this.render(null,true)}
      this.options.scrolled?.(this)
      this.domChanged=false
      this.options.changed?.(this)
    }
    async older() {
      if(this.pendingOlder)return
      if(this.start>0){const anchor=this.anchor();this.start=Math.max(0,this.start-WINDOW_STEP);this.end=Math.min(this.entries.length,this.start+WINDOW_SIZE);this.reading=true;if(this.end<this.entries.length)this.liveHtml='';this.render(anchor);return}
      if(!this.hasMore || this.loading)return
      this.reading=true
      this.pendingOlder=true
      try{await this.options.older()}finally{this.pendingOlder=false}
    }
    latest() {this.reading=false;this.intentUntil=0;this.end=this.entries.length;this.start=Math.max(0,this.end-WINDOW_SIZE);this.liveHtml=this.options.live?.()??this.pendingLive??'';this.render(null,true)}
    pause() {if(!this.paused)this.savedScroll=this.box.scrollTop;this.paused=true}
    resume() {
      if(!this.paused)return
      this.paused=false;this.box.scrollTop=this.savedScroll||0
      const pending=this.pending;this.pending=null;if(pending)this.set(pending.entries,pending.options)
    }
    reset() {cancelAnimationFrame(this.frame);cancelAnimationFrame(this.releaseFrame);this.frame=0;this.entries=[];this.start=this.end=this.previousLength=0;this.lastRange='';this.nodes.clear();this.disclosures.clear();this.reading=false;this.pendingOlder=false;this.suppress=false;this.intentUntil=0;this.pendingLive='';this.pending=null;this.paused=false;this.lastScrollTop=0;this.box.replaceChildren()}
  }
  let cacheEpoch=0
  let database
  function openDatabase() {
    if(database)return database
    database=new Promise(resolve=>{
      if(typeof indexedDB==='undefined'){resolve(null);return}
      const request=indexedDB.open('dshRemoteHistoryV1',1),timer=setTimeout(()=>resolve(null),1500)
      request.onupgradeneeded=()=>{const store=request.result.createObjectStore('history',{keyPath:'key'});store.createIndex('scopeTime',['scope','updatedAt'])}
      request.onsuccess=()=>{clearTimeout(timer);request.result.onversionchange=()=>request.result.close();resolve(request.result)}
      request.onerror=request.onblocked=()=>{clearTimeout(timer);resolve(null)}
    })
    return database
  }
  function decodeLegacy(raw,id) {
    if(!raw)return Promise.resolve(null)
    if(raw.length>250000&&typeof Worker!=='undefined')return new Promise(resolve=>{
      let worker,url,timer
      const done=value=>{clearTimeout(timer);worker?.terminate();if(url)URL.revokeObjectURL(url);resolve(value)}
      try{url=URL.createObjectURL(new Blob(["self.onmessage=e=>{try{self.postMessage(JSON.parse(e.data.raw)[e.data.id]||null)}catch{self.postMessage(null)}}"],{type:'text/javascript'}));worker=new Worker(url);worker.onmessage=e=>done(e.data);worker.onerror=()=>done(null);timer=setTimeout(()=>done(null),3000);worker.postMessage({raw,id})}catch{done(null)}
    })
    try{return Promise.resolve(JSON.parse(raw)[id]||null)}catch{return Promise.resolve(null)}
  }
  const cacheKey=(scope,id)=>scope+':session:'+encodeURIComponent(id)
  async function cacheLoad(scope,id,legacy) {
    const key=cacheKey(scope,id),db=await openDatabase()
    if(db){const value=await new Promise(resolve=>{
      let tx,settled=false
      const done=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)}
        const timer=setTimeout(()=>{globalThis.DshDiagnostics?.storageFailure(scope,{name:'TimeoutError'},'indexeddb');done(null);try{tx?.abort()}catch{}},1500)
      try{tx=db.transaction('history');const request=tx.objectStore('history').get(key);request.onsuccess=()=>done(request.result);request.onerror=tx.onabort=tx.onerror=()=>done(null)}catch{done(null)}
    });if(value)return value}
    try{const value=JSON.parse(localStorage.getItem(key)||'null');if(value)return value}catch{}
    // One-time compatibility with the old per-connection JSON cache.
    try{const value=await legacy?.(id);if(value){void cacheSave(scope,id,value);return value}return null}catch{return null}
  }
  async function cacheSave(scope,id,value) {
    const epoch=cacheEpoch,key=cacheKey(scope,id),kept=[];let size=0
    for(let i=(value.events||[]).length-1;i>=0;i--){const entry=value.events[i],length=signature(entry).length;if(size+length>750000)break;kept.unshift(entry);size+=length}
    if(!kept.length)return false
    const data={...value,events:kept,minSeq:kept[0].seq,hasMore:value.hasMore||kept.length<(value.events||[]).length,key,scope,id,updatedAt:Date.now()},db=await openDatabase()
    if(epoch!==cacheEpoch)return false
    if(db)try{const saved=await new Promise(resolve=>{
      const tx=db.transaction('history','readwrite'),store=tx.objectStore('history');store.put(data)
      let count=0;const request=store.index('scopeTime').openKeyCursor(IDBKeyRange.bound([scope,0],[scope,Number.MAX_SAFE_INTEGER]),'prev')
      request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(++count>10)store.delete(cursor.primaryKey);cursor.continue()}
      tx.oncomplete=()=>resolve(true);tx.onabort=tx.onerror=()=>{globalThis.DshDiagnostics?.storageFailure(scope,tx.error||{name:'UnknownError'},'indexeddb');resolve(false)}
    });if(saved)return true}catch(error){globalThis.DshDiagnostics?.storageFailure(scope,error,'indexeddb')}
    if(epoch!==cacheEpoch)return false
    try{
      const indexKey=scope+':cache-index',index=JSON.parse(localStorage.getItem(indexKey)||'[]').filter(item=>item!==key),serialized=JSON.stringify(data)
      let diagnosed=false
      while(true){try{localStorage.setItem(key,serialized);break}catch(error){if(!diagnosed){diagnosed=true;globalThis.DshDiagnostics?.storageFailure(scope,error)}if(!index.length)throw error;localStorage.removeItem(index.pop())}}
      index.unshift(key)
      for(const removed of index.splice(10))localStorage.removeItem(removed)
      localStorage.setItem(indexKey,JSON.stringify(index));return kept.length>0
    }catch{return false}
  }
  async function cacheRemove(scope,id) {const key=cacheKey(scope,id);try{localStorage.removeItem(key)}catch{};const db=await openDatabase();if(db)try{db.transaction('history','readwrite').objectStore('history').delete(key)}catch{}}
  async function cacheClear() {cacheEpoch++;try{for(const key of Object.keys(localStorage))if(key.includes(':session:')||key.endsWith(':cache-index')||/^(history|sessions)Cache/.test(key))localStorage.removeItem(key)}catch{};const db=await openDatabase();if(db)await new Promise(resolve=>{try{const tx=db.transaction('history','readwrite');tx.objectStore('history').clear();tx.oncomplete=tx.onabort=tx.onerror=()=>resolve()}catch{resolve()}})}
  const api={HistoryView,reconcile,insertSorted,signature,cacheLoad,cacheSave,cacheRemove,cacheClear,decodeLegacy,WINDOW_SIZE}
  if(typeof module!=='undefined'&&module.exports)module.exports=api
  else root.DshHistory=api
})(typeof window==='undefined'?globalThis:window)
