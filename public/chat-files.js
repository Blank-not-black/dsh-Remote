/* Explicit user downloads only; attachment IDs never become filesystem paths. */
(function(root,factory){const api=factory(root);if(typeof module==='object')module.exports=api;root.DshChatFiles=api})(typeof window!=='undefined'?window:globalThis,(root)=>{
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
 function relativePath(path) {
  return typeof path==='string' && !!path && path.length<=4096 && !/[\x00-\x1f]/.test(path) && !/^(?:[a-z][a-z0-9+.-]*:|[\\/]|#|\?)/i.test(path)
   && !/^[a-f0-9]{64}$/i.test(path) && !/[?#]/.test(path)
   && (/^\.{1,2}[\\/]/.test(path) || /(?:^|[\\/])[^\\/]+\.[^\\/.]+$/.test(path))
 }
 function pathOf(value,cwd='') {
  if(typeof value!=='string'||value.length>4096||/[\x00-\x1f]/.test(value))return ''
  let path=value.trim()
  if(/^file:/i.test(path)){try{const u=new URL(path);if(u.hostname&&u.hostname!=='localhost')return '';path=decodeURIComponent(u.pathname);if(/^\/[a-z]:\//i.test(path))path=path.slice(1)}catch{return ''}}
  if(/[\x00-\x1f]/.test(path))return ''
  if(/^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path))return path
  if(relativePath(path)){const base=pathOf(cwd);if(base)return base.replace(/[\\/]+$/,'')+'/'+path}
  return ''
 }

 function render(block) {
  const a=block.attachment||block,raw=a.path||block.path||''
  const path=pathOf(raw)||(relativePath(raw)?raw:''),id=/^[a-f0-9]{64}$/.test(a.attachmentId||'')?a.attachmentId:''
  const name=a.name||block.name||'file'
  return `<div class="chat-file"><span class="chat-file-name">📎 ${esc(name)} <small>${esc(a.bytes??block.bytes??'')} bytes</small></span>${id||path?`<button type="button" ${id?'data-dsh-attachment="'+esc(id)+'"':''} ${path?'data-dsh-file-path="'+esc(path)+'"':''} data-dsh-file-name="${esc(name)}">下载文件</button>`:''}</div>`
 }
 async function trackDownload(id,control,c) {
  // New shells expose DownloadManager state; older shells keep their enqueue-only contract.
  for (;;) {
   await new Promise(resolve=>setTimeout(resolve,1000))
   if(!c.valid() || control.isConnected===false)return
   const status=JSON.parse(root.NativeFile.getFileDownloadStatus(String(id))||'{}')
   if(status.phase==='complete'){
    control.textContent='下载完成 · 再次下载'
    c.notice('下载完成：下载/dsh-remote/'+status.name,'ok');return
   }
   if(status.phase==='error')throw Error(status.error||'下载失败，请重试')
   if(status.phase==='unknown')throw Error('系统下载任务已移除，请重试')
   control.textContent=status.phase==='paused'?'下载暂停，等待网络…':'下载中…'
  }
 }
 function bind(target,config){target.addEventListener('click',async event=>{
  const control=event.target.closest?.('[data-dsh-file-path],[data-dsh-attachment]')
  if(!control||!target.contains(control)||control.getAttribute('aria-busy')==='true')return
  event.preventDefault()
  const c=config(),id=control.dataset.dshAttachment,path=pathOf(control.dataset.dshFilePath,c.cwd)
  if(!c.valid())return
  if(!id&&!path){c.notice('无法定位文件，请核对当前会话的工作目录','err');return}
  const name=(control.dataset.dshFileName||path.split(/[\\/]/).pop()||'download').replace(/[\\/\x00-\x1f]/g,'_')
  const makeUrl=attachment=>{
   const url=new URL(c.server+(attachment?'/remote/api/session-file':'/fs/file'),root.location?.href)
   if(attachment){url.searchParams.set('sessionId',c.sessionId);url.searchParams.set('attachmentId',id)}
   else url.searchParams.set('path',path)
   return url
  }
  const head=url=>fetch(url,{method:'HEAD',redirect:'error',headers:c.headers,signal:AbortSignal.timeout(15000)})
  const original=control.textContent
  control.setAttribute('aria-busy','true')
  try{
   let url=makeUrl(!!id),response=await head(url)
   if(!c.valid())return
   // Only an explicit host path can back up an unsupported attachment endpoint.
   if(id&&path&&[404,405,501,503].includes(response.status)){
    url=makeUrl(false);response=await head(url);if(!c.valid())return
   }
   if(!response.ok)throw Error(response.status===403?'主机不允许下载这个文件':response.status===404?'文件不存在或不属于当前会话':[405,501,503].includes(response.status)?'主机版本暂不支持附件下载，请更新主机插件':'文件下载失败（HTTP '+response.status+'）')
   if(c.native){
    if(!root.NativeFile?.downloadToDownloads)throw Error('当前 App 不支持系统下载，请更新 App')
    const task=root.NativeFile.downloadToDownloads(url.href,name,c.token)
    if(root.NativeFile.getFileDownloadStatus&&!task)throw Error('系统下载未能启动，请重试')
    c.notice('已交给系统下载，请在下载目录查看','ok')
    if(root.NativeFile.getFileDownloadStatus&&task){
     control.textContent='下载中…'
     await trackDownload(task,control,c)
    }
   }else{
    if(c.token)url.searchParams.set('token',c.token)
    const link=document.createElement('a');link.href=url.href;link.download=name;link.referrerPolicy='no-referrer'
    document.body.append(link);link.click();link.remove()
    c.notice('已交给浏览器下载，请在下载目录查看','ok')
   }
  }catch(error){
   if(c.valid()){control.textContent=original;c.notice(error.message,'err')}
  }finally{control.removeAttribute('aria-busy')}
 })}
 return {pathOf,relativePath,render,bind}
})
