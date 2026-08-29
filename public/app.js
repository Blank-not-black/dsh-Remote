/* DSH Remote 移动控制台 · 零依赖 */
'use strict'

const I18N = window.I18N
const t = (k, v) => I18N.t(k, v)
I18N.init(window.APP_STR)
// 投票是公开公告的低风险写入；网关不可达时允许 App 直连同一公网收集器托底。
// 普通反馈仍只走网关，避免绕过网关的鉴权与隐私处理。
const DIRECT_POLL_FEEDBACK_URL = 'https://vm-0-2-ubuntu.tail1f6fc4.ts.net/submit'

/* ---------------- 状态 ---------------- */
const LS = {
  get(k, d) { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  del(k) { try { localStorage.removeItem(k) } catch {} }
}
const CLIENT_ID = (() => {
  try {
    const key = 'dshRemoteClientIdV2'
    let id = localStorage.getItem(key)
    if (!id) {
      id = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
      localStorage.setItem(key, id)
    }
    return id
  } catch { return '' }
})()
function clientIdHeaders() { return CLIENT_ID ? { 'x-dsh-remote-client-id': CLIENT_ID } : {} }

/* 离线缓存: 会话列表 + 每会话聊天记录。只在网络失败时兜底展示, 不会替代线上数据。 */
const CACHE = {
  sessions: 'sessionsCacheV1',
  history: 'historyCacheV1'
}
function cacheRead(key, d = null) {
  try { return JSON.parse(LS.get(key, '')) || d } catch { return d }
}
function cacheWrite(key, value) {
  try { LS.set(key, JSON.stringify(value)) } catch { LS.del(key) }
}
function readHistoryCache() { return cacheRead(CACHE.history, {}) || {} }
function writeHistoryCache(cache) {
  try { LS.set(CACHE.history, JSON.stringify(cache)); return }
  catch {
    // localStorage 配额不足: 每会话只留最近 50 条再试一次
    try {
      for (const k of Object.keys(cache)) cache[k].events = (cache[k].events || []).slice(-50)
      LS.set(CACHE.history, JSON.stringify(cache))
    } catch { LS.del(CACHE.history) }
  }
}

const state = {
  token: '',
  wsTicket: { token: '', server: '', value: '', expiresAt: 0 },
  server: '',             // 当前生效的网关地址, 空 = 同源(浏览器模式)
  servers: [],            // 服务器列表: [{id,url,note,group,token}]；连接身份 = 地址 + 令牌
  groups: ['默认'],       // 组名列表(顺序保留)
  activeGroup: '默认',    // 当前连接组
  autoSelect: { '默认': true },   // 组内自动测速选优 / 手动指定
  groupActive: { '默认': '' },    // 每组当前生效的 server id(手动模式)
  serverLatency: {},      // 地址 + 令牌 -> 最近一次 /health 测速毫秒数
  gatewayHealth: {},      // url -> /health 协议版本与能力声明
  selectingServer: false, // 防重入: 测速/切换中
  sessions: [],
  sessionSort: LS.get('sessionSort', 'time') === 'workspace' ? 'workspace' : 'time',
  workspaceFilter: LS.get('workspaceFilterV1', ''),
  byId: new Map(),
  current: null,           // 当前打开的 sessionId
  sessionRecovery: { status: 'idle', error: '' },
  pendingProjections: new Map(),
  lastStreamResyncAt: 0,
  hostInfo: null,
  localVersion: '',
  updateInfo: null,
  warnedGatewayVersions: new Set(),
  announcement: null,
  announcements: [],
  approvals: [],           // 待处理审批
  questions: [],           // 待处理提问
  queues: {},              // sessionId -> queue items
  queueSteering: {},       // sessionId:itemId -> pending steer request
  sessionTurnTimes: {},    // sessionId -> 本轮开始/结束时间，避免中间事件推动排序
  jobs: {},                // sessionId -> jobs
  sessionActivity: new Set(), // 已发送消息或已执行命令的会话
  pendingPrompts: new Set(),  // 正在提交消息的会话
  history: emptyHistory(),
  errCount: 0,
  streamInfo: {
    mux: { status: 'idle', lastOpenAt: 0, lastCloseAt: 0, lastCloseCode: 0, lastCloseReason: '' },
    host: { status: 'idle', lastOpenAt: 0, lastCloseAt: 0, lastCloseCode: 0, lastCloseReason: '' },
  },
  streamMode: 'ws', // 'ws' | 'poll'
  pollSeq: { mux: 0, host: 0 },
  refreshTimer: null,
  fs: { path: null, initial: null, loaded: false, upload: null, workspaceId: LS.get('fsWorkspaceIdV1', ''), roots: [], rootIndex: 0, preview: null },
  composerImages: [], // 当前草稿中的图片附件：只在发送成功后释放
  models: { loaded: false, loading: false, groups: [], current: null, failures: [] },
  modelSettings: { status: 'idle', error: '', writable: false, hasDocument: false, providers: [], namespaces: [], credentials: {} },
  modelEditor: null,
  asrTest: { running: false, status: 'idle', meta: null, summary: null, events: [] },
  wb: null,
  wbProjects: [],
  wbArchived: [],
  wbOpen: false,
  wbOpenProjects: {},
  subagentExpandedSession: ''
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

/* ---------------- 应用内选择抽屉 ---------------- */
const CUSTOM_SELECT_TITLES = {
  'session-workspace-filter': 'workspace.select',
  'session-sort': 'sessions.sortLabel',
  'fs-workspace': 'workspace.select',
  'mobile-enter-action': 'settings.mobileEnterTitle',
  'bg-interval': 'settings.bgIntervalTitle',
  'new-session-workspace': 'workspace.select'
}
let customSelectCurrent = null

function syncCustomSelect(select) {
  const trigger = select?._customSelectTrigger
  if (!trigger) return
  const option = select.selectedOptions?.[0] || select.options?.[select.selectedIndex]
  const label = trigger.querySelector('.custom-select-trigger-label')
  if (label) label.textContent = option?.textContent?.trim() || t('select.choose')
  trigger.disabled = !!select.disabled
  trigger.setAttribute('aria-expanded', customSelectCurrent?.select === select ? 'true' : 'false')
}

function closeCustomSelect({ restoreFocus = true } = {}) {
  if (!$('custom-select-sheet')) return
  const previous = customSelectCurrent
  customSelectCurrent = null
  $('custom-select-backdrop').classList.add('hidden')
  $('custom-select-sheet').classList.add('hidden')
  if (previous?.select) syncCustomSelect(previous.select)
  if (restoreFocus) previous?.trigger?.focus?.({ preventScroll: true })
}

function customSelectOptionCopy(option) {
  const copy = document.createElement('span')
  copy.className = 'custom-select-option-copy'
  const raw = option.textContent?.trim() || ''
  const separator = raw.indexOf(' — ')
  const name = document.createElement('span')
  name.className = 'custom-select-option-name'
  name.textContent = separator >= 0 ? raw.slice(0, separator) : raw
  copy.appendChild(name)
  if (separator >= 0) {
    const path = document.createElement('span')
    path.className = 'custom-select-option-path'
    path.textContent = raw.slice(separator + 3)
    copy.appendChild(path)
  }
  return copy
}

function openCustomSelect(select) {
  const trigger = select?._customSelectTrigger
  if (!select || !trigger || select.disabled) return
  closeFeedbackSheet()
  syncCustomSelect(select)
  customSelectCurrent = { select, trigger }
  const titleKey = CUSTOM_SELECT_TITLES[select.id]
  $('custom-select-title').textContent = t(titleKey || 'select.choose')
  const options = $('custom-select-options')
  options.replaceChildren()
  let selectedButton = null
  Array.from(select.options).forEach(option => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'custom-select-option' + (option.selected ? ' current' : '')
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', option.selected ? 'true' : 'false')
    button.disabled = option.disabled
    button.appendChild(customSelectOptionCopy(option))
    const check = document.createElement('span')
    check.className = 'custom-select-option-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = option.selected ? '✓' : ''
    button.appendChild(check)
    button.addEventListener('click', () => {
      if (option.disabled) return
      select.value = option.value
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change', { bubbles: true }))
      syncCustomSelect(select)
      closeCustomSelect()
    })
    options.appendChild(button)
    if (option.selected) selectedButton = button
  })
  $('custom-select-backdrop').classList.remove('hidden')
  $('custom-select-sheet').classList.remove('hidden')
  syncCustomSelect(select)
  setTimeout(() => (selectedButton || options.querySelector('button:not(:disabled)'))?.focus(), 30)
}

function enhanceCustomSelect(select) {
  if (!select || select._customSelectTrigger || select.multiple || Number(select.size) > 1) return
  select.classList.add('custom-select-native')
  select.tabIndex = -1
  select.setAttribute('aria-hidden', 'true')
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.id = `${select.id}-trigger`
  trigger.className = 'custom-select-trigger'
  if (select.classList.contains('workspace-select')) trigger.classList.add('workspace-select-trigger')
  if (select.classList.contains('full')) trigger.classList.add('full')
  if (select.classList.contains('session-sort')) trigger.classList.add('session-sort-trigger')
  if (select.classList.contains('setting-select')) trigger.classList.add('setting-select-trigger')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  const label = document.createElement('span')
  label.className = 'custom-select-trigger-label'
  trigger.appendChild(label)
  trigger.addEventListener('click', () => openCustomSelect(select))
  select.insertAdjacentElement('afterend', trigger)
  select._customSelectTrigger = trigger
  const associatedLabel = document.querySelector(`label[for="${CSS.escape(select.id)}"]`)
  if (associatedLabel) associatedLabel.htmlFor = trigger.id
  select.addEventListener('change', () => syncCustomSelect(select))
  select._customSelectObserver = new MutationObserver(() => syncCustomSelect(select))
  select._customSelectObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] })
  syncCustomSelect(select)
}

function initCustomSelects() {
  document.querySelectorAll('select').forEach(enhanceCustomSelect)
  $('custom-select-backdrop').addEventListener('click', () => closeCustomSelect())
  $('custom-select-close').addEventListener('click', () => closeCustomSelect())
  $('custom-select-cancel').addEventListener('click', () => closeCustomSelect())
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && customSelectCurrent) closeCustomSelect()
  })
}

/* ---------------- 反馈 ---------------- */
const FEEDBACK_LINKS = {
  githubIssues: 'https://github.com/Blank-not-black/dsh-Remote/issues',
  giteeIssues: 'https://gitee.com/Blankneverfails/dsh-Remote/issues',
  bili: 'https://space.bilibili.com/419009275/dynamic',
  repo: 'https://github.com/Blank-not-black/dsh-Remote'
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.focus(); ta.select()
    const ok = document.execCommand('copy')
    ta.remove(); return ok
  } catch { return false }
}
function openFeedbackSheet() {
  $('feedback-backdrop').classList.remove('hidden')
  $('feedback-sheet').classList.remove('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'true')
  const first = $('feedback-sheet').querySelector('[role="menuitem"]')
  if (first) first.focus()
}
function closeFeedbackSheet() {
  $('feedback-backdrop').classList.add('hidden')
  $('feedback-sheet').classList.add('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'false')
}
function toggleFeedbackSheet() {
  $('feedback-sheet').classList.contains('hidden') ? openFeedbackSheet() : closeFeedbackSheet()
}
function openFeedbackModal() {
  state.feedbackType = 'bug'
  document.querySelectorAll('#fb-chips .fb-chip').forEach(b => b.classList.toggle('current', b.dataset.fbType === 'bug'))
  $('fb-msg').value = ''
  $('fb-contact').value = ''
  $('modal-feedback').classList.remove('hidden')
  setTimeout(() => $('fb-msg').focus(), 50)
}
function closeFeedbackModal() { $('modal-feedback').classList.add('hidden') }
function openFeedbackSuccess() {
  $('modal-feedback-success').classList.remove('hidden')
  setTimeout(() => $('feedback-success-confirm').focus(), 50)
}
function closeFeedbackSuccess() {
  $('modal-feedback-success').classList.add('hidden')
  $('btn-feedback')?.focus()
}
async function submitFeedback() {
  const type = state.feedbackType || 'bug'
  const message = $('fb-msg').value.trim()
  const contact = $('fb-contact').value.trim()
  if (!message) { toast(t('feedback.empty'), 'err'); return }
  if (message.length > 2000) { toast(t('feedback.tooLong'), 'err'); return }
  const btn = $('fb-submit')
  btn.disabled = true
  try {
    const base = updateBase()
    if (!base) throw new Error(t('feedback.networkError'))
    const res = await fetch(base + '/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ type, message, contact, appVersion: state.localVersion })
    })
    let json = {}
    try { json = await res.json() } catch {}
    if (res.ok && json.ok) { closeFeedbackModal(); openFeedbackSuccess() }
    else if (res.status === 429) { toast(json.retryAfter ? t('feedback.rateLimitedAt', { n: json.retryAfter }) : t('feedback.rateLimited'), 'err') }
    else { toast(t('feedback.submitFailed', { msg: json.error || res.status }), 'err') }
  } catch {
    toast(t('feedback.submitFailed', { msg: t('feedback.networkError') }), 'err')
  } finally {
    btn.disabled = false
  }
}

function fmtTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60e3) return t('time.justNow')
  if (diff < 3600e3) return Math.floor(diff / 60e3) + t('time.minAgo')
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + t('time.hourAgo')
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function fmtStatsDate(value, withYear = false) {
  const raw = String(value || '')
  const date = new Date(`${raw}T00:00:00`)
  if (!raw || Number.isNaN(date.getTime())) return raw
  try {
    const locale = I18N.lang === 'en' ? 'en-US' : 'zh-CN'
    return new Intl.DateTimeFormat(locale, withYear
      ? { year: 'numeric', month: 'short', day: 'numeric' }
      : { month: 'numeric', day: 'numeric' }).format(date)
  } catch { return raw.slice(5) }
}

function fmtSize(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const b = Number(n)
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB'
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB'
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB'
  return b + ' B'
}

function fmtFullTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ---------------- API ---------------- */
function apiUrl(path) {
  return (state.server || '') + path
}

let wsTicketPromise = null
async function getWsTicket() {
  const now = Date.now()
  if (state.wsTicket.token === state.token && state.wsTicket.server === state.server &&
      state.wsTicket.value && state.wsTicket.expiresAt > now + 15000) return state.wsTicket.value
  if (wsTicketPromise) return wsTicketPromise
  const token = state.token
  const server = state.server
  wsTicketPromise = (async () => {
    if (activeGatewayCapability('wsTicket') === false) throw new Error('ws ticket unsupported')
    const res = await fetch(apiUrl('/api/ws-ticket'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web',
        ...clientIdHeaders(),
      }
    })
    if (!res.ok) throw new Error('ws ticket HTTP ' + res.status)
    const data = await res.json()
    if (!data?.ticket || !Number(data.expiresAt)) throw new Error('invalid ws ticket')
    state.wsTicket = { token, server, value: data.ticket, expiresAt: Number(data.expiresAt) }
    return data.ticket
  })()
  try { return await wsTicketPromise } finally { wsTicketPromise = null }
}

function updateBase() {
  const configured = String(state.server || '').replace(/\/+$/, '')
  if (configured) return configured
  if (!/^https?:$/.test(location.protocol)) return ''
  const origin = location.origin.replace(/\/+$/, '')
  return location.pathname === '/remote' || location.pathname.startsWith('/remote/')
    ? origin + '/remote'
    : origin
}

function adminApiUrl(path) {
  const base = String(state.server || '').replace(/\/+$/, '')
  if (base) return base + path
  // DSH 抽屉页面同源运行在 /remote/ 前缀下，管理接口也必须带此前缀；
  // 独立网关根页面则继续使用 /admin/api/*。
  return location.pathname.startsWith('/remote/') ? '/remote' + path : path
}

function fmtCost(n) {
  return '¥' + (Number(n) || 0).toFixed(2)
}

function bucketTokens(b) {
  return (b.input || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.output || 0)
}

/* ---------------- Token 统计页 ---------------- */
let statsChartMode = LS.get('statsChartModeV1', 'token') === 'cost' ? 'cost' : 'token'

function applyStatsChartMode() {
  document.querySelectorAll('[data-stats-panel]').forEach(panel => {
    const active = panel.dataset.statsPanel === statsChartMode
    panel.classList.toggle('hidden', !active)
    panel.setAttribute('aria-hidden', active ? 'false' : 'true')
  })
  document.querySelectorAll('[data-stats-mode]').forEach(button => {
    const active = button.dataset.statsMode === statsChartMode
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  })
}

function setStatsChartMode(mode) {
  if (mode !== 'token' && mode !== 'cost') return
  statsChartMode = mode
  LS.set('statsChartModeV1', mode)
  applyStatsChartMode()
}

async function loadStats() {
  const cards = $('stats-cards')
  const chart = $('stats-chart')
  const tokenChart = $('stats-token-chart')
  const note = $('stats-note')
  if (!state.token) {
    cards.innerHTML = ''
    chart.innerHTML = `<div class="stats-empty">${t('statsPage.gatewayDown')}</div>`
    tokenChart.innerHTML = `<div class="stats-empty">${t('statsPage.gatewayDown')}</div>`
    note.textContent = ''
    $('stats-sub').textContent = ''
    $('stats-sub').textContent = ''
    $('stats-legend').innerHTML = ''
    $('stats-token-legend').innerHTML = ''
    return
  }
  try {
    const res = await fetch(apiUrl('/stats/summary?days=7'), {
      headers: { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }
    })
    if (res.status === 401) { authFailure(); return }
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    renderStats(json.days || [])
  } catch (e) {
    cards.innerHTML = ''
    chart.innerHTML = `<div class="stats-empty">${t('statsPage.gatewayDown')}</div>`
    tokenChart.innerHTML = `<div class="stats-empty">${t('statsPage.gatewayDown')}</div>`
    note.textContent = ''
    $('stats-sub').textContent = ''
    $('stats-sub').textContent = ''
    $('stats-legend').innerHTML = ''
    $('stats-token-legend').innerHTML = ''
  }
}

function renderStats(days) {
  const cards = $('stats-cards')
  const chart = $('stats-chart')
  const tokenChart = $('stats-token-chart')
  const note = $('stats-note')
  if (!days.length) {
    cards.innerHTML = ''
    chart.innerHTML = `<div class="stats-empty">${t('statsPage.empty')}</div>`
    tokenChart.innerHTML = `<div class="stats-empty">${t('statsPage.empty')}</div>`
    note.textContent = t('statsPage.note')
    $('stats-sub').textContent = ''
    $('stats-legend').innerHTML = ''
    $('stats-token-legend').innerHTML = ''
    return
  }
  const today = days[days.length - 1]
  const totalTokens = bucketTokens(today.total)
  const peakCost = today.peak.cost || 0
  const offCost = today.off.cost || 0
  const totalCost = peakCost + offCost
  const peakShare = totalCost > 0 ? Math.round(peakCost / totalCost * 100) : 0
  const todayLabel = fmtStatsDate(today.date)
  const todayFullLabel = fmtStatsDate(today.date, true)
  cards.innerHTML = `
    <article class="scard scard-primary">
      <div class="scard-head">
        <div class="scard-label"><span class="scard-icon token" aria-hidden="true">↗</span><span>${t('statsPage.todayTokens')}</span></div>
        <span class="scard-badge">${esc(t('statsPage.today'))} · ${esc(todayLabel)}</span>
      </div>
      <div class="scard-value">${fmtTokens(totalTokens)}<span class="scard-unit">${esc(t('statsPage.tokenUnit'))}</span></div>
      <div class="scard-helper">${esc(t('statsPage.breakdown'))}</div>
      <div class="bucket-grid">
        <div class="b"><span class="bucket-dot input" aria-hidden="true"></span><span class="n">${t('statsPage.input')}</span><strong class="t">${fmtTokens(today.total.input)}</strong></div>
        <div class="b"><span class="bucket-dot cache-read" aria-hidden="true"></span><span class="n">${t('statsPage.cacheRead')}</span><strong class="t">${fmtTokens(today.total.cacheRead)}</strong></div>
        <div class="b"><span class="bucket-dot cache-write" aria-hidden="true"></span><span class="n">${t('statsPage.cacheWrite')}</span><strong class="t">${fmtTokens(today.total.cacheWrite)}</strong></div>
        <div class="b"><span class="bucket-dot output" aria-hidden="true"></span><span class="n">${t('statsPage.output')}</span><strong class="t">${fmtTokens(today.total.output)}</strong></div>
      </div>
    </article>
    <article class="scard scard-cost">
      <div class="scard-head">
        <div class="scard-label"><span class="scard-icon cost" aria-hidden="true">¥</span><span>${t('statsPage.todayCost')}</span></div>
        <span class="scard-badge">${esc(t('statsPage.estimated'))}</span>
      </div>
      <div class="scard-value">${fmtCost(totalCost)}</div>
      <div class="stats-split">
        <div class="stats-split-item"><span><i class="split-dot peak" aria-hidden="true"></i>${t('statsPage.peak')}</span><strong>${fmtCost(peakCost)}</strong></div>
        <div class="stats-split-item"><span><i class="split-dot off" aria-hidden="true"></i>${t('statsPage.off')}</span><strong>${fmtCost(offCost)}</strong></div>
      </div>
    </article>
    <article class="scard scard-share">
      <div class="scard-head">
        <div class="scard-label"><span class="scard-icon share" aria-hidden="true">%</span><span>${t('statsPage.peakShare')}</span></div>
      </div>
      <div class="share-layout">
        <div class="share-ring" style="--share:${peakShare}%" role="img" aria-label="${esc(t('statsPage.peakShareLabel', { n: peakShare }))}"><span>${peakShare}%</span></div>
        <div class="share-copy"><strong>${t('statsPage.peak')}</strong><span>${t('statsPage.days', { n: days.length })}</span><small>${esc(todayFullLabel)}</small></div>
      </div>
    </article>`
  $('stats-sub').textContent = todayFullLabel
  note.textContent = t('statsPage.note')
  $('stats-legend').innerHTML = `<span class="lg"><span class="sw peak"></span>${t('statsPage.peak')}</span><span class="lg"><span class="sw off"></span>${t('statsPage.off')}</span>`
  $('stats-token-legend').innerHTML = `<span class="lg"><span class="sw token"></span>${t('statsPage.tokenTotal')}</span>`
  chart.setAttribute('aria-label', t('statsPage.costChartLabel'))
  tokenChart.setAttribute('aria-label', t('statsPage.tokenChartLabel'))
  const maxCost = Math.max(...days.map(d => (d.total.cost || 0)), 0.0001)
  chart.innerHTML = days.map(d => {
    const cost = d.total.cost || 0
    // 峰/谷按该日实际费用占比堆叠, 柱总高按当日费用相对窗口最大值; 不再加最小高度, 保证占比真实
    const peakH = cost > 0 ? Math.round((d.peak.cost || 0) / cost * 100) : 0
    const offH = cost > 0 ? Math.max(0, 100 - peakH) : 0
    const totalH = cost > 0 ? Math.max(3, Math.round(cost / maxCost * 100)) : 0
    const label = fmtStatsDate(d.date)
    const fullLabel = `${fmtStatsDate(d.date, true)} · ${t('statsPage.peak')} ${fmtCost(d.peak.cost)} · ${t('statsPage.off')} ${fmtCost(d.off.cost)} · ${t('statsPage.tokenTotal')} ${fmtTokens(bucketTokens(d.total))}`
    return `<div class="stats-bar" role="listitem" title="${esc(fullLabel)}" aria-label="${esc(fullLabel)}">
      <div class="bars" style="height:${totalH}%">
        <div class="seg peak" style="height:${peakH}%"></div>
        <div class="seg off" style="height:${offH}%"></div>
      </div>
      <div class="val">${cost > 0 ? fmtCost(cost) : ''}</div>
      <div class="lbl">${label}</div>
    </div>`
  }).join('')
  const maxTokens = Math.max(...days.map(d => bucketTokens(d.total)), 1)
  tokenChart.innerHTML = days.map(d => {
    const tokens = bucketTokens(d.total)
    const totalH = tokens > 0 ? Math.max(3, Math.round(tokens / maxTokens * 100)) : 0
    const label = fmtStatsDate(d.date)
    const tip = `${fmtStatsDate(d.date, true)} · ${t('statsPage.tokenTotal')} ${fmtTokens(tokens)} · ${t('statsPage.input')} ${fmtTokens(d.total.input)} · ${t('statsPage.output')} ${fmtTokens(d.total.output)}`
    return `<div class="stats-bar" role="listitem" title="${esc(tip)}" aria-label="${esc(tip)}">
      <div class="bars token" style="height:${totalH}%"></div>
      <div class="val">${tokens > 0 ? fmtTokens(tokens) : ''}</div>
      <div class="lbl">${label}</div>
    </div>`
  }).join('')
}
async function rpc(method, payload = {}, timeoutMs = 45000) {
  const opts = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload })
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(timeoutMs)
  }
  const res = await fetch(apiUrl('/api/' + method), opts)
  if (res.status === 401) throw new Error('AUTH')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const full = await res.json()
  if (!full?.result) throw new Error(t('err.badResponse'))
  if (!full.result.ok) {
    const err = full.result.error || {}
    throw new Error(err.message || t('err.dshError'))
  }
  return full.result.value
}

async function respond(rpcId, value) {
  const opts = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } })
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(15000)
  }
  const res = await fetch(apiUrl('/api/respond'), opts)
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

let hostDescribePromise = null
let hostDescribeRetryTimer = null
let hostDescribeFailures = 0

function scheduleHostDescribeRetry() {
  if (!state.token || hostDescribeRetryTimer) return
  const delays = [2000, 5000, 15000, 30000, 60000]
  const delay = delays[Math.min(Math.max(0, hostDescribeFailures - 1), delays.length - 1)]
  hostDescribeRetryTimer = setTimeout(() => {
    hostDescribeRetryTimer = null
    void refreshHostDescription()
  }, delay)
}

async function refreshHostDescription({ notify = false } = {}) {
  if (!state.token) return null
  if (hostDescribePromise) return hostDescribePromise
  const server = state.server
  hostDescribePromise = (async () => {
    try {
      const host = await rpc('host.describe', {}, 5000)
      if (server !== state.server) return null
      state.hostInfo = host
      const health = activeGatewayHealth()
      if (health) health.upstreamReachable = true
      hostDescribeFailures = 0
      if (hostDescribeRetryTimer) clearTimeout(hostDescribeRetryTimer)
      hostDescribeRetryTimer = null
      const desc = $('host-desc')
      if (desc && host) desc.textContent = t('settings.hostDesc', { version: host.version, cwd: host.cwd, n: host.attachedSessions })
      renderOverview()
      return host
    } catch (error) {
      if (server !== state.server) return null
      if (error.message === 'AUTH') authFailure()
      else {
        hostDescribeFailures++
        scheduleHostDescribeRetry()
        if (notify) toast(`${t('settings.probeFailed')}：${error.message}`, 'err')
      }
      return null
    } finally {
      hostDescribePromise = null
      if (server !== state.server) scheduleHostDescribeRetry()
    }
  })()
  return hostDescribePromise
}

function authFailure() {
  toast(t('err.accessDenied'), 'err')
  showView('view-settings')
  $('token-desc').textContent = t('token.invalid')
}

/* ---------------- 多服务器分组管理 + 自动选优 ---------------- */
function newServerId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function ensureGroup(name) {
  if (!name) name = '默认'
  if (!state.groups.includes(name)) state.groups.push(name)
  if (!(name in state.autoSelect)) state.autoSelect[name] = true
  if (!(name in state.groupActive)) state.groupActive[name] = ''
  return name
}

function groupServers(group) {
  return state.servers.filter(s => s.group === group)
}

function activeServers() {
  return groupServers(state.activeGroup)
}

function normalizedServerToken(token) { return typeof token === 'string' ? token.trim() : '' }
function serverIdentity(url, token) {
  return `${String(url || '').replace(/\/+$/, '')}\u0000${normalizedServerToken(token)}`
}
function serverKey(server) {
  return serverIdentity(server?.url ?? server, server?.token)
}
function serverToken(server) { return normalizedServerToken(server?.token) }
function currentServerEntry() {
  return state.servers.find(s => s.url === state.server && serverToken(s) === state.token)
    || state.servers.find(s => s.url === state.server)
    || null
}
function setCurrentAccessToken(value) {
  const token = normalizedServerToken(value)
  if (!token) return false
  const current = currentServerEntry()
  if (current) current.token = token
  state.token = token
  LS.set('token', token)
  saveServers()
  return true
}

/** 旧结构迁移: servers(string[]) + server/activeServer -> 新分组结构, 幂等(仅当 servers-v2 不存在时执行)。 */
function migrateServersV1() {
  if (LS.get('servers-v2', null) !== null) return
  let arr = null
  try { arr = JSON.parse(LS.get('servers', '')) } catch {}
  if (!Array.isArray(arr)) {
    const legacy = LS.get('server', '')
    arr = legacy ? [legacy] : []
  }
  const urls = arr.map(s => String(s || '').trim().replace(/\/+$/, ''))
    .filter(s => /^https?:\/\//i.test(s))
  state.servers = urls.map((url, i) => ({ id: 's' + (i + 1), url, note: '', group: '默认', token: normalizedServerToken(state.token) }))
  state.groups = ['默认']
  state.activeGroup = '默认'
  state.autoSelect = { '默认': true }
  state.groupActive = { '默认': '' }
  const active = LS.get('activeServer', '')
  if (active === 'origin') {
    state.server = ''
  } else {
    const hit = state.servers.find(s => s.url === active)
    state.server = hit ? hit.url : (state.servers[0]?.url || '')
    state.groupActive['默认'] = hit ? hit.id : (state.servers[0]?.id || '')
  }
  saveServers()
}

function loadServers() {
  let data = null
  try { data = JSON.parse(LS.get('servers-v2', '')) } catch {}
  if (!data || !Array.isArray(data.servers)) {
    migrateServersV1()
    return
  }
  const legacyToken = normalizedServerToken(state.token || LS.get('token', ''))
  state.servers = data.servers.filter(s => s && typeof s.url === 'string')
    .map(s => ({ id: s.id || newServerId(), url: s.url.replace(/\/+$/, ''), note: s.note || '', group: s.group || '默认', token: s.token == null ? legacyToken : normalizedServerToken(s.token) }))
  state.groups = Array.isArray(data.groups) && data.groups.length ? data.groups : ['默认']
  state.activeGroup = state.groups.includes(data.activeGroup) ? data.activeGroup : '默认'
  state.autoSelect = data.autoSelect || {}
  state.groupActive = data.groupActive || {}
  ensureGroup('默认')
  for (const s of state.servers) ensureGroup(s.group)
  if (!state.groups.includes(state.activeGroup)) state.activeGroup = '默认'
  // 恢复当前连接地址
  const manual = state.groupActive[state.activeGroup]
  const manualSrv = manual ? state.servers.find(s => s.id === manual) : null
  const selected = manualSrv || activeServers()[0]
  state.server = selected?.url || ''
  if (selected) {
    state.token = serverToken(selected)
    LS.set('token', state.token)
  }
}

function saveServers() {
  LS.set('servers-v2', JSON.stringify({
    servers: state.servers,
    groups: state.groups,
    activeGroup: state.activeGroup,
    autoSelect: state.autoSelect,
    groupActive: state.groupActive,
  }))
  // 旧 key 保留但不再写入(回滚兼容)
}

function serverCandidates() {
  const list = activeServers().map(s => ({ ...s, token: serverToken(s) }))
  // 浏览器控制台: 当前页面(同源网关)也作为候选, 通常 0 跳内最快
  if (!CAP?.isNativePlatform?.() && location.origin && !list.some(s => s.url === location.origin)) {
    list.push({ id: 'origin', url: location.origin, token: state.token, origin: true })
  }
  return list
}

async function pingServer(base) {
  const u = String(base || '').replace(/\/+$/, '')
  if (!u) return Infinity
  const t0 = performance.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3500)
  try {
    const res = await fetch(u + '/health?t=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return Infinity
    const health = await res.json().catch(() => null)
    if (health && typeof health === 'object') {
      state.gatewayHealth[u] = health
      renderOverview()
    }
    return Math.round(performance.now() - t0)
  } catch {
    return Infinity
  } finally {
    clearTimeout(timer)
  }
}

function activeGatewayCapability(name) {
  const capabilities = activeGatewayHealth()?.capabilities
  if (!capabilities || !Object.prototype.hasOwnProperty.call(capabilities, name)) return null
  return Number(capabilities[name]) > 0
}

function activeGatewayHealth() {
  const key = String(state.server || location.origin || '').replace(/\/+$/, '')
  return state.gatewayHealth[key] || null
}

function dshReachable() {
  const health = activeGatewayHealth()
  if (health && typeof health.upstreamReachable === 'boolean') return health.upstreamReachable
  return !!state.hostInfo
}

async function selectFastestServer({ silent = false, reconnect = true } = {}) {
  if (state.selectingServer) return null
  state.selectingServer = true
  try {
    if (!silent) toast(t('speed.testing'))
    const candidates = serverCandidates()
    let chosen = ''
    let chosenToken = state.token
    let best = null
    let ms = Infinity

    if (state.autoSelect[state.activeGroup] !== false) {
      const measured = await Promise.all(candidates.map(async (server) => [server, await pingServer(server.url)]))
      for (const [server, latency] of measured) state.serverLatency[serverKey(server)] = latency
      best = candidates
        .filter(server => Number.isFinite(state.serverLatency[serverKey(server)]))
        .sort((a, b) => state.serverLatency[serverKey(a)] - state.serverLatency[serverKey(b)])[0] || null
      const sameOrigin = !CAP?.isNativePlatform?.() && best?.url === location.origin
      chosen = best ? (sameOrigin && best.origin ? '' : best.url) : (state.server || '')
      chosenToken = best ? serverToken(best) : state.token
      ms = best ? state.serverLatency[serverKey(best)] : Infinity
    } else {
      const manual = state.groupActive[state.activeGroup]
      const manualSrv = manual ? state.servers.find(s => s.id === manual) : null
      chosen = manualSrv ? manualSrv.url : (activeServers()[0]?.url || '')
      chosenToken = manualSrv ? serverToken(manualSrv) : state.token
      if (chosen && !silent) {
        const key = serverKey(manualSrv || { url: chosen, token: state.token })
        state.serverLatency[key] = await pingServer(chosen)
        ms = state.serverLatency[key]
      }
    }

    renderServers()
    if (chosen !== state.server || chosenToken !== state.token) {
      state.hostInfo = null
      hostDescribeFailures = 0
      if (hostDescribeRetryTimer) clearTimeout(hostDescribeRetryTimer)
      hostDescribeRetryTimer = null
      resetFsForServer()
      state.server = chosen
      state.token = chosenToken
      LS.set('token', state.token)
      if (state.autoSelect[state.activeGroup] !== false && best) {
        const srv = state.servers.find(s => s.id === best.id)
        if (srv) state.groupActive[state.activeGroup] = srv.id
      }
      saveServers()
      syncBgConfig()
      renderServers()
      if (!silent) {
        if (chosen) toast(t('speed.switched', { url: chosen, ms: Number.isFinite(ms) ? ms : 0 }), 'ok')
        else toast(t('speed.switchedOrigin'), 'ok')
      }
      if (reconnect && state.token) { openStreams(); refreshAll() }
    } else if (!silent) {
      if (best) toast(t('speed.alreadyBest', { url: chosen || t('speed.origin'), ms: state.serverLatency[serverKey(best)] }), 'ok')
      else if (chosen) toast(t('speed.manualUsing', { url: chosen, ms: Number.isFinite(ms) ? ms : '—' }), 'ok')
      else toast(t('speed.allDown'), 'err')
    }
    await maybeWarnAppBehindGateway()
    return chosen
  } finally {
    state.selectingServer = false
  }
}

function serverTitle(s) {
  return s.note || s.url
}

function renderGroupSelect() {
  const label = $('group-select-label')
  const menu = $('group-select-menu')
  if (!label || !menu) return
  label.textContent = state.activeGroup
  menu.innerHTML = state.groups.map(g =>
    `<button type="button" class="group-option ${g === state.activeGroup ? 'current' : ''}" data-group-option="${esc(g)}">${esc(g)}${g === state.activeGroup ? ' ✓' : ''}</button>`).join('')
  menu.querySelectorAll('[data-group-option]').forEach(b =>
    b.addEventListener('click', () => {
      closeGroupMenu()
      if (b.dataset.groupOption !== state.activeGroup) switchGroup(b.dataset.groupOption)
    }))
}

function toggleGroupMenu() {
  const menu = $('group-select-menu')
  if (!menu) return
  menu.classList.toggle('hidden')
}

function closeGroupMenu() {
  const menu = $('group-select-menu')
  if (menu) menu.classList.add('hidden')
}

function renderServers() {
  const box = $('server-list')
  if (!box) return
  renderGroupSelect()
  const groupsHtml = state.groups.map(g => {
    const list = groupServers(g)
    const auto = state.autoSelect[g] !== false
    const activeManual = state.groupActive[g] || ''
    return `<div class="srv-group" data-group="${esc(g)}">
      <div class="srv-group-head">
        <button class="srv-group-name" data-group-name="${esc(g)}">${g === state.activeGroup ? '▾' : '▸'} ${esc(g)} <span class="srv-group-count">${list.length}</span></button>
        <button class="srv-group-speed mini-btn" data-speed-group="${esc(g)}" title="${t('groups.speedTest')}">⚡</button>
        <label class="switch small" title="${t('groups.autoSelect')}">
          <input type="checkbox" data-auto-group="${esc(g)}" ${auto ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
        ${g !== '默认' ? `<button class="srv-group-del" data-del-group="${esc(g)}" title="${t('groups.delete')}">✕</button>` : ''}
      </div>
      <div class="srv-group-body ${g === state.activeGroup ? '' : 'hidden'}">
        ${list.map(s => {
          const ms = state.serverLatency[serverKey(s)]
          let badge = `<span class="server-badge">${t('servers.untested')}</span>`
          const active = s.url === state.server && serverToken(s) === state.token
          if (Number.isFinite(ms)) badge = `<span class="server-badge ${active ? 'good' : ''}">${ms}ms${active ? t('servers.current') : ''}</span>`
          else if (ms !== undefined) badge = '<span class="server-badge bad">' + t('servers.unreachable') + '</span>'
          const activeInGroup = auto ? active : s.id === activeManual
          return `<div class="server-row ${activeInGroup ? 'active' : ''}" data-use-server="${esc(s.id)}">
            <span class="server-main"><span class="server-note">${esc(serverTitle(s))}</span>${s.note ? `<span class="server-url">${esc(s.url)}</span>` : ''}<span class="server-token-badge">${s.token ? t('servers.tokenSet') : t('servers.tokenMissing')}</span></span>${badge}
            <button class="server-edit" data-edit-server="${esc(s.id)}" title="${t('servers.edit')}">✎</button>
            <button class="server-del" data-del-server="${esc(s.id)}" aria-label="${t('servers.delete')}">✕</button>
          </div>`
        }).join('') || '<div class="server-empty">' + t('groups.noServer') + '</div>'}
      </div>
    </div>`
  }).join('')

  box.innerHTML = state.servers.length
    ? groupsHtml
    : '<div class="server-empty">' + t('servers.empty') + '</div>'

  box.querySelectorAll('[data-group-name]').forEach(b => {
    b.title = t('groups.switchHint')
    b.addEventListener('click', () => switchGroup(b.dataset.groupName))
    b.addEventListener('dblclick', () => renameGroup(b.dataset.groupName))
  })
  box.querySelectorAll('[data-speed-group]').forEach(b => b.addEventListener('click', () => { state.activeGroup = b.dataset.speedGroup; saveServers(); selectFastestServer({ silent: false }) }))
  box.querySelectorAll('[data-auto-group]').forEach(chk => chk.addEventListener('change', (e) => {
    const g = e.target.dataset.autoGroup
    state.autoSelect[g] = e.target.checked
    saveServers()
    if (g === state.activeGroup) selectFastestServer({ silent: false })
    toast(t(e.target.checked ? 'groups.autoOn' : 'groups.autoOff', { group: g }), 'ok')
  }))
  box.querySelectorAll('[data-del-group]').forEach(b => b.addEventListener('click', () => deleteGroup(b.dataset.delGroup)))
  box.querySelectorAll('[data-del-server]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); removeServer(b.dataset.delServer) }))
  box.querySelectorAll('[data-edit-server]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editServer(b.dataset.editServer) }))
  box.querySelectorAll('[data-use-server]').forEach(row => row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    const id = row.dataset.useServer
    const s = state.servers.find(x => x.id === id)
    if (!s) return
    const group = s.group
    if (state.autoSelect[group] !== false) {
      // 自动选择模式下点击条目 = 编辑
      editServer(id)
      return
    }
    // 手动模式: 点击条目 = 选中该服务器连接
    state.groupActive[group] = id
    state.activeGroup = group
    if (state.server !== s.url) resetFsForServer()
    state.server = s.url
    state.token = serverToken(s)
    LS.set('token', state.token)
    saveServers()
    syncBgConfig()
    renderServers()
    toast(t('servers.manualSelected', { url: serverTitle(s) }), 'ok')
    if (state.token) { openStreams(); refreshAll() }
  }))

  const cur = currentServerEntry()
  const curNote = cur ? (cur.note || cur.url) : ''
  const curGroup = cur ? cur.group : state.activeGroup
  const curMs = cur ? state.serverLatency[serverKey(cur)] : undefined
  $('server-desc').textContent = state.server
    ? t('servers.currentDescGroup', { group: curGroup, url: curNote, ms: Number.isFinite(curMs) ? curMs + 'ms' : '—' })
    : (CAP?.isNativePlatform?.() ? t('servers.notSet') : t('servers.defaultDesc'))
  updateConn()
}

async function addServer() {
  const input = $('server-input')
  let raw = (input?.value || '').trim().replace(/\/+$/, '')
  if (!raw) return toast(t('servers.needAddress'), 'err')
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad')
  } catch {
    return toast(t('servers.badProtocol'), 'err')
  }
  const token = normalizedServerToken(state.token)
  if (state.servers.some(s => serverIdentity(s.url, serverToken(s)) === serverIdentity(raw, token))) return toast(t('servers.duplicate'))
  let note = prompt(t('servers.promptNote'), '') || ''
  state.servers.push({ id: newServerId(), url: raw, note: note.trim(), group: state.activeGroup, token })
  saveServers()
  if (input) input.value = ''
  renderServers()
  toast(t('servers.added'), 'ok')
  if (state.token) selectFastestServer({ silent: false })
}

