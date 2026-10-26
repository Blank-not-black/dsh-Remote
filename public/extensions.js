/* Optional plugin views. Entry points belong to installed plugins and session actions. */
'use strict';
window.DshExtensions = (() => {
  let current, cache
  let shortcuts
  const catalog = [
    { id: 'skills', name: '@linxin666/dsh-client-ui-skill-explorer', label: '打开技能中心', summary: '浏览、搜索和阅读主机上的技能', verified: '0.4.6' },
    { id: 'teams', name: '@nanmicoder/dsh-agent-teams', label: '查看智能体团队', summary: '查看智能体团队、任务与成员状态', verified: '0.1.24-rc.1' },
    { id: 'cost', name: 'dsh-cost-meter', label: '查看费用与额度', summary: '查看费用、套餐额度与峰谷提醒', verified: '1.8.17' },
    { id: 'context', name: 'dsh-context', label: '查看当前会话上下文', session: true, summary: '查看会话上下文用量与构成', verified: '0.64.0' },
    { id: 'tasks', name: '@linxin666/dsh-client-ui-task-board', label: '查看任务看板', summary: '只读查看任务、执行结果与计划时间', verified: '0.4.8' },
  ]
  const empty = () => ({ known: false, skills: false, cost: false, context: false, teams: false, tasks: false })
  const helpUrl = 'https://github.com/Blank-not-black/dsh-Remote/blob/main/docs/wiki/plugins.md'
  const reasons = {
    'not-installed': ['未安装', 'Not installed'], disabled: ['配置未启用', 'Disabled in configuration'],
    'runtime-unknown': ['运行状态未知', 'Runtime status unknown'], waiting: ['等待启动或依赖', 'Waiting for startup or dependencies'],
    'runtime-failed': ['插件启动失败', 'Plugin startup failed'], 'restart-required': ['配置已更新，待重启 DSH', 'Configuration updated; restart DSH'],
    unverified: ['运行中，接口待读取验证', 'Running; interface not verified yet'], available: ['接口读取成功', 'Interface read succeeded'],
    unsupported: ['接口不兼容', 'Unsupported interface'], 'endpoint-missing': ['主机未提供适配接口', 'Adapter endpoint unavailable on host'], 'read-failed': ['接口读取失败，可重试', 'Interface read failed; retry available'],
    timeout: ['接口读取超时，可重试', 'Interface read timed out; retry available'], 'host-denied': ['主机拒绝读取，请检查认证', 'Host denied access; check authentication'],
  }
  function diagnosticsFor(snapshot, item, config) {
    return catalog.filter(feature => feature.name === item.name).map(feature => {
      const installed = snapshot?.items?.find(row => row?.name === feature.name)
      const runtime = [...(Array.isArray(installed?.runtime) ? installed.runtime : []), ...(snapshot?.runtime || []).filter(row => row?.name === feature.name)]
      const changed = snapshot?.pendingRestart && snapshot.operations?.some(job => job.name === feature.name && job.restartRequired && ['complete','failed','interrupted'].includes(job.phase))
      const observed = config && same(config) ? cache.observations?.[feature.id] : null
      const fresh = observed && observed.version === installed?.version && Date.now() - observed.at < 300000
      const code = !installed ? 'not-installed' : changed ? 'restart-required' : installed.enabled !== true ? 'disabled'
        : snapshot.runtimeAvailable !== true ? 'runtime-unknown' : runtime.some(row => row?.phase === 'failed') ? 'runtime-failed'
        : !runtime.length || runtime.some(row => row?.enabled === false || row?.phase !== 'active') ? 'waiting'
        : snapshot.adaptations?.[feature.id]?.supported === false ? 'unsupported' : fresh ? observed.code : 'unverified'
      return { id: feature.id, code, label: reasons[code][window.I18N?.lang === 'en' ? 1 : 0], helpUrl, checkedAt: fresh ? observed.at : null }
    })
  }
  function reportAvailability(config, id, result) {
    if (!config || !catalog.some(row => row.id === id) || !same(config)) return
    const native = identity(config)
    if (!native.valid() || config.valid && !config.valid()) return
    const code = result?.ok === true && result.available !== false ? 'available'
      : result?.code === 'unsupported' ? 'unsupported' : result?.code === 'not-installed' ? 'endpoint-missing'
      : result?.code === 'host-denied' ? 'host-denied' : result?.code === 'timeout' ? 'timeout' : 'read-failed'
    cache.observations ||= {}
    cache.observations[id] = { code, at: Date.now(), version: cache.snapshot?.items?.find(row => row.name === catalog.find(feature => feature.id === id).name)?.version }
  }
  function capabilitiesOf(snapshot) {
    if (snapshot?.ok !== true || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.runtime)) return empty()
    const result = { ...empty(), known: true }
    for (const feature of catalog) {
      const item = snapshot.items.find(row => row?.name === feature.name)
      if (item?.enabled !== true || snapshot.runtimeAvailable !== true) continue
      if (snapshot.adaptations?.[feature.id]?.supported === false) continue
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
    return cache && cache.connection.valid() && next.valid() && (typeof next.server === 'string'
      ? cache.connection.server === next.server && cache.connection.token === next.token : cache.connection === next)
  }
  function remember(config, snapshot) {
    if (!config.valid()) return
    if (!same(config)) { cache?.controller?.abort(); cache = { connection: identity(config) } }
    cache.value = capabilitiesOf(snapshot); cache.at = Date.now()
    cache.snapshot = snapshot
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
        record.snapshot = snapshot; record.value = capabilitiesOf(snapshot); record.at = Date.now(); return record.value
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
  const shortcutNames = { skills: ['技能中心', 'Skills'], teams: ['智能体团队', 'Agent teams'], cost: ['费用与额度', 'Costs & quotas'], context: ['上下文分析', 'Context analysis'], tasks: ['任务看板', 'Task board'] }
  const shortcutText = (zh, en) => window.I18N?.lang === 'en' ? en : zh
  function closeShortcuts(restoreFocus = false) {
    if (!shortcuts) return
    const s = shortcuts
    shortcuts = null
    s.menu.classList.add('hidden'); s.trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus) s.trigger.focus()
    return true
  }
  function bindShortcuts({ trigger, menu, config, connected, hasSession, open, beforeOpen }) {
    if (!trigger || !menu) return
    const items = () => Array.from(menu.querySelectorAll('button[role="menuitem"]:not(:disabled)'))
    async function show() {
      closeShortcuts(); beforeOpen?.()
      const connectionConfig = config(), s = { trigger, menu, config: connectionConfig }
      shortcuts = s
      const valid = () => shortcuts === s && connectionConfig.valid()
      const title = node('p', shortcutText('插件快捷打开', 'Plugin shortcuts'), 'ext-shortcut-title')
      const list = node('div', null, 'ext-shortcut-list')
      const message = text => { const p = node('p', text, 'ext-shortcut-empty'); p.setAttribute('role', 'status'); list.replaceChildren(p) }
      const manage = node('button', shortcutText('插件管理', 'Manage plugins'), 'ext-shortcut-manage')
      manage.type = 'button'; manage.setAttribute('role', 'menuitem')
      manage.addEventListener('click', () => { if (valid()) { closeShortcuts(); open('manage') } })
      menu.replaceChildren(title, list, manage)
      menu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true')
      message(connected() ? shortcutText('正在读取插件…', 'Loading plugins…') : shortcutText('请先连接 DSH 主机', 'Connect to a DSH host first'))
      manage.focus()
      if (!connected()) return
      const available = await getCapabilities(connectionConfig)
      if (!valid()) return
      const features = catalog.filter(feature => available[feature.id])
      if (!features.length) {
        message(available.known ? shortcutText('暂无可快捷打开的插件', 'No plugin views available') : shortcutText('暂时无法读取插件，请稍后重试', 'Could not read plugins; try again'))
        return
      }
      const focusInside = menu.contains(document.activeElement)
      list.replaceChildren()
      for (const feature of features) {
        const button = node('button', null, 'ext-shortcut-item')
        button.type = 'button'; button.setAttribute('role', 'menuitem'); button.dataset.pluginShortcut = feature.id
        const label = shortcutNames[feature.id]
        button.append(node('span', shortcutText(...label)), node('span', '›', 'ext-shortcut-arrow'))
        if (feature.session && !hasSession()) {
          button.disabled = true
          button.append(node('small', shortcutText('请先打开一个会话', 'Open a session first')))
        }
        button.addEventListener('click', () => {
          if (!valid() || (feature.session && !hasSession())) return
          closeShortcuts(); open(feature.id)
        })
        list.append(button)
      }
      if (focusInside) items()[0]?.focus()
    }
    trigger.addEventListener('click', () => { if (shortcuts?.trigger === trigger) closeShortcuts(); else void show() })
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); if (shortcuts?.trigger !== trigger) void show(); else items()[0]?.focus() }
    })
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeShortcuts(true); return }
      const buttons = items(), index = buttons.indexOf(document.activeElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
    })
    document.addEventListener('click', event => { if (shortcuts?.trigger === trigger && !trigger.contains(event.target) && !menu.contains(event.target)) closeShortcuts() })
    document.addEventListener('focusin', event => { if (shortcuts?.trigger === trigger && !trigger.contains(event.target) && !menu.contains(event.target)) closeShortcuts() })
    document.addEventListener('keydown', event => { if (shortcuts?.trigger === trigger && event.key === 'Escape') { event.preventDefault(); closeShortcuts(true) } })
  }
  const stopViews=()=>{window.DshSkillsCenter?.close();window.DshInsights?.close();window.DshTeams?.close();window.DshTasks?.close()}
  function close(){closeShortcuts();if(current){const old=current;current=null;stopViews();window.DshPluginCenter?.close();old.target.replaceChildren()}}
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
      else if(route==='teams')await window.DshTeams.mount(config,view)
      else if(route==='tasks')await window.DshTasks.mount(config,view)
      else window.DshInsights.mount({tab:'cost',hostOverview:true,allowedTabs:['cost'],connection:config.connection,url:config.url},view)
      if(valid()&&route!=='manage')config.scrollTop?.()
    }
    back.addEventListener('click',()=>{if(valid()){if(s.route==='manage')config.back?.();else void navigate('manage')}})
    void navigate(initial === 'home' ? 'manage' : initial)
  }
  function scrollParent(el) {
    for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight&&/auto|scroll/.test(getComputedStyle(parent).overflowY))return parent
    return document.scrollingElement
  }
  return {mount,close,bindShortcuts,closeShortcuts,capabilitiesOf,featuresFor,diagnosticsFor,reportAvailability,getCapabilities,remember,invalidateCapabilities,catalog:catalog.map(row=>Object.freeze({...row}))}
})()
