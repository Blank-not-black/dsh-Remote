import { once } from 'node:events'
export async function serveSessionFile(ctx, req, res, url) {
  const send = (status, code) => { res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify({ok:false,code})) }
  if (!['GET','HEAD'].includes(req.method)) return send(405,'read-only')
  const sessionId=url.searchParams.get('sessionId'),id=url.searchParams.get('attachmentId')
  if (!sessionId || sessionId.length>200 || !/^[a-f0-9]{64}$/.test(id||'') || [...url.searchParams.keys()].some(k=>!['sessionId','attachmentId','token'].includes(k)) || url.searchParams.getAll('attachmentId').length!==1 || url.searchParams.getAll('sessionId').length!==1) return send(400,'invalid-reference')
  let controller,store
  try {controller=ctx.get?.('sessionController');store=ctx.get?.('attachments')}catch{return send(503,'files-unsupported')}
  const abort=new AbortController()
  if (!controller?.inspect || !store?.readFileStream) return send(503,'files-unsupported')
  const cancel=()=>abort.abort();res.once('close',cancel)
  try {
    const inspection=await controller.inspect(sessionId,abort.signal)
    let ref
    for (const event of inspection?.events||[]) {
      if (!['user/message','assistant/message','tool/result'].includes(event.type)) continue
      const blocks=event.data?.message?.content||event.data?.content||[]
      if (!Array.isArray(blocks)) continue
      ref=blocks.find(b=>b?.type==='file'&&b.attachment?.attachmentId===id)?.attachment
      if(ref)break
    }
    if (!ref) return send(404,'file-not-in-session')
    if (!Number.isSafeInteger(ref.bytes)||ref.bytes<0||typeof ref.name!=='string') return send(502,'invalid-host-reference')
    const name=ref.name.replace(/[\\/\r\n"\x00-\x1f]/g,'_').slice(0,200)||'download'
    const headers={'content-type':'application/octet-stream','content-length':String(ref.bytes),'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),'cache-control':'private, no-store','x-content-type-options':'nosniff'}
    if(req.method==='HEAD'){res.writeHead(200,headers);return res.end()}
    const stream=store.readFileStream(ref,abort.signal)[Symbol.asyncIterator](),first=await stream.next()
    res.writeHead(200,headers)
    let bytes=0,next=first
    try { while(!next.done){abort.signal.throwIfAborted();const chunk=Buffer.from(next.value);bytes+=chunk.length;if(bytes>ref.bytes)throw Error('size');if(!res.write(chunk))await once(res,'drain',{signal:abort.signal});next=await stream.next()}if(bytes!==ref.bytes)throw Error('size');res.end() }
    finally{await stream.return?.()}
  } catch { if(res.headersSent)res.destroy();else if(!res.destroyed)send(502,'file-unavailable') }
  finally {res.off('close',cancel)}
}
