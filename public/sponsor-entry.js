/* Shared, visible sponsorship entry. The application page owns availability and review. */
;(function(root) {
  'use strict'
  const applicationUrl='https://relay-pilot.blankalwaysgoeson.site/sponsor/'
  const entries=new WeakMap()
  function mount(target) {
    if(!target)return
    let entry=entries.get(target)
    if(!entry){
      const line=document.createElement('p'),link=document.createElement('a'),note=document.createElement('span')
      line.className='sponsor-entry';link.href=applicationUrl;link.target='_blank';link.rel='noopener noreferrer'
      line.append(link,note);target.append(line);entry={line,link,note};entries.set(target,entry)
    }
    const en=root.I18N?.lang==='en'
    entry.link.textContent=en?'Sponsor ¥1 or more · Apply for one month of basic relay':'赞助 ¥1 及以上 · 申请一个月基础中转'
    entry.note.textContent=en?' · Manual payment verification; 5GB per service month, one gateway, no file transfer.':' · 人工核验到账后开通，服务月 5GB，单网关，不含文件传输。'
    return entry.line
  }
  root.DshSponsor={applicationUrl,mount}
  for(const body of document.querySelectorAll('.donate-body'))mount(body)
})(typeof window!=='undefined'?window:globalThis)