function editServer(id) {
  const s = state.servers.find(x => x.id === id)
  if (!s) return
  const raw = (prompt(t('servers.promptEditUrl'), s.url) || '').trim().replace(/\/+$/, '')
  if (!raw) return
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad')
  } catch {
    return toast(t('servers.badProtocol'), 'err')
  }
  const tokenInput = prompt(t('servers.promptEditToken'), '')
  if (tokenInput === null) return
  const token = normalizedServerToken(tokenInput) || serverToken(s)
  if (state.servers.some(x => x.id !== id && serverIdentity(x.url, serverToken(x)) === serverIdentity(raw, token))) return toast(t('servers.duplicate'))
  const note = prompt(t('servers.promptEditNote', { url: raw }), s.note || '')
  if (note === null) return
  const group = prompt(t('servers.promptEditGroup'), s.group || '默认')
  if (group === null) return
  const wasActive = state.server === s.url && state.token === serverToken(s)
  const changedActiveUrl = wasActive && state.server !== raw
  s.url = raw
  s.note = note.trim()
  s.group = ensureGroup(group.trim() || '默认')
  s.token = token
  if (wasActive) {
    if (changedActiveUrl) resetFsForServer()
    state.server = raw
    state.token = token
    LS.set('token', token)
  }
  saveServers()
  renderServers()
  toast(t('servers.edited'), 'ok')
  if (wasActive && state.token) selectFastestServer({ silent: true })
}

function removeServer(id) {
  const s = state.servers.find(x => x.id === id)
  if (!s) return
  state.servers = state.servers.filter(x => x.id !== id)
  const wasActive = state.server === s.url && state.token === serverToken(s)
  // 清理该组手动指定
  for (const g of state.groups) if (state.groupActive[g] === id) state.groupActive[g] = ''
  saveServers()
  renderServers()
  if (wasActive) {
    toast(t('servers.removedActive'))
    selectFastestServer({ silent: true })
  }
}

/* ---------------- 组管理 ---------------- */
function switchGroup(name) {
  if (!state.groups.includes(name)) return
  state.activeGroup = name
  saveServers()
  renderServers()
  toast(t('groups.switched', { group: name }), 'ok')
  selectFastestServer({ silent: false })
}

function addGroup() {
  const name = (prompt(t('groups.promptAdd')) || '').trim()
  if (!name) return
  if (state.groups.includes(name)) return toast(t('groups.duplicate'), 'err')
  ensureGroup(name)
  state.activeGroup = name
  saveServers()
  renderServers()
  toast(t('groups.added', { group: name }), 'ok')
}

function renameGroup(oldName) {
  if (oldName === '默认') return
  const name = (prompt(t('groups.promptRename', { group: oldName }), oldName) || '').trim()
  if (!name || name === oldName) return
  if (state.groups.includes(name)) return toast(t('groups.duplicate'), 'err')
  const idx = state.groups.indexOf(oldName)
  state.groups[idx] = name
  for (const s of state.servers) if (s.group === oldName) s.group = name
  if (state.activeGroup === oldName) state.activeGroup = name
  if (name in state.autoSelect) delete state.autoSelect[name]
  state.autoSelect[name] = state.autoSelect[oldName] !== false
  delete state.autoSelect[oldName]
  state.groupActive[name] = state.groupActive[oldName] || ''
  delete state.groupActive[oldName]
  saveServers()
  renderServers()
  toast(t('groups.renamed', { group: name }), 'ok')
}

function deleteGroup(name) {
  if (name === '默认') return toast(t('groups.cannotDeleteDefault'), 'err')
  if (!state.groups.includes(name)) return
  if (!confirm(t('groups.confirmDelete', { group: name }))) return
  state.groups = state.groups.filter(g => g !== name)
  for (const s of state.servers) if (s.group === name) s.group = '默认'
  delete state.autoSelect[name]
  delete state.groupActive[name]
  if (state.activeGroup === name) state.activeGroup = '默认'
  saveServers()
  renderServers()
  toast(t('groups.deleted'), 'ok')
  if (state.token) selectFastestServer({ silent: true })
}

/* ---------------- 事件流 (WebSocket + 轮询降级) ---------------- */
const streams = {}
state.streamsOk = { mux: false, host: false }
const streamMeta = {
  mux: { generation: 0, attempt: 0, failures: 0, retryTimer: null },
  host: { generation: 0, attempt: 0, failures: 0, retryTimer: null },
}
let pollTimer = null
let wsRetryTimer = null
let connTickTimer = null
let reconnectInfo = null

function clearStreamTimers(ws) {
  if (!ws) return
  if (ws._retryTimer) clearTimeout(ws._retryTimer)
  ws._retryTimer = null
}

function streamIsCurrent(kind, ws, generation) {
  return streams[kind] === ws && streamMeta[kind].generation === generation
}

function aggregateStreamFailures() {
  state.errCount = Math.max(streamMeta.mux.failures, streamMeta.host.failures)
}

function markStreamInfo(kind, patch) {
  state.streamInfo[kind] = { ...state.streamInfo[kind], ...patch }
}

function allStreamsOpen() {
  return streams.mux?.readyState === WebSocket.OPEN && streams.host?.readyState === WebSocket.OPEN
}

function clearStreamRetry(kind) {
  const meta = streamMeta[kind]
  if (meta.retryTimer) clearTimeout(meta.retryTimer)
  meta.retryTimer = null
}

function closeStream(kind) {
  const meta = streamMeta[kind]
  clearStreamRetry(kind)
  meta.generation++
  const ws = streams[kind]
  streams[kind] = null
  state.streamsOk[kind] = false
  try { ws?.close() } catch {}
}

function clearConnTick() {
  clearInterval(connTickTimer)
  connTickTimer = null
}

function startConnTick() {
  if (connTickTimer) return
  connTickTimer = setInterval(() => {
    updateConn()
    if (!reconnectInfo || state.streamMode === 'poll' || !navigator.onLine ||
        (streams.mux?.readyState === WebSocket.OPEN && streams.host?.readyState === WebSocket.OPEN)) {
      clearConnTick()
    }
  }, 1000)
}

function setReconnect(delay) {
  reconnectInfo = { at: Date.now() + delay }
  startConnTick()
  updateConn()
}

function clearReconnect() {
  reconnectInfo = null
  clearConnTick()
}

function openStreams() {
  if (!state.token) return
  if (state.streamMode !== 'poll') state.streamMode = 'ws'
  openStream('mux', onMuxFrame, true)
  openStream('host', onHostFrame, false)
}

function openStream(kind, handler, refreshOnOpen, isRestore, ticket = null) {
  if (!state.token) return
  if (ticket === null) {
    const token = state.token
    void getWsTicket().then((value) => {
      if (state.token === token) openStream(kind, handler, refreshOnOpen, isRestore, value)
    }).catch(() => {
      // 兼容旧网关/插件副本: ticket 接口不可用时临时回退旧 token 握手。
      if (state.token === token) openStream(kind, handler, refreshOnOpen, isRestore, '')
    })
    return
  }
  let base
  if (state.server) {
    base = state.server.replace(/^http/, 'ws')
  } else {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${proto}//${location.host}`
  }
  const clientMark = CAP?.isNativePlatform?.() ? 'app' : 'web'
  const auth = ticket ? `ticket=${encodeURIComponent(ticket)}` : `token=${encodeURIComponent(state.token)}`
  const clientId = CLIENT_ID ? `&clientId=${encodeURIComponent(CLIENT_ID)}` : ''
  const streamUrl = `${base}/api/events.${kind}?${auth}&client=${clientMark}${clientId}`
  const current = streams[kind]
  if (current?._streamUrl === streamUrl &&
      (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return
  if (current && current._streamUrl !== streamUrl) {
    streamMeta[kind].attempt = 0
    streamMeta[kind].failures = 0
    aggregateStreamFailures()
  }
  closeStream(kind)
  const meta = streamMeta[kind]
  const generation = meta.generation
  const ws = new WebSocket(streamUrl)
  streams[kind] = ws
  ws._streamUrl = streamUrl
  ws._generation = generation
  ws._isRestore = !!isRestore
  ws.onopen = () => {
    if (!streamIsCurrent(kind, ws, generation)) return
    state.streamsOk[kind] = true
    markStreamInfo(kind, { status: 'open', lastOpenAt: Date.now(), lastCloseCode: 0, lastCloseReason: '' })
    meta.attempt = 0
    meta.failures = 0
    aggregateStreamFailures()
    clearStreamTimers(ws)
    // DSH mux/host 是只下行 WebSocket, 浏览器不能发送应用层 ping。
    // 网关负责 RFC6455 Ping/Pong, 前端只监听业务帧和 close 事件。
    if (state.streamMode === 'poll' && allStreamsOpen()) {
      stopPolling()
      state.streamMode = 'ws'
    }
    if (allStreamsOpen()) clearReconnect()
    updateConn()
    // mux 每次(重)连接都会重放“仍待处理”的审批/提问基线:
    // 先清空旧列表, 避免“桌面已自定义回答, 手机漏收 question/resolved”后永久残留。
    if (kind === 'mux') {
      state.approvals = []
      state.questions = []
      renderPending()
    }
    if (refreshOnOpen) refreshAll()
    if (allStreamsOpen()) {
      resyncAfterStreamOpen()
      void pingServer(state.server || location.origin)
      void refreshHostDescription()
    }
  }
  ws.onmessage = (msg) => {
    if (!streamIsCurrent(kind, ws, generation)) return
    state.streamsOk[kind] = true
    updateConn()
    try {
      const full = JSON.parse(msg.data)
      handler(full)
    } catch {}
  }
  ws.onclose = () => {
    clearStreamTimers(ws)
    if (!streamIsCurrent(kind, ws, generation)) return
    streams[kind] = null
    state.streamsOk[kind] = false
    markStreamInfo(kind, {
      status: 'closed',
      lastCloseAt: Date.now(),
      lastCloseCode: Number(ws.code) || 0,
      lastCloseReason: String(ws.reason || ''),
    })
    meta.failures++
    aggregateStreamFailures()
    updateConn()
    if (!navigator.onLine) { clearReconnect(); return }
    // 任一通道连续失败 3 次就降级轮询；另一个通道不会清零它的失败计数。
    if (state.streamMode !== 'poll' && meta.failures >= 3) { enterPollMode(); return }
    // 多服务器: 连续掉线若干次就重测速, 自动换到当前可达的最快地址
    if (state.servers.length && meta.failures % 5 === 0) setTimeout(() => selectFastestServer({ silent: true }), 300)
    // VPN/跨地域链路使用更宽松的指数退避: 1.5s 起步, 最大 60s, 带 20% 抖动。
    const attempt = meta.attempt++
    const baseDelay = Math.min(1500 * Math.pow(2, attempt), 60000)
    const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
    setReconnect(delay)
    clearStreamRetry(kind)
    meta.retryTimer = setTimeout(() => {
      meta.retryTimer = null
      if (state.token && navigator.onLine) openStream(kind, handler, refreshOnOpen, state.streamMode === 'poll')
    }, delay)
  }
  ws.onerror = () => { try { ws.close() } catch {} }
}

/* ---------------- 轮询降级模式 ---------------- */
function enterPollMode() {
  if (state.streamMode === 'poll') return
  state.streamMode = 'poll'
  state.pollSeq = { mux: 0, host: 0 }
  state.streamsOk = { mux: false, host: false }
  closeStream('mux')
  closeStream('host')
  refreshAll()
  startPolling()
  updateConn()
}

function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = null
  clearTimeout(wsRetryTimer)
  wsRetryTimer = null
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(pollOnce, 4000)
  wsRetryTimer = setInterval(tryRestoreWs, 30000)
  pollOnce()
}

let pollInFlight = false
async function pollOnce() {
  if (state.streamMode !== 'poll' || pollInFlight) return
  pollInFlight = true
  try {
    await Promise.all([pollKind('mux'), pollKind('host')])
  } finally {
    pollInFlight = false
  }
}

async function pollKind(kind) {
  if (state.streamMode !== 'poll') return
  const since = state.pollSeq[kind] || 0
  let res
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30000) : undefined
    const headers = { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }
    res = signal ? await fetch(apiUrl(`/api/events.poll?kind=${kind}&since=${since}&wait=25000`), { signal, headers }) : await fetch(apiUrl(`/api/events.poll?kind=${kind}&since=${since}&wait=25000`), { headers })
  } catch { return }
  if (res.status === 401) { authFailure(); return }
  if (!res.ok) return
  let data
  try { data = await res.json() } catch { return }
  if (!data || !Array.isArray(data.events)) return
  // 网关重启或客户端离线过久后，游标可能落后于内存环形缓冲；
  // 从当前缓冲重新接收，并刷新权威会话列表，避免静默漏事件。
  const reset = data.truncated === true || (typeof data.latestSeq === 'number' && data.latestSeq < since)
  if (reset) {
    state.pollSeq[kind] = 0
    if (kind === 'mux') {
      state.approvals = []
      state.questions = []
      renderPending()
    }
    scheduleRefresh()
    if (state.current) void resyncCurrentSession()
  }
  for (const item of data.events) {
    if (item.seq > (state.pollSeq[kind] || 0)) {
      state.pollSeq[kind] = item.seq
      if (kind === 'mux') onMuxFrame(item.event)
      else onHostFrame(item.event)
    }
  }
}

function tryRestoreWs() {
  if (state.streamMode !== 'poll' || !state.token) return
  // 轮询继续跑，等 WS 真正 onopen 后再切回，避免重连窗口丢事件
  if (!streams.mux && !streamMeta.mux.retryTimer) openStream('mux', onMuxFrame, true, true)
  if (!streams.host && !streamMeta.host.retryTimer) openStream('host', onHostFrame, false, true)
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

/* 回前台 / 定时兜底: 任何流不在 OPEN 就重连; 多服务器时顺便重测速 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    onResume()
    if (state.servers.length) selectFastestServer({ silent: true })
    else if (state.token && (streams.mux?.readyState !== WebSocket.OPEN || streams.host?.readyState !== WebSocket.OPEN)) openStreams()
  }
})
window.addEventListener('pageshow', onResume)
setInterval(() => {
  if (document.visibilityState === 'visible' && state.token) {
    if (streams.mux?.readyState !== WebSocket.OPEN || streams.host?.readyState !== WebSocket.OPEN) openStreams()
  }
}, 15000)
// 多服务器: 每 5 分钟重测一次延迟, 网络环境变化(离开 Wi-Fi / 挂上 Tailscale)时自动换线
setInterval(() => {
  if (document.visibilityState === 'visible' && state.servers.length) selectFastestServer({ silent: true })
}, 300000)

/* 网络感知: 离线立刻关 WS + 显示离线, 在线立即重连 */
window.addEventListener('offline', () => {
  clearReconnect()
  closeStream('mux')
  closeStream('host')
  if (state.streamMode === 'poll') stopPolling()
  updateConn()
})
window.addEventListener('online', () => {
  if (!state.token) { updateConn(); return }
  state.errCount = 0
  clearReconnect()
  openStreams()
  updateConn()
})

function onMuxFrame(full) {
  const f = full.payload
  if (!f) return
  if (f.type === 'session/event') return onSessionEvent(f.sessionId, f.event)
  if (f.type === 'session/subscribed') return
  if (f.type === 'approval/requested') {
    state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId)
    state.approvals.push({ ...f, rpcId: full.rpcId })
    notify(t('notify.approvalTitle'), t('notify.approvalBody', { tool: f.toolName || t('tool.unknown') }))
    renderPending(); return
  }
  if (f.type === 'approval/resolved') { state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId); renderPending(); return }
  if (f.type === 'question/requested') {
    state.questions = state.questions.filter(q => q.rpcId !== full.rpcId)
    state.questions.push({ ...f, rpcId: full.rpcId })
    notify(t('notify.questionTitle'), f.questions?.map(q => q.question).join(' / ') || t('notify.questionBody'))
    renderPending(); return
  }
  if (f.type === 'question/resolved') { state.questions = state.questions.filter(q => q.rpcId !== f.questionRpcId); renderPending(); return }
  if (f.type === 'session/queue') { state.queues[f.sessionId] = f.items || []; renderQueue(); return }
  if (f.type === 'session/jobs') { state.jobs[f.sessionId] = f.jobs || []; renderJobs(); return }
  if (f.type === 'session/projection') { applyProjection(f.sessionId, f.key, f.value, f.seq); return }
  if (f.type === 'stream/error') { toast(t('stream.error', { msg: f.error?.message || '' }), 'err') }
}
function onHostFrame(full) {
  const f = full.payload
  if (!f) return
  if (['host/session-added', 'host/session-removed', 'host/workspace-changed', 'host/workspace-removed', 'host/workspace-order-changed', 'host/archived-sessions-changed'].includes(f.type)) return scheduleRefresh()
  if (f.type === 'host/session-status') {
    const s = state.byId.get(f.sessionId)
    if (s) { s.running = f.running; if (state.current === f.sessionId) { renderSessionCards(); updateCancelBtn(); renderSessionSub(); updateSessionStatus() } }
    return
  }
  if (f.type === 'host/agent-error') {
    const s = state.byId.get(f.sessionId)
    if (s) { s.error = true; s.running = false }
    if (state.current === f.sessionId) { renderSessionSub(); updateSessionStatus() }
    return toast(t('session.errorMsg', { msg: f.message }), 'err')
  }
  if (f.type === 'host/remote-event') return scheduleRefresh()
}

function onSessionEvent(sessionId, event) {
  if (!event) return
  const s = state.byId.get(sessionId)
  if (event.type === 'turn/start' || event.type === 'turn/end') {
    noteSessionTurnTime(sessionId, event)
    renderSessions()
  }
  if (event.type === 'agent/status') {
    if (s) { s.running = !!event.data?.running; s.blank = false; if (s.running) s.error = false }
    if (state.current === sessionId) { updateCancelBtn(); renderSessionSub(); updateSessionStatus() }
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
  if (state.current) { renderSessionCards(); renderSessionSub(); updateCancelBtn(); updateSessionStatus() }
  renderPending(); renderQueue(); renderJobs(); updateConn()
}

async function refreshSessions() {
  const v = await safeRpc('session.list', {}, t('err.sessionList'))
  if (!v) {
    // 网关不可达: 用上次成功的会话列表兜底, 用户仍能打开历史缓存
    if (!state.sessions.length) {
      const cached = cacheRead(CACHE.sessions, [])
      if (Array.isArray(cached) && cached.length) {
        state.sessions = cached
        state.byId = new Map(cached.map(s => [s.sessionId, s]))
        renderSessions()
        toast(t('sessions.cacheFallback'), 'ok')
      }
    }
    return
  }
  state.sessions = v.items || []
  state.byId = new Map(state.sessions.map(s => [s.sessionId, s]))
  applyPendingProjections()
  cacheWrite(CACHE.sessions, state.sessions.slice(0, 80))
  renderSessions()
  refreshWorkbench()
}

function removeLocalSessionRecord(sessionId) {
  if (!sessionId) return
  state.sessions = state.sessions.filter(session => session?.sessionId !== sessionId)
  state.byId.delete(sessionId)
  state.pendingProjections.delete(sessionId)
  state.sessionActivity.delete(sessionId)
  state.pendingPrompts.delete(sessionId)
  delete state.queues[sessionId]
  delete state.jobs[sessionId]
  const historyCache = readHistoryCache()
  if (Object.prototype.hasOwnProperty.call(historyCache, sessionId)) {
    delete historyCache[sessionId]
    writeHistoryCache(historyCache)
  }
  cacheWrite(CACHE.sessions, state.sessions.slice(0, 80))
}

function proj(s, key, d) { return s?.projections?.values?.[key] ?? d }
function hydrateSessionProjections(sessionId, projections) {
  const s = state.byId.get(sessionId)
  if (!s || !projections || typeof projections !== 'object') return
  const incomingSeq = Number(projections.asOfSeq) || 0
  const current = s.projections || { asOfSeq: 0, values: {} }
  const currentSeq = Number(current.asOfSeq) || 0
  if (incomingSeq < currentSeq) return
  s.projections = {
    asOfSeq: Math.max(currentSeq, incomingSeq),
    values: { ...(current.values || {}), ...(projections.values || {}) }
  }
}
function applyPendingProjections() {
  for (const [sessionId, projections] of state.pendingProjections) {
    if (!state.byId.has(sessionId)) continue
    hydrateSessionProjections(sessionId, projections)
    state.pendingProjections.delete(sessionId)
  }
}
function applyProjection(sessionId, key, value, seq) {
  const s = state.byId.get(sessionId)
  if (!s) {
    const pending = state.pendingProjections.get(sessionId) || { asOfSeq: 0, values: {} }
    pending.values[key] = value
    pending.asOfSeq = Math.max(pending.asOfSeq || 0, seq || 0)
    state.pendingProjections.set(sessionId, pending)
    return
  }
  const currentSeq = Number(s.projections?.asOfSeq) || 0
  if (seq && seq < currentSeq) return
  s.projections = s.projections || { asOfSeq: 0, values: {} }
  s.projections.values = s.projections.values || {}
  s.projections.values[key] = value
  s.projections.asOfSeq = Math.max(currentSeq, seq || 0)
  if (state.current === sessionId) { renderSessionTitle(); renderSessionCards() }
  if (['title', 'goal', 'todos', 'plan', 'sessionListMetadata'].includes(key)) scheduleRefresh()
  else renderSessions()
}
function setSessionRecovery(status, error = '') {
  state.sessionRecovery = { status, error: String(error || '') }
  if (state.current) { renderSessionSub(); updateSessionStatus() }
}
function recoveryLabel() {
  const status = state.sessionRecovery.status
  if (status === 'loading' || status === 'resuming') return t('session.recovering')
  if (status === 'cached') return t('session.recoveryCached')
  if (status === 'error') return t('session.recoveryFailed')
  return ''
}
function resyncCurrentSession() {
  if (!state.current) return Promise.resolve()
  return loadHistory(true).then(() => {
    if (state.current) { renderSessionCards(); renderSessionSub(); updateCancelBtn(); updateSessionStatus() }
  })
}
function resyncAfterStreamOpen() {
  if (!state.current || Date.now() - state.lastStreamResyncAt < 1200) return
  state.lastStreamResyncAt = Date.now()
  void refreshAll().then(() => resyncCurrentSession())
}
function titleOf(s) { return proj(s, 'title') || (s?.sessionId ? short(s.sessionId) : t('session.unknown')) }
function short(id) { return '…' + String(id).slice(-8) }
function isTopLevelSession(session) {
  return !!session && !session.parentSessionId && session.origin !== 'subagent'
}
function topLevelSessions() { return state.sessions.filter(isTopLevelSession) }
const GOAL_TERMINAL_PHASES = new Set(['complete', 'cleared'])
function isGoalTerminal(goal) {
  return !!goal && GOAL_TERMINAL_PHASES.has(goal.phase)
}
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

/* ---------------- 工作台与归档会话 ---------------- */
function wbPathKey(p) {
  let value = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/')
  if (value.length > 1) value = value.replace(/\/+$/, '')
  const windows = /^[A-Za-z]:\//.test(value) || /Windows/i.test(navigator.platform || navigator.userAgent || '')
  return windows ? value.toLowerCase() : value
}
function wbBaseName(p) {
  const value = String(p || '').replace(/[\\/]+$/, '')
  return value.split(/[\\/]/).pop() || value
}
function wbStrictInside(pathValue, rootValue) {
  const pathKey = wbPathKey(pathValue)
  const rootKey = wbPathKey(rootValue)
  if (!pathKey || !rootKey || pathKey === rootKey) return false
  return pathKey.startsWith(rootKey.endsWith('/') ? rootKey : rootKey + '/')
}
function wbJoin(root, name) {
  const raw = String(root || '')
  const separator = raw.includes('\\') ? '\\' : '/'
  return raw.replace(/[\\/]+$/, '') + separator + String(name || '')
}
function workbenchRoot() {
  return state.wb?.bound && state.wb.path ? state.wb.path : ''
}
const WORKSPACE_UNGROUPED = '__ungrouped__'
function workspaceItems() {
  return (state.wbProjects || []).filter(w => w && typeof w.workspaceId === 'string' && w.workspaceId && typeof w.path === 'string' && w.path)
}
const WORKBENCH_ORDER_CACHE_KEY = 'workbenchOrderV1'
function workbenchOrderScope() { return String(state.server || location.origin || 'default') }
function workbenchOrderStore() {
  const value = cacheRead(WORKBENCH_ORDER_CACHE_KEY, {})
  if (!value || typeof value !== 'object') return { scopes: {} }
  if (!value.scopes || typeof value.scopes !== 'object') value.scopes = {}
  return value
}
function workbenchOrderScopeValue() {
  const store = workbenchOrderStore()
  const key = workbenchOrderScope()
  if (!store.scopes[key] || typeof store.scopes[key] !== 'object') store.scopes[key] = {}
  return { store, value: store.scopes[key] }
}
function orderedItems(items, ids, getId) {
  const source = Array.isArray(items) ? items : []
  const byId = new Map(source.map(item => [String(getId(item)), item]))
  const result = []
  const used = new Set()
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id)
    const item = byId.get(key)
    if (item && !used.has(key)) { result.push(item); used.add(key) }
  }
  for (const item of source) {
    const key = String(getId(item))
    if (!used.has(key)) { result.push(item); used.add(key) }
  }
  return result
}
function orderedWorkspaceItems(items) {
  const { value } = workbenchOrderScopeValue()
  return orderedItems(items, value.workspaceIds, item => item.workspaceId)
}
function orderedWorkspaceSessions(workspaceId, items) {
  const { value } = workbenchOrderScopeValue()
  return orderedItems(items, value.sessionIds?.[String(workspaceId)], item => item.sessionId)
}
function saveWorkbenchOrder(mutator) {
  const { store, value } = workbenchOrderScopeValue()
  mutator(value)
  cacheWrite(WORKBENCH_ORDER_CACHE_KEY, store)
}
function commitWorkspaceOrder(order) {
  saveWorkbenchOrder(value => { value.workspaceIds = order.map(String) })
  renderWorkbench()
  toast(t('wb.orderSaved'), 'ok')
}
function commitWorkspaceSessionOrder(workspaceId, order) {
  if (!workspaceId) return
  saveWorkbenchOrder(value => {
    value.sessionIds ||= {}
    value.sessionIds[String(workspaceId)] = order.map(String)
  })
  renderWorkbench()
  toast(t('wb.orderSaved'), 'ok')
}
function workspaceById(workspaceId) {
  return workspaceItems().find(w => w.workspaceId === workspaceId) || null
}
function workspaceOwnsSession(workspace, session) {
  if (!workspace || !session?.sessionId) return false
  if (String(session.workspaceId || '') === workspace.workspaceId) return true
  if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.some(id => String(id) === String(session.sessionId))) return true
  const cwdKey = wbPathKey(sessionCwd(session))
  const workspaceKey = wbPathKey(workspace.path)
  return !!cwdKey && !!workspaceKey && (cwdKey === workspaceKey || cwdKey.startsWith(workspaceKey.endsWith('/') ? workspaceKey : workspaceKey + '/'))
}
function workspaceForSession(session) {
  if (!session) return null
  return workspaceItems().find(workspace => workspaceOwnsSession(workspace, session)) || null
}
function workspaceName(workspace) {
  return String(workspace?.title || wbBaseName(workspace?.path) || workspace?.path || '').trim()
}
function workspaceOptionLabel(workspace) {
  const name = workspaceName(workspace)
  return workspace.path && workspace.path !== name ? `${name} — ${workspace.path}` : name
}
function workspaceOptionsHtml({ all = false, ungrouped = false, root = false, selected = '' } = {}) {
  const rows = []
  if (all) rows.push({ id: '', label: t('workspace.all') })
  if (root) {
    const roots = state.fs.roots.length ? state.fs.roots : ['']
    roots.forEach((rootPath, index) => rows.push({
      id: index === 0 ? '' : `__fs_root__:${index}`,
      label: rootPath && roots.length > 1 ? `${t('fs.root')} — ${rootPath}` : t('fs.root'),
    }))
  }
  for (const workspace of workspaceItems()) rows.push({ id: workspace.workspaceId, label: workspaceOptionLabel(workspace) })
  if (ungrouped) rows.push({ id: WORKSPACE_UNGROUPED, label: t('workspace.ungrouped') })
  return rows.map(row => `<option value="${esc(row.id)}"${row.id === selected ? ' selected' : ''}>${esc(row.label)}</option>`).join('')
}
function renderWorkspaceNavigation() {
  const items = workspaceItems()
  if (state.workspaceFilter !== WORKSPACE_UNGROUPED && state.workspaceFilter && !workspaceById(state.workspaceFilter)) {
    state.workspaceFilter = ''
    LS.del('workspaceFilterV1')
  }
  const sessionSelect = $('session-workspace-filter')
  if (sessionSelect) {
    sessionSelect.innerHTML = workspaceOptionsHtml({ all: true, ungrouped: true, selected: state.workspaceFilter })
    syncCustomSelect(sessionSelect)
  }
  const selectedWorkspace = workspaceById(state.workspaceFilter)
  const pathBox = $('session-workspace-path')
  if (pathBox) pathBox.textContent = selectedWorkspace?.path || (state.workspaceFilter === WORKSPACE_UNGROUPED ? t('workspace.ungrouped') : t('workspace.allPath'))
  const filesButton = $('session-workspace-files')
  if (filesButton) filesButton.disabled = !selectedWorkspace

  if (state.fs.workspaceId && !workspaceById(state.fs.workspaceId)) {
    state.fs.workspaceId = ''
    LS.del('fsWorkspaceIdV1')
  }
  const fsSelect = $('fs-workspace')
  if (fsSelect) {
    const selected = state.fs.workspaceId || (state.fs.rootIndex > 0 ? `__fs_root__:${state.fs.rootIndex}` : '')
    fsSelect.innerHTML = workspaceOptionsHtml({ root: true, selected })
    syncCustomSelect(fsSelect)
  }
  if ($('modal-new-session') && !$('modal-new-session').classList.contains('hidden')) renderNewSessionWorkspace()
  return items
}
async function refreshWorkbench() {
  if (!state.token) return
  try {
    const res = await fetch(apiUrl('/workbench'), {
      headers: { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }
    })
    if (res.ok) {
      const value = await res.json().catch(() => null)
      if (value && typeof value.bound === 'boolean') state.wb = value
    }
  } catch {}
  try {
    const value = await rpc('workspace.list', {})
    state.wbProjects = Array.isArray(value?.items) ? value.items : []
    state.wbArchived = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds : []
  } catch {
    state.wbProjects = []
    state.wbArchived = []
  }
  // 以磁盘实际目录为准同步工作台项目：删除目录后不再残留，新增子目录自动收纳。
  if (state.wb?.bound && state.wb.path) {
    try {
      const listRes = await fetch(fsApiUrl('/list', { path: state.wb.path }), { headers: fsHeaders() })
      if (listRes.ok) {
        const listData = await listRes.json().catch(() => ({}))
        if (Array.isArray(listData.entries)) {
          const diskDirs = new Set(listData.entries.filter(e => e.type === 'dir').map(e => wbPathKey(wbJoin(state.wb.path, e.name))))
          // 工作台只管理自己根目录下的项目；DSH 中位于其他路径的工作区必须保留，
          // 否则手机的工作区选择器会因绑定了工作台而丢失条目。
          state.wbProjects = state.wbProjects.filter(w => !wbStrictInside(w.path, state.wb.path) || diskDirs.has(wbPathKey(w.path)))
          const have = new Set(state.wbProjects.map(w => wbPathKey(w.path)))
          for (const entry of listData.entries) {
            if (entry.type !== 'dir') continue
            const projectPath = wbJoin(state.wb.path, entry.name)
            if (have.has(wbPathKey(projectPath))) continue
            try {
              const created = await rpc('workspace.create', { path: projectPath })
              if (created?.workspace) { state.wbProjects.push(created.workspace); have.add(wbPathKey(projectPath)) }
            } catch {}
          }
        }
      }
    } catch {}
  }
  renderWorkspaceNavigation()
  renderWorkbench()
  renderSessions()
}
function renderWorkbench() {
  const bar = $('workbench-bar')
  if (!bar) return
  const bound = !!state.wb?.bound && !!state.wb.path
  const toggle = $('wb-toggle')
  const panel = $('wb-panel')
  bar.classList.toggle('bound', bound)
  bar.classList.toggle('unbound', !bound)
  if (!bound) {
    $('wb-label').textContent = t('wb.unbound')
    toggle.setAttribute('aria-expanded', 'false')
    panel.classList.add('hidden')
    panel.innerHTML = ''
    return
  }
  $('wb-label').textContent = t('wb.bound', { title: state.wb.title || wbBaseName(state.wb.path) })
  toggle.setAttribute('aria-expanded', state.wbOpen ? 'true' : 'false')
  panel.classList.toggle('hidden', !state.wbOpen)
  if (!state.wbOpen) { panel.innerHTML = ''; return }
  const projects = orderedWorkspaceItems(state.wbProjects.filter(w => wbStrictInside(w.path, workbenchRoot())))
  if (!projects.length) {
    panel.innerHTML = `<div class="wb-empty">${esc(t('wb.noProjects'))}</div>`
    return
  }
  const archivedSet = new Set(state.wbArchived || [])
  const projectHtml = projects.map(w => {
    const id = String(w.workspaceId || '')
    const open = !!state.wbOpenProjects[id]
    const sessions = orderedWorkspaceSessions(id, (w.sessionIds || []).map(sid => state.byId.get(sid)).filter(isTopLevelSession).filter(s => !archivedSet.has(s.sessionId)))
    const body = open ? `<div class="wb-sessions">${sessions.length ? sessions.map(s => `
      <div class="session-swipe" data-session-swipe data-id="${esc(s.sessionId)}">
        <button class="wb-session" type="button" data-wb-session="${esc(s.sessionId)}" data-motion-key="${esc(s.sessionId)}">
          <span class="wb-session-drag-handle" data-reorder-handle aria-hidden="true">⠿</span>
          <span class="wb-session-title">${esc(titleOf(s))}</span>
          <span class="wb-session-meta">${s.running ? esc(t('sessions.running')) : esc(fmtTime(sessionSortTime(s)))}</span>
        </button>
        <button type="button" class="sc-archive-btn" data-archive-session="${esc(s.sessionId)}">${esc(t('session.archive'))}</button>
      </div>`).join('') : `<div class="wb-empty">${esc(t('wb.noSessions'))}</div>`}</div>` : ''
    return `<div class="wb-project ${open ? 'open' : ''}" data-wb-project="${esc(id)}" data-motion-key="${esc(id)}">
      <div class="wb-project-head">
        <span class="wb-drag-handle" data-reorder-handle aria-hidden="true">⠿</span>
        <span class="wb-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="wb-project-title">${esc(w.title || wbBaseName(w.path) || w.path)}</span>
        <button class="mini-btn wb-new" type="button" data-wb-new="${esc(id)}">${esc(t('wb.newSession'))}</button>
      </div>${body}
    </div>`
  }).join('')
  if (window.DshMotion?.relayout) {
    window.DshMotion.relayout(panel, '.wb-project', () => { panel.innerHTML = projectHtml })
  } else panel.innerHTML = projectHtml
  window.DshMotion?.list(panel, '.wb-session')
  window.DshMotion?.bindLongPressReorder(panel, '.wb-project', {
    handleSelector: '.wb-project-head',
    excludeSelector: '[data-wb-new]',
    onCommit: ({ order }) => commitWorkspaceOrder(order)
  })
  window.DshMotion?.bindLongPressReorder(panel, '.session-swipe', {
    groupSelector: '.wb-project',
    handleSelector: '.wb-session',
    onCommit: ({ item, order }) => commitWorkspaceSessionOrder(item.closest('[data-wb-project]')?.dataset.wbProject, order)
  })
}

