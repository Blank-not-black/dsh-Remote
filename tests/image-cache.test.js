'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path')
const database=require('./fixtures/image-indexeddb.cjs')
const source=fs.readFileSync(path.join(__dirname,'../public/image-cache.js'),'utf8')
function client(db=database(),options={}){
  const root={indexedDB:db.indexedDB,Blob,...options}
  const c=vm.createContext({window:root,setTimeout,clearTimeout,Date,Map,Promise,JSON,Error})
  vm.runInContext(source,c)
  return root.DshImageCache
}
const image=()=>({blob:new Blob(['test image'],{type:'image/png'}),etag:'"v1"'})
const imageRows=db=>[...db.rows.values()].filter(row=>row.blob)
test('image cache survives a new client, coalesces reads, and isolates credentials and sessions',async()=>{
  const db=database(),a=client(db);let calls=0
  const loader=async()=>{calls++;return image()}
  await Promise.all(Array.from({length:8},()=>a.load('host-token-a','session-a/image',loader)))
  assert.equal(calls,1)
  const b=client(db);assert.equal((await b.load('host-token-a','session-a/image',loader)).blob.size,10);assert.equal(calls,1)
  await b.load('host-token-b','session-a/image',loader);await b.load('host-token-a','session-b/image',loader)
  assert.equal(calls,3);assert.equal((await b.stats()).count,3)
})
test('path images revalidate, update changed data, reuse offline, and reject authorization failures',async()=>{
  const db=database(),cache=client(db)
  await cache.load('scope','path',image)
  await cache.load('scope','path',async cached=>{assert.equal(cached.etag,'"v1"');return cached},{revalidate:true})
  const next=await cache.load('scope','path',async()=>({blob:new Blob(['changed'],{type:'image/png'}),etag:'"v2"'}),{revalidate:true})
  assert.equal(next.blob.size,7)
  assert.equal((await cache.load('scope','path',async()=>{throw TypeError('offline')},{revalidate:true})).blob.size,7)
  await assert.rejects(cache.load('scope','path',async()=>{throw Object.assign(Error('Forbidden'),{status:403})},{revalidate:true}),/Forbidden/)
  assert.equal((await cache.stats()).count,0)
})
test('scoped clear preserves other connections; clearing during download prevents stale writes',async()=>{
  const db=database(),cache=client(db)
  await cache.load('a','old',image);await cache.load('b','old',image)
  let finish,started
  const ready=new Promise(resolve=>{started=resolve})
  const pending=cache.load('a','late',()=>new Promise(resolve=>{finish=resolve;started()}))
  const rejected=assert.rejects(pending,/stale image/)
  await ready;assert.equal(await cache.clear('a'),true);finish(image());await rejected
  assert.equal((await cache.stats()).count,1);assert.equal([...db.rows.values()][0].scope,'b')
  await cache.clear();assert.equal((await cache.stats()).count,0)
})
test('credential/session changes during a cache read or download never return or persist the image',async()=>{
  const db=database(),cache=client(db);let valid=true,finish,started
  const ready=new Promise(resolve=>{started=resolve})
  const pending=cache.load('a','image',()=>new Promise(resolve=>{finish=resolve;started()})),observed=pending.catch(e=>e)
  await ready;await cache.clear();finish(image());assert.match((await observed).message,/stale image/)
  valid=false;await assert.rejects(cache.load('a','image',image,{valid:()=>valid}),/stale image/)
  assert.equal(imageRows(db).length,0)
})
test('cache enforces total byte and item limits, expires unused rows, and touches LRU on hits',async()=>{
  class SizedBlob{constructor(size){this.size=size;this.type='image/png'}}
  const db=database(),cache=client(db,{Blob:SizedBlob}),large=()=>({blob:new SizedBlob(12*1024*1024)})
  for(let i=0;i<18;i++)await cache.load('a','large'+i,large)
  assert.ok((await cache.stats()).bytes<=200*1024*1024);assert.equal([...db.rows.values()].some(v=>JSON.parse(v.key)[1]==='large0'),false)
  await cache.clear()
  for(let i=0;i<501;i++)await cache.load('a',String(i),()=>({blob:new SizedBlob(1)}))
  assert.equal((await cache.stats()).count,500)
  const oldest=imageRows(db)[0];oldest.accessedAt=Date.now()-31*86400000
  assert.equal((await cache.stats()).count,499)
  const kept=imageRows(db)[0];kept.accessedAt=Date.now()-10*86400000
  await cache.load(kept.scope,JSON.parse(kept.key)[1],()=>{throw Error('cache miss')})
  assert.ok(db.rows.get(kept.key).accessedAt>Date.now()-1000)
})
test('unavailable or full persistent storage does not prevent image loading and reports failure to clear',async()=>{
  const absent=client({indexedDB:undefined});assert.equal((await absent.load('a','image',image)).blob.size,10);assert.equal((await absent.stats()).available,false)
  assert.equal(await absent.clear(),false)
  const db=database();db.failWrites(true)
  assert.equal((await client(db).load('a','image',image)).blob.size,10);assert.equal(db.rows.size,0)
})
test('oversized images display without persistence and invalid image content is rejected',async()=>{
  class SizedBlob{constructor(size,type='image/png'){this.size=size;this.type=type}}
  const db=database(),cache=client(db,{Blob:SizedBlob})
  assert.equal((await cache.load('a','big',()=>({blob:new SizedBlob(13*1024*1024)}))).blob.size,13*1024*1024)
  assert.equal(db.rows.size,0)
  await assert.rejects(cache.load('a','html',()=>({blob:new SizedBlob(10,'text/html')})),/Invalid image/)
})
test('stalled IDB opens and reads have deadlines instead of blocking image rendering',async()=>{
  for(const readStalls of [false,true]){
    const timers=new Map();let sequence=0,aborted=false
    const db={transaction:()=>({objectStore:()=>({get:()=>({})}),abort(){aborted=true}})}
    const indexedDB={open(){const request={result:db};if(readStalls)queueMicrotask(()=>request.onsuccess());return request}}
    const root={indexedDB,Blob},c=vm.createContext({window:root,setTimeout:fn=>{timers.set(++sequence,fn);return sequence},clearTimeout:id=>timers.delete(id),Date,Map,Promise,JSON,Error})
    vm.runInContext(source,c)
    const pending=root.DshImageCache.load('a','image',image)
    await new Promise(setImmediate);for(const callback of [...timers.values()])callback()
    await new Promise(setImmediate);for(const callback of [...timers.values()])callback()
    assert.equal((await pending).blob.size,10)
    if(readStalls)assert.equal(aborted,true)
  }
})
test('clearing in another tab invalidates outstanding downloads without removing other scopes',async()=>{
  const db=database(),a=client(db),b=client(db)
  await a.load('b','kept',image)
  let finish,started;const ready=new Promise(resolve=>{started=resolve})
  const pending=a.load('a','late',()=>new Promise(resolve=>{finish=resolve;started()}))
  const rejected=assert.rejects(pending,/stale image/)
  await ready;await b.clear('a');finish(image());await rejected
  assert.equal((await b.stats()).count,1)
  assert.equal(imageRows(db)[0].scope,'b')
})
