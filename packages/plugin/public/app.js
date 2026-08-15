/* DSH Remote 移动控制台 · 零依赖 */
'use strict'

/* ---------------- 状态 ---------------- */
const LS = {
  get(k, d) { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  del(k) { try { localStorage.removeItem(k) } catch {} }
}

const state = {
  token: '',
  server: '',             // 网关地址, 空 = 同源(浏览器模式)
  sessions: [],
  byId: new Map(),
  current: null,           // 当前打开的 sessionId
  hostInfo: null,
  localVersion: '',
  updateInfo: null,
  approvals: [],           // 待处理审批
  questions: [],           // 待处理提问
  queues: {},              // sessionId -> queue items
  jobs: {},                // sessionId -> jobs
  history: emptyHistory(),
  errCount: 0,
  refreshTimer: null
}

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36) }

function toast(text, kind = '') {
  const el = $('toast')
  el.textContent = text
  el.className = 'toast ' + kind
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200)
}

function fmtTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60e3) return '刚刚'
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前'
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

/* ---------------- API ---------------- */
function apiUrl(path) {
  return (state.server || '') + path
}
async function rpc(method, payload = {}) {
  const res = await fetch(apiUrl('/api/' + method), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web' },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload })
  })
  if (res.status === 401) throw new Error('AUTH')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const full = await res.json()
  if (!full?.result) throw new Error('坏响应')
  if (!full.result.ok) {
    const err = full.result.error || {}
    throw new Error(err.message || 'DSH 返回错误')
  }
  return full.result.value
}

async function respond(rpcId, value) {
  const res = await fetch(apiUrl('/api/respond'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } })
  })
  if (res.status === 401) throw new Error('AUTH')
  const receipt = await res.json()
  return receipt?.accepted === true
}

async function safeRpc(method, payload, errText) {
  try { return await rpc(method, payload) }
  catch (e) {
    if (e.message === 'AUTH') authFailure()
    else toast(errText ? `${errText}：${e.message}` : e.message, 'err')
    return null
  }
}

function authFailure() {
  toast('访问被拒绝：请检查令牌', 'err')
  showView('view-settings')
  $('token-desc').textContent = '令牌无效，点「更换」重新设置'
}

/* ---------------- 事件流 (WebSocket) ---------------- */
const streams = {}
state.streamsOk = { mux: false, host: false }

function openStreams() {
  openStream('mux', onMuxFrame, true)
  openStream('host', onHostFrame, false)
}

function openStream(kind, handler, refreshOnOpen) {
  let base
  if (state.server) {
    base = state.server.replace(/^http/, 'ws')
  } else {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${proto}//${location.host}`
  }
  const clientMark = CAP?.isNativePlatform?.() ? 'app' : 'web'
  const ws = new WebSocket(`${base}/api/events.${kind}?token=${encodeURIComponent(state.token)}&client=${clientMark}`)
  try { streams[kind]?.close() } catch {}
  streams[kind] = ws
  ws.onopen = () => {
    state.streamsOk[kind] = true
    state.errCount = 0
    updateConn()
    if (refreshOnOpen) refreshAll()
  }
  ws.onmessage = (msg) => {
    state.streamsOk[kind] = true
    state.errCount = 0
    updateConn()
    try {
      const full = JSON.parse(msg.data)
      handler(full)
    } catch {}
  }
  ws.onclose = () => {
    state.streamsOk[kind] = false
    state.errCount++
    updateConn()
    if (state.errCount === 3) toast('连接中断，正在重连…', 'err')
    // 无条件重连; 页面被挂起时定时器暂停, visibilitychange 会再触发一次
    if (streams[kind] === ws) setTimeout(() => openStream(kind, handler, refreshOnOpen), 1200)
  }
  ws.onerror = () => { try { ws.close() } catch {} }
}

/* 回前台恢复: 强制重排修复 MIUI WebView 后台切回时 sticky 顶栏不绘制的问题 */
function onResume() {
  if (document.visibilityState !== 'visible') return
  applyNativeInsets()
  // 视图状态与 body class 兜底同步(会话页顶栏按设计隐藏, 主页必须恢复显示)
  document.body.classList.toggle('in-session', !$('view-session').classList.contains('hidden'))
  const bar = document.querySelector('.topbar')
  if (bar) {
    bar.style.display = 'none'
    void bar.offsetHeight // 强制回流
    bar.style.display = ''
  }
  window.scrollTo(0, 0)
  updateConn()
}

