'use strict'
// Small asynchronous, serialized IDB fixture. Aborts discard all staged writes.
module.exports=function imageDatabase(){
  const rows=new Map(),queue=[];let busy=false,fail=false
  const start=()=>{if(busy||!queue.length)return;busy=true;queue.shift()()}
  const db={close(){},transaction(){
    let work,active=false,finished=false,pending=0,completion
    const waiting=[]
    const tx={abort(){finish(false)},objectStore:()=>store}
    function finish(commit){if(finished)return;finished=true;clearImmediate(completion);if(commit){rows.clear();for(const [key,value] of work)rows.set(key,value)};queueMicrotask(()=>{(commit?tx.oncomplete:tx.onabort)?.();busy=false;start()})}
    function check(){clearImmediate(completion);if(active&&!pending)completion=setImmediate(()=>finish(!fail))}
    function operation(fn){
      const request={};pending++
      const run=()=>queueMicrotask(()=>{if(finished)return;try{fn(request)}catch(error){tx.error=error;finish(false)}pending--;check()})
      if(active)run();else waiting.push(run)
      return request
    }
    function cursor(index){
      let keys,at=0;const request={}
      const step=()=>operation(()=>{
        if(!keys)keys=[...work.keys()].sort((a,b)=>index?(work.get(a).accessedAt-work.get(b).accessedAt)||a.localeCompare(b):a.localeCompare(b))
        while(at<keys.length&&!work.has(keys[at]))at++
        const key=keys[at++]
        request.result=key===undefined?null:{primaryKey:key,value:work.get(key),delete:()=>store.delete(key),continue:step}
        request.onsuccess?.()
      })
      step();return request
    }
    const store={
      get:key=>operation(r=>{r.result=work.get(key);r.onsuccess?.()}),
      put:value=>operation(r=>{work.set(value.key,{...value});r.onsuccess?.()}),
      delete:key=>operation(()=>work.delete(key)),clear:()=>operation(()=>work.clear()),
      openCursor:()=>cursor(false),index:()=>({openCursor:()=>cursor(true)})
    }
    queue.push(()=>{active=true;work=new Map([...rows].map(([key,value])=>[key,{...value}]));for(const run of waiting)run();check()});setImmediate(start)
    return tx
  }}
  const indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess?.());return request}}
  return {rows,indexedDB,failWrites:value=>{fail=value}}
}