function sessionCwd(s) { return typeof s?.cwd === 'string' ? s.cwd.trim() : '' }
function sessionWorkspaceLabel(s) {
  const workspace = workspaceForSession(s)
  return workspace?.path || sessionCwd(s) || t('sessions.workspaceUnknown')
}
function sessionWorkspaceName(s) {
  const workspace = workspaceForSession(s)
  return workspace ? workspaceName(workspace) : workspaceDisplayName(sessionWorkspaceLabel(s))
}
function workspaceDisplayName(label) {
  const value = String(label || '').trim()
  if (!value || value === t('sessions.workspaceUnknown')) return value || t('sessions.workspaceUnknown')
  const clean = value.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
}
function sessionSortTime(s) {
  return Math.max(Number(state.sessionTurnTimes[s?.sessionId]) || 0, Number(s?.updatedAt) || 0, Number(s?.createdAt) || 0)
}
function noteSessionTurnTime(sessionId, eventOrTime) {
  const raw = typeof eventOrTime === 'object' ? eventOrTime?.time : eventOrTime
  const time = Number(raw) > 0 ? Number(raw) : Date.now()
  if (!sessionId || !Number.isFinite(time)) return
  state.sessionTurnTimes[sessionId] = Math.max(Number(state.sessionTurnTimes[sessionId]) || 0, time)
}
function sessionWorkspaceOrderKey(s) {
  const workspace = workspaceForSession(s)
  return String(workspace?.workspaceId || 'path:' + (sessionWorkspaceLabel(s) || WORKSPACE_UNGROUPED))
}
function commitWorkspaceGroupOrder(order) {
  saveWorkbenchOrder(value => { value.workspaceIds = order.map(String) })
  renderSessions()
  renderWorkbench()
  toast(t('wb.orderSaved'), 'ok')
}
function sortedSessions() {
  const items = topLevelSessions()
  if (state.sessionSort === 'workspace') {
    return items.sort((a, b) => {
      const aw = sessionCwd(a) || '\uffff'
      const bw = sessionCwd(b) || '\uffff'
      const byWorkspace = aw.localeCompare(bw, undefined, { numeric: true, sensitivity: 'base' })
      return byWorkspace || (sessionSortTime(b) - sessionSortTime(a))
    })
  }
  return items.sort((a, b) => sessionSortTime(b) - sessionSortTime(a))
}
function renderSessions() {
  const list = $('session-list')
  const allItems = sortedSessions()
  const archivedSet = new Set(state.wbArchived || [])
  const visible = allItems.filter(s => {
    if (!state.workspaceFilter) return true
    if (state.workspaceFilter === WORKSPACE_UNGROUPED) return !workspaceForSession(s)
    return workspaceOwnsSession(workspaceById(state.workspaceFilter), s)
  })
  const archived = visible.filter(s => archivedSet.has(s.sessionId))
  const main = visible.filter(s => !archivedSet.has(s.sessionId))
  const showArchived = LS.get('showArchivedV1', '0') === '1'
  const renderSession = s => {
      const workspace = sessionWorkspaceLabel(s)
      const workspaceTitle = sessionWorkspaceName(s)
      const title = titleOf(s)
      const goal = goalOf(s)
      const pending = (state.approvals.some(a => a.sessionId === s.sessionId) || state.questions.some(q => q.sessionId === s.sessionId)) ? 'pending' : ''
      const queueN = (state.queues[s.sessionId] || []).filter(i => i.placement === 'queued').length
      const dots = []
      if (s.running) dots.push('running')
      if (pending) dots.push('pending')
      const badge = goal ? `<span class="sc-badge ${goal.phase === 'active' ? 'goal-active' : ''}">${esc(t('sessions.goalBadge', { phase: goal.phase || '?' }))}</span>` : ''
      const queueBadge = queueN ? `<span class="sc-badge">${esc(t('sessions.queueBadge', { n: queueN }))}</span>` : ''
      const archiveButton = archivedSet.has(s.sessionId) ? '' : `<button type="button" class="sc-archive-btn" data-archive-session="${esc(s.sessionId)}">${esc(t('session.archive'))}</button>`
      return `<div class="session-swipe" data-session-swipe data-id="${esc(s.sessionId)}">
        <div class="session-card ${state.current === s.sessionId ? 'current' : ''}">
        <div class="sc-title">${esc(title)}</div>
        <div class="sc-meta">
          <span class="sc-dot ${dots.join(' ')}"></span>
          <span>${fmtTime(sessionSortTime(s))}</span>
          ${s.running ? '<span>' + t('sessions.running') + '</span>' : ''}
          ${badge}${queueBadge}
        </div>
        <div class="sc-workspace" title="${esc(workspace)}">⌂ ${esc(workspaceTitle)}</div>
        <span class="sc-arrow">›</span>
        </div>
        ${archiveButton}
      </div>`
  }
  const renderItems = (items) => {
    if (state.sessionSort !== 'workspace') return items.map(renderSession).join('')
    const groups = []
    const byKey = new Map()
    for (const session of items) {
      const key = sessionWorkspaceOrderKey(session)
      let group = byKey.get(key)
      if (!group) {
        group = { key, label: sessionWorkspaceName(session), path: sessionWorkspaceLabel(session), items: [] }
        byKey.set(key, group)
        groups.push(group)
      }
      group.items.push(session)
    }
    const { value } = workbenchOrderScopeValue()
    return orderedItems(groups, value.workspaceIds, group => group.key).map(group => `<div class="session-workspace-group" data-workspace-group="${esc(group.key)}" data-motion-key="${esc(group.key)}">
      <div class="session-group-label" data-reorder-handle title="${esc(group.path)}"><span class="session-group-drag-handle" aria-hidden="true">⠿</span><span class="session-group-icon" aria-hidden="true">⌂</span><span class="session-group-name">${esc(group.label)}</span></div>
      ${orderedWorkspaceSessions(group.key, group.items).map(renderSession).join('')}
    </div>`).join('')
  }
  const divider = archived.length ? `<button class="archived-toggle" type="button" data-archived-toggle>${esc(showArchived ? t('wb.archivedShown') : t('wb.archivedHidden'))}</button>` : ''
  const rows = renderItems(main) + divider + (showArchived ? renderItems(archived) : '')
  const renderList = () => { list.innerHTML = rows || `<div class="empty">${esc(t('home.empty'))}</div>` }
  if (window.DshMotion?.relayout) window.DshMotion.relayout(list, '.session-swipe', renderList)
  else renderList()
  window.DshMotion?.bindLongPressReorder(list, '.session-workspace-group', {
    handleSelector: '.session-group-label',
    onCommit: ({ order }) => commitWorkspaceGroupOrder(order)
  })
  window.DshMotion?.bindLongPressReorder(list, '.session-swipe', {
    groupSelector: '.session-workspace-group',
    handleSelector: '.session-card',
    onCommit: ({ item, order }) => commitWorkspaceSessionOrder(item.closest('[data-workspace-group]')?.dataset.workspaceGroup, order)
  })
  list.classList.toggle('workspace-sorted', state.sessionSort === 'workspace')
  const sort = $('session-sort')
  if (sort) { sort.value = state.sessionSort; syncCustomSelect(sort) }
  $('home-empty').classList.toggle('hidden', visible.length > 0)
  const running = topLevelSessions().filter(s => s.running).length
  const pending = state.approvals.length + state.questions.length
  $('stat-strip').innerHTML = `
    <div class="stat running"><div class="v">${running}</div><div class="k">${t('sessions.statRunning')}</div></div>
    <div class="stat pending"><div class="v">${pending}</div><div class="k">${t('sessions.statPending')}</div></div>
    <div class="stat ctx"><div class="v">${visible.length}</div><div class="k">${t('sessions.statTotal')}</div></div>`
  updatePendingBadge()
}

/* ---------------- 会话详情 ---------------- */
async function openSession(id) {
  state.current = id
  setSessionRecovery('loading')
  state.history = emptyHistory()
  document.body.classList.add('in-session')
  showView('view-session')
  $('btn-rename-session').classList.remove('hidden')
  $('btn-archive-session').classList.toggle('hidden', (state.wbArchived || []).includes(id))
  $('session-cards').innerHTML = ''
  renderSessionTitle(); renderSessionSub(); updateCancelBtn(); updateSessionStatus()
  $('history').innerHTML = '<div class="empty">' + t('history.loading') + '</div>'
  renderQueue()
  restoreCachedHistory()
  await loadHistory(true)
  renderSessionCards()
  refreshSessions()
}

function sessionHasPendingActivity(sessionId, session) {
  return !!session?.running
    || state.sessionActivity.has(sessionId)
    || state.pendingPrompts.has(sessionId)
    || (state.queues[sessionId] || []).some(item => item?.placement !== 'context')
}

async function shouldDiscardEmptySession(sessionId) {
  const session = state.byId.get(sessionId)
  if (!session || sessionHasPendingActivity(sessionId, session)) return false
  const deadline = Date.now() + 3500
  while (state.current === sessionId && state.history.loading && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (state.current !== sessionId || sessionHasPendingActivity(sessionId, session)) return false
  return isEmptySessionHistory(state.history)
}

async function closeSession() {
  if (closeSession.pending) return closeSession.pending
  const sessionId = state.current
  if (!sessionId) return
  const task = (async () => {
    const discard = await shouldDiscardEmptySession(sessionId)
    if (state.current !== sessionId) return
    state.current = null
    if (discard) removeLocalSessionRecord(sessionId)
    setComposerFullscreen(false)
    clearComposerImages()
    setSessionRecovery('idle')
    $('btn-rename-session').classList.add('hidden')
    $('btn-archive-session').classList.add('hidden')
    state.history = emptyHistory()
    document.body.classList.remove('in-session')
    hideComposerMenu()
    renderSessions()
    renderWorkbench()
    showView('view-home')
  })()
  closeSession.pending = task
  try { await task } finally {
    if (closeSession.pending === task) closeSession.pending = null
  }
}

/* Android 手势返回/实体返回: 注册后系统不再直接杀 App, 由这里接管导航 */
function bindNativeBack() {
  if (!CAP?.isNativePlatform?.()) return
  try {
    CAP.Plugins?.App?.addListener?.('backButton', () => {
      if ($('composer-wrap')?.classList.contains('fs')) { setComposerFullscreen(false); return }
      if (customSelectCurrent) { closeCustomSelect(); return }
      const openModal = [...document.querySelectorAll('.modal')].find(m => !m.classList.contains('hidden'))
      if (openModal) { if (openModal.id === 'modal-notes') closeNotesModal(); else if (openModal.id === 'modal-archive') closeArchiveConfirm(); else if (openModal.id === 'modal-rename') closeRenameSession(); else if (openModal.id === 'modal-app-version-warning') closeAppVersionWarning(false); else if (openModal.id === 'modal-scan-live') closeLiveScan(''); else openModal.classList.add('hidden'); return }   // 先关弹窗
      if (document.body.classList.contains('in-session')) { void closeSession(); return } // 会话页 → 回主页
      if (!$('view-files').classList.contains('hidden')) {           // 文件页 → 上级目录 → 主页
        if (state.fs.path && state.fs.initial && state.fs.path !== state.fs.initial) { fsUp(); return }
        showView('view-home'); return
      }
      try { CAP.Plugins?.App?.exitApp?.() } catch {}                  // 主页再返回 → 退出(与系统一致)
    })
  } catch {}
}

function renderSessionTitle() {
  const s = state.byId.get(state.current)
  $('session-title').textContent = s ? titleOf(s) : t('session.unknown')
}

function renderSessionSub() {
  const s = state.byId.get(state.current)
  if (!s) { $('session-sub').textContent = ''; return }
  const parts = [short(s.sessionId)]
  if (s.cwd) parts.push(s.cwd)
  if (s.running) parts.push(t('session.running'))
  else if (s.error) parts.push(t('session.interrupted'))
  const recovery = recoveryLabel()
  if (recovery) parts.push(recovery)
  $('session-sub').textContent = parts.join(' · ')
}

/** 顶栏状态: 运行中=蓝色流动渐变, 中断/出错=橙红渐变, 空闲=原样式 */
function updateSessionStatus() {
  const s = state.byId.get(state.current)
  const head = $('session-head')
  if (!head) return
  const composerStatus = $('composer-status')
  if (composerStatus) composerStatus.classList.toggle('hidden', !s?.running)
  head.classList.remove('running', 'interrupted')
  const queued = (state.queues[state.current] || []).some(i => i.placement !== 'context')
  if (s?.running || queued) head.classList.add('running')
  else if (s?.error) head.classList.add('interrupted')
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
    hasMore: false, loading: false, loaded: false, renderStart: 0, renderEnd: 0,
    partialReasoning: new Map()
  }
}

function sessionHistoryHasContent(history) {
  return !!history && ((history.visible?.length || 0) > 0 || (history.partialReasoning?.size || 0) > 0)
}

function isEmptySessionHistory(history) {
  return history?.loaded === true && !sessionHistoryHasContent(history)
}

function reasoningStreamKey(data, index) {
  return `${data?.turn ?? '?'}:${data?.step ?? '?'}:${index ?? '?'}`
}

/**
 * DSH 的实时思考以 assistant/chunk 下发，历史尾页可能把增量压成
 * reasoning-chunks。最终 assistant/message 到达后再由正式消息接管展示。
 */
function applyReasoningStreamEvent(event) {
  const h = state.history
  const data = event?.data || {}
  let changed = false
  if (event?.type === 'assistant/chunk') {
    const chunk = data.chunk || {}
    const key = reasoningStreamKey(data, chunk.index)
    if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
      h.partialReasoning.set(key, { turn: data.turn, step: data.step, index: chunk.index, text: '' })
      changed = true
    } else if (chunk.type === 'reasoning-delta') {
      const item = h.partialReasoning.get(key) || { turn: data.turn, step: data.step, index: chunk.index, text: '' }
      item.text += String(chunk.text || '')
      h.partialReasoning.set(key, item)
      changed = true
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning') {
      h.partialReasoning.set(key, {
        turn: data.turn, step: data.step, index: chunk.index,
        text: String(chunk.block.text ?? chunk.block.content ?? '')
      })
      changed = true
    }
  } else if (event?.type === 'reasoning-chunks') {
    const key = reasoningStreamKey(data, data.index)
    const item = h.partialReasoning.get(key) || { turn: data.turn, step: data.step, index: data.index, text: '' }
    item.text += Array.isArray(data.texts) ? data.texts.join('') : String(data.text || '')
    h.partialReasoning.set(key, item)
    changed = true
  } else if (event?.type === 'assistant/message') {
    for (const [key, item] of h.partialReasoning) {
      if (item.turn === data.turn && item.step === data.step) {
        h.partialReasoning.delete(key)
        changed = true
      }
    }
  }
  return changed
}

let reasoningRenderTimer = null
function scheduleReasoningRender() {
  if (reasoningRenderTimer) return
  reasoningRenderTimer = setTimeout(() => {
    reasoningRenderTimer = null
    if (!state.current) return
    const box = $('history')
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 240
    renderHistory(false, nearBottom ? 'bottom' : 'fixed')
  }, 80)
}

function partialReasoningHtml() {
  return [...state.history.partialReasoning.values()]
    .filter(item => item.text)
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || (a.step ?? 0) - (b.step ?? 0) || (a.index ?? 0) - (b.index ?? 0))
    .map(item => `<div class="msg assistant reasoning-live"><div class="role">${esc(t('role.dsh'))}</div><details class="tool" open><summary>${esc(t('block.thinkingLive'))}</summary><div class="tool-text">${esc(truncate(item.text, 12000))}</div></details></div>`)
    .join('')
}

function trimVisible() {
  const h = state.history
  if (h.visible.length <= HISTORY_MAX_VISIBLE) return
  const drop = h.visible.splice(0, h.visible.length - HISTORY_MAX_VISIBLE)
  for (const e of drop) h.seqs.delete(e.seq)
  h.renderStart = Math.max(0, h.renderStart - drop.length)
  h.renderEnd = Math.max(h.renderStart, h.renderEnd - drop.length)
}

/* 聊天记录本地缓存: 每会话最多 250 条, 全局最多 10 个会话 */
function scheduleHistoryCacheSave() {
  clearTimeout(scheduleHistoryCacheSave._t)
  scheduleHistoryCacheSave._t = setTimeout(saveHistoryCache, 400)
}

function saveHistoryCache() {
  const id = state.current
  if (!id || !state.history.visible.length) return
  const s = state.byId.get(id)
  const cache = readHistoryCache()
  cache[id] = {
    title: s ? titleOf(s) : '',
    updatedAt: Date.now(),
    events: state.history.visible.slice(-250).map(e => ({ seq: e.seq, event: e.event }))
  }
  const keys = Object.entries(cache)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 10)
    .map(([k]) => k)
  const pruned = {}
  for (const k of keys) pruned[k] = cache[k]
  writeHistoryCache(pruned)
}

/** 网关不可达时回填本地缓存的历史; 返回是否命中。 */
function restoreCachedHistory() {
  const id = state.current
  if (!id) return false
  const cached = readHistoryCache()[id]
  if (!cached?.events?.length) return false
  if (cached.title) hydrateSessionProjections(id, { values: { title: cached.title }, asOfSeq: 0 })
  const h = emptyHistory()
  for (const e of cached.events) {
    if (e?.seq == null) continue
    h.seqs.add(e.seq)
    h.visible.push(e)
  }
  h.visible.sort((a, b) => a.seq - b.seq)
  h.loaded = true
  state.history = h
  $('history-hint').textContent = t('history.offlineCache', { n: h.visible.length })
  renderHistory(true)
  return true
}

async function loadHistory(reset) {
  const id = state.current
  if (!id || state.history.loading) return
  const history = state.history
  history.loading = true
  if (reset) setSessionRecovery('loading')
  const moreBtn = $('history-more')
  if (moreBtn) moreBtn.classList.add('hidden')
  const payload = { sessionId: id, maxMessages: 60 }
  if (!reset && state.history.minSeq !== Infinity) payload.beforeSeq = state.history.minSeq

  let v
  try {
    v = await rpc('session.history', payload)
  } catch (e) {
    if (state.current !== id || state.history !== history) return
    history.loading = false
    if (e.message === 'AUTH') { authFailure(); return }
    if (restoreCachedHistory()) {
      setSessionRecovery('cached', e.message)
      toast(t('history.cacheFallback'), 'ok')
      return
    }
    const msg = e.message || t('err.dshError')
    setSessionRecovery('error', msg)
    const box = $('history')
    if (box && (reset || !state.history.visible.length)) {
      box.innerHTML = `<div class="empty"><div>${esc(t('history.loadFailed', { msg }))}</div><button type="button" class="mini-btn" id="btn-history-retry" style="margin-top:10px">${esc(t('history.retry'))}</button></div>`
      const retry = $('btn-history-retry')
      if (retry) retry.addEventListener('click', () => loadHistory(true))
    } else {
      toast(t('history.loadFailed', { msg }), 'err')
    }
    return
  }

  if (state.current !== id || state.history !== history) return
  hydrateSessionProjections(id, v.projections)
  history.loaded = true
  const incoming = v.events || []
  let added = 0
  if (reset) state.history.partialReasoning.clear()
  for (const entry of incoming) {
    const ev = entry?.event
    const seq = ev?.seq
    if (ev?.type === 'turn/start' || ev?.type === 'turn/end') noteSessionTurnTime(id, ev)
    applyReasoningStreamEvent(ev)
    if (seq == null || state.history.seqs.has(seq)) continue
    if (!shouldShowEvent(ev.type, ev)) continue     // chunk 与非用户上下文不保留
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
  history.loading = false
  setSessionRecovery('ready')
  renderSessionTitle(); renderSessionSub(); renderSessionCards()
  try {
    if (reset) renderHistory(true)
    else if (added) renderHistory(false, 'keep')
  } catch (e) {
    console.error('renderHistory failed', e)
  }
  if (moreBtn) moreBtn.classList.toggle('hidden', !state.history.hasMore)
  $('history-hint').textContent = state.history.visible.length ? t('history.count', { n: state.history.visible.length }) : ''
  scheduleHistoryCacheSave()
}

function insertLiveEvent(event) {
  const h = state.history
  const reasoningChanged = applyReasoningStreamEvent(event)
  if (event?.type === 'assistant/chunk' || event?.type === 'reasoning-chunks') {
    if (reasoningChanged) scheduleReasoningRender()
    return
  }
  const seq = event?.seq
  if (seq == null || h.seqs.has(seq) || !shouldShowEvent(event.type, event)) {
    if (reasoningChanged) scheduleReasoningRender()
    return
  }
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
    // 图片异步撑高历史区后，用户可能瞬间不再满足 nearBottom。新回复仍须
    // 扩展可见窗口，但保持当前阅读位置，不能等到重新进入会话才出现。
    h.renderEnd = h.visible.length
    renderHistory(false, 'fixed')
  }
  scheduleHistoryCacheSave()
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
  const reasoningHtml = partialReasoningHtml()
  if (!len && !reasoningHtml) {
    box.innerHTML = '<div class="empty">' + t('history.empty') + '</div>'
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
  box.innerHTML = filtered.slice(start, end).map(e => eventHtml(e, { toolNames })).join('') + reasoningHtml
  if (reset || mode === 'bottom') box.scrollTop = box.scrollHeight
  else if (mode === 'keep') box.scrollTop = Math.max(0, oldTop + (box.scrollHeight - oldH))
  else if (mode === 'fixed') box.scrollTop = oldTop
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
function messageSource(data) {
  const source = data?.source ?? data?.message?.source
  return source && typeof source === 'object' ? source : null
}
function isHumanUserMessage(event) {
  if (event?.type !== 'user/message') return false
  const source = messageSource(event.data || {})
  // Older DSH events may not carry source metadata; keep those visible for compatibility.
  return !source || source.kind === 'user'
}
function shouldShowEvent(type, event) {
  if (!INTERESTING_EVENTS.has(type)) return false
  if (type === 'user/message' && !isHumanUserMessage(event)) {
    const data = event?.data || {}
    const blocks = data.message?.content || data.content || []
    return systemReminderText(blocks).length > 0
  }
  return true
}
function systemReminderText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && typeof b === 'object' && b.type === 'text' && String(b.text ?? '').trimStart().startsWith('<system-reminder>'))
    .map(b => String(b.text ?? ''))
    .join('\n')
}
function eventHtml(entry, ctx = {}) {
  const seq = entry.seq
  const ev = entry.event || {}
  const data = ev.data || {}
  const type = ev.type || 'event'
  if (!shouldShowEvent(type, ev)) return ''
  let inner = ''

  if (type === 'user/message' || type === 'assistant/message') {
    const msg = data.message || {}
    const role = data.role || msg.role || (type.startsWith('user') ? 'user' : 'assistant')
    const blocks = msg.content || data.content || []
    const sysText = type === 'user/message' ? systemReminderText(blocks) : ''
    if (sysText) {
      inner = `<details class="event event-detail" data-seq="${seq}"><summary>${esc(t('event.systemReminder'))}</summary><pre>${esc(truncate(sysText, 4000))}</pre></details>`
    } else if (type === 'user/message' && !isHumanUserMessage(ev)) {
      return ''
    } else {
      inner = `<div class="msg ${esc(role)}" data-seq="${seq}"><div class="role">${esc(role === 'user' ? t('role.me') : t('role.dsh'))}</div>${blocks.map(blockHtml).join('')}</div>`
    }
  } else if (type === 'tool/call') {
    const name = data.name || data.toolName || t('tool.default')
    const step = (data.turn != null ? ` · turn ${data.turn}` : '') + (data.step != null ? `.${data.step}` : '')
    inner = `<details class="tool" data-seq="${seq}"><summary>🔧 ${esc(name)}<span class="tool-meta-inline">${esc(step)}</span></summary><pre>${esc(safeJson(data.arguments ?? data.args ?? data.input ?? data))}</pre></details>`
  } else if (type === 'tool/result') {
    const callId = data.callId || data.message?.source?.callId
    const name = (callId && ctx.toolNames?.get(callId)) || t('tool.result')
    const err = data.error || data.ok === false
    inner = `<details class="tool result ${err ? 'error' : ''}" data-seq="${seq}"><summary>📦 ${esc(name)}<span class="tool-meta-inline">${t('tool.result')}</span></summary><pre>${esc(truncate(safeJson(data.result ?? data.output ?? data.message ?? data), 4000))}</pre></details>`
  } else if (type === 'agent/status') {
    const running = !!data.running
    inner = `<div class="event" data-seq="${seq}">${running ? t('event.taskStart') : t('event.taskEnd')}</div>`
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
    case 'text': return `<div class="md">${window.mdToHtml ? window.mdToHtml(b.text ?? '') : esc(b.text ?? '')}</div>`
    case 'image': return `<img alt="${t('block.image')}" src="data:${esc(b.mediaType || 'image/png')};base64,${esc(b.data || '')}">`
    case 'thinking':
    case 'reasoning':
      return `<details class="tool"><summary>${t('block.thinking')}</summary><div class="tool-text">${esc(truncate(String(b.text ?? b.content ?? safeJson(b)), 6000))}</div></details>`
    case 'code': return `<pre>${esc(b.content ?? b.code ?? '')}</pre>`
    case 'tool-call':
      return `<details class="tool"><summary>🔧 ${esc(b.name || b.toolName || t('block.toolCall'))}</summary><pre>${esc(truncate(safeJson(b.arguments ?? b), 4000))}</pre></details>`
    case 'tool-result':
      return `<details class="tool result"><summary>📦 ${esc(b.name || b.toolName || t('block.toolResult'))}</summary><pre>${esc(truncate(safeJson(b.content ?? b), 4000))}</pre></details>`
    default: return `<details class="tool"><summary>${esc(t('block.unknown', { type: b.type || '?' }))}</summary><pre>${esc(truncate(safeJson(b), 2000))}</pre></details>`
  }
}

function safeJson(v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) }
  catch { return String(v) }
}
function truncate(s, n) { return String(s).length > n ? String(s).slice(0, n) + t('truncated') : s }

/* 会话卡片(goal/todo/subagents); 统计进顶栏 📊 弹窗 */
function statsHtml(s) {
  const stats = proj(s, 'sessionStats')
  const usage = proj(s, 'tokenUsage')
  const ctx = proj(s, 'contextPressure')
  const perms = proj(s, 'permissions')
  let html = ''
  if (stats) {
    const llmMin = stats.llmMs ? (stats.llmMs / 60000).toFixed(1) : null
    html += `<div class="card"><div class="card-title">${t('stats.roundTitle')}</div>
      <div class="card-row"><span class="k">${t('stats.turnsSteps')}</span><span class="v">${stats.turns ?? '—'} / ${stats.steps ?? '—'}</span></div>
      <div class="card-row"><span class="k">${t('stats.llmTime')}</span><span class="v">${llmMin ? llmMin + t('stats.minutes') : '—'}</span></div>
      ${usage ? `<div class="card-row"><span class="k">${t('stats.outputCache')}</span><span class="v">${fmtTokens(usage.outputTokens)} / ${fmtTokens(usage.cacheReadTokens)}</span></div>` : ''}
      ${ctx ? `<div class="card-row"><span class="k">${t('stats.ctxPressure')}</span><span class="v">${fmtTokens(ctx.pressureTokens)} / ${fmtTokens(ctx.contextWindow)}</span></div>` : ''}
      ${perms?.currentValue ? `<div class="card-row"><span class="k">${t('stats.permission')}</span><span class="v">${esc(perms.currentValue)}</span></div>` : ''}
    </div>`
  }
  return html || '<div class="empty">' + t('stats.empty') + '</div>'
}

let sessionCardsRenderGeneration = 0
async function renderSessionCards() {
  const renderGeneration = ++sessionCardsRenderGeneration
  const sessionId = state.current
  const s = state.byId.get(sessionId)
  const box = $('session-cards')
  const statsBox = $('stats-body')
  if (!s) { box.innerHTML = ''; if (statsBox) statsBox.innerHTML = ''; return }
  if (statsBox) { try { statsBox.innerHTML = statsHtml(s) } catch {} }
  box.innerHTML = ''
  const goal = goalOf(s)
  const todos = proj(s, 'todos')
  let html = ''

  if (goal && !isGoalTerminal(goal)) {
    html += `<div class="card"><div class="card-title">${t('goal.title')}</div>
      <div class="goal-obj">${esc(goal.objective || '')}</div>
      <div class="goal-phase">phase: ${esc(goal.phase || '?')} · revision ${goal.revision ?? '?'}</div>
      <div class="goal-actions">
        ${goal.phase === 'active' ? '<button class="mini-btn" data-goal="pause">' + t('goal.pause') + '</button>' : '<button class="mini-btn" data-goal="resume">' + t('goal.resume') + '</button>'}
        <button class="mini-btn" data-goal="complete">${t('goal.complete')}</button>
        <button class="mini-btn" data-goal="edit">${t('goal.edit')}</button>
        <button class="mini-btn" data-goal="clear">${t('goal.clear')}</button>
      </div></div>`
  }
  if (todos?.items?.length) {
    html += `<div class="card"><div class="card-title">${t('todos.title')}</div>${todos.items.map(t =>
      `<div><span class="pill ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : ''}">${esc(t.status || 'pending')}</span>${esc(t.content || '')}</div>`
    ).join('')}</div>`
  }
  box.innerHTML = html
  box.querySelectorAll('[data-goal]').forEach(btn =>
    btn.addEventListener('click', () => goalAction(btn.dataset.goal)))

  // 子代理
  const sub = await safeRpc('subagent.list', { parentSessionId: sessionId })
  if (renderGeneration !== sessionCardsRenderGeneration || state.current !== sessionId) return
  if (sub?.entries?.length) {
    const expanded = state.subagentExpandedSession === sessionId
    const toggleLabel = expanded ? t('subagent.collapse') : t('subagent.expand')
    const rows = sub.entries.map(e => {
      if (e.kind === 'diagnostic') return `<div class="card-row"><span class="k">${t('subagent.diagnostic')}</span><span class="v">${esc(e.reason)}</span></div>`
      const label = e.label || short(e.id)
      const running = e.activity === 'running'
      return `<div class="card-row"><span class="k">${running ? '▶ ' : ''}${esc(label)}</span><span class="v">${esc(e.mode)} ${running ? t('subagent.running') : ''}${e.mode === 'continuable' && running ? ` <button class="mini-btn" data-sub-interrupt="${esc(e.id)}">${t('subagent.interrupt')}</button>` : ''}</span></div>`
    }).join('')
    const subagentClosedIcon = 'M7 10l5 5 5-5'
    const subagentOpenIcon = 'M7 14l5-5 5 5'
    const subagentIcon = expanded ? subagentOpenIcon : subagentClosedIcon
    box.insertAdjacentHTML('beforeend', `<div class="card subagent-card"><button type="button" class="subagent-toggle" data-subagent-toggle aria-expanded="${expanded}" aria-label="${esc(toggleLabel)}" title="${esc(toggleLabel)}"><span class="card-title">${esc(t('subagent.count', { n: sub.entries.length }))}</span><span class="subagent-toggle-icon" aria-hidden="true"><morph-icon data-morph-state="${expanded ? 'open' : 'closed'}" data-morph-closed="${subagentClosedIcon}" data-morph-open="${subagentOpenIcon}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${subagentIcon}"/></svg></morph-icon></span></button><div class="subagent-list${expanded ? '' : ' hidden'}">${rows}</div></div>`)
    box.querySelector('[data-subagent-toggle]')?.addEventListener('click', () => {
      const icon = box.querySelector('[data-subagent-toggle] morph-icon')
      if (icon) icon.setAttribute('data-morph-state', expanded ? 'closed' : 'open')
      state.subagentExpandedSession = expanded ? '' : sessionId
      setTimeout(() => renderSessionCards(), 240)
    })
    box.querySelectorAll('[data-sub-interrupt]').forEach(btn =>
      btn.addEventListener('click', () => interruptSubagent(btn.dataset.subInterrupt)))
  }
}

