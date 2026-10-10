'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const H=require('../public/history.js')
function domFixture(){
 let tick=0;const frames=new Map()
 class Node {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.listeners={};this.hidden=false;this.clientHeight=400;this.clientWidth=360;this.scrollTop=0;this.height=40;this.innerHTML='';this.textContent=''}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn)}
  fire(name){for(const fn of this.listeners[name]||[])fn({})}
  get nextSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null}
  insertBefore(node,cursor){node.remove();const i=cursor?this.children.indexOf(cursor):this.children.length;this.children.splice(i,0,node);node.parentNode=this}
  prepend(node){this.insertBefore(node,this.children[0])}
  append(node){this.insertBefore(node,null)}
  remove(){if(this.parentNode){const p=this.parentNode;p.children.splice(p.children.indexOf(this),1);this.parentNode=null}}
  replaceChildren(){for(const c of [...this.children])c.remove()}
  querySelectorAll(){return this.children.filter(c=>c.className==='history-entry')}
  get scrollHeight(){return this.children.reduce((n,c)=>n+(c.hidden||c.className==='history-live'&&!c.innerHTML||c.className==='history-empty'&&!c.textContent?0:c.height),0)}
  getBoundingClientRect(){if(!this.parentNode)return {top:0,bottom:400};let top=-this.parentNode.scrollTop;for(const c of this.parentNode.children){if(c===this)break;if(!c.hidden)top+=c.className==='history-live'&&!c.innerHTML?0:c.height}return {top,bottom:top+this.height}}
 }
 const context=vm.createContext({document:{createElement:tag=>new Node(tag)},requestAnimationFrame:fn=>{const id=++tick;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id),Date,JSON,Map,Set,WeakMap,Promise,globalThis:{},module:{exports:{}}})
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/history.js'),'utf8'),context)
 const box=new Node('box'),api=context.module.exports,view=new api.HistoryView(box,{html:entry=>String(entry.seq),olderLabel:()=> 'Earlier',loadingLabel:()=> 'Loading',older:async()=>{}})
 return {box,view,api,flush:()=>{for(const [id,fn]of [...frames]){frames.delete(id);fn()}}}
}
const entries=(start,count)=>Array.from({length:count},(_,i)=>({seq:start+i,event:{type:'assistant/message',data:{text:'message '+(start+i)}}}))
test('10,000 history records remain bounded while paging up and back down',async()=>{
 const {box,view,flush}=domFixture(),all=entries(1,10000);view.set(all,{reset:true});flush()
 let moves=0
 while(view.start>0){box.scrollTop=0;view.intentUntil=Date.now()+1000;await view.older();flush();assert.ok(box.querySelectorAll().length<=H.WINDOW_SIZE);assert.ok(view.nodes.size<=H.WINDOW_SIZE);moves++}
 assert.ok(moves>150);assert.equal(view.entries[view.start].seq,1)
 view.latest();flush();assert.equal(view.entries[view.end-1].seq,10000)
})
test('Image height changes do not suppress new replies; actual reading preserves the viewport',()=>{
 const {view,box,flush}=domFixture();view.set(entries(1,400),{reset:true});flush();box.querySelectorAll()[0].height=600
 view.set(entries(1,401));flush();assert.equal(view.end,401);assert.equal(box.querySelectorAll().at(-1).dataset.historySeq,'401')
 box.scrollTop=1000;view.intentUntil=Date.now()+1000;view.onScroll();flush();const anchor=view.anchor(),top=box.scrollTop,end=view.end
 view.set(entries(1,402));flush();assert.equal(view.end,end);assert.equal(view.anchor().seq,anchor.seq);assert.equal(box.scrollTop,top)
})
test('Identical remote records reuse DOM nodes and do not rebuild layout',()=>{
 const {view,box,flush,api}=domFixture(),old=entries(1,250);view.set(old,{reset:true});flush();view.reading=true;box.scrollTop=500
 const nodes=[...box.querySelectorAll()],anchor=view.anchor(),scroll=box.scrollTop
 const merged=api.reconcile(old,structuredClone(old),1);view.set(merged);flush()
 assert.equal(view.domChanged,false);assert.deepEqual(box.querySelectorAll(),nodes);assert.equal(view.anchor().seq,anchor.seq);assert.equal(box.scrollTop,scroll)
})
test('Server page prepends once, keeps anchor and reveals older cached records',async()=>{
 const {view,box,flush}=domFixture();view.set(entries(61,60),{reset:true,hasMore:true});flush();box.scrollTop=0
 let calls=0,release;view.options.older=()=>{calls++;return new Promise(resolve=>{release=()=>{view.set(entries(1,120),{hasMore:false});resolve()}})}
 const first=view.older();await view.older();assert.equal(calls,1);release();await first;flush();assert.equal(view.start,0);assert.equal(view.entries[0].seq,1);assert.equal(box.querySelectorAll().find(node=>node.dataset.historySeq==='61').getBoundingClientRect().top,40)
})
test('Reconciliation replaces changed entries, removes absent authoritative entries and preserves live tail',()=>{
 const old=entries(1,8),incoming=entries(4,3);incoming[1].event.data.text='changed'
 const merged=H.reconcile(old,incoming,4,true,8)
 assert.deepEqual(merged.map(e=>e.seq),[1,2,3,4,5,6,8]);assert.equal(merged[3],old[3]);assert.notEqual(merged[4],old[4]);assert.equal(merged.at(-1),old.at(-1))
})
function loaderFixture(file){
 const source=fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),start=source.indexOf('async function loadHistory('),end=source.indexOf(file==='app.js'?'function insertLiveEvent(':'const INTERESTING_EVENTS',start)
 const state={current:'a',history:{visible:entries(10,3),minSeq:10,partialReasoning:new Map(),reasoningVersion:0,hasMore:true}},calls=[],renders=[];let resolve,reject,valid=true
 const context=vm.createContext({state,Date,Number,Map,Set,Math,window:{DshHistory:H},captureConnection:()=>({valid:()=>valid}),getConversationView:()=>({more:{},options:{loadingLabel:()=>''}}),rpc:(_,payload)=>{calls.push(payload);return new Promise((a,b)=>{resolve=a;reject=b})},historySource:value=>{state.history.source=value},setSessionRecovery:()=>{},hydrateSessionProjections:()=>{},applyReasoningStreamEvent:()=>{},noteSessionTurnTime:()=>{},shouldShowEvent:type=>!['session/title','title'].includes(type),trimVisible:()=>{},applyReasoningBaseline:()=>{},renderSessionTitle:()=>{},renderSessionSub:()=>{},renderSessionCards:()=>{},updateSessionActions:()=>{},renderHistory:(...args)=>renders.push(args),scheduleHistoryCacheSave:()=>{},document:{createElement:()=>({addEventListener:(_,fn)=>{context.retry=fn}})},$:()=>({innerHTML:'',textContent:'',append:()=>{}}),t:()=>'',esc:x=>x,authFailure:()=>{}})
 context.conversationView={reading:true}
 vm.runInContext(source.slice(source.indexOf('function trimVisible('),start)+source.slice(start,end),context)
 return {state,calls,renders,load:context.loadHistory,resolve:value=>resolve(value),reject:error=>reject(error),invalidate:()=>{valid=false},setReading:value=>{context.conversationView.reading=value},retry:()=>context.retry()}
}
for(const file of ['app.js','desktop/desktop.js']){
 test(file+': offline refresh retains cached content and source, delayed A cannot overwrite B',async()=>{
  const h=loaderFixture(file),old=h.state.history.visible,p=h.load(true);assert.equal(h.state.history.source,'syncing');h.reject(new Error('offline'));await p;assert.equal(h.state.history.visible,old);assert.equal(h.state.history.source,'offline')
  const pending=h.load(true);h.state.current='b';h.state.history={visible:entries(100,1)};h.resolve({events:[{event:{seq:7,type:'assistant/message'}}]});await pending;assert.equal(h.state.history.visible[0].seq,100)
 })
 test(file+': parallel older requests coalesce and a non-progressing cursor stops paging',async()=>{
  const h=loaderFixture(file),p=h.load(false);await h.load(false);assert.equal(h.calls.length,1);h.resolve({events:[{event:{seq:10,type:'session/title'}}],hasMore:true});await p;assert.equal(h.state.history.hasMore,false)
 })
 test(file+': repeated remote paging stays bounded without losing the oldest cursor',async()=>{
  const h=loaderFixture(file);h.state.history.visible=entries(20001,60);h.state.history.minSeq=20001;h.state.history.seqs=new Set(h.state.history.visible.map(e=>e.seq))
  for(let i=0;i<120;i++){const before=h.state.history.minSeq,p=h.load(false);h.resolve({events:entries(before-60,60).map(e=>({event:{...e.event,seq:e.seq}})),hasMore:true});await p;assert.ok(h.state.history.visible.length<=5000);assert.equal(h.state.history.seqs.size,h.state.history.visible.length);assert.equal(h.state.history.minSeq,before-60)}
  assert.equal(h.state.history.tailEvicted,true);assert.equal(h.state.history.visible[0].seq,h.state.history.minSeq)
 })
 test(file+': full snapshots remove stale cache; trimming resumes at the new retained cursor',async()=>{
  const h=loaderFixture(file);h.setReading(false)
  const p=h.load(true);h.resolve({events:entries(100,3).map(e=>({event:{...e.event,seq:e.seq}})),hasMore:false});await p;assert.deepEqual(h.state.history.visible.map(e=>e.seq),[100,101,102])
  const next=h.load(true);h.resolve({events:entries(1,5001).map(e=>({event:{...e.event,seq:e.seq}})),hasMore:false});await next
  assert.equal(h.state.history.visible.length,5000);assert.equal(h.state.history.minSeq,2);assert.equal(h.state.history.hasMore,true)
  const older=h.load(false);assert.equal(h.calls.at(-1).beforeSeq,2);h.resolve({events:[{event:{seq:1,type:'assistant/message'}}],hasMore:false});await older;assert.equal(h.state.history.visible[0].seq,1)
 })
 test(file+': first-load failure has a working retry and does not remain loading',async()=>{
  const h=loaderFixture(file);h.state.history.visible=[]
  const p=h.load(true);h.reject(new Error('offline'));await p;assert.equal(h.state.history.loading,false)
  h.retry();assert.equal(h.calls.length,2);h.resolve({events:[{event:{seq:1,type:'assistant/message'}}],hasMore:false});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.state.history.visible[0].seq,1);assert.equal(h.state.history.loading,false)
 })
 test(file+': cache restoration precedes remote history and navigation cleanup does not wait for network',()=>{
  const s=fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),start=s.indexOf('async function openSession('),end=s.indexOf('async function closeSession',start),open=s.slice(start,end)
  assert.ok(open.indexOf('await restoreCachedHistory()')<open.indexOf('await loadHistory'))
  assert.match(open,/void archiveEmptySessionOnLeave/)
  assert.match(open,/state\.history!==openingHistory.*!openingConnection\.valid\(\)/)
 })
}
test('Local cache isolates credentials, bounds quota fallback, and can be cleared',async()=>{
 const data={},storage={getItem:key=>data[key]??null,setItem:(key,value)=>{data[key]=value},removeItem:key=>{delete data[key]}}
 Object.defineProperty(globalThis,'localStorage',{value:new Proxy(storage,{ownKeys:()=>Object.keys(data),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})}),configurable:true})
 try{
  assert.equal(await H.cacheSave('identity-a','same',{events:entries(1,20)}),true)
  assert.equal(await H.cacheLoad('identity-b','same'),null);assert.equal((await H.cacheLoad('identity-a','same')).events.length,20)
  for(let i=0;i<13;i++)await H.cacheSave('identity-a','session'+i,{events:entries(1,2)})
  assert.equal(await H.cacheLoad('identity-a','same'),null)
  const big=entries(1,20).map(e=>({...e,event:{data:{text:'x'.repeat(100000)}}}));await H.cacheSave('identity-b','large',{events:big,minSeq:1})
  const restored=await H.cacheLoad('identity-b','large');assert.ok(restored.events.length<20);assert.equal(restored.minSeq,restored.events[0].seq);assert.equal(restored.hasMore,true)
  await H.cacheRemove('identity-b','large');assert.equal(await H.cacheLoad('identity-b','large'),null)
  await H.cacheClear();assert.equal(await H.cacheLoad('identity-a','session12'),null)
 }finally{delete globalThis.localStorage}
})
test('IndexedDB transaction failure falls back to local storage, evicting older same-identity cache on quota',async()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)||null,removeItem:key=>data.delete(key),setItem:(key,value)=>{if(key.includes(':session:')&&data.has('scope:session:old'))throw Error('quota');data.set(key,value)}}
 data.set('scope:session:old','old');data.set('scope:cache-index',JSON.stringify(['scope:session:old']))
 const db={transaction:()=>{const tx={objectStore:()=>({put:()=>{},index:()=>({openKeyCursor:()=>({})})})};queueMicrotask(()=>tx.onabort?.());return tx}}
 const indexedDB={open:()=>{const request={result:db};queueMicrotask(()=>request.onsuccess());return request}}
 const context=vm.createContext({module:{exports:{}},globalThis:{},indexedDB,localStorage:storage,IDBKeyRange:{bound:()=>[]},setTimeout,clearTimeout,queueMicrotask,Date,JSON,Map,Set,WeakMap})
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/history.js'),'utf8'),context)
 assert.equal(await context.module.exports.cacheSave('scope','new',{events:entries(1,3)}),true)
 assert.equal(data.has('scope:session:old'),false);assert.ok(data.has('scope:session:new'))
})
