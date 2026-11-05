/* Bootstrap a device pairing through an authenticated, user-confirmed LAN host. */
;(function(root) {
  'use strict'
  const bridge=root.NativeE2ee, attempts=new Set(), pairedOrigins=new Map()
  let busy=false
  const text=(zh,en)=>root.I18N?.lang==='en'?en:zh
  function localUrl(value) {
    try {
      const u=new URL(value),h=u.hostname.replace(/^\[|\]$/g,'')
      if (!['http:','https:'].includes(u.protocol) || u.username || u.password) return false
      if (h==='localhost'||h==='::1'||h.includes(':')&&/^(?:fc|fd|fe[89ab])[a-f0-9:]*$/i.test(h)) return true
      const parts=h.split('.').map(Number)
      if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255))return false
      const [a,b]=parts
      return a===10||a===127||a===192&&b===168||a===172&&b>=16&&b<=31
    } catch {return false}
  }
  async function offer({connection,onPaired,onStatus=()=>{},force=false}) {
    if(!bridge?.configure||bridge.supported?.()===false||busy)return
    const c=connection(),endpoint=new URL(c.url('/relay'),root.location.href)
    if(!c.valid()||!localUrl(endpoint.href)||!/^Bearer \S+$/i.test(c.headers?.authorization||''))return
    const key=JSON.stringify([endpoint.href,c.headers.authorization])
    if(!force&&attempts.has(key))return
    attempts.add(key);busy=true
    const headers={...c.headers},options={headers,cache:'no-store',redirect:'error'}
    const read=async url=>{
      const response=await root.fetch(url,{...options,signal:root.AbortSignal.timeout(8000)})
      if(!response.ok)throw Error('E2EE_HOST_UNAVAILABLE')
      return response.json()
    }
    const verify=async(origin,pin)=>{
      for(let i=0;i<4&&c.valid();i++) {
        try {
          const remote=await read(origin+'/relay')
          if(remote.e2ee?.fingerprint!==pin||new URL(remote.publicUrl).origin!==origin)throw Error('E2EE_HOST_MISMATCH')
          return true
        } catch {if(i<3&&c.valid())await new Promise(resolve=>root.setTimeout(resolve,1000))}
      }
      return false
    }
    try {
      const host=await read(endpoint.href)
      if(!c.valid()||!host.canPairLocally)return
      if(!host.enabled||!host.e2ee?.configured||!host.e2ee.enabled){attempts.delete(key);return}
      const origin=new URL(host.publicUrl).origin,pin=host.e2ee.fingerprint
      if(new URL(host.publicUrl).protocol!=='https:'||!/^[a-f0-9]{64}$/.test(pin))throw Error('E2EE_HOST_INVALID')
      const old=JSON.parse(bridge.info(origin))
      if(old.configured&&old.fingerprint===pin&&!old.error&&old.deviceId&&old.expiresAt>Date.now()) {
        if(!await verify(origin,pin))throw Error('E2EE_VERIFY_FAILED')
        if(c.valid()){pairedOrigins.set(endpoint.origin,origin);onPaired?.(origin,c)}
        return
      }
      if(old.error&&old.error!=='E2EE_DEVICE_EXPIRED')throw Error('E2EE_STORAGE_UNAVAILABLE')
      const message=text('为这台手机自动配置公网加密连接？请确认当前局域网连接是你自己的电脑。\n局域网：','Automatically configure this phone’s encrypted relay? Confirm this LAN connection is your own computer.\nLAN: ')
        +endpoint.origin+'\n'+text('公网：','Public: ')+origin
        +(old.fingerprint&&old.fingerprint!==pin?'\n'+text('主机证书已改变，将替换旧配对。','The host certificate changed. This replaces the previous pairing.'):'')
      if(!root.confirm(message)||!c.valid())return
      const pairUrl=new URL(endpoint.href);pairUrl.pathname=pairUrl.pathname.replace(/\/$/,'')+'/pair'
      onStatus(text('正在通过局域网配置加密中转…','Configuring encrypted relay over LAN…'))
      // A create request is sent once. An uncertain write is never replayed.
      const response=await root.fetch(pairUrl.href,{...options,method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({fingerprint:pin,label:text('Android 手机','Android phone')}),signal:root.AbortSignal.timeout(15000)})
      const data=await response.json()
      if(!c.valid())return
      const pair=data.pairing,url=pair&&new URL(pair.relayUrl)
      if(!response.ok||!pair||pair.fingerprint!==pin||url.origin!==origin||url.protocol!=='https:'||url.pathname!=='/relay/v1/e2ee'||url.search||url.hash||url.username||url.password)throw Error('E2EE_PAIRING_INVALID')
      const result=JSON.parse(bridge.configure(JSON.stringify(pair),old.fingerprint||''))
      if(result.error||result.origin!==origin)throw Error('E2EE_IMPORT_FAILED')
      const verified=await verify(origin,pin)
      if(!c.valid())return
      if(!verified)throw Error('E2EE_VERIFY_FAILED')
      pairedOrigins.set(endpoint.origin,origin);onPaired?.(origin,c)
      onStatus(text('公网配对已保存并验证，局域网连接保留。','Relay pairing saved and verified. The LAN connection is kept.'))
    } catch {
      if(c.valid())onStatus(text('公网配对尚未完成，局域网连接保留。请到云服务器中转重试；不会自动关闭加密。','Relay setup is incomplete. LAN remains connected. Retry in Cloud relay; encryption is never disabled automatically.'),true)
    } finally {busy=false}
  }
  root.DshRelayAutoPair={offer,localUrl,pairedOrigin:value=>{try{return pairedOrigins.get(new URL(value,root.location.href).origin)||''}catch{return ''}}}
})(typeof window!=='undefined'?window:globalThis)