function setGoalPhaseLocal(phase) {
  const s = state.byId.get(state.current)
  const p = s && proj(s, 'goal')
  const goal = p && typeof p === 'object' && p.goal && typeof p.goal === 'object' ? p.goal : p
  if (!goal) return
  goal.phase = phase
  renderSessions()
  renderSessionCards()
}

async function goalAction(kind) {
  const s = state.byId.get(state.current)
  const goal = goalOf(s)
  if (!goal) return toast(t('goal.none'))
  const ref = { id: goal.id, revision: goal.revision }
  if (kind === 'edit') return openGoalModal(goal)
  const map = { pause: 'goal.pause', resume: 'goal.resume', complete: 'goal.complete', clear: 'goal.clear' }
  const method = map[kind]
  if (!method) return
  if (kind === 'clear' && !confirm(t('goal.confirmClear'))) return
  if (kind === 'complete' && !confirm(t('goal.confirmComplete'))) return
  const result = await safeRpc(method, { sessionId: state.current, ref }, t('goal.actionFailed'))
  if (result == null) return
  if (kind === 'complete') setGoalPhaseLocal('complete')
  if (kind === 'clear') setGoalPhaseLocal('cleared')
  toast(t('goal.actionSubmitted'), 'ok')
  scheduleRefresh()
}

async function interruptSubagent(childId) {
  if (!confirm(t('subagent.confirmInterrupt'))) return
  const result = await safeRpc('subagent.interrupt', { parentSessionId: state.current, childSessionId: childId, mode: 'continuable' }, t('subagent.interruptFailed'))
  if (result == null) return
  toast(t('subagent.interruptSubmitted'), 'ok')
  setTimeout(renderSessionCards, 600)
}

/* ---------------- 发送 / 取消 / 快捷菜单 ---------------- */
async function runSlashCommand(text) {
  const clean = String(text || '').trim()
  if (!clean.startsWith('/') || !state.current) return false
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(20000)
      : undefined
    const res = await fetch(apiUrl('/remote/api/command'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() },
      body: JSON.stringify({ sessionId: state.current, line: clean }),
      ...(signal ? { signal } : {})
    })
    if (res.status === 401) { authFailure(); return true }
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    if (data?.ok === false) { toast(data.message || t('send.failed'), 'err'); return true }
    if (data?.ok && data.executed === true) { toast(t('send.commandExecuted'), 'ok'); return true }
  } catch (e) {
    console.error('slash command bridge failed', e)
  }
  return false
}

function bytesToBase64(bytes) {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)))
  }
  return btoa(binary)
}

function imageTypeOk(type) {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(type || '').toLowerCase())
}

function renderComposerImages() {
  const box = $('composer-attachments')
  if (!box) return
  document.body.classList.toggle('has-composer-images', state.composerImages.length > 0)
  box.classList.toggle('hidden', state.composerImages.length === 0)
  box.innerHTML = state.composerImages.map(item => `<div class="composer-attachment" title="${esc(item.file.name || t('block.image'))}">
    <img src="${esc(item.url)}" alt="${esc(item.file.name || t('block.image'))}">
    <button type="button" class="composer-attachment-remove" data-remove-image="${esc(item.id)}" aria-label="${esc(t('composer.removeImage'))}">×</button>
  </div>`).join('')
}

function clearComposerImages() {
  state.composerImages.splice(0).forEach(item => { try { URL.revokeObjectURL(item.url) } catch {} })
  renderComposerImages()
}

function removeComposerImage(id) {
  const index = state.composerImages.findIndex(item => item.id === id)
  if (index < 0) return
  const [item] = state.composerImages.splice(index, 1)
  try { URL.revokeObjectURL(item.url) } catch {}
  renderComposerImages()
  toast(t('composer.imageRemoved'), 'ok')
}

function addComposerImages(files) {
  const incoming = Array.from(files || []).filter(Boolean)
  if (!incoming.length) return
  if (state.composerImages.length + incoming.length > 20) {
    toast(t('composer.imageLimit', { count: 20 }), 'err')
    return
  }
  for (const file of incoming) {
    if (!imageTypeOk(file.type)) { toast(t('composer.imageUnsupported'), 'err'); continue }
    if (file.size > 3.5 * 1024 * 1024) { toast(t('composer.imageTooLarge', { size: '3.5 MB' }), 'err'); continue }
    state.composerImages.push({ id: uuid(), file, url: URL.createObjectURL(file) })
  }
  renderComposerImages()
  if (incoming.length) toast(t('composer.imageAdded'), 'ok')
}

function dataUrlToFile(dataUrl, name = 'photo.jpg') {
  const m = /^data:([^;,]+);base64,(.*)$/i.exec(String(dataUrl || ''))
  if (!m) return null
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0))
  return new File([bytes], name, { type: m[1] })
}

async function captureComposerImage(source) {
  if (!CAP?.isNativePlatform?.()) {
    const input = $(source === 'CAMERA' ? 'composer-camera-input' : 'composer-gallery-input')
    input?.click()
    return
  }
  const camera = CAP.Plugins?.Camera
  if (!camera?.getPhoto) { toast(t('scan.unsupported'), 'err'); return }
  try {
    if (source === 'CAMERA') {
      const perm = await camera.requestPermissions?.({ permissions: ['camera'] })
      if (perm && perm.camera !== 'granted') { toast(t('scan.permissionDenied'), 'err'); return }
    }
    const photo = await camera.getPhoto({
      resultType: 'dataUrl', source: source === 'PHOTOS' ? 'PHOTOS' : 'CAMERA', quality: 85,
      correctOrientation: true, saveToGallery: false
    })
    const file = dataUrlToFile(photo?.dataUrl, `dsh-image-${Date.now()}.${photo?.format || 'jpg'}`)
    if (file) addComposerImages([file])
  } catch (e) {
    const msg = String(e?.message || e || '')
    if (!/cancel/i.test(msg)) toast(t('composer.imageReadFailed', { msg }), 'err')
  }
}

function toggleComposerImageMenu() {
  const menu = $('composer-image-menu')
  if (!menu) return
  const show = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !show)
  $('btn-image')?.classList.toggle('active', show)
}

async function sendSessionText(text) {
  return sendSessionContent(text, [])
}

async function sendSessionContent(text, images) {
  const clean = String(text || '').trim()
  if ((!clean && !images.length) || !state.current) return false
  const sessionId = state.current
  if (images.length === 0 && clean && await runSlashCommand(clean)) {
    state.sessionActivity.add(sessionId)
    return true
  }
  const buttons = [$('btn-send'), $('btn-fs-send')].filter(Boolean)
  buttons.forEach(button => { button.disabled = true })
  state.pendingPrompts.add(sessionId)
  try {
    const content = [...await encodeComposerImagesFor(images)]
    if (clean) content.push({ type: 'text', text: clean })
    setSessionRecovery('resuming')
    const v = await safeRpc('session.prompt', {
      sessionId,
      mode: 'queue',
      content
    }, t('send.failed'))
    if (v?.accepted) {
      state.sessionActivity.add(sessionId)
      if (state.current === sessionId) {
        setSessionRecovery('ready')
        noteSessionTurnTime(sessionId, Date.now())
        renderSessions()
        toast(images.length ? t('send.imageSent') : (clean.startsWith('/') ? t('send.commandSent') : t('send.sent')), 'ok')
      }
      return true
    }
    if (v?.command?.text) {
      state.sessionActivity.add(sessionId)
      if (state.current === sessionId) toast(t('send.commandExecuted'), 'ok')
      return true
    }
    if (state.current === sessionId) setSessionRecovery('error')
    return false
  } catch (e) {
    if (state.current === sessionId) {
      setSessionRecovery('error', e?.message)
      toast(t('composer.imageReadFailed', { msg: e?.message || e }), 'err')
    }
    return false
  } finally {
    state.pendingPrompts.delete(sessionId)
    buttons.forEach(button => { button.disabled = false })
  }
}

async function encodeComposerImagesFor(images) {
  return Promise.all(images.map(async item => ({
    type: 'image', mediaType: item.file.type, data: bytesToBase64(new Uint8Array(await item.file.arrayBuffer())),
    ...(item.file.name ? { name: item.file.name } : {})
  })))
}

async function sendMessage() {
  const input = $('composer-input')
  const text = input.value.trim()
  const images = state.composerImages.slice()
  if ((!text && !images.length) || !state.current) return
  if (images.length && text.startsWith('/')) { toast(t('composer.imageSlashUnsupported'), 'err'); return }
  if (await sendSessionContent(text, images)) {
    input.value = ''
    autosize(input)
    clearComposerImages()
  }
}

function hideComposerMenu() {
  $('composer-menu').classList.add('hidden')
  $('btn-plus').classList.remove('active')
  $('permission-submenu')?.classList.add('hidden')
}

function toggleComposerMenu() {
  const menu = $('composer-menu')
  const show = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !show)
  $('btn-plus').classList.toggle('active', show)
  if (show && !state.models.loaded && !state.models.loading) loadSessionModels()
}

function isMobileDevice() {
  return !!CAP?.isNativePlatform?.() || /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent || '')
}
function mobileEnterAction() {
  return LS.get('mobileEnterAction', 'newline') === 'send' ? 'send' : 'newline'
}

async function loadSessionModels() {
  if (!state.current || state.models.loading) return
  state.models.loading = true
  renderModelMenu()
  try {
    const v = await rpc('session.models', { sessionId: state.current })
    state.models.groups = v.groups || []
    state.models.current = v.current || null
    state.models.failures = v.failures || []
    state.models.loaded = true
  } catch (e) {
    if (e.message === 'AUTH') { authFailure(); return }
    toast(t('models.loadFailed', { msg: e.message }), 'err')
  }
  state.models.loading = false
  renderModelMenu()
}

function renderModelMenu() {
  const box = $('menu-models')
  if (!box) return
  if (state.models.loading) { box.innerHTML = '<span>' + t('models.loading') + '</span>'; return }
  const groups = state.models.groups || []
  if (!groups.length) {
    box.innerHTML = '<span>' + ((state.models.failures || []).map(f => f.name + ' ' + t('models.unavailable')).join('；') || t('models.none')) + '</span>'
    const effortGroup = $('menu-effort-group')
    if (effortGroup) effortGroup.classList.add('hidden')
    return
  }
  const cur = state.models.current
  box.innerHTML = groups.map(g => `
    <div style="width:100%">
      <div class="model-provider">${esc(g.name || g.id)}</div>
      <div class="menu-chips">${(g.models || []).map(m => {
        const isCur = cur && cur.provider === g.id && cur.model === m.id
        return `<button class="model-chip ${isCur ? 'current' : ''}" data-model="${esc(m.id)}" data-provider="${esc(g.id)}">${esc(m.name || m.id)}</button>`
      }).join('')}</div>
    </div>`).join('')
  box.querySelectorAll('[data-model]').forEach(btn =>
    btn.addEventListener('click', () => selectSessionModel(btn.dataset.provider, btn.dataset.model)))
  renderEffortMenu()
}

function renderEffortMenu() {
  const group = $('menu-effort-group')
  const box = $('menu-efforts')
  if (!group || !box) return
  const cur = state.models.current
  const provider = (state.models.groups || []).find(g => g.id === cur?.provider)
  const model = (provider?.models || []).find(m => m.id === cur?.model)
  const { efforts, defaultEffort, custom } = reasoningEffortOptions(model)
  group.classList.toggle('hidden', !cur || !efforts.length)
  box.innerHTML = efforts.map(e => {
    const isCur = cur?.reasoningEffort === e.id || (!cur?.reasoningEffort && e.id === defaultEffort)
    return `<button class="menu-chip ${isCur ? 'current' : ''}" data-effort="${esc(e.id)}" title="${esc(e.description || '')}">${esc(e.name || e.id)}</button>`
  }).join('') + (custom ? `<span class="effort-hint">${esc(t('models.effortCustomHint'))}</span>` : '')
  box.querySelectorAll('[data-effort]').forEach(btn =>
    btn.addEventListener('click', () => selectSessionEffort(btn.dataset.effort)))
}

function reasoningEffortOptions(model) {
  const raw = Array.isArray(model?.reasoning?.efforts) && model.reasoning.efforts.length
    ? model.reasoning.efforts
    : (Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length ? model.reasoningEfforts : null)
  const names = {
    low: t('models.effortLow'), high: t('models.effortHigh'), max: t('models.effortMax'), off: t('models.effortOff')
  }
  if (raw) {
    return {
      efforts: raw.map(e => typeof e === 'string' ? { id: e, name: names[e] || e } : e),
      defaultEffort: model?.reasoning?.defaultEffort,
      custom: !model?.reasoning?.efforts
    }
  }
  return {
    efforts: ['low', 'high', 'max'].map(id => ({ id, name: names[id] })),
    defaultEffort: undefined,
    custom: true
  }
}

async function selectSessionEffort(effortId) {
  const cur = state.models.current
  if (!state.current || !cur) return
  const v = await safeRpc('session.selectModel', {
    sessionId: state.current, provider: cur.provider, model: cur.model, reasoningEffort: effortId
  }, t('models.effortFailed'))
  if (v?.selected) {
    state.models.current = v.selected
    renderEffortMenu()
    toast(t('models.effortSwitched', { effort: effortId }), 'ok')
  }
}

async function selectSessionModel(provider, modelId) {
  if (!state.current) return
  const group = (state.models.groups || []).find(g => g.id === provider)
  const model = (group?.models || []).find(m => m.id === modelId)
  const payload = { sessionId: state.current, provider, model: modelId }
  const effort = model?.reasoning?.defaultEffort || model?.reasoning?.efforts?.[0]?.id
  if (effort) payload.reasoningEffort = effort
  const v = await safeRpc('session.selectModel', payload, t('models.switchFailed'))
  if (v?.selected) {
    state.models.current = v.selected
    renderModelMenu()
    toast(t('models.switched', { model: v.selected.model }), 'ok')
  }
}

async function cancelSession() {
  if (!state.current) return
  if (!confirm(t('session.confirmStop'))) return
  const v = await safeRpc('session.cancel', { sessionId: state.current }, t('session.stopFailed'))
  if (v?.accepted) { setSessionRecovery('ready'); toast(t('session.stopRequested'), 'ok') }
}

let renamePendingSessionId = null
function renameSession(sessionId = state.current) {
  const session = state.byId.get(sessionId)
  if (!session) return
  renamePendingSessionId = sessionId
  $('rename-session-input').value = titleOf(session)
  $('modal-rename').classList.remove('hidden')
  setTimeout(() => { $('rename-session-input').focus(); $('rename-session-input').select() }, 40)
}
function closeRenameSession() {
  renamePendingSessionId = null
  $('modal-rename').classList.add('hidden')
}
async function confirmRenameSession() {
  const sessionId = renamePendingSessionId
  if (!sessionId) return
  const title = $('rename-session-input').value.trim()
  if (!title) return toast(t('session.renameEmpty'), 'err')
  const button = $('rename-confirm')
  button.disabled = true
  setSessionRecovery('resuming')
  try {
    const value = await safeRpc('session.rename', { sessionId, title }, t('session.renameFailed'))
    if (value == null) { setSessionRecovery('error'); return }
    if (value.title) applyProjection(sessionId, 'title', value.title, value.seq)
    closeRenameSession()
    setSessionRecovery('ready')
    toast(t('session.renamed'), 'ok')
    await refreshSessions()
  } finally {
    button.disabled = false
  }
}

async function newSession() {
  if (!state.token) { showView('view-settings'); return }
  if (!workspaceItems().length) await refreshWorkbench()
  const preferred = workspaceById(state.workspaceFilter)?.workspaceId || LS.get('lastNewSessionWorkspaceV1', '')
  renderNewSessionWorkspace(preferred)
  $('modal-new-session').classList.remove('hidden')
}
function renderNewSessionWorkspace(preferredId = '') {
  const items = workspaceItems()
  const select = $('new-session-workspace')
  if (!select) return
  const current = workspaceById(preferredId || select.value)?.workspaceId || items[0]?.workspaceId || ''
  select.innerHTML = workspaceOptionsHtml({ selected: current })
  select.disabled = !items.length
  syncCustomSelect(select)
  const workspace = workspaceById(select.value)
  $('new-session-workspace-name').textContent = workspace ? workspaceName(workspace) : ''
  $('new-session-workspace-path').textContent = workspace?.path || ''
  $('new-session-empty').classList.toggle('hidden', !!items.length)
  $('new-session-create').disabled = !workspace
}
function closeNewSessionModal() {
  $('modal-new-session').classList.add('hidden')
}
async function createSessionInWorkspace() {
  const workspaceId = $('new-session-workspace').value
  if (!workspaceById(workspaceId)) return toast(t('newSession.chooseWorkspace'), 'err')
  const button = $('new-session-create')
  button.disabled = true
  const v = await safeRpc('session.create', { workspaceId: workspaceId }, t('home.createFailed'))
  button.disabled = false
  if (!v?.sessionId) return
  state.workspaceFilter = workspaceId
  state.fs.workspaceId = workspaceId
  LS.set('workspaceFilterV1', workspaceId)
  LS.set('fsWorkspaceIdV1', workspaceId)
  LS.set('lastNewSessionWorkspaceV1', workspaceId)
  closeNewSessionModal()
  toast(t('home.created'), 'ok')
  await refreshSessions()
  openSession(v.sessionId)
}

let archivePendingSessionId = null
function archiveSession(sessionId) {
  const session = state.byId.get(sessionId)
  if (!session) return
  archivePendingSessionId = sessionId
  $('archive-session-title').textContent = titleOf(session)
  $('archive-session-workspace').textContent = sessionWorkspaceLabel(session)
  $('modal-archive').classList.remove('hidden')
}
function closeArchiveConfirm() {
  archivePendingSessionId = null
  $('modal-archive').classList.add('hidden')
}
async function confirmArchiveSession() {
  const sessionId = archivePendingSessionId
  if (!sessionId) return
  const button = $('archive-confirm')
  button.disabled = true
  try {
    const value = await safeRpc('workspace.archiveSession', { sessionId }, t('session.archiveFailed', { msg: '' }))
    if (value == null) return
    closeArchiveConfirm()
    toast(t('session.archived'), 'ok')
    await refreshSessions()
    if (state.current === sessionId) void closeSession()
  } finally {
    button.disabled = false
  }
}

let swipeTracking = null
let swipeSuppressClickUntil = 0
function closeRevealedSwipes(except = null) {
  document.querySelectorAll('.session-swipe.revealed').forEach(row => {
    if (row !== except) row.classList.remove('revealed')
  })
}
function bindSessionSwipe() {
  const containers = [$('session-list'), $('wb-panel')].filter(Boolean)
  for (const list of containers) list.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return
    const row = e.target.closest('[data-session-swipe]')
    if (!row) return
    closeRevealedSwipes(row)
    const touch = e.touches[0]
    swipeTracking = {
      row,
      startX: touch.clientX,
      startY: touch.clientY,
      offset: row.classList.contains('revealed') ? -92 : 0,
      axis: null
    }
  }, { passive: true })
  for (const list of containers) list.addEventListener('touchmove', e => {
    if (!swipeTracking || e.touches.length !== 1) return
    const touch = e.touches[0]
    const dx = touch.clientX - swipeTracking.startX
    const dy = touch.clientY - swipeTracking.startY
    if (!swipeTracking.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
      swipeTracking.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (swipeTracking.axis !== 'x') return
    e.preventDefault()
    const offset = Math.max(-92, Math.min(0, swipeTracking.offset + dx))
    swipeTracking.row.style.setProperty('--swipe-x', offset + 'px')
  }, { passive: false })
  for (const list of containers) list.addEventListener('touchend', () => {
    if (!swipeTracking) return
    if (swipeTracking.axis === 'x') {
      const row = swipeTracking.row
      const offset = parseFloat(row.style.getPropertyValue('--swipe-x') || swipeTracking.offset)
      row.classList.toggle('revealed', offset <= -46)
      row.style.removeProperty('--swipe-x')
      swipeSuppressClickUntil = Date.now() + 350
    }
    swipeTracking = null
  }, { passive: true })
  for (const list of containers) list.addEventListener('touchcancel', () => { swipeTracking = null }, { passive: true })
}

/* ---------------- 系统总览 / 待办 ---------------- */
function renderOverview() {
  const ring = $('overview-pulse-ring')
  if (!ring) return
  const checks = {
    // 独立网关页面默认走同源，此时 state.server 合法地为空；不能因此把
    // 已连接网关误报为离线。Capacitor 等非 HTTP 页面仍要求显式服务器。
    gateway: !!state.token && (!!state.server || /^https?:$/.test(location.protocol)),
    dsh: dshReachable(),
    mux: !!state.streamsOk?.mux,
    host: !!state.streamsOk?.host
  }
  const online = Object.values(checks).filter(Boolean).length
  const status = online === 4 ? 'nominal' : online > 0 ? 'degraded' : 'offline'
  const pulseCard = document.querySelector('.overview-pulse-card')
  if (pulseCard) {
    pulseCard.classList.remove('status-nominal', 'status-degraded', 'status-offline')
    pulseCard.classList.add('status-' + status)
  }
  ring.style.setProperty('--pulse-pct', `${online / 4 * 100}%`)
  $('overview-health').textContent = online === 4 ? t('overview.live') : online ? `${online}/4` : t('overview.offlineCore')
  $('overview-health-caption').textContent = online === 4 ? t('overview.allLinked') : online ? t('overview.components', { n: online }) : t('overview.offlineShort')
  $('overview-status').textContent = t(`overview.${status}`)
  $('overview-status-desc').textContent = t('overview.components', { n: online })
  for (const [name, ok] of Object.entries(checks)) {
    const item = document.querySelector(`[data-overview-link="${name}"]`)
    if (!item) continue
    item.classList.toggle('ok', ok)
    item.classList.toggle('off', !ok)
    const value = item.querySelector('b')
    if (value) value.textContent = ok ? t('overview.online') : t('overview.offlineShort')
  }

  const pending = [
    ...state.approvals.map(a => ({ kind: 'approval', item: a })),
    ...state.questions.map(q => ({ kind: 'question', item: q }))
  ]
  $('overview-attention-count').textContent = pending.length ? t('overview.pendingCount', { n: pending.length }) : '—'
  $('overview-attention-list').innerHTML = pending.length ? pending.slice(0, 3).map(({ kind, item }) => {
    const title = titleOf(state.byId.get(item.sessionId))
    if (kind === 'approval') return `<div class="overview-attention-item" data-overview-approval="${esc(item.approvalId)}">
      <span class="overview-item-mark">⌁</span><span class="overview-item-copy"><span class="overview-item-title">${esc(item.toolName || t('tool.default'))}</span><span class="overview-item-desc">${esc(item.reason || t('pending.noReason'))} · ${esc(title)}</span></span>
      <span class="overview-item-actions"><button type="button" class="mini-btn" data-overview-approve="1">${t('pending.allow')}</button><button type="button" class="mini-btn" data-overview-approve="0">${t('pending.reject')}</button></span>
    </div>`
    return `<button type="button" class="overview-attention-item question" data-overview-question="${esc(item.rpcId)}">
      <span class="overview-item-mark">?</span><span class="overview-item-copy"><span class="overview-item-title">${esc(item.questions?.[0]?.question || t('notify.questionTitle'))}</span><span class="overview-item-desc">${esc(title)}</span></span><span class="overview-item-arrow">›</span>
    </button>`
  }).join('') : `<div class="overview-empty">${t('pending.empty')}</div>`
  $('overview-attention-list').querySelectorAll('[data-overview-approve]').forEach(btn => {
    btn.addEventListener('click', () => approveApproval(btn.closest('[data-overview-approval]')?.dataset.overviewApproval || '', btn.dataset.overviewApprove === '1'))
  })
  $('overview-attention-list').querySelectorAll('[data-overview-question]').forEach(btn => {
    btn.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === btn.dataset.overviewQuestion)))
  })

  const topSessions = topLevelSessions()
  const running = topSessions.filter(s => s.running).length
  const sessions = topSessions.sort((a, b) => Number(b.running) - Number(a.running) || (sessionSortTime(b) - sessionSortTime(a))).slice(0, 4)
  const primary = $('overview-primary-action')
  if (primary) {
    let action = 'new'
    let label = t('overview.action.newSession')
    let sessionId = ''
    if (!state.token) {
      action = 'settings'
      label = t('overview.action.connect')
    } else if (online > 0 && online < 4) {
      action = 'refresh'
      label = t('overview.action.refresh')
    } else if (pending.length) {
      action = 'attention'
      label = t('overview.action.attention')
    } else if (sessions.length) {
      action = 'session'
      sessionId = sessions[0].sessionId
      label = t('overview.action.openSession')
    }
    primary.textContent = label
    primary.dataset.overviewAction = action
    primary.dataset.overviewSession = sessionId
    primary.disabled = status === 'offline' && action === 'refresh'
  }
  $('overview-dsh-version').textContent = state.hostInfo?.version || '—'
  $('overview-gateway-version').textContent = checks.gateway ? t('overview.online') : t('overview.offlineShort')
  $('overview-active-sessions').textContent = String(running)
  $('overview-connection-mode').textContent = state.token ? t(state.streamMode === 'poll' ? 'overview.poll' : 'overview.ws') : '—'
  $('overview-active-count').textContent = running ? t('overview.activeCount', { n: running }) : ''
  $('overview-session-list').innerHTML = sessions.length ? sessions.map(s => `<button type="button" class="overview-session-item ${s.running ? 'running' : ''}" data-overview-session="${esc(s.sessionId)}">
    <span class="overview-item-mark">${s.running ? '●' : '○'}</span><span class="overview-item-copy"><span class="overview-item-title">${esc(titleOf(s))}</span><span class="overview-item-desc">${s.running ? esc(t('sessions.running')) + ' · ' : ''}${esc(fmtTime(sessionSortTime(s)))}</span></span><span class="overview-item-arrow">›</span>
  </button>`).join('') : `<div class="overview-empty">${t('overview.noSession')}</div>`
  $('overview-session-list').querySelectorAll('[data-overview-session]').forEach(btn => btn.addEventListener('click', () => openSession(btn.dataset.overviewSession)))
}

function renderPending() {
  const list = $('pending-list')
  const items = [
    ...state.approvals.map(a => ({ kind: 'approval', a })),
    ...state.questions.map(q => ({ kind: 'question', q }))
  ]
  $('pending-count').textContent = items.length ? t('pending.count', { n: items.length }) : ''
  list.innerHTML = items.length ? items.map(it => {
    if (it.kind === 'approval') {
      const a = it.a
      const title = titleOf(state.byId.get(a.sessionId))
      return `<div class="pending-card approval" data-approval="${esc(a.approvalId)}">
        <div class="pc-title">${esc(t('pending.approvalTitle', { tool: a.toolName || t('tool.default') }))}</div>
        <div class="pc-desc">${esc(a.reason || t('pending.noReason'))}</div>
        <div class="pc-session">${esc(title)}</div>
        <div class="goal-actions"><button class="mini-btn" data-approve="1">${t('pending.allow')}</button><button class="mini-btn" data-approve="0">${t('pending.reject')}</button></div>
      </div>`
    }
    const q = it.q
    const title = titleOf(state.byId.get(q.sessionId))
    return `<div class="pending-card question" data-question="${esc(q.rpcId)}">
      <div class="pc-title">❓ ${esc(q.questions?.[0]?.question || t('notify.questionTitle'))}</div>
      <div class="pc-desc">${q.questions?.length > 1 ? t('pending.questionCount', { n: q.questions.length }) : ''}</div>
      <div class="pc-session">${esc(title)}</div>
      <div class="goal-actions"><button class="mini-btn" data-answer="1">${t('pending.answer')}</button></div>
    </div>`
  }).join('') : '<div class="empty">' + t('pending.empty') + '</div>'
  list.querySelectorAll('[data-approve]').forEach(btn => {
    const card = btn.closest('[data-approval]')
    btn.addEventListener('click', () => approveApproval(card?.dataset.approval || '', btn.dataset.approve === '1'))
  })
  list.querySelectorAll('[data-question]').forEach(btn =>
    btn.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === btn.dataset.question))))
  updatePendingBadge()
  renderOverview()
}

async function approveApproval(id, allow) {
  const a = state.approvals.find(x => x.approvalId === id)
  if (!a) return
  let ok
  try {
    ok = await respond(a.rpcId, { sessionId: a.sessionId, approvalId: a.approvalId, outcome: allow ? 'allowed-once' : 'rejected' })
  } catch (e) {
    if (e.message === 'AUTH') authFailure()
    else toast(t('pending.submitFailed', { msg: e.message || t('fs.networkError') }), 'err')
    return
  }
  toast(ok ? (allow ? t('pending.allowed') : t('pending.rejected')) : t('pending.stale'), ok ? 'ok' : 'err')
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
      <textarea rows="2" placeholder="${t('question.customPlaceholder')}" data-qcustom="${i}"></textarea>
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
  if (!answers.length) return toast(t('question.needAnswer'), 'err')
  let ok
  try {
    ok = await respond(q.rpcId, { sessionId: q.sessionId, answer: { answers } })
  } catch (e) {
    if (e.message === 'AUTH') authFailure()
    else toast(t('question.submitFailed', { msg: e.message || t('fs.networkError') }), 'err')
    return
  }
  if (ok) { toast(t('question.submitted'), 'ok'); $('modal-question').classList.add('hidden'); state.questions = state.questions.filter(x => x.rpcId !== q.rpcId); renderPending() }
  else toast(t('question.stale'), 'err')
}

/* ---------------- 后台任务 ---------------- */
function queuePreview(item) {
  const blocks = item?.message?.content || item?.content || []
  const text = Array.isArray(blocks)
    ? blocks.filter(block => block?.type === 'text').map(block => String(block.text || '')).join(' ').trim()
    : ''
  return text || (Array.isArray(blocks) && blocks.some(block => block?.type === 'image') ? t('queue.image') : '…')
}
async function steerQueueItem(itemId) {
  const sessionId = state.current
  const key = `${sessionId}:${itemId}`
  const s = state.byId.get(sessionId)
  if (!sessionId || !s?.running || state.queueSteering[key]) return
  state.queueSteering[key] = true
  renderQueue()
  try {
    const v = await safeRpc('session.updateQueue', { sessionId, itemId, action: { kind: 'steer' } }, t('queue.steerFailed', { msg: '' }).replace(/：$/, '').replace(/: $/, ''))
    if (v?.accepted) toast(t('queue.steerSubmitted'), 'ok')
  } finally {
    delete state.queueSteering[key]
    renderQueue()
  }
}
function renderQueue() {
  const s = state.byId.get(state.current)
  if (!s) return
  const items = (state.queues[state.current] || []).filter(item => item?.placement === 'queued')
  const box = $('queue-dock')
  if (box) {
    box.classList.toggle('hidden', !items.length)
    box.innerHTML = items.length ? `<div class="queue-dock-head"><span>⌁</span><span>${esc(t('queue.title'))} · ${items.length}</span></div><div class="queue-dock-list">${items.map(item => {
      const key = `${state.current}:${item.id}`
      const busy = !!state.queueSteering[key]
      return `<div class="queue-dock-item"><span class="queue-dock-preview" title="${esc(queuePreview(item))}">${esc(queuePreview(item))}</span><button type="button" class="mini-btn queue-dock-action" data-queue-steer="${esc(item.id)}" title="${esc(s.running ? t('queue.steer') : t('queue.steerUnavailable'))}" ${s.running && !busy ? '' : 'disabled'}>${busy ? '…' : esc(t('queue.steer'))}</button></div>`
    }).join('')}</div>` : ''
    box.querySelectorAll('[data-queue-steer]').forEach(button => {
      button.addEventListener('click', () => steerQueueItem(button.dataset.queueSteer))
    })
  }
  updateCancelBtn()
  updateSessionStatus()
  // 队列数量在会话列表已显示; 详情页不重复大 UI
  $('history-hint').textContent = items.length ? t('history.queueAndCount', { q: items.length, n: state.history.visible.length }) : t('history.countOnly', { n: state.history.visible.length })
  renderSessions()
}

function renderJobs() {
  const box = $('jobs-list')
  const all = Object.entries(state.jobs).filter(([, jobs]) => jobs?.length)
  if (!all.length) { box.innerHTML = '<div class="empty">' + t('jobs.empty') + '</div>'; return }
  box.innerHTML = all.flatMap(([sid, jobs]) => jobs.map(j => {
    const title = titleOf(state.byId.get(sid))
    return `<div class="job-card">
      <div class="job-name">${esc(j.label || j.id)} <span class="pill ${j.status === 'running' ? 'active' : 'done'}">${esc(j.status)}</span></div>
      <div class="job-state">${esc(j.kind)} · ${esc(title)} · ${j.startedAt ? fmtTime(j.startedAt) : ''}${j.detail ? ' · ' + esc(j.detail) : ''}</div>
    </div>`
  }).join(''))
}

/* ---------------- 文件传输 ---------------- */
function fsHeaders() {
  return {
    authorization: 'Bearer ' + state.token,
    'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web',
    ...clientIdHeaders()
  }
}

function fsJoin(dir, name) {
  const meta = fsPathMeta(dir)
  if (!meta.value) return String(name || '')
  return meta.value.endsWith(meta.separator) ? meta.value + name : meta.value + meta.separator + name
}

function fsParent(p) {
  const meta = fsPathMeta(p)
  if (!meta.value) return ''
  if (meta.root && fsPathEqual(meta.value, meta.root)) return meta.root
  const idx = meta.value.lastIndexOf(meta.separator)
  if (idx < 0) return meta.root || ''
  const parent = meta.value.slice(0, idx)
  return meta.root && parent.length < meta.root.length ? meta.root : (parent || meta.root)
}

function fsPathMeta(input) {
  const source = String(input || '').trim()
  const windows = /^[A-Za-z]:(?:[\\/]|$)/.test(source) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(source) || source.includes('\\')
  if (!windows) {
    let value = source.replace(/\/+/g, '/')
    const root = value.startsWith('/') ? '/' : ''
    if (root && value.length > root.length) value = value.replace(/\/+$/, '')
    return { value, root, separator: '/', windows: false }
  }
  let value = source.replace(/\//g, '\\')
  const unc = /^\\{2,}/.test(value)
  value = unc
    ? '\\\\' + value.replace(/^\\+/, '').replace(/\\+/g, '\\')
    : value.replace(/\\+/g, '\\')
  let root = ''
  if (unc) {
    const parts = value.slice(2).split('\\').filter(Boolean)
    root = parts.length >= 2 ? `\\\\${parts[0]}\\${parts[1]}` : value
  } else {
    const drive = /^([A-Za-z]:)/.exec(value)
    if (drive) {
      root = drive[1] + '\\'
      if (value === drive[1]) value = root
    }
  }
  if (root && value.length > root.length) value = value.replace(/\\+$/, '')
  return { value, root, separator: '\\', windows: true }
}

function fsPathKey(value) {
  const meta = fsPathMeta(value)
  return meta.windows ? meta.value.toLowerCase() : meta.value
}

function fsPathEqual(left, right) {
  return fsPathKey(left) === fsPathKey(right)
}

function fsPathInside(candidate, root) {
  const child = fsPathMeta(candidate)
  const boundary = fsPathMeta(root)
  if (!child.value || !boundary.value || child.windows !== boundary.windows) return false
  const childKey = child.windows ? child.value.toLowerCase() : child.value
  const rootKey = boundary.windows ? boundary.value.toLowerCase() : boundary.value
  if (childKey === rootKey) return true
  const prefix = rootKey.endsWith(boundary.separator) ? rootKey : rootKey + boundary.separator
  return childKey.startsWith(prefix)
}

function resetFsForServer() {
  state.fs.path = null
  state.fs.initial = null
  state.fs.loaded = false
  state.fs.upload = null
  state.fs.preview = null
  state.fs.roots = []
  state.fs.rootIndex = 0
  state.fs.workspaceId = ''
  LS.del('fsWorkspaceIdV1')
}

const FS_PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.py', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
  '.ini', '.conf', '.env', '.sh', '.bash', '.zsh', '.fish', '.sql', '.java', '.kt',
  '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.vue',
  '.svelte', '.gradle', '.properties', '.gitignore', '.dockerfile'
])
function fsPreviewExtension(name) {
  const lower = String(name || '').toLowerCase()
  if (lower === 'dockerfile') return '.dockerfile'
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}
function fsCanPreview(name, size) {
  return Number(size) <= 1024 * 1024 && FS_PREVIEW_EXTENSIONS.has(fsPreviewExtension(name))
}
function openWorkspaceFiles(workspaceId) {
  const workspace = workspaceById(workspaceId)
  if (!workspace) return
  state.fs.workspaceId = workspace.workspaceId
  state.fs.loaded = false
  LS.set('fsWorkspaceIdV1', workspace.workspaceId)
  renderWorkspaceNavigation()
  showView('view-files')
}

