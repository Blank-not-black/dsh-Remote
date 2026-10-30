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
  }
  function mount(target, { connection, path = '/relay', credentials } = {}) {
    if (!target || target.dataset.relayMounted) return
    target.dataset.relayMounted='true';target.classList.add('relay-settings')
    const heading=el('div','relay-heading'),title=el('h3'),badge=el('span','relay-badge')
    heading.append(title,badge)
    const intro=el('p','relay-muted'),status=el('p','relay-status');status.setAttribute('aria-live','polite')
    const address=el('div','relay-address'),link=el('a'),copy=el('button');copy.type='button';link.target='_blank';link.rel='noopener noreferrer';address.append(link,copy)
    const quota=el('div','relay-quota'),meter=el('progress'),usage=el('p'),reset=el('p','relay-muted');meter.max=100;quota.append(usage,meter,reset)
    const binding=el('p','relay-muted'),form=el('form','relay-form'),keyLabel=el('label'),keyInput=el('input')
    keyInput.type='password';keyInput.autocomplete='off';keyInput.spellcheck=false;keyInput.maxLength=128;keyInput.name='relay-key'
    keyLabel.append(el('span'),keyInput)
    const adminLabel=el('label'),adminInput=el('input');adminInput.type='password';adminInput.autocomplete='off';adminInput.name='relay-admin';adminLabel.append(el('span'),adminInput)
    const submit=el('button','relay-primary');submit.type='submit';form.append(keyLabel,adminLabel,submit)
    const actions=el('div','relay-actions'),toggle=el('button'),refresh=el('button'),takeover=el('button');toggle.type=refresh.type=takeover.type='button';actions.append(takeover,toggle,refresh)
    const hint=el('p','relay-muted'),notice=el('p','relay-notice');notice.setAttribute('role','status')
    target.append(heading,intro,status,address,quota,binding,form,actions,hint,notice)
    let identity='',value=null,lastRead=0,busy=false,loading=false,controller=null,destroyed=false,readError=false,failures=0
    function context() { const ctx=connection();return { ...ctx, endpoint:ctx.url(path) } }
    function current(ctx) { return !destroyed && ctx.valid() && identity===JSON.stringify([ctx.endpoint,ctx.headers?.authorization||'']) }
    function syncIdentity() {
      const ctx=context(),next=JSON.stringify([ctx.endpoint,ctx.headers?.authorization||''])
      if(next!==identity){identity=next;controller?.abort();controller=null;keyInput.value='';adminInput.value='';value=null;notice.textContent='';lastRead=0;loading=false;busy=false;readError=false;failures=0;render()}
      return ctx
    }
    function render() {
      title.textContent=text('云服务器中转','Cloud relay')
      intro.textContent=text('让手机通过公网连接这台主机。每位用户使用自己的中转密钥，首次开通会绑定此主机。','Connect to this host over the internet. Your personal relay key binds to this host when activated.')
      const phase=value?.phase||(readError?'unavailable':loading?'loading':'unconfigured')
      const names={loading:['正在读取','Loading'],unavailable:['状态读取失败','Status unavailable'],unconfigured:['尚未开通','Not configured'],disabled:['已停用','Disabled'],connecting:['正在连接','Connecting'],online:['已连接','Connected'],reconnecting:['正在重连','Reconnecting'],expired:['授权已到期','Expired'],'authorization-inactive':['授权已撤销或到期','Authorization inactive'],'quota-exceeded':['今日流量已用完','Daily quota reached'],'quota-unavailable':['流量服务暂不可用','Quota service unavailable'],error:['连接异常','Connection error']}
      badge.textContent=phase==='quota-exceeded'&&value?.daily?.period==='month'?text('本月流量已用完','Monthly quota reached'):text(...(names[phase]||names.error));badge.dataset.phase=phase
      status.textContent=busy?text('正在保存并绑定，请稍候…','Saving and binding…'):value?.error?text('请检查主机配置或刷新状态。','Check the host configuration or refresh.'):text('开通后会随 Remote 网关启动，无需单独运行工具。','Starts with the Remote gateway after activation.')
      let safeUrl=''
      try { const url=new URL(value?.publicUrl);if(url.protocol==='https:'&&!url.username&&!url.password)safeUrl=url.origin } catch {}
      address.hidden=!safeUrl;link.textContent=safeUrl;link.href=safeUrl||'#';copy.textContent=text('复制地址','Copy URL')
      const daily=value?.daily
      quota.hidden=!daily
      if(daily?.unavailable){usage.textContent=text('无法确认流量额度，云端暂停传输。','Quota unavailable; cloud transfer is paused.');meter.hidden=true;reset.textContent=''}
      else if(daily){
        meter.hidden=false;meter.value=Math.min(100,Math.max(0,Number(daily.usedBytes)/Number(daily.limitBytes)*100))
        const gb=bytes=>(Math.max(0,Number(bytes)||0)/1e9).toFixed(2)
        const monthly=daily.period==='month'
        usage.textContent=text(`${monthly?'本月':'今日'}已用 ${gb(daily.usedBytes)} / ${gb(daily.limitBytes)} GB · 剩余 ${gb(daily.remainingBytes)} GB`,`${monthly?'This month':'Today'} ${gb(daily.usedBytes)} / ${gb(daily.limitBytes)} GB · ${gb(daily.remainingBytes)} GB left`)
        reset.textContent=monthly?text('上传与下载及对话图片合计；额度覆盖本次开通的服务月，不包含文件传输。','Uploads, downloads and chat images share this service month quota; file transfer is excluded.'):text('上传与下载合计；北京时间每天 00:00 重置。','Uploads + downloads; resets daily at 00:00 Beijing time.')
      }
      const expires=value?.expiresAt?new Date(value.expiresAt).toLocaleString():''
      binding.textContent=value?.fingerprint?text(`已绑定此主机 · ${value.fingerprint.slice(0,12)}${expires?' · 有效期至 '+expires:''}`,`Bound to this host · ${value.fingerprint.slice(0,12)}${expires?' · Until '+expires:''}`):''
      keyLabel.firstChild.textContent=text(value?.configured?'更换个人中转密钥':'个人中转密钥',value?.configured?'Replace personal relay key':'Personal relay key')
      keyInput.placeholder='dsrp_…';keyInput.setAttribute('aria-label',keyLabel.firstChild.textContent)
      adminLabel.hidden=value?.canManage!==false
      adminLabel.firstChild.textContent=text('主机管理令牌（仅本次操作）','Host admin token (this operation only)')
      adminInput.setAttribute('aria-label',adminLabel.firstChild.textContent)
      submit.textContent=busy?text('正在处理…','Working…'):text(value?.configured?'绑定新密钥':'绑定并开启',value?.configured?'Bind new key':'Bind and enable')
      submit.disabled=busy||!value;keyInput.disabled=busy;adminInput.disabled=busy
      toggle.hidden=!value?.configured;toggle.disabled=busy;toggle.textContent=text(value?.enabled?'停用中转':'开启中转',value?.enabled?'Disable relay':'Enable relay')
      refresh.textContent=text('刷新状态','Refresh');refresh.disabled=busy||loading
      takeover.hidden=!value?.legacyAvailable;takeover.disabled=busy;takeover.textContent=text('接管已有试用连接','Take over existing trial')
      hint.textContent=value?.quotaPending?text('等待云端确认流量额度…','Waiting for cloud quota…'):text('手机使用此公网地址和原 Remote 访问令牌。停用会断开通过此入口的连接；授权到期或用满后，请通过本地地址管理。','Use this URL and your existing Remote access token. Disabling disconnects this route; use a local address after expiry or quota exhaustion.')
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
        if(response.status===429&&data.daily){value={phase:'quota-exceeded',daily:data.daily,configured:false};notice.textContent=data.daily.period==='month'?text('本月额度已用完。请用主机本地地址管理；续期需在当前资格到期后重新申请。','Monthly quota reached. Manage through the local host; apply again after expiry.'):text('今日额度已用完。请用主机本地地址进入设置，或等待零点恢复。','Daily quota reached. Use the local host address or wait until reset.');return}
        if(!response.ok)throw Object.assign(Error(data.error||'HTTP_'+response.status),{code:data.error,status:response.status})
        if(data.supported!==true)throw Object.assign(Error('UNSUPPORTED_GATEWAY'),{code:'UNSUPPORTED_GATEWAY'})
        value=data;notice.textContent='';readError=false;failures=0
      }catch(error){
        if(current(ctx)&&!busy&&controller===abort){
          readError=true;failures++
          notice.textContent=error.status===401?text('访问令牌无效，请在主机与连接中重新连接。','Invalid access token. Reconnect in Hosts and connections.'):error.status===404?text('请将此主机 Remote 升级到 0.8.0-rc.2 或更新版本后使用。','Upgrade this host Remote to 0.8.0-rc.2 or later.'):messages[error.code]?text(...messages[error.code]):abort.signal.aborted?text('读取中转状态超时，请检查网络后刷新。','Relay status timed out. Check the network and refresh.'):text('暂时无法连接主机读取中转状态，可稍后刷新。','Cannot reach the host for relay status. Refresh shortly.')
        }
      }finally{clearTimeout(timer);if(current(ctx)&&controller===abort){loading=false;render()}}
    }
    async function change(action) {
      const ctx=syncIdentity();if(busy)return
      const key=keyInput.value.trim(),admin=adminInput.value.trim()
      if(action==='enroll'&&!/^dsrp_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/.test(key)){notice.textContent=text('请填写完整的个人中转密钥。','Enter the complete personal relay key.');return}
      busy=true;controller?.abort();loading=false;notice.textContent='';render()
      const abort=new AbortController();controller=abort;const timer=setTimeout(()=>abort.abort(),20000)
      // Clear immediately, including ambiguous network outcomes. Never store the key.
      keyInput.value='';adminInput.value=''
      try {
        const response=await root.fetch(ctx.endpoint,{method:'POST',headers:{...ctx.headers,...(admin?{authorization:'Bearer '+admin}:{}),'content-type':'application/json'},credentials,body:JSON.stringify({action,...(action==='enroll'?{key}:{})}),signal:abort.signal})
        const data=await response.json();if(!current(ctx))return
        if(!response.ok)throw Object.assign(Error(data.error),{code:data.error})
        value=data;notice.textContent=text(action==='disable'?'中转已停用。':'设置已保存，正在确认云端连接。',action==='disable'?'Relay disabled.':'Saved. Confirming the cloud connection.')
      }catch(error){if(current(ctx))notice.textContent=messages[error.code]?text(...messages[error.code]):text('暂时无法确认操作结果。请刷新状态后再决定是否重试。','Result unconfirmed. Refresh status before deciding whether to retry.')}
      finally{clearTimeout(timer);if(current(ctx)){busy=false;lastRead=0;render()}}
    }
    form.addEventListener('submit',event=>{event.preventDefault();void change('enroll')})
    toggle.addEventListener('click',()=>void change(value?.enabled?'disable':'enable'))
    takeover.addEventListener('click',()=>void change('import'))
    refresh.addEventListener('click',()=>void load(true))
    copy.addEventListener('click',async()=>{
      const ctx=syncIdentity(),url=link.href
      try{await root.navigator.clipboard.writeText(url);if(current(ctx))notice.textContent=text('地址已复制。','URL copied.')}
      catch{if(current(ctx))notice.textContent=text('请选中上方地址复制。','Select the URL above to copy it.')}
    })
    function tick(){if(destroyed)return;syncIdentity();render();void load()}
    const timer=setInterval(tick,1000);tick()
    return { refresh:()=>load(true),destroy:()=>{destroyed=true;clearInterval(timer);controller?.abort();keyInput.value='';adminInput.value=''} }
  }
  root.DshRelaySettings={mount}
})(typeof window!=='undefined'?window:globalThis)
