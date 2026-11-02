/* Host-local device administration. Pairing secrets live only in this page's memory. */
;(function(root) {
  'use strict'
  const text=(zh,en)=>root.I18N?.lang==='en'?en:zh
  const make=(tag,value)=>{const e=document.createElement(tag);if(value)e.textContent=value;return e}
  root.DshRelayDevices={mount(target,{connection,path,credentials}){
    const title=make('h3',text('中转设备与配对','Relay devices and pairing'))
    const hint=make('p',text('设备管理请在主机本地地址打开。每台设备独立配对，最长有效 30 天；到期后重新创建并导入。浏览器暂不支持此加密入口。','Open a local host address to manage devices. Each device has a separate pairing valid for up to 30 days. Create and import a new pairing after expiry. This encrypted entry does not support browsers yet.'))
    const panel=make('div'),enable=make('button',text('启用主机加密入口','Enable encrypted host entry')),refresh=make('button',text('刷新设备','Refresh devices'))
    const form=make('form'),label=make('input'),days=make('select'),create=make('button',text('创建设备配对','Create device pairing'))
    form.className='relay-device-form'
    label.placeholder=text('设备名称，例如：我的手机','Device name, e.g. My phone');label.maxLength=80;label.required=true;label.setAttribute('aria-label',label.placeholder)
    days.setAttribute('aria-label',text('配对有效期','Pairing validity'))
    for(const n of [7,14,30]){const option=make('option',text(n+' 天',n+' days'));option.value=String(n);days.append(option)}
    days.value='30';create.type='submit';form.append(label,days,create)
    const list=make('div'),rotate=make('button',text('更换主机证书并清除全部配对','Rotate host certificate and clear all pairings'))
    const notice=make('p'),download=make('button',text('保存配对文件（仅本次可用）','Save pairing file (available this time only)'))
    notice.setAttribute('role','status');download.hidden=true
    for(const b of [enable,refresh,rotate,download])b.type='button'
    panel.append(enable,form,refresh,list,rotate,download);target.append(title,hint,panel,notice)
    let host=null,data=null,identity='',busy=false,abort=null,pairing=null,disposed=false
    function ctx(){const c=connection();return {...c,endpoint:c.url(path)}}
    function valid(c){return !disposed&&c.valid()&&identity===JSON.stringify([c.endpoint,c.headers?.authorization||''])}
    function render(){
      panel.hidden=host?.canManageDevices!==true
      enable.hidden=host?.e2ee?.enabled===true;form.hidden=!host?.e2ee?.enabled;rotate.hidden=!host?.configured
      for(const b of [enable,refresh,rotate,create,label,days])b.disabled=busy
      download.hidden=!pairing;list.replaceChildren()
      for(const d of data?.devices||[]){
        const row=make('div');row.className='relay-device-row'
        const name=make('span',d.label+' · '+(d.active?text('有效至 ','Valid until ')+new Date(d.expiresAt).toLocaleString():d.revokedAt?text('已撤销','Revoked'):text('已到期','Expired')))
        const revoke=make('button',text('撤销','Revoke'));revoke.type='button';revoke.disabled=busy||!d.active
        revoke.addEventListener('click',()=>{if(root.confirm(text('撤销此设备？连接会立即断开，需要新配对才能再次访问。\n','Revoke this device? Its connections will close and a new pairing will be required.\n')+d.label))void run({action:'revoke-device',id:d.id})})
        row.append(name,revoke);list.append(row)
      }
      if(data&&!data.devices?.length)list.append(make('p',text('尚无设备，请创建配对后在 Android App 导入。','No devices. Create a pairing and import it in the Android app.')))
    }
    async function run(value){
      const c=ctx();if(busy||host?.canManageDevices!==true)return
      busy=true;abort?.abort();abort=new AbortController();const own=abort,timer=setTimeout(()=>own.abort(),20000)
      pairing=null;notice.textContent='';render()
      try{
        const response=await root.fetch(c.endpoint,{method:value?'POST':'GET',headers:{...c.headers,...(value?{'content-type':'application/json'}:{})},credentials,cache:'no-store',signal:own.signal,...(value?{body:JSON.stringify(value)}:{})})
        const result=await response.json();if(!valid(c))return
        if(!response.ok)throw Error(result.error||'E2EE_OPERATION_FAILED')
        data=result;host={...host,...result};pairing=result.pairing||null
        if(pairing)notice.textContent=text('配对已创建。请立即保存文件并安全传到对应设备；文件包含访问凭据，不能公开。创建或撤销会短暂断开其他中转连接。','Pairing created. Save it now and transfer it securely to the intended device. It contains access credentials. Creating or revoking a device briefly disconnects other relay clients.')
        else if(value)notice.textContent=text('已保存。中转连接会重新建立；已受理任务继续运行。','Saved. Relay connections will reconnect; accepted tasks continue.')
      }catch(error){if(valid(c))notice.textContent=error.message==='E2EE_DISABLED_BY_POLICY'?text('主机环境已明确关闭加密，请先在主机取消 DSH_REMOTE_RELAY_E2EE=0 并重启网关。','The host environment disables encryption. Remove DSH_REMOTE_RELAY_E2EE=0 and restart the gateway first.'):text('未能确认结果，请刷新设备列表后再决定是否重试。错误：','Result unconfirmed. Refresh the device list before deciding whether to retry. Error: ')+error.message}
      finally{clearTimeout(timer);if(valid(c)){busy=false;render()}}
    }
    form.addEventListener('submit',e=>{e.preventDefault();if(!label.value.trim())return;void run({action:'create-device',label:label.value.trim(),days:Number(days.value)})})
    refresh.addEventListener('click',()=>void run())
    enable.addEventListener('click',()=>{if(root.confirm(text('启用后旧公网入口将停止使用，需要先为 Android 创建并导入配对。当前中转连接会断开，请保留本地管理页面。','Enabling disables the legacy public entry. Create and import an Android pairing. Relay clients will disconnect; keep this local management page open.')))void run({action:'enable-encryption'})})
    rotate.addEventListener('click',()=>{if(root.confirm(text('确认更换主机证书？全部现有配对立即失效，所有设备需要重新配对。此操作无法撤销。','Rotate the host certificate? All existing pairings become invalid and every device must pair again. This cannot be undone.')))void run({action:'rotate-identity',confirm:'REPAIR_ALL_DEVICES'})})
    download.addEventListener('click',()=>{
      if(!pairing)return
      const url=URL.createObjectURL(new Blob([JSON.stringify(pairing,null,2)+'\n'],{type:'application/json'})),a=make('a')
      a.href=url;a.download='dsh-remote-device-'+pairing.deviceId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
    })
    return {update(value){
      const c=ctx(),next=JSON.stringify([c.endpoint,c.headers?.authorization||''])
      if(next!==identity){abort?.abort();identity=next;host=null;data=null;pairing=null;busy=false;label.value='';notice.textContent=''}
      const first=value?.canManageDevices===true&&host?.canManageDevices!==true
      // Keep fresh device-operation state until the next host status read.
      host=value;render();if(first)void run()
    },destroy(){disposed=true;abort?.abort();pairing=null;data=null;label.value='';list.replaceChildren()}}
  }}
})(typeof window!=='undefined'?window:globalThis)