async function openWorkspaceModal() {
  if (!state.token) { toast(t('fs.noTokenToast'), 'err'); showView('view-settings'); return }
  if (!state.fs.path) await loadFs(null, { silent: true })
  $('workspace-parent-path').textContent = state.fs.path || '~'
  $('workspace-name').value = ''
  $('modal-workspace').classList.remove('hidden')
  setTimeout(() => $('workspace-name').focus(), 50)
}
function closeWorkspaceModal() { $('modal-workspace').classList.add('hidden') }
async function createWorkspace() {
  if (createWorkspace.busy) return
  const name = $('workspace-name').value.trim()
  if (!name) { toast(t('workspace.nameRequired'), 'err'); $('workspace-name').focus(); return }
  createWorkspace.busy = true
  const parent = state.fs.path || ''
  const button = $('workspace-create')
  button.disabled = true
  try {
    const res = await fetch(fsApiUrl('/mkdir', { path: parent, name }), { method: 'POST', headers: fsHeaders() })
    if (res.status === 401) { fsAuthError(401); return }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = data.error === 'exists' ? t('workspace.exists') : data.error === 'bad-name' ? t('workspace.invalidName') : data.error || ('HTTP ' + res.status)
      throw new Error(msg)
    }
    closeWorkspaceModal()
    await loadFs(parent || null, { silent: true })
    let workspace = null
    try {
      const created = await rpc('workspace.create', { path: data.path })
      workspace = created?.workspace || null
    } catch {}
    const sessionPayload = workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : { cwd: data.path }
    const v = await safeRpc('session.create', sessionPayload, t('home.createFailed'))
    if (workspace?.workspaceId) {
      state.workspaceFilter = workspace.workspaceId
      state.fs.workspaceId = workspace.workspaceId
      LS.set('workspaceFilterV1', workspace.workspaceId)
      LS.set('fsWorkspaceIdV1', workspace.workspaceId)
    }
    await refreshSessions()
    if (v?.sessionId) {
      toast(t('workspace.created'), 'ok')
      openSession(v.sessionId)
    } else {
      toast(t('workspace.createdNoSession'), 'ok')
    }
  } catch (e) {
    if (e.message === 'AUTH') fsAuthError(401)
    else toast(t('workspace.createFailed', { msg: e.message || t('fs.networkError') }), 'err')
  } finally {
    createWorkspace.busy = false
    button.disabled = false
  }
}

function fsApiUrl(sub, params = {}) {
  const u = new URL(apiUrl('/fs' + sub), location.href)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, v)
  }
  return u.href
}

function fsAuthError(status) {
  if (status === 401) authFailure()
}

async function loadFs(dir, { silent = false, resetRoot = false } = {}) {
  if (!state.token) {
    $('fs-path').textContent = t('fs.noToken')
    $('fs-list').innerHTML = '<div class="empty">' + t('fs.goSettings') + '</div>'
    return
  }
  if (resetRoot) { state.fs.initial = null; state.fs.path = null }
  const target = dir ?? state.fs.path ?? ''
  if (!silent) {
    $('fs-list').innerHTML = '<div class="empty">' + t('fs.loading') + '</div>'
    $('fs-path').textContent = target ? '…' + target.slice(-40) : t('fs.loading')
  }
  try {
    const res = await fetch(fsApiUrl('/list', target ? { path: target } : {}), { headers: fsHeaders() })
    if (res.status === 401) { fsAuthError(401); return }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !Array.isArray(data.entries)) throw new Error(data.error === 'not-found' ? t('fs.notFound') : data.error === 'forbidden' ? t('fs.forbidden') : data.error || ('HTTP ' + res.status))
    state.fs.path = data.path
    if (!state.fs.initial) state.fs.initial = data.path
    if (Array.isArray(data.roots) && data.roots.length) state.fs.roots = data.roots.map(value => String(value || '')).filter(Boolean)
    if (!state.fs.roots.length) state.fs.roots = [data.path]
    if (!state.fs.workspaceId) {
      const rootIndex = state.fs.roots.findIndex(root => fsPathInside(data.path, root))
      if (rootIndex >= 0) state.fs.rootIndex = rootIndex
    }
    state.fs.loaded = true
    renderWorkspaceNavigation()
    renderFs(data)
  } catch (e) {
    if (e.message === 'AUTH') return
    $('fs-path').textContent = target || '~'
    $('fs-list').innerHTML = `<div class="empty">${esc(t('fs.loadFailed', { msg: e.message || t('fs.networkError') }))}</div>`
    if (!silent) toast(t('fs.loadFailedToast', { msg: e.message }), 'err')
  }
}

function renderFs(data) {
  $('fs-path').textContent = data.path || '~'
  const list = $('fs-list')
  if (!data.entries.length) {
    list.innerHTML = '<div class="empty">' + t('fs.emptyDir') + '</div>'
    return
  }
  list.innerHTML = data.entries.map(e => {
    const isDir = e.type === 'dir'
    const preview = !isDir && fsCanPreview(e.name, e.size)
    return `<div class="fs-row" data-name="${esc(e.name)}" data-type="${esc(e.type)}" data-size="${Number(e.size) || 0}">
      <span class="fs-ico">${fsIconSvg(isDir)}</span>
      <span class="fs-meta">
        <span class="fs-name">${esc(e.name)}</span>
        <span class="fs-sub">${isDir ? t('fs.dir') : fmtSize(e.size)} · ${fmtFullTime(e.mtimeMs)}</span>
      </span>
      <span class="fs-arrow">${isDir || preview ? '›' : '↓'}</span>
    </div>`
  }).join('')
  list.querySelectorAll('.fs-row').forEach(row =>
    row.addEventListener('click', () => fsOpenEntry(row.dataset.name, row.dataset.type, Number(row.dataset.size))))
}

function fsIconSvg(isDir) {
  return isDir
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5h6l2 2H20a1 1 0 0 1 1 1v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a1 1 0 0 1 .5-1Z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5v4h4M8 13h8M8 16h6"/></svg>'
}

function fsOpenEntry(name, type, size = 0) {
  if (!name) return
  const p = fsJoin(state.fs.path, name)
  if (type === 'dir') return loadFs(p)
  if (fsCanPreview(name, size)) return openFsPreview(p, name)
  downloadFsFile(name)
}

function downloadFsFile(name) {
  const p = fsJoin(state.fs.path, name)
  downloadFsPath(p, name)
}

function downloadFsPath(p, name) {
  const url = fsApiUrl('/file', { path: p })
  if (CAP?.isNativePlatform?.()) {
    if (window.NativeFile?.downloadToDownloads) {
      try {
        window.NativeFile.downloadToDownloads(url, name, state.token)
        toast(t('fs.downloadStarted'), 'ok')
      } catch (e) {
        toast(t('fs.downloadFailed', { msg: e?.message || '' }), 'err')
      }
      return
    }
    toast(t('fs.downloadUnsupported'), 'err')
    return
  }
  // 浏览器控制台: <a download> + ?token= 兜底(主通道仍是 Bearer 头)
  const a = document.createElement('a')
  const u = new URL(url)
  u.searchParams.set('token', state.token)
  a.href = u.href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

let fsPreviewGeneration = 0
async function openFsPreview(pathValue, name) {
  const generation = ++fsPreviewGeneration
  state.fs.preview = { path: pathValue, name, extension: fsPreviewExtension(name), content: '' }
  $('file-preview-title').textContent = name
  $('file-preview-path').textContent = pathValue
  $('file-preview-loading').textContent = t('fs.previewLoading')
  $('file-preview-loading').classList.remove('hidden')
  $('file-preview-source').classList.add('hidden')
  $('file-preview-rendered').classList.add('hidden')
  $('file-preview-tabs').classList.add('hidden')
  $('modal-file-preview').classList.remove('hidden')
  try {
    const res = await fetch(fsApiUrl('/preview', { path: pathValue }), { headers: fsHeaders() })
    if (res.status === 401) { closeFsPreview(); fsAuthError(401); return }
    const data = await res.json().catch(() => ({}))
    if (generation !== fsPreviewGeneration) return
    if (!res.ok) {
      const message = data.error === 'preview-too-large' ? t('fs.previewTooLarge')
        : (data.error === 'preview-unsupported' || data.error === 'preview-binary') ? t('fs.previewUnsupported')
          : t('fs.previewFailed', { msg: data.error || ('HTTP ' + res.status) })
      throw new Error(message)
    }
    state.fs.preview = data
    $('file-preview-loading').classList.add('hidden')
    $('file-preview-source').textContent = data.content || ''
    const markdown = data.extension === '.md' || data.extension === '.markdown'
    $('file-preview-tabs').classList.toggle('hidden', !markdown)
    if (markdown) $('file-preview-rendered').innerHTML = window.mdToHtml(data.content || '')
    showFsPreviewMode(markdown ? 'rendered' : 'source')
  } catch (e) {
    if (generation !== fsPreviewGeneration) return
    $('file-preview-loading').textContent = e.message || t('fs.previewFailed', { msg: t('fs.networkError') })
  }
}
function showFsPreviewMode(mode) {
  const rendered = mode === 'rendered' && !($('file-preview-tabs').classList.contains('hidden'))
  $('file-preview-source').classList.toggle('hidden', rendered)
  $('file-preview-rendered').classList.toggle('hidden', !rendered)
  $('file-preview-source-tab').classList.toggle('current', !rendered)
  $('file-preview-rendered-tab').classList.toggle('current', rendered)
}
function closeFsPreview() {
  fsPreviewGeneration++
  state.fs.preview = null
  $('modal-file-preview').classList.add('hidden')
}

function showFsProgress(pct, loaded, total) {
  $('fs-progress').classList.remove('hidden')
  $('fs-progress-bar').style.width = Math.max(2, Math.min(100, pct)) + '%'
  $('fs-progress-text').textContent = `${pct}% · ${fmtSize(loaded)} / ${fmtSize(total)}`
}

function setFsProgressText(text) {
  $('fs-progress-text').textContent = text
}

function hideFsProgress() {
  $('fs-progress').classList.add('hidden')
  $('fs-progress-bar').style.width = '0%'
}

function setFsButtons(show, paused = false) {
  const pauseBtn = $('fs-pause-btn')
  const cancelBtn = $('fs-cancel-btn')
  if (!pauseBtn || !cancelBtn) return
  pauseBtn.classList.toggle('hidden', !show)
  cancelBtn.classList.toggle('hidden', !show)
  if (show) pauseBtn.textContent = paused ? t('fs.resume') : t('fs.pause')
}

function pauseFsUpload() {
  const up = state.fs.upload
  if (!up) return
  if (!up.active) {
    if (up.paused) resumeFsUpload()
    return
  }
  up.pauseRequested = true
  try { up.xhr?.abort() } catch {}
}

function resumeFsUpload() {
  const up = state.fs.upload
  if (!up || !up.file) return
  up.paused = false
  runFsUpload(up)
}

async function cancelFsUpload() {
  const up = state.fs.upload
  if (!up) return
  up.cancelled = true
  try { up.xhr?.abort() } catch {}
  try {
    await fetch(fsApiUrl('/upload-control', { path: up.path, name: up.name, session: up.session, action: 'cancel' }), {
      method: 'POST', headers: fsHeaders()
    })
  } catch {}
  state.fs.upload = null
  hideFsProgress()
  setFsButtons(false)
  toast(t('fs.uploadCancelled'))
}

const FS_CHUNK_SIZE = 4 * 1024 * 1024 // 4MB/块, 断线后重选同一文件自动续传

/** 把文件 [start,end) 逐块喂给 hasher(续传时补齐已传前缀); 期间可被暂停打断 */
async function hashFsRange(file, hasher, start, end, up) {
  const step = FS_CHUNK_SIZE
  for (let off = start; off < end; off += step) {
    const buf = await file.slice(off, Math.min(off + step, end)).arrayBuffer()
    if (up?.pauseRequested) {
      const err = new Error(t('fs.pausedErr')); err.code = 'PAUSED'; throw err
    }
    hasher.update(new Uint8Array(buf))
  }
}

function uploadFsFile(file) {
  if (!file) return
  if (!state.token) { toast(t('fs.noTokenToast'), 'err'); showView('view-settings'); return }
  if (file.size > 2 * 1024 * 1024 * 1024) { toast(t('fs.tooLarge'), 'err'); return }
  if (state.fs.upload?.active) { toast(t('fs.uploadBusy'), 'err'); return }

  const prev = state.fs.upload
  if (prev && prev.path === state.fs.path && prev.name === file.name && prev.size === file.size) {
    prev.file = file
    runFsUpload(prev)
    return
  }
  // 换传别的文件: 顺手清掉旧任务的服务端分片, 不残留隐藏 .part
  if (prev) {
    prev.cancelled = true
    try { prev.xhr?.abort() } catch {}
    try {
      fetch(fsApiUrl('/upload-control', { path: prev.path, name: prev.name, session: prev.session, action: 'cancel' }), {
        method: 'POST', headers: fsHeaders()
      })
    } catch {}
  }
  const up = {
    session: uuid(), path: state.fs.path, name: file.name, size: file.size,
    offset: 0, file, xhr: null, active: false, paused: false, cancelled: false
  }
  state.fs.upload = up
  runFsUpload(up)
}

async function runFsUpload(up) {
  if (!up || !up.file) return
  up.active = true
  up.cancelled = false
  up.paused = false
  up.pauseRequested = false
  setFsButtons(true, false)

  const uploadChunk = (params, blob) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    up.xhr = xhr
    xhr.open('POST', fsApiUrl('/upload', params))
    xhr.setRequestHeader('authorization', 'Bearer ' + state.token)
    xhr.setRequestHeader('x-dsh-remote-client', CAP?.isNativePlatform?.() ? 'app' : 'web')
    if (CLIENT_ID) xhr.setRequestHeader('x-dsh-remote-client-id', CLIENT_ID)
    if (params.offset != null) xhr.setRequestHeader('Upload-Offset', String(params.offset))
    if (params.size != null) xhr.setRequestHeader('Upload-Length', String(params.size))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const loaded = up.offset + Math.min(e.loaded, e.total)
        showFsProgress(Math.round(loaded / Math.max(1, up.size) * 100), loaded, up.size)
      }
    }
    xhr.onload = () => {
      if (up.xhr === xhr) up.xhr = null
      let json = {}
      try { json = JSON.parse(xhr.responseText || '{}') } catch {}
      resolve({ status: xhr.status, json })
    }
    xhr.onerror = () => { if (up.xhr === xhr) up.xhr = null; reject(new Error(t('fs.networkError'))) }
    xhr.upload.onerror = () => { if (up.xhr === xhr) up.xhr = null; reject(new Error(t('fs.networkInterrupt'))) }
    xhr.onabort = () => {
      if (up.xhr === xhr) up.xhr = null
      const err = new Error(t(up.cancelled ? 'fs.cancelledErr' : 'fs.pausedErr'))
      err.code = up.cancelled ? 'CANCELLED' : 'PAUSED'
      reject(err)
    }
    xhr.send(blob)
  })

  const probe = async () => {
    const res = await fetch(fsApiUrl('/upload-probe', { path: up.path, name: up.name, session: up.session, size: String(up.size) }), { headers: fsHeaders() })
    if (res.status === 401) { fsAuthError(401); return null }
    const json = await res.json().catch(() => ({}))
    if (json.ok) up.offset = json.partialSize || 0
    return json
  }

  let overwrite = false
  let wasResumed = false
  let hasher = new SHA256()
  try {
    const info = await probe()
    if (info === null || up.cancelled) return
    if (info.partialSize > 0) wasResumed = true
    if (info.targetExists && info.targetSize === up.size && !overwrite) {
      if (!confirm(t('fs.confirmOverwrite'))) { state.fs.upload = null; hideFsProgress(); setFsButtons(false); return }
      overwrite = true
    }
    if (up.offset > 0) await hashFsRange(up.file, hasher, 0, up.offset, up)
    showFsProgress(Math.round(up.offset / Math.max(1, up.size) * 100), up.offset, up.size)

    while (up.offset < up.size) {
      if (up.cancelled) return
      const end = Math.min(up.offset + FS_CHUNK_SIZE, up.size)
      const blob = up.file.slice(up.offset, end)
      const before = hasher.clone()
      const chunkBytes = new Uint8Array(await blob.arrayBuffer())
      if (up.pauseRequested) {
        const err = new Error(t('fs.pausedErr')); err.code = 'PAUSED'; throw err
      }
      hasher.update(chunkBytes)
      const isLast = end >= up.size
      const params = { path: up.path, name: up.name, session: up.session, offset: String(up.offset), size: String(up.size) }
      if (isLast) { params.finish = '1'; params.sha256 = hasher.hex() }
      if (overwrite) params.overwrite = '1'
      const r = await uploadChunk(params, blob)
      if (r.status === 401) { fsAuthError(401); return }
      if (r.status === 200 && r.json.offset != null) { up.offset = r.json.offset; continue }
      if (r.status === 201) {
        const expected = params.sha256 || hasher.hex()
        if (r.json.sha256 && r.json.sha256 !== expected) {
          const err = new Error(t('fs.checksumMismatch')); err.checksum = true
          throw err
        }
        hideFsProgress()
        setFsButtons(false)
        state.fs.upload = null
        toast(t('fs.uploadDone', { name: up.name, resumed: wasResumed ? t('fs.resumedSuffix') : '' }), 'ok')
        loadFs()
        return
      }
      if (r.status === 409 && r.json.error === 'conflict') {
        hasher = before // 这段数据没被写入, 回退哈希状态后带 overwrite=1 重发
        if (!confirm(t('fs.confirmOverwrite2'))) { state.fs.upload = null; hideFsProgress(); setFsButtons(false); return }
        overwrite = true
        continue
      }
      if (r.status === 409 && r.json.error === 'offset-mismatch') {
        hasher = before
        await probe()
        continue
      }
      if (r.status === 422 && r.json.error === 'checksum-mismatch') {
        const err = new Error(t('fs.checksumCleared'))
        err.checksum = true
        throw err
      }
      throw new Error(r.json.error || ('HTTP ' + r.status))
    }

    // offset 已到文件末尾但还没落位(0 字节文件 / 续传时最后一块已完成而 rename 被中断):
    // 发一个空 finish 块完成收尾, 同时带上全量 SHA-256 校验
    if (up.offset >= up.size) {
      const expected = hasher.hex()
      const params = { path: up.path, name: up.name, session: up.session, offset: String(up.offset), size: String(up.size), finish: '1', sha256: expected }
      if (overwrite) params.overwrite = '1'
      const r = await uploadChunk(params, new Blob([]))
      if (r.status === 401) { fsAuthError(401); return }
      if (r.status === 409 && r.json.error === 'conflict') {
        if (!confirm(t('fs.confirmOverwrite2'))) { state.fs.upload = null; hideFsProgress(); setFsButtons(false); return }
        params.overwrite = '1'
        return runFsUpload(up) // 目标冲突未写入, 重新走 probe + 空 finish
      }
      if (r.status === 422 && r.json.error === 'checksum-mismatch') {
        const err = new Error(t('fs.checksumCleared'))
        err.checksum = true
        throw err
      }
      if (r.status !== 201) throw new Error(r.json.error || ('HTTP ' + r.status))
      if (r.json.sha256 && r.json.sha256 !== expected) {
        const err = new Error(t('fs.checksumMismatch')); err.checksum = true
        throw err
      }
      hideFsProgress()
      setFsButtons(false)
      state.fs.upload = null
      toast(t('fs.uploadDone', { name: up.name, resumed: wasResumed ? t('fs.resumedSuffix') : '' }), 'ok')
      loadFs()
      return
    }

    hideFsProgress()
    setFsButtons(false)
  } catch (e) {
    up.active = false
    if (up.cancelled || e?.code === 'CANCELLED') return
    if (e?.code === 'PAUSED') {
      up.paused = true
      setFsButtons(true, true)
      setFsProgressText(t('fs.pausedPct', { pct: Math.round(up.offset / Math.max(1, up.size) * 100) }))
      toast(t('fs.pausedToast'), 'ok')
      return
    }
    if (e?.checksum) {
      // 坏分片保留只会反复校验失败: 服务端删掉, 下一次「继续」从 0 完整重传
      up.paused = true
      up.offset = 0
      try {
        await fetch(fsApiUrl('/upload-control', { path: up.path, name: up.name, session: up.session, action: 'cancel' }), {
          method: 'POST', headers: fsHeaders()
        })
      } catch {}
      setFsButtons(true, true)
      setFsProgressText(t('fs.checksumFailed'))
      toast(e.message, 'err')
      return
    }
    hideFsProgress()
    setFsButtons(false)
    toast(t('fs.uploadInterrupted', { msg: e.message }), 'err')
  }
}

function fsUp() {
  if (!state.fs.path || !state.fs.initial) return
  const parent = fsParent(state.fs.path)
  if (fsPathEqual(state.fs.path, state.fs.initial) || !fsPathInside(parent, state.fs.initial)) {
    toast(t('fs.alreadyRoot'))
    return
  }
  loadFs(parent)
}

function bindFsPullRefresh() {
  const view = $('view-files')
  if (!view) return
  const pull = $('fs-pull')
  let startY = null
  view.addEventListener('touchstart', (e) => {
    if (window.scrollY <= 0) { startY = e.touches[0].clientY; pull.style.height = '0px' }
  }, { passive: true })
  view.addEventListener('touchmove', (e) => {
    if (startY == null) return
    const dy = e.touches[0].clientY - startY
    if (dy > 4 && window.scrollY <= 0) {
      pull.style.height = Math.min(64, dy / 2) + 'px'
      pull.textContent = dy > 80 ? t('fs.pullRelease') : t('fs.pullDown')
    }
  }, { passive: true })
  view.addEventListener('touchend', () => {
    if (startY == null) return
    const h = parseFloat(pull.style.height || '0')
    startY = null
    if (h >= 40) {
      pull.textContent = t('fs.refreshing')
      loadFs(null, { silent: true })
    }
    pull.style.height = '0px'
  })
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
  if (!objective) return toast(t('goal.cannotEmpty'), 'err')
  const result = await safeRpc('goal.edit', { sessionId: state.current, ref: { id: goal.id, revision: goal.revision }, objective }, t('goal.updateFailed'))
  if (result == null) return
  $('modal-goal').classList.add('hidden')
  toast(t('goal.updated'), 'ok')
  scheduleRefresh()
}

/* ---------------- 检查更新 ---------------- */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim())
  if (!m) return { core: [0, 0, 0], pre: null }
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null }
}
function cmpVersion(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i] - pb.core[i]
    if (d) return d
  }
  // 无预发布后缀 = 正式版 > 任何 rc; 两个 rc 按段比较(数字段按数值, 字母段按字典序)
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const sa = String(pa.pre).split('.'), sb = String(pb.pre).split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i] ?? '', y = sb[i] ?? ''
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d }
    else if (nx !== ny) return nx ? -1 : 1 // 数字段 < 字母段(semver 规则)
    else { const d = x.localeCompare(y); if (d) return d }
  }
  return 0
}

function isComparableVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || '').trim())
}

function isAppBehindGateway(appVersion, gatewayVersion) {
  return isComparableVersion(appVersion) && isComparableVersion(gatewayVersion) && cmpVersion(gatewayVersion, appVersion) > 0
}

function isAppVersionWarningOpen() {
  const modal = $('modal-app-version-warning')
  return !!modal && !modal.classList.contains('hidden')
}

async function maybeWarnAppBehindGateway({ probe = false } = {}) {
  if (!CAP?.isNativePlatform?.() || !state.localVersion) return false
  const base = String(state.server || '').replace(/\/+$/, '')
  if (!base) return false
  let health = state.gatewayHealth[base]
  if (!health && probe) {
    await pingServer(base)
    health = state.gatewayHealth[base]
  }
  const gatewayVersion = String(health?.version || '').trim()
  if (!isAppBehindGateway(state.localVersion, gatewayVersion)) return false
  const warningKey = `${state.localVersion}\u0000${gatewayVersion}`
  if (state.warnedGatewayVersions.has(warningKey)) return false
  const anotherModal = [...document.querySelectorAll('.modal')]
    .some(modal => modal.id !== 'modal-app-version-warning' && !modal.classList.contains('hidden'))
  if (anotherModal) return false
  state.warnedGatewayVersions.add(warningKey)
  $('app-version-current').textContent = 'v' + state.localVersion
  $('app-version-gateway').textContent = 'v' + gatewayVersion
  $('modal-app-version-warning').classList.remove('hidden')
  setTimeout(() => $('app-version-update')?.focus(), 50)
  return true
}

function closeAppVersionWarning(checkNow = false) {
  $('modal-app-version-warning').classList.add('hidden')
  if (checkNow) {
    showView('view-settings')
    showSettingsPage('about')
    void checkUpdate(false)
  } else {
    scheduleStartupNotices(150)
  }
}

function resetUpdateExpand() {
  const desc = $('update-desc')
  if (desc) desc.classList.remove('expanded')
  const btn = $('btn-update-expand')
  if (btn) btn.classList.add('hidden')
}

function renderUpdateExpandBtn() {
  const btn = $('btn-update-expand')
  if (!btn || btn.classList.contains('hidden')) return
  btn.textContent = t($('update-desc').classList.contains('expanded') ? 'update.collapse' : 'update.expand')
}

function toggleUpdateExpand() {
  $('update-desc').classList.toggle('expanded')
  renderUpdateExpandBtn()
}

async function loadLocalVersion() {
  try {
    const res = await fetch('version.json?t=' + Date.now())
    if (res.ok) state.localVersion = (await res.json())?.version || ''
  } catch {}
  $('update-desc').textContent = state.localVersion ? t('update.currentV', { version: state.localVersion }) : t('update.noVersion')
}

/* ---------------- 远程公告 ----------------
 * 与 update.json 放在同一台服务器上，格式见 README/发布说明。
 * 公告只读取文本并用 textContent/转义后的换行渲染，不执行服务端下发的 HTML/脚本。
 */
const ANNOUNCEMENTS_KEY = 'seenAnnouncementsV1'
const ANNOUNCEMENT_HISTORY_KEY = 'announcementHistoryV1'
const ANNOUNCEMENT_VOTES_KEY = 'announcementVotesV1'
const ANNOUNCEMENTS_POLL_MS = 30 * 1000
let announcementCheckPromise = null
let announcementPollTimer = null
let announcementPollingStarted = false
function readSeenAnnouncements() {
  try {
    const value = JSON.parse(LS.get(ANNOUNCEMENTS_KEY, '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function markAnnouncementSeen(id) {
  if (!id) return
  const seen = readSeenAnnouncements()
  seen[id] = Date.now()
  const keys = Object.keys(seen)
  if (keys.length > 100) {
    keys.sort((a, b) => Number(seen[a]) - Number(seen[b]))
    for (const key of keys.slice(0, keys.length - 100)) delete seen[key]
  }
  LS.set(ANNOUNCEMENTS_KEY, JSON.stringify(seen))
  renderAnnouncementBoard()
}
function readAnnouncementVotes() {
  try {
    const value = JSON.parse(LS.get(ANNOUNCEMENT_VOTES_KEY, '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function announcementVoteKey(announcementId, pollId) {
  return `${announcementId}\u0000${pollId}`
}
function storeAnnouncementVote(announcementId, pollId, optionId) {
  const votes = readAnnouncementVotes()
  votes[announcementVoteKey(announcementId, pollId)] = { optionId, votedAt: Date.now() }
  const keys = Object.keys(votes)
  if (keys.length > 100) {
    keys.sort((a, b) => Number(votes[a]?.votedAt || 0) - Number(votes[b]?.votedAt || 0))
    for (const key of keys.slice(0, keys.length - 100)) delete votes[key]
  }
  LS.set(ANNOUNCEMENT_VOTES_KEY, JSON.stringify(votes))
  renderAnnouncementBoard()
}
function announcementVote(item) {
  if (!item?.poll?.id) return null
  const saved = readAnnouncementVotes()[announcementVoteKey(item.id, item.poll.id)]
  if (!saved?.optionId) return null
  const option = item.poll.options.find(entry => entry.id === saved.optionId)
  return option ? { ...saved, option } : null
}
function readAnnouncementHistory() {
  try {
    const value = JSON.parse(LS.get(ANNOUNCEMENT_HISTORY_KEY, '[]'))
    return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string') : []
  } catch { return [] }
}
function storeAnnouncementHistory(items) {
  const merged = new Map(readAnnouncementHistory().map(item => [item.id, item]))
  for (const item of items) if (item?.id) merged.set(item.id, item)
  const list = [...merged.values()].sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0)).slice(0, 50)
  LS.set(ANNOUNCEMENT_HISTORY_KEY, JSON.stringify(list))
  return list
}
function announcementBoardItems() {
  const seen = readSeenAnnouncements()
  const merged = new Map(readAnnouncementHistory().map(item => [item.id, item]))
  for (const item of state.announcements) if (item?.id) merged.set(item.id, item)
  return [...merged.values()]
    .filter(item => !seen[item.id])
    .sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0))
    .slice(0, 1)
}
function renderAnnouncementBoard() {
  const box = $('overview-announcement-list')
  if (!box) return
  const items = announcementBoardItems()
  if (!items.length) {
    box.innerHTML = `<div class="overview-empty">${esc(t('overview.communityEmpty'))}</div>`
    return
  }
  box.innerHTML = items.map(item => {
    const poll = !!item.poll
    const vote = announcementVote(item)
    const date = Number(item.publishedAt) > 0 ? fmtFullTime(item.publishedAt) : t('announcement.noDate')
    const action = poll ? (vote ? t('overview.communityVoted') : t('overview.communityVote')) : t('overview.communityView')
    return `<button class="overview-announcement-card ${poll ? 'poll' : 'notice'}" type="button" data-home-announcement="${esc(item.id)}">
      <span class="overview-announcement-meta"><span class="overview-announcement-badge">${esc(t(poll ? 'overview.communityPoll' : 'overview.communityNotice'))}</span><span class="overview-announcement-new">${esc(t('overview.communityNew'))}</span><span class="overview-announcement-date">${esc(date)}</span></span>
      <span class="overview-announcement-title">${esc(item.title)}</span>
      <span class="overview-announcement-copy">${esc(item.content)}</span>
      <span class="overview-announcement-footer"><span>${esc(action)}</span><span aria-hidden="true">›</span></span>
    </button>`
  }).join('')
}
function renderAnnouncementHistory() {
  const box = $('announcement-history-list')
  if (!box) return
  const list = readAnnouncementHistory()
  if (!list.length) {
    box.innerHTML = `<div class="empty">${esc(t('announcement.historyEmpty'))}</div>`
    return
  }
  box.innerHTML = list.map(item => {
    const date = Number(item.publishedAt) > 0 ? fmtFullTime(item.publishedAt) : t('announcement.noDate')
    const action = item.actionUrl ? `<a class="announcement-action" href="${esc(item.actionUrl)}" target="_blank" rel="noopener">${esc(item.actionText || t('announcement.open'))}</a>` : ''
    const vote = announcementVote(item)
    const pollAction = item.poll ? (vote
      ? `<div class="announcement-poll-status">${esc(t('announcement.voteThanks', { option: vote.option.label }))}</div>`
      : `<button class="mini-btn" type="button" data-announcement-poll="${esc(item.id)}">${esc(t('announcement.voteFromHistory'))}</button>`) : ''
    return `<details class="announcement-history-item"><summary><span>${esc(item.title)}</span><small>${esc(date)}</small></summary><div class="announcement-history-content">${esc(item.content).replace(/\r?\n/g, '<br>')}${action}${pollAction}</div></details>`
  }).join('')
}
function openAnnouncementHistory() {
  renderAnnouncementHistory()
  $('modal-announcement-history')?.classList.remove('hidden')
}
function closeAnnouncementHistory() {
  $('modal-announcement-history')?.classList.add('hidden')
}
function announcementVersionMatch(item) {
  const min = String(item.minVersion || item.minAppVersion || '').trim()
  const max = String(item.maxVersion || item.maxAppVersion || '').trim()
  if (!state.localVersion) return false
  if (min && cmpVersion(state.localVersion, min) < 0) return false
  if (max && cmpVersion(state.localVersion, max) > 0) return false
  return true
}
function normalizeAnnouncementPoll(value, announcementId) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || announcementId || '').trim().slice(0, 120)
  const question = String(value.question || '').trim().slice(0, 300)
  if (!id || !question || !Array.isArray(value.options)) return null
  const seen = new Set()
  const options = []
  for (const raw of value.options.slice(0, 8)) {
    const optionId = String(raw?.id || '').trim().slice(0, 120)
    const label = String(raw?.label || '').trim().slice(0, 200)
    if (!optionId || !label || seen.has(optionId)) continue
    seen.add(optionId)
    options.push({ id: optionId, label, description: String(raw?.description || '').trim().slice(0, 500) })
  }
  return options.length >= 2 ? { id, question, options } : null
}
function normalizeAnnouncement(item, base) {
  if (!item || typeof item !== 'object') return null
  const id = String(item.id || '').trim().slice(0, 120)
  const title = String(item.title || '').trim().slice(0, 160)
  const content = String(item.content ?? item.body ?? '').trim().slice(0, 20000)
  if (!id || !title || !content || !announcementVersionMatch(item)) return null
  const now = Date.now()
  const startsAt = Date.parse(item.publishedAt || item.startsAt || '')
  const expiresAt = Date.parse(item.expiresAt || '')
  if (Number.isFinite(startsAt) && startsAt > now) return null
  if (Number.isFinite(expiresAt) && expiresAt <= now) return null
  let actionUrl = String(item.actionUrl || item.url || '').trim()
  if (actionUrl) {
    try {
      const parsed = new URL(actionUrl, base + '/')
      if (!['http:', 'https:'].includes(parsed.protocol)) actionUrl = ''
      else actionUrl = parsed.href
    } catch { actionUrl = '' }
  }
  return {
    id, title, content, actionUrl,
    actionText: String(item.actionText || '').trim().slice(0, 80),
    publishedAt: Number.isFinite(startsAt) ? startsAt : 0,
    force: item.force === true,
    poll: normalizeAnnouncementPoll(item.poll, id)
  }
}
function renderAnnouncementPoll(item) {
  const panel = $('announcement-poll')
  const poll = item?.poll
  panel.classList.toggle('hidden', !poll)
  if (!poll) return
  const vote = announcementVote(item)
  $('announcement-poll-question').textContent = poll.question
  $('announcement-poll-options').innerHTML = poll.options.map(option => `
    <label class="announcement-poll-option">
      <input type="radio" name="announcement-poll-option" value="${esc(option.id)}"${vote?.optionId === option.id ? ' checked' : ''}${vote ? ' disabled' : ''}>
      <span><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span>
    </label>`).join('')
  const status = $('announcement-poll-status')
  status.textContent = vote ? t('announcement.voteThanks', { option: vote.option.label }) : ''
  status.classList.toggle('hidden', !vote)
  const submit = $('announcement-poll-submit')
  submit.classList.toggle('hidden', !!vote)
  submit.disabled = true
}
function openAnnouncementModal(item) {
  state.announcement = item
  $('announcement-title').textContent = item.title
  $('announcement-content').innerHTML = esc(item.content).replace(/\r?\n/g, '<br>')
  renderAnnouncementPoll(item)
  const action = $('announcement-action')
  if (item.actionUrl) {
    action.href = item.actionUrl
    action.textContent = item.actionText || t('announcement.open')
    action.classList.remove('hidden')
  } else {
    action.removeAttribute('href')
    action.textContent = ''
    action.classList.add('hidden')
  }
  $('announcement-later').classList.toggle('hidden', item.force)
  $('modal-announcement').classList.remove('hidden')
}
async function submitAnnouncementVote() {
  const item = state.announcement
  const poll = item?.poll
  const optionId = document.querySelector('input[name="announcement-poll-option"]:checked')?.value || ''
  const option = poll?.options.find(entry => entry.id === optionId)
  if (!poll || !option) return toast(t('announcement.voteChoose'), 'err')
  const button = $('announcement-poll-submit')
  button.disabled = true
  const payload = {
    type: 'poll',
    message: `Poll ${poll.id}: ${option.id}`,
    announcementId: item.id,
    pollId: poll.id,
    optionId: option.id,
    appVersion: state.localVersion
  }
  try {
    const base = updateBase()
    let res = null
    let data = {}
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    if (base) {
      try {
        res = await fetch(base + '/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {})
        })
        data = await res.json().catch(() => ({}))
      } catch {}
    }
    // 没有网关地址、网关网络错误或令牌失效时，投票改走公网收集器。
    if (!res || res.status === 401) {
      const directSignal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
      res = await fetch(DIRECT_POLL_FEEDBACK_URL, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(directSignal ? { signal: directSignal } : {})
      })
      data = await res.json().catch(() => ({}))
    }
    if (res.ok && data.ok) {
      storeAnnouncementVote(item.id, poll.id, option.id)
      markAnnouncementSeen(item.id)
      renderAnnouncementPoll(item)
      renderAnnouncementHistory()
      toast(t('announcement.voteThanks', { option: option.label }), 'ok')
    } else if (res.status === 429) {
      toast(t('announcement.voteAgainLater'), 'err')
      button.disabled = false
    } else {
      toast(t('announcement.voteFailed', { msg: data.error || res.status }), 'err')
      button.disabled = false
    }
  } catch (e) {
    toast(t('announcement.voteFailed', { msg: e.message || t('announcement.voteNetworkError') }), 'err')
    button.disabled = false
  }
}
function closeAnnouncement(markSeen) {
  if (markSeen && state.announcement) markAnnouncementSeen(state.announcement.id)
  state.announcement = null
  $('modal-announcement').classList.add('hidden')
}
async function fetchAnnouncements() {
  const base = updateBase()
  if (!base || !state.localVersion || isAppVersionWarningOpen()) return false
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    const url = base + '/announcements.json?t=' + Date.now()
    const res = signal ? await fetch(url, { cache: 'no-store', signal }) : await fetch(url, { cache: 'no-store' })
    if (!res.ok) return false
    const raw = await res.text()
    if (raw.length > 512 * 1024) return false
    const data = JSON.parse(raw)
    const source = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [data])
    const normalized = source.map(item => normalizeAnnouncement(item, base)).filter(Boolean)
    state.announcements = normalized.sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0))
    storeAnnouncementHistory(normalized)
    renderAnnouncementBoard()
    const seen = readSeenAnnouncements()
    const items = normalized.filter(item => !seen[item.id])
      .sort((a, b) => b.publishedAt - a.publishedAt)
    if (!items.length || state.announcement) return false
    openAnnouncementModal(items[0])
    return true
  } catch { return false }
}

