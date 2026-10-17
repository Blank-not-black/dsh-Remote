/* Shared chat image lightbox. No dependencies, mobile and desktop. */
'use strict';
;(function(root){
  const english=()=>root.I18N?.lang==='en'
  let lightbox=null,stage=null,image=null,closeButton=null,hint=null,opener=null
  let resolver=null,observer=null,mutation=null
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
  function open(src,alt=''){
    if(!src||!elements())return
    opener=root.document.activeElement||null
    image.src=src
    image.alt=alt||(english()?'Image':'图片')
    lightbox.classList.remove('hidden')
    root.document.body?.classList.add('image-preview-open')
    setZoom(false)
    root.requestAnimationFrame?.(()=>lightbox.focus?.({preventScroll:true}))
  }
  function close(){
    if(!lightbox||lightbox.classList.contains('hidden'))return
    setZoom(false)
    lightbox.classList.add('hidden')
    root.document.body?.classList.remove('image-preview-open')
    image.removeAttribute?.('src')
    const target=opener;opener=null
    target?.focus?.({preventScroll:true})
  }
  // Markdown images may point at a local file. The host shell supplies an authenticated
  // request for that path; load lazily and swap the placeholder for a real previewable image.
  function configure(options={}){
    if(typeof options.resolvePath==='function')resolver=options.resolvePath
    if(!mutation&&typeof root.MutationObserver==='function'&&root.document?.body){
      // History renders (paging, streaming, cache restore) replace nodes without a full render call.
      mutation=new root.MutationObserver(records=>{
        for(const record of records)for(const node of record.addedNodes)if(node?.nodeType===1)hydrate(node)
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
    if(!resolver||!scope?.querySelectorAll)return
    const candidates=[...(scope.matches?.('[data-chat-image][data-chat-image-path]')?[scope]:[]),...scope.querySelectorAll('[data-chat-image][data-chat-image-path]')]
    for(const button of candidates){
      if(button.dataset.chatImageLoading||button.dataset.chatImageLoaded)continue
      button.dataset.chatImageLoading='1'
      const watch=watcher()
      if(watch)watch.observe(button)
      else void loadPathImage(button)
    }
  }
  async function loadPathImage(button){
    const path=button.dataset.chatImagePath
    if(!path||!resolver)return
    try{
      const source=await resolver(path)
      const request=typeof source==='string'?{url:source}:source||{}
      const response=await (root.fetch||fetch)(request.url,{headers:request.headers||{}})
      if(!response.ok)throw new Error('HTTP '+response.status)
      const blob=await response.blob()
      if(!blob||!blob.size)throw new Error('empty image')
      const url=root.URL?.createObjectURL?root.URL.createObjectURL(blob):''
      if(!url)throw new Error('no blob url')
      const node=root.document.createElement('img')
      node.src=url;node.alt=button.dataset.chatImageAlt||'';node.draggable=false;node.loading='lazy'
      node.addEventListener('error',()=>pathImageFailed(button))
      node.addEventListener('load',()=>{button.classList.remove('is-loading');button.classList.add('is-loaded')})
      button.replaceChildren(node)
      button.dataset.chatImageLoaded='1'
      delete button.dataset.chatImagePath
    }catch(error){pathImageFailed(button)}
  }
  function pathImageFailed(button){
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
    root.document.addEventListener('keydown',event=>{if(event.key==='Escape'&&isOpen()){event.preventDefault?.();close()}})
    // Chat images live inside rendered history: delegate instead of rebinding per message.
    root.document.addEventListener('click',event=>{
      const trigger=event.target?.closest?.('[data-chat-image]')
      if(!trigger)return
      const img=trigger.querySelector?.('img')
      if(img?.src)open(img.src,img.alt||'')
    })
    return lightbox
  }
  root.DshImagePreview={open,close,isOpen,zoom:toggleZoom,mount:elements,configure,hydrate}
  root.document?.addEventListener('DOMContentLoaded',()=>{elements();hydrate(root.document)})
})(typeof window==='undefined'?globalThis:window)