/* 回前台 / 定时兜底: 任何流不在 OPEN 就重连 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    onResume()
    if (streams.mux?.readyState !== WebSocket.OPEN || streams.host?.readyState !== WebSocket.OPEN) openStreams()
  }
})
window.addEventListener('pageshow', onResume)
setInterval(() => {
  if (document.visibilityState === 'visible') {
    if (streams.mux?.readyState !== WebSocket.OPEN || streams.host?.readyState !== WebSocket.OPEN) openStreams()
  }
}, 15000)
function onMuxFrame(full) {
  const f = full.payload
  if (!f) return
  if (f.type === 'session/event') return onSessionEvent(f.sessionId, f.event)
  if (f.type === 'session/subscribed') return
  if (f.type === 'approval/requested') {
    state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId)
    state.approvals.push({ ...f, rpcId: full.rpcId })
    notify('工具审批', `${f.toolName || '未知工具'} 需要批准`)
    renderPending(); return
  }
  if (f.type === 'approval/resolved') { state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId); renderPending(); return }
  if (f.type === 'question/requested') {
    state.questions = state.questions.filter(q => q.rpcId !== full.rpcId)
    state.questions.push({ ...f, rpcId: full.rpcId })
    notify('DSH 提问', f.questions?.map(q => q.question).join(' / ') || '需要你回答')
    renderPending(); return
  }
  if (f.type === 'question/resolved') { state.questions = state.questions.filter(q => q.rpcId !== f.questionRpcId); renderPending(); return }
  if (f.type === 'session/queue') { state.queues[f.sessionId] = f.items || []; renderQueue(); return }
  if (f.type === 'session/jobs') { state.jobs[f.sessionId] = f.jobs || []; renderJobs(); return }
  if (f.type === 'session/projection') { applyProjection(f.sessionId, f.key, f.value, f.seq); return }
  if (f.type === 'stream/error') { toast('事件流错误：' + (f.error?.message || ''), 'err') }
}
function onHostFrame(full) {
  const f = full.payload
  if (!f) return
  if (['host/session-added', 'host/session-removed', 'host/workspace-changed', 'host/workspace-removed', 'host/workspace-order-changed', 'host/archived-sessions-changed'].includes(f.type)) return scheduleRefresh()
  if (f.type === 'host/session-status') {
    const s = state.byId.get(f.sessionId)
    if (s) { s.running = f.running; if (state.current === f.sessionId) { renderSessionCards(); updateCancelBtn() } }
    return
  }
  if (f.type === 'host/agent-error') return toast(`会话出错：${f.message}`, 'err')
  if (f.type === 'host/remote-event') return scheduleRefresh()
}

function onSessionEvent(sessionId, event) {
  if (!event) return
  const s = state.byId.get(sessionId)
  if (s) s.updatedAt = Date.now()
  if (event.type === 'agent/status') {
    if (s) { s.running = !!event.data?.running; s.blank = false }
    if (state.current === sessionId) { updateCancelBtn(); renderSessionSub() }
  }
  if (event.type === 'session/title' || event.type === 'title') {
    if (event.data?.title && s) s.projections.values.title = event.data.title
    if (state.current === sessionId) renderSessionTitle()
  }
  if (state.current === sessionId) insertLiveEvent(event)
  if (['goal/created', 'goal/updated', 'goal/completed', 'goal/cleared', 'todo/updated', 'plan/updated', 'checkpoint/created'].includes(event.type)) scheduleRefresh()
}

/* ---------------- 数据刷新 ---------------- */
function scheduleRefresh() {
  clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(refreshAll, 700)
}

async function refreshAll() {
  await refreshSessions()
  if (state.current) { renderSessionCards(); renderSessionSub(); updateCancelBtn() }
  renderPending(); renderQueue(); renderJobs(); updateConn()
}

async function refreshSessions() {
  const v = await safeRpc('session.list', {}, '拉取会话列表失败')
  if (!v) return
  state.sessions = v.items || []
  state.byId = new Map(state.sessions.map(s => [s.sessionId, s]))
  renderSessions()
}

function proj(s, key, d) { return s?.projections?.values?.[key] ?? d }
function applyProjection(sessionId, key, value, seq) {
  const s = state.byId.get(sessionId)
  if (s) {
    s.projections = s.projections || { asOfSeq: 0, values: {} }
    s.projections.values = s.projections.values || {}
    s.projections.values[key] = value
    s.projections.asOfSeq = Math.max(s.projections.asOfSeq || 0, seq || 0)
  }
  if (state.current === sessionId) { renderSessionTitle(); renderSessionCards() }
  if (['title', 'goal', 'todos', 'plan', 'sessionListMetadata'].includes(key)) scheduleRefresh()
  else renderSessions()
}function titleOf(s) { return proj(s, 'title') || short(s.sessionId) }
function short(id) { return '…' + String(id).slice(-8) }
function goalOf(s) {
  const p = proj(s, 'goal')
  if (!p) return null
  return p.goal && typeof p.goal === 'object' ? p.goal : p
}

function updatePendingBadge() {
  const pending = state.approvals.length + state.questions.length
  $('nav-pending').classList.toggle('hidden', pending === 0)
  if (pending) $('nav-pending').textContent = pending
}

function renderSessions() {
  const list = $('session-list')
  const items = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  list.innerHTML = items.map(s => {
    const title = titleOf(s)
    const goal = goalOf(s)
    const pending = (state.approvals.some(a => a.sessionId === s.sessionId) || state.questions.some(q => q.sessionId === s.sessionId)) ? 'pending' : ''
    const queueN = (state.queues[s.sessionId] || []).filter(i => i.placement === 'queued').length
    const dots = []
    if (s.running) dots.push('running')
    if (pending) dots.push('pending')
    const badge = goal ? `<span class="sc-badge ${goal.phase === 'active' ? 'goal-active' : ''}">目标·${esc(goal.phase || '?')}</span>` : ''
    const queueBadge = queueN ? `<span class="sc-badge">队列 ${queueN}</span>` : ''
    return `<div class="session-card ${state.current === s.sessionId ? 'current' : ''}" data-id="${esc(s.sessionId)}">
      <div class="sc-title">${esc(title)}</div>
      <div class="sc-meta">
        <span class="sc-dot ${dots.join(' ')}"></span>
        <span>${fmtTime(s.updatedAt)}</span>
        ${s.running ? '<span>运行中</span>' : ''}
        ${badge}${queueBadge}
      </div>
      <span class="sc-arrow">›</span>
    </div>`
  }).join('')
  $('home-empty').classList.toggle('hidden', items.length > 0)
  const running = state.sessions.filter(s => s.running).length
  const pending = state.approvals.length + state.questions.length
  $('stat-strip').innerHTML = `
    <div class="stat running"><div class="v">${running}</div><div class="k">运行中</div></div>
    <div class="stat pending"><div class="v">${pending}</div><div class="k">待处理</div></div>
    <div class="stat ctx"><div class="v">${items.length}</div><div class="k">会话总数</div></div>`
  updatePendingBadge()
}

/* ---------------- 会话详情 ---------------- */
async function openSession(id) {
  state.current = id
  state.history = emptyHistory()
  document.body.classList.add('in-session')
  showView('view-session')
  renderSessionTitle(); renderSessionSub(); updateCancelBtn()
  $('history').innerHTML = '<div class="empty">加载历史…</div>'
  await loadHistory(true)
  renderSessionCards()
  refreshSessions()
}

function closeSession() {
  state.current = null
  state.history = emptyHistory()
  document.body.classList.remove('in-session')
  showView('view-home')
}

