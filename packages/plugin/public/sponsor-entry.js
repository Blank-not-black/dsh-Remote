/* Shared, visible sponsorship entry. The application page owns availability and review. */
;(function(root) {
  'use strict'
  const applicationUrl='https://relay-pilot.blankalwaysgoeson.site/sponsor/'
  const entries=new WeakMap()
  let inAppEntry=null
  function openPortal(manage=false) {
    if(manage&&typeof root.NativeBackground?.openCloudRelayManagement==='function')root.NativeBackground.openCloudRelayManagement()
    else if(typeof root.NativeBackground?.openCloudRelay==='function')root.NativeBackground.openCloudRelay()
    else return false
    return true
  }
  function mount(target) {
    if(!target)return
    let entry=entries.get(target)
    if(!entry){
      const line=document.createElement('p'),link=document.createElement('a'),note=document.createElement('span')
      line.className='sponsor-entry';link.href=applicationUrl;link.target='_blank';link.rel='noopener noreferrer'
      link.addEventListener('click',event=>{if(inAppEntry){event.preventDefault();inAppEntry()}})
      line.append(link,note);target.append(line);entry={line,link,note};entries.set(target,entry)
    }
    const en=root.I18N?.lang==='en'
    entry.link.textContent=en?'Cloud relay · Apply, check status or renew':'云中转 · 开通、查询与续费'
    entry.note.textContent=en?'From ¥1, manually verified. 5GB per service month, one gateway, no file transfer.':'赞助 ¥1 起，人工核验；服务月 5GB，单网关，不含文件传输。'
    return entry.line
  }
  root.DshSponsor={applicationUrl,mount,openPortal,setInAppEntry:entry=>{inAppEntry=entry}}
  for(const body of document.querySelectorAll('.donate-body'))mount(body)
})(typeof window!=='undefined'?window:globalThis)
