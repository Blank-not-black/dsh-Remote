/* Optional plugin views. Entry points belong to installed plugins and session actions. */
'use strict';
window.DshExtensions = (() => {
  let current, cache
  const catalog = [
    { id: 'skills', name: '@linxin666/dsh-client-ui-skill-explorer', label: '打开技能中心' },
    { id: 'cost', name: 'dsh-cost-meter', label: '查看费用与额度' },
    { id: 'context', name: 'dsh-context', label: '查看当前会话上下文', session: true },
  ]
  const empty = () => ({ known: false, skills: false, cost: false, context: false })
  function capabilitiesOf(snapshot) {
    if (snapshot?.ok !== true || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.runtime)) return empty()
    const result = { ...empty(), known: true }
    for (const feature of catalog) {
      const item = snapshot.items.find(row => row?.name === feature.name)
      if (item?.enabled !== true || snapshot.runtimeAvailable !== true) continue
      if (item.runtime != null && !Array.isArray(item.runtime)) continue
      const runtime = [...(item.runtime || []), ...snapshot.runtime.filter(row => row?.name === feature.name)]
      result[feature.id] = runtime.length > 0 && runtime.every(row => row && row.enabled !== false && row.phase === 'active')
    }
    return result
  }
  function featuresFor(snapshot, item, session = false) {
    const available = capabilitiesOf(snapshot)
    return catalog.filter(feature => feature.name === item.name && available[feature.id] && (!feature.session || session))
  }
  function identity(config) { return config.connection || config }
  function same(config) {
    const next = identity(config)
    return cache && cache.connection.valid() && next.valid() && cache.connection.server === next.server && cache.connection.token === next.token
  }
  function remember(config, snapshot) {
    if (!config.valid()) return
    if (!same(config)) { cache?.controller?.abort(); cache = { connection: identity(config) } }
    cache.value = capabilitiesOf(snapshot); cache.at = Date.now()
    cache.serial = (cache.serial || 0) + 1
  }
  function invalidateCapabilities() { cache?.controller?.abort(); cache = null }
  async function getCapabilities(config) {
    if (!config.valid()) return empty()
    if (!same(config)) { invalidateCapabilities(); cache = { connection: identity(config) } }
    const record = cache
    if (record.value && Date.now() - record.at < 15000) return record.value
    if (record.task) return record.task
    record.controller = new AbortController()
    const serial = record.serial || 0
    record.task = (async () => {
      try {
        const response = await fetch(config.url('/remote/api/plugins/state'), { headers: config.headers,
          signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(15000)]) })
        const body = await response.text()
        if (body.length > 2 * 1024 * 1024) return empty()
        const snapshot = JSON.parse(body)
        if (!response.ok || !config.valid() || cache !== record || snapshot?.ok !== true) return empty()
        if ((record.serial || 0) !== serial) return record.value || empty()
        record.value = capabilitiesOf(snapshot); record.at = Date.now(); return record.value
      } catch {
        if (cache === record && config.valid() && (record.serial || 0) !== serial) return record.value || empty()
        if (cache === record) { record.value = empty(); record.at = Date.now() }
        return empty()
      }
      finally { record.task = null }
    })()
    return record.task
  }
  const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el}
  const stopViews=()=>{window.DshSkillsCenter?.close();window.DshInsights?.close()}
  function close(){if(current){const old=current;current=null;stopViews();window.DshPluginCenter?.close();old.target.replaceChildren()}}
  function mount(config,target,initial='manage') {
    close()
    const s={config,target,route:'manage',navigation:0};current=s
    const valid=()=>current===s&&config.valid()
    const root=node('section',null,'ext-page'),header=node('header',null,'ext-header'),back=node('button','← 返回插件列表'),hint=node('p',null,'ext-host'),content=node('div',null,'ext-content'),manager=node('div',null,'ext-manager'),view=node('div',null,'ext-view')
    back.type='button';header.append(back,hint);content.append(manager,view);root.append(header,content);target.replaceChildren(root)
    try{hint.textContent='当前主机 · '+new URL(config.connection.server).host}catch{hint.textContent='当前连接的主机'}
    async function navigate(route) {
      if(!valid())return
      const navigation=++s.navigation
      if(route==='home')route='manage'
      if(route==='context'){config.openContext?.();return}
      if(route!=='manage'){
        const available=await getCapabilities(config)
        if(!valid()||navigation!==s.navigation)return
        if(!available[route]){navigate('manage');return}
        if(s.route==='manage'){s.scroller=scrollParent(root);s.scroll=s.scroller?.scrollTop||0;window.DshPluginCenter?.pause()}
      }
      stopViews();s.route=route;view.replaceChildren();header.hidden=route==='manage'&&!config.back;manager.hidden=route!=='manage';view.hidden=route==='manage';root.className='ext-page'+(route==='manage'?' is-manage':'')
      back.textContent=route==='manage'?(window.I18N?.lang==='en'?'← Back to More':'← 返回更多'):(window.I18N?.lang==='en'?'← Back to plugins':'← 返回插件列表')
      if(route==='manage'){
        if(!s.mounted){s.mounted=true;await window.DshPluginCenter.mount({...config,onFeature:navigate},manager)}
        else {if(s.scroller)s.scroller.scrollTop=s.scroll;void window.DshPluginCenter.resume()}
      }else if(route==='skills')await window.DshSkillsCenter.mount(config,view,{dedicated:true})
      else window.DshInsights.mount({tab:'cost',hostOverview:true,allowedTabs:['cost'],connection:config.connection,url:config.url},view)
      if(valid()&&route!=='manage')config.scrollTop?.()
    }
    back.addEventListener('click',()=>{if(valid()){if(s.route==='manage')config.back?.();else void navigate('manage')}})
    void navigate('manage').then(()=>{if(initial!=='manage'&&initial!=='home'&&valid())void navigate(initial)})
  }
  function scrollParent(el) {
    for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight&&/auto|scroll/.test(getComputedStyle(parent).overflowY))return parent
    return document.scrollingElement
  }
  return {mount,close,capabilitiesOf,featuresFor,getCapabilities,remember,invalidateCapabilities}
})()