function checkAnnouncements() {
  if (announcementCheckPromise) return announcementCheckPromise
  announcementCheckPromise = fetchAnnouncements().finally(() => { announcementCheckPromise = null })
  return announcementCheckPromise
}

function startAnnouncementPolling() {
  if (announcementPollingStarted) return
  announcementPollingStarted = true
  announcementPollTimer = setInterval(() => {
    if (!document.hidden) void checkAnnouncements()
  }, ANNOUNCEMENTS_POLL_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkAnnouncements()
  })
  window.addEventListener('online', () => { void checkAnnouncements() })
}

let startupNoticeTimer = null
function scheduleStartupNotices(delay = 4000) {
  clearTimeout(startupNoticeTimer)
  startupNoticeTimer = setTimeout(async () => {
    if (isAppVersionWarningOpen()) return
    const shown = await checkAnnouncements()
    if (!shown && state.token && !isAppVersionWarningOpen()) checkUpdate(true)
  }, delay)
}

/* ---------------- 更新内容弹窗 ---------------- */
const NOTES_KEY = 'seenNotesVersion'
let notesVersion = ''
let notesPages = []
let notesPage = 0
function splitNotes(notes) {
  return String(notes || '').split(/[；;]/).map(s => s.trim()).filter(Boolean)
}
function renderNotesPages(items) {
  const box = $('notes-pages')
  if (!box) return
  const pages = []
  for (let i = 0; i < items.length; i += 3) pages.push(items.slice(i, i + 3))
  notesPages = pages
  notesPage = 0
  box.innerHTML = pages.map(page => `<div class="notes-page" style="flex:0 0 100%;scroll-snap-align:start;box-sizing:border-box;min-width:0;">${page.map(item => `<div class="notes-item" style="padding:6px 0;line-height:1.5;">${esc(item)}</div>`).join('')}</div>`).join('')
  box.scrollLeft = 0
  updateNotesPage()
}
function renderNotesVersionPages(entries) {
  const box = $('notes-pages')
  if (!box) return
  notesPages = entries
  notesPage = 0
  box.innerHTML = entries.map(entry => {
    const items = splitNotes(entry.notes)
    return `<div class="notes-page" style="flex:0 0 100%;scroll-snap-align:start;box-sizing:border-box;min-width:0;">
      <div class="notes-version-title" style="font-weight:700;margin-bottom:6px;opacity:.9;">v${esc(entry.version)}</div>
      ${items.length ? items.map(item => `<div class="notes-item" style="padding:6px 0;line-height:1.5;">${esc(item)}</div>`).join('') : `<div class="notes-item" style="padding:6px 0;line-height:1.5;">${esc(entry.notes || '')}</div>`}
    </div>`
  }).join('')
  box.scrollLeft = 0
  updateNotesPage()
}
function updateNotesPage() {
  const box = $('notes-pages')
  const pageEl = $('notes-page')
  if (!box || !pageEl) return
  const total = notesPages.length || 1
  const idx = Math.min(Math.max(0, Math.round(box.scrollLeft / Math.max(1, box.clientWidth))), total - 1)
  notesPage = idx
  pageEl.textContent = t('notes.page', { current: idx + 1, total })
}
function scrollNotes(dir) {
  const box = $('notes-pages')
  if (box) box.scrollBy({ left: dir * box.clientWidth, behavior: 'smooth' })
}
function openNotesModal(info) {
  if (!info?.version) return
  const history = Array.isArray(info.history) ? info.history.filter(h => h && typeof h.version === 'string' && typeof h.notes === 'string' && !String(h.version).includes('-rc')) : []
  const latestStable = history[0]?.version || info.version
  if (history.length) {
    const entries = history.filter(h => cmpVersion(h.version, state.localVersion) > 0)
    if (!entries.length) return
    if (LS.get(NOTES_KEY) === latestStable) return
    notesVersion = latestStable
    const vEl = $('notes-version')
    if (vEl) vEl.textContent = 'v' + latestStable
    renderNotesVersionPages(entries.reverse())
    $('modal-notes').classList.remove('hidden')
    return
  }
  if (String(info.version).includes('-rc')) return
  if (LS.get(NOTES_KEY) === info.version) return
  const items = splitNotes(info.notes)
  if (!items.length) return
  notesVersion = info.version
  const vEl = $('notes-version')
  if (vEl) vEl.textContent = 'v' + info.version
  renderNotesPages(items)
  $('modal-notes').classList.remove('hidden')
}
function closeNotesModal() {
  $('modal-notes').classList.add('hidden')
  if (notesVersion) { LS.set(NOTES_KEY, notesVersion); notesVersion = '' }
}

async function checkUpdate(silent) {
  if (!state.localVersion) {
    $('update-desc').textContent = t('update.noVersion')
    resetUpdateExpand()
    if (!silent) toast(t('update.noVersion'), 'err')
    return
  }
  const base = updateBase()
  if (!base) {
    if (!silent) toast(t('update.needServer'), 'err')
    $('update-desc').textContent = state.localVersion ? `${t('update.currentV', { version: state.localVersion })} · ${t('update.needServer')}` : t('update.needServer')
    resetUpdateExpand()
    return
  }
  if (!silent) toast(t('update.checking'))
  try {
    const res = await fetch(base + '/update.json?t=' + Date.now() + '&local=' + encodeURIComponent(state.localVersion))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const info = await res.json()
    openNotesModal(info)
    if (info.version && cmpVersion(info.version, state.localVersion) > 0) {
      state.updateInfo = info
      const hasNotes = !!(info.notes && String(info.notes).trim())
      $('update-desc').textContent = t('update.found', { version: info.version, notes: hasNotes ? '：' + info.notes : '' })
      $('update-desc').classList.remove('expanded')
      $('btn-update-expand').classList.toggle('hidden', !hasNotes)
      renderUpdateExpandBtn()
      $('btn-download-update').classList.remove('hidden')
      if (!silent) toast(t('update.found', { version: info.version }), 'ok')
      else notify(t('update.foundTitle'), t('update.foundBody', { version: info.version }))
    } else {
      state.updateInfo = null
      $('update-desc').textContent = state.localVersion ? t('update.latestV', { version: state.localVersion }) : t('update.latestRemote', { version: info.version || '?' })
      $('btn-download-update').classList.add('hidden')
      resetUpdateExpand()
      if (!silent) toast(t('update.latestToast'), 'ok')
    }
  } catch (e) {
    $('update-desc').textContent = t('update.checkFailedDesc', { msg: e.message || t('fs.networkError') })
    resetUpdateExpand()
    if (!silent) toast(t('update.checkFailed', { msg: e.message }), 'err')
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 下载 APK 并用 update.json 的 sha256 校验。
 * 返回 { ok, skipped } 或 { ok:false, status | corrupted | network }。
 * 老产物没有 sha256 时跳过校验；crypto.subtle 不可用也跳过（不阻塞老 WebView）。
 */
async function verifyUpdateApk(info, url) {
  const expected = String(info.sha256 || '').trim().toLowerCase()
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return { ok: true, skipped: true }
  let res
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(120000) : undefined
    res = signal ? await fetch(url, { signal }) : await fetch(url)
  } catch (err) {
    return { ok: false, network: true, msg: err?.message || '' }
  }
  if (!res.ok) return { ok: false, status: res.status }
  let buf
  try {
    buf = await res.arrayBuffer()
  } catch (err) {
    return { ok: false, network: true, msg: err?.message || '' }
  }
  let actual
  try {
    actual = await sha256Hex(buf)
  } catch {
    return { ok: true, skipped: true }
  }
  if (actual.toLowerCase() !== expected) return { ok: false, corrupted: true }
  return { ok: true, skipped: false }
}

async function downloadUpdate() {
  const info = state.updateInfo
  if (!info) return
  const base = updateBase()
  let url
  try { url = new URL(info.apkUrl || 'dsh-remote.apk', base + '/').href }
  catch { url = base + '/' + (info.apkUrl || 'dsh-remote.apk') }

  // 先下载校验再交给原生/浏览器安装；校验失败不进入安装
  const verify = await verifyUpdateApk(info, url)
  if (!verify.ok) {
    if (verify.corrupted) {
      toast(t('update.corrupted'), 'err')
    } else if (verify.status) {
      toast(t('update.serverFileMissing'), 'err')
    } else {
      toast(t('update.downloadFailed', { msg: verify.msg || t('fs.networkError') }), 'err')
    }
    return
  }

  if (CAP?.isNativePlatform?.()) {
    // Android WebView 原生桥(不依赖 Capacitor 插件路由)
    if (window.NativeUpdate?.downloadAndInstall) {
      try {
        window.NativeUpdate.downloadAndInstall(url)
        toast(t('update.downloadStarted'), 'ok')
      } catch (e) {
        toast(t('update.downloadFailed', { msg: e?.message || '' }), 'err')
      }
      return
    }
    // 兜底: 旧版 App 没有原生桥时用浏览器下载
    toast(t('update.installUnsupported'), 'err')
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
      toast(t('notify.permissionFailed', { msg: e?.message || '' }), 'err')
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

async function sendTestNotification() {
  if (!CAP?.isNativePlatform?.()) {
    toast(t('settings.testNotifyUnavailable'), 'err')
    return
  }
  const L = CAP.Plugins?.LocalNotifications
  if (!L?.schedule) {
    toast(t('settings.testNotifyUnavailable'), 'err')
    return
  }
  const ok = await ensureNotify()
  if (!ok) { toast(t('settings.notifyDenied'), 'err'); return }
  try {
    await L.schedule({
      notifications: [{
        id: 8899,
        title: 'DSH Remote',
        body: '测试通知 · Test',
        schedule: { at: new Date(Date.now() + 3000) }
      }]
    })
    toast(t('settings.testNotifySent'), 'ok')
  } catch (e) {
    toast(t('settings.testNotifyFailed', { msg: e?.message || '' }), 'err')
  }
}

/* ---------------- 后台轮询（Android 前台服务） ---------------- */
function bgBridge() { return window.NativeBackground }
function bgBase() { return (state.server || location.origin || '').replace(/\/+$/, '') }
function applyBgConfigFromNative() {
  const b = bgBridge()
  if (!b?.getBackgroundConfig) return
  try {
    const cfg = JSON.parse(b.getBackgroundConfig() || '{}')
    $('opt-bg-poll').checked = !!cfg.enabled
    const v = String(cfg.intervalMin ?? 1)
    const opts = Array.from($('bg-interval')?.options || [])
    if (opts.some(o => o.value === v)) $('bg-interval').value = v
    syncCustomSelect($('bg-interval'))
    if ($('opt-task-done')) $('opt-task-done').checked = cfg.notifyTaskDone !== false
    $('bg-auth-status')?.classList.toggle('hidden', !cfg.loginExpired)
  } catch {}
}
function saveBgConfig(enabled) {
  const b = bgBridge()
  if (!b?.saveBackgroundConfig) return false
  const base = bgBase()
  const intervalMin = parseFloat($('bg-interval')?.value || '0.5') || 0.5
  const notifyTaskDone = $('opt-task-done')?.checked !== false
  b.saveBackgroundConfig(JSON.stringify({ enabled, intervalMin, base, token: state.token || '', clientId: CLIENT_ID || '', notifyTaskDone }))
  if (enabled) $('bg-auth-status')?.classList.add('hidden')
  return true
}
function syncBgConfig() {
  if ($('opt-bg-poll')?.checked && state.token) saveBgConfig(true)
}

/* ---------------- 预设提示词 ---------------- */
const PRESETS_KEY = 'dshPromptPresets'
const PRESET_NAME_MAX = 20
const PRESET_TEXT_MAX = 2000
const PRESET_LIMIT = 20
function readPresets() {
  try {
    const v = JSON.parse(LS.get(PRESETS_KEY, '[]') || '[]')
    return Array.isArray(v) ? v.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.text === 'string') : []
  } catch { return [] }
}
function writePresets(list) {
  LS.set(PRESETS_KEY, JSON.stringify(list))
  renderPresets()
  renderPresetMenu()
}
function renderPresets() {
  const box = $('preset-list')
  if (!box) return
  const list = readPresets()
  if (!list.length) {
    box.innerHTML = `<div class="server-empty">${esc(t('presets.empty'))}</div>`
    return
  }
  box.innerHTML = list.map(p => `<div class="server-row">
    <div class="server-main"><div class="server-note">${esc(p.name)}</div><div class="server-url">${esc((p.text || '').slice(0, 60))}</div></div>
    <button class="mini-btn" data-preset-edit="${esc(p.id)}">${t('presets.edit')}</button>
    <button class="mini-btn" data-preset-del="${esc(p.id)}">${t('presets.delete')}</button>
  </div>`).join('')
  box.querySelectorAll('[data-preset-edit]').forEach(b => b.addEventListener('click', () => editPreset(b.dataset.presetEdit)))
  box.querySelectorAll('[data-preset-del]').forEach(b => b.addEventListener('click', () => deletePreset(b.dataset.presetDel)))
}
function renderPresetMenu() {
  const group = $('preset-menu-group')
  const listBox = $('preset-menu-list')
  if (!group || !listBox) return
  const list = readPresets()
  group.classList.toggle('hidden', !list.length)
  listBox.innerHTML = list.map(p => `<button class="menu-chip" data-preset="${esc(p.id)}">${esc(p.name)}</button>`).join('')
}
function promptPreset(id) {
  const list = readPresets()
  const existing = id ? list.find(p => p.id === id) : null
  const name = prompt(t('presets.namePrompt'), existing?.name || '')
  if (name == null) return
  const text = prompt(t('presets.textPrompt'), existing?.text || '')
  if (text == null) return
  const n = (name || '').trim()
  if (!n) return toast(t('presets.nameEmpty'), 'err')
  if (n.length > PRESET_NAME_MAX) return toast(t('presets.nameTooLong'), 'err')
  if (text.length > PRESET_TEXT_MAX) return toast(t('presets.textTooLong'), 'err')
  if (existing) {
    existing.name = n
    existing.text = text
  } else {
    if (list.length >= PRESET_LIMIT) return toast(t('presets.limit'), 'err')
    list.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: n, text })
  }
  writePresets(list)
  toast(existing ? t('presets.saved') : t('presets.added'), 'ok')
}
function addPreset() { promptPreset(null) }
function editPreset(id) { promptPreset(id) }
function deletePreset(id) {
  const list = readPresets()
  const p = list.find(x => x.id === id)
  if (!p) return
  if (!confirm(t('presets.confirmDelete', { name: p.name }))) return
  writePresets(list.filter(x => x.id !== id))
  toast(t('presets.deleted'), 'ok')
}

/* ---------------- 峰谷计费提醒(前台服务进程内定时, 绕开 MIUI 后台限制) ---------------- */
function peakRemindOn() { return LS.get('peakRemind', '0') === '1' }
const LEGACY_PEAK_NOTIFICATION_IDS = [8801, 8802, 8803, 8804]

async function cancelLegacyPeakNotifications() {
  if (!CAP?.isNativePlatform?.()) return false
  const notifications = CAP.Plugins?.LocalNotifications
  if (!notifications?.cancel) return true
  try {
    await notifications.cancel({ notifications: LEGACY_PEAK_NOTIFICATION_IDS.map(id => ({ id })) })
    return true
  } catch (error) {
    console.warn('Failed to cancel legacy peak reminders', error)
    return false
  }
}

async function schedulePeakReminders({ legacyCleaned = false } = {}) {
  if (!CAP?.isNativePlatform?.()) return false
  if (!legacyCleaned && !await cancelLegacyPeakNotifications()) return false
  const b = bgBridge()
  if (!b?.startPeakReminder) return false
  try {
    return b.startPeakReminder() !== false
  } catch { return false }
}

async function cancelPeakReminders() {
  if (!CAP?.isNativePlatform?.()) return false
  const b = bgBridge()
  if (!b?.stopPeakReminder) return false
  try {
    const stopped = b.stopPeakReminder() !== false
    const legacyCleaned = await cancelLegacyPeakNotifications()
    return stopped && legacyCleaned
  } catch { return false }
}

async function restorePeakReminders() {
  if (!CAP?.isNativePlatform?.()) return
  // 旧版使用 LocalNotifications 每日调度；无论当前开关状态都先清理，防止与前台服务重复提醒。
  const legacyCleaned = await cancelLegacyPeakNotifications()
  if (peakRemindOn() && legacyCleaned) await schedulePeakReminders({ legacyCleaned: true })
}

/* ---------------- 功能测试 / Android ASR ---------------- */
function asrTestBridge() { return window.NativeAsrTest }

function emptyAsrTest() {
  return { running: false, status: 'idle', meta: null, summary: null, events: [], lastError: '' }
}

function asrTestEvent(event) {
  if (!event || typeof event !== 'object') return
  const current = state.asrTest
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'meta') current.meta = data
  if (event.type === 'summary') {
    current.summary = data
    current.running = false
  }
  if (event.type === 'status') {
    current.status = String(data.status || 'unknown')
    if (current.status === 'listening' || current.status === 'starting' || current.status === 'restarting') current.running = true
    if (['stopped', 'unsupported', 'permission-denied'].includes(current.status)) current.running = false
  }
  if (event.type === 'error') current.lastError = String(data.name || data.message || 'error')
  current.events.push({ type: event.type, atMs: Number(event.atMs) || 0, data })
  if (current.events.length > 500) current.events.splice(0, current.events.length - 500)
  renderAsrTest()
}
window.__dshAsrEvent = asrTestEvent

function asrTestStatusText(status) {
  const labels = {
    idle: t('settings.asrTestNativeOnly'),
    starting: t('settings.asrTestStarted'),
    listening: t('settings.asrTestStarted'),
    restarting: t('settings.asrTestRestarting'),
    'permission-requesting': t('settings.asrTestPermission'),
    'permission-denied': t('settings.asrTestPermissionDenied'),
    'permission-error': t('settings.asrTestPermissionError'),
    unsupported: t('settings.asrTestUnavailable'),
    busy: t('settings.asrTestBusy'),
    stopped: t('settings.asrTestStopped')
  }
  return labels[status] || t('settings.asrTestStatus', { status })
}

function asrTestLogLines() {
  const current = state.asrTest
  const lines = []
  for (const event of current.events) {
    const data = event.data || {}
    const at = `${event.atMs}ms`
    if (event.type === 'meta') {
      lines.push(`[${at}] meta brand=${data.brand || '—'} manufacturer=${data.manufacturer || '—'} model=${data.model || '—'} Android=${data.androidVersion || '—'} API=${data.apiLevel || '—'}`)
      lines.push(`[${at}] recordAudioPermission=${data.recordAudioPermission ?? 'unknown'} recordAudioAppOp=${data.recordAudioAppOp || 'unknown'} microphoneMuted=${data.microphoneMuted ?? 'unknown'}`)
      lines.push(`[${at}] recognitionAvailable=${data.recognitionAvailable === true} onDeviceAvailable=${data.onDeviceAvailable === true} path=${data.networkPath || '—'}`)
      for (const service of data.recognitionServices || []) lines.push(`[${at}] service ${service.packageName || '—'} / ${service.serviceName || '—'} xiaomiLike=${service.xiaomiLike === true}`)
    } else if (event.type === 'status') {
      lines.push(`[${at}] status=${data.status || '—'} session=${data.session ?? '—'} reason=${data.reason || '—'} ${data.message || ''}`.trim())
    } else if (event.type === 'partial' || event.type === 'final') {
      lines.push(`[${at}] ${event.type}#${data.count ?? '—'} session=${data.session ?? '—'} +${data.elapsedMs ?? '—'}ms: ${data.text || '(empty)'}`)
    } else if (event.type === 'callback') {
      lines.push(`[${at}] callback=${data.name || '—'} session=${data.session ?? '—'} +${data.elapsedMs ?? '—'}ms${data.bytes >= 0 ? ` bytes=${data.bytes}` : ''}`)
    } else if (event.type === 'error') {
      lines.push(`[${at}] error=${data.name || '—'} code=${data.code ?? '—'} session=${data.session ?? '—'} ${data.message || ''}`.trim())
    } else if (event.type === 'summary') {
      lines.push(`[${at}] summary reason=${data.reason || '—'} duration=${data.durationMs ?? '—'}ms sessions=${data.sessionCount ?? '—'} restarts=${data.restartCount ?? '—'} partial=${data.partialCount ?? '—'} final=${data.finalCount ?? '—'} errors=${data.errorCount ?? '—'}`)
    }
  }
  return lines
}

function asrTestReport() {
  const current = state.asrTest
  const meta = current.meta || {}
  const summary = current.summary || {}
  const lines = [
    'DSH Remote Android ASR 测试报告',
    `生成时间: ${new Date().toISOString()}`,
    `设备: ${meta.brand || '—'} / ${meta.manufacturer || '—'} / ${meta.model || '—'}`,
    `Android: ${meta.androidVersion || '—'} (API ${meta.apiLevel || '—'})`,
    `识别可用: ${meta.recognitionAvailable === true ? 'yes' : meta.recognitionAvailable === false ? 'no' : 'unknown'}`,
    `端侧识别可用: ${meta.onDeviceAvailable === true ? 'yes' : meta.onDeviceAvailable === false ? 'no' : 'unknown'}`,
    `路径: ${meta.networkPath || 'system-default-recognition-service'}`,
    `测试结束原因: ${summary.reason || current.status || '—'}`,
    `总时长: ${summary.durationMs ?? '—'}ms`,
    `session: ${summary.sessionCount ?? '—'} / 重建: ${summary.restartCount ?? '—'} / partial: ${summary.partialCount ?? '—'} / final: ${summary.finalCount ?? '—'} / errors: ${summary.errorCount ?? '—'}`,
    '',
    '事件日志:',
    ...asrTestLogLines()
  ]
  return lines.join('\n')
}

function renderAsrTest() {
  const start = $('btn-asr-test-start')
  const stop = $('btn-asr-test-stop')
  const copy = $('btn-asr-test-copy')
  const permission = $('btn-asr-test-permission')
  const engine = $('btn-asr-test-engine')
  const status = $('asr-test-status')
  const summary = $('asr-test-summary')
  const log = $('asr-test-log')
  if (!start || !stop || !copy || !permission || !engine || !status || !summary || !log) return
  const current = state.asrTest
  const native = !!(CAP?.isNativePlatform?.() && asrTestBridge()?.startAsrTest)
  start.disabled = current.running || !native
  stop.disabled = !current.running || !native
  copy.disabled = !current.events.length
  const permissionError = current.status === 'permission-error' || current.status === 'permission-denied' || current.summary?.reason === 'permission-error'
  status.className = 'feature-test-status ' + (permissionError || current.status === 'unsupported' ? 'error' : current.status === 'stopped' ? 'ok' : 'muted')
  status.textContent = native ? (permissionError ? t('settings.asrTestPermissionError') : asrTestStatusText(current.status)) : t('settings.asrTestWebUnsupported')
  permission.classList.toggle('hidden', !native || !permissionError)
  engine.classList.toggle('hidden', !native || !permissionError)
  const meta = current.meta || {}
  const s = current.summary
  summary.textContent = [
    meta.model ? `${t('settings.asrTestMeta')}: ${meta.brand || '—'} / ${meta.manufacturer || '—'} / ${meta.model}` : '',
    s ? `${t('settings.asrTestSummary')}: ${t('settings.asrTestStatus', { status: s.reason || 'done' })} · session ${s.sessionCount ?? '—'} · partial ${s.partialCount ?? '—'} · final ${s.finalCount ?? '—'} · error ${s.errorCount ?? '—'}` : ''
  ].filter(Boolean).join('\n')
  log.textContent = current.events.length ? asrTestLogLines().join('\n') : t('settings.asrTestLogEmpty')
  log.scrollTop = log.scrollHeight
}

function clearAsrTest() {
  if (state.asrTest.running) return toast(t('settings.asrTestBusy'), 'err')
  state.asrTest = emptyAsrTest()
  renderAsrTest()
}

async function startAsrTest() {
  const native = asrTestBridge()
  if (!CAP?.isNativePlatform?.() || !native?.startAsrTest) return toast(t('settings.asrTestWebUnsupported'), 'err')
  if (state.asrTest.running) return toast(t('settings.asrTestBusy'), 'err')
  if (!confirm(t('settings.asrTestConsent'))) return
  state.asrTest = { ...emptyAsrTest(), running: true, status: 'starting' }
  renderAsrTest()
  try {
    if (native.startAsrTest() === false) throw new Error(t('settings.asrTestUnavailable'))
  } catch (error) {
    state.asrTest.running = false
    state.asrTest.status = 'error'
    state.asrTest.lastError = error?.message || String(error)
    renderAsrTest()
    toast(state.asrTest.lastError, 'err')
  }
}

function stopAsrTest() {
  try { asrTestBridge()?.stopAsrTest?.() } catch {}
}

function openAsrPermissionSettings() {
  try {
    if (asrTestBridge()?.openAsrPermissionSettings?.() === false) throw new Error('permission settings unavailable')
  } catch (error) {
    toast(error?.message || String(error), 'err')
  }
}

function openAsrEngineSettings() {
  try {
    if (asrTestBridge()?.openAsrEngineSettings?.() === false) throw new Error('voice engine settings unavailable')
  } catch (error) {
    toast(error?.message || String(error), 'err')
  }
}

async function copyAsrTestLog() {
  const ok = await copyText(asrTestReport())
  toast(t(ok ? 'settings.asrTestCopyOk' : 'settings.asrTestCopyFailed'), ok ? 'ok' : 'err')
}

/* ---------------- 模型设置 ---------------- */
const MODEL_SETTINGS_FIELDS = ['baseURL', 'api', 'apiKeyEnv', 'displayName', 'models']
const MODEL_REASONING_LIMIT = 12
const MODEL_REASONING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

function modelValueAt(value, path = []) {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current
}

function cloneModelValue(value) {
  if (value === undefined) return undefined
  try { return structuredClone(value) } catch {}
  try { return JSON.parse(JSON.stringify(value)) } catch { return value }
}

function modelObjectAt(value, path = []) {
  const result = modelValueAt(value, path)
  return result && typeof result === 'object' && !Array.isArray(result) ? cloneModelValue(result) : {}
}

function modelKeyRefFor(provider, namespace, path) {
  const effective = modelObjectAt(namespace?.value, path)
  const user = modelObjectAt(namespace?.user, path)
  const named = typeof user.apiKeyEnv === 'string' && user.apiKeyEnv.trim()
    ? user.apiKeyEnv.trim()
    : typeof effective.apiKeyEnv === 'string' && effective.apiKeyEnv.trim()
      ? effective.apiKeyEnv.trim()
      : ''
  if (named) return named
  if (namespace?.ns === 'llm-deepseek') return 'DEEPSEEK_API_KEY'
  if (namespace?.ns === 'llm-pi-ai') return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY'
  return ''
}

function modelProfileName(row) {
  const display = String(row.displayName || row.provider || '')
  return display === row.provider ? display : `${display} (${row.provider})`
}

function modelSettingsNamespace(ns) {
  return state.modelSettings.namespaces.find(item => item.ns === ns) || null
}

function modelSettingsRow(provider) {
  return state.modelSettings.providers.find(row => row.provider === provider) || null
}

function modelSettingsPathChanged(before, after, key) {
  return JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])
}

function modelCatalogRows(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(model => model && typeof model === 'object' && !Array.isArray(model))
    .map(model => cloneModelValue(model))
}

function modelReasoningRows(model) {
  const reasoning = modelObjectAt(model, ['reasoning'])
  const raw = Array.isArray(reasoning.efforts) && reasoning.efforts.length
    ? reasoning.efforts
    : (Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : [])
  return raw.map(item => {
    const value = typeof item === 'string' ? { id: item } : modelObjectAt(item)
    return {
      id: typeof value.id === 'string' ? value.id.trim() : '',
      name: typeof value.name === 'string' ? value.name.trim() : '',
      description: typeof value.description === 'string' ? value.description.trim() : ''
    }
  })
}

function withModelReasoning(model, rows, defaultEffort = '') {
  const next = cloneModelValue(model) || {}
  delete next.reasoningEfforts
  const reasoning = modelObjectAt(next, ['reasoning'])
  const efforts = rows.map(row => {
    const value = { id: String(row.id || '').trim() }
    if (String(row.name || '').trim()) value.name = String(row.name).trim()
    if (String(row.description || '').trim()) value.description = String(row.description).trim()
    return value
  })
  if (efforts.length) {
    reasoning.efforts = efforts
    const selected = efforts.some(row => row.id === defaultEffort) ? defaultEffort : ''
    if (selected) reasoning.defaultEffort = selected
    else delete reasoning.defaultEffort
    next.reasoning = reasoning
  } else {
    delete reasoning.efforts
    delete reasoning.defaultEffort
    if (Object.keys(reasoning).length) next.reasoning = reasoning
    else delete next.reasoning
  }
  return next
}

function modelReasoningError(models) {
  for (const model of models) {
    const rows = modelReasoningRows(model)
    if (rows.length > MODEL_REASONING_LIMIT) return t('settings.modelReasoningLimit', { count: MODEL_REASONING_LIMIT })
    const ids = new Set()
    for (const row of rows) {
      if (!row.id) return t('settings.modelReasoningIdRequired')
      if (!MODEL_REASONING_ID_RE.test(row.id)) return t('settings.modelReasoningInvalid')
      if (ids.has(row.id)) return t('settings.modelReasoningDuplicate')
      ids.add(row.id)
    }
    const defaultEffort = modelObjectAt(model, ['reasoning']).defaultEffort
    if (defaultEffort && !ids.has(defaultEffort)) return t('settings.modelReasoningDefaultInvalid')
  }
  return ''
}

async function loadModelSettings(force = false) {
  if (!state.token) {
    state.modelSettings = { ...state.modelSettings, status: 'error', error: t('token.notSetHint') }
    renderModelSettings()
    return
  }
  if (state.modelSettings.status === 'loading') return
  if (!force && state.modelSettings.status === 'ready') return
  state.modelSettings = { ...state.modelSettings, status: 'loading', error: '' }
  renderModelSettings()
  try {
    const [providersValue, settingsValue] = await Promise.all([
      rpc('llm.providers', {}),
      rpc('settings.describe', {})
    ])
    const namespaces = Array.isArray(settingsValue?.namespaces) ? settingsValue.namespaces : []
    const providers = Array.isArray(providersValue?.providers) ? providersValue.providers : []
    const rows = providers.map(entry => {
      const settingsPath = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
      const namespace = namespaces.find(item => item.ns === entry.settingsNs) || null
      const effective = modelObjectAt(namespace?.value, settingsPath)
      const keyRef = modelKeyRefFor(entry.provider, namespace, settingsPath)
      return {
        ...entry,
        settingsPath,
        keyRef,
        namespace,
        configured: namespace !== null && (settingsPath.length === 0 || modelValueAt(namespace.value, settingsPath) !== undefined),
        effective,
        credential: null
      }
    })
    const refs = [...new Set(rows.map(row => row.keyRef).filter(Boolean))]
    let credentials = {}
    if (refs.length > 0) {
      const value = await rpc('credentials.describe', { refs })
      credentials = value?.credentials && typeof value.credentials === 'object' ? value.credentials : {}
    }
    state.modelSettings = {
      status: 'ready',
      error: '',
      writable: settingsValue?.writable === true,
      hasDocument: settingsValue?.hasDocument === true,
      providers: rows.map(row => ({ ...row, credential: row.keyRef ? credentials[row.keyRef] || null : null })),
      namespaces,
      credentials
    }
    state.modelEditor = null
  } catch (error) {
    state.modelSettings = { ...state.modelSettings, status: 'error', error: error?.message || String(error) }
  }
  renderModelSettings()
}

function renderModelSettings() {
  const status = $('model-settings-status')
  const list = $('model-settings-list')
  if (!status || !list) return
  const current = state.modelSettings
  if (current.status === 'loading') {
    status.className = 'model-settings-status muted'
    status.textContent = t('settings.modelLoading')
    list.innerHTML = ''
    return
  }
  if (current.status === 'error') {
    status.className = 'model-settings-status error'
    status.textContent = t('settings.modelUnavailable', { msg: current.error || t('err.dshError') })
    list.innerHTML = ''
    return
  }
  if (!current.providers.length) {
    status.className = 'model-settings-status muted'
    status.textContent = t('settings.modelEmpty')
    list.innerHTML = ''
    return
  }
  status.className = 'model-settings-status ' + (current.writable ? 'muted' : 'model-readonly')
  status.textContent = current.writable ? t('settings.modelIntro') : t('settings.modelReadOnly')
  list.innerHTML = current.providers.map(renderModelProviderCard).join('')
}

function renderModelProviderCard(row) {
  const editor = state.modelEditor?.provider === row.provider ? renderModelEditor() : ''
  const credentialConfigured = row.credential?.configured === true
  const dot = row.keyRef ? (credentialConfigured ? 'configured' : '') : 'unknown'
  const stateLabel = row.keyRef
    ? (credentialConfigured ? t('settings.modelConfigured') : t('settings.modelMissing'))
    : t('settings.modelConfigured')
  return `<article class="model-provider-card" data-model-provider-card="${esc(row.provider)}">
    <div class="model-provider-head">
      <div class="model-provider-identity">
        <span class="model-provider-dot ${dot}" title="${esc(stateLabel)}" aria-label="${esc(stateLabel)}"></span>
        <span class="model-provider-name">${esc(row.displayName || row.provider)}</span>
        <code class="model-provider-route">${esc(row.provider)}</code>
      </div>
      <button class="mini-btn" type="button" data-model-action="edit" data-model-provider="${esc(row.provider)}">${esc(t('settings.modelEdit'))}</button>
    </div>
    ${editor}
  </article>`
}