/* Android 手势返回/实体返回: 注册后系统不再直接杀 App, 由这里接管导航 */
function bindNativeBack() {
  if (!CAP?.isNativePlatform?.()) return
  try {
    CAP.Plugins?.App?.addListener?.('backButton', () => {
      const openModal = [...document.querySelectorAll('.modal')].find(m => !m.classList.contains('hidden'))
      if (openModal) { openModal.classList.add('hidden'); return }   // 先关弹窗
      if (document.body.classList.contains('in-session')) { closeSession(); return } // 会话页 → 回主页
      try { CAP.Plugins?.App?.exitApp?.() } catch {}                  // 主页再返回 → 退出(与系统一致)
    })
  } catch {}
}

function renderSessionTitle() {
  const s = state.byId.get(state.current)
  $('session-title').textContent = s ? titleOf(s) : '未知会话'
}

function renderSessionSub() {
  const s = state.byId.get(state.current)
  if (!s) { $('session-sub').textContent = ''; return }
  const parts = [short(s.sessionId)]
  if (s.cwd) parts.push(s.cwd)
  if (s.running) parts.push('运行中')
  $('session-sub').textContent = parts.join(' · ')
}

function updateCancelBtn() {
  const s = state.byId.get(state.current)
  const running = s?.running || (state.queues[state.current] || []).some(i => i.placement !== 'context')
  $('btn-cancel').classList.toggle('hidden', !running)
}

const HISTORY_MAX_VISIBLE = 5000  // 已加载的可显示事件上限(消息/工具/状态, 不含 chunk)

function emptyHistory() {
  return {
    visible: [], seqs: new Set(), minSeq: Infinity,
    hasMore: false, loading: false, renderStart: 0, renderEnd: 0
  }
}

function trimVisible() {
  const h = state.history
  if (h.visible.length <= HISTORY_MAX_VISIBLE) return
  const drop = h.visible.splice(0, h.visible.length - HISTORY_MAX_VISIBLE)
  for (const e of drop) h.seqs.delete(e.seq)
  h.renderStart = Math.max(0, h.renderStart - drop.length)
  h.renderEnd = Math.max(h.renderStart, h.renderEnd - drop.length)
}

async function loadHistory(reset) {
  const id = state.current
  if (!id || state.history.loading) return
  state.history.loading = true
  const moreBtn = $('history-more')
  if (moreBtn) moreBtn.classList.add('hidden')
  const payload = { sessionId: id, maxMessages: 60 }
  if (!reset && state.history.minSeq !== Infinity) payload.beforeSeq = state.history.minSeq
  const v = await safeRpc('session.history', payload, '加载历史失败')
  if (!v) { state.history.loading = false; return }
  const incoming = v.events || []
  let added = 0
  for (const entry of incoming) {
    const ev = entry?.event
    const seq = ev?.seq
    if (seq == null || state.history.seqs.has(seq)) continue
    if (!shouldShowEvent(ev.type)) continue          // chunk 等内部事件不保留
    state.history.seqs.add(seq)
    state.history.visible.push({ seq, event: ev, view: entry.view })
    added++
  }
  // 向前翻页游标 = 本页最旧的 raw seq(即使它本身被过滤)
  const firstSeq = incoming[0]?.event?.seq
  if (firstSeq != null) state.history.minSeq = Math.min(state.history.minSeq, firstSeq)
  state.history.visible.sort((a, b) => a.seq - b.seq)
  trimVisible()
  state.history.hasMore = !!v.hasMore
  state.history.loading = false
  if (reset) renderHistory(true)
  else if (added) renderHistory(false, 'keep')
  if (moreBtn) moreBtn.classList.toggle('hidden', !state.history.hasMore)
  $('history-hint').textContent = state.history.visible.length ? `${state.history.visible.length} 条` : ''
}

function insertLiveEvent(event) {
  const h = state.history
  const seq = event?.seq
  if (seq == null || h.seqs.has(seq) || !shouldShowEvent(event.type)) return
  h.seqs.add(seq)
  h.visible.push({ seq, event })
  h.visible.sort((a, b) => a.seq - b.seq)
  trimVisible()
  const box = $('history')
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 240
  if (nearBottom) {
    h.renderEnd = h.visible.length
    h.renderStart = Math.max(0, h.renderEnd - 200)
    renderHistory(false, 'bottom')
  } else {
    renderHistory(false, 'keep')
  }
}

function isToolEvent(type) { return type === 'tool/call' || type === 'tool/result' }

function filteredEntries() {
  const showTools = LS.get('showTools', '1') !== '0'
  const f = state.history.visible.filter(e => showTools || !isToolEvent(e.event?.type))
  state.history.filtered = f
  return f
}

function renderHistory(reset, mode = 'bottom') {
  const box = $('history')
  const h = state.history
  const filtered = filteredEntries()
  const len = filtered.length
  if (!len) {
    box.innerHTML = '<div class="empty">还没有消息</div>'
    h.renderStart = 0; h.renderEnd = 0
    updateRail()
    return
  }
  if (reset) {
    h.renderEnd = len
    h.renderStart = Math.max(0, len - 200)
  }
  const start = Math.min(h.renderStart, len)
  const end = Math.min(h.renderEnd, len) || len
  const oldH = box.scrollHeight
  const oldTop = box.scrollTop
  // callId → 工具名, 供 tool/result 折叠标题显示
  const toolNames = new Map()
  for (const e of state.history.visible) {
    if (e.event?.type !== 'tool/call') continue
    const d = e.event.data || {}
    if (d.callId && d.name) toolNames.set(d.callId, d.name)
  }
  box.innerHTML = filtered.slice(start, end).map(e => eventHtml(e, { toolNames })).join('')
  if (reset || mode === 'bottom') box.scrollTop = box.scrollHeight
  else if (mode === 'keep') box.scrollTop = Math.max(0, oldTop + (box.scrollHeight - oldH))
  updateRail()
}

