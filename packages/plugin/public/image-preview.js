/* Shared chat image lightbox. No dependencies, mobile and desktop. */
'use strict';
;(function(root){
  const english=()=>root.I18N?.lang==='en'
  let lightbox=null,stage=null,image=null,closeButton=null,hint=null,opener=null
  let resolver=null,attachmentResolver=null,capture=null,observer=null,mutation=null,generation=0,saver=null
  let currentRef=null,saveMenu=null,saveMenuRef=null,pressTimer=null,pressOrigin=null,pressPointer=null,suppressClickUntil=0
  const objectUrls=new Map()
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  function attachmentRef(attachment){
    if(!attachment||typeof attachment!=='object')return null
    const attachmentId=String(attachment.attachmentId||'')
    if(!/^(?:sha256:)?[a-f0-9]{64}$/.test(attachmentId))return null
    // DSH modern RPC validates the whole reference, not only the storage id.
    return { attachmentId, mediaType:String(attachment.mediaType||''), bytes:Number(attachment.bytes)||0,
      width:Number(attachment.width)||0, height:Number(attachment.height)||0, ...(attachment.name?{name:String(attachment.name)}:{}) }
  }
  function attachmentHtml(attachment,label,sessionId){
    const ref=attachmentRef(attachment)
    if(!ref)return '<span class="chat-image-status">'+escape(label)+'</span>'
    const alt=escape(attachment.name||label)
    return '<button type="button" class="chat-image is-loading" data-chat-image data-chat-image-attachment="'+ref.attachmentId+'" data-chat-image-ref="'+escape(JSON.stringify(ref))+'" data-chat-image-session="'+escape(sessionId)+'" data-chat-image-alt="'+alt+'" aria-label="'+alt+'"><span class="chat-image-status">'+escape(label)+'</span></button>'
  }
  function labels(){
    if(!lightbox)return
    lightbox.setAttribute('aria-label',english()?'Image preview':'图片预览')
    if(closeButton)closeButton.setAttribute('aria-label',english()?'Close':'关闭')
    if(hint)hint.textContent=isZoomed()?(english()?'Double-tap to fit · tap outside to close':'双击还原 · 点空白处关闭'):(english()?'Double-tap to zoom · tap outside to close':'双击放大 · 点空白处关闭')
  }
  function isZoomed(){return !!lightbox?.classList.contains('is-zoomed')}
  function setZoom(on){
    if(!lightbox)return
    lightbox.classList.toggle('is-zoomed',!!on)
    if(image){
      if(on&&image.naturalWidth){image.style.width=image.naturalWidth*2+'px';image.style.height=image.naturalHeight*2+'px'}
      else{image.style.width='';image.style.height=''}
    }
    if(on&&stage)root.requestAnimationFrame?.(()=>{stage.scrollLeft=(stage.scrollWidth-stage.clientWidth)/2;stage.scrollTop=(stage.scrollHeight-stage.clientHeight)/2})
    labels()
  }
  function toggleZoom(){setZoom(!isZoomed())}
  function isOpen(){return !!lightbox&&!lightbox.classList.contains('hidden')}
  function open(src,alt='',ref=null){
    if(!src||!elements())return
    opener=root.document.activeElement||null
    currentRef=ref||null
    image.src=src
    image.alt=alt||(english()?'Image':'图片')
    lightbox.classList.remove('hidden')
    root.document.body?.classList.add('image-preview-open')
    setZoom(false)
    root.requestAnimationFrame?.(()=>lightbox.focus?.({preventScroll:true}))
  }
  function close(){
    if(!lightbox||lightbox.classList.contains('hidden'))return
    closeSaveMenu()
    setZoom(false)
    lightbox.classList.add('hidden')
    root.document.body?.classList.remove('image-preview-open')
    image.removeAttribute?.('src')
    const target=opener;opener=null
    target?.focus?.({preventScroll:true})
  }
  function descriptorFor(trigger){
    if(!trigger)return null
    const attachmentId=trigger.dataset?.chatImageAttachment
    if(attachmentId){
      let ref=null
      try{ref=JSON.parse(trigger.dataset.chatImageRef||'null')}catch{}
      return {kind:'attachment',attachmentId,sessionId:trigger.dataset.chatImageSession||'',name:(ref&&ref.name)||trigger.dataset.chatImageAlt||'',mediaType:ref?.mediaType||''}
    }
    const path=trigger.dataset?.chatImagePath
    return path?{kind:'path',path,name:trigger.dataset.chatImageAlt||''}:null
  }
  function cancelPress(){
    if(pressTimer){clearTimeout(pressTimer);pressTimer=null}
    pressOrigin=null;pressPointer=null
  }
  function closeSaveMenu(){
    if(!saveMenu||saveMenu.classList.contains('hidden'))return false
    saveMenu.classList.add('hidden');saveMenuRef=null;return true
  }
  function openSaveMenu(ref){
    if(!saveMenu||!ref)return
    saveMenuRef=ref
    saveMenu.classList.remove('hidden')
  }
  async function saveRef(ref){
    if(!ref)return
    try{
      if(saver)return await saver(ref)
      // Browser shells without a host-specific saver can still keep the rendered image.
      const src=image?.src
      if(!src)return
      const link=root.document.createElement('a')
      link.href=src;link.download=(ref.name||'image').replace(/[\\/\x00-\x1f]/g,'_').slice(0,200)||'image'
      root.document.body.append(link);link.click();link.remove()
    }catch{}
  }
  // Markdown images may point at a local file. The host shell supplies an authenticated
  // request for that path; load lazily and swap the placeholder for a real previewable image.
  function configure(options={}){
    if(typeof options.resolvePath==='function')resolver=options.resolvePath
    if(typeof options.resolveAttachment==='function')attachmentResolver=options.resolveAttachment
    if(typeof options.capture==='function')capture=options.capture
    if(typeof options.save==='function')saver=options.save
    if(!mutation&&typeof root.MutationObserver==='function'&&root.document?.body){
      // History renders (paging, streaming, cache restore) replace nodes without a full render call.
      mutation=new root.MutationObserver(records=>{
        for(const record of records){
          for(const node of record.addedNodes)if(node?.nodeType===1)hydrate(node)
          if(record.removedNodes?.length)Promise.resolve().then(()=>{
            for(const [button,url] of objectUrls)if(button.isConnected===false){root.URL?.revokeObjectURL?.(url);objectUrls.delete(button)}
          })
        }
      })
      mutation.observe(root.document.body,{childList:true,subtree:true})
    }
    hydrate(root.document)
  }
  function watcher(){
    if(observer)return observer
    if(typeof root.IntersectionObserver!=='function')return null
    observer=new root.IntersectionObserver(entries=>{
      for(const entry of entries){
        if(!entry.isIntersecting)continue
        observer.unobserve(entry.target)
        void loadPathImage(entry.target)
      }
    },{rootMargin:'320px'})
    return observer
  }
  function hydrate(scope){
    if((!resolver&&!attachmentResolver)||!scope?.querySelectorAll)return
    const candidates=[...(scope.matches?.('[data-chat-image][data-chat-image-path]')||scope.matches?.('[data-chat-image][data-chat-image-attachment]')?[scope]:[]),...scope.querySelectorAll('[data-chat-image][data-chat-image-path]'),...scope.querySelectorAll('[data-chat-image][data-chat-image-attachment]')]
    for(const button of candidates){
      if(button.dataset.chatImageAttachment?!attachmentResolver:!resolver)continue
      if(button.dataset.chatImageLoading||button.dataset.chatImageLoaded)continue
      button.dataset.chatImageLoading='1'
      const watch=watcher()
      if(watch)watch.observe(button)
      else void loadPathImage(button)
    }
  }
  async function loadPathImage(button){
    const path=button.dataset.chatImagePath
    const attachmentId=button.dataset.chatImageAttachment
    let attachment=null
    if(attachmentId){
      try{const parsed=JSON.parse(button.dataset.chatImageRef||'null');if(parsed&&parsed.attachmentId===attachmentId)attachment=parsed}catch{}
      if(!attachment)attachment={attachmentId}
    }
    if(attachmentId?!attachmentResolver:(!path||!resolver))return
    const identity=capture?.(),version=generation
    const valid=()=>version===generation&&button.isConnected!==false&&(!identity||identity.valid())
    try{
      let url
      if(root.DshImageCache&&identity?.scope){
        // Scope includes the connection credential hash; attachments are also session-scoped.
        const request=attachmentId?null:await resolver(path)
        if(!valid())return
        const target=typeof request==='string'?{url:request}:request||{}
        const id=attachmentId?JSON.stringify(['attachment',button.dataset.chatImageSession,attachmentId]):JSON.stringify(['path',target.url])
        const value=await root.DshImageCache.load(identity.scope,id,async cached=>{
          if(!valid())throw Error('stale image')
          if(attachmentId){
            const result=await attachmentResolver(attachment,button.dataset.chatImageSession)
            if(result?.attachment?.attachmentId!==attachment.attachmentId||!/^image\/(?:png|jpeg|webp|gif)$/.test(result.attachment.mediaType)||typeof result.data!=='string'||!result.data||result.data.length>16*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data))throw Object.assign(Error('invalid image attachment'),{status:422})
            const binary=root.atob(result.data),bytes=new Uint8Array(binary.length)
            for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i)
            return {blob:new root.Blob([bytes],{type:result.attachment.mediaType})}
          }
          const headers={...target.headers}
          if(cached?.etag)headers['If-None-Match']=cached.etag
          else if(cached?.lastModified)headers['If-Modified-Since']=cached.lastModified
          const read=async signal=>{
            const response=await (root.fetch||fetch)(target.url,{headers,signal,cache:'no-cache'})
            if(response.status===304&&cached)return cached
            if(!response.ok)throw Object.assign(Error('HTTP '+response.status),{status:response.status})
            return {blob:await response.blob(),etag:response.headers?.get('etag'),lastModified:response.headers?.get('last-modified')}
          }
          return root.DshNetwork?.readWithDeadline?root.DshNetwork.readWithDeadline(read,45000):read(root.AbortSignal?.timeout?.(45000))
        },{revalidate:!attachmentId,valid})
        if(!valid())return
        url=root.URL.createObjectURL(value.blob)
        objectUrls.set(button,url)
      }else if(attachmentId){
        const result=await attachmentResolver(attachment,button.dataset.chatImageSession)
        if(result?.attachment?.attachmentId!==attachment.attachmentId||!/^image\/(?:png|jpeg|webp|gif)$/.test(result.attachment.mediaType)||typeof result.data!=='string'||!result.data||result.data.length>16*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data))throw new Error('invalid image attachment')
        url='data:'+result.attachment.mediaType+';base64,'+result.data
      }else{
      const source=await resolver(path)
      const request=typeof source==='string'?{url:source}:source||{}
      const response=await (root.fetch||fetch)(request.url,{headers:request.headers||{}})
      if(!response.ok)throw new Error('HTTP '+response.status)
      const blob=await response.blob()
      if(!blob||!blob.size)throw new Error('empty image')
      url=root.URL?.createObjectURL?root.URL.createObjectURL(blob):''
      if(!url)throw new Error('no blob url')
      objectUrls.set(button,url)
      }
      if(!valid()){release(button);return}
      const node=root.document.createElement('img')
      node.src=url;node.alt=button.dataset.chatImageAlt||'';node.draggable=false;node.loading='lazy'
      node.addEventListener('error',()=>pathImageFailed(button))
      node.addEventListener('load',()=>{button.classList.remove('is-loading');button.classList.add('is-loaded')})
      button.replaceChildren(node)
      button.dataset.chatImageLoaded='1'
    }catch(error){if(valid())pathImageFailed(button)}
  }
  function release(button){const url=objectUrls.get(button);if(url)root.URL?.revokeObjectURL?.(url);objectUrls.delete(button)}
  function reset(){generation++;close();closeSaveMenu();for(const button of objectUrls.keys())release(button)}
  function pathImageFailed(button){
    release(button)
    button.classList.remove('is-loading')
    button.classList.add('is-error')
    const status=button.querySelector?.('.chat-image-status')
    if(status)status.textContent=english()?'Image unavailable':'图片无法加载'
  }
  function elements(){
    if(lightbox)return lightbox
    lightbox=root.document?.getElementById('image-lightbox')
    if(!lightbox)return null
    stage=lightbox.querySelector('[data-image-lightbox-stage]')
    image=lightbox.querySelector('[data-image-lightbox-img]')
    closeButton=lightbox.querySelector('[data-image-lightbox-close]')
    hint=lightbox.querySelector('[data-image-lightbox-hint]')
    closeButton?.addEventListener('click',close)
    lightbox.addEventListener('click',event=>{const target=event.target;if(target===lightbox||target===stage)close()})
    stage?.addEventListener('click',event=>{if(event.target===stage)close()})
    image?.addEventListener('dblclick',event=>{event.preventDefault?.();toggleZoom()})
    root.document.addEventListener('keydown',event=>{if(event.key==='Escape'&&isOpen()){event.preventDefault?.();if(closeSaveMenu())return;close()}})
    // A long press opens a two-action sheet; the preview click below is suppressed after it.
    saveMenu=root.document.getElementById('image-save-menu')
    if(!saveMenu){
      saveMenu=root.document.createElement('div')
      saveMenu.id='image-save-menu'
      saveMenu.className='image-save-menu hidden'
      saveMenu.setAttribute('role','menu')
      saveMenu.innerHTML='<button type="button" role="menuitem" data-image-save-action="save"></button><button type="button" role="menuitem" data-image-save-action="cancel"></button>'
      const mount = root.document.body
      if (mount && typeof mount.appendChild === 'function') mount.appendChild(saveMenu)
      else if (mount && typeof mount.append === 'function') mount.append(saveMenu)
      saveMenu.addEventListener('click',event=>{
        const action=event.target?.closest?.('[data-image-save-action]')?.dataset.imageSaveAction
        if(!action)return
        event.preventDefault?.();event.stopPropagation?.()
        const ref=saveMenuRef
        closeSaveMenu()
        if(action==='save')void saveRef(ref)
      })
    }
    const saveLabel=saveMenu.querySelector('[data-image-save-action="save"]'),cancelLabel=saveMenu.querySelector('[data-image-save-action="cancel"]')
    if(saveLabel)saveLabel.textContent=english()?'Save image':'保存图片'
    if(cancelLabel)cancelLabel.textContent=english()?'Cancel':'取消'
    root.document.addEventListener('pointerdown',event=>{
      if(event.button!==undefined&&event.button!==0)return
      if(saveMenu&&!saveMenu.classList.contains('hidden'))return
      const trigger=event.target?.closest?.('[data-chat-image]')
      const inPreview=event.target===image
      if(!trigger&&!inPreview)return
      if(pressTimer){cancelPress();return}
      const ref=inPreview?currentRef:descriptorFor(trigger)
      if(!ref)return
      pressPointer=event.pointerId
      pressOrigin={x:event.clientX,y:event.clientY}
      pressTimer=setTimeout(()=>{pressTimer=null;suppressClickUntil=Date.now()+900;openSaveMenu(ref)},520)
    },true)
    root.document.addEventListener('pointermove',event=>{
      if(!pressTimer||!pressOrigin)return
      if(Math.hypot(event.clientX-pressOrigin.x,event.clientY-pressOrigin.y)>10)cancelPress()
    },true)
    root.document.addEventListener('pointerup',cancelPress,true)
    root.document.addEventListener('pointercancel',cancelPress,true)
    root.document.addEventListener('contextmenu',event=>{
      if(event.target?.closest?.('[data-chat-image]')||event.target===image)event.preventDefault?.()
    })
    // Chat images live inside rendered history: delegate instead of rebinding per message.
    root.document.addEventListener('click',event=>{
      if(Date.now()<suppressClickUntil)return
      const trigger=event.target?.closest?.('[data-chat-image]')
      if(!trigger)return
      const img=trigger.querySelector?.('img')
      if(img?.src)open(img.src,img.alt||'',descriptorFor(trigger))
    })
    return lightbox
  }
  root.DshImagePreview={open,close,isOpen,zoom:toggleZoom,mount:elements,configure,hydrate,attachmentHtml,reset,closeSaveMenu}
  root.document?.addEventListener('DOMContentLoaded',()=>{elements();hydrate(root.document)})
})(typeof window==='undefined'?globalThis:window)