function renderModelReasoningEditor(model, index, readOnly) {
  const rows = modelReasoningRows(model)
  const reasoning = modelObjectAt(model, ['reasoning'])
  const defaultEffort = typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : ''
  const effortRows = rows.length
    ? rows.map((row, effortIndex) => `<div class="model-reasoning-entry">
        <input class="model-input" data-model-field="reasoning-id" data-model-index="${index}" data-reasoning-index="${effortIndex}" value="${esc(row.id)}" placeholder="${esc(t('settings.modelReasoningId'))}" aria-label="${esc(t('settings.modelReasoningId'))} ${effortIndex + 1}" ${readOnly ? 'disabled' : ''}>
        <input class="model-input" data-model-field="reasoning-name" data-model-index="${index}" data-reasoning-index="${effortIndex}" value="${esc(row.name)}" placeholder="${esc(t('settings.modelReasoningName'))}" aria-label="${esc(t('settings.modelReasoningName'))} ${effortIndex + 1}" ${readOnly ? 'disabled' : ''}>
        <input class="model-input" data-model-field="reasoning-description" data-model-index="${index}" data-reasoning-index="${effortIndex}" value="${esc(row.description)}" placeholder="${esc(t('settings.modelReasoningDescription'))}" aria-label="${esc(t('settings.modelReasoningDescription'))} ${effortIndex + 1}" ${readOnly ? 'disabled' : ''}>
        <button class="model-entry-remove" type="button" data-model-action="remove-reasoning" data-model-index="${index}" data-reasoning-index="${effortIndex}" aria-label="${esc(t('settings.modelReasoningRemove'))}" title="${esc(t('settings.modelReasoningRemove'))}" ${readOnly ? 'disabled' : ''}>×</button>
      </div>`).join('')
    : `<div class="model-empty">${esc(t('settings.modelReasoningEmpty'))}</div>`
  const defaultOptions = rows.filter(row => row.id).map(row => `<option value="${esc(row.id)}" ${defaultEffort === row.id ? 'selected' : ''}>${esc(row.name || row.id)}</option>`).join('')
  return `<div class="model-reasoning" data-model-reasoning-editor="${index}">
    <div class="model-reasoning-head">
      <div><div class="model-catalog-title">${esc(t('settings.modelReasoning'))}</div><div class="model-catalog-hint">${esc(t('settings.modelReasoningHint'))}</div></div>
      <div class="model-catalog-actions"><button class="mini-btn" type="button" data-model-action="add-reasoning" data-model-index="${index}" ${readOnly || rows.length >= MODEL_REASONING_LIMIT ? 'disabled' : ''}>${esc(t('settings.modelReasoningAdd'))}</button><button class="mini-btn" type="button" data-model-action="clear-reasoning" data-model-index="${index}" ${readOnly || !rows.length ? 'disabled' : ''}>${esc(t('settings.modelReasoningClear'))}</button></div>
    </div>
    <div class="model-reasoning-list">${effortRows}</div>
    <label class="model-reasoning-default"><span>${esc(t('settings.modelReasoningDefault'))}</span><select class="model-input" data-model-field="reasoning-default" data-model-index="${index}" ${readOnly || !rows.length ? 'disabled' : ''}><option value="" ${defaultEffort ? '' : 'selected'}>${esc(t('settings.modelReasoningProviderDefault'))}</option>${defaultOptions}</select></label>
  </div>`
}

function renderModelEditor() {
  const editor = state.modelEditor
  if (!editor) return ''
  const readOnly = !state.modelSettings.writable || editor.busy
  const keyPlaceholder = editor.keyConfigured && !editor.clearKey
    ? t('settings.modelApiKeyStored')
    : t('settings.modelApiKeyPlaceholder')
  const models = editor.models || []
  const modelList = models.length
    ? models.map((model, index) => `<div class="model-entry-card">
        <div class="model-entry">
          <input class="model-input" data-model-field="model-id" data-model-index="${index}" value="${esc(model.id || '')}" placeholder="${esc(t('settings.modelId'))}" aria-label="${esc(t('settings.modelId'))} ${index + 1}" ${readOnly ? 'disabled' : ''}>
          <input class="model-input model-name-input" data-model-field="model-name" data-model-index="${index}" value="${esc(model.name || '')}" placeholder="${esc(t('settings.modelName'))}" aria-label="${esc(t('settings.modelName'))} ${index + 1}" ${readOnly ? 'disabled' : ''}>
          <button class="model-entry-remove" type="button" data-model-action="remove-model" data-model-index="${index}" aria-label="${esc(t('settings.modelRemove'))}" title="${esc(t('settings.modelRemove'))}" ${readOnly ? 'disabled' : ''}>×</button>
        </div>
        ${renderModelReasoningEditor(model, index, readOnly)}
      </div>`).join('')
    : `<div class="model-empty">${esc(t('settings.modelNoModels'))}</div>`
  const discovery = editor.discovered?.length
    ? `<div class="model-discovery">
        <div class="model-discovery-head"><span>${esc(t('settings.modelCandidates'))}</span><button class="mini-btn" type="button" data-model-action="select-all">${esc(editor.discoverySelected.size === editor.discovered.length ? t('settings.modelSelectNone') : t('settings.modelSelectAll'))}</button></div>
        <div class="model-discovery-list">${editor.discovered.map((model, index) => `<label class="model-discovery-row"><input type="checkbox" data-model-candidate="${esc(model.id)}" ${editor.discoverySelected.has(model.id) ? 'checked' : ''}><code>${esc(model.id)}${model.name && model.name !== model.id ? ` · ${esc(model.name)}` : ''}</code></label>`).join('')}</div>
        <button class="mini-btn" type="button" data-model-action="add-selected" ${readOnly ? 'disabled' : ''}>${esc(t('settings.modelAddSelected'))}</button>
      </div>`
    : ''
  const effectText = editor.applies === 'restart' ? t('settings.modelRestart') : t('settings.modelLive')
  return `<div class="model-editor">
    <div class="model-editor-title"><strong>${esc(editor.displayName || editor.provider)}</strong><code>${esc(editor.provider)}</code></div>
    <div class="model-field">
      <label for="model-api-key-${esc(editor.provider)}">${esc(t('settings.modelApiKey'))}</label>
      <input id="model-api-key-${esc(editor.provider)}" class="model-input" type="password" autocomplete="off" data-model-field="apiKey" value="${esc(editor.keyDraft || '')}" placeholder="${esc(keyPlaceholder)}" ${readOnly || editor.keyWritable === false ? 'disabled' : ''}>
      ${editor.keyConfigured && editor.keyWritable !== false ? `<button class="mini-btn" type="button" data-model-action="clear-key" ${readOnly ? 'disabled' : ''}>${esc(t('settings.modelClearKey'))}</button>` : ''}
    </div>
    <div class="model-inline">
      <div class="model-field"><label for="model-base-url-${esc(editor.provider)}">${esc(t('settings.modelBaseUrl'))}</label><input id="model-base-url-${esc(editor.provider)}" class="model-input" type="url" data-model-field="baseURL" value="${esc(editor.baseURL || '')}" placeholder="${esc(t('settings.modelBaseUrlPlaceholder'))}" ${readOnly ? 'disabled' : ''}></div>
      ${editor.api ? `<div class="model-field"><span class="model-field-label">${esc(t('settings.modelProtocol'))}</span><input class="model-input" data-model-field="api" value="${esc(editor.api)}" ${readOnly ? 'disabled' : ''}></div>` : ''}
    </div>
    <div class="model-catalog">
      <div class="model-catalog-head"><div><div class="model-catalog-title">${esc(t('settings.modelCatalog'))}</div><div class="model-catalog-hint">${esc(t('settings.modelCatalogHint'))}</div></div><div class="model-catalog-actions"><button class="mini-btn" type="button" data-model-action="discover" ${readOnly || editor.busy ? 'disabled' : ''}>${esc(editor.busy ? t('settings.modelFetching') : t('settings.modelFetch'))}</button><button class="mini-btn" type="button" data-model-action="add-model" ${readOnly ? 'disabled' : ''}>${esc(t('settings.modelAdd'))}</button></div></div>
      <div class="model-list">${modelList}</div>
      ${discovery}
    </div>
    ${editor.error ? `<p class="model-editor-error">${esc(editor.error)}</p>` : ''}
    <div class="model-editor-actions"><span class="model-catalog-hint">${esc(effectText)}</span><button class="mini-btn" type="button" data-model-action="cancel">${esc(t('settings.modelCancel'))}</button><button class="mini-btn primary" type="button" data-model-action="save" ${readOnly ? 'disabled' : ''}>${esc(editor.busy ? t('settings.modelSaving') : t('settings.modelSave'))}</button></div>
  </div>`
}

function openModelEditor(provider) {
  const row = modelSettingsRow(provider)
  const namespace = row?.namespace
  if (!row || !namespace) return
  const effective = modelObjectAt(namespace.value, row.settingsPath)
  const user = modelObjectAt(namespace.user, row.settingsPath)
  state.modelEditor = {
    provider: row.provider,
    displayName: row.displayName,
    settingsNs: row.settingsNs,
    settingsPath: row.settingsPath,
    namespace,
    userProfile: user,
    effectiveProfile: effective,
    keyRef: row.keyRef || '',
    keyConfigured: row.credential?.configured === true,
    keyWritable: row.credential?.writable !== false,
    baseURL: typeof (user.baseURL ?? effective.baseURL) === 'string' ? (user.baseURL ?? effective.baseURL) : '',
    initialBaseURL: typeof user.baseURL === 'string' ? user.baseURL : '',
    api: typeof (user.api ?? effective.api) === 'string' ? (user.api ?? effective.api) : '',
    initialApi: typeof user.api === 'string' ? user.api : '',
    models: modelCatalogRows(user.models ?? effective.models),
    modelsDirty: false,
    baseURLDirty: false,
    apiDirty: false,
    keyDraft: '',
    clearKey: false,
    discovered: [],
    discoverySelected: new Set(),
    applies: namespace.applies,
    busy: false,
    error: ''
  }
  renderModelSettings()
}

function collectModelEditorForm() {
  const editor = state.modelEditor
  const root = $('model-settings-list')
  if (!editor || !root) return
  const base = root.querySelector('[data-model-field="baseURL"]')
  const api = root.querySelector('[data-model-field="api"]')
  const key = root.querySelector('[data-model-field="apiKey"]')
  if (base) editor.baseURL = base.value.trim()
  if (api) editor.api = api.value.trim()
  if (key) editor.keyDraft = key.value
  root.querySelectorAll('[data-model-field="model-id"]').forEach(input => {
    const index = Number(input.dataset.modelIndex)
    if (editor.models[index]) editor.models[index].id = input.value.trim()
  })
  root.querySelectorAll('[data-model-field="model-name"]').forEach(input => {
    const index = Number(input.dataset.modelIndex)
    if (editor.models[index]) {
      const value = input.value.trim()
      if (value) editor.models[index].name = value
      else delete editor.models[index].name
    }
  })
  editor.models.forEach((model, index) => {
    const section = root.querySelector(`[data-model-reasoning-editor="${index}"]`)
    if (!section) return
    const rows = [...section.querySelectorAll('[data-model-field="reasoning-id"]')].map((input, effortIndex) => ({
      id: input.value.trim(),
      name: section.querySelector(`[data-model-field="reasoning-name"][data-reasoning-index="${effortIndex}"]`)?.value.trim() || '',
      description: section.querySelector(`[data-model-field="reasoning-description"][data-reasoning-index="${effortIndex}"]`)?.value.trim() || ''
    }))
    const defaultEffort = section.querySelector('[data-model-field="reasoning-default"]')?.value || ''
    editor.models[index] = withModelReasoning(model, rows, defaultEffort)
  })
}

function setModelEditorError(message) {
  if (!state.modelEditor) return
  state.modelEditor.error = message || ''
  renderModelSettings()
}

async function discoverModelSettings() {
  const editor = state.modelEditor
  if (!editor || editor.busy) return
  collectModelEditorForm()
  editor.busy = true
  editor.error = ''
  renderModelSettings()
  try {
    const payload = { settingsNs: editor.settingsNs }
    if (editor.provider) payload.provider = editor.provider
    if (editor.baseURL) payload.baseURL = editor.baseURL
    if (editor.api) payload.api = editor.api
    if (editor.keyDraft.trim()) payload.apiKey = editor.keyDraft.trim()
    const value = await rpc('llm.discoverModels', payload)
    const found = Array.isArray(value?.models) ? value.models.filter(model => model && typeof model.id === 'string' && model.id.trim()) : []
    if (!found.length) throw new Error(t('settings.modelFetchEmpty'))
    const known = new Set(editor.models.map(model => model.id))
    editor.discovered = found
    editor.discoverySelected = new Set(found.filter(model => !known.has(model.id)).map(model => model.id))
  } catch (error) {
    editor.error = t('settings.modelFetchFailed', { msg: error?.message || String(error) })
  } finally {
    editor.busy = false
  }
  renderModelSettings()
}

function addDiscoveredModels() {
  const editor = state.modelEditor
  if (!editor) return
  collectModelEditorForm()
  const known = new Set(editor.models.map(model => model.id))
  for (const candidate of editor.discovered || []) {
    if (!editor.discoverySelected.has(candidate.id) || known.has(candidate.id)) continue
    editor.models.push({ id: candidate.id, ...(candidate.name ? { name: candidate.name } : {}), ...(candidate.contextWindow ? { contextWindow: candidate.contextWindow } : {}), ...(candidate.maxTokens ? { maxTokens: candidate.maxTokens } : {}) })
    known.add(candidate.id)
  }
  editor.modelsDirty = true
  editor.discovered = []
  editor.discoverySelected = new Set()
  renderModelSettings()
}

async function saveModelEditor() {
  const editor = state.modelEditor
  if (!editor || editor.busy) return
  collectModelEditorForm()
  if (!state.modelSettings.writable) return setModelEditorError(t('settings.modelReadOnly'))
  const models = editor.models || []
  if (editor.modelsDirty && models.some(model => !String(model.id || '').trim())) return setModelEditorError(t('settings.modelIdRequired'))
  const reasoningError = editor.modelsDirty ? modelReasoningError(models) : ''
  if (reasoningError) return setModelEditorError(reasoningError)
  if (editor.keyDraft.trim() && !editor.keyRef) return setModelEditorError(t('settings.modelSaveFailed', { msg: t('settings.modelApiKey') }))
  editor.busy = true
  editor.error = ''
  renderModelSettings()
  try {
    const before = editor.userProfile || {}
    const after = { ...before }
    if (editor.baseURLDirty) {
      if (editor.baseURL) after.baseURL = editor.baseURL
      else delete after.baseURL
    }
    if (editor.apiDirty) {
      if (editor.api) after.api = editor.api
      else delete after.api
    }
    if (editor.modelsDirty) after.models = models.map(model => cloneModelValue(model))
    if (editor.settingsNs === 'llm-pi-ai' && editor.keyDraft.trim() && !after.apiKeyEnv) after.apiKeyEnv = editor.keyRef
    const ops = MODEL_SETTINGS_FIELDS.flatMap(key => {
      if (!modelSettingsPathChanged(before, after, key)) return []
      const path = [...editor.settingsPath, key]
      return after[key] === undefined ? [{ op: 'unset', path }] : [{ op: 'set', path, value: after[key] }]
    })
    if (ops.length) {
      const value = await rpc('settings.mutate', { ns: editor.settingsNs, ops, expectedRevision: editor.namespace.revision })
      editor.namespace = value
    }
    if (editor.keyDraft.trim()) {
      await rpc('credentials.set', { ref: editor.keyRef, value: editor.keyDraft.trim() })
    } else if (editor.clearKey && editor.keyConfigured && editor.keyRef) {
      await rpc('credentials.unset', { ref: editor.keyRef })
    }
    state.modelEditor = null
    await loadModelSettings(true)
    toast(t('settings.modelSaved'), 'ok')
  } catch (error) {
    editor.error = t('settings.modelSaveFailed', { msg: error?.message || String(error) })
  } finally {
    if (state.modelEditor === editor) {
      editor.busy = false
      renderModelSettings()
    }
  }
}

function handleModelSettingsClick(event) {
  const action = event.target.closest('[data-model-action]')
  if (!action) return
  const type = action.dataset.modelAction
  if (type === 'edit') return openModelEditor(action.dataset.modelProvider)
  if (type === 'cancel') { state.modelEditor = null; renderModelSettings(); return }
  if (type === 'save') return void saveModelEditor()
  const editor = state.modelEditor
  if (!editor) return
  if (type === 'add-model') {
    collectModelEditorForm(); editor.models.push({ id: '' }); editor.modelsDirty = true; renderModelSettings(); return
  }
  if (type === 'remove-model') {
    collectModelEditorForm(); editor.models.splice(Number(action.dataset.modelIndex), 1); editor.modelsDirty = true; renderModelSettings(); return
  }
  if (type === 'add-reasoning') {
    collectModelEditorForm()
    const index = Number(action.dataset.modelIndex)
    const model = editor.models[index]
    if (!model) return
    const rows = modelReasoningRows(model)
    if (rows.length >= MODEL_REASONING_LIMIT) return setModelEditorError(t('settings.modelReasoningLimit', { count: MODEL_REASONING_LIMIT }))
    rows.push({ id: '', name: '', description: '' })
    editor.models[index] = withModelReasoning(model, rows, modelObjectAt(model, ['reasoning']).defaultEffort || '')
    editor.modelsDirty = true
    renderModelSettings()
    return
  }
  if (type === 'remove-reasoning') {
    collectModelEditorForm()
    const index = Number(action.dataset.modelIndex)
    const effortIndex = Number(action.dataset.reasoningIndex)
    const model = editor.models[index]
    if (!model) return
    const rows = modelReasoningRows(model)
    rows.splice(effortIndex, 1)
    editor.models[index] = withModelReasoning(model, rows, modelObjectAt(model, ['reasoning']).defaultEffort || '')
    editor.modelsDirty = true
    renderModelSettings()
    return
  }
  if (type === 'clear-reasoning') {
    collectModelEditorForm()
    const index = Number(action.dataset.modelIndex)
    const model = editor.models[index]
    if (!model) return
    editor.models[index] = withModelReasoning(model, [], '')
    editor.modelsDirty = true
    renderModelSettings()
    return
  }
  if (type === 'clear-key') { collectModelEditorForm(); editor.keyDraft = ''; editor.clearKey = true; renderModelSettings(); return }
  if (type === 'discover') return void discoverModelSettings()
  if (type === 'add-selected') return addDiscoveredModels()
  if (type === 'select-all') {
    const ids = (editor.discovered || []).map(model => model.id)
    editor.discoverySelected = editor.discoverySelected.size === ids.length ? new Set() : new Set(ids)
    renderModelSettings()
  }
}

function handleModelSettingsInput(event) {
  const editor = state.modelEditor
  if (!editor) return
  const field = event.target.dataset.modelField
  if (field === 'baseURL') editor.baseURLDirty = true
  if (field === 'api') editor.apiDirty = true
  if (field === 'model-id' || field === 'model-name' || field?.startsWith('reasoning-')) editor.modelsDirty = true
}

async function openModelConfigDocument() {
  const value = await safeRpc('settings.openDocument', {}, t('settings.modelOpenConfigFailed'))
  if (value?.opened) toast(t('settings.modelOpenedConfig'), 'ok')
}
/* ---------------- 视图切换 ---------------- */
function showView(id) {
  for (const v of ['view-home', 'view-files', 'view-session', 'view-activity', 'view-stats', 'view-settings']) $(v).classList.toggle('hidden', v !== id)
  // 离开会话页必须清掉 in-session, 否则其他页面顶栏被 body 样式隐藏
  document.body.classList.toggle('in-session', id === 'view-session')
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === id))
  window.DshMotion?.view($(id))
  window.scrollTo(0, 0)
  if (id === 'view-files' && !state.fs.loaded) {
    const workspace = workspaceById(state.fs.workspaceId)
    loadFs(workspace?.path || null, { silent: true, resetRoot: true })
  }
  if (id === 'view-stats') loadStats()
  if (id === 'view-settings') showSettingsHome()
}

const SETTINGS_GROUPS = ['general', 'model', 'tests', 'servers', 'notify', 'theme', 'about']
function showSettingsHome() {
  const home = $('settings-home')
  if (!home) return
  home.classList.remove('hidden')
  for (const name of SETTINGS_GROUPS) $('settings-page-' + name)?.classList.add('hidden')
  window.scrollTo(0, 0)
}
function showSettingsPage(name) {
  const home = $('settings-home')
  if (!home || !SETTINGS_GROUPS.includes(name)) return
  home.classList.add('hidden')
  for (const g of SETTINGS_GROUPS) $('settings-page-' + g)?.classList.toggle('hidden', g !== name)
  window.scrollTo(0, 0)
  if (name === 'model') void loadModelSettings()
}

function updateConn() {
  const el = $('conn-badge')
  // mux/host 的打开顺序不稳定；连接状态改变时同步重绘总览，避免后打开的
  // 通道只更新顶栏、总览却永久停留在 3/4。
  renderOverview()
  const cur = currentServerEntry()
  const ms = cur ? state.serverLatency[serverKey(cur)] : undefined
  const curGroup = cur ? cur.group : state.activeGroup
  const curLabel = cur ? (cur.note || cur.url) : (state.server || t('speed.origin'))
  const titleBase = t('conn.titleGroup', { group: curGroup, url: curLabel, ms: Number.isFinite(ms) ? ms + 'ms' : '—' })
  if (!navigator.onLine) {
    el.textContent = t('conn.offline')
    el.className = 'topbar-btn conn-badge off'
    el.title = titleBase
    return
  }
  if (state.streamMode === 'poll') {
    el.textContent = t('conn.poll')
    el.className = 'topbar-btn conn-badge off'
    el.title = t('conn.pollTitle') + ' · ' + titleBase
    return
  }
  const ok = !!state.streamsOk?.mux
  if (!ok && reconnectInfo) {
    const remain = Math.max(0, Math.ceil((reconnectInfo.at - Date.now()) / 1000))
    el.textContent = remain > 0 ? t('conn.reconnectIn', { n: remain }) : t('conn.reconnecting')
    el.className = 'topbar-btn conn-badge off'
    el.title = t('conn.reconnecting') + ' · ' + titleBase
    return
  }
  if (!ok && state.errCount > 0) {
    el.textContent = t('conn.failed')
    el.className = 'topbar-btn conn-badge off'
    el.title = titleBase
    return
  }
  el.textContent = ok ? t('conn.on') : t('conn.off')
  el.className = 'topbar-btn conn-badge ' + (ok ? 'on' : 'off')
  el.title = titleBase
}

function autosize(el) {
  // 全屏编辑时 textarea 由 flex 容器提供整块高度；普通的 120px 限高
  // 不能覆盖这里，否则输入超过约五行后会被重新压回小输入框。
  if (el?.id === 'composer-input' && $('composer-wrap')?.classList.contains('fs')) {
    el.style.height = '100%'
    updateComposerFullscreenButton()
    return
  }
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  if (el.id === 'composer-input') updateComposerFullscreenButton()
}

function updateComposerFullscreenButton() {
  const input = $('composer-input')
  const wrap = $('composer-wrap')
  const button = $('btn-fs-toggle')
  if (!input || !wrap || !button) return
  const active = wrap.classList.contains('fs')
  const shouldShow = active || input.scrollHeight > 120
  button.classList.toggle('hidden', !shouldShow)
  $('composer-input-wrap')?.classList.toggle('has-fs-btn', shouldShow)
  $('fs-ico')?.setAttribute('data-morph-state', active ? 'open' : 'closed')
  button.title = t(active ? 'composer.exitFullscreen' : 'composer.fullscreen')
  button.setAttribute('aria-label', t(active ? 'composer.exitFullscreen' : 'composer.fullscreen'))
}

function setComposerFullscreen(on) {
  const wrap = $('composer-wrap')
  if (!wrap) return
  $('btn-stats')?.classList.toggle('hidden', !!on)
  $('btn-fs-send')?.classList.toggle('hidden', !on)
  if (on) {
    $('composer-image-menu')?.classList.add('hidden')
    $('btn-image')?.classList.remove('active')
  }
  wrap.classList.toggle('fs', !!on)
  document.body.classList.toggle('composer-fullscreen', !!on)
  if (on) {
    $('composer-input')?.style.removeProperty('height')
  } else {
    wrap.style.transform = ''
    wrap.classList.remove('dragging')
    autosize($('composer-input'))
  }
  updateComposerFullscreenButton()
}

function bindComposerFullscreenGesture() {
  const handle = $('composer-fs-handle')
  if (!handle) return
  let startY = 0
  let tracking = false
  handle.addEventListener('touchstart', e => {
    if (!$('composer-wrap').classList.contains('fs') || e.touches.length !== 1) return
    tracking = true
    startY = e.touches[0].clientY
  }, { passive: true })
  handle.addEventListener('touchmove', e => {
    if (!tracking || e.touches.length !== 1) return
    const dy = e.touches[0].clientY - startY
    if (dy <= 0) return
    e.preventDefault()
    $('composer-wrap').classList.add('dragging')
    $('composer-wrap').style.transform = `translateY(${Math.min(dy, 180)}px)`
  }, { passive: false })
  const finish = () => {
    if (!tracking) return
    const wrap = $('composer-wrap')
    const transform = wrap.style.transform.match(/translateY\(([-\d.]+)px\)/)
    const dy = transform ? Number(transform[1]) : 0
    tracking = false
    wrap.classList.remove('dragging')
    if (dy > 60) setComposerFullscreen(false)
    else wrap.style.transform = ''
  }
  handle.addEventListener('touchend', finish, { passive: true })
  handle.addEventListener('touchcancel', finish, { passive: true })
}

/* ---------------- 初始化 ---------------- */
/** 解析 dshremote://pair?token=..&server=.. 配对二维码；server 可重复以携带多个主机地址。 */
function applyPairUrl(url) {
  try {
    const u = new URL(String(url).trim())
    if (u.protocol !== 'dshremote:' || u.hostname !== 'pair') return false
    const tok = (u.searchParams.get('token') || '').trim()
    const servers = [...new Set(u.searchParams.getAll('server')
      .map(value => value.trim().replace(/\/+$/, ''))
      .filter(value => /^https?:\/\//i.test(value)))]
    if (!tok || !servers.length) return false
    const previousServer = state.server
    const previousToken = state.token
    state.token = tok
    LS.set('token', tok)
    for (let i = servers.length - 1; i >= 0; i--) {
      const server = servers[i]
      if (!state.servers.some(s => s.url === server && normalizedServerToken(s.token) === tok)) {
        state.servers.unshift({ id: newServerId(), url: server, note: '', group: state.activeGroup, token: tok })
      }
    }
    const first = state.servers.find(s => s.url === servers[0] && normalizedServerToken(s.token) === tok)
    if (!first) return false
    if (previousServer !== first.url || previousToken !== tok) resetFsForServer()
    state.server = first.url
    state.token = tok
    if (!state.groupActive || typeof state.groupActive !== 'object') state.groupActive = {}
    state.groupActive[state.activeGroup] = first.id
    saveServers()
    renderServers()
    $('token-desc').textContent = t('token.savedScan')
    syncBgConfig()
    return true
  } catch {
    return false
  }
}

/** 拍照/相册得到的 dataUrl → 画到 canvas → jsQR 纯本地解码(不依赖任何谷歌服务) */
async function decodeQrDataUrl(dataUrl) {
  const img = new Image()
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error(t('scan.imageLoadFailed')))
    img.src = dataUrl
  })
  const maxSide = 1600
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error(t('scan.decodeUnsupported'))
  ctx.drawImage(img, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const code = window.jsQR?.(imageData.data, w, h, { inversionAttempts: 'attemptBoth' })
  return code?.data || ''
}

let liveScanStream = null
let liveScanTimer = null
let liveScanResolve = null
let liveScanCanvas = null
let liveScanContext = null
let liveScanCancelled = false
let liveScanDetector = null
let liveScanBusy = false
let liveScanWorker = null
let liveScanWorkerUrl = ''
let liveScanWorkerResolve = null

function stopLiveScanWorker() {
  liveScanWorkerResolve?.('')
  liveScanWorkerResolve = null
  liveScanWorker?.terminate()
  liveScanWorker = null
  if (liveScanWorkerUrl) URL.revokeObjectURL(liveScanWorkerUrl)
  liveScanWorkerUrl = ''
}

function startLiveScanWorker() {
  if (!window.Worker || !window.Blob || !window.URL?.createObjectURL) return
  try {
    const sourceUrl = new URL('jsqr.min.js', document.baseURI).href
    const workerSource = `
      let loaded = false
      self.onmessage = event => {
        try {
          if (!loaded) {
            self.importScripts(${JSON.stringify(sourceUrl)})
            loaded = true
          }
          const { data, width, height } = event.data || {}
          const code = self.jsQR?.(data, width, height, { inversionAttempts: 'attemptBoth' })
          self.postMessage({ raw: code?.data || '' })
        } catch (error) {
          self.postMessage({ raw: '', error: String(error?.message || error) })
        }
      }
    `
    liveScanWorkerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }))
    liveScanWorker = new Worker(liveScanWorkerUrl)
    liveScanWorker.onmessage = event => {
      const resolve = liveScanWorkerResolve
      liveScanWorkerResolve = null
      resolve?.(event.data?.raw || '')
    }
    liveScanWorker.onerror = () => {
      const resolve = liveScanWorkerResolve
      liveScanWorkerResolve = null
      resolve?.('')
      stopLiveScanWorker()
    }
  } catch {
    stopLiveScanWorker()
  }
}

function closeLiveScan(result = '') {
  liveScanCancelled = true
  if (liveScanTimer) clearTimeout(liveScanTimer)
  liveScanTimer = null
  if (liveScanStream) liveScanStream.getTracks().forEach(track => track.stop())
  liveScanStream = null
  liveScanDetector = null
  stopLiveScanWorker()
  const video = $('scan-live-video')
  if (video) video.srcObject = null
  $('modal-scan-live')?.classList.add('hidden')
  const resolve = liveScanResolve
  liveScanResolve = null
  resolve?.(result)
}

async function scanLiveFrame() {
  if (!liveScanResolve) return
  const video = $('scan-live-video')
  if (!video || video.readyState < 2 || !video.videoWidth || !liveScanContext) {
    liveScanTimer = setTimeout(scanLiveFrame, 180)
    return
  }
  if (liveScanBusy) return
  liveScanBusy = true
  try {
    let raw = ''
    if (liveScanDetector) {
      const codes = await liveScanDetector.detect(video)
      raw = codes?.[0]?.rawValue || ''
    } else {
      // 只解码取景框中央区域，避免在低端手机上对整幅高分辨率画面反复二值化。
      const side = Math.floor(Math.min(video.videoWidth, video.videoHeight) * 0.64)
      const sx = Math.floor((video.videoWidth - side) / 2)
      const sy = Math.floor((video.videoHeight - side) / 2)
      const maxSide = 480
      const scale = Math.min(1, maxSide / Math.max(1, side))
      const w = Math.max(1, Math.round(side * scale))
      const h = w
      if (liveScanCanvas.width !== w || liveScanCanvas.height !== h) {
        liveScanCanvas.width = w
        liveScanCanvas.height = h
      }
      liveScanContext.drawImage(video, sx, sy, side, side, 0, 0, w, h)
      const imageData = liveScanContext.getImageData(0, 0, w, h)
      if (liveScanWorker) {
        raw = await new Promise(resolve => {
          liveScanWorkerResolve = resolve
          liveScanWorker.postMessage({ data: imageData.data, width: w, height: h }, [imageData.data.buffer])
        })
      } else {
        raw = window.jsQR?.(imageData.data, w, h, { inversionAttempts: 'attemptBoth' })?.data || ''
      }
    }
    if (raw && liveScanResolve) return closeLiveScan(raw)
  } catch {
    // 摄像头帧在切后台或权限切换时可能暂时不可读，下一帧继续即可。
  } finally {
    liveScanBusy = false
  }
  if (liveScanResolve) liveScanTimer = setTimeout(scanLiveFrame, 180)
}

/** 打开持续取帧的本地摄像头扫码；返回 undefined 表示当前 WebView 不支持实时摄像头。 */
async function scanPairLive() {
  if (!navigator.mediaDevices?.getUserMedia) return undefined
  const video = $('scan-live-video')
  const modal = $('modal-scan-live')
  if (!video || !modal || !window.jsQR) return undefined
  const camera = CAP.Plugins?.Camera
  const perm = await camera?.requestPermissions?.({ permissions: ['camera'] })
  if (perm && perm.camera !== 'granted') throw new Error(t('scan.permissionDenied'))
  liveScanCancelled = false
  modal.classList.remove('hidden')
  $('scan-live-status').textContent = t('scan.liveStarting')
  try {
    liveScanStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 960, max: 1280 },
        height: { ideal: 720, max: 1280 },
        frameRate: { ideal: 24, max: 30 }
      }
    })
    if (liveScanCancelled) {
      liveScanStream.getTracks().forEach(track => track.stop())
      liveScanStream = null
      return ''
    }
    video.srcObject = liveScanStream
    await video.play()
    $('scan-live-status').textContent = t('scan.liveHint')
    try {
      if (window.BarcodeDetector) {
        const formats = await window.BarcodeDetector.getSupportedFormats?.()
        if (!formats || formats.includes('qr_code')) liveScanDetector = new window.BarcodeDetector({ formats: ['qr_code'] })
      }
    } catch { liveScanDetector = null }
    liveScanCanvas = document.createElement('canvas')
    liveScanContext = liveScanCanvas.getContext('2d', { willReadFrequently: true })
    if (!liveScanContext) throw new Error(t('scan.decodeUnsupported'))
    startLiveScanWorker()
    return await new Promise(resolve => {
      liveScanResolve = resolve
      scanLiveFrame()
    })
  } catch (e) {
    closeLiveScan('')
    throw e
  } finally {
    liveScanCanvas = null
    liveScanContext = null
    liveScanDetector = null
    liveScanBusy = false
  }
}

/** App 内扫码优先使用实时摄像头取帧；不支持时回退到官方 Camera 拍照/相册 + jsQR。 */
async function scanPair(source) {
  if (!CAP?.isNativePlatform?.()) {
    toast(t('scan.browserHint'), 'err')
    return
  }
  if (source === 'CAMERA') {
    try {
      const liveRaw = await scanPairLive()
      if (liveRaw !== undefined) {
        if (!liveRaw) return toast(t('scan.cancelled'), 'ok')
        if (applyPairUrl(liveRaw)) {
          toast(t('scan.paired'), 'ok')
          openStreams()
          refreshAll()
        } else toast(t('scan.notPair'), 'err')
        return
      }
    } catch (e) {
      const msg = String(e?.message || e || '')
      toast(/cancel/i.test(msg) ? t('scan.cancelled') : t('scan.failed', { msg }), 'err')
      return
    }
  }
  const camera = CAP.Plugins?.Camera
  if (!camera?.getPhoto) { toast(t('scan.unsupported'), 'err'); return }
  try {
    // 显式指定来源绕过 PROMPT: 小米/HyperOS 的 PROMPT 选择器会错乱(选拍照开相册/选相册开相机)
    if (source === 'CAMERA') {
      const perm = await camera.requestPermissions?.({ permissions: ['camera'] })
      if (perm && perm.camera !== 'granted') { toast(t('scan.permissionDenied'), 'err'); return }
    }
    const photo = await camera.getPhoto({
      resultType: 'dataUrl',
      source: source === 'PHOTOS' ? 'PHOTOS' : 'CAMERA',
      quality: 85,
      correctOrientation: true,
      saveToGallery: false,
    })
    if (!photo?.dataUrl) { toast(t('scan.noPhoto'), 'err'); return }
    const raw = await decodeQrDataUrl(photo.dataUrl)
    if (!raw) { toast(t('scan.noQr'), 'err'); return }
    if (applyPairUrl(raw)) {
      toast(t('scan.paired'), 'ok')
      openStreams()
      refreshAll()
    } else {
      toast(t('scan.notPair'), 'err')
    }
  } catch (e) {
    const msg = String(e?.message || e || '')
    toast(/cancel/i.test(msg) ? t('scan.cancelled') : t('scan.failed', { msg }), 'err')
  }
}