/* 右侧导航条: 用户发言节点 + 拖动快速定位 */
function updateRail() {
  const box = $('history')
  const thumb = $('rail-thumb')
  const nodesBox = $('rail-nodes')
  if (!box || !thumb || !nodesBox) return
  const sh = box.scrollHeight
  const ch = box.clientHeight
  if (sh <= ch) {
    thumb.style.display = 'none'
    nodesBox.innerHTML = ''
    return
  }
  thumb.style.display = ''
  const trackH = Math.max(1, ch - 8)
  const thumbH = Math.max(32, ch / sh * trackH)
  const maxTop = trackH - thumbH
  const ratio = box.scrollTop / Math.max(1, sh - ch)
  thumb.style.height = thumbH + 'px'
  thumb.style.top = (4 + ratio * maxTop) + 'px'

  const boxTop = box.getBoundingClientRect().top
  const userNodes = [...box.querySelectorAll('.msg.user')]
  nodesBox.innerHTML = userNodes.map(el => {
    const off = el.getBoundingClientRect().top - boxTop + box.scrollTop
    const pos = Math.min(4 + trackH, 4 + off / Math.max(1, sh) * trackH)
    return `<div class="rail-node" data-offset="${Math.round(off)}" style="top:${pos}px"></div>`
  }).join('')
  let activeIdx = -1
  userNodes.forEach((el, i) => {
    const off = el.getBoundingClientRect().top - boxTop + box.scrollTop
    if (off <= box.scrollTop + 60) activeIdx = i
  })
  if (activeIdx >= 0) nodesBox.children[activeIdx]?.classList.add('active')
}

function bindRail() {
  const box = $('history')
  const thumb = $('rail-thumb')
  const nodesBox = $('rail-nodes')
  if (!box || !thumb || !nodesBox) return
  nodesBox.addEventListener('click', (e) => {
    const node = e.target.closest('.rail-node')
    if (!node) return
    box.scrollTo({ top: Math.max(0, Number(node.dataset.offset) - 10), behavior: 'smooth' })
  })
  let drag = null
  thumb.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, top: box.scrollTop }
    try { thumb.setPointerCapture(e.pointerId) } catch {}
  })
  thumb.addEventListener('pointermove', (e) => {
    if (!drag) return
    const trackH = Math.max(1, box.clientHeight - 8)
    const delta = (e.clientY - drag.y) / trackH * Math.max(1, box.scrollHeight - box.clientHeight)
    box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, drag.top + delta))
    updateRail()
  })
  thumb.addEventListener('pointerup', () => { drag = null })
  thumb.addEventListener('pointercancel', () => { drag = null })
}

/* 事件 → HTML */
const INTERESTING_EVENTS = new Set([
  'user/message', 'assistant/message',
  'tool/call', 'tool/result',
  'agent/status',
  'checkpoint/created', 'compaction/complete', 'compaction/summary',
  'goal/created', 'goal/updated', 'goal/completed', 'goal/cleared',
  'todo/updated', 'plan/updated',
  'question/asked', 'question/resolved',
  'approval/asked', 'approval/resolved',
  'session/title', 'title'
])
function shouldShowEvent(type) {
  if (INTERESTING_EVENTS.has(type)) return true
  return false
}
function eventHtml(entry, ctx = {}) {
  const seq = entry.seq
  const ev = entry.event || {}
  const data = ev.data || {}
  const type = ev.type || 'event'
  if (!shouldShowEvent(type)) return ''
  let inner = ''

  if (type === 'user/message' || type === 'assistant/message') {
    const msg = data.message || {}
    const role = data.role || msg.role || (type.startsWith('user') ? 'user' : 'assistant')
    const blocks = msg.content || data.content || []
    inner = `<div class="msg ${esc(role)}" data-seq="${seq}"><div class="role">${esc(role === 'user' ? '我' : 'DSH')}</div>${blocks.map(blockHtml).join('')}</div>`
  } else if (type === 'tool/call') {
    const name = data.name || data.toolName || '工具'
    const step = (data.turn != null ? ` · turn ${data.turn}` : '') + (data.step != null ? `.${data.step}` : '')
    inner = `<details class="tool" data-seq="${seq}"><summary>🔧 ${esc(name)}<span class="tool-meta-inline">${esc(step)}</span></summary><pre>${esc(safeJson(data.arguments ?? data.args ?? data.input ?? data))}</pre></details>`
  } else if (type === 'tool/result') {
    const callId = data.callId || data.message?.source?.callId
    const name = (callId && ctx.toolNames?.get(callId)) || '结果'
    const err = data.error || data.ok === false
    inner = `<details class="tool result ${err ? 'error' : ''}" data-seq="${seq}"><summary>📦 ${esc(name)}<span class="tool-meta-inline">结果</span></summary><pre>${esc(truncate(safeJson(data.result ?? data.output ?? data.message ?? data), 4000))}</pre></details>`
  } else if (type === 'agent/status') {
    const running = !!data.running
    inner = `<div class="event" data-seq="${seq}">${running ? '▶ 任务开始' : '■ 任务结束'}</div>`
  } else if (type === 'llm/usage') {
    inner = `<div class="event" data-seq="${seq}">tokens ${fmtTokens(data.inputTokens)} → ${fmtTokens(data.outputTokens)}</div>`
  } else if (type === 'checkpoint/created' || type === 'compaction/complete' || type === 'compaction/summary') {
    inner = `<div class="event" data-seq="${seq}">⟳ ${esc(type)}</div>`
  } else {
    inner = `<div class="event" data-seq="${seq}">${esc(type)}</div>`
  }
  return inner
}

function blockHtml(b) {
  if (!b || typeof b !== 'object') return `<p>${esc(String(b))}</p>`
  if ((b.type === 'tool-call' || b.type === 'tool-result') && LS.get('showTools', '1') === '0') return ''
  switch (b.type) {
    case 'text': return `<div>${renderMarkdown(b.text ?? '')}</div>`
    case 'image': return `<img alt="图片" src="data:${esc(b.mediaType || 'image/png')};base64,${esc(b.data || '')}">`
    case 'thinking':
    case 'reasoning':
      return `<details class="tool"><summary>🧠 思考过程</summary><div class="tool-text">${esc(truncate(String(b.text ?? b.content ?? safeJson(b)), 6000))}</div></details>`
    case 'code': return `<pre>${esc(b.content ?? b.code ?? '')}</pre>`
    case 'tool-call':
      return `<details class="tool"><summary>🔧 ${esc(b.name || b.toolName || '工具调用')}</summary><pre>${esc(truncate(safeJson(b.arguments ?? b), 4000))}</pre></details>`
    case 'tool-result':
      return `<details class="tool result"><summary>📦 ${esc(b.name || b.toolName || '工具结果')}</summary><pre>${esc(truncate(safeJson(b.content ?? b), 4000))}</pre></details>`
    default: return `<details class="tool"><summary>块 · ${esc(b.type || '?')}</summary><pre>${esc(truncate(safeJson(b), 2000))}</pre></details>`
  }
}

