/* Doctor entry for the authenticated host panel and gateway management page. */
'use strict'
;(function(root) {
  const uuid=()=>globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)
  const HANDOFF_KEY='dshRemoteDoctorHandoffV1'
  function saveSessionHandoff(sessionId,token) {
    const value=JSON.stringify({sessionId,token,origin:location.origin,at:Date.now()})
    try { root.sessionStorage.setItem(HANDOFF_KEY,value);if(root.sessionStorage.getItem(HANDOFF_KEY)===value)return } catch {}
    throw Error('无法保存本次连接，请在该主机的会话列表查看诊断结果。')
  }
  function restoreSessionConnection({state,newId=uuid,persist=()=>{}}) {
    let raw
    try { raw=root.sessionStorage.getItem(HANDOFF_KEY);root.sessionStorage.removeItem(HANDOFF_KEY) } catch { return false }
    if(!raw)return false
    let handoff
    try { handoff=JSON.parse(raw) } catch { return false }
    if(!handoff || typeof handoff!=='object' || Array.isArray(handoff))return false
    const sessionId=new URL(location.href).searchParams.get('sessionId'),age=Date.now()-handoff.at
    if(handoff.origin!==location.origin || !/^https?:$/.test(location.protocol) || !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId||'')
      || sessionId!==handoff.sessionId || !Number.isFinite(age) || age<0 || age>120000 || typeof handoff.token!=='string' || !handoff.token || handoff.token.length>4096)return false
    // Adopt this explicit same-origin navigation without overwriting another
    // saved identity or disabling the user's normal automatic selection policy.
    let server=state.servers.find(row=>String(row.url||'').replace(/\/+$/,'')===handoff.origin && row.token===handoff.token)
    if(!server){server={id:newId(),url:handoff.origin,token:handoff.token,note:'',group:state.activeGroup||'默认'};state.servers.unshift(server)}
    const group=server.group||'默认'
    if(!state.groups.includes(group))state.groups.push(group)
    state.activeGroup=group;state.groupActive[group]=server.id
    state.server=handoff.origin;state.token=handoff.token
    persist()
    return true
  }
  async function loadTarget({url=route=>route,headers={},connection={valid:()=>true},pluginMode=false}={}) {
    if(!connection.valid())throw Error('Connection changed')
    const response=await fetch(url(pluginMode?'/remote/admin/api/doctor-target':'/remote/api/doctor/target'),{headers,credentials:'same-origin',signal:AbortSignal.timeout(15000)})
    if(!response.ok)throw Error('Target unavailable')
    const text=await response.text()
    if(!connection.valid() || text.length>512*1024)throw Error('Target unavailable')
    return JSON.parse(text)
  }
  function open({state, pluginMode, token = () => '', copy, toast}) {
    if(typeof root.DshDoctor?.open!=='function'){toast?.('诊疗组件未能加载，请刷新页面后重试。','err');return false}
    const initial = state() || {}, identity = initial.hostname || location.host, savedToken = token()
    const valid = () => !!state() && (state().hostname || location.host) === identity && token() === savedToken
    async function rpc(method, payload) {
      if (!valid()) throw new Error('Connection changed')
      if (!['session.create','session.prompt'].includes(method)) throw new Error('Unsupported diagnosis operation')
      const id = uuid()
      const headers = {'content-type':'application/json','x-dsh-remote-client':'admin'}
      if (!pluginMode) headers.authorization = 'Bearer ' + savedToken
      const routes = pluginMode ? [method.replace('.', '/'), method] : [method]
      for (const route of routes) {
        const modern = route.includes('/')
        const response = await fetch('/api/' + route, {method:'POST', credentials:'same-origin',headers,
          body:JSON.stringify({type:'client-request',rpcId:id,method:route,payload:modern ? {args:{request:method==='session.prompt'?{...payload,requestId:payload.requestId||id}:payload}} : payload}),signal:AbortSignal.timeout(30000)})
        if (!valid()) throw new Error('Connection changed')
        if ([404,405,501].includes(response.status) && route !== routes.at(-1)) { await response.body?.cancel(); continue }
        const body = await response.json()
        if (!valid()) throw new Error('Connection changed')
        if (!response.ok || body.result?.ok !== true) throw new Error('DSH diagnosis request failed (' + response.status + ')')
        return body.result.value
      }
    }
    async function openSession(sessionId) {
      if (!valid()) return
      if (root.parent !== root) {
        const requestId = uuid()
        const opened = await new Promise(resolve=>{
          const finish = value=>{clearTimeout(timer);root.removeEventListener('message',reply);resolve(value)}
          const reply = event=>{if(event.source===root.parent && event.origin===location.origin && event.data?.source==='dsh-remote-host' && event.data.requestId===requestId)finish(event.data.opened===true)}
          const timer=setTimeout(()=>finish(false),1500)
          root.addEventListener('message',reply)
          root.parent.postMessage({source:'dsh-remote-admin',type:'open-session',sessionId,requestId},location.origin)
        })
        if (opened) return
      }
      // Web host tabs can return to DSH's recent conversations. Gateway
      // management tabs open the Remote conversation UI with a public ID only.
      if(!valid())return
      if (pluginMode) location.assign('/')
      else { saveSessionHandoff(sessionId,savedToken);location.assign('/?sessionId=' + encodeURIComponent(sessionId)) }
    }
    root.DshDoctor.open({connection:{valid},rpc,openSession,surface:'management',copy,toast,
      loadTarget:()=>loadTarget({pluginMode,connection:{valid},headers:pluginMode?{}:{authorization:'Bearer '+savedToken,'x-dsh-remote-client':'admin'}}),
      environment:()=>({surface:pluginMode?'DSH plugin panel':'Gateway management',appVersion:state()?.version,gatewayVersion:state()?.gatewayVersion || state()?.version,dshVersion:state()?.dshVersion,
        gatewayOk:state()?.mode==='gateway',gatewayReachable:state()?.upstream?.reachable,host:identity,mux:state()?.events?.mux?.connected?'connected':'unknown',hostEvents:state()?.events?.host?.connected?'connected':'unknown'})})
  }
  function consumeSessionLink(openSession, sessions) {
    const url = new URL(location.href), id = url.searchParams.get('sessionId')
    if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id) || !sessions.has(id)) return
    url.searchParams.delete('sessionId');history.replaceState(null,'',url.pathname + url.search + url.hash)
    void openSession(id)
  }
  root.DshDoctorEntry = {open,loadTarget,consumeSessionLink,restoreSessionConnection}
})(window)
