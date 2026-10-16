/* Durable write receipts. POST once, recover using GET only; zero dependencies. */
;(function(root) {
  'use strict'
  const methods = new Set(['session.create','session.prompt','session.updateQueue','session.selectModel',
    'session.rename','session.cancel','workspace.create','workspace.archiveSession',
    'goal.edit','goal.pause','goal.resume','goal.complete','goal.clear'])
  const pending = new Map()
  const storageKey = 'dshRemoteOperationReceiptsV1'
  function saved() { try { return JSON.parse(root.localStorage?.getItem(storageKey) || '[]').filter(row => Date.now()-row.createdAt<86400000).slice(-100) } catch { return [] } }
  function persist() {
    const rows=new Map(saved().map(row=>[row.id,row]))
    for(const row of pending.values())rows.set(row.id,{id:row.id,scope:row.scope,intent:row.intent,method:row.method,sessionId:row.sessionId,createdAt:row.createdAt})
    try { root.localStorage?.setItem(storageKey,JSON.stringify([...rows.values()].slice(-100))) } catch {}
    root.dispatchEvent?.(new Event('dsh-operation-change'))
  }
  function forget(id) {
    pending.delete(id)
    try { root.localStorage?.setItem(storageKey,JSON.stringify(saved().filter(row=>row.id!==id))) } catch {}
    root.dispatchEvent?.(new Event('dsh-operation-change'))
  }
  async function digest(value) {
    const input=new TextEncoder().encode(value)
    if(root.crypto?.subtle) {
      const bytes=await root.crypto.subtle.digest('SHA-256',input)
      return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('')
    }
    // LAN HTTP does not expose SubtleCrypto. Reuse the existing upload hasher.
    if(typeof root.SHA256==='function')return new root.SHA256().update(input).hex()
    throw new Error('SHA-256 unavailable')
  }
  function newId() {
    if(root.crypto.randomUUID)return root.crypto.randomUUID()
    return [...root.crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('')
  }
  async function restore(config) {
    const scope=await digest(config.url('/api/operations')+'\0'+config.headers.authorization)
    if(!config.valid())return scope
    for(const row of saved())if(row.scope===scope&&!pending.has(row.id))pending.set(row.id,{...row,phase:'unknown',config})
    for(const row of pending.values())if(row.scope===scope)row.config=config
    return scope
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  function unknown(id) {
    const error = new Error((root.I18N?.lang === 'en' ? 'Result unconfirmed. Check the conversation before sending again. Operation: ' : '结果未确认，请核对会话后再决定是否重发。操作编号：') + id)
    error.operationId = id; error.operationPending = true
    return error
  }
  async function execute(config) {
    const scope=await restore(config),intent=await digest(JSON.stringify([config.method,config.payload]))
    if(!config.valid())throw unknown('connection-changed')
    const existing=[...pending.values()].find(row=>row.scope===scope&&row.intent===intent)
    const id = existing?.id || newId(), createdAt = Date.now()
    const entry = existing || { id, scope, intent, method: config.method, sessionId: config.payload.sessionId || '', createdAt, phase: 'running', config }
    pending.set(id, entry)
    persist()
    const statusUrl = config.url('/api/operations?id=' + encodeURIComponent(id))
    const request = async (method, body) => {
      const response = await root.fetch(statusUrl, { method, headers: config.headers,
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) })
      if (!config.valid()) throw unknown(id)
      if (response.status === 401) throw Error('AUTH')
      const value = await response.json()
      if (!config.valid()) throw unknown(id)
      if (response.status >= 400) {
        if (response.status >= 500) throw unknown(id)
        if (method === 'GET' && response.status === 404) throw unknown(id)
        const error = new Error(value.error || ('HTTP ' + response.status)); error.rpcRejected = true; throw error
      }
      return value
    }
    let status
    try {
      try { status = existing ? await request('GET') : await request('POST', { method: config.method, payload: config.payload }) }
      catch (error) { if (error.message === 'AUTH' || error.rpcRejected || !config.valid()) throw error }
      for (let attempt = 0; config.valid() && Date.now() - createdAt < 90000; attempt++) {
        if (status?.phase === 'complete' || status?.phase === 'rejected') {
          entry.phase = status.phase; forget(id)
          return status.result
        }
        if (status?.phase === 'unknown') { entry.phase = 'unknown'; throw unknown(id) }
        await sleep(Math.min(3000, 400 + attempt * 250))
        try { status = await request('GET') }
        catch (error) { if (error.message === 'AUTH' || error.rpcRejected) throw error }
      }
      throw unknown(id)
    } catch (error) {
      if (error.rpcRejected || error.message === 'AUTH') forget(id)
      else entry.phase = 'unknown'
      persist()
      throw error
    }
  }
  async function check(id) {
    const entry = pending.get(id)
    if (!entry || !entry.config.valid()) return null
    const response = await root.fetch(entry.config.url('/api/operations?id=' + encodeURIComponent(id)), {
      headers: entry.config.headers, signal: AbortSignal.timeout(15000) })
    if (!entry.config.valid()) return null
    const value = await response.json()
    if (!entry.config.valid()) return null
    if (response.ok) { entry.phase = value.phase; if (['complete','rejected'].includes(value.phase)) forget(id) }
    return response.ok ? value : null
  }
  const api = { supports: method => methods.has(method), execute, check, restore,
    dismiss: id => { const row=pending.get(id);if(!row||row.phase!=='unknown'||!row.config.valid())return false;forget(id);return true },
    pending: () => [...pending.values()].filter(row => row.config.valid()).map(({id,method,sessionId,createdAt,phase}) => ({id,method,sessionId,createdAt,phase})) }
  root.DshOperations = api
  if (typeof module !== 'undefined') module.exports = api
})(typeof window === 'undefined' ? globalThis : window)