function renderMarkdown(text) {
  const parts = String(text ?? '').split(/```/)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out += `<pre>${esc(parts[i])}</pre>`
    else out += esc(parts[i])
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(?:^|\n)(#{1,4})\s+([^\n]+)/g, (m, h, t) => `\n<b>${t}</b>`)
      .replace(/\n/g, '<br>')
  }
  return out
}

function safeJson(v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) }
  catch { return String(v) }
}
function truncate(s, n) { return String(s).length > n ? String(s).slice(0, n) + '…(截断)' : s }

/* 会话卡片(goal/todo/subagents); 统计进顶栏 📊 弹窗 */
function statsHtml(s) {
  const stats = proj(s, 'sessionStats')
  const usage = proj(s, 'tokenUsage')
  const ctx = proj(s, 'contextPressure')
  const perms = proj(s, 'permissions')
  let html = ''
  if (stats) {
    const llmMin = stats.llmMs ? (stats.llmMs / 60000).toFixed(1) : null
    html += `<div class="card"><div class="card-title">本轮统计</div>
      <div class="card-row"><span class="k">轮次 / 步骤</span><span class="v">${stats.turns ?? '—'} / ${stats.steps ?? '—'}</span></div>
      <div class="card-row"><span class="k">模型耗时</span><span class="v">${llmMin ? llmMin + ' 分钟' : '—'}</span></div>
      ${usage ? `<div class="card-row"><span class="k">输出 / 缓存读</span><span class="v">${fmtTokens(usage.outputTokens)} / ${fmtTokens(usage.cacheReadTokens)}</span></div>` : ''}
      ${ctx ? `<div class="card-row"><span class="k">上下文压力</span><span class="v">${fmtTokens(ctx.pressureTokens)} / ${fmtTokens(ctx.contextWindow)}</span></div>` : ''}
      ${perms?.currentValue ? `<div class="card-row"><span class="k">权限</span><span class="v">${esc(perms.currentValue)}</span></div>` : ''}
    </div>`
  }
  return html || '<div class="empty">暂无统计数据</div>'
}

async function renderSessionCards() {
  const s = state.byId.get(state.current)
  const box = $('session-cards')
  const statsBox = $('stats-body')
  if (!s) { box.innerHTML = ''; if (statsBox) statsBox.innerHTML = ''; return }
  if (statsBox) statsBox.innerHTML = statsHtml(s)
  const goal = goalOf(s)
  const todos = proj(s, 'todos')
  let html = ''

  if (goal) {
    html += `<div class="card"><div class="card-title">目标</div>
      <div class="goal-obj">${esc(goal.objective || '')}</div>
      <div class="goal-phase">phase: ${esc(goal.phase || '?')} · revision ${goal.revision ?? '?'}</div>
      <div class="goal-actions">
        ${goal.phase === 'active' ? '<button class="mini-btn" data-goal="pause">暂停</button>' : '<button class="mini-btn" data-goal="resume">继续</button>'}
        <button class="mini-btn" data-goal="complete">完成</button>
        <button class="mini-btn" data-goal="edit">改目标</button>
        <button class="mini-btn" data-goal="clear">清除</button>
      </div></div>`
  }
  if (todos?.items?.length) {
    html += `<div class="card"><div class="card-title">任务清单</div>${todos.items.map(t =>
      `<div><span class="pill ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : ''}">${esc(t.status || 'pending')}</span>${esc(t.content || '')}</div>`
    ).join('')}</div>`
  }
  box.innerHTML = html
  box.querySelectorAll('[data-goal]').forEach(btn =>
    btn.addEventListener('click', () => goalAction(btn.dataset.goal)))

  // 子代理
  const sub = await safeRpc('subagent.list', { parentSessionId: state.current })
  if (sub?.entries?.length) {
    const rows = sub.entries.map(e => {
      if (e.kind === 'diagnostic') return `<div class="card-row"><span class="k">诊断项</span><span class="v">${esc(e.reason)}</span></div>`
      const label = e.label || short(e.id)
      const running = e.activity === 'running'
      return `<div class="card-row"><span class="k">${running ? '▶ ' : ''}${esc(label)}</span><span class="v">${esc(e.mode)} ${running ? '· 运行中' : ''}${e.mode === 'continuable' && running ? ` <button class="mini-btn" data-sub-interrupt="${esc(e.id)}">中断</button>` : ''}</span></div>`
    }).join('')
    box.insertAdjacentHTML('beforeend', `<div class="card"><div class="card-title">子代理</div>${rows}</div>`)
    box.querySelectorAll('[data-sub-interrupt]').forEach(btn =>
      btn.addEventListener('click', () => interruptSubagent(btn.dataset.subInterrupt)))
  }
}

async function goalAction(kind) {
  const s = state.byId.get(state.current)
  const goal = goalOf(s)
  if (!goal) return toast('当前会话没有目标')
  const ref = { id: goal.id, revision: goal.revision }
  if (kind === 'edit') return openGoalModal(goal)
  const map = { pause: 'goal.pause', resume: 'goal.resume', complete: 'goal.complete', clear: 'goal.clear' }
  const method = map[kind]
  if (!method) return
  if (kind === 'clear' && !confirm('清除当前目标？(不会删除会话)')) return
  if (kind === 'complete' && !confirm('将目标标记为完成？')) return
  await safeRpc(method, { sessionId: state.current, ref }, '目标操作失败')
  toast('目标操作已提交', 'ok')
  scheduleRefresh()
}

async function interruptSubagent(childId) {
  if (!confirm('中断这个子代理当前回合？')) return
  await safeRpc('subagent.interrupt', { parentSessionId: state.current, childSessionId: childId, mode: 'continuable' }, '中断失败')
  toast('中断请求已提交', 'ok')
  setTimeout(renderSessionCards, 600)
}

/* ---------------- 发送 / 取消 ---------------- */
async function sendMessage() {
  const input = $('composer-input')
  const text = input.value.trim()
  if (!text || !state.current) return
  $('btn-send').disabled = true
  const v = await safeRpc('session.prompt', {
    sessionId: state.current,
    mode: 'queue',
    content: [{ type: 'text', text }]
  }, '发送失败')
  $('btn-send').disabled = false
  if (v?.accepted) { input.value = ''; autosize(input); toast('已发送', 'ok') }
  else if (v?.command?.text) toast('命令已执行')
}

async function cancelSession() {
  if (!state.current) return
  if (!confirm('停止当前会话正在运行的任务？')) return
  const v = await safeRpc('session.cancel', { sessionId: state.current }, '停止失败')
  if (v?.accepted) toast('已请求停止', 'ok')
}

async function newSession() {
  const v = await safeRpc('session.create', {}, '新建会话失败')
  if (!v?.sessionId) return
  toast('会话已创建', 'ok')
  await refreshSessions()
  openSession(v.sessionId)
}

/* ---------------- 待办 ---------------- */
function renderPending() {
  const list = $('pending-list')
  const items = [
    ...state.approvals.map(a => ({ kind: 'approval', a })),
    ...state.questions.map(q => ({ kind: 'question', q }))
  ]
  $('pending-count').textContent = items.length ? `${items.length} 项` : ''
  list.innerHTML = items.length ? items.map(it => {
    if (it.kind === 'approval') {
      const a = it.a
      const title = titleOf(state.byId.get(a.sessionId))
      return `<div class="pending-card approval" data-approval="${esc(a.approvalId)}">
        <div class="pc-title">🔧 ${esc(a.toolName || '工具')} 请求批准</div>
        <div class="pc-desc">${esc(a.reason || '无说明')}</div>
        <div class="pc-session">${esc(title)}</div>
        <div class="goal-actions"><button class="mini-btn" data-approve="1">允许</button><button class="mini-btn" data-approve="0">拒绝</button></div>
      </div>`
    }
    const q = it.q
    const title = titleOf(state.byId.get(q.sessionId))
    return `<div class="pending-card question" data-question="${esc(q.rpcId)}">
      <div class="pc-title">❓ ${esc(q.questions?.[0]?.question || 'DSH 提问')}</div>
      <div class="pc-desc">${q.questions?.length > 1 ? `共 ${q.questions.length} 个问题` : ''}</div>
      <div class="pc-session">${esc(title)}</div>
      <div class="goal-actions"><button class="mini-btn" data-answer="1">去回答</button></div>
    </div>`
  }).join('') : '<div class="empty">暂无待处理事项</div>'
  list.querySelectorAll('[data-approve]').forEach(btn => {
    const card = btn.closest('[data-approval]')
    btn.addEventListener('click', () => approveApproval(card?.dataset.approval || '', btn.dataset.approve === '1'))
  })
  list.querySelectorAll('[data-question]').forEach(btn =>
    btn.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === btn.dataset.question))))
  updatePendingBadge()
}

async function approveApproval(id, allow) {
  const a = state.approvals.find(x => x.approvalId === id)
  if (!a) return
  const ok = await respond(a.rpcId, { sessionId: a.sessionId, approvalId: a.approvalId, outcome: allow ? 'allowed-once' : 'rejected' })
  toast(ok ? (allow ? '已允许' : '已拒绝') : '审批已不在待处理状态', ok ? 'ok' : 'err')
  state.approvals = state.approvals.filter(x => x.approvalId !== id)
  renderPending()
}

function openQuestionModal(q) {
  if (!q) return
  state.questionModal = q
  $('question-body').innerHTML = q.questions.map((item, i) => `
    <div class="q-item">
      <div class="q-text">${esc(item.header ? item.header + '：' : '')}${esc(item.question)}</div>
      ${(item.options || []).map((o, j) => `
        <label class="q-option"><input type="${item.multiSelect ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o.label)}" data-q="${i}"><span>${esc(o.label)}${o.description ? `<div class="muted">${esc(o.description)}</div>` : ''}</span></label>`).join('')}
      <textarea rows="2" placeholder="其他 / 自定义回答(可选)" data-qcustom="${i}"></textarea>
    </div>`).join('')
  $('modal-question').classList.remove('hidden')
}

async function submitQuestion() {
  const q = state.questionModal
  if (!q) return
  const answers = q.questions.map((item, i) => {
    const sel = [...$('question-body').querySelectorAll(`input[data-q="${i}"]:checked`)].map(x => x.value)
    const custom = $('question-body').querySelector(`[data-qcustom="${i}"]`)?.value?.trim()
    const ans = { id: item.id, selected: sel }
    if (custom) ans.custom = custom
    if (!sel.length && !custom) return null
    return ans
  }).filter(Boolean)
  if (!answers.length) return toast('请先选择或填写回答', 'err')
  const ok = await respond(q.rpcId, { sessionId: q.sessionId, answer: { answers } })
  if (ok) { toast('已提交回答', 'ok'); $('modal-question').classList.add('hidden'); state.questions = state.questions.filter(x => x.rpcId !== q.rpcId); renderPending() }
  else toast('提问已不在待处理状态', 'err')
}

/* ---------------- 后台任务 ---------------- */
function renderQueue() {
  const s = state.byId.get(state.current)
  if (!s) return
  const items = state.queues[state.current] || []
  updateCancelBtn()
  // 队列数量在会话列表已显示; 详情页不重复大 UI
  $('history-hint').textContent = items.length ? `队列 ${items.length} · 历史 ${state.history.visible.length}` : `历史 ${state.history.visible.length}`
  renderSessions()
}

function renderJobs() {
  const box = $('jobs-list')
  const all = Object.entries(state.jobs).filter(([, jobs]) => jobs?.length)
  if (!all.length) { box.innerHTML = '<div class="empty">暂无后台任务</div>'; return }
  box.innerHTML = all.flatMap(([sid, jobs]) => jobs.map(j => {
    const title = titleOf(state.byId.get(sid))
    return `<div class="job-card">
      <div class="job-name">${esc(j.label || j.id)} <span class="pill ${j.status === 'running' ? 'active' : 'done'}">${esc(j.status)}</span></div>
      <div class="job-state">${esc(j.kind)} · ${esc(title)} · ${j.startedAt ? fmtTime(j.startedAt) : ''}${j.detail ? ' · ' + esc(j.detail) : ''}</div>
    </div>`
  }).join(''))
}

/* ---------------- goal 编辑 ---------------- */
function openGoalModal(goal) {
  state.goalEdit = goal
  $('goal-body').innerHTML = `
    <div class="kv"><span class="k">phase</span><span class="v">${esc(goal.phase || '?')}</span></div>
    <div class="kv"><span class="k">revision</span><span class="v">${goal.revision ?? '?'}</span></div>
    <textarea id="goal-edit-text" rows="4" style="width:100%;margin-top:10px">${esc(goal.objective || '')}</textarea>`
  $('goal-edit').classList.remove('hidden')
  $('modal-goal').classList.remove('hidden')
}

async function submitGoalEdit() {
  const goal = state.goalEdit
  if (!goal) return
  const objective = $('goal-edit-text')?.value?.trim()
  if (!objective) return toast('目标不能为空', 'err')
  await safeRpc('goal.edit', { sessionId: state.current, ref: { id: goal.id, revision: goal.revision }, objective }, '更新失败')
  $('modal-goal').classList.add('hidden')
  toast('目标已更新', 'ok')
  scheduleRefresh()
}

/* ---------------- 检查更新 ---------------- */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(Number)
  const pb = String(b || '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

async function loadLocalVersion() {
  try {
    const res = await fetch('version.json?t=' + Date.now())
    if (res.ok) state.localVersion = (await res.json())?.version || ''
  } catch {}
  $('update-desc').textContent = state.localVersion ? `当前版本 v${state.localVersion}` : '未获取到版本'
}

async function checkUpdate(silent) {
  const base = state.server
  if (!base) {
    if (!silent) toast('请先设置服务器地址', 'err')
    $('update-desc').textContent = state.localVersion ? `当前版本 v${state.localVersion} · 未设置服务器` : '请先设置服务器地址'
    return
  }
  if (!silent) toast('正在检查更新…')
  try {
    const res = await fetch(base + '/update.json?t=' + Date.now())
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const info = await res.json()
    if (info.version && cmpVersion(info.version, state.localVersion) > 0) {
      state.updateInfo = info
      $('update-desc').textContent = `发现新版本 v${info.version}${info.notes ? '：' + info.notes : ''}`
      $('btn-download-update').classList.remove('hidden')
      if (!silent) toast(`发现新版本 v${info.version}`, 'ok')
      else notify('发现新版本', 'v' + info.version + ' 可更新')
    } else {
      state.updateInfo = null
      $('update-desc').textContent = state.localVersion ? `已是最新 v${state.localVersion}` : `最新版本 v${info.version || '?'}`
      $('btn-download-update').classList.add('hidden')
      if (!silent) toast('已是最新版本', 'ok')
    }
  } catch (e) {
    $('update-desc').textContent = '检查失败：' + (e.message || '网络错误')
    if (!silent) toast('检查更新失败：' + e.message, 'err')
  }
}

function downloadUpdate() {
  const info = state.updateInfo
  if (!info) return
  const base = state.server || ''
  let url
  try { url = new URL(info.apkUrl || 'dsh-remote.apk', base + '/').href }
  catch { url = base + '/' + (info.apkUrl || 'dsh-remote.apk') }
  if (CAP?.isNativePlatform?.()) {
    // Android WebView 原生桥(不依赖 Capacitor 插件路由)
    if (window.NativeUpdate?.downloadAndInstall) {
      try {
        window.NativeUpdate.downloadAndInstall(url)
        toast('开始下载，完成后会弹出安装页', 'ok')
      } catch (e) {
        toast('无法启动下载：' + (e?.message || ''), 'err')
      }
      return
    }
    // 兜底: 旧版 App 没有原生桥时用浏览器下载
    toast('当前版本不支持 App 内安装，已转浏览器下载', 'err')
  }
  // 浏览器: 直接触发下载
  location.href = url
}

/* ---------------- 通知 ---------------- */
const CAP = window.Capacitor || null
async function ensureNotify() {
  // App 内走原生通知插件(WebView 的 Web Notification 在 MIUI 拿不到权限)
  if (CAP?.isNativePlatform?.()) {
    try {
      const L = CAP.Plugins?.LocalNotifications
      if (!L?.requestPermissions) return false
      const p = await L.requestPermissions()
      return p?.display === 'granted'
    } catch (e) {
      toast('通知权限申请失败：' + (e?.message || ''), 'err')
      return false
    }
  }
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return await Notification.requestPermission() === 'granted'
}
function notify(title, body) {
  if (LS.get('notify', '0') !== '1') return
  if (CAP?.isNativePlatform?.()) {
    try {
      CAP.Plugins.LocalNotifications.schedule({
        notifications: [{
          id: (Date.now() % 100000) + 1,
          title: 'DSH Remote · ' + title,
          body,
          schedule: { at: new Date(Date.now() + 800) }
        }]
      })
    } catch {}
    return
  }
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('DSH Remote · ' + title, { body })
    }
  } catch {}
}

/* ---------------- 视图切换 ---------------- */
function showView(id) {
  for (const v of ['view-home', 'view-session', 'view-activity', 'view-settings']) $(v).classList.toggle('hidden', v !== id)
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === id))
  window.scrollTo(0, 0)
}

function updateConn() {
  const ok = !!state.streamsOk?.mux
  const el = $('conn-badge')
  el.textContent = ok ? '已连接' : '未连接'
  el.className = 'conn-badge ' + (ok ? 'on' : 'off')
}

function autosize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

/* ---------------- 初始化 ---------------- */
function initToken() {
  const urlToken = new URLSearchParams(location.search).get('token')
  if (urlToken) {
    state.token = urlToken
    LS.set('token', urlToken)
    history.replaceState(null, '', location.pathname) // URL 里不留下 token
  } else {
    state.token = LS.get('token', '')
  }
  state.server = LS.get('server', '')
  $('token-desc').textContent = state.token ? '已保存(本机)' : '未设置'
  $('server-desc').textContent = state.server || '默认 = 当前页面地址'
}

function bindUi() {
  // 底部导航
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => showView(b.dataset.view)))
  // 会话列表点击
  $('session-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-id]')
    if (card) openSession(card.dataset.id)
  })
  $('btn-back').addEventListener('click', closeSession)
  $('btn-stats').addEventListener('click', () => { renderSessionCards(); $('modal-stats').classList.remove('hidden') })
  $('stats-close').addEventListener('click', () => $('modal-stats').classList.add('hidden'))
  $('btn-refresh').addEventListener('click', () => { toast('刷新中…'); refreshAll() })
  $('btn-admin').addEventListener('click', () => {
    location.href = state.server ? state.server.replace(/\/+$/, '') + '/admin' : 'admin'
  })
  $('btn-new-session').addEventListener('click', newSession)
  $('btn-cancel').addEventListener('click', cancelSession)
  $('btn-send').addEventListener('click', sendMessage)
  const input = $('composer-input')
  input.addEventListener('input', () => autosize(input))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage() }
  })

  // 审批
  $('approval-allow').addEventListener('click', () => {
    const a = state.approvalModal
    if (a) { approveApproval(a.approvalId, true); $('modal-approval').classList.add('hidden') }
  })
  $('approval-reject').addEventListener('click', () => {
    const a = state.approvalModal
    if (a) { approveApproval(a.approvalId, false); $('modal-approval').classList.add('hidden') }
  })
  // 提问
  $('question-submit').addEventListener('click', submitQuestion)
  $('question-later').addEventListener('click', () => $('modal-question').classList.add('hidden'))
  // goal
  $('goal-close').addEventListener('click', () => $('modal-goal').classList.add('hidden'))
  $('goal-edit').addEventListener('click', submitGoalEdit)
  // 设置
  $('btn-change-token').addEventListener('click', () => {
    const t = prompt('输入访问令牌(网关启动时打印的 token)：', state.token)
    if (t && t.trim()) { state.token = t.trim(); LS.set('token', t.trim()); $('token-desc').textContent = '已保存'; toast('已保存，正在重连', 'ok'); openStreams(); refreshAll() }
  })
  $('btn-change-server').addEventListener('click', () => {
    const s = prompt('输入网关地址(留空 = 当前页面地址)：\n例: http://192.168.1.100:8787', state.server)
    if (s === null) return
    const v = (s || '').trim().replace(/\/+$/, '')
    state.server = v
    v ? LS.set('server', v) : LS.del('server')
    $('server-desc').textContent = v || '默认 = 当前页面地址'
    toast('服务器已设置，正在重连', 'ok')
    openStreams(); refreshAll()
  })
  $('btn-host-describe').addEventListener('click', async () => {
    const v = await safeRpc('host.describe', {}, '探测失败')
    if (v) {
      state.hostInfo = v
      $('host-desc').textContent = `DSH ${v.version} · ${v.cwd} · 附加会话 ${v.attachedSessions}`
    }
  })
  $('btn-check-update').addEventListener('click', () => checkUpdate(false))
  $('btn-download-update').addEventListener('click', downloadUpdate)
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('清除本地令牌、服务器与缓存？')) return
    LS.del('token'); LS.del('notify'); LS.del('server')
    location.reload()
  })
  $('opt-notify').checked = LS.get('notify', '0') === '1'
  $('opt-notify').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const ok = await ensureNotify()
      if (!ok) { e.target.checked = false; return toast('通知权限未开启') }
    }
    LS.set('notify', e.target.checked ? '1' : '0')
  })
  $('opt-tools').checked = LS.get('showTools', '1') !== '0'
  $('opt-tools').addEventListener('change', (e) => {
    LS.set('showTools', e.target.checked ? '1' : '0')
    if (state.current) renderHistory(true)
    toast(e.target.checked ? '已显示工具调用' : '已隐藏工具调用', 'ok')
  })
  bindRail()

  // 向上翻历史 / 向下回最新
  $('history').addEventListener('scroll', () => {
    const box = $('history')
    const h = state.history
    updateRail()
    if (!state.current || !h.filtered?.length) return
    if (box.scrollTop < 80) {
      if (h.renderStart > 0) {
        h.renderStart = Math.max(0, h.renderStart - 100)
        renderHistory(false, 'keep')
      } else if (h.hasMore && !h.loading) {
        loadHistory(false)
      }
    } else if (box.scrollHeight - box.scrollTop - box.clientHeight < 240) {
      if (h.renderEnd < h.filtered.length) {
        h.renderEnd = h.filtered.length
        h.renderStart = Math.max(0, h.renderEnd - 200)
        renderHistory(false, 'bottom')
      }
    }
  })
}

/* App 内真实系统栏 inset(刘海/状态栏/手势条) */
function applyNativeInsets() {
  try {
    const raw = window.NativeUpdate?.getInsets?.()
    if (!raw) return
    const ins = JSON.parse(raw)
    document.documentElement.style.setProperty('--native-top', (ins.top || 0) + 'px')
    document.documentElement.style.setProperty('--native-bottom', (ins.bottom || 0) + 'px')
  } catch {}
}

async function boot() {
  initToken()
  bindUi()
  bindNativeBack()
  applyNativeInsets()
  updateConn()
  loadLocalVersion()
  if (!state.token) {
    showView('view-settings')
    $('token-desc').textContent = '未设置——点「更换」粘贴网关启动时打印的 token'
  } else {
    openStreams()
    await refreshAll()
    const host = await safeRpc('host.describe', {}, '')
    if (host) { state.hostInfo = host; $('host-desc').textContent = `DSH ${host.version} · ${host.cwd} · 附加会话 ${host.attachedSessions}` }
    // 启动后自动检查一次更新(静默)
    setTimeout(() => checkUpdate(true), 4000)
  }
  renderPending()
}

document.addEventListener('DOMContentLoaded', boot)
