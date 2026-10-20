/* Remote presentation, task navigation and six-theme controls. No API writes. */
'use strict'
;(function (root) {
  const $ = id => document.getElementById(id)
  const lang = () => root.I18N?.lang === 'en' ? 'en' : 'zh'
  const words = {
    zh: {
      overview:'概览',devices:'设备与访问',network:'连接网络',usage:'用量',diagnostics:'诊断',settings:'设置',
      ready:'远程连接可用',partial:'连接部分可用',unknown:'连接状态尚未确认',stopped:'网关尚未启动',auth:'网关认证需要处理',attention:'网关状态需要检查',upstream:'暂时无法连接 DSH',
      ok:'已响应',error:'暂不可达',warning:'恢复中',waiting:'尚未确认',gateway:'远程网关',realtime:'实时通道',
      first:'连接第一台手机',firstDesc:'电脑保持 DSH 运行，在手机安装 App 后扫码连接。已有 App 可直接配对。',
      add:'添加手机',pair:'已有 App，去配对',install:'安装 App 并连接',check:'检查连接',console:'完整控制台',
      daily:'查看连接、添加手机，或进入控制台管理访问权限。',fault:'查看失败环节和下一步；可用功能仍可继续使用。',
      online:'在线连接',none:'当前没有手机在线。添加手机后会显示在这里。',unavailable:'暂时无法读取连接列表。',
      all:'查看全部',details:'查看详情',onlineState:'在线',offlineState:'离线',web:'浏览器',app:'Android App',anonymous:'未备注的连接',
      address:'连接地址',source:'当前主机',updated:'状态读取于',usageHint:'Token、API 费用与套餐额度按数据来源分别展示。',
      usageWait:'打开此分区后读取主机费用数据。',runtime:'运行与端口',runtimeHint:'停止网关会中断使用它的手机和浏览器连接。',
      advanced:'版本与运行详情',show:'显示令牌',hide:'隐藏令牌',masked:'访问凭据已隐藏',unknownNote:'检查未完成或数据不可用；请稍后刷新或查看诊断。',
      readyNote:'DSH、网关和实时通道均已响应。',stoppedNote:'在电脑端启动网关后，手机才能连接。',
      networkHint:'管理手机可访问的主机地址和云中转。',diagnosticsHint:'已知结果与未知项分开显示，不由缺失数据推断成功。',
      devicesHint:'在线连接、授权设备和 IP 访问记录分别管理。',settingsHint:'保存后以主机回读结果确认是否生效。',
      secure:'凭据仅在主动配对或显示时呈现。',full:'打开完整控制台',start:'启动网关',refresh:'刷新状态',
      counts:'个在线连接',help:'关于与支持',connected:'已连接',publicNote:'手机需要能访问所选地址。'
    },
    en: {
      overview:'Overview',devices:'Devices & access',network:'Network',usage:'Usage',diagnostics:'Diagnostics',settings:'Settings',
      ready:'Remote access is ready',partial:'Connection partially available',unknown:'Connection status unconfirmed',stopped:'Gateway is stopped',auth:'Gateway authentication needs attention',attention:'Check gateway state',upstream:'DSH is unreachable',
      ok:'Responding',error:'Unreachable',warning:'Recovering',waiting:'Unconfirmed',gateway:'Gateway',realtime:'Realtime',
      first:'Connect your first phone',firstDesc:'Keep DSH running. Install the app on your phone, then scan to connect. Already installed? Go straight to pairing.',
      add:'Add a phone',pair:'App installed? Pair now',install:'Install app & connect',check:'Check connection',console:'Full console',
      daily:'Check connections, add a phone, or manage access in the console.',fault:'See the affected connection and next step. Available features can still be used.',
      online:'Online connections',none:'No phone is online. Add a phone to see it here.',unavailable:'Connection list is unavailable.',
      all:'View all',details:'View details',onlineState:'Online',offlineState:'Offline',web:'Browser',app:'Android app',anonymous:'Unnamed connection',
      address:'Address',source:'Current host',updated:'State read at',usageHint:'Tokens, API costs and plan quotas retain their source and accounting definitions.',
      usageWait:'Host cost data loads when this section opens.',runtime:'Gateway & port',runtimeHint:'Stopping the gateway disconnects phones and browsers using it.',
      advanced:'Version & runtime details',show:'Show token',hide:'Hide token',masked:'Access credentials hidden',unknownNote:'A check is pending or data is unavailable. Refresh or open diagnostics.',
      readyNote:'DSH, the gateway and realtime channels are responding.',stoppedNote:'Start the gateway on your computer before connecting your phone.',
      networkHint:'Manage reachable host addresses and cloud relay.',diagnosticsHint:'Known results and unconfirmed checks remain distinct.',
      devicesHint:'Manage connections, device credentials and IP access records separately.',settingsHint:'Changes are confirmed by reading the host state.',
      secure:'Credentials appear only when pairing or explicitly shown.',full:'Open full console',start:'Start gateway',refresh:'Refresh state',
      counts:'online connections',help:'About & support',connected:'Connected',publicNote:'Your phone must reach the selected address.'
    }
  }
  const t = key => words[lang()][key] || key
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const derive = st => root.DshRemoteState.derive(st)
  const stableHtml = (el, html) => { if (el && el.innerHTML !== html) el.innerHTML = html }
  function pathHtml(model) {
    return [['DSH',model.upstream],[t('gateway'),model.gateway],[t('realtime'),model.realtime]].map(([label,status]) =>
      '<div class="remote-path-item"><span>' + esc(label) + '</span><strong class="remote-state-' + status + '">' +
      (status === 'ok' ? '✓ ' : status === 'error' ? '! ' : '· ') + esc(t(status === 'unknown' ? 'waiting' : status)) + '</strong></div>').join('')
  }
  function clientHtml(st, limit = 3) {
    const model = derive(st)
    if (!model.online) return '<p class="remote-empty">' + t('unavailable') + '</p>'
    if (!model.online.length) return '<p class="remote-empty">' + t('none') + '</p>'
    return model.online.slice(0,limit).map(d => '<div class="remote-client"><div><strong>' +
      esc(d.note || t(d.kind === 'app' ? 'app' : 'web')) + '</strong><span>' + esc(d.ip || t('waiting')) +
      '</span></div><span class="remote-state-ok">● ' + t('onlineState') + '</span></div>').join('')
  }
  function reconcileRows(body,html) {
    if (!body || body.innerHTML===html) return
    const staging=document.createElement('tbody'); staging.innerHTML=html
    const keep=new Set()
    for(const [index,fresh] of Array.from(staging.children).entries()) {
      const key=fresh.dataset.remoteKey
      let row=Array.from(body.children).find(el=>el.dataset.remoteKey===key)
      if(row) {
        for(const [i,cell] of Array.from(fresh.children).entries()) {
          const target=row.children[i]
          if(!target){row.append(cell);continue}
          if(target.innerHTML!==cell.innerHTML)target.innerHTML=cell.innerHTML
          for(const attr of cell.attributes)target.setAttribute(attr.name,attr.value)
        }
      } else row=fresh
      keep.add(row)
      if(body.children[index]!==row)body.insertBefore(row,body.children[index]||null)
    }
    for(const row of Array.from(body.children))if(!keep.has(row))row.remove()
  }
  root.DshRemoteUI = { t, derive, pathHtml, clientHtml, reconcileRows }
  const main = $('main-view')
  if (!main || !document.querySelector('.admin-wrap')) return
  document.documentElement.classList.add('remote-admin')
  const keys = ['overview','devices','network','diagnostics','settings']
  const store = {
    get(key) { try { return localStorage.getItem(key) } catch { return null } },
    set(key,value) { try { localStorage.setItem(key,value) } catch {} }
  }
  const nav = document.createElement('nav')
  nav.className = 'remote-tabs'
  nav.setAttribute('role','tablist')
  nav.setAttribute('aria-label','Remote')
  const picker = document.createElement('select')
  picker.className = 'remote-page-picker'
  picker.setAttribute('aria-label','Remote')
  const pages = {}
  const buttons = {}
  for (const key of keys) {
    const button = document.createElement('button')
    button.type = 'button'; button.id = 'remote-tab-' + key
    button.setAttribute('role','tab'); button.setAttribute('aria-controls','remote-page-' + key)
    button.dataset.page = key; nav.append(button); buttons[key] = button
    const option = document.createElement('option'); option.value = key; picker.append(option)
    const page = document.createElement('section')
    page.id = 'remote-page-' + key; page.className = 'remote-page'
    page.setAttribute('role','tabpanel'); page.setAttribute('aria-labelledby',button.id)
    const head = document.createElement('header'); head.className = 'remote-page-head'
    const title = document.createElement('h2'); title.dataset.remoteTitle = key
    const sub = document.createElement('p'); sub.className = 'remote-page-hint'
    head.append(title,sub); page.append(head); pages[key] = page
  }
  main.prepend(nav,picker)
  // Keep destinations connected while moving controls: later ID lookups must
  // still find buttons inside a section that has already been moved.
  Object.values(pages).forEach(page=>main.append(page))
  const add = (page,id,resolve) => { const el = $(id); if(el) pages[page].append(resolve ? resolve(el) : el) }
  const table = $('device-rows')?.closest('.table-wrap')
  const deviceHeading = table?.previousElementSibling
  add('overview','admin-hero')
  const path = document.createElement('div'); path.id = 'remote-health-path'; path.className = 'remote-health-path'; pages.overview.append(path)
  const task = document.createElement('section'); task.className = 'remote-task'
  task.innerHTML = '<div><h3 id="remote-task-title"></h3><p id="remote-task-desc"></p></div><div class="remote-task-actions"><button type="button" id="remote-task-primary" class="remote-primary"></button><button type="button" id="remote-task-pair" class="remote-secondary"></button></div>'
  pages.overview.append(task)
  const connections = document.createElement('section'); connections.className = 'remote-connections'
  connections.innerHTML = '<div class="remote-section-head"><h3 id="remote-online-title"></h3><button type="button" class="remote-link" id="remote-view-devices"></button></div><div id="remote-client-list"></div>'
  pages.overview.append(connections)
  const updated = document.createElement('p'); updated.className = 'remote-updated'; pages.overview.append(updated)
  add('devices','admin-setup')
  add('devices','device-key-enabled',el => el.closest('.device-key-card'))
  add('devices','pair-box')
  if (deviceHeading?.classList.contains('section-head')) pages.devices.append(deviceHeading)
  if (table) pages.devices.append(table)
  add('network','host-ip-card')
  add('network','relay-settings')
  add('diagnostics','doctor-card')
  const runtime = document.createElement('section'); runtime.className='remote-settings-block'
  runtime.innerHTML='<h3 id="remote-runtime-title"></h3><p id="remote-runtime-hint"></p>'
  pages.settings.append(runtime)
  const gatewayButton = $('btn-gateway'); if(gatewayButton) runtime.append(gatewayButton)
  if($('btn-logout'))document.querySelector('.admin-title .right')?.append($('btn-logout'))
  add('settings','gateway-port-row')
  add('settings','login-startup-title',el=>el.closest('section'))
  const advanced = document.createElement('details'); advanced.className='remote-advanced'
  const advancedTitle = document.createElement('summary'); advanced.append(advancedTitle)
  if($('stats')) advanced.append($('stats'))
  pages.settings.append(advanced)
  const reveal = document.createElement('button'); reveal.type='button'; reveal.className='mini-btn'
  reveal.id='remote-token-reveal'; $('shared-token-row')?.querySelector('.token-actions')?.prepend(reveal)
  let state = null, current = 'overview', showingToken = false, visitedHost = ''
  let initialRoute = location.hash.replace(/^#(?:remote\/)?/,'')
  if (!keys.includes(initialRoute)) initialRoute = ''
  function select(key,{persist=true,route=true}={}) {
    if(!keys.includes(key))key='overview'
    const changed=current!==key
    current=key
    for(const entry of keys) {
      pages[entry].hidden=entry!==key
      buttons[entry].setAttribute('aria-selected',String(entry===key))
      buttons[entry].tabIndex=entry===key?0:-1
    }
    picker.value=key
    if(persist && visitedHost)store.set('dshRemotePage:'+visitedHost,key)
    if(route && location.hash!=='#remote/'+key) history.replaceState(null,'',location.pathname+location.search+'#remote/'+key)
    if(key!=='devices') { showingToken=false; mask() }
    if(changed) document.dispatchEvent(new CustomEvent('dsh-remote-section',{detail:{section:key}}))
  }
  function openSetup(step=1) {
    select('devices')
    root.dispatchEvent(new CustomEvent('dsh-remote-setup',{detail:{step}}))
    $('admin-setup')?.scrollIntoView({behavior:'smooth',block:'start'})
  }
  function mask() {
    const token = state?.gatewayAuthError ? '' : state?.token || ''
    if($('token-full')) $('token-full').textContent=token?(showingToken?token:'•••• •••• •••• ••••'):t('waiting')
    reveal.textContent=t(showingToken?'hide':'show')
    reveal.disabled=!token
    reveal.setAttribute('aria-pressed',String(showingToken))
  }
  reveal.addEventListener('click',()=>{showingToken=!showingToken;mask()})
  nav.addEventListener('click',event=>{const button=event.target.closest('[data-page]');if(button)select(button.dataset.page)})
  nav.addEventListener('keydown',event=>{
    const index=keys.indexOf(current)
    const next=event.key==='ArrowRight'?keys[(index+1)%keys.length]:event.key==='ArrowLeft'?keys[(index+keys.length-1)%keys.length]:event.key==='Home'?keys[0]:event.key==='End'?keys.at(-1):''
    if(next){event.preventDefault();select(next);buttons[next].focus()}
  })
  picker.addEventListener('change',()=>select(picker.value))
  root.addEventListener('hashchange',()=>select(location.hash.replace(/^#remote\//,''),{route:false}))
  $('remote-view-devices').addEventListener('click',()=>select('devices'))
  $('remote-task-pair').addEventListener('click',()=>openSetup(2))
  $('remote-task-primary').addEventListener('click',()=>{
    const model=derive(state)
    if(!model.authenticated || ['upstream','partial','unknown'].includes(model.phase))select('diagnostics')
    else openSetup(1)
  })
  document.addEventListener('click',event=>{
    const link=event.target.closest('a[href="#admin-setup"]')
    if(link){event.preventDefault();openSetup(1)}
  })
  function update(next) {
    state=next
    const model=derive(state)
    const host=state ? state.hostname || state.upstream?.url || location.host : visitedHost || location.host
    if(host && host!==visitedHost) {
      visitedHost=host
      select(initialRoute || store.get('dshRemotePage:'+host) || 'overview',{route:true})
      initialRoute=''
    }
    if(model.onlineCount>0)store.set('dshRemotePaired:'+host,'1')
    const first=!model.history && store.get('dshRemotePaired:'+host)!=='1'
    for(const key of keys) {
      buttons[key].textContent=t(key)
      picker.options[keys.indexOf(key)].textContent=t(key)
      pages[key].querySelector('h2').textContent=t(key)
      const hint={devices:'devicesHint',network:'networkHint',usage:'usageHint',diagnostics:'diagnosticsHint',settings:'settingsHint'}[key]
      pages[key].querySelector('.remote-page-hint').textContent=hint?t(hint):state?.hostname || t('source')
    }
    stableHtml(path,pathHtml(model))
    stableHtml($('remote-client-list'),clientHtml(state,5))
    $('remote-online-title').textContent=t('online')
    $('remote-view-devices').textContent=t('all')
    $('remote-task-title').textContent=t(model.phase==='ready'?(first?'first':'add'):model.phase)
    $('remote-task-desc').textContent=t(model.phase==='ready'?(first?'firstDesc':'daily'):model.phase==='stopped'?'stoppedNote':model.phase==='unknown'?'unknownNote':'fault')
    $('remote-task-primary').textContent=t(model.phase==='ready'?(first?'install':'add'):'check')
    $('remote-task-pair').textContent=t('pair')
    $('remote-task-pair').hidden=!model.authenticated
    $('remote-runtime-title').textContent=t('runtime')
    $('remote-runtime-hint').textContent=t('runtimeHint')
    advancedTitle.textContent=t('advanced')
    updated.textContent=t('updated')+' '+new Date().toLocaleTimeString(lang()==='zh'?'zh-CN':'en-US')
    const hero=$('admin-hero')
    if(hero) {
      $('admin-hero-title').textContent=t(model.phase)
      $('admin-hero-desc').textContent=state?.gatewayAuthError || t(model.phase==='ready'?'readyNote':model.phase==='stopped'?'stoppedNote':model.phase==='unknown'?'unknownNote':'fault')
      hero.dataset.remotePhase=model.phase
    }
    if(!model.authenticated)showingToken=false
    mask()
  }
  select(initialRoute || 'overview',{persist:false,route:false})
  root.DshConsole={update,select,openSetup,current:()=>current,conceal(){showingToken=false;mask()}}
  root.addEventListener('dsh-remote-console-state',event=>update(event.detail))
})(window)
