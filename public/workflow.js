/* 0.8 task navigation. Existing controllers retain all protocol ownership. */
;(function(root) {
  'use strict'
  let config, sheet, connectionButton, attention, operationList
  let receiptIdentity=''
  const $ = id => document.getElementById(id)
  const label = (zh,en) => root.I18N?.lang === 'en' ? en : zh
  function element(tag,cls,text) { const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el }
  function icon(name) {
    const paths={host:'M3 4h18v12H3zM8 21h8m-4-5v5',plugins:'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
      receipts:'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6m-6 4h6',general:'M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2M16 8l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
      model:'m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5',notify:'M6 9a6 6 0 0 1 12 0c0 7 3 7 3 8H3c0-1 3-1 3-8m4 12h4',about:'M12 11v6m0-10v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'}
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg')
    for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value)
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[name]||paths.host);svg.append(path);return svg
  }
  function button(zh,en,action,cls='workflow-button') {
    const el=element('button',cls),caption=element('span');el.type='button';caption.dataset.flowZh=zh;caption.dataset.flowEn=en;el.append(caption)
    el.addEventListener('click',action);return el
  }
  function rename(target,zh,en) {
    if(!target)return
    target.removeAttribute('data-i18n');target.dataset.flowZh=zh;target.dataset.flowEn=en
  }
  function restoreAttention() {
    const list=$(config?.desktop?'ds-overview-attention-list':'overview-attention-list')
    if(list&&attention&&!attention.contains(list))attention.append(list)
  }
  function openSheet(title,content) {
    restoreAttention()
    operationList=null
    sheet.querySelector('h2').textContent=title
    const body=sheet.querySelector('.workflow-sheet-body')
    for(const child of [...body.children])if(child.id==='workflow-model-content'){child.hidden=true;document.body.append(child)}
    if(content.id==='workflow-model-content')content.hidden=false
    body.replaceChildren(content)
    if(!sheet.open)sheet.showModal()
  }
  function close() { restoreAttention();operationList=null;sheet?.close() }
  function openModels() {
    const content=$('workflow-model-content')
    if(content)openSheet(label('模型与思考深度','Model and reasoning'),content)
    config.models?.()
  }
  async function showOperations() {
    const content=element('div'),pending=element('section'),receipts=element('section')
    pending.append(element('h3','',label('待审批与待回答','Approvals and questions')))
    receipts.append(element('h3','',label('操作回执','Operation receipts')),
      element('p','workflow-muted',label('回执用于查询网络中断后尚未确认的操作结果。','Receipts track operation results after a connection interruption.')))
    const rows=element('div');receipts.append(rows);content.append(pending,receipts)
    openSheet(label('审批与操作回执','Approvals and receipts'),content);operationList=rows
    const list=$(config.desktop?'ds-overview-attention-list':'overview-attention-list')
    if(list)pending.append(list)
    // Question dialogs use the existing modal controller, above the page.
    pending.addEventListener('click',event=>{if(event.target.closest('[data-overview-question],[data-ds-overview-question]'))close()},true)
    void refreshOperations()
    try { if(config.operations)await root.DshOperations?.restore(config.operations()) }
    catch { if(operationList===rows)rows.append(element('p','workflow-muted',label('暂时无法读取回执，可稍后重新打开。','Unable to read receipts. Try again shortly.')));return }
    if(operationList===rows)void refreshOperations()
  }
  async function refreshOperations() {
    if(!operationList||!sheet.open)return
    const target=operationList;target.replaceChildren()
    const rows=root.DshOperations?.pending()||[]
    if(!rows.length)target.append(element('p','workflow-muted',label('没有待确认操作。','No unconfirmed operations.')))
    for(const row of rows){
      const item=element('div','workflow-receipt')
      item.append(element('strong','',row.method),element('code','',row.id),element('span','workflow-muted',label('结果待确认，不会自动重复提交','Unconfirmed; never automatically submitted again')))
      const check=button('查询结果','Check result',async()=>{
        check.disabled=true
        try {
          const value=await root.DshOperations.check(row.id)
          if(!sheet.open||target!==operationList)return
          item.append(element('p','',value?label('当前状态：','Status: ')+value.phase:label('暂时无法确认，请核对会话。','Unable to confirm. Check the conversation.')))
          if(value?.phase==='complete'){config.refresh();config.recover?.(row,value);check.remove()}
        }catch{item.append(element('p','',label('网络不可达，可稍后查询。','Network unavailable. Check later.')))}
        finally{check.disabled=false}
      });item.append(check)
      if(row.phase==='unknown')item.append(button('核对后结束跟踪','Finish tracking after checking',()=>{
        if(!root.confirm(label('请先核对主机会话记录。结束跟踪后，相同操作将作为新请求提交；如果原操作已执行，再次提交会重复。确定结束跟踪？','Check the conversation on the host first. After tracking ends, the same action will create a new request and may duplicate a completed action. Finish tracking?')))return
        if(root.DshOperations.dismiss(row.id))void refreshOperations()
      }))
      target.append(item)
    }
    translate()
  }
  async function preview(connection,path,name) {
    if(!connection.valid())return
    const content=element('div'),status=element('p','workflow-muted',label('正在读取…','Loading…'));content.append(status)
    openSheet(name,content)
    try{
      const url=new URL(connection.server+'/fs/preview',location.href);url.searchParams.set('path',path)
      const response=await root.fetch(url,{headers:connection.headers,signal:AbortSignal.timeout(root.DshNetwork?.profile().readTimeout||45000)})
      const value=await response.json()
      if(!connection.valid()||!sheet.open||!sheet.contains(content))return
      if(!response.ok)throw Error(value.error||('HTTP '+response.status))
      content.replaceChildren(element('code','workflow-muted',value.path||path))
      const source=element('pre','workflow-file-source',value.content||'');content.append(source)
      if(/\.md$|\.markdown$/i.test(name)&&root.mdToHtml){
        const rendered=element('div','workflow-file-markdown');rendered.innerHTML=root.mdToHtml(value.content||'');content.append(rendered);source.hidden=true
        const toggle=button('源码 / 预览','Source / preview',()=>{source.hidden=!source.hidden;rendered.hidden=!rendered.hidden})
        content.prepend(toggle);translate()
      }
    }catch(error){if(connection.valid()&&sheet.open&&sheet.contains(content))status.textContent=label('无法预览：','Unable to preview: ')+error.message}
  }
  function connectionDetails() {
    const content=element('div','workflow-connection-content'),snapshot=config.snapshot()
    content.append(element('p','',snapshot.host||label('当前页面主机','Current host')))
    content.append(element('p','workflow-muted',label('连接主机后，工作区与会话始终归属这台主机。','Workspaces and conversations belong to the selected host.')))
    const links=$(config.desktop?'view-overview':'view-activity')
    if(links){
      const details=element('details','workflow-technical'),summary=element('summary','',label('连接与运行详情','Connection details'))
      details.append(summary);const clone=element('div','workflow-link-status')
      for(const [key,name] of [['gateway','网关 / Gateway'],['dsh','DSH'],['mux','实时 / mux'],['hostEvents','主机事件 / host']]){
        clone.append(element('p','',name+' · '+(snapshot[key]?label('在线','Online'):label('未就绪','Not ready'))))
      }
      details.append(clone);content.append(details)
    }
    content.append(button('重新检查','Check connection',()=>{config.retry();close()}),button('主机与连接','Hosts and connections',()=>{close();config.settings('servers')}))
    if(snapshot.gateway)content.append(button('打开管理控制台','Open management console',()=>config.admin()))
    openSheet(label('当前主机','Current host'),content);translate()
  }
  function setupMore() {
    const home=$('settings-home');if(!home)return
    const intro=element('div','workflow-page-head');const heading=element('h1');rename(heading,'更多','More');intro.append(heading);home.prepend(intro)
    const plugins=button('主机插件','Host plugins',()=>config.plugins(),'workflow-setting-link')
    const receipts=button('审批与操作回执','Approvals and receipts',showOperations,'workflow-setting-link')
    const main=home.querySelector('.settings-group,.ds-settings');main?.prepend(plugins);main?.append(receipts)
    const names={servers:['主机与连接','Hosts and connections'],general:['外观与输入','Appearance and input'],model:['模型与提供方','Models and providers'],notify:['通知与后台','Notifications and background'],about:['关于与维护','About and maintenance']}
    const descriptions={servers:['连接地址、访问令牌与公网中转','Addresses, access tokens and cloud relay'],general:['主题、语言、输入与常用提示词','Theme, language, input and reusable prompts'],model:['提供方、访问凭据与模型目录','Providers, credentials and model catalog'],notify:['消息提醒与后台接收','Event notifications and background delivery'],about:['版本、公告、反馈与本地数据','Version, announcements, feedback and local data']}
    for(const [key,nameset] of Object.entries(names)){
      const row=home.querySelector(`[data-settings-group="${key}"]`)
      rename(row?.querySelector('.setting-name,.ds-setting-name'),...nameset)
      rename(row?.querySelector('.setting-desc,.ds-setting-desc'),...descriptions[key])
      const page=$('settings-page-'+key)
      rename(page?.querySelector('[data-settings-back] .setting-name,[data-settings-back] .ds-setting-name'),...nameset)
      if(row){const mark=element('span','workflow-setting-icon');mark.append(icon(key==='servers'?'host':key));row.prepend(mark)}
    }
    for(const [target,name] of [[plugins,'plugins'],[receipts,'receipts']]){const mark=element('span','workflow-setting-icon');mark.append(icon(name));target.prepend(mark)}
    const work=element('section','workflow-more-group'),preferences=element('section','workflow-more-group')
    const workTitle=element('h2'),preferenceTitle=element('h2');rename(workTitle,'连接与工作','Connections and work');rename(preferenceTitle,'偏好与维护','Preferences and maintenance')
    const workList=element('div','workflow-settings-list'),preferenceList=element('div','workflow-settings-list')
    const host=home.querySelector('[data-settings-group="servers"]');if(host)workList.append(host)
    workList.append(plugins,receipts);work.append(workTitle,workList)
    for(const name of ['general','model','notify','about']){const row=home.querySelector(`[data-settings-group="${name}"]`);if(row)preferenceList.append(row)}
    preferences.append(preferenceTitle,preferenceList);home.append(work,preferences)
    home.querySelector('[data-settings-group="tests"]')?.remove()
    home.querySelector('[data-settings-group="theme"]')?.remove()
    const general=$('settings-page-general'),theme=$('settings-page-theme')
    if(general&&theme){
      const groups=config.desktop?[...theme.querySelectorAll(':scope > .ds-setting-row')].slice(1):[...theme.querySelectorAll('.settings-group')].slice(1)
      for(const group of groups)general.append(group)
    }
    const defaultMode=$('busy-send-mode')?.closest('.setting-row');if(defaultMode)defaultMode.hidden=true
    const gesture=$('opt-steer-send')?.closest('.setting-row')
    rename(gesture?.querySelector('.setting-name'),'长按快捷插队','Hold to steer')
    rename(gesture?.querySelector('.setting-desc'),'运行时长按发送可插队；普通点击仍排队。','Hold to steer while running; clicking still queues.')
    for(const id of ['btn-change-token','token-desc','desktop-token-input']){
      const row=$(id)?.closest('.setting-row,.ds-setting-row,.desktop-connect-form')
      if(row&&home.contains(row))$('settings-page-servers')?.append(row)
    }
    const language=$('btn-lang')?.closest('.setting-row,.ds-setting-row')
    if(language&&home.contains(language))general?.append(language)
    const about=$('settings-page-about'),servers=$('settings-page-servers')
    if(about&&config.feedback)about.append(button('提交反馈','Send feedback',config.feedback))
    if(about&&root.DshDiagnostics)about.append(button('本地操作日志','Local operation logs',()=>root.DshDiagnostics.show()))
    for(const id of ['btn-dsh-start','btn-host-describe']){const row=$(id)?.closest('.setting-row,.ds-setting-row');if(row&&about?.contains(row))servers?.append(row)}
    const support=home.querySelector('.feedback-card');if(support)about?.append(support)
    home.querySelector('p.about')?.remove()
    const data=element('section','workflow-data-settings');data.append(element('h3','',label('本地数据','Local data')))
    data.append(button('清除历史缓存','Clear history cache',()=>config.clear('history')),button('移除当前连接','Remove current connection',()=>config.clear('connection')),button('清除全部本地配置','Clear all local settings',()=>config.clear('all'),'workflow-button workflow-danger'))
    about?.append(data)
    const reset=$('btn-reset')?.closest('.setting-row,.ds-setting-row');if(reset)reset.hidden=true
    for(const group of home.querySelectorAll('.settings-group,.ds-settings')){
      if(!group.children.length)group.remove()
      else if([...group.children].every(child=>child.hidden||child.classList.contains('hidden')))group.hidden=true
    }
    const wb=$(config.desktop?'workbench-box':'workbench-bar')
    if(wb&&servers){const details=element('details','workflow-technical'),summary=element('summary','',label('高级目录组织（原工作台）','Advanced folder organization'))
      details.append(summary,wb,button('发现并登记子目录','Discover subfolders',()=>config.discover()));servers.append(details)}
    if(servers)servers.append(button('打开管理控制台','Open management console',()=>config.admin()))
    const workspace=$('modal-workspace')?.querySelector('.modal-body,.ds-modal-body')
    if(workspace&&config.register)workspace.append(button('使用当前目录，不新建文件夹','Use current folder',()=>config.register()))
    const noWorkspaces=$('new-session-empty')
    if(noWorkspaces)noWorkspaces.after(button('浏览主机目录','Browse host folders',()=>{config.browse?.()}))
    const notify=$('settings-page-notify')
    if(notify){
      const more=element('details','workflow-technical');more.append(element('summary','',label('后台间隔与通知排障','Background interval and diagnostics')))
      for(const id of ['bg-interval','btn-test-notify']){const row=$(id)?.closest('.setting-row');if(row)more.append(row)}
      notify.append(more)
    }
  }
  function setupComposer() {
    if(!config.desktop){
      const content=element('div');content.id='workflow-model-content'
      for(const id of ['menu-models','menu-effort-group']){const row=$(id);if(row)content.append(id==='menu-models'?row.closest('.menu-group'):row)}
      content.hidden=true;document.body.append(content)
      const controls=element('div','workflow-composer-config')
      const models=button('模型','Model',()=>{content.hidden=false;openModels()});models.id='workflow-models';models.prepend(icon('model'));controls.append(models)
      $('composer-wrap')?.querySelector('.composer')?.append(controls)
      rename($('btn-plus'),'指令','Commands')
    }
    const send=$('btn-send');if(!send)return
    const alternate=button('插队发送','Steer',()=>config.send('steer'),'workflow-button workflow-steer')
    alternate.id='workflow-steer';send.after(alternate)
    const actions=$('session-actions')
    if(actions){
      actions.append(button('查看工作区文件','Workspace files',()=>{actions.close();config.files()}),
        button('导出会话','Export conversation',()=>{actions.close();void config.command('/export')}),
        button('压缩上下文','Compact context',()=>{actions.close();void config.command('/compact')}))
    }
    for(const el of document.querySelectorAll('[data-cmd="/compact"],[data-cmd="/export"],[data-ds-cmd="/compact"],[data-ds-cmd="/export"]'))el.remove()
  }
  function setupSecondaryPages() {
    const definitions={
      general:{title:['外观与输入','Appearance and input'],intro:['按你的习惯调整显示、输入与常用提示词。','Adjust display, input and reusable prompts to suit your workflow.'],icon:'general',groups:[['input','对话与输入','Conversation and input'],['appearance','外观与语言','Appearance and language'],['presets','预设提示词','Reusable prompts']]},
      servers:{title:['主机与连接','Hosts and connections'],intro:['管理连接地址、访问令牌与公网中转。','Manage host addresses, access tokens and relay connections.'],icon:'host',groups:[['local','连接地址','Host addresses'],['access','访问令牌','Access token'],['relay','云服务器中转','Cloud relay'],['host','主机管理','Host management'],['advanced','高级选项','Advanced options']]},
      model:{title:['模型与提供方','Models and providers'],intro:['配置当前主机的模型提供方与访问凭据。','Configure model providers and credentials on the current host.'],icon:'model',groups:[['main','提供方配置','Provider configuration']]},
      notify:{title:['通知与后台','Notifications and background'],intro:['选择需要提醒的事项，并管理后台接收方式。','Choose which events to hear about and how to receive them in the background.'],icon:'notify',groups:[['main','消息与提醒','Messages and reminders'],['advanced','后台与排障','Background and diagnostics']]},
      about:{title:['关于与维护','About and maintenance'],intro:['查看版本与公告，获取帮助或管理本地数据。','Find version information, announcements, help and local data controls.'],icon:'about',groups:[['main','版本与项目','Version and project'],['announcements','公告','Announcements'],['support','反馈与支持','Feedback and support'],['data','本地数据','Local data']]},
      theme:{title:['外观','Appearance'],intro:['选择你喜欢的配色。','Choose your preferred color palette.'],icon:'general',groups:[['main','配色','Color palette']]},
      tests:{title:['功能测试','Diagnostics'],intro:['检查当前设备与主机的可用能力。','Check the capabilities of this device and host.'],icon:'host',groups:[['main','功能检查','Capability checks']]},
    }
    const includes=(node,selector)=>node.matches(selector)||!!node.querySelector(selector)
    for(const [key,definition] of Object.entries(definitions)){
      const page=$('settings-page-'+key);if(!page||page.classList.contains('workflow-subpage'))continue
      const oldBack=page.querySelector('[data-settings-back]'),oldGroup=oldBack?.parentElement
      oldBack?.remove()
      if(oldGroup!==page&&oldGroup?.classList.contains('settings-group')&&!oldGroup.children.length)oldGroup.remove()
      const parts=[]
      for(const node of [...page.children]){
        if(node.matches('.settings-group:not(.model-settings-shell):not(.feedback-card)')){parts.push(...node.children);node.remove()}
        else parts.push(node)
      }
      const header=element('header','workflow-subpage-head'),back=element('button','workflow-back'),backLabel=element('span')
      back.type='button';rename(backLabel,'返回更多','Back to More');back.dataset.settingsBack=''
      back.append(element('span','workflow-back-arrow','‹'),backLabel)
      const title=element('h1');rename(title,...definition.title);title.id='workflow-title-'+key
      const intro=element('p','workflow-subpage-intro');rename(intro,...definition.intro)
      const mark=element('span','workflow-setting-icon');mark.append(icon(definition.icon))
      const identity=element('div','workflow-subpage-identity'),copy=element('div');copy.append(title,intro);identity.append(mark,copy)
      header.append(back,identity)
      const body=element('div','workflow-subpage-body'),cards=new Map()
      for(const [id,zh,en] of definition.groups){
        const section=element('section','workflow-settings-section'),heading=element('h2'),card=element('div','workflow-settings-card')
        rename(heading,zh,en);heading.id='workflow-group-'+key+'-'+id;section.setAttribute('aria-labelledby',heading.id);card.dataset.workflowSettingsSlot=id
        section.append(heading,card);cards.set(id,{section,card});body.append(section)
      }
      for(const node of parts){
        let group=definition.groups[0][0]
        if(key==='general'){
          if(includes(node,'#btn-theme,#btn-lang'))group='appearance'
          else if(includes(node,'#btn-preset-add,#btn-manage-presets,#preset-list'))group='presets'
        }else if(key==='servers'){
          if(node.id==='relay-settings')group='relay'
          else if(includes(node,'#token-desc,#desktop-token-input'))group='access'
          else if(node.matches('.workflow-technical'))group='advanced'
          else if(includes(node,'#btn-host-describe,#btn-dsh-start')||node.matches('.workflow-button'))group='host'
        }else if(key==='notify'&&node.matches('.workflow-technical'))group='advanced'
        else if(key==='about'){
          if(node.matches('.workflow-data-settings'))group='data'
          else if(node.id==='overview-announcement-board')group='announcements'
          else if(node.matches('.feedback-card,.workflow-button')||includes(node,'[data-donate-open],#btn-donate-about'))group='support'
        }
        cards.get(group).card.append(node)
      }
      // Move existing controls rather than rebuilding them: listeners, form state
      // and asynchronously updated regions keep their original DOM identities.
      for(const {section,card} of cards.values())if(!card.children.length||[...card.children].every(node=>node.hidden||node.classList.contains('hidden')))section.hidden=true
      page.classList.add('workflow-subpage');page.setAttribute('aria-labelledby',title.id)
      page.replaceChildren(header,body)
    }
  }
  function setupStart() {
    const desktop=config.desktop,home=$(desktop?'view-sessions':'view-home');if(!home)return
    const head=element('section','workflow-start')
    const title=element('div','workflow-page-head'),heading=element('h1');rename(heading,desktop?'会话':'工作空间',desktop?'Conversations':'Workspace');title.append(heading)
    connectionButton=button('检查连接…','Checking connection…',connectionDetails,'workflow-connection');connectionButton.id='workflow-connection'
    connectionButton.removeAttribute('data-flow-zh');connectionButton.removeAttribute('data-flow-en')
    title.append(connectionButton);head.append(title)
    if(!desktop){
      const workspace=$('workspace-nav'),create=$('btn-new-session')
      if(workspace)head.append(workspace)
      if(create){create.classList.add('workflow-new-session');head.append(create)}
      rename(home.querySelector('.section-head > span:first-child'),'最近会话','Recent conversations')
    }
    attention=element('section','workflow-attention');attention.id='workflow-attention'
    const attentionTitle=element('h2');rename(attentionTitle,'待处理','Needs attention');attention.append(attentionTitle)
    const pending=$(desktop?'ds-overview-attention-list':'overview-attention-list');if(pending)attention.append(pending)
    head.append(attention)
    const notice=element('div','workflow-notice');notice.id='workflow-unconfirmed';notice.hidden=true
    notice.append(element('span','',label('有操作结果待确认','Some operation results are unconfirmed')),button('查看回执','Check receipts',showOperations));head.append(notice)
    home.prepend(head)
    const announcements=$('overview-announcement-board')
    if(announcements)$('settings-page-about')?.append(announcements)
    const stat=$('stat-strip');if(stat)stat.hidden=true
  }
  function translate() {
    const english=root.I18N?.lang==='en'
    for(const el of document.querySelectorAll('[data-flow-zh]'))el.textContent=english?el.dataset.flowEn:el.dataset.flowZh
    if(!config.desktop&&$('btn-plus')){
      $('btn-plus').setAttribute('aria-label',label('指令与权限','Commands and permissions'))
      $('btn-plus').title=label('指令与权限','Commands and permissions')
    }
    $('workflow-models')?.setAttribute('aria-label',label('模型与思考深度','Model and reasoning'))
  }
  function update() {
    if(!config)return
    const snapshot=config.snapshot(),english=root.I18N?.lang==='en'
    if(snapshot.token&&config.operations&&root.DshOperations){
      const context=config.operations(),identity=JSON.stringify([context.url('/api/operations'),context.headers.authorization])
      if(identity!==receiptIdentity){receiptIdentity=identity;void root.DshOperations.restore(context).then(()=>{if(identity===receiptIdentity)update()}).catch(()=>{})}
    }
    if(connectionButton){
      const status=!snapshot.token?label('连接主机','Connect host'):snapshot.gateway&&snapshot.dsh?label('已连接','Connected'):label('正在恢复连接','Reconnecting')
      connectionButton.textContent=status+' · '+(snapshot.host||label('当前主机','Current host'))
      connectionButton.classList.toggle('is-online',!!snapshot.gateway&&!!snapshot.dsh)
    }
    if(attention)attention.hidden=!snapshot.pending
    const alternate=$('workflow-steer');if(alternate){alternate.hidden=!snapshot.busy;alternate.disabled=!!snapshot.sending}
    const send=$('btn-send');if(send&&!snapshot.sending){send.textContent=snapshot.busy?label('排队发送','Queue'):label('发送','Send');send.setAttribute('aria-label',send.textContent)}
    const unconfirmed=$('workflow-unconfirmed');if(unconfirmed)unconfirmed.hidden=!(root.DshOperations?.pending().some(row=>row.phase==='unknown'))
    document.documentElement.dataset.workflowLang=english?'en':'zh'
    translate()
  }
  function mount(options) {
    if(config)return;config=options;document.body.classList.add('workflow-v8')
    sheet=element('dialog','workflow-sheet');sheet.id='workflow-sheet'
    const header=element('header','workflow-sheet-head');header.append(element('h2'),button('关闭','Close',close));sheet.append(header,element('div','workflow-sheet-body'));document.body.append(sheet)
    sheet.addEventListener('click',event=>{if(event.target===sheet)close()})
    sheet.addEventListener('close',()=>{if(!sheet.open){restoreAttention();operationList=null}})
    setupMore();setupStart();setupComposer();config.start?.()
    const relaySettings=$('relay-settings')
    if(relaySettings){$('settings-page-servers')?.append(relaySettings);root.DshRelaySettings?.mount(relaySettings,{connection:config.relay||config.operations})}
    setupSecondaryPages()
    const overview=$('view-activity');if(overview)overview.dataset.workflowLegacy='overview'
    if(!config.desktop){
      const badge=$('nav-pending')
      if(badge)badge.remove()
      for(const el of document.querySelectorAll('.bottom-nav [data-view="view-activity"],.bottom-nav [data-view="view-plugins"],nav [data-view="view-activity"],nav [data-view="view-plugins"]'))el.remove()
      rename(document.querySelector('nav [data-view="view-settings"] [data-i18n]'),'更多','More')
      if(badge)document.querySelector('nav [data-view="view-home"]')?.append(badge)
      for(const id of ['btn-donate','btn-feedback']){const el=$(id);if(el)el.hidden=true}
    }else{
      const sessions=document.querySelector('.ds-nav-item[data-view="view-overview"]')
      if(sessions){sessions.dataset.view='view-sessions';rename(sessions.querySelector('[data-i18n]'),'会话','Conversations')}
      for(const el of document.querySelectorAll('.ds-nav-item[data-view="view-plugins"]'))el.hidden=true
      rename(document.querySelector('[data-view="view-settings"] [data-i18n]'),'更多','More')
      const feedback=$('btn-feedback');if(feedback)feedback.hidden=true
    }
    new MutationObserver(update).observe(document.documentElement,{attributes:true,attributeFilter:['lang']})
    root.addEventListener('dsh-operation-change',update)
    update()
  }
  function clearStorage() {
    root.DshDiagnostics?.clear()
    const keys=new Set(['activeServer','busySendMode','dsShowArchivedV1','dshAdminDoctorCollapsed','dshAdminToken',
      'dshLang','dshNetworkModeV1','dshWeakStreamOff','dshTheme','fsWorkspaceIdV1','lastNewSessionWorkspaceV1','mobileEnterAction',
      'notify','peakRemind','server','servers','servers-v1','servers-v2','sessionSort','showArchivedV1','showTools',
      'steerSendingEnabled','token','workspaceFilterV1','dshRemoteClientIdV2','dshPromptPresets','seenNotesVersion',
      'dshCollapsedGoalsV1','workbenchOrderV1','seenAnnouncementsV1','announcementHistoryV1','announcementVotesV1',
      'dshAdminEnabledHostIPsV1','dshAdminManualHostIPsV1','dshRemoteOperationReceiptsV1','dshRemoteDiagnosticsV1','dshRemoteDiagnosticsV1Salt'])
    for(const key of Object.keys(localStorage))if(keys.has(key)||/^(?:sessions|history)Cache/.test(key))localStorage.removeItem(key)
    sessionStorage.removeItem('dshRemoteOperationReceiptsV1')
    sessionStorage.removeItem('dshRemoteLayout')
  }
  root.DshWorkflow={mount,update,close,connectionDetails,showOperations,clearStorage,preview,isMounted:()=>!!config}
})(window)
