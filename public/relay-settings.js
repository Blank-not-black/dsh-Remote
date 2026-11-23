/* Shared settings for the host-owned relay; no credentials enter browser storage. */
;(function(root) {
  'use strict'
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const el = (tag, cls, value) => { const node=document.createElement(tag);if(cls)node.className=cls;if(value)node.textContent=value;return node }
  const messages = {
    INVALID_AUTHORIZATION:['中转密钥无效或已到期，请核对运营者发给你的密钥。','The relay key is invalid or expired.'],
    HOST_ALREADY_BOUND:['此密钥已绑定其他主机，请申请新的密钥。','This key is already bound to another host.'],
    RELAY_ADMIN_REQUIRED:['开通或停用需要此主机的管理令牌。','The host admin token is required.'],
    ENROLLMENT_CONNECTION_FAILED:['暂时无法连接中转服务器，密钥未保存到浏览器。','The relay server is unreachable. The key was not saved in the browser.'],
    GATEWAY_UNAVAILABLE:['请先在主机上启动 Remote 网关。','Start the Remote gateway on the host first.'],
    RELAY_OPERATION_BUSY:['主机正在处理上一次操作，请稍后刷新状态。','The previous operation is still running. Refresh shortly.'],
    unauthorized:['请先连接主机，再设置云服务器中转。','Connect to your host before configuring its relay.'],
    INVALID_RESPONSE:['主机返回了无法识别的中转状态，请检查连接地址和主机 Remote 版本。','Unrecognized relay response. Check the host URL and Remote version.'],
    UNSUPPORTED_GATEWAY:['此主机尚不支持云中转设置，请更新主机 Remote。','Update the host Remote to use cloud relay settings.'],
    INVALID_ACTIVATION_FILE:['请选择办理页生成的中转激活文件。','Select an activation file from the relay portal.'],
    ACTIVATION_FILE_EXPIRED:['激活文件已过期。可重新下载，或在办理页领取密钥手动配置。','The activation file expired. Download a new one or claim the key for manual setup.'],
    LOCAL_PAIRING_REQUIRED:['请连接主机的局域网地址，或在主机本机管理页导入。','Connect over the LAN or import on the host’s local management page.'],
    RELAY_ACTIVATION_PENDING:['主机已有待确认的导入。请先到电脑管理页处理。','An import is already waiting for confirmation on the host.'],
    RELAY_ACTIVATION_NOT_PENDING:['这项导入已完成或超时，请刷新状态。','This import finished or timed out. Refresh the status.'],
    HOST_ALREADY_CONFIGURED:['此主机已绑定其他中转资格。请核对主机或在管理页手动处理。','This host is bound to a different relay authorization. Check the host or configure it manually.'],
  }
  const registrationLabels={
    idle:['登记状态未查询','Registration not checked'],loading:['正在查询登记进度…','Checking application status…'],
    none:['本设备没有已保存的登记','No application saved on this device'],
    unavailable:['暂时无法确认登记进度','Could not verify application status'],
    draft:['已登记 · 待提交','Registered · Not submitted'],submitted:['已提交 · 等待审核','Submitted · In review'],
    approved:['审核通过','Approved'],renewable:['审核通过 · 可续费','Approved · Renewal available'],
    expired:['登记或资格已到期','Application or eligibility expired'],rejected:['审核未通过','Not approved'],revoked:['资格已撤销','Eligibility revoked']
  }
  function mount(target, { connection, path = '/relay', credentials, phonePairingCode, syncActivation, deviceManagement = true, service = false } = {}) {
    if (!target || target.dataset.relayMounted) return
    target.dataset.relayMounted='true';target.classList.add('relay-settings')
    const heading=el('div','relay-heading'),title=el('h3'),badge=el('span','relay-badge')
    heading.append(title,badge)
    const intro=el('p','relay-muted'),status=el('p','relay-status');status.setAttribute('aria-live','polite')
    const sponsor=el('div','relay-sponsor')
    const registration=el('section','relay-registration'),registrationTitle=el('h3'),registrationStatus=el('p','relay-status'),registrationHint=el('p','relay-muted')
    registrationStatus.setAttribute('role','status')
    const registrationActions=el('div','relay-actions'),registrationLink=el('a','mini-btn relay-primary'),registrationRecover=el('a','mini-btn'),registrationRefresh=el('button'),registrationInbox=el('button')
    registrationLink.target='_blank';registrationLink.rel='noopener noreferrer';registrationRefresh.type='button'
    registrationInbox.type='button';registrationInbox.hidden=true
    registrationRecover.target='_blank';registrationRecover.rel='noopener noreferrer';registrationRecover.hidden=true
    registrationActions.append(registrationLink,registrationRecover,registrationInbox,registrationRefresh);registration.append(registrationTitle,registrationActions,registrationStatus,registrationHint)
    let hostConnected=false
    const bridge=root.NativeBackground
    const automaticKey='dsh-relay-automatic-checkout-v1'
    const automaticSupported=service&&typeof bridge?.openCloudRelayAutomaticCheckout==='function'&&
      typeof bridge.cloudRelayAutomaticActivation==='function'&&typeof bridge.refreshCloudRelayAutomaticActivation==='function'&&!!root.crypto?.subtle
    let automaticCheckout=null, checkingAutomatic=false, nextAutomaticCheck=0
    if(automaticSupported){try{automaticCheckout=JSON.parse(root.localStorage.getItem(automaticKey))}catch{}}
    const checkRegistration=typeof bridge?.cloudRelayRegistration==='function'&&typeof bridge?.refreshCloudRelayRegistration==='function'
    const checkInbox=typeof bridge?.cloudRelayUnreadMessages==='function'&&typeof bridge?.openCloudRelayInbox==='function'
    registrationRefresh.addEventListener('click',()=>bridge.refreshCloudRelayRegistration())
    registrationInbox.addEventListener('click',()=>bridge.openCloudRelayInbox())
    registrationLink.addEventListener('click',event=>{
      if(registrationLink.dataset.automatic==='true'){
        event.preventDefault()
        void openAutomaticCheckout()
      }else if(root.DshSponsor?.openPortal())event.preventDefault()
    })
    registrationRecover.addEventListener('click',event=>{if(root.DshSponsor?.openPortal())event.preventDefault()})
    const address=el('div','relay-address'),link=el('a'),copy=el('button');copy.type='button';link.target='_blank';link.rel='noopener noreferrer';address.append(link,copy)
    const quota=el('div','relay-quota'),meter=el('progress'),usage=el('p'),reset=el('p','relay-muted');meter.max=100;quota.append(usage,meter,reset)
    const plan=el('p','relay-muted'),binding=el('p','relay-muted'),form=el('form','relay-form'),keyLabel=el('label'),keyInput=el('input')
    keyInput.type='password';keyInput.autocomplete='off';keyInput.spellcheck=false;keyInput.maxLength=128;keyInput.name='relay-key'
    keyLabel.append(el('span'),keyInput)
    const adminLabel=el('label'),adminInput=el('input');adminInput.type='password';adminInput.autocomplete='off';adminInput.name='relay-admin';adminLabel.append(el('span'),adminInput)
    const submit=el('button','relay-primary');submit.type='submit';form.append(keyLabel)
    if(!service)form.append(adminLabel)
    form.append(submit)
    const actions=el('div','relay-actions'),toggle=el('button'),refresh=el('button'),takeover=el('button');toggle.type=refresh.type=takeover.type='button';actions.append(takeover,toggle,refresh)
    const hint=el('p','relay-muted'),notice=el('p','relay-notice');notice.setAttribute('role','status')
    const activation = el('section', 'relay-activation')
    const importButton = el('button', 'relay-primary', text('导入中转激活文件', 'Import relay activation file'))
    const importFile = el('input')
    importButton.type = 'button'; importFile.type = 'file'; importFile.name = 'relay-activation'
    importFile.accept = '.json,application/json'; importFile.hidden = true
    const activationNotice = el('p', 'relay-notice'); activationNotice.setAttribute('role', 'status')
    const approve = el('button', 'relay-primary', text('确认并绑定', 'Approve and bind'))
    const reject = el('button', '', text('拒绝导入', 'Reject import'))
    const retrySync = el('button', '', text('重试配置此手机', 'Retry setup on this phone'))
    const inboxOffer = el('div', 'relay-inbox-offer')
    const inboxTarget = el('p', 'relay-muted')
    const applyInbox = el('button', 'relay-primary', text('应用到此主机', 'Apply to this host'))
    const dismissInbox = el('button', '', text('稍后配置', 'Set up later'))
    applyInbox.type = dismissInbox.type = 'button'
    const inboxActions = el('div', 'relay-actions')
    inboxActions.append(applyInbox, dismissInbox)
    inboxOffer.append(inboxTarget, inboxActions)
    approve.type = reject.type = retrySync.type = 'button'
    const activationActions = el('div', 'relay-actions')
    activationActions.append(importButton, approve, reject, retrySync)
    activation.append(inboxOffer, activationActions, importFile, activationNotice)
    const phoneGuide=el('section','relay-pair-guide'),phoneTitle=el('h3'),phoneHint=el('p','relay-muted')
    const showCode=el('button','relay-primary'),hideCode=el('button'),code=el('div','relay-phone-code'),phoneStatus=el('p','relay-pair-progress')
    showCode.type=hideCode.type='button';phoneStatus.setAttribute('role','status')
    phoneTitle.textContent=text('配对一台 Android 手机','Pair an Android phone')
    phoneHint.textContent=text('手机与电脑连接同一局域网。在 DSH Remote 的「主机与连接」扫描下方连接码，并在手机确认。连接码含访问凭据，请私下使用。','Connect the phone and computer to the same LAN. Scan this code in DSH Remote under Hosts and connections, then confirm on the phone. Keep the code private.')
    showCode.textContent=text('添加手机并显示连接码','Add a phone and show connection code')
    hideCode.textContent=text('关闭连接码','Close connection code')
    const recentPair=el('p','relay-muted')
    phoneGuide.append(phoneTitle,phoneHint,showCode,hideCode,code,phoneStatus,recentPair)
    const hostPanel = service ? el('section', 'relay-host-panel') : target
    hostPanel.append(heading,intro,status)
    hostPanel.append(activation)
    if(phonePairingCode)hostPanel.append(phoneGuide)
    if(!service)hostPanel.append(sponsor)
    const bindOptions=el('details','relay-bind-options')
    const bindSummary=el('summary')
    bindOptions.append(bindSummary,form)
    if(service)hostPanel.append(plan,binding,quota,address,bindOptions)
    else hostPanel.append(address,plan,quota,binding,bindOptions)
    if(service){adminLabel.className='relay-operation-auth';hostPanel.append(adminLabel)}
    hostPanel.append(actions,hint,notice)
    if(service)target.append(registration,hostPanel)
    const deviceTarget=el('div','relay-device-panel')
    if(deviceManagement)target.append(deviceTarget)
    const devices=deviceManagement?root.DshRelayDevices?.mount(deviceTarget,{connection,path:path+'/e2ee',credentials}):null
    let activeSetup='',pendingSetup=''
    function closeCode(){
      activeSetup='';pendingSetup='';code.textContent='';phoneStatus.textContent=''
      hideCode.hidden=true;showCode.disabled=false
    }
    hideCode.addEventListener('click',closeCode)
    showCode.addEventListener('click',async()=>{
      const ctx=syncIdentity()
      if(pendingSetup||activeSetup||value?.canManageDevices!==true||!value.enabled||!value.e2ee?.configured)return
      const random=root.crypto.getRandomValues(new Uint8Array(16))
      const setup=Array.from(random,byte=>byte.toString(16).padStart(2,'0')).join('')
      pendingSetup=setup;showCode.disabled=true
      phoneStatus.textContent=text('正在生成连接码…','Preparing the connection code…')
      try{
        const svg=await phonePairingCode(setup)
        if(!current(ctx)||pendingSetup!==setup)return
        if(!svg)throw Error('PAIR_CODE_UNAVAILABLE')
        code.innerHTML=svg;activeSetup=setup;hideCode.hidden=false
        phoneStatus.textContent=text('等待手机扫码并确认…','Waiting for the phone to scan and confirm…')
        lastRead=0
        void load()
      }catch{
        if(current(ctx)&&pendingSetup===setup)phoneStatus.textContent=text('暂时无法生成连接码。请确认网关已启动、存在可用局域网地址，再试一次。','Could not prepare the connection code. Check that the gateway is running and has a LAN address, then retry.')
      }finally{if(current(ctx)&&pendingSetup===setup){pendingSetup='';showCode.disabled=!!activeSetup}}
    })
    let identity='',value=null,lastRead=0,busy=false,loading=false,controller=null,destroyed=false,readError=false,failures=0
    let importReading=false, awaitingActivation='', syncedActivation='', syncing=false, activationMessage='', inboxActivation=null, automaticBinding=false
    function context() { const ctx=connection();return { ...ctx, endpoint:ctx.url(path) } }
    function current(ctx) { return !destroyed && ctx.valid() && identity===JSON.stringify([ctx.endpoint,ctx.headers?.authorization||'']) }
    function syncIdentity() {
      const ctx=context(),next=JSON.stringify([ctx.endpoint,ctx.headers?.authorization||''])
      hostConnected=ctx.connected!==false
      if(next!==identity){identity=next;controller?.abort();controller=null;keyInput.value='';adminInput.value='';bindOptions.open=false;value=null;notice.textContent='';lastRead=0;loading=false;busy=false;readError=false;failures=0;closeCode()
        importReading=false;awaitingActivation='';syncedActivation='';syncing=false;automaticBinding=false;activationMessage='';importFile.value='';render()}
      return ctx
    }
    function render() {
      devices?.update(value)
      if(phonePairingCode){
        phoneGuide.hidden=value?.canManageDevices!==true||!value.enabled||!value.e2ee?.configured
        if(phoneGuide.hidden&&(activeSetup||pendingSetup))closeCode()
        const activity=Array.isArray(value?.pairingActivity)?value.pairingActivity:[]
        if(activeSetup){
          const recent=activity.find(device=>device.setupId===activeSetup)
          const message=recent?.firstPublicAccessAt
            ?text('手机已从公网访问这台电脑。请在手机查看会话验证结果。','The phone reached this computer over the relay. Check the session verification result on the phone.')
            :recent?text('电脑已收到配对，等待手机验证公网。','Pairing received. Waiting for the phone to verify public access.')
              :text('等待手机扫码并确认…','Waiting for the phone to scan and confirm…')
          if(phoneStatus.textContent!==message)phoneStatus.textContent=message
        }
        const latest=activity[activity.length-1]
        recentPair.hidden=!latest
        if(latest){
          const when=new Date(latest.createdAt).toLocaleString()
          const state=latest.firstPublicAccessAt?text('已从公网访问','Reached over public relay'):text('已创建设备，等待公网验证','Device created, awaiting public verification')
          const message=text('最近的设备配对 · ','Most recent device pairing · ')+when+' · '+state
          if(recentPair.textContent!==message)recentPair.textContent=message
        }
      }
      if(service)renderRegistration()
      else root.DshSponsor?.mount(sponsor)
      title.textContent=service?text('这台主机的中转','Relay for this host'):text('云服务器中转','Cloud relay')
      intro.textContent=service?'':text('让手机通过公网连接这台主机。每位用户使用自己的中转密钥，首次开通会绑定此主机。','Connect to this host over the internet. Your personal relay key binds to this host when activated.')
      const phase=service&&!hostConnected?'disconnected':service&&value?.legacyAvailable?'legacy':service&&value?.phase!=='quota-exceeded'&&value?.configured===false?'unconfigured':value?.phase||(readError?'unavailable':loading||service?'loading':'unconfigured')
      const names={loading:['正在读取','Loading'],unavailable:['状态读取失败','Status unavailable'],unconfigured:['尚未开通','Not configured'],disabled:['已停用','Disabled'],connecting:['正在连接','Connecting'],online:['主机中转在线','Host relay online'],reconnecting:['正在重连','Reconnecting'],expired:['授权已到期','Expired'],'authorization-inactive':['授权已撤销或到期','Authorization inactive'],'quota-exceeded':['今日流量已用完','Daily quota reached'],'quota-unavailable':['流量服务暂不可用','Quota service unavailable'],error:['连接异常','Connection error']}
      names.disconnected=['尚未连接主机','No host connected'];names.legacy=['已有登记的试用连接','Existing trial connection']
      if(service)names.unconfigured=['此主机未绑定','Host not bound']
      badge.textContent=phase==='quota-exceeded'&&value?.daily?.period==='month'?text('本月流量已用完','Monthly quota reached'):text(...(names[phase]||names.error));badge.dataset.phase=phase
      status.textContent=busy?text('正在保存并绑定，请稍候…','Saving and binding…'):value?.error?text('请检查主机配置或刷新状态。','Check the host configuration or refresh.'):service?'':text('开通后会随 Remote 网关启动，无需单独运行工具。','Starts with the Remote gateway after activation.')
      let safeUrl=''
      try { const url=new URL(value?.publicUrl);if(url.protocol==='https:'&&!url.username&&!url.password)safeUrl=url.origin } catch {}
      address.hidden=!safeUrl;link.textContent=safeUrl;link.href=safeUrl||'#';copy.textContent=text('复制地址','Copy URL')
      const daily=value?.daily
      const planType = relayPlan(value)
      plan.hidden = !planType
      const hasPacks=Number(daily?.fallbackLimitBytes)>0 || Number(value?.monthlyLimitBytes)>5e9
      const fileEnabled=value?.fileTransfer===true && hasPacks
      plan.textContent=planType==='early-test'?text('特殊先行测试用户','Special early tester'):plan.hidden?'':fileEnabled?text('流量包已生效 · 支持文件传输','Data pack active · File transfer enabled'):text('基础中转 · 一个服务月 5GB · 单网关绑定 · 支持对话图片，不含文件传输。','Basic relay · 5GB per service month · One gateway · Chat images supported; file transfer excluded.')
      quota.hidden=!daily
      if(daily?.unavailable){usage.textContent=text('无法确认流量额度，云端暂停传输。','Quota unavailable; cloud transfer is paused.');meter.hidden=true;reset.textContent=''}
      else if(daily){
        meter.hidden=false;meter.value=Math.min(100,Math.max(0,Number(daily.usedBytes)/Number(daily.limitBytes)*100))
        const gb=bytes=>(Math.max(0,Number(bytes)||0)/1e9).toFixed(2)
        const monthly=daily.period==='month'
        usage.textContent=text(`${monthly?'本月':'今日'}已用 ${gb(daily.usedBytes)} / ${gb(daily.limitBytes)} GB · 剩余 ${gb(daily.remainingBytes)} GB`,`${monthly?'This month':'Today'} ${gb(daily.usedBytes)} / ${gb(daily.limitBytes)} GB · ${gb(daily.remainingBytes)} GB left`)
        reset.textContent=monthly?(fileEnabled?text('对话、图片和文件共用本期额度。','Chat, images and files share this service month quota.'):hasPacks&&daily.exhausted?text('文件流量额度已用完。直接 HTTPS 连接可继续使用剩余的文本和图片兜底额度。','File quota reached. Direct HTTPS can use any remaining allowance for chat and images.'):text('上传与下载及对话图片合计；额度覆盖本次开通的服务月。','Uploads, downloads and chat images share this service month quota.')):text('上传与下载合计；北京时间每天 00:00 重置。','Uploads + downloads; resets daily at 00:00 Beijing time.')
      }
      const expires=value?.expiresAt?new Date(value.expiresAt).toLocaleString():''
      binding.textContent=value?.configured?text(`已绑定此主机${expires?' · 有效期至 '+expires:''}`,`Bound to this host${expires?' · Until '+expires:''}`):''
      bindSummary.textContent=text('手动配置中转密钥','Configure relay key manually')
      renderActivation()
      adminLabel.hidden=value?.canManage!==false
      keyLabel.firstChild.textContent=text(value?.configured?'更换个人中转密钥':'个人中转密钥',value?.configured?'Replace personal relay key':'Personal relay key')
      keyInput.placeholder='dsrp_…';keyInput.setAttribute('aria-label',keyLabel.firstChild.textContent)
      adminLabel.firstChild.textContent=text('主机管理令牌（仅本次操作）','Host admin token (this operation only)')
      adminInput.setAttribute('aria-label',adminLabel.firstChild.textContent)
      submit.textContent=busy?text('正在处理…','Working…'):text(value?.configured?'绑定新密钥':'绑定并开启',value?.configured?'Bind new key':'Bind and enable')
      submit.disabled=busy||!value;keyInput.disabled=busy;adminInput.disabled=busy
      toggle.hidden=!value?.configured;toggle.disabled=busy||service&&readError;toggle.textContent=text(value?.enabled?'停用中转':'开启中转',value?.enabled?'Disable relay':'Enable relay')
      refresh.textContent=text('刷新状态','Refresh');refresh.disabled=busy||loading
      takeover.hidden=!value?.legacyAvailable;takeover.disabled=busy;takeover.textContent=text('接管已有试用连接','Take over existing trial')
      hint.textContent=value?.quotaPending?text('等待云端确认流量额度…','Waiting for cloud quota…'):service?(value?.enabled?text('停用会断开此公网入口。','Disabling disconnects this public route.'):''):value?.e2ee?.configured?text('Android 可从局域网扫码配对。配对文件可在设备管理中手动创建。','Pair Android over the LAN using a connection code. Manual pairing files are available in device management.'):text('手机使用此公网地址和原 Remote 访问令牌。停用会断开通过此入口的连接；授权到期或用满后，请通过本地地址管理。','Use this URL and your existing Remote access token. Disabling disconnects this route; use a local address after expiry or quota exhaustion.')
    }
    function renderActivation() {
      const request = value?.activationRequest
      const canApprove = !service && value?.canManageDevices === true && request?.phase === 'pending'
      inboxOffer.hidden = !inboxActivation
      if (inboxActivation) {
        const endpoint = context().endpoint
        let host = ''
        if (hostConnected) { try { host = new URL(endpoint).host } catch {} }
        const description = host
          ? text('收到站内激活。将应用到当前主机：', 'Activation received. Apply it to the current host: ') + host
          : text('收到站内激活。请先通过局域网连接要绑定的主机。', 'Activation received. Connect to the intended host over the LAN first.')
        if (inboxTarget.textContent !== description) inboxTarget.textContent = description
      }
      applyInbox.disabled = busy || loading || syncing
      dismissInbox.disabled = busy
      importButton.disabled = busy || importReading || syncing
      approve.hidden = reject.hidden = !canApprove
      approve.disabled = reject.disabled = busy
      retrySync.hidden = !syncActivation || !value?.enabled || !value.activationId || !value.canPairLocally
      retrySync.disabled = syncing || busy
      const message = canApprove
        ? text('有一台已认证的手机请求绑定中转。确认后将绑定到这台电脑。','An authenticated phone requested relay activation. Approval binds it to this computer.')
        : activationMessage
      if (activationNotice.textContent !== message) activationNotice.textContent = message
    }
    function manualActivation(message) {
      activationMessage = message + ' ' + text('仍可展开「手动配置中转密钥」。','Manual relay-key setup is still available.')
      bindOptions.open = true
      renderActivation()
    }
    function updateActivation(ctx) {
      const request = value?.activationRequest
      if (awaitingActivation) {
        if (request?.id === awaitingActivation && (request.phase === 'pending' || request.phase === 'binding')) return
        const bound = value?.activationId === awaitingActivation || request?.id === awaitingActivation && request.phase === 'bound'
        awaitingActivation = ''
        if (!bound) {
          automaticBinding = false
          manualActivation(request?.error && messages[request.error] ? text(...messages[request.error]) : text('手机发起的导入未完成。请在电脑检查确认结果。','The import from this phone did not complete. Check its confirmation on the host.'))
          return
        }
        activationMessage = text('主机已绑定。','Host bound.')
      }
      if (!document.hidden && (automaticBinding || target.getClientRects().length)) void syncImportedActivation(ctx)
    }
    async function syncImportedActivation(ctx, retry = false) {
      const id = value?.activationId
      if (!syncActivation || !value?.enabled || !value.canPairLocally || !id || syncing || !retry && syncedActivation === id) return
      syncedActivation = id; syncing = true
      activationMessage = text('主机已绑定，正在配置此手机…','Host bound. Setting up this phone…')
      renderActivation()
      let result
      try { result = await syncActivation(value) } catch {}
      if (!current(ctx)) return
      syncing = false
      automaticBinding = false
      if (result?.ok) {
        activationMessage = text('主机已绑定，手机已配置，公网连接已验证。','Host bound. Phone configured and relay connection verified.')
        renderActivation()
      } else {
        manualActivation(text('主机已绑定，手机配置未完成。可重试，也可用下方配对入口或手动添加公网地址。','The host is bound. Retry setup, use pairing below or add the public address manually.'))
      }
    }
    function parseActivation(contents) {
      if (typeof contents !== 'string' || contents.length > 4096) throw Object.assign(Error('INVALID_ACTIVATION_FILE'), { code: 'INVALID_ACTIVATION_FILE' })
      const data = JSON.parse(contents)
      if (!data || data.type !== 'dsh-remote-relay-activation' || data.version !== 1 ||
          typeof data.code !== 'string' || !/^dsra_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/.test(data.code) ||
          !Number.isSafeInteger(data.expiresAt) || Object.keys(data).length !== 4) {
        throw Object.assign(Error('INVALID_ACTIVATION_FILE'), { code: 'INVALID_ACTIVATION_FILE' })
      }
      if (data.expiresAt <= Date.now()) throw Object.assign(Error('ACTIVATION_FILE_EXPIRED'), { code: 'ACTIVATION_FILE_EXPIRED' })
      return data
    }
    function receiveActivation(raw) {
      const ctx = syncIdentity()
      try {
        inboxActivation = parseActivation(raw)
        activationMessage = ''
        renderActivation()
        if (ctx.connected !== false && !busy) void load(true)
      } catch (error) {
        inboxActivation = null
        manualActivation(text(...(messages[error.code] || messages.INVALID_ACTIVATION_FILE)))
      }
    }
    async function hostFingerprint(ctx) {
      const authorization=ctx.headers?.authorization
      if(!authorization)return ''
      const digest=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([ctx.endpoint,authorization])))
      return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
    }
    async function openAutomaticCheckout() {
      const ctx=syncIdentity()
      try {
        const host=await hostFingerprint(ctx)
        if(!host||!current(ctx)||value?.canPairLocally!==true||value.configured!==false)return
        const ticket=root.crypto.randomUUID().replaceAll('-','')
        const selection={ticket,host}
        root.localStorage.setItem(automaticKey,JSON.stringify(selection))
        automaticCheckout=selection;nextAutomaticCheck=0
        bridge.openCloudRelayAutomaticCheckout(ticket)
      }catch{root.DshSponsor?.openPortal()}
    }
    async function checkAutomaticCheckout() {
      const selection=automaticCheckout
      if(!selection||checkingAutomatic||document.hidden||Date.now()<nextAutomaticCheck||busy||loading)return
      const state=bridge.cloudRelayRegistration()
      if(state!=='submitted'&&state!=='approved'&&state!=='renewable')return
      nextAutomaticCheck=Date.now()+12000;checkingAutomatic=true
      try {
        const ctx=syncIdentity()
        if(ctx.connected===false||await hostFingerprint(ctx)!==selection.host||!current(ctx)||automaticCheckout!==selection)return
        await load(true)
        if(!current(ctx)||readError||value?.activationImport!==true||value.canPairLocally!==true||value.configured!==false||value.legacyAvailable)return
        const raw=bridge.cloudRelayAutomaticActivation(selection.ticket)
        if(!raw){bridge.refreshCloudRelayAutomaticActivation(selection.ticket);return}
        const data=parseActivation(raw)
        root.localStorage.removeItem(automaticKey)
        automaticCheckout=null;automaticBinding=true
        if(!await change('activate-file',{activation:data},ctx)&&current(ctx)){
          automaticBinding=false;inboxActivation=data;renderActivation()
        }
      }catch{}finally{checkingAutomatic=false}
    }
    function renderRegistration() {
      const raw=checkRegistration?bridge.cloudRelayRegistration():'unavailable'
      const state=Object.hasOwn(registrationLabels,raw)?raw:'unavailable'
      const verifiedUnbound=hostConnected&&!readError&&value?.configured===false&&!value.legacyAvailable&&value.phase!=='quota-exceeded'
      const canStart=verifiedUnbound&&(state==='none'||!bridge)
      const automatic=automaticSupported&&canStart&&value.activationImport===true&&value.canPairLocally===true
      const canRestart=verifiedUnbound&&['expired','rejected','revoked'].includes(state)
      const manageRegistration=!(canStart||canRestart||state==='none'&&!hostConnected||!bridge&&!hostConnected)
      registrationTitle.textContent=text('云中转套餐','Cloud relay plans')
      const label=text(...registrationLabels[state])
      if(registrationStatus.textContent!==label)registrationStatus.textContent=label
      registrationHint.textContent=state==='none'?text('在别处登记过？用原查询凭证恢复后，这台 App 就能收到该编号的运营消息。','Applied elsewhere? Recover your application to receive messages for its number in this app.'):state==='unavailable'?text('可用原查询凭证核对，确认前请勿重复付款。','Verify with your recovery code before paying again.'):''
      if(automatic)registrationHint.textContent=text('申请编号自动保存。审核通过后，App 会尝试配置当前选定的局域网主机。','The application is saved here. After approval, the app will try to configure the selected host over the LAN.')
      registrationLink.dataset.automatic=String(automatic)
      if(root.DshSponsor)registrationLink.href=registrationRecover.href=root.DshSponsor.applicationUrl
      registrationLink.textContent=state==='draft'?text('继续办理','Continue application')
        :state==='submitted'?text('查看审核进度','Check review status')
        :manageRegistration?text('续费 / 购买流量包','Renew or buy data packs')
        :automatic?text('开通并自动配置此主机','Apply and set up this host automatically')
        :text('查看套餐并开通','View plans and activate')
      registrationRecover.textContent=text('续费 / 购买流量包','Renew or buy data packs')
      registrationRecover.hidden=manageRegistration
      registrationRefresh.hidden=!checkRegistration
      registrationRefresh.disabled=state==='loading'
      registrationRefresh.textContent=text('刷新登记','Refresh application')
      const unread=checkInbox?bridge.cloudRelayUnreadMessages():-1
      registrationInbox.hidden=!checkInbox||unread<0&&['idle','none','loading'].includes(state)
      registrationInbox.textContent=unread>0?text(`站内消息 · ${unread} 条未读`,`Inbox · ${unread} unread`):text('站内消息','Inbox')
      if(state==='idle'&&!document.hidden&&target.getClientRects().length)bridge.refreshCloudRelayRegistration()
    }
    async function load(force=false) {
      const ctx=syncIdentity()
      if(ctx.connected===false){notice.textContent=text('请先连接主机，再查看中转状态。','Connect to your host to read relay status.');return}
      if(busy||loading||!force&&(document.hidden||!target.getClientRects().length||Date.now()-lastRead<Math.min(60000,5000*2**Math.min(failures,4))))return
      loading=true;lastRead=Date.now();const abort=new AbortController();controller=abort
      const timeout=Math.max(15000,root.DshNetwork?.profile().readTimeout||30000)
      const timer=setTimeout(()=>abort.abort(),timeout)
      render()
      try {
        const response=await root.fetch(ctx.endpoint,{headers:ctx.headers,credentials,cache:'no-store',signal:abort.signal})
        let data
        try{data=await response.json()}catch{throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE',status:response.status})}
        if(!current(ctx))return
        if(response.status===429&&data.daily){value={phase:'quota-exceeded',daily:data.daily,configured:false};notice.textContent=data.daily.period==='month'?text('本月额度已用完。可从上方查看续费和购买流量包的选项，或用主机本地地址管理。','Monthly quota reached. See the options above for renewal and data packs, or manage through the local host.'):text('今日额度已用完。请用主机本地地址进入设置，或等待零点恢复。','Daily quota reached. Use the local host address or wait until reset.');return}
        if(!response.ok)throw Object.assign(Error(data.error||'HTTP_'+response.status),{code:data.error,status:response.status})
        if(data.supported!==true)throw Object.assign(Error('UNSUPPORTED_GATEWAY'),{code:'UNSUPPORTED_GATEWAY'})
        value=data;notice.textContent='';readError=false;failures=0
        updateActivation(ctx)
      }catch(error){
        if(current(ctx)&&!busy&&controller===abort){
          readError=true;failures++
          notice.textContent=error.status===401?text('访问令牌无效，请在主机与连接中重新连接。','Invalid access token. Reconnect in Hosts and connections.'):error.status===404?text('请将此主机 Remote 升级到 0.8.0-rc.2 或更新版本后使用。','Upgrade this host Remote to 0.8.0-rc.2 or later.'):messages[error.code]?text(...messages[error.code]):abort.signal.aborted?text('读取中转状态超时，请检查网络后刷新。','Relay status timed out. Check the network and refresh.'):text('暂时无法连接主机读取中转状态，可稍后刷新。','Cannot reach the host for relay status. Refresh shortly.')
        }
      }finally{clearTimeout(timer);if(current(ctx)&&controller===abort){loading=false;render()}}
    }
    async function change(action, parameters = {}, captured = null) {
      const ctx=syncIdentity();if(busy)return
      if (captured && (!current(captured) || captured.endpoint !== ctx.endpoint)) return
      const activationAction = ['activate-file', 'approve-activation', 'reject-activation'].includes(action)
      const key=keyInput.value.trim(),admin=adminInput.value.trim()
      if(action==='enroll'&&!/^dsrp_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/.test(key)){notice.textContent=text('请填写完整的个人中转密钥。','Enter the complete personal relay key.');return}
      busy=true;controller?.abort();loading=false;notice.textContent='';render()
      const abort=new AbortController();controller=abort;const timer=setTimeout(()=>abort.abort(),20000)
      // Clear immediately, including ambiguous network outcomes. Never store the key.
      keyInput.value='';adminInput.value=''
      try {
        const response=await root.fetch(ctx.endpoint,{method:'POST',headers:{...ctx.headers,...(admin?{authorization:'Bearer '+admin}:{}),'content-type':'application/json'},credentials,redirect:'error',body:JSON.stringify({action,...parameters,...(action==='enroll'?{key}:{})}),signal:abort.signal})
        const data=await response.json();if(!current(ctx))return
        if(!response.ok)throw Object.assign(Error(data.error),{code:data.error})
        value={...data,canManageDevices:data.canManageDevices ?? value?.canManageDevices};notice.textContent=text(action==='disable'?'中转已停用。':'设置已保存，正在确认云端连接。',action==='disable'?'Relay disabled.':'Saved. Confirming the cloud connection.')
        if (activationAction) {
          const request = data.activationRequest
          if (action === 'activate-file' && request?.phase === 'pending') {
            awaitingActivation = request.id
            activationMessage = text('请在主机本机的 Remote 管理页确认这项导入。','Approve this import on the host’s local Remote management page.')
          } else if (action === 'reject-activation') {
            activationMessage = text('已拒绝这项导入。','Import rejected.')
          } else if (request?.phase === 'failed') {
            manualActivation(messages[request.error] ? text(...messages[request.error]) : text('绑定失败。','Binding failed.'))
            return false
          } else {
            activationMessage = text('主机已绑定，正在确认云端连接。','Host bound. Confirming the relay connection.')
            updateActivation(ctx)
          }
        }
        return true
      }catch(error){if(current(ctx)){
        const detail = messages[error.code]?text(...messages[error.code]):text('暂时无法确认操作结果。请刷新状态后再决定是否重试。','Result unconfirmed. Refresh status before deciding whether to retry.')
        if(activationAction)manualActivation(detail);else notice.textContent=detail
      }}
      finally{clearTimeout(timer);if(current(ctx)){busy=false;lastRead=0;render()}}
    }
    importButton.addEventListener('click', () => importFile.click())
    importFile.addEventListener('change', async () => {
      const ctx = syncIdentity(), file = importFile.files?.[0]
      importFile.value = ''
      if (!file || busy || importReading) return
      if (ctx.connected === false || value?.activationImport !== true) {
        manualActivation(text('请先连接支持导入的主机，或在主机本机导入。','Connect to a compatible host or import on the host itself.'))
        return
      }
      importReading = true; activationMessage = ''; renderActivation()
      try {
        if (file.size > 4096) throw Object.assign(Error('INVALID_ACTIVATION_FILE'), { code: 'INVALID_ACTIVATION_FILE' })
        const data = parseActivation(await file.text())
        if (current(ctx)) await change('activate-file', { activation: data }, ctx)
      } catch (error) {
        if (current(ctx)) manualActivation(text(...(messages[error.code] || messages.INVALID_ACTIVATION_FILE)))
      } finally { if (current(ctx)) { importReading = false; renderActivation() } }
    })
    applyInbox.addEventListener('click', async () => {
      const ctx = syncIdentity(), data = inboxActivation
      if (!data || busy || loading || syncing) return
      if (data.expiresAt <= Date.now()) {
        inboxActivation = null
        manualActivation(text(...messages.ACTIVATION_FILE_EXPIRED))
        return
      }
      if (ctx.connected === false || value?.activationImport !== true || value.canPairLocally !== true) {
        manualActivation(text('请先通过局域网连接支持激活的主机。', 'Connect over the LAN to a host that supports activation.'))
        return
      }
      if (await change('activate-file', { activation: data }, ctx) && inboxActivation === data) {
        inboxActivation = null
        renderActivation()
      }
    })
    dismissInbox.addEventListener('click', () => { inboxActivation = null; renderActivation() })
    approve.addEventListener('click', () => void change('approve-activation', { requestId: value?.activationRequest?.id }))
    reject.addEventListener('click', () => void change('reject-activation', { requestId: value?.activationRequest?.id }))
    retrySync.addEventListener('click', () => void syncImportedActivation(syncIdentity(), true))
    form.addEventListener('submit',event=>{event.preventDefault();void change('enroll')})
    toggle.addEventListener('click',()=>void change(value?.enabled?'disable':'enable'))
    takeover.addEventListener('click',()=>void change('import'))
    refresh.addEventListener('click',()=>void load(true))
    copy.addEventListener('click',async()=>{
      const ctx=syncIdentity(),url=link.href
      try{await root.navigator.clipboard.writeText(url);if(current(ctx))notice.textContent=text('地址已复制。','URL copied.')}
      catch{if(current(ctx))notice.textContent=text('请选中上方地址复制。','Select the URL above to copy it.')}
    })
    function tick(){if(destroyed)return;syncIdentity();render();void load(automaticBinding&&!!awaitingActivation&&Date.now()-lastRead>=5000);void checkAutomaticCheckout()}
    const timer=setInterval(tick,1000);tick()
    return { receiveActivation, refresh:()=>load(true),destroy:()=>{destroyed=true;inboxActivation=null;clearInterval(timer);controller?.abort();closeCode();devices?.destroy();keyInput.value='';adminInput.value=''} }
  }
  function relayPlan(status) {
    if (status?.quotaPeriod === 'month' || status?.daily?.period === 'month') return 'basic'
    return status?.displayPlan === 'early-test' ? 'early-test' : ''
  }

  function connectionCategory(status, base) {
    if (status?.supported !== true) return 'unknown'
    if (status.canPairLocally === true) return 'direct'
    try {
      const address = new URL(status.publicUrl)
      if (address.protocol !== 'https:' || address.origin !== new URL(base).origin) return 'unknown'
    } catch {
      return 'unknown'
    }
    const plan = relayPlan(status)
    if (plan) return plan
    try {
      return new URL(status.server).origin !== new URL(root.DshSponsor?.applicationUrl).origin ? 'self-hosted' : 'relay'
    } catch {
      return 'relay'
    }
  }

  root.DshRelaySettings={mount,connectionCategory}
})(typeof window!=='undefined'?window:globalThis)
