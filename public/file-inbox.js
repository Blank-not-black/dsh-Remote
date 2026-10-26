/* Foreground file inbox. Confirmation precedes every download; zero dependencies. */
;(function(root) {
  'use strict'
  const MAX = 50 * 1024 * 1024
  const zh = () => root.I18N?.lang !== 'en'
  const label = (cn, en) => zh() ? cn : en
  async function hash(bytes) {
    if (root.crypto?.subtle) return [...new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
    if (typeof root.SHA256 === 'function') return new root.SHA256().update(new Uint8Array(bytes)).hex()
    throw Error(label('当前环境无法校验文件', 'File verification is unavailable'))
  }
  function createClient(config) {
    let current = null, epoch = 0
    const requests = new Set()
    const stored = key => { try { return JSON.parse(root.localStorage.getItem(key) || 'null') } catch { return null } }
    const persist = ctx => { if (ctx.valid()) root.localStorage.setItem(ctx.storage, JSON.stringify(ctx.prefs)) }
    const requireCurrent = ctx => { if (!ctx.valid()) throw Error(label('连接已改变，请重新打开收件箱', 'Connection changed. Reopen the inbox.')) }
    async function identity() {
      const connection = config.capture(), generation = epoch
      if (!connection.token) throw Error(label('请先连接主机', 'Connect to a host first'))
      if (current?.valid()) return current
      const scope = await hash(new TextEncoder().encode(config.url('/api/file-inbox') + '\0' + connection.token))
      if (generation !== epoch || !connection.valid()) throw Error('connection-changed')
      const storage = 'dshRemoteFileInboxV1:' + scope
      let prefs = stored(storage)
      if (!/^[a-f0-9]{64}$/.test(prefs?.key || '')) {
        prefs = { key: [...root.crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''), name: config.native?.() ? 'Android' : label('浏览器', 'Browser'), jobs: {}, receipts: {} }
      }
      prefs.jobs ||= {}; prefs.receipts ||= {}
      const ctx = { connection, storage, prefs, lastRegister: 0, valid: () => generation === epoch && connection.valid() }
      persist(ctx); current = ctx
      return ctx
    }
    async function read(ctx, url, options, timeoutMs, decode) {
      requireCurrent(ctx)
      const controller = new AbortController(), timeout = AbortSignal.timeout(timeoutMs), abort = () => controller.abort()
      requests.add(controller); timeout.addEventListener('abort', abort, { once: true })
      try {
        const response = await root.fetch(url, { ...options, signal: controller.signal, redirect: 'error' })
        requireCurrent(ctx)
        const data = await decode(response)
        requireCurrent(ctx)
        return data
      } finally { requests.delete(controller); timeout.removeEventListener('abort', abort) }
    }
    async function api(ctx, body) {
      const { response, data } = await read(ctx, config.url('/api/file-inbox'), { method: body ? 'POST' : 'GET', headers: { ...config.headers(ctx.connection), 'content-type': 'application/json', 'x-dsh-remote-inbox-key': ctx.prefs.key }, ...(body ? { body: JSON.stringify(body) } : {}) }, 12000, async response => ({ response, data: await response.json() }))
      requireCurrent(ctx)
      if (!response.ok) throw Error(response.status === 404 ? label('主机尚不支持文件收件箱，请升级 Remote 插件', 'Update the host Remote plugin to use the file inbox') : String(data.error || 'HTTP ' + response.status))
      return data
    }
    async function acknowledge(ctx, id, phase) {
      requireCurrent(ctx)
      ctx.prefs.receipts[id] = phase; persist(ctx)
      await api(ctx, { action: 'receipt', id, phase })
      delete ctx.prefs.receipts[id]; persist(ctx)
    }
    async function sync() {
      const ctx = await identity()
      if (Date.now() - ctx.lastRegister > 20000) { ctx.device = await api(ctx, { action: 'register', name: ctx.prefs.name }); ctx.lastRegister = Date.now() }
      const before = await api(ctx)
      for (const id of Object.keys(ctx.prefs.jobs)) {
        const row = before.transfers.find(row => row.id === id)
        if (!row || ['expired', 'rejected', 'complete', 'downloaded'].includes(row.phase)) { delete ctx.prefs.jobs[id]; delete ctx.prefs.receipts[id]; persist(ctx) }
      }
      for (const id of Object.keys(ctx.prefs.receipts)) {
        const row = before.transfers.find(row => row.id === id)
        if (!row || ['expired', 'rejected', 'complete', 'downloaded'].includes(row.phase)) { delete ctx.prefs.receipts[id]; persist(ctx) }
      }
      for (const [id, job] of Object.entries(ctx.prefs.jobs)) {
        requireCurrent(ctx)
        let status
        try { status = JSON.parse(config.native()?.getFileDownloadStatus(job)) } catch { continue }
        // DownloadManager returns unknown after its record is removed. Let the
        // user retry instead of retaining a job that can never finish.
        if (!['complete', 'error', 'unknown'].includes(status?.phase)) continue
        try { await acknowledge(ctx, id, status.phase === 'complete' ? 'complete' : 'failed'); delete ctx.prefs.jobs[id]; persist(ctx) } catch {}
      }
      for (const [id, phase] of Object.entries(ctx.prefs.receipts)) { try { await acknowledge(ctx, id, phase) } catch {} }
      const value = await api(ctx)
      return { ...value, device: ctx.device, name: ctx.prefs.name, jobs: { ...ctx.prefs.jobs } }
    }
    return {
      sync,
      reset() { epoch++; current = null; for (const request of requests) request.abort(); requests.clear() },
      async rename(name) { const ctx = await identity(); requireCurrent(ctx); ctx.prefs.name = String(name).trim().slice(0, 60) || 'Remote'; persist(ctx); ctx.lastRegister = 0; return sync() },
      async reject(row) { const ctx = await identity(); return api(ctx, { action: 'reject', id: row.id }) },
      async receive(row) {
        const ctx = await identity()
        const accepted = await api(ctx, { action: 'accept', id: row.id })
        requireCurrent(ctx)
        const url = new URL(config.url('/fs/inbox-file'), root.location.href)
        url.searchParams.set('id', row.id); url.searchParams.set('ticket', accepted.ticket)
        const native = config.native?.()
        try {
          if (native?.downloadToDownloads && native?.getFileDownloadStatus) {
            const job = native.downloadToDownloads(url.href, accepted.fileName, ctx.connection.token)
            if (!/^\d+$/.test(String(job))) throw Error(label('系统下载未启动', 'System download did not start'))
            ctx.prefs.jobs[row.id] = String(job); persist(ctx)
            return { native: true }
          }
          const bytes = await read(ctx, url.href, { headers: config.headers(ctx.connection) }, 20 * 60 * 1000, async response => {
            if (!response.ok || accepted.size > MAX) throw Error(label('文件下载失败', 'Download failed'))
            return response.arrayBuffer()
          })
          requireCurrent(ctx)
          if (bytes.byteLength !== accepted.size || await hash(bytes) !== accepted.sha256) throw Error(label('文件校验失败', 'File verification failed'))
          requireCurrent(ctx)
          return { native: false, blob: new Blob([bytes], { type: 'application/octet-stream' }), name: accepted.fileName, id: row.id, valid: ctx.valid,
            handedOff: () => acknowledge(ctx, row.id, 'downloaded') }
        } catch (error) {
          if (ctx.valid()) { try { await acknowledge(ctx, row.id, 'failed') } catch {} }
          throw error
        }
      },
    }
  }

  const actionable = row => ['pending', 'accepted', 'downloading', 'failed'].includes(row.phase)
  const sessionTransfers = (rows, sessionId) => sessionId ? rows.filter(row => row.sessionId === sessionId && actionable(row)) : []
  let mounted
  function mount(config) {
    if (mounted || !root.document) return mounted
    const client = createClient(config), doc = root.document
    const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el }
    const button = (text, action, key, primary = false) => {
      const el = node('button', text, 'file-inbox-button' + (primary ? ' primary' : ''))
      el.type = 'button'; el.dataset.inboxFocus = key; el.addEventListener('click', action); return el
    }
    const files = doc.getElementById('file-inbox-files'), session = doc.getElementById('file-inbox-session')
    const slots = [files, session].filter(Boolean)
    let snapshot, busy = false, polling = false, note = '', noteId = '', lastSignature = '', destroyed = false, generation = 0, revision = 0
    let historyOpen = false, deviceOpen = false
    const expanded = new Set(), ready = new Map()
    const context = () => config.context?.() || { sessionId: '', inChat: false }
    const releasePrepared = () => { ready.forEach(item => URL.revokeObjectURL(item.url)); ready.clear() }
    const phases = () => ({ pending: label('等待接收', 'Awaiting acceptance'), accepted: label('准备下载', 'Preparing download'), downloading: label('下载中 / 等待回执', 'Downloading / awaiting receipt'), downloaded: label('已交给浏览器保存', 'Handed to browser'), complete: label('设备报告已保存', 'Device reports saved'), failed: label('接收失败', 'Receive failed'), rejected: label('已拒绝', 'Rejected'), expired: label('已过期', 'Expired') })
    function reset() { generation++; client.reset(); snapshot = null; note = ''; noteId = ''; busy = false; polling = false; lastSignature = ''; historyOpen = false; deviceOpen = false; expanded.clear(); releasePrepared(); render() }
    async function action(id, work) {
      if (busy) return
      const start = generation, scope = context(), active = doc.activeElement
      const focusKey = slots.some(slot => slot.contains(active)) ? active?.dataset?.inboxFocus : ''
      const actionRevision = ++revision
      busy = true; noteId = id; note = label('处理中…', 'Working…'); render()
      try { await work(); if (start !== generation) return; const value = await client.sync(); if (start !== generation) return; snapshot = value; note = ''; noteId = '' }
      catch (error) { if (start === generation) note = error.message }
      finally { if (start === generation) { busy = false; render(); restoreActionFocus(focusKey, scope, start, actionRevision) } }
    }
    function restoreActionFocus(key, scope, start, actionRevision) {
      if (!key) return
      // Wait for the session deck to select and reveal the replacement card.
      root.requestAnimationFrame(() => {
        const current = context(), active = doc.activeElement
        if (destroyed || start !== generation || actionRevision !== revision || busy ||
          current.sessionId !== scope.sessionId || current.inChat !== scope.inChat ||
          (active && active !== doc.body && active !== doc.documentElement)) return
        const visible = el => el && !el.disabled && !el.closest('[hidden],.hidden,[inert]') && el.getClientRects().length
        const candidates = slots.flatMap(slot => [...slot.querySelectorAll('[data-inbox-focus]')])
        const keys = [key.replace(/:accept$/, ':save'), key, key.replace(/:[^:]+$/, ':card')]
        const target = keys.map(value => candidates.find(el => el.dataset.inboxFocus === value && visible(el))).find(Boolean)
          || candidates.find(el => el.dataset.inboxFocus.startsWith('session:') && visible(el))
          || (scope.inChat ? [doc.getElementById('session-deck-stage'), doc.getElementById('composer-input'), doc.getElementById('composer')].find(visible)
            : candidates.find(el => el.dataset.inboxFocus === 'files:heading' && visible(el)))
        target?.focus({ preventScroll: true })
      })
    }
    function card(row, placement) {
      const compact = placement === 'session', prepared = ready.get(row.id)
      const el = node('article', null, 'file-inbox-card' + (compact ? ' is-compact' : '') + (actionable(row) ? ' needs-action' : ''))
      el.dataset.transferId = row.id
      const key = action => placement + ':' + row.id + ':' + action
      el.tabIndex = -1; el.dataset.inboxFocus = key('card')
      const head = node('div', null, 'file-inbox-card-head'), icon = node('span', '↓', 'file-inbox-icon'), names = node('div', null, 'file-inbox-names')
      icon.setAttribute('aria-hidden', 'true')
      const size = row.size < 1024 ? row.size + ' B' : row.size < 1048576 ? (row.size / 1024).toFixed(1) + ' KiB' : (row.size / 1048576).toFixed(2) + ' MiB'
      const purpose = [row.title && row.title !== row.fileName ? row.title : '', row.message].filter(Boolean).join(' · ')
      if (compact) {
        names.append(node('strong', row.fileName, 'file-inbox-filename'))
        const extension = /\.([a-z0-9]{1,10})$/i.exec(row.fileName)?.[1]?.toUpperCase()
        const meta = node('div', null, 'file-inbox-inline-meta'); meta.append(node('span', (extension ? extension + ' · ' : '') + size, 'file-inbox-size'))
        if (prepared || row.phase !== 'pending') meta.append(node('span', prepared ? label('传输校验通过', 'Transfer verified') : phases()[row.phase] || row.phase, 'file-inbox-phase ' + row.phase))
        head.append(names, meta); el.append(head, node('p', purpose || label('未附文件说明', 'No file description provided'), 'file-inbox-message'))
      } else {
        names.append(node('span', label('文件接收请求', 'File delivery'), 'file-inbox-eyebrow'), node('strong', row.fileName, 'file-inbox-filename'))
        head.append(icon, names, node('span', phases()[row.phase] || row.phase, 'file-inbox-phase ' + row.phase)); el.append(head)
        el.append(node('p', size + (row.title && row.title !== row.fileName ? ' · ' + row.title : ''), 'file-inbox-meta'))
        if (row.message) el.append(node('p', row.message, 'file-inbox-message'))
      }
      const details = node('details', null, 'file-inbox-details'); details.open = expanded.has(key('details'))
      details.append(node('summary', compact ? label('详情', 'Details') : label('查看详情', 'Details')))
      if (compact) details.append(node('p', label('文件：', 'File: ') + row.fileName), node('p', label('说明：', 'Description: ') + (purpose || label('未提供', 'Not provided'))))
      details.append(node('p', label('来源会话：', 'Session: ') + (config.sessionTitle?.(row.sessionId) || row.sessionId)), node('p', label('到期：', 'Expires: ') + new Date(row.expiresAt).toLocaleString()))
      details.addEventListener('toggle', () => details.open ? expanded.add(key('details')) : expanded.delete(key('details')))
      if (!compact) el.append(details)
      const actions = node('div', null, 'file-inbox-actions')
      if (prepared) {
        if (!compact) el.append(node('p', label('已校验，点击保存文件。', 'Verified. Save the file to continue.'), 'file-inbox-meta'))
        actions.append(button(label('保存文件', 'Save file'), () => action(row.id, async () => {
          if (!prepared.valid()) throw Error(label('连接已改变', 'Connection changed'))
          const anchor = node('a'); anchor.href = prepared.url; anchor.download = prepared.name; doc.body.append(anchor); anchor.click(); anchor.remove()
          await prepared.handedOff(); URL.revokeObjectURL(prepared.url); ready.delete(row.id)
        }), key('save'), true))
      } else if (actionable(row) && !snapshot.jobs?.[row.id]) {
        actions.append(button(row.phase === 'pending' ? label('接收文件', 'Accept file') : label('重新接收', 'Receive again'), () => action(row.id, async () => {
          const out = await client.receive(row)
          if (!out.native) ready.set(row.id, { ...out, url: URL.createObjectURL(out.blob) })
        }), key('accept'), true))
        if (row.phase === 'pending') actions.append(button(label('拒绝', 'Reject'), () => action(row.id, () => client.reject(row)), key('reject')))
      }
      if (compact) actions.append(details)
      if (actions.children.length) el.append(actions)
      if (note && noteId === row.id) el.append(node('p', note, 'file-inbox-note'))
      return el
    }
    function render() {
      if (destroyed) return
      const active = doc.activeElement, focused = active?.dataset?.inboxFocus, hadFocus = slots.some(slot => slot.contains(active))
      const rows = snapshot?.transfers || [], current = context()
      if (session) {
        const selected = current.inChat ? sessionTransfers(rows, current.sessionId) : []
        session.hidden = !selected.length
        session.replaceChildren()
        if (selected.length) {
          const header = node('div', null, 'file-inbox-head'), heading = node('h3', label('待接收文件', 'Incoming files'))
          header.append(heading, node('span', String(selected.length), 'file-inbox-count'))
          const list = node('div', null, 'file-inbox-list'); for (const row of selected) list.append(card(row, 'session'))
          session.append(header, list)
        }
      }
      if (files) {
        files.replaceChildren()
        const header = node('header', null, 'file-inbox-head'), heading = node('h2', label('文件收件箱', 'File inbox'))
        heading.tabIndex = -1; heading.dataset.inboxFocus = 'files:heading'
        const count = rows.filter(actionable).length
        header.append(heading, node('span', String(count), 'file-inbox-count'), button(label('刷新', 'Refresh'), tick, 'files:refresh'))
        files.append(header)
        files.append(node('p', label('DSH 发来的文件，确认后才会接收。', 'Files sent by DSH are downloaded only after you accept.'), 'file-inbox-intro'))
        if (note && !noteId) files.append(node('p', note, 'file-inbox-note'))
        const incoming = rows.filter(actionable), list = node('div', null, 'file-inbox-list')
        for (const row of incoming) list.append(card(row, 'files'))
        if (!incoming.length) list.append(node('p', snapshot ? label('暂无待接收文件', 'No incoming files') : label('连接主机后可接收文件', 'Connect to a host to receive files'), 'file-inbox-empty'))
        files.append(list)
        const history = rows.filter(row => !actionable(row))
        if (history.length) {
          const group = node('details', null, 'file-inbox-history'); group.open = historyOpen
          group.append(node('summary', label('已处理', 'History') + ' (' + history.length + ')'))
          const items = node('div', null, 'file-inbox-list'); for (const row of history) items.append(card(row, 'history'))
          group.append(items); group.addEventListener('toggle', () => { historyOpen = group.open }); files.append(group)
        }
        if (snapshot) {
          const device = node('details', null, 'file-inbox-device'); device.open = deviceOpen
          device.append(node('summary', label('接收设备 · ', 'Receiving device · ') + snapshot.name))
          const field = node('label', label('设备名称 ', 'Device name ')), input = node('input'); input.value = snapshot.name; input.maxLength = 60; input.dataset.inboxFocus = 'files:name'
          field.append(input); device.append(field, button(label('保存名称', 'Save name'), () => action('', async () => { await client.rename(input.value) }), 'files:rename'), node('small', label('设备编号：', 'Device id: ') + (snapshot.device?.id || '—')))
          device.addEventListener('toggle', () => { deviceOpen = device.open }); files.append(device)
        }
      }
      for (const slot of slots) for (const el of slot.querySelectorAll('button,input')) el.disabled = busy
      if (hadFocus && focused) {
        const target = slots.flatMap(slot => [...slot.querySelectorAll('[data-inbox-focus]')]).find(el => el.dataset.inboxFocus === focused)
        if (target?.tagName === 'INPUT') target.value = active.value
        if (target && !target.disabled) target.focus()
      }
    }
    async function tick() {
      if (destroyed || polling || busy || doc.visibilityState === 'hidden') return
      const start = generation, readRevision = revision
      polling = true
      try {
        const next = await client.sync(), signature = JSON.stringify(next)
        if (start !== generation || readRevision !== revision) return
        snapshot = next; note = ''; noteId = ''
        for (const [id, item] of ready) if (!next.transfers.some(row => row.id === id && row.phase === 'downloading')) { URL.revokeObjectURL(item.url); ready.delete(id) }
        if (signature !== lastSignature && doc.activeElement?.tagName !== 'INPUT') { render(); lastSignature = signature }
      } catch (error) { if (start === generation && readRevision === revision) { note = error.message; noteId = ''; render() } }
      finally { if (start === generation) polling = false }
    }
    async function open() { config.openFiles?.(); render(); files?.querySelector('h2')?.focus(); await tick() }
    const entries = [...doc.querySelectorAll('[data-file-inbox-open]')]
    for (const el of entries) el.addEventListener('click', open)
    const timer = root.setInterval(tick, 10000)
    doc.addEventListener('visibilitychange', tick)
    mounted = { open, render, reset, close: () => false, refresh: tick, destroy() { client.reset(); releasePrepared(); root.clearInterval(timer); doc.removeEventListener('visibilitychange', tick); for (const el of entries) el.removeEventListener('click', open); for (const slot of slots) slot.replaceChildren(); if (session) session.hidden = true; destroyed = true; mounted = null } }
    render(); void tick()
    return mounted
  }
  root.DshFileInbox = { createClient, sessionTransfers, mount, reset: () => mounted?.reset(), refresh: () => mounted?.refresh(), render: () => mounted?.render(), open: () => mounted?.open(), close: () => mounted?.close() }
  if (typeof module !== 'undefined') module.exports = root.DshFileInbox
})(typeof window !== 'undefined' ? window : globalThis)
