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
  class HistoryView {
    constructor(box, options) {
      this.box=box; this.options=options; this.entries=[]; this.start=0; this.end=0; this.nodes=new Map(); this.reading=false; this.suppress=false; this.frame=0; this.pendingOlder=false
      this.more=document.createElement('button'); this.more.type='button'; this.more.className='history-page-control'; this.more.textContent=options.olderLabel()
      this.more.addEventListener('click',()=>this.older())
      this.empty=document.createElement('div'); this.empty.className='history-empty'
      this.live=document.createElement('div'); this.live.className='history-live'
      const intent=()=>{this.intentUntil=Date.now()+800}
      for(const name of ['wheel','touchmove','pointerdown'])box.addEventListener(name,intent,{passive:true})
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
    set(entries, {reset=false, follow=false, live='', hasMore=false, loading=false, emptyLabel=''}={}) {
      if(!reset&&entries.length===this.entries.length&&entries.every((entry,i)=>entry===this.entries[i])&&hasMore===this.hasMore&&loading===this.loading&&(this.end===entries.length?live:'')===this.liveHtml){this.entries=entries;this.more.disabled=loading;this.more.textContent=loading?this.options.loadingLabel():this.options.olderLabel();this.domChanged=false;this.options.changed?.(this);return}
      if(Date.now()<this.intentUntil)this.reading=this.box.scrollHeight-this.box.scrollTop-this.box.clientHeight>=180
      const oldWidth=this.end-this.start
      const anchor=this.anchor(), oldStart=this.entries[this.start]?.seq, oldEnd=this.entries[Math.max(this.start,this.end-1)]?.seq
      this.entries=entries; this.hasMore=hasMore; this.loading=loading
      if(reset || !this.end){this.end=entries.length;this.start=Math.max(0,this.end-WINDOW_SIZE);this.reading=false}
      else if((follow || !this.reading) && this.end>=this.previousLength){this.end=entries.length;this.start=Math.max(0,this.end-WINDOW_SIZE)}
      else {
        let start=entries.findIndex(e=>e.seq===oldStart),end=entries.findIndex(e=>e.seq===oldEnd)
        if(start<0)start=anchor?entries.findIndex(e=>e.seq===anchor.seq):0
        this.start=Math.max(0,start-(this.pendingOlder?WINDOW_STEP:0));this.end=Math.min(entries.length,Math.max(this.start+1,end+1,this.start+Math.min(WINDOW_SIZE,oldWidth)))
      }
      this.previousLength=entries.length
      this.empty.textContent=emptyLabel
      this.more.textContent=loading?this.options.loadingLabel():this.options.olderLabel();this.more.disabled=loading;this.more.hidden=this.start===0&&!hasMore
      this.liveHtml=this.end===entries.length?live:''
      this.render(anchor,reset || (!this.reading && this.end===entries.length))
    }
    render(anchor, bottom=false) {
      const box=this.box, slice=this.entries.slice(this.start,Math.min(this.end,this.start+WINDOW_SIZE)), desired=[]
      this.end=this.start+slice.length
      const rangeKey=this.start+':'+this.end
      let changed=rangeKey!==this.lastRange || this.live.innerHTML!==this.liveHtml
      this.lastRange=rangeKey
      for(const entry of slice) {
        const key=signature(entry);let cached=this.nodes.get(entry.seq)
        if(!cached || cached.key!==key){changed=true;const node=document.createElement('div');node.className='history-entry';node.dataset.historySeq=String(entry.seq);node.innerHTML=this.options.html(entry);cached={key,node};this.nodes.set(entry.seq,cached)}
        desired.push(cached.node)
      }
      this.more.hidden=this.start===0&&!this.hasMore
      const keep=new Set(desired)
      this.suppress=true
      for(const child of [...box.children])if(child!==this.more && child!==this.live && child!==this.empty && !keep.has(child))child.remove()
      if(this.more.parentNode!==box)box.prepend(this.more)
      let cursor=this.more.nextSibling
      for(const node of desired){if(node===cursor)cursor=cursor.nextSibling;else box.insertBefore(node,cursor)}
      if(!slice.length && !this.liveHtml){if(this.empty.parentNode!==box)box.append(this.empty)}else this.empty.remove()
      if(this.live.innerHTML!==this.liveHtml)this.live.innerHTML=this.liveHtml
      if(this.live.parentNode!==box)box.append(this.live)
      if(bottom)box.scrollTop=box.scrollHeight
      else if(anchor){const current=this.nodes.get(anchor.seq)?.node;if(current?.parentNode===box)box.scrollTop+=current.getBoundingClientRect().top-anchor.top}
      const active=new Set(slice.map(entry=>entry.seq));for(const seq of this.nodes.keys())if(!active.has(seq))this.nodes.delete(seq)
      cancelAnimationFrame(this.releaseFrame);this.releaseFrame=requestAnimationFrame(()=>{this.suppress=false})
      this.domChanged=changed
      this.options.changed?.(this)
    }
    onScroll() {
      const box=this.box
      if(Date.now()<this.intentUntil)this.reading=box.scrollHeight-box.scrollTop-box.clientHeight>=180
      if(box.scrollTop<80 && Date.now()<this.intentUntil)this.older()
      else if(box.scrollHeight-box.scrollTop-box.clientHeight<120 && this.end<this.entries.length && Date.now()<this.intentUntil){const anchor=this.anchor();this.end=Math.min(this.entries.length,this.end+WINDOW_STEP);this.start=Math.max(0,this.end-WINDOW_SIZE);this.render(anchor)}
      this.options.scrolled?.(this)
      this.domChanged=false
      this.options.changed?.(this)
    }
    async older() {
      if(this.pendingOlder)return
      if(this.start>0){const anchor=this.anchor();this.start=Math.max(0,this.start-WINDOW_STEP);this.end=Math.min(this.entries.length,this.start+WINDOW_SIZE);this.reading=true;this.render(anchor);return}
      if(!this.hasMore || this.loading)return
      this.reading=true
      this.pendingOlder=true
      try{await this.options.older()}finally{this.pendingOlder=false}
    }
    latest() {this.reading=false;this.end=this.entries.length;this.start=Math.max(0,this.end-WINDOW_SIZE);this.liveHtml=this.options.live?.()||'';this.render(null,true)}
    reset() {cancelAnimationFrame(this.frame);cancelAnimationFrame(this.releaseFrame);this.frame=0;this.entries=[];this.start=this.end=this.previousLength=0;this.lastRange='';this.nodes.clear();this.reading=false;this.pendingOlder=false;this.suppress=false;this.intentUntil=0;this.box.replaceChildren()}
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
    if(db){const value=await new Promise(resolve=>{try{const request=db.transaction('history').objectStore('history').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null)}catch{resolve(null)}});if(value)return value}
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
      tx.oncomplete=()=>resolve(true);tx.onabort=tx.onerror=()=>resolve(false)
    });if(saved)return true}catch{}
    if(epoch!==cacheEpoch)return false
    try{
      const indexKey=scope+':cache-index',index=JSON.parse(localStorage.getItem(indexKey)||'[]').filter(item=>item!==key),serialized=JSON.stringify(data)
      while(true){try{localStorage.setItem(key,serialized);break}catch(error){if(!index.length)throw error;localStorage.removeItem(index.pop())}}
      index.unshift(key)
      for(const removed of index.splice(10))localStorage.removeItem(removed)
      localStorage.setItem(indexKey,JSON.stringify(index));return kept.length>0
    }catch{return false}
  }
  async function cacheRemove(scope,id) {const key=cacheKey(scope,id);try{localStorage.removeItem(key)}catch{};const db=await openDatabase();if(db)try{db.transaction('history','readwrite').objectStore('history').delete(key)}catch{}}
  async function cacheClear() {cacheEpoch++;try{for(const key of Object.keys(localStorage))if(key.includes(':session:')||key.endsWith(':cache-index')||/^(history|sessions)Cache/.test(key))localStorage.removeItem(key)}catch{};const db=await openDatabase();if(db)await new Promise(resolve=>{try{const tx=db.transaction('history','readwrite');tx.objectStore('history').clear();tx.oncomplete=tx.onabort=tx.onerror=()=>resolve()}catch{resolve()}})}
  const api={HistoryView,reconcile,signature,cacheLoad,cacheSave,cacheRemove,cacheClear,decodeLegacy,WINDOW_SIZE}
  if(typeof module!=='undefined'&&module.exports)module.exports=api
  else root.DshHistory=api
})(typeof window==='undefined'?globalThis:window)