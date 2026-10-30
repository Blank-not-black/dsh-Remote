/* Persistent chat images. Native IndexedDB only; credentials never enter records. */
'use strict';
;(function(root){
  const LIMIT=200*1024*1024, ITEM_LIMIT=12*1024*1024, MAX_ITEMS=500, MAX_AGE=30*86400000, TIMEOUT=1500
  let database, epoch=0
  const pending=new Map(),scopeEpoch=new Map()
  const versionOf=scope=>epoch+':'+(scopeEpoch.get(scope)||0)
  const CONTROL='!cache-control',revisionOf=(control,scope)=>(control?.all||0)+':'+(control?.scopes?.[scope]||0)
  function open(){
    if(database)return database
    database=new Promise(resolve=>{
      let request,settled=false
      const finish=db=>{if(settled){db?.close();return}settled=true;clearTimeout(timer);resolve(db)}
      const timer=setTimeout(()=>finish(null),TIMEOUT)
      try{
        request=root.indexedDB.open('dshRemoteImagesV1',1)
        request.onupgradeneeded=()=>request.result.createObjectStore('images',{keyPath:'key'}).createIndex('accessedAt','accessedAt')
        request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=null};finish(db)}
        request.onerror=request.onblocked=()=>finish(null)
      }catch{finish(null)}
    })
    return database
  }
  async function transaction(mode,action,fallback){
    const db=await open()
    if(!db)return fallback
    return new Promise(resolve=>{
      let tx,value=fallback,settled=false
      const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result)}
      const timer=setTimeout(()=>{finish(fallback);try{tx?.abort()}catch{}},TIMEOUT)
      try{
        tx=db.transaction('images',mode)
        tx.oncomplete=()=>finish(value);tx.onerror=tx.onabort=()=>finish(fallback)
        action(tx.objectStore('images'),result=>{value=result})
      }catch{finish(fallback);try{tx?.abort()}catch{}}
    })
  }
  const keyOf=(scope,id)=>JSON.stringify([scope,id])
  const usable=row=>row?.blob instanceof root.Blob && row.blob.size>0 && row.blob.size<=ITEM_LIMIT && /^image\/(?:png|jpeg|webp|gif|bmp|avif|svg\+xml)$/.test(row.blob.type)
  async function read(key,scope){
    return transaction('readwrite',(store,result)=>{
      const snapshot={row:null,revision:'0:0'};result(snapshot)
      const control=store.get(CONTROL)
      control.onsuccess=()=>{snapshot.revision=revisionOf(control.result,scope)}
      const request=store.get(key)
      request.onsuccess=()=>{
        const row=request.result
        if(!usable(row)||!Number.isFinite(row.accessedAt)||Date.now()-row.accessedAt>MAX_AGE){if(row)store.delete(key);return}
        row.accessedAt=Date.now();store.put(row);snapshot.row=row
      }
    },{row:null,revision:null})
  }
  async function save(row,version,valid,revision,retry=true){
    if(revision===null||!usable(row)||version!==versionOf(row.scope)||!valid())return false
    const saved=await transaction('readwrite',(store,result)=>{
      if(version!==versionOf(row.scope)||!valid())return
      const control=store.get(CONTROL)
      control.onsuccess=()=>{
        // A clear in another tab must also invalidate this outstanding download.
        if(revision!==revisionOf(control.result,row.scope)){result('cleared');return}
        store.put(row)
        const rows=[];let bytes=0
        const request=store.index('accessedAt').openCursor()
        request.onsuccess=()=>{
          const cursor=request.result
          if(cursor){if(cursor.primaryKey===CONTROL){cursor.continue();return}const value=cursor.value;if(!usable(value)||!Number.isFinite(value.accessedAt)||Date.now()-value.accessedAt>MAX_AGE)cursor.delete();else{rows.push({key:cursor.primaryKey,size:value.blob.size});bytes+=value.blob.size}cursor.continue();return}
          while(bytes>LIMIT||rows.length>MAX_ITEMS){const old=rows.shift();bytes-=old.size;store.delete(old.key)}
          result(true)
        }
      }
    },false)
    if(saved||!retry||version!==versionOf(row.scope)||!valid())return saved
    // Browser quota may be lower than our cap. Free oldest images and retry once.
    const freed=await transaction('readwrite',(store,result)=>{
      if(version!==versionOf(row.scope)||!valid())return
      let bytes=0
      const request=store.index('accessedAt').openCursor()
      request.onsuccess=()=>{const cursor=request.result;if(!cursor||bytes>=row.blob.size){result(true);return}if(cursor.primaryKey!==CONTROL){bytes+=cursor.value.blob?.size||0;cursor.delete()}cursor.continue()}
    },false)
    return freed?save(row,version,valid,revision,false):false
  }
  async function load(scope,id,loader,{revalidate=false,valid=()=>true}={}){
    if(!scope||!id)throw Error('Missing image identity')
    const key=keyOf(scope,id),version=versionOf(scope)
    const check=()=>{if(version!==versionOf(scope)||!valid())throw Error('stale image')}
    check()
    if(pending.has(key)){const value=await pending.get(key);check();return value}
    const job=(async()=>{
      const snapshot=await read(key,scope),cached=snapshot.row;check()
      if(cached&&!revalidate)return cached
      let value=cached
      if(!cached||revalidate){
        try{value=await loader(cached)}catch(error){
          // Offline reuse is allowed, authentication or missing-file failures are not.
          if(!cached||error.status||error.message==='stale image'){
            if(cached&&error.status)await transaction('readwrite',store=>store.delete(key),false)
            throw error
          }
          value=cached
        }
      }
      check()
      if(!(value?.blob instanceof root.Blob)||!value.blob.size||!/^image\/(?:png|jpeg|webp|gif|bmp|avif|svg\+xml)$/.test(value.blob.type))throw Error('Invalid image data')
      const saved=await save({key,scope,blob:value.blob,etag:String(value.etag||'').slice(0,512),lastModified:String(value.lastModified||'').slice(0,128),accessedAt:Date.now()},version,valid,snapshot.revision)
      if(saved==='cleared')throw Error('stale image')
      check();return value
    })()
    pending.set(key,job)
    try{return await job}finally{if(pending.get(key)===job)pending.delete(key)}
  }
  async function clear(scope){
    if(scope===undefined){epoch++;pending.clear();scopeEpoch.clear()}
    else{scopeEpoch.set(scope,(scopeEpoch.get(scope)||0)+1);for(const key of pending.keys())if(JSON.parse(key)[0]===scope)pending.delete(key)}
    return transaction('readwrite',(store,result)=>{
      const request=store.get(CONTROL)
      request.onsuccess=()=>{
        const control=request.result||{key:CONTROL,all:0,scopes:{}}
        if(scope===undefined){control.all++;control.scopes={};store.clear();store.put(control);result(true);return}
        control.scopes[scope]=(control.scopes[scope]||0)+1;store.put(control)
        const rows=store.openCursor()
        rows.onsuccess=()=>{const cursor=rows.result;if(!cursor){result(true);return}if(cursor.value.scope===scope)cursor.delete();cursor.continue()}
      }
    },false)
  }
  async function stats(){
    return transaction('readwrite',(store,result)=>{
      let count=0,bytes=0
      const request=store.openCursor()
      request.onsuccess=()=>{
        const cursor=request.result
        if(!cursor){result({available:true,count,bytes,limitBytes:LIMIT});return}
        if(cursor.primaryKey===CONTROL){cursor.continue();return}
        const row=cursor.value
        if(!usable(row)||!Number.isFinite(row.accessedAt)||Date.now()-row.accessedAt>MAX_AGE)cursor.delete()
        else{count++;bytes+=row.blob.size}
        cursor.continue()
      }
    },{available:false,count:0,bytes:0,limitBytes:LIMIT})
  }
  root.DshImageCache={load,clear,stats,limitBytes:LIMIT,itemLimitBytes:ITEM_LIMIT}
})(typeof window==='undefined'?globalThis:window)
