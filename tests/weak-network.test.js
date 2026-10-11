'use strict'
const { test }=require('node:test'),assert=require('node:assert/strict')
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),vm=require('node:vm')
const {createRealisticStack}=require('./fixtures/realistic-stack.cjs')
function request(url,headers={},method='GET',body){return new Promise((resolve,reject)=>{
 const req=http.request(url,{headers,method},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));res.on('error',reject)})
 req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('request timeout')));req.end(body)
})}
test('Gateway gzip and ETag reduce actual transferred JS bytes and retain exact decoded content',async t=>{
 const s=await createRealisticStack();t.after(()=>s.stop())
 const identity=await request(s.base+'/app.js',{'accept-encoding':'identity'}),gz=await request(s.base+'/app.js',{'accept-encoding':'gzip'})
 assert.equal(gz.headers['content-encoding'],'gzip');assert.match(gz.headers.vary,/Accept-Encoding/);assert.match(gz.headers.vary,/Origin/)
 assert.ok(gz.body.length<identity.body.length*0.4);assert.deepEqual(zlib.gunzipSync(gz.body),identity.body)
 t.diagnostic(JSON.stringify({resource:'app.js',identityBytes:identity.body.length,gzipBytes:gz.body.length}))
 const cached=await request(s.base+'/app.js',{'accept-encoding':'gzip','if-none-match':gz.headers.etag});assert.equal(cached.status,304);assert.equal(cached.body.length,0)
 const otherVariant=await request(s.base+'/app.js',{'accept-encoding':'identity','if-none-match':gz.headers.etag});assert.equal(otherVariant.status,200)
 const noGzip=await request(s.base+'/app.js',{'accept-encoding':'gzip;q=0, *;q=1'});assert.equal(noGzip.headers['content-encoding'],undefined)
 const head=await request(s.base+'/app.js',{'accept-encoding':'gzip'},'HEAD');assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),identity.body.length)
 const small=await request(s.base+'/version.json',{'accept-encoding':'gzip'});assert.equal(small.headers['content-encoding'],undefined)
})
test('Gateway compresses authenticated large history without changing its contract or caching private data',async t=>{
 const s=await createRealisticStack();t.after(()=>s.stop())
 for(let i=0;i<40;i++)s.dsh.state.history.push({seq:i+100,type:'assistant/message',data:{content:[{type:'text',text:'弱网测试 repeated history content '.repeat(150)}]}})
 const body=JSON.stringify({type:'client-request',rpcId:'slow-history',method:'session.history',payload:{sessionId:'session-1',maxMessages:60}})
 const headers={'content-type':'application/json',authorization:'Bearer '+s.token,'accept-encoding':'gzip'}
 const r=await request(s.base+'/api/session.history',headers,'POST',body)
 assert.equal(r.status,200);assert.equal(r.headers['content-encoding'],'gzip');assert.equal(r.headers['cache-control'],'no-store')
 assert.equal(Number(r.headers['content-length']),r.body.length);const raw=zlib.gunzipSync(r.body),v=JSON.parse(raw)
 assert.equal(v.result.ok,true);assert.ok(v.result.value.events.length>30);assert.ok(r.body.length<raw.length*0.3)
 t.diagnostic(JSON.stringify({resource:'session.history',identityBytes:raw.length,gzipBytes:r.body.length}))
 const denied=await request(s.base+'/api/session.history',{'content-type':'application/json','accept-encoding':'gzip'},'POST',body);assert.equal(denied.status,401);assert.equal(denied.headers['content-encoding'],undefined)
 const ticket=await request(s.base+'/api/ws-ticket',headers,'POST');assert.equal(ticket.headers['content-encoding'],undefined)
})
test('Compression policy skips encoded data, SSE, ranges, HEAD, no-transform and ineffective compression',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../gateway.js'),'utf8'),code=source.slice(source.indexOf('const HTTP_COMPRESSION'),source.indexOf('// Crash records'))
 for(const variant of ['sse','range','head','encoded','no-transform','noise']){
  let h,bytes;const res={req:{method:variant==='head'?'HEAD':'GET',headers:{'accept-encoding':'gzip',...(variant==='range'?{range:'bytes=0-100'}:{})}},writeHead:(status,headers)=>h=headers,end:b=>bytes=b}
  const c=vm.createContext({Buffer,zlib,process:{env:{}}});vm.runInContext(code+';this.send=sendHttpBody',c)
  const data=variant==='noise'?require('node:crypto').randomBytes(4096):Buffer.from('x'.repeat(4096))
  c.send(res,200,{'content-type':variant==='sse'?'text/event-stream':'application/json',...(variant==='encoded'?{'content-encoding':'br'}:{}),...(variant==='no-transform'?{'cache-control':'no-transform'}:{})},data,true)
  if(variant==='noise')await new Promise(r=>setTimeout(r,30))
  assert.notEqual(h['content-encoding'],'gzip');if(variant!=='head')assert.deepEqual(bytes,data)
 }
})