/** 系统相机/浏览器扫码后通过 dshremote:// 链接唤起 App: 这里接住并配对 */
function bindNativeLinks() {
  if (!CAP?.isNativePlatform?.()) return
  try {
    CAP.Plugins?.App?.addListener?.('appUrlOpen', (data) => {
      if (data?.url && applyPairUrl(data.url)) {
        toast(t('scan.pairedLink'), 'ok')
        openStreams()
        refreshAll()
      }
    })
    CAP.Plugins?.App?.getLaunchUrl?.().then((data) => {
      if (data?.url) applyPairUrl(data.url)
    }).catch(() => {})
  } catch {}
}

function initToken() {
  const urlToken = new URLSearchParams(location.search).get('token')
  if (urlToken) {
    state.token = urlToken
    LS.set('token', urlToken)
    history.replaceState(null, '', location.pathname) // URL 里不留下 token
  } else {
    state.token = LS.get('token', '')
  }
  loadServers()
  if (urlToken) {
    state.token = normalizedServerToken(urlToken)
    LS.set('token', state.token)
    const currentId = state.groupActive[state.activeGroup]
    const current = state.servers.find(s => s.id === currentId) || state.servers.find(s => s.url === state.server)
    if (current) current.token = state.token
    saveServers()
  }
  $('token-desc').textContent = state.token ? t('token.savedLocal') : t('token.notSet')
  $('server-desc').textContent = state.server || t('servers.defaultDesc')
}

let dshControlPollPromise = null

function dshControlButtonsBusy(busy, supported = true) {
  const buttons = [$('btn-dsh-start'), $('btn-dsh-restart')].filter(Boolean)
  buttons.forEach(button => {
    button.disabled = busy || !supported
    button.classList.toggle('hidden', !supported)
  })
}

function dshControlFailureText(value) {
  const key = {
    SERVICE_NOT_FOUND: 'settings.dshErrorServiceNotFound',
    INVALID_SERVICE: 'settings.dshErrorInvalidService',
    SYSTEMCTL_NOT_FOUND: 'settings.dshErrorSystemctlNotFound',
    SYSTEMD_UNAVAILABLE: 'settings.dshErrorSystemdUnavailable',
    SERVICE_CONTROL_NOT_FOUND: 'settings.dshErrorServiceControlNotFound',
    SERVICE_DISABLED: 'settings.dshErrorServiceDisabled',
    SERVICE_STOP_TIMEOUT: 'settings.dshErrorServiceStopTimeout',
    STATUS_PARSE_FAILED: 'settings.dshErrorStatusParseFailed',
    PERMISSION_DENIED: 'settings.dshErrorPermissionDenied',
    COMMAND_TIMEOUT: 'settings.dshErrorCommandTimeout',
    COMMAND_FAILED: 'settings.dshErrorCommandFailed',
    SERVICE_FAILED: 'settings.dshErrorServiceFailed',
    SERVICE_TIMEOUT: 'settings.dshErrorServiceTimeout',
    UPSTREAM_TIMEOUT: 'settings.dshErrorUpstreamTimeout',
    EVENTS_TIMEOUT: 'settings.dshErrorEventsTimeout',
    OPERATION_NOT_FOUND: 'settings.dshErrorOperationNotFound',
    OPERATION_IN_PROGRESS: 'settings.dshErrorOperationProgress',
  }[value?.code]
  return key
    ? t(key, { service: value?.service || value?.status?.service || 'dsh-web' })
    : t('settings.dshErrorGeneric', { msg: value?.error || value?.message || value?.code || t('conn.off') })
}

function dshControlStageText(operation, step = operation) {
  const seconds = Math.max(0, Math.round(Number(step?.elapsedMs ?? operation?.elapsedMs ?? 0) / 1000))
  const action = operation?.action === 'start' ? t('settings.dshStart') : t('settings.dshRestart')
  const service = operation?.service || operation?.status?.service || 'dsh-web'
  if (step?.stage === 'queued') return t('settings.dshStageQueued')
  if (step?.stage === 'checking') return t('settings.dshStageChecking', { service })
  if (step?.stage === 'command') return t('settings.dshStageCommand', { action })
  if (step?.stage === 'waiting-service') return t('settings.dshStageWaitingService', { seconds })
  if (step?.stage === 'waiting-upstream') return t('settings.dshStageWaitingUpstream', { seconds })
  if (step?.stage === 'waiting-events') return t('settings.dshStageWaitingEvents', { seconds })
  if (step?.stage === 'complete') {
    if (operation?.code === 'ALREADY_RUNNING') return t('settings.dshAlreadyRunning', { pid: operation?.status?.mainPid || '—' })
    return t('settings.dshSuccessDetail', {
      action,
      pid: operation?.status?.mainPid || '—',
      status: operation?.upstream?.status || '—',
      seconds: Math.max(0, Math.round(Number(operation?.elapsedMs || step?.elapsedMs || 0) / 1000)),
    })
  }
  if (step?.stage === 'failed') return dshControlFailureText(operation)
  return step?.message || operation?.message || '—'
}

function renderDshControlOperation(operation) {
  const desc = $('dsh-control-desc')
  const box = $('dsh-control-steps')
  if (!desc || !box || !operation) return
  const failed = operation.stage === 'failed' || operation.done && operation.ok === false
  desc.textContent = failed ? t('settings.dshFailed', { msg: dshControlFailureText(operation) }) : dshControlStageText(operation)
  const steps = Array.isArray(operation.steps) && operation.steps.length
    ? operation.steps
    : [{ stage: operation.stage || 'queued', elapsedMs: operation.elapsedMs || 0, message: operation.message || '' }]
  box.classList.remove('hidden')
  box.innerHTML = steps.map((step, index) => {
    const current = !operation.done && index === steps.length - 1
    const isFailed = step.stage === 'failed'
    const success = step.stage === 'complete'
    const mark = isFailed ? '×' : success ? '✓' : current ? '…' : '✓'
    const cls = isFailed ? 'failed' : success ? 'success' : current ? 'current' : ''
    const detail = isFailed && operation.detail
      ? `<span class="dsh-control-step-detail">${esc(t('settings.dshErrorDetail', { detail: operation.detail }))}</span>`
      : ''
    return `<div class="dsh-control-step ${cls}"><span class="dsh-control-step-mark" aria-hidden="true">${mark}</span><span>${esc(dshControlStageText(operation, step))}</span>${detail}</div>`
  }).join('')
  dshControlButtonsBusy(!operation.done, true)
}

async function readDshControlResponse(res) {
  const text = await res.text()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { error: `HTTP ${res.status}`, detail: text.slice(0, 500) } }
}

async function pollDshControlOperation(operationId, initial) {
  let value = initial
  while (true) {
    renderDshControlOperation(value)
    if (value.done) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 700))
    const res = await fetch(adminApiUrl(`/admin/api/dsh?operation=${encodeURIComponent(operationId)}`), {
      headers: { authorization: 'Bearer ' + state.token }, cache: 'no-store'
    })
    if (res.status === 401) { authFailure(); throw Object.assign(new Error('unauthorized'), { auth: true }) }
    const next = await readDshControlResponse(res)
    if (!res.ok) throw Object.assign(new Error(next.error || next.message || `HTTP ${res.status}`), { dshPayload: { ...next, httpStatus: res.status } })
    value = next
  }
}

function renderDshControlStatus(value) {
  const desc = $('dsh-control-desc')
  const box = $('dsh-control-steps')
  if (!desc || !value) return
  if (value.supported === false) {
    desc.textContent = value.code ? dshControlFailureText(value) : value.message || t('settings.dshUnsupported')
    dshControlButtonsBusy(false, false)
    return
  }
  if (value.ok === false) {
    desc.textContent = t('settings.dshStatusFailed', { msg: dshControlFailureText(value) })
    dshControlButtonsBusy(false, false)
    return
  }
  dshControlButtonsBusy(false, true)
  if (box && !dshControlPollPromise) box.classList.add('hidden')
  const service = value.service || 'dsh-web'
  const serviceState = `${value.activeState || value.state || 'unknown'}/${value.subState || 'unknown'}`
  desc.textContent = value.running
    ? t('settings.dshRunningDetail', { service, pid: value.mainPid || '—', state: serviceState })
    : t('settings.dshStoppedDetail', { service, state: serviceState })
}

async function loadDshControl() {
  if (!state.token || !$('dsh-control-desc')) return
  if (activeGatewayCapability('dshLifecycle') === false) {
    renderDshControlStatus({
      supported: false,
      message: activeGatewayHealth()?.dshControl?.message || t('settings.dshUnsupported')
    })
    return
  }
  try {
    const res = await fetch(adminApiUrl('/admin/api/dsh'), { headers: { authorization: 'Bearer ' + state.token }, cache: 'no-store' })
    if (res.status === 401) return authFailure()
    const value = await readDshControlResponse(res)
    if (!res.ok) throw Object.assign(new Error(value.error || value.message || `HTTP ${res.status}`), { dshPayload: value })
    renderDshControlStatus(value)
    if (value.operation?.operationId && !value.operation.done && !dshControlPollPromise) {
      dshControlPollPromise = pollDshControlOperation(value.operation.operationId, value.operation)
        .then(renderDshControlOperation)
        .catch(error => {
          if (!error?.auth) $('dsh-control-desc').textContent = t('settings.dshFailed', { msg: error?.dshPayload ? dshControlFailureText(error.dshPayload) : t('settings.dshResultUnknown') })
        })
        .finally(() => { dshControlPollPromise = null; dshControlButtonsBusy(false, true) })
    }
  } catch (error) {
    $('dsh-control-desc').textContent = t('settings.dshStatusFailed', { msg: error?.dshPayload ? dshControlFailureText(error.dshPayload) : t('conn.off') })
  }
}

async function controlDsh(action) {
  if (dshControlPollPromise) return
  const label = action === 'start' ? t('settings.dshStart') : t('settings.dshRestart')
  dshControlButtonsBusy(true, true)
  renderDshControlOperation({ action, service: 'dsh-web', accepted: true, done: false, stage: 'queued', elapsedMs: 0, steps: [] })
  try {
    const res = await fetch(adminApiUrl('/admin/api/dsh'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    if (res.status === 401) return authFailure()
    let v = await readDshControlResponse(res)
    if (res.status === 409 && v.operation?.operationId) v = v.operation
    else if (!res.ok) throw Object.assign(new Error(v.error || v.message || `HTTP ${res.status}`), { dshPayload: { ...v, httpStatus: res.status } })

    if (v.accepted && v.operationId) {
      dshControlPollPromise = pollDshControlOperation(v.operationId, v)
      v = await dshControlPollPromise
      if (!v.ok) throw Object.assign(new Error(dshControlFailureText(v)), { dshPayload: v })
      renderDshControlOperation(v)
      toast(dshControlStageText(v), 'ok')
      return
    }

    // 兼容旧网关：它会在单个 POST 中直接返回最终状态。
    if (v.ok === false) throw Object.assign(new Error(v.error || v.message || `HTTP ${res.status}`), { dshPayload: v })
    renderDshControlStatus(v)
    toast(t('settings.dshStarted', { action: label }), 'ok')
  } catch (error) {
    if (error?.auth) return
    const payload = error?.dshPayload
    const message = payload ? dshControlFailureText(payload) : t('settings.dshResultUnknown')
    if (payload) renderDshControlOperation({ action, service: payload.service || 'dsh-web', done: true, ok: false, stage: 'failed', steps: payload.steps || [], ...payload })
    else $('dsh-control-desc').textContent = t('settings.dshFailed', { msg: message })
    toast(t('settings.dshFailed', { msg: message }), 'err')
  } finally {
    dshControlPollPromise = null
    dshControlButtonsBusy(false, true)
  }
}

function renderLangBtn() {
  const btn = $('btn-lang')
  if (btn) btn.textContent = I18N.lang === 'zh' ? 'EN' : '中文'
}

const THEME_META = [
  { id: 'default', sw: ['#0B0E1A', '#151B33', '#5B8CFF'] },
  { id: 'dark', sw: ['#05348B', '#0D438F', '#F9A647'] },
  { id: 'light', sw: ['#EFEEEC', '#FAF8F5', '#E6BC7B'] },
  { id: 'neutral', sw: ['#DDD4B8', '#585818', '#832D15'] }
]

function renderThemeBtn() {
  const btn = $('btn-theme')
  if (btn) btn.textContent = t('theme.' + window.DSHTheme.get())
}

function renderThemeOptions() {
  const box = $('theme-options')
  if (!box) return
  const cur = window.DSHTheme.get()
  box.innerHTML = THEME_META.map(m => `
    <button class="theme-option ${m.id === cur ? 'current' : ''}" data-theme="${m.id}" title="${t('theme.' + m.id)}">
      <span class="theme-swatches">${m.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      <span class="theme-name">${t('theme.' + m.id)}</span>
      <span class="theme-check">${m.id === cur ? '✓' : ''}</span>
    </button>`).join('')
  box.querySelectorAll('.theme-option').forEach(btn =>
    btn.addEventListener('click', () => {
      window.DSHTheme.set(btn.dataset.theme)
      renderThemeBtn()
      renderThemeOptions()
      $('modal-theme').classList.add('hidden')
    }))
}

function openThemePanel() {
  renderThemeOptions()
  $('modal-theme').classList.remove('hidden')
}

function openDonateModal() {
  const m = $('modal-donate')
  if (m) m.classList.remove('hidden')
}

function bindUi() {
  renderLangBtn()
  renderThemeBtn()
  $('btn-lang').addEventListener('click', () => {
    I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh')
    renderLangBtn()
    renderThemeBtn()
    renderUpdateExpandBtn()
    renderServers()
    renderSessions()
    renderWorkbench()
    renderAnnouncementBoard()
    renderPending(); renderQueue(); renderJobs()
    updateConn()
    if (state.modelSettings.status === 'ready' || state.modelSettings.status === 'error' || state.modelSettings.status === 'loading') renderModelSettings()
    renderAsrTest()
    if (state.current) { renderSessionTitle(); renderSessionSub(); renderSessionCards(); renderHistory(true) }
    else renderModelMenu()
    loadLocalVersion()
    if (state.hostInfo) $('host-desc').textContent = t('settings.hostDesc', { version: state.hostInfo.version, cwd: state.hostInfo.cwd, n: state.hostInfo.attachedSessions })
    $('token-desc').textContent = state.token ? t('token.savedLocal') : t('token.notSet')
  })
  $('btn-theme').addEventListener('click', openThemePanel)
  $('theme-close').addEventListener('click', () => $('modal-theme').classList.add('hidden'))
  $('btn-donate').addEventListener('click', openDonateModal)
  $('donate-close').addEventListener('click', () => $('modal-donate').classList.add('hidden'))
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-donate-open]')) openDonateModal()
  })
  // 更新内容弹窗
  $('notes-close').addEventListener('click', closeNotesModal)
  $('notes-prev').addEventListener('click', () => scrollNotes(-1))
  $('notes-next').addEventListener('click', () => scrollNotes(1))
  $('notes-pages').addEventListener('scroll', updateNotesPage)
  $('modal-notes').addEventListener('click', (e) => { if (e.target === $('modal-notes')) closeNotesModal() })
  renderServers()
  document.querySelectorAll('[data-stats-mode]').forEach(button =>
    button.addEventListener('click', () => setStatsChartMode(button.dataset.statsMode)))
  applyStatsChartMode()
  // 底部导航
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => showView(b.dataset.view)))
  $('overview-primary-action').addEventListener('click', () => {
    const button = $('overview-primary-action')
    const action = button.dataset.overviewAction
    if (action === 'session' && button.dataset.overviewSession) return openSession(button.dataset.overviewSession)
    if (action === 'new') return newSession()
    if (action === 'settings') return showView('view-settings')
    if (action === 'refresh') return openStreams()
    const first = document.querySelector('.overview-attention-item')
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (first.matches('button')) first.focus({ preventScroll: true })
    }
  })
  // 会话列表点击
  $('session-list').addEventListener('click', (e) => {
    if (swipeSuppressClickUntil > Date.now()) { swipeSuppressClickUntil = 0; return }
    if (e.target.closest('[data-archived-toggle]')) {
      LS.set('showArchivedV1', LS.get('showArchivedV1', '0') === '1' ? '0' : '1')
      renderSessions()
      return
    }
    const archive = e.target.closest('[data-archive-session]')
    if (archive) {
      e.stopPropagation()
      archiveSession(archive.dataset.archiveSession)
      return
    }
    const swipeRow = e.target.closest('[data-session-swipe]')
    if (swipeRow?.classList.contains('revealed')) {
      swipeRow.classList.remove('revealed')
      return
    }
    const card = e.target.closest('[data-id]')
    if (card) openSession(card.dataset.id)
  })
  bindSessionSwipe()
  $('wb-toggle').addEventListener('click', () => {
    if (!state.wb?.bound) return
    state.wbOpen = !state.wbOpen
    renderWorkbench()
  })
  $('wb-panel').addEventListener('click', (e) => {
    const archive = e.target.closest('[data-archive-session]')
    if (archive) {
      e.stopPropagation()
      archiveSession(archive.dataset.archiveSession)
      return
    }
    const newButton = e.target.closest('[data-wb-new]')
    if (newButton) {
      safeRpc('session.create', { workspaceId: newButton.dataset.wbNew }, t('home.createFailed')).then(async v => {
        if (!v?.sessionId) return
        state.workspaceFilter = newButton.dataset.wbNew
        LS.set('workspaceFilterV1', state.workspaceFilter)
        toast(t('home.created'), 'ok')
        await refreshSessions()
        openSession(v.sessionId)
      })
      return
    }
    const head = e.target.closest('.wb-project-head')
    if (head) {
      const project = head.closest('[data-wb-project]')
      const id = project?.dataset.wbProject
      if (id) { state.wbOpenProjects[id] = !state.wbOpenProjects[id]; renderWorkbench() }
      return
    }
    const session = e.target.closest('[data-wb-session]')
    if (session) openSession(session.dataset.wbSession)
  })
  $('btn-back').addEventListener('click', () => { void closeSession() })
  $('btn-stats').addEventListener('click', () => { renderSessionCards(); $('modal-stats').classList.remove('hidden') })
  $('stats-close').addEventListener('click', () => $('modal-stats').classList.add('hidden'))
  $('btn-refresh').addEventListener('click', () => { toast(t('common.refreshing')); openStreams(); refreshAll() })
  $('overview-refresh').addEventListener('click', () => {
    toast(t('common.refreshing'))
    openStreams()
    void Promise.all([refreshAll(), checkAnnouncements()])
  })
  // 反馈
  $('btn-feedback').addEventListener('click', (e) => { e.stopPropagation(); toggleFeedbackSheet() })
  $('feedback-backdrop').addEventListener('click', closeFeedbackSheet)
  $('feedback-sheet').addEventListener('click', (e) => {
    if (e.target.closest('a[role="menuitem"]')) closeFeedbackSheet()
  })
  $('btn-copy-link').addEventListener('click', async () => {
    const ok = await copyText(FEEDBACK_LINKS.repo)
    toast(t(ok ? 'feedback.copied' : 'feedback.copyFailed'), ok ? 'ok' : 'err')
    closeFeedbackSheet()
  })
  $('btn-write-feedback').addEventListener('click', () => { closeFeedbackSheet(); openFeedbackModal() })
  $('fb-cancel').addEventListener('click', closeFeedbackModal)
  $('fb-submit').addEventListener('click', submitFeedback)
  $('feedback-success-confirm').addEventListener('click', closeFeedbackSuccess)
  $('modal-feedback-success').addEventListener('click', (e) => {
    if (e.target === $('modal-feedback-success')) closeFeedbackSuccess()
  })
  document.querySelectorAll('#fb-chips .fb-chip').forEach(btn =>
    btn.addEventListener('click', () => {
      state.feedbackType = btn.dataset.fbType
      document.querySelectorAll('#fb-chips .fb-chip').forEach(b => b.classList.toggle('current', b === btn))
    }))
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#feedback-sheet') && !e.target.closest('#btn-feedback')) closeFeedbackSheet()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('feedback-sheet').classList.contains('hidden')) { closeFeedbackSheet(); $('btn-feedback').focus() }
    else if (e.key === 'Escape' && !$('modal-feedback-success').classList.contains('hidden')) closeFeedbackSuccess()
    else if (e.key === 'Escape' && isAppVersionWarningOpen()) closeAppVersionWarning(false)
  })
  $('btn-new-session').addEventListener('click', newSession)
  $('session-workspace-filter').addEventListener('change', (e) => {
    state.workspaceFilter = e.target.value
    if (state.workspaceFilter) LS.set('workspaceFilterV1', state.workspaceFilter)
    else LS.del('workspaceFilterV1')
    renderWorkspaceNavigation()
    renderSessions()
  })
  $('session-workspace-files').addEventListener('click', () => openWorkspaceFiles(state.workspaceFilter))
  $('new-session-workspace').addEventListener('change', (e) => renderNewSessionWorkspace(e.target.value))
  $('new-session-cancel').addEventListener('click', closeNewSessionModal)
  $('new-session-create').addEventListener('click', createSessionInWorkspace)
  $('modal-new-session').addEventListener('click', (e) => { if (e.target === $('modal-new-session')) closeNewSessionModal() })
  $('btn-new-workspace').addEventListener('click', openWorkspaceModal)
  $('session-sort')?.addEventListener('change', (e) => {
    state.sessionSort = e.target.value === 'workspace' ? 'workspace' : 'time'
    LS.set('sessionSort', state.sessionSort)
    renderSessions()
  })
  $('fs-workspace').addEventListener('change', (e) => {
    const rootMatch = /^__fs_root__:(\d+)$/.exec(e.target.value)
    if (rootMatch) {
      state.fs.rootIndex = Math.min(Number(rootMatch[1]), Math.max(0, state.fs.roots.length - 1))
      state.fs.workspaceId = ''
    } else {
      state.fs.rootIndex = 0
      state.fs.workspaceId = e.target.value
    }
    if (state.fs.workspaceId) LS.set('fsWorkspaceIdV1', state.fs.workspaceId)
    else LS.del('fsWorkspaceIdV1')
    state.fs.loaded = false
    const workspace = workspaceById(state.fs.workspaceId)
    const rootPath = !workspace && rootMatch ? state.fs.roots[state.fs.rootIndex] : null
    loadFs(workspace?.path || rootPath || null, { resetRoot: true })
  })
  $('file-preview-close').addEventListener('click', closeFsPreview)
  $('file-preview-done').addEventListener('click', closeFsPreview)
  $('file-preview-source-tab').addEventListener('click', () => showFsPreviewMode('source'))
  $('file-preview-rendered-tab').addEventListener('click', () => showFsPreviewMode('rendered'))
  $('file-preview-download').addEventListener('click', () => {
    const preview = state.fs.preview
    if (preview?.path && preview?.name) downloadFsPath(preview.path, preview.name)
  })
  $('modal-file-preview').addEventListener('click', (e) => { if (e.target === $('modal-file-preview')) closeFsPreview() })
  $('btn-cancel').addEventListener('click', cancelSession)
  $('btn-rename-session').addEventListener('click', () => renameSession())
  $('btn-archive-session').addEventListener('click', () => archiveSession(state.current))
  $('rename-cancel').addEventListener('click', closeRenameSession)
  $('rename-confirm').addEventListener('click', confirmRenameSession)
  $('rename-session-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) confirmRenameSession() })
  $('modal-rename').addEventListener('click', e => { if (e.target === $('modal-rename')) closeRenameSession() })
  $('btn-send').addEventListener('click', sendMessage)
  $('btn-fs-send').addEventListener('click', sendMessage)
  $('btn-plus').addEventListener('click', toggleComposerMenu)
  $('btn-image').addEventListener('click', toggleComposerImageMenu)
  $('composer-image-menu').addEventListener('click', (e) => {
    const option = e.target.closest('[data-image-source]')
    if (!option) return
    $('composer-image-menu').classList.add('hidden')
    $('btn-image').classList.remove('active')
    captureComposerImage(option.dataset.imageSource)
  })
  $('composer-attachments').addEventListener('click', (e) => {
    const button = e.target.closest('[data-remove-image]')
    if (button) removeComposerImage(button.dataset.removeImage)
  })
  $('composer-camera-input').addEventListener('change', (e) => { addComposerImages(e.target.files); e.target.value = '' })
  $('composer-gallery-input').addEventListener('change', (e) => { addComposerImages(e.target.files); e.target.value = '' })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#composer-image-menu, #btn-image')) {
      $('composer-image-menu')?.classList.add('hidden')
      $('btn-image')?.classList.remove('active')
    }
  })
  $('composer-menu').addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-cmd]')
    if (chip) {
      if (chip.dataset.cmd === '/permission') {
        const submenu = $('permission-submenu')
        submenu?.classList.toggle('hidden')
        return
      }
      $('permission-submenu')?.classList.add('hidden')
      const input = $('composer-input')
      input.value = chip.dataset.cmd + ' '
      input.focus()
      autosize(input)
      hideComposerMenu()
      return
    }
    const perm = e.target.closest('[data-perm]')
    if (perm) {
      const input = $('composer-input')
      input.value = '/permission ' + perm.dataset.perm + ' '
      input.focus()
      autosize(input)
      hideComposerMenu()
      return
    }
    const preset = e.target.closest('[data-preset]')
    if (preset) {
      const found = readPresets().find(x => x.id === preset.dataset.preset)
      if (found) {
        const input = $('composer-input')
        input.value = found.text
        input.focus()
        autosize(input)
      }
      hideComposerMenu()
    }
  })
  $('btn-model-refresh').addEventListener('click', loadSessionModels)
  const input = $('composer-input')
  input.addEventListener('input', () => autosize(input))
  $('btn-fs-toggle').addEventListener('click', () => setComposerFullscreen(!$('composer-wrap').classList.contains('fs')))
  bindComposerFullscreenGesture()
  updateComposerFullscreenButton()
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return
    if (isMobileDevice() && mobileEnterAction() !== 'send') return
    if (!e.shiftKey) { e.preventDefault(); sendMessage() }
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
  $('workspace-cancel').addEventListener('click', closeWorkspaceModal)
  $('workspace-create').addEventListener('click', createWorkspace)
  $('workspace-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createWorkspace() })
  $('modal-workspace').addEventListener('click', (e) => { if (e.target === $('modal-workspace')) closeWorkspaceModal() })
  $('archive-cancel').addEventListener('click', closeArchiveConfirm)
  $('archive-confirm').addEventListener('click', confirmArchiveSession)
  $('modal-archive').addEventListener('click', (e) => { if (e.target === $('modal-archive')) closeArchiveConfirm() })
  $('announcement-later').addEventListener('click', () => closeAnnouncement(false))
  $('announcement-confirm').addEventListener('click', () => closeAnnouncement(true))
  $('announcement-poll-options').addEventListener('change', () => { $('announcement-poll-submit').disabled = false })
  $('announcement-poll-submit').addEventListener('click', submitAnnouncementVote)
  $('modal-announcement').addEventListener('click', (e) => {
    if (e.target === $('modal-announcement') && !state.announcement?.force) closeAnnouncement(false)
  })
  $('announcement-history-close').addEventListener('click', closeAnnouncementHistory)
  $('announcement-history-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-announcement-poll]')
    if (!button) return
    const item = readAnnouncementHistory().find(entry => entry.id === button.dataset.announcementPoll)
    if (item?.poll) { closeAnnouncementHistory(); openAnnouncementModal(item) }
  })
  $('modal-announcement-history').addEventListener('click', (e) => {
    if (e.target === $('modal-announcement-history')) closeAnnouncementHistory()
  })
  $('overview-announcement-history').addEventListener('click', openAnnouncementHistory)
  $('overview-announcement-list').addEventListener('click', (e) => {
    const button = e.target.closest('[data-home-announcement]')
    if (!button) return
    const item = announcementBoardItems().find(entry => entry.id === button.dataset.homeAnnouncement)
    if (item) openAnnouncementModal(item)
  })
  // 设置
  $('view-settings').addEventListener('click', (e) => {
    const group = e.target.closest('[data-settings-group]')
    if (group) { showSettingsPage(group.dataset.settingsGroup); return }
    if (e.target.closest('[data-settings-back]')) { showSettingsHome(); return }
  })
  $('btn-model-settings-refresh')?.addEventListener('click', () => loadModelSettings(true))
  $('btn-model-settings-open')?.addEventListener('click', openModelConfigDocument)
  $('model-settings-list')?.addEventListener('click', handleModelSettingsClick)
  $('model-settings-list')?.addEventListener('input', handleModelSettingsInput)
  $('btn-asr-test-start')?.addEventListener('click', startAsrTest)
  $('btn-asr-test-stop')?.addEventListener('click', stopAsrTest)
  $('btn-asr-test-copy')?.addEventListener('click', copyAsrTestLog)
  $('btn-asr-test-clear')?.addEventListener('click', clearAsrTest)
  $('btn-asr-test-permission')?.addEventListener('click', openAsrPermissionSettings)
  $('btn-asr-test-engine')?.addEventListener('click', openAsrEngineSettings)
  renderAsrTest()
  $('btn-scan-camera').addEventListener('click', () => scanPair('CAMERA'))
  $('btn-scan-gallery').addEventListener('click', () => scanPair('PHOTOS'))
  $('scan-live-cancel')?.addEventListener('click', () => closeLiveScan(''))
  $('modal-scan-live')?.addEventListener('click', e => { if (e.target === $('modal-scan-live')) closeLiveScan('') })
  $('btn-change-token').addEventListener('click', () => {
    const input = prompt(t('token.prompt'), state.token)
    if (input && setCurrentAccessToken(input)) { $('token-desc').textContent = t('token.saved'); toast(t('token.savedReconnect'), 'ok'); openStreams(); refreshAll(); syncBgConfig() }
  })
  $('btn-server-speed').addEventListener('click', () => selectFastestServer({ silent: false }))
  $('btn-server-add').addEventListener('click', addServer)
  $('btn-group-add').addEventListener('click', addGroup)
  $('group-select-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleGroupMenu() })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#group-select')) closeGroupMenu()
  })
  $('server-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addServer() }
  })
  $('btn-host-describe').addEventListener('click', async () => {
    await refreshHostDescription({ notify: true })
  })
  $('btn-dsh-start')?.addEventListener('click', () => controlDsh('start'))
  $('btn-dsh-restart')?.addEventListener('click', () => controlDsh('restart'))
  $('btn-check-update').addEventListener('click', () => checkUpdate(false))
  $('btn-download-update').addEventListener('click', downloadUpdate)
  $('btn-update-expand').addEventListener('click', toggleUpdateExpand)
  $('app-version-later').addEventListener('click', () => closeAppVersionWarning(false))
  $('app-version-update').addEventListener('click', () => closeAppVersionWarning(true))
  $('modal-app-version-warning').addEventListener('click', (e) => {
    if (e.target === $('modal-app-version-warning')) closeAppVersionWarning(false)
  })
  $('btn-reset').addEventListener('click', () => {
    if (!confirm(t('settings.confirmReset'))) return
    LS.del('token'); LS.del('notify'); LS.del('server'); LS.del('mobileEnterAction'); LS.del(ANNOUNCEMENTS_KEY); LS.del(ANNOUNCEMENT_HISTORY_KEY); LS.del(ANNOUNCEMENT_VOTES_KEY)
    if (bgBridge()?.saveBackgroundConfig) saveBgConfig(false)
    location.reload()
  })
  $('mobile-enter-action').value = mobileEnterAction()
  $('mobile-enter-action').addEventListener('change', (e) => {
    const action = e.target.value === 'send' ? 'send' : 'newline'
    LS.set('mobileEnterAction', action)
    toast(t(action === 'send' ? 'settings.mobileEnterSend' : 'settings.mobileEnterNewline'), 'ok')
  })
  $('opt-notify').checked = LS.get('notify', '0') === '1'
  $('opt-notify').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const ok = await ensureNotify()
      if (!ok) { e.target.checked = false; return toast(t('settings.notifyDenied')) }
    }
    LS.set('notify', e.target.checked ? '1' : '0')
  })
  $('opt-peak-remind').checked = peakRemindOn()
  $('opt-peak-remind').addEventListener('change', async (e) => {
    if (e.target.checked) {
      if (!CAP?.isNativePlatform?.()) {
        e.target.checked = false
        return toast(t('peakRemind.browserOnly'), 'err')
      }
      const ok = await ensureNotify()
      if (!ok) { e.target.checked = false; return toast(t('settings.notifyDenied')) }
      const started = await schedulePeakReminders()
      if (!started) {
        e.target.checked = false
        return toast(t('peakRemind.failed'), 'err')
      }
      toast(t('peakRemind.on'), 'ok')
    } else {
      const stopped = await cancelPeakReminders()
      if (!stopped) {
        e.target.checked = true
        return toast(t('peakRemind.failed'), 'err')
      }
      toast(t('peakRemind.off'), 'ok')
    }
    LS.set('peakRemind', e.target.checked ? '1' : '0')
  })
  $('btn-test-notify').addEventListener('click', sendTestNotification)
  $('btn-announcement-history').addEventListener('click', openAnnouncementHistory)
  // 启动时先清理旧版 LocalNotifications，再按当前开关恢复前台提醒服务。
  restorePeakReminders()
  applyBgConfigFromNative()
  $('opt-bg-poll').addEventListener('change', async (e) => {
    if (e.target.checked) {
      if (!CAP?.isNativePlatform?.() || !bgBridge()?.saveBackgroundConfig) {
        e.target.checked = false
        return toast(t('settings.bgNativeOnly'), 'err')
      }
      if (!state.token) {
        e.target.checked = false
        return toast(t('settings.bgNeedToken'), 'err')
      }
      const ok = await ensureNotify()
      if (!ok) { e.target.checked = false; return toast(t('settings.notifyDenied')) }
      saveBgConfig(true)
      toast(t('settings.bgOn'), 'ok')
    } else {
      saveBgConfig(false)
      toast(t('settings.bgOff'), 'ok')
    }
  })
  $('bg-interval').addEventListener('change', () => {
    if ($('opt-bg-poll')?.checked) saveBgConfig(true)
  })
  $('opt-task-done')?.addEventListener('change', () => {
    if (bgBridge()?.saveBackgroundConfig) saveBgConfig($('opt-bg-poll')?.checked)
  })
  renderPresets()
  renderPresetMenu()
  $('btn-preset-add').addEventListener('click', addPreset)
  $('opt-tools').checked = LS.get('showTools', '1') !== '0'
  $('opt-tools').addEventListener('change', (e) => {
    LS.set('showTools', e.target.checked ? '1' : '0')
    if (state.current) renderHistory(true)
    toast(e.target.checked ? t('settings.toolsShown') : t('settings.toolsHidden'), 'ok')
  })

  // 文件页
  $('fs-up').addEventListener('click', fsUp)
  $('fs-new-workspace').addEventListener('click', openWorkspaceModal)
  $('fs-refresh').addEventListener('click', () => { toast(t('common.refreshing')); loadFs() })
  $('fs-upload-btn').addEventListener('click', () => $('fs-file-input').click())
  $('fs-file-input').addEventListener('change', (e) => {
    const f = e.target.files?.[0]
    if (f) uploadFsFile(f)
    e.target.value = '' // 允许连续选同一个文件
  })
  $('fs-pause-btn').addEventListener('click', pauseFsUpload)
  $('fs-cancel-btn').addEventListener('click', cancelFsUpload)
  bindFsPullRefresh()

  bindRail()

  initCustomSelects()

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
  renderAnnouncementBoard()
  renderLangBtn()
  bindNativeBack()
  bindNativeLinks()
  applyNativeInsets()
  showView('view-activity')
  updateConn()
  await loadLocalVersion()
  if (!state.token) {
    showView('view-activity')
    $('token-desc').textContent = t('token.notSetHint')
  } else {
    // 多服务器: 启动时静默测速一次, 选最快的连接(同源页面也参与比较)
    await selectFastestServer({ silent: true, reconnect: false })
    await maybeWarnAppBehindGateway({ probe: true })
    openStreams()
    await refreshAll()
    await refreshHostDescription()
    loadDshControl()
  }
  // 网关从中央 HTTPS 公告源读取并在不可达时回退内置文件。前台每 30 秒检查，
  // 回到前台或网络恢复时立即补查；公告优先，避免启动时两个弹窗重叠。
  startAnnouncementPolling()
  scheduleStartupNotices()
  renderPending()
}

document.addEventListener('DOMContentLoaded', boot)
