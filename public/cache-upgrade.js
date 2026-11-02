/* Trusted package/build identity and upgrade handling. Never clears credentials. */
;(function(root){
  'use strict'
  const HEX=/^[a-f0-9]{64}$/, loaded=root.document?.querySelector('meta[name="dsh-remote-build"]')?.content
  const script=root.document?.currentScript?.src
  let config,checking=false,banner,autoReloaded=false
  const text=(zh,en)=>root.I18N?.lang==='en'?en:zh
  async function check(){
    if(checking||!config||!HEX.test(loaded||'')||!script)return
    checking=true
    try{
      const url=new URL('build.json',script);url.searchParams.set('fresh',String(Date.now()))
      const response=await root.fetch(url.href,{cache:'no-store',signal:AbortSignal.timeout(5000)})
      if(!response.ok)return
      const next=(await response.json()).buildId
      if(!HEX.test(next||'')||next===loaded)return
      if(!banner){
        banner=root.document.createElement('aside');banner.className='cache-upgrade-notice';banner.setAttribute('role','status')
        banner.style.cssText='position:fixed;z-index:39;top:8px;left:12px;right:12px;padding:12px;background:var(--dsr-panel,#fff);color:var(--dsr-text,#182331);border:1px solid var(--dsr-line,#778899);border-radius:12px;display:flex;gap:10px;align-items:center'
        const copy=root.document.createElement('span'),button=root.document.createElement('button')
        copy.textContent=text('新界面已就绪，重新载入即可更新；未发送内容会保留。','An updated interface is ready. Reload to update; unsent content is preserved.')
        button.type='button';button.textContent=text('重新载入','Reload')
        button.style.minHeight='44px'
        button.addEventListener('click',()=>{if(config.safe())root.location.reload();else root.alert(text('请先处理当前审批、上传或未发送内容，再重新载入。','Finish pending approvals/uploads or save unsent content before reloading.'))})
        banner.append(copy,button);root.document.body.append(banner)
      }
      // A running turn, draft, approval or upload must never be interrupted.
      // One automatic reload per target build also prevents a bad cache loop.
      const key='dshRemoteBuildReload:'+root.location.pathname
      if(!autoReloaded&&config.safe()){
        let saved
        try{saved=root.sessionStorage.getItem(key)}catch{return}
        if(saved===next)return
        try{root.sessionStorage.setItem(key,next);if(root.sessionStorage.getItem(key)!==next)return}catch{return}
        autoReloaded=true;root.location.reload()
      }
    }catch{}finally{checking=false}
  }
  async function migrate(){
    try{const scopes=config?.scopes?.();if(scopes?.length)await root.DshHistory?.migrateLegacy?.(scopes)}catch{}
  }
  function mount(value){
    if(config)return
    config=value
    const run=()=>{void check();void migrate()}
    root.setTimeout(run,1500);root.setInterval(run,60_000)
    root.document?.addEventListener('visibilitychange',()=>{if(!root.document.hidden)run()})
    root.addEventListener?.('online',run)
  }
  root.DshCacheUpgrade={mount,check,migrate}
})(window)
