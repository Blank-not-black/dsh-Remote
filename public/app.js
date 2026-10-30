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
  set(k, v) { try { localStorage.setItem(k, v); return true } catch(error) { try { globalThis.DshDiagnostics?.storageFailure(k,error) } catch {} return false } },
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
let doctorSessionHandoff = false
function clientIdHeaders() { return CLIENT_ID ? { 'x-dsh-remote-client-id': CLIENT_ID } : {} }

/* 按连接身份隔离：本地缓存先显示，远端历史在后台校验与合并。 */
const CACHE = {
  get sessions() { return connectionCacheKey('sessions') },
  get history() { return connectionCacheKey('history') }
}
function connectionCacheKey(kind, server=state.server, token=state.token) {
  const hash = new SHA256()
  hash.update(new TextEncoder().encode(JSON.stringify([server || location.origin, token])))
  return kind + 'CacheV2:' + hash.hex()
}
function cacheRead(key, d = null) {
  try { return JSON.parse(LS.get(key, '')) || d } catch { return d }
}
function cacheWrite(key, value) {
  try { LS.set(key, JSON.stringify(value)) } catch { LS.del(key) }
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
  announcementItems: [],
  announcementIndex: 0,
  announcements: [],
  approvals: [],           // 待处理审批
  approvalRecords: new Map(), // 审批记录：审计事件(approval/asked+decided)与实时审批帧
  approvalRecordsServer: null,
  questions: [],           // 待处理提问
  queues: {},              // sessionId -> queue items
  queueSteering: {},       // sessionId:itemId -> pending steer request
  compactionBootAt: Date.now(),
  compactions: {},         // sessionId -> {active, phase, startedAt, message, source}
  pendingCommands: {},     // sessionId -> command name; waits briefly before showing generic progress
  compactionPollTimer: null,
  compactionClockTimer: null,
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
  wb: null,
  wbProjects: [],
  wbArchived: [],
  wbOpen: false,
  wbOpenProjects: {},
  subagentSessions: {}
}

// Increment on every identity transition, including A -> B -> A and token edits.
let connectionGeneration = 0, sessionsRequest = 0, filesRequest = 0, workbenchRequest = 0
for (const key of ['server', 'token']) {
  let value = state[key]
  Object.defineProperty(state, key, {
    enumerable: true,
    get: () => value,
    set(next) {
      if (next === value) return
      cancelHistoryLoad()
      value = next; connectionGeneration++
      window.DshImagePreview?.reset?.()
      clearTimeout(state.refreshTimer); state.refreshTimer = null
      state.sessions = []; state.byId.clear(); state.pendingProjections.clear(); state.runtimeErrors = new Map()
      state.hostInfo = null
      if(typeof closeStream==='function'&&typeof streamMeta!=='undefined'){closeStream('mux');closeStream('host')}
      state.current = null; state.history = emptyHistory(); state.subagentSessions = {}; window.DshSubagents?.reset()
      state.models = { loaded: false, loading: false, groups: [], current: null, failures: [] }
      state.modelSettings = { status: 'idle', error: '', writable: false, hasDocument: false, providers: [], namespaces: [], credentials: {} }; state.modelEditor = null
      state.goalEdit = null; state.goalEditContext = null
      state.approvals = []; state.questions = []; state.questionModal = null
      state.queues = {}; state.jobs = {}; state.queueSteering = {}; state.compactions = {}; state.compactionTerminals = {}; state.compactionSeqs = {}; state.compactionBootAt = Date.now(); state.pendingCommands = {}; state.sessionTurnTimes = {}
      state.sessionActivity = new Set(); state.pendingPrompts = new Set()
      state.fs.path = null; state.fs.initial = null; state.fs.loaded = false; state.fs.roots = []; state.fs.rootIndex = 0
      state.wb = null; state.wbProjects = []; state.wbArchived = []; state.workspaceFilter = ''; state.fs.workspaceId = ''; clearTimeout(scheduleHistoryCacheSave._t)
      window.DshPluginCenter?.close()
      window.DshInsights?.close()
      window.DshExtensions?.close()
      window.DshExtensions?.invalidateCapabilities()
      window.DshFileInbox?.reset()
      window.DshSessionDeck?.reset()
      if (typeof document !== 'undefined') document.getElementById('btn-insights')?.classList.add('hidden')
      if(typeof document!=='undefined') {
        const identityGeneration=connectionGeneration
        queueMicrotask(()=>{if(identityGeneration===connectionGeneration&&typeof startOverviewDetection==='function')startOverviewDetection(true,true)})
        document.getElementById('history')?.replaceChildren?.()
        const generation=connectionGeneration
        queueMicrotask(()=>{if(generation!==connectionGeneration)return;if(typeof conversationView!=='undefined')conversationView?.reset();if(!state.current&&document.body.classList.contains('in-session')){document.body.classList.remove('in-session');showView('view-home')};restoreCachedSessionList()})
      }
      if (typeof document !== 'undefined') {
        document.getElementById('modal-workspace')?.classList.add('hidden')
        for (const id of ['modal-question', 'modal-new-session', 'modal-rename', 'modal-archive', 'modal-goal']) document.getElementById(id)?.classList.add('hidden')
        if (typeof renderPending === 'function') renderPending()
        if (typeof renderModelSettings === 'function') renderModelSettings()
        const generation = connectionGeneration
        queueMicrotask(() => {
          if (generation === connectionGeneration && document.getElementById('view-plugins')?.classList.contains('hidden') === false) openPluginPage()
        })
      }
    },
  })
}
function captureConnection() {
  const generation = connectionGeneration, server = state.server, token = state.token
  return { server, token, valid: () => generation === connectionGeneration && server === state.server && token === state.token }
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
  'busy-send-mode': 'settings.busySendTitle',
  'bg-interval': 'settings.bgIntervalTitle',
  'new-session-workspace': 'workspace.select',
  'new-session-agent-preset': 'newSession.type',
  'workspace-agent-preset': 'newSession.type'
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
  window.DshExtensions?.closeShortcuts()
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
function doctorEnvironment() {
  let report = {}
  try { report = globalThis.DshDiagnostics?.report?.() || {} } catch {}
  const health = activeGatewayHealth()
  return {
    surface: CAP?.isNativePlatform?.() ? 'Android app' : 'Mobile web',
    appVersion: state.localVersion || report.client?.version || '',
    gatewayVersion: health?.version || '',
    gatewayOk: health?.ok === true,
    gatewayReachable: health?.upstreamReachable,
    dshVersion: state.hostInfo?.version || '',
    host: currentServerEntry()?.note || state.server || location.origin,
    mux: state.streamsOk?.mux ? 'connected' : state.streamMode || 'unknown',
    hostEvents: state.streamsOk?.host ? 'connected' : state.streamMode || 'unknown',
  }
}
function openDoctor() {
  closeFeedbackSheet()
  if (!window.DshDoctor) {
    toast(t('feedback.submitFailed', { msg: 'doctor unavailable' }), 'err')
    return
  }
  const connection=captureConnection(), accessToken=state.token
  window.DshDoctor.open({
    connection,
    loadTarget:()=>window.DshDoctorEntry.loadTarget({url:apiUrl,headers:{authorization:'Bearer '+accessToken},connection}),
    surface: 'mobile',
    rpc: (method, payload) => rpc(method, payload),
    openSession: async id => { await openSession(id); return connection.valid() && state.current===id && !$('view-session').classList.contains('hidden') },
    workspaceId: () => workspaceForSession(state.byId.get(state.current))?.workspaceId || workspaceById(state.workspaceFilter)?.workspaceId || '',
    cwd: () => sessionCwd(state.byId.get(state.current)) || '',
    environment: doctorEnvironment,
    diagnostics: () => globalThis.DshDiagnostics?.report?.(),
    exportDiagnostics: () => globalThis.DshDiagnostics?.download?.(),
    copy: copyText,
    toast,
  })
}
function openFeedbackModal(options = {}) {
  if (!options.preserveDraft) {
    state.feedbackType = 'bug'
    document.querySelectorAll('#fb-chips .fb-chip').forEach(b => b.classList.toggle('current', b.dataset.fbType === 'bug'))
    $('fb-msg').value = ''
    $('fb-contact').value = ''
    $('fb-include-diagnostics').checked = false
    $('fb-include-crashes').checked = false
    $('fb-crash-details').open = false
  }
  void loadCrashPreview()
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
async function loadCrashPreview() {
  const generation=loadCrashPreview.generation=(loadCrashPreview.generation||0)+1
  const connection=captureConnection(),preview=$('fb-crash-preview')
  preview.textContent=t('feedback.crashLoading')
  const selected=$('fb-include-diagnostics').checked,crashes=$('fb-include-crashes').checked
  if(!selected&&!crashes){preview.textContent=I18N.lang==='en'?'Select a log option above to preview the attachment.':'勾选上方日志选项后，可在这里预览拟上传的附件。';return}
  const read=async route=>{try{const response=await fetch(updateBase()+route,{headers:{authorization:'Bearer '+connection.token},signal:AbortSignal.timeout(5000),cache:'no-store'});if(!response.ok)throw Error();return await response.json()}catch{return {unavailable:true}}}
  const evidence={}
  if(selected){evidence.client=globalThis.DshDiagnostics?.report();evidence.gateway=await read('/diagnostics')}
  if(crashes){const data=await read('/crash-logs');evidence.crashes=data.upload||data}
  if(connection.valid()&&generation===loadCrashPreview.generation)preview.textContent=JSON.stringify(evidence,null,2)
}
async function submitFeedback() {
  const type = state.feedbackType || 'bug'
  const message = $('fb-msg').value.trim()
  const contact = $('fb-contact').value.trim()
  const includeDiagnostics = $('fb-include-diagnostics').checked
  const includeCrashLogs = $('fb-include-crashes').checked
  const clientDiagnostics=includeDiagnostics?globalThis.DshDiagnostics?.report():null
  if (!message) { toast(t('feedback.empty'), 'err'); return }
  if (message.length > 2000) { toast(t('feedback.tooLong'), 'err'); return }
  const btn = $('fb-submit')
  btn.disabled = true
  const diagnostic=globalThis.DshDiagnostics?.start('feedback.submit')
  try {
    const base = updateBase()
    if (!base) throw new Error(t('feedback.networkError'))
    const res = await fetch(base + '/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ type, message, contact, appVersion: state.localVersion, includeDiagnostics, includeCrashLogs,...(clientDiagnostics?{clientDiagnostics}:{}) })
    })
    diagnostic?.end({phase:res.ok?'complete':'failed',httpStatus:res.status})
    let json = {}
    try { json = await res.json() } catch {}
    if (res.ok && json.ok) { closeFeedbackModal(); openFeedbackSuccess()
      const status=$('feedback-diagnostics-status'),saved=json.diagnostics?.saved===true&&json.diagnostics.reportId===clientDiagnostics?.reportId
      status.textContent=clientDiagnostics?(saved?(I18N.lang==='en'?'Diagnostic report saved. ID: ':'诊断日志已保存，编号：')+clientDiagnostics.reportId:(I18N.lang==='en'?'Feedback received, but the server did not confirm the complete diagnostic report. Copy or export the local log to supplement it.':'反馈已收到，但服务器未确认完整诊断日志已保存。请复制或导出本地日志补充。')):''
      status.classList.toggle('hidden',!clientDiagnostics)
    }
    else if (res.status === 429) { toast(json.retryAfter ? t('feedback.rateLimitedAt', { n: json.retryAfter }) : t('feedback.rateLimited'), 'err') }
    else { toast(t('feedback.submitFailed', { msg: json.error || res.status }), 'err') }
  } catch(error) {
    diagnostic?.fail(error)
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
let wsTicketConnection = null
async function getWsTicket() {
  // Share only an in-flight request. A completed ticket may be exhausted or
  // belong to the gateway instance that just exited.
  if (wsTicketPromise && wsTicketConnection?.valid()) return wsTicketPromise
  const connection = captureConnection()
  const token = state.token
  const server = state.server
  const job = (async () => {
    if (activeGatewayCapability('wsTicket') === false) throw Object.assign(new Error('ws ticket unsupported'), { unsupported: true })
    const read = async signal => {
      const res = await fetch(apiUrl('/api/ws-ticket'), {
        method: 'POST',
        signal,
        headers: {
          authorization: 'Bearer ' + token,
          'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web',
          ...clientIdHeaders(),
        }
      })
      if (!res.ok) throw Object.assign(new Error('ws ticket HTTP ' + res.status), { unsupported: [404, 405, 501].includes(res.status) })
      return res.json()
    }
    const data = await (globalThis.DshNetwork?.readWithDeadline
      ? globalThis.DshNetwork.readWithDeadline(read,8000)
      : read(AbortSignal.timeout(8000)))
    if (!connection.valid()) throw new Error('stale ws ticket')
    if (!data?.ticket || !Number(data.expiresAt)) throw new Error('invalid ws ticket')
    state.wsTicket = { token, server, value: data.ticket, expiresAt: Number(data.expiresAt) }
    return data.ticket
  })()
  wsTicketPromise = job
  wsTicketConnection = connection
  try { return await job } finally { if (wsTicketPromise === job) { wsTicketPromise = null; wsTicketConnection = null } }
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

async function rpc(method, payload = {}, timeoutMs = 45000, cancellation = null) {
  const diagnostic=globalThis.DshDiagnostics?.start('rpc',{method,sessionId:payload.sessionId,server:state.server})
  try {
  const opts = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload })
  }
  if (cancellation) opts.signal = cancellation
  else if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(timeoutMs)
  }
  const operation = window.DshOperations?.supports(method) && activeGatewayCapability('operations') === true
  const connection = operation ? captureConnection() : null
  const receipt = operation ? await window.DshOperations.execute({ method, payload, url: apiUrl, headers: opts.headers, valid: () => connection.valid() }) : null
  const res = receipt ? { status: 200, ok: true, json: async () => receipt } : await fetch(apiUrl('/api/' + method), opts)
  diagnostic?.end({phase:'response',httpStatus:res.status})
  if (res.status === 401) throw new Error('AUTH')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const full = await res.json()
  if (!full?.result) throw new Error(t('err.badResponse'))
  if (!full.result.ok) {
    const err = full.result.error || {}
    const error = new Error(err.code === 'session/migration-required' ? t('session.migrationRequired') : err.message || t('err.dshError'))
    error.code = err.code
    error.rpcRejected = true
    throw error
  }
  diagnostic?.end({phase:'complete'})
  return full.result.value
  } catch(error) { diagnostic?.fail(error);throw error }
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
  const connection = captureConnection()
  try { const value = await rpc(method, payload); return connection.valid() ? value : null }
  catch (e) {
    if (!connection.valid()) return null
    if (e.message === 'AUTH') authFailure()
    else if (e.operationPending) toast(e.message, 'err')
    else toast(errText ? `${errText}：${e.message}` : e.message, 'err')
    return null
  }
}

let hostDescribePromise = null
let hostDescribeConnection = null
let hostDescribeRetryTimer = null
let hostDescribeFailures = 0
function hostDescriptionText(host) {
  const detail = t('settings.hostDesc', { version: host.version || t('settings.unknown'), cwd: host.cwd || t('settings.unknown'), n: Number.isSafeInteger(host.attachedSessions) ? host.attachedSessions : t('settings.unknown') })
  const health = activeGatewayHealth()
  return health ? detail + ' · ' + t('settings.hostHealth', { status: t(health.upstreamOk ? 'conn.on' : 'conn.off'), http: health.upstreamStatus || '—', mux: health.events?.mux?.connected ? '✓' : '×', host: health.events?.host?.connected ? '✓' : '×', time: health.upstreamCheckedAt ? new Date(health.upstreamCheckedAt).toLocaleTimeString() : '—' }) : detail
}

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
  if (hostDescribePromise && hostDescribeConnection?.valid()) return hostDescribePromise
  const connection = captureConnection()
  hostDescribeConnection = connection
  const job = (async () => {
    try {
      if (notify) {
        const base = String(connection.server || location.origin).replace(/\/+$/, '')
        const response = await fetch(base + '/health?probe=fresh', { cache: 'no-store', signal: AbortSignal.timeout(6500) })
        const health = await response.json()
        if (!connection.valid()) return null
        if (response.ok && health?.service === 'dsh-remote') state.gatewayHealth[base] = health
      }
      const host = await rpc('host.describe', {}, 5000)
      if (!connection.valid()) return null
      state.hostInfo = host
      hostDescribeFailures = 0
      if (hostDescribeRetryTimer) clearTimeout(hostDescribeRetryTimer)
      hostDescribeRetryTimer = null
      const desc = $('host-desc')
      if (desc && host) desc.textContent = hostDescriptionText(host)
      renderOverview()
      return host
    } catch (error) {
      if (!connection.valid()) return null
      if (error.message === 'AUTH') authFailure()
      else {
        hostDescribeFailures++
        scheduleHostDescribeRetry()
        if (notify) toast(`${t('settings.probeFailed')}：${error.message}`, 'err')
      }
      return null
    } finally {
      if (hostDescribePromise === job) { hostDescribePromise = null; hostDescribeConnection = null }
    }
  })()
  hostDescribePromise = job
  return job
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
    const res = await fetch(u + '/health?probe=live&t=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' })
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
  if (health && typeof health.upstreamOk === 'boolean') return health.upstreamOk
  if (health && typeof health.upstreamReachable === 'boolean') return health.upstreamReachable
  return !!state.hostInfo && state.hostInfo.metadataOnly !== true
}

async function selectFastestServer({ silent = false, reconnect = true } = {}) {
  const request = selectFastestServer.request = (selectFastestServer.request || 0) + 1
  const connection = captureConnection(), group = state.activeGroup
  const policy = JSON.stringify([state.autoSelect[group], state.groupActive[group], state.servers])
  const valid = () => connection.valid() && request === selectFastestServer.request && state.activeGroup === group && policy === JSON.stringify([state.autoSelect[group], state.groupActive[group], state.servers])
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
      if (!valid()) return null
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

    if (!valid()) return null
    if (typeof window !== 'undefined') window.DshNetwork?.observeLatency(ms)
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
    if (request === selectFastestServer.request) state.selectingServer = false
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
  $('group-select-btn')?.setAttribute('aria-label', t('groups.currentLabel', { group: state.activeGroup }))
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

let groupDrawerReturnFocus = null

function groupDrawerOpen() {
  return !$('group-drawer')?.classList.contains('hidden')
}

function renderGroupDrawer() {
  const trigger = $('group-drawer-trigger')
  const brandGroup = $('brand-group-name')
  const current = $('group-drawer-current')
  const list = $('group-drawer-list')
  if (brandGroup) brandGroup.textContent = state.activeGroup
  if (trigger) trigger.setAttribute('aria-label', t('groups.drawerOpen') + '：' + state.activeGroup)
  if (current) current.textContent = state.activeGroup
  if (!list) return
  list.innerHTML = state.groups.map(group => {
    const servers = groupServers(group)
    const selected = group === state.activeGroup
    return `<button type="button" class="group-drawer-option ${selected ? 'current' : ''}" data-quick-group="${esc(group)}" ${selected ? 'aria-current="true"' : ''}>
      <span class="group-drawer-option-mark" aria-hidden="true"></span>
      <span class="group-drawer-option-copy"><span class="group-drawer-option-name">${esc(group)}</span><span class="group-drawer-option-meta">${t('groups.serverCount', { count: servers.length })}</span></span>
      <span class="group-drawer-option-check" aria-hidden="true">${selected ? '✓' : ''}</span>
    </button>`
  }).join('')
}

function openGroupDrawer() {
  const drawer = $('group-drawer')
  const backdrop = $('group-drawer-backdrop')
  const trigger = $('group-drawer-trigger')
  if (!drawer || !backdrop || !trigger) return
  renderGroupDrawer()
  groupDrawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger
  drawer.classList.remove('hidden')
  backdrop.classList.remove('hidden')
  document.body.classList.add('group-drawer-open')
  trigger.setAttribute('aria-expanded', 'true')
  requestAnimationFrame(() => (drawer.querySelector('[data-quick-group].current') || drawer.querySelector('[data-quick-group]') || drawer).focus({ preventScroll: true }))
}

function closeGroupDrawer({ restoreFocus = true } = {}) {
  const drawer = $('group-drawer')
  const backdrop = $('group-drawer-backdrop')
  const trigger = $('group-drawer-trigger')
  if (!drawer || !backdrop || drawer.classList.contains('hidden')) return
  drawer.classList.add('hidden')
  backdrop.classList.add('hidden')
  document.body.classList.remove('group-drawer-open')
  trigger?.setAttribute('aria-expanded', 'false')
  if (restoreFocus) (groupDrawerReturnFocus || trigger)?.focus({ preventScroll: true })
  groupDrawerReturnFocus = null
}

function keepGroupDrawerFocus(event) {
  if (!groupDrawerOpen()) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeGroupDrawer()
    return
  }
  if (event.key !== 'Tab') return
  const drawer = $('group-drawer')
  const targets = [...drawer.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
  if (!targets.length) return
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

function renderServers() {
  const box = $('server-list')
  if (!box) return
  renderGroupSelect()
  renderGroupDrawer()
  const groupsHtml = state.groups.map(g => {
    const list = groupServers(g)
    const auto = state.autoSelect[g] !== false
    const activeManual = state.groupActive[g] || ''
    return `<div class="srv-group" data-group="${esc(g)}">
      <div class="srv-group-head">
        <button class="srv-group-name" data-group-name="${esc(g)}"><span class="srv-group-label">${g === state.activeGroup ? '▾' : '▸'} ${esc(g)}</span><span class="srv-group-count">${list.length}</span></button>
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
          const active = s.url === state.server && serverToken(s) === state.token
          // 只显示一条最有用的状态，避免地址被状态文案挤成竖排。
          let badge = `<span class="server-badge">${t('servers.untested')}</span>`
          if (!s.token) badge = `<span class="server-badge bad">${t('servers.tokenMissing')}</span>`
          else if (Number.isFinite(ms)) badge = `<span class="server-badge ${active ? 'good' : ''}">${ms}ms${active ? t('servers.current') : ''}</span>`
          else if (ms !== undefined) badge = '<span class="server-badge bad">' + t('servers.unreachable') + '</span>'
          else if (active) badge = `<span class="server-badge good">${t('servers.currentOnly')}</span>`
          const activeInGroup = auto ? active : s.id === activeManual
          return `<div class="server-row ${activeInGroup ? 'active' : ''}" data-use-server="${esc(s.id)}">
            <span class="server-main"><span class="server-note" title="${esc(serverTitle(s))}">${esc(serverTitle(s))}</span>${s.note ? `<span class="server-url">${esc(s.url)}</span>` : ''}</span>${badge}
            <button class="server-edit" data-edit-server="${esc(s.id)}" title="${t('servers.edit')}" aria-label="${t('servers.edit')}">✎</button>
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
    ? t('servers.currentDescGroup', { group: curGroup, url: curNote }) + (Number.isFinite(curMs) ? ' · ' + curMs + 'ms' : '')
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
  void window.DshImageCache?.clear(historyCacheScope(s.url,serverToken(s)))
  void window.DshHistory.cacheClear(historyCacheScope(s.url,serverToken(s)))
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
    if (streams[kind] && [WebSocket.OPEN, WebSocket.CONNECTING].includes(streams[kind].readyState)) return
    const connection=captureConnection(), generation=streamMeta[kind].generation
    const valid=()=>connection.valid() && generation===streamMeta[kind].generation
    void getWsTicket().then((value) => {
      if (valid()) openStream(kind, handler, refreshOnOpen, isRestore, value)
    }).catch((error) => {
      // 兼容旧网关/插件副本: ticket 接口不可用时临时回退旧 token 握手。
      if (!valid()) return
      if (error.unsupported) openStream(kind, handler, refreshOnOpen, isRestore, '')
      else {
        clearStreamRetry(kind)
        const meta = streamMeta[kind]
        meta.failures++
        aggregateStreamFailures()
        if (state.streamMode !== 'poll' && meta.failures >= 3) { enterPollMode(); return }
        const delay = Math.round(Math.min(1500 * 2 ** Math.min(meta.attempt++, 6), 60000) * (0.8 + Math.random() * 0.4))
        meta.retryTimer = setTimeout(() => { meta.retryTimer = null; if (valid() && navigator.onLine) openStream(kind, handler, refreshOnOpen, isRestore) }, delay)
        setReconnect(delay)
      }
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
    globalThis.DshDiagnostics?.record('stream.state',{channel:kind,status:'open',attempt:meta.failures})
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
  ws.onclose = (event) => {
    clearStreamTimers(ws)
    if (!streamIsCurrent(kind, ws, generation)) return
    streams[kind] = null
    state.streamsOk[kind] = false
    markStreamInfo(kind, {
      status: 'closed',
      lastCloseAt: Date.now(),
      lastCloseCode: Number(event.code) || 0,
      lastCloseReason: String(event.reason || '').slice(0, 200),
    })
    globalThis.DshDiagnostics?.record('stream.state',{channel:kind,status:'closed',closeCode:Number(event.code)||0,attempt:meta.failures+1})
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
    globalThis.DshDiagnostics?.record('stream.retry',{channel:kind,attempt:meta.attempt,delayMs:delay})
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
  globalThis.DshDiagnostics?.record('poll.state',{status:'poll'})
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
  pollInFlight?.stop()
  pollInFlight = null
  clearInterval(pollTimer); pollTimer = null
  clearInterval(wsRetryTimer); wsRetryTimer = null
}
function startPolling() {
  stopPolling()
  pollTimer = setInterval(pollOnce, 4000)
  wsRetryTimer = setInterval(tryRestoreWs, 30000)
  void pollOnce()
}
let pollInFlight = null
async function pollOnce() {
  if (state.streamMode !== 'poll') return
  if (!pollInFlight) pollInFlight = new window.DshNetwork.PollLoop({
    active: () => state.streamMode === 'poll' && !!state.token,
    capture: () => { const connection = captureConnection(), cursors = state.pollSeq; return { valid: () => connection.valid() && state.pollSeq === cursors } },
    read: pollKind
  })
  return pollInFlight.tick()
}

async function pollKind(kind, cancellation) {
  if (state.streamMode !== 'poll') return
  const connection = captureConnection(), cursors = state.pollSeq
  const valid = () => connection.valid() && state.streamMode === 'poll' && state.pollSeq === cursors && !cancellation?.aborted
  const since = state.pollSeq[kind] || 0
  let res, data
  try {
    const timeoutMs = window.DshNetwork?.profile().pollTimeout || 30000
    const headers = { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }
    const read = async signal => {
      const response = await fetch(apiUrl(`/api/events.poll?kind=${kind}&since=${since}&wait=25000&epoch=${encodeURIComponent(cursors[kind + "Epoch"] || "")}`), { ...(signal ? { signal } : {}), headers })
      return {res:response,data:response.ok ? await response.json() : null}
    }
    let result
    if(globalThis.DshNetwork?.readWithDeadline)result=await globalThis.DshNetwork.readWithDeadline(read,timeoutMs,cancellation)
    else {
      const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
      const signal = cancellation && timeout && typeof AbortSignal.any === 'function' ? AbortSignal.any([cancellation, timeout]) : timeout || cancellation
      result=await read(signal)
    }
    res=result.res;data=result.data
  } catch { return }
  if (!valid()) return
  if (res.status === 401) { authFailure(); return }
  if (!res.ok) return
  if (!valid()) return
  if (!data || !Array.isArray(data.events)) return
  // 网关重启或客户端离线过久后，游标可能落后于内存环形缓冲；
  // 从当前缓冲重新接收，并刷新权威会话列表，避免静默漏事件。
  const reset = data.reset === true || (!!data.epoch && !!cursors[kind + 'Epoch'] && cursors[kind + 'Epoch'] !== data.epoch) || data.truncated === true || (typeof data.latestSeq === 'number' && data.latestSeq < since)
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
  if (data.epoch) cursors[kind + 'Epoch'] = data.epoch
  // The fallback poll may contain a request and its resolution together. Seed
  // native tombstones first, including before the pending baseline is replayed.
  if (kind === 'mux' && typeof window !== 'undefined' && window.NativeBackground?.handlePendingEvent) {
    for (const item of data.events) {
      const payload = item.event?.payload
      if (item.seq > (reset ? 0 : since) && ['approval/resolved', 'question/resolved'].includes(payload?.type)) {
        window.NativeBackground.handlePendingEvent(bgBase(), state.token || '', JSON.stringify(item.event), false)
      }
    }
  }
  for (const frame of data.baseline || []) { if (kind === 'mux') onMuxFrame(frame); else onHostFrame(frame) }
  for (const item of data.events) {
    if (item.seq > (state.pollSeq[kind] || 0)) {
      state.pollSeq[kind] = item.seq
      if (kind === 'mux') onMuxFrame(item.event)
      else onHostFrame(item.event)
    }
  }
  return data.waitSupported === true ? 100 : 4000
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
  void openPendingNavigation()
  recoverSessionHistory()
  if(state.token)openStreams()
}

/* 回前台 / 定时兜底: 任何流不在 OPEN 就重连; 多服务器时顺便重测速 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    onResume()
    if (window.NativeBackground?.getPendingNavigation?.()) return
    if (state.servers.length) selectFastestServer({ silent: true })
    else if (state.token) repairMissingStreams()
  }
})
window.addEventListener('pageshow', onResume)
setInterval(() => {
  if (document.visibilityState === 'visible' && state.token) {
    repairMissingStreams()
    sessionSyncTick()
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
  recoverSessionHistory()
  openStreams()
  updateConn()
})
// Connection metrics also emit change; only a network type change needs recovery.
let networkConnectionType=navigator.connection?.type||navigator.connection?.effectiveType
navigator.connection?.addEventListener?.('change',()=>{
  const type=navigator.connection.type||navigator.connection.effectiveType
  if(type===networkConnectionType)return
  networkConnectionType=type
  if(document.visibilityState==='visible'&&state.token){recoverSessionHistory();openStreams();if(state.servers.length)void selectFastestServer({silent:true})}
})

function onMuxFrame(full) {
  const f = full.payload
  if (!f) return
  if (f.type === 'session/reasoning') {
    if (f.sessionId === state.current) { applyReasoningBaseline(f.partialReasoning); scheduleReasoningRender() }
    return
  }
  if (f.type === 'session/event') return onSessionEvent(f.sessionId, f.event, { replay: f.replay === true })
  if (f.type === 'session/subscribed') return
  if (f.type === 'approval/requested') {
    state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId)
    state.approvals.push({ ...f, rpcId: full.rpcId })
    collectApprovalFrame(f)
    notifyPendingRequest(full, t('notify.approvalTitle'), t('notify.approvalBody', { tool: f.toolName || t('tool.unknown') }))
    renderPending(); return
  }
  if (f.type === 'approval/resolved') { collectApprovalFrame(f); clearPendingNotification(f); state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId); renderPending(); return }
  if (f.type === 'question/requested') {
    state.questions = state.questions.filter(q => q.rpcId !== full.rpcId)
    state.questions.push({ ...f, rpcId: full.rpcId })
    notifyPendingRequest(full, t('notify.questionTitle'), f.questions?.map(q => q.question).join(' / ') || t('notify.questionBody'))
    renderPending(); return
  }
  if (f.type === 'question/resolved') {
    clearPendingNotification(f)
    state.questions = state.questions.filter(q => q.rpcId !== f.questionRpcId)
    if (state.questionModal?.rpcId === f.questionRpcId) { $('modal-question').classList.add('hidden'); state.questionModal = null }
    renderPending(); return
  }
  if (f.type === 'session/queue') { state.queues[f.sessionId] = f.items || []; renderQueue(); return }
  if (f.type === 'session/jobs') { state.jobs[f.sessionId] = f.jobs || []; renderJobs(); return }
  if (f.type === 'session/projection') { applyProjection(f.sessionId, f.key, f.value, f.seq); return }
  if (f.type === 'stream/error') { toast(t('stream.error', { msg: f.error?.message || '' }), 'err') }
  if (f.type === 'session/stream-error' && f.sessionId === state.current) { setSessionRecovery('error', f.error?.code === 'session/migration-required' ? t('session.migrationRequired') : f.error?.message); toast(f.error?.code === 'session/migration-required' ? t('session.migrationRequired') : f.error?.message, 'err') }
}
function onHostFrame(full) {
  const f = full.payload
  if (!f) return
  if (['host/session-status', 'host/agent-error'].includes(f.type) && typeof window !== 'undefined' && window.NativeBackground?.handleTaskEvent) window.NativeBackground.handleTaskEvent(bgBase(), state.token || '', JSON.stringify(full), f.replay === true)
  if (['host/session-added', 'host/session-removed', 'host/workspace-changed', 'host/workspace-removed', 'host/workspace-order-changed', 'host/archived-sessions-changed'].includes(f.type)) return scheduleRefresh()
  if (f.type === 'host/session-activity') {
    const session = state.byId.get(f.sessionId)
    if (session) { session.updatedAt = Number(f.updatedAt) || Date.now(); renderSessions(); renderOverview() }
    scheduleSessionSync(f.sessionId)
    return
  }
  if (f.type === 'host/session-status') {
    if (f.running && state.runtimeErrors?.delete(f.sessionId) && state.current === f.sessionId) renderHistory()
    const s = state.byId.get(f.sessionId)
    if (s) { s.running = f.running; if (f.running) s.error = false; if (state.current === f.sessionId) { renderSessionCards(); updateCancelBtn(); renderSessionSub(); updateSessionStatus() } }
    if (!f.running) scheduleSessionSync(f.sessionId)
    return
  }
  if (f.type === 'host/agent-error') {
    const s = state.byId.get(f.sessionId)
    if (s) { s.error = true; s.running = false }
    rememberRuntimeError(f.sessionId, f.message)
    if (state.current === f.sessionId) { renderSessionSub(); updateSessionStatus(); toast(t('session.errorMsg', { msg: f.message }), 'err') }
    return
  }
  if (f.type === 'host/remote-event') return scheduleRefresh()
}

function activeCompaction(sessionId = state.current) {
  const compact = state.compactions[sessionId]
  return compact?.active === true ? compact : null
}

function compactElapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remain = seconds % 60
  return minutes > 0 ? `${minutes}:${String(remain).padStart(2, '0')}` : `${remain}s`
}

function setCompactionStatus(sessionId, next) {
  state.compactionTerminals ||= {}
  if (!sessionId) return
  const previous = state.compactions[sessionId]
  const active = next?.active === true
  if (active) {
    state.compactions[sessionId] = {
      active: true,
      phase: next.phase || previous?.phase || 'running',
      command: String(next.command || previous?.command || 'compact'),
      startedAt: Number(next.startedAt) || previous?.startedAt || Date.now(),
      message: String(next.message || ''),
      source: next.source || previous?.source || 'event',
      compactionId: next.compactionId || previous?.compactionId || '',
      notify: next.notify ?? previous?.notify ?? (next.source === 'command'),
    }
  } else {
    delete state.compactions[sessionId]
    if (previous?.active) {
      state.compactionTerminals[sessionId] = { startedAt: previous.startedAt, compactionId: previous.compactionId }
    }
    if (previous?.active && previous.notify && next?.notify !== false && ['complete', 'failed'].includes(next?.phase)) {
      const command = previous.command || 'compact'
      if (command === 'export' && next?.phase === 'complete' && state.current === sessionId && typeof downloadSessionExport === 'function') void downloadSessionExport(sessionId)
      if (next?.phase === 'failed') toast(command === 'compact'
        ? t('session.compactFailed', { msg: next.message || t('send.failed') })
        : t('session.commandFailed', { command, msg: next.message || t('send.failed') }), 'err')
      else toast(command === 'compact' ? t('session.compactComplete') : t('session.commandComplete', { command }), 'ok')
    }
  }
  ensureCompactionMonitoring()
  if (state.current === sessionId) updateSessionStatus()
}

async function refreshCompactionStatus(sessionId = state.current) {
  if (!sessionId) return
  const connection = captureConnection()
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    const url = new URL(connection.server + '/remote/api/command-status', location.href)
    url.searchParams.set('sessionId', sessionId)
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }, ...(signal ? { signal } : {}) })
    if (!connection.valid()) return
    if (res.status === 401) { authFailure(); return }
    if (!res.ok) return
    if (!connection.valid()) return
    const body = await res.json().catch(() => null)
    if (!connection.valid()) return
    const operation = body?.operation || body?.compact
    if (!operation) return
    if (operation.startedAt && activeCompaction(sessionId)?.startedAt > Number(operation.startedAt)) return
    const pending = state.pendingCommands[sessionId]
    if (operation.active === true) {
      const terminal = state.compactionTerminals?.[sessionId]
      if (terminal && Number(operation.startedAt) <= terminal.startedAt) return
      delete state.pendingCommands[sessionId]
      setCompactionStatus(sessionId, { ...operation, source: 'status' })
    } else if (activeCompaction(sessionId) && activeCompaction(sessionId).source !== 'event') {
      setCompactionStatus(sessionId, operation)
    } else if (pending) {
      if (operation.phase === 'failed') toast(t('session.commandFailed', { command: pending, msg: operation.message || t('send.failed') }), 'err')
      delete state.pendingCommands[sessionId]
    }
  } catch {}
}

function ensureCompactionMonitoring() {
  const active = Object.values(state.compactions).some(compact => compact?.active)
  if (!active) {
    if (state.compactionPollTimer) clearInterval(state.compactionPollTimer)
    if (state.compactionClockTimer) clearInterval(state.compactionClockTimer)
    state.compactionPollTimer = null
    state.compactionClockTimer = null
    return
  }
  if (!state.compactionClockTimer) {
    state.compactionClockTimer = setInterval(() => {
      if (activeCompaction()) updateSessionStatus()
    }, 1000)
  }
  if (!state.compactionPollTimer) {
    state.compactionPollTimer = setInterval(() => {
      const compact = activeCompaction()
      if (compact && compact.source !== 'event') void refreshCompactionStatus()
    }, 3000)
  }
}

function observeCompactionEvent(sessionId, event, meta = {}) {
  if (!event || !sessionId || !['compaction/start','compaction/end','session/end-seed'].includes(event.type)) return
  state.compactionSeqs ||= {}; state.compactionBootAt ||= Date.now()
  const seq = Number(event.seq), previous = activeCompaction(sessionId)
  if (seq > 0 && seq <= (state.compactionSeqs[sessionId] || 0)) return
  const id = event.data?.compactionId || ''
  if (event.type === 'compaction/end' && previous?.compactionId && previous.compactionId !== id) return
  if (seq > 0) state.compactionSeqs[sessionId] = seq
  const time = typeof event.time === 'number' ? event.time : Date.parse(event.time)
  if (event.type === 'compaction/start') {
    setCompactionStatus(sessionId, { active: true, phase: 'running', compactionId: id,
      startedAt: previous?.startedAt || (Number.isFinite(time) ? time : Date.now()), source: previous?.source || 'event',
      notify: meta.replay ? false : previous?.notify || Number.isFinite(time) && time >= state.compactionBootAt })
  } else {
    setCompactionStatus(sessionId, { active: false, phase: event.type === 'session/end-seed' ? 'interrupted' : event.data?.error ? 'failed' : 'complete',
      message: event.data?.error || '', ...(meta.replay || event.type === 'session/end-seed' ? { notify: false } : {}) })
  }
}

function onSessionEvent(sessionId, event, meta = {}) {
  if (!event) return
  if (['agent/status', 'agent/error', 'turn/start', 'turn/end', 'goal/completed'].includes(event.type) && typeof window !== 'undefined' && window.NativeBackground?.handleTaskEvent) window.NativeBackground.handleTaskEvent(bgBase(), state.token || '', JSON.stringify({ payload: { sessionId, event } }), meta.replay === true)
  const s = state.byId.get(sessionId)
  observeCompactionEvent(sessionId, event, meta)
  if (event.type === 'turn/start' || event.type === 'turn/end') {
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error' && s) {
      s.error = true; s.running = false
      if (state.current === sessionId) { updateCancelBtn(); renderSessionSub(); updateSessionStatus() }
    }
    noteSessionTurnTime(sessionId, event)
    renderSessions()
    if (event.type === 'turn/start') state.runtimeErrors?.delete(sessionId)
    if (event.type === 'turn/end' && !meta.replay) scheduleSessionSync(sessionId)
  }
  if (event.type === 'agent/status') {
    if (event.data?.running) state.runtimeErrors?.delete(sessionId)
    else if (!meta.replay) scheduleSessionSync(sessionId)
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
  if (state.refreshTimer) return
  const connection = captureConnection()
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; if (connection.valid()) void refreshAll() }, 700)
}

async function refreshAll() {
  await refreshSessions()
  if (state.current) { renderSessionCards(); renderSessionSub(); updateCancelBtn(); updateSessionStatus() }
  renderPending(); renderQueue(); renderJobs(); updateConn()
}

async function refreshSessions() {
  if(typeof restoreCachedSessionList==='function')restoreCachedSessionList()
  const connection = captureConnection(), request = ++sessionsRequest
  const v = await safeRpc('session.list', {}, t('err.sessionList'))
  if (!connection.valid() || request !== sessionsRequest) return
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
  for (const [id, child] of Object.entries(state.subagentSessions || {})) {
    const listed = state.byId.get(id)
    const merged = listed ? { ...child, ...listed, parentSessionId: child.parentSessionId, subagentMode: child.subagentMode, origin: 'subagent' } : child
    state.byId.set(id, merged)
    state.subagentSessions[id] = merged
  }
  applyPendingProjections()
  cacheWrite(CACHE.sessions, state.sessions.slice(0, 80))
  if(typeof window!=='undefined')window.DshDoctorEntry?.consumeSessionLink(openSession,state.byId)
  renderSessions()
  refreshWorkbench()
}

function removeLocalSessionRecord(sessionId) {
  if (!sessionId) return
  void window.DshHistory.cacheRemove(historyCacheScope(),sessionId)
  state.sessions = state.sessions.filter(session => session?.sessionId !== sessionId)
  state.byId.delete(sessionId)
  state.pendingProjections.delete(sessionId)
  state.sessionActivity.delete(sessionId)
  state.pendingPrompts.delete(sessionId)
  delete state.queues[sessionId]
  delete state.jobs[sessionId]
  LS.del(historyCacheScope()) // Also discard the obsolete monolithic cache.
  cacheWrite(CACHE.sessions, state.sessions.slice(0, 80))
}

function proj(s, key, d) { return s?.projections?.values?.[key] ?? d }
function optionalPluginConfig(connection = captureConnection()) {
  return { connection, valid: connection.valid, url: path => connection.server + path,
    headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() } }
}
function availableInsightTabs(capabilities, session) {
  const context = capabilities.context
  return [...(context ? ['context'] : []), ...(capabilities.cost ? ['cost'] : [])]
}
async function refreshInsightEntry() {
  const control = $('btn-insights'), id = state.current, connection = captureConnection()
  if (!control || !id || !connection.token || !window.DshExtensions) { control?.classList.add('hidden'); return }
  const capabilities = await window.DshExtensions.getCapabilities(optionalPluginConfig(connection))
  if (!connection.valid() || state.current !== id) return
  const tabs = availableInsightTabs(capabilities, state.byId.get(id))
  control.classList.toggle('hidden', !tabs.length)
  const label = t(tabs.length === 2 ? 'insights.title' : tabs[0] === 'cost' ? 'insights.costTitle' : 'insights.contextTitle')
  control.textContent = label; control.title = label; control.setAttribute('aria-label', label)
}
async function openInsights(tab = 'context', fullPage = false) {
  const connection = captureConnection(), id = state.current
  const capabilities = await window.DshExtensions.getCapabilities(optionalPluginConfig(connection))
  if (!connection.valid() || state.current !== id || !id) return
  const allowedTabs = availableInsightTabs(capabilities, state.byId.get(id))
  if (!allowedTabs.length) { void refreshInsightEntry(); return }
  window.DshInsights?.close()
  const view = fullPage ? getConversationView() : null, wasPaused = view?.paused
  view?.pause()
  window.DshInsights?.open({ tab, fullPage, allowedTabs, connection, url: path => connection.server + path,
    getSession: () => state.byId.get(state.current), getTitle: () => sessionTitleValue(state.byId.get(state.current)),
    onFullPage: selected => void openInsights(selected, true),
    onClose: () => { if (view && !wasPaused && connection.valid() && state.current === id) view.resume() } })
}
function hydrateSessionProjections(sessionId, projections) {
  const s = state.byId.get(sessionId)
  if (!s || !projections || typeof projections !== 'object') return
  const incomingSeq = Number(projections.asOfSeq) || 0
  const current = s.projections || { asOfSeq: 0, values: {} }
  if (projections.kind === 'cached' && current.kind === 'sequenced') return
  if (current.kind === 'cached' || projections.kind === 'cached') {
    s.projections = { ...projections, asOfSeq: incomingSeq, kind: projections.kind || 'sequenced', values: { ...(current.values || {}), ...(projections.values || {}) } }
    return
  }
  const currentSeq = Number(current.asOfSeq) || 0
  if (incomingSeq < currentSeq) return
  s.projections = {
    kind: projections.kind || current.kind || 'sequenced',
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
  if (s.projections?.kind === 'cached') s.projections = { kind: 'sequenced', asOfSeq: 0, values: { ...(s.projections.values || {}) } }
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
// Coalesce activity/status signals, including signals received during a history read.
function scheduleSessionSync(sessionId = state.current, delay = 250) {
  if (!sessionId || sessionId !== state.current) return
  const history = state.history, connection = captureConnection()
  if (history.syncTimer) return
  delay = Math.max(delay, 2000 - (Date.now() - (history.lastSyncAt || 0)))
  history.syncTimer = setTimeout(() => {
    history.syncTimer = null
    if (!connection.valid() || state.current !== sessionId || state.history !== history) return
    if (history.loading) { scheduleSessionSync(sessionId, 500); return }
    void resyncCurrentSession().catch(() => {})
  }, delay)
}
function sessionSyncTick() {
  if (document.visibilityState === 'visible' && state.token && navigator.onLine !== false &&
      state.current && !state.history.loading && Date.now() - (state.history.lastSyncAt || 0) >= 15000) scheduleSessionSync(state.current, 0)
}
function rememberRuntimeError(sessionId, message) {
  if (!sessionId) return
  state.runtimeErrors ||= new Map()
  state.runtimeErrors.set(sessionId, String(message || ''))
  if (state.runtimeErrors.size > 100) state.runtimeErrors.delete(state.runtimeErrors.keys().next().value)
  if (sessionId === state.current) { renderHistory(); scheduleSessionSync(sessionId) }
}
function resyncAfterStreamOpen() {
  if (!state.current || Date.now() - state.lastStreamResyncAt < 1200) return
  state.lastStreamResyncAt = Date.now()
  void refreshAll().then(() => resyncCurrentSession())
}
function sessionTitleValue(s) {
  const value = proj(s, 'title', '')
  return value == null ? '' : String(value).trim()
}
function hasSessionTitle(s) { return !!sessionTitleValue(s) }
function titleOf(s) { return sessionTitleValue(s) || (s?.sessionId ? t('session.untitled') : t('session.unknown')) }
function sessionLabelOf(s) {
  const title = titleOf(s)
  if (!s?.sessionId || hasSessionTitle(s)) return title
  return `${title} · ${String(s.sessionId).slice(-8)}`
}
function short(id) { return '…' + String(id).slice(-8) }
function isTopLevelSession(session) {
  // Ordinary forks also carry parentSessionId; only explicit subagents leave the main list.
  return !!session && session.origin !== 'subagent'
}
// DSH marks sessions created via "new session" but never prompted as blank and hides
// them in its own UI; keep the same semantics here so they do not occupy the list,
// the workspace tree or the home stats.
function isVisibleSession(session) { return isTopLevelSession(session) && !session?.blank }
function topLevelSessions() { return state.sessions.filter(isVisibleSession) }
const GOAL_TERMINAL_PHASES = new Set(['complete', 'cleared'])
function isGoalTerminal(goal) {
  return !!goal && GOAL_TERMINAL_PHASES.has(goal.phase)
}
function goalOf(s) {
  const p = proj(s, 'goal')
  if (!p) return null
  return p.goal && typeof p.goal === 'object' ? p.goal : p
}
const COLLAPSED_GOALS_KEY = 'dshCollapsedGoalsV1'
function collapsedGoals() {
  try {
    const value = JSON.parse(LS.get(COLLAPSED_GOALS_KEY, '[]'))
    return Array.isArray(value) ? value.filter(item => item && typeof item.sessionId === 'string' && typeof item.goalId === 'string') : []
  } catch { return [] }
}
function goalDisplayId(goal) { return String(goal?.id || '__current__') }
function isGoalCollapsed(sessionId, goal) {
  const goalId = goalDisplayId(goal)
  return collapsedGoals().some(item => item.sessionId === sessionId && item.goalId === goalId)
}
function setGoalCollapsed(sessionId, goal, collapsed) {
  const goalId = goalDisplayId(goal)
  const next = collapsedGoals().filter(item => item.sessionId !== sessionId)
  if (collapsed) next.push({ sessionId, goalId })
  LS.set(COLLAPSED_GOALS_KEY, JSON.stringify(next.slice(-100)))
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
async function refreshWorkbench({ discover = false } = {}) {
  const connection = captureConnection(), request = ++workbenchRequest
  const valid = () => connection.valid() && request === workbenchRequest
  const sharedRead = (name, read) => window.DshNetwork?.shareRead ? window.DshNetwork.shareRead(JSON.stringify([connection.server, connection.token, name]), read) : read()
  if (!state.token) return
  const workspaceRead = sharedRead('workspace.list', () => connection.valid() ? rpc('workspace.list', {}) : null).catch(() => null)
  try {
    const target = apiUrl('/workbench')
    const res = await sharedRead('workbench', async () => {
      if(!connection.valid())return {ok:false,value:null}
      const response = await fetch(target, {
        headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }, signal: AbortSignal.timeout(10000)
      })
      return { ok: response.ok, value: await response.json().catch(() => null) }
    })
    if (!valid()) return
    if (res.ok) {
      const value = res.value
      if (!valid()) return
      if (value && typeof value.bound === 'boolean') state.wb = value
    }
  } catch {}
  if (!valid()) return
  try {
    const value = await workspaceRead
    if (!valid()) return
    if (value) state.wbProjects = Array.isArray(value.items) ? value.items : []
    if (value) state.wbArchived = Array.isArray(value.archivedSessionIds) ? value.archivedSessionIds : []
  } catch {
    if (!valid()) return
    state.wbProjects = []
    state.wbArchived = []
  }
  // 以磁盘实际目录为准同步工作台项目：删除目录后不再残留，新增子目录自动收纳。
  if (discover && state.wb?.bound && state.wb.path) {
    try {
      const listRes = await fetch(fsApiUrl('/list', { path: state.wb.path }), { headers: fsHeaders() })
      if (!valid()) return
      if (listRes.ok) {
        const listData = await listRes.json().catch(() => ({}))
        if (!valid()) return
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
            if (!valid()) return
            try {
              const created = await rpc('workspace.create', { path: projectPath })
              if (!valid()) return
              if (created?.workspace) { state.wbProjects.push(created.workspace); have.add(wbPathKey(projectPath)) }
            } catch {}
            if (!valid()) return
          }
        }
      }
    } catch {}
    if (!valid()) return
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
    const sessions = orderedWorkspaceSessions(id, (w.sessionIds || []).map(sid => state.byId.get(sid)).filter(isVisibleSession).filter(s => !archivedSet.has(s.sessionId)))
    const body = open ? `<div class="wb-sessions">${sessions.length ? sessions.map(s => `
      <div class="session-swipe" data-session-swipe data-id="${esc(s.sessionId)}" role="button" tabindex="0" aria-label="${esc(sessionLabelOf(s))}">
        <button class="wb-session" type="button" data-wb-session="${esc(s.sessionId)}" data-motion-key="${esc(s.sessionId)}">
          <span class="wb-session-drag-handle" data-reorder-handle aria-hidden="true">⠿</span>
          <span class="wb-session-title">${esc(sessionLabelOf(s))}</span>
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
      const title = sessionLabelOf(s)
      const goal = goalOf(s)
      const pending = (state.approvals.some(a => a.sessionId === s.sessionId) || state.questions.some(q => q.sessionId === s.sessionId)) ? 'pending' : ''
      const queueN = (state.queues[s.sessionId] || []).filter(i => i.placement === 'queued').length
      const dots = []
      if (s.running) dots.push('running')
      if (pending) dots.push('pending')
      const badge = goal ? `<span class="sc-badge ${goal.phase === 'active' ? 'goal-active' : ''}">${esc(t('sessions.goalBadge', { phase: goal.phase || '?' }))}</span>` : ''
      const queueBadge = queueN ? `<span class="sc-badge">${esc(t('sessions.queueBadge', { n: queueN }))}</span>` : ''
      const archiveButton = archivedSet.has(s.sessionId) ? '' : `<button type="button" class="sc-archive-btn" data-archive-session="${esc(s.sessionId)}">${esc(t('session.archive'))}</button>`
      return `<div class="session-swipe" data-session-swipe data-id="${esc(s.sessionId)}" role="button" tabindex="0" aria-label="${esc(sessionLabelOf(s))}">
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
const emptySessionCleanup = new Set()
async function archiveEmptySessionOnLeave(sessionId, leaving = false) {
  const base = state.server, connection=captureConnection()
  const protectedSession = () => !connection.valid() || state.server !== base || (!leaving && state.current !== sessionId)
    || !!state.byId.get(sessionId)?.parentSessionId || state.byId.get(sessionId)?.origin === 'subagent'
    || !state.byId.has(sessionId) || state.byId.get(sessionId)?.running
    || state.sessionActivity?.has(sessionId) || state.pendingPrompts?.has(sessionId)
    || (state.queues[sessionId] || []).length > 0
    || (state.composerImages || []).length > 0 || !!$('composer-input')?.value?.trim()
  if (!sessionId || emptySessionCleanup.has(sessionId) || protectedSession()) return false
  emptySessionCleanup.add(sessionId)
  try {
    const history = await rpc('session.history', { sessionId, maxMessages: 1 })
    if (protectedSession() || !Array.isArray(history?.events) || history.events.some(item => !['permission/preset', 'sandbox/mode', 'approval/policy'].includes(item?.event?.type || item?.type))
        || history.hasMore || (history.partialReasoning || []).length) return false
    const result = await rpc('workspace.archiveSession', { sessionId })
    if (!Array.isArray(result?.archivedSessionIds) || !result.archivedSessionIds.includes(sessionId)) return false
    if (state.server !== base) return false
    await refreshSessions()
    return true
  } catch { return false } // 离线、历史未知或归档失败时保留会话。
  finally { emptySessionCleanup.delete(sessionId) }
}

async function openSession(id) {
  globalThis.DshDiagnostics?.record('session.open',{phase:'start',sessionId:id,server:state.server})
  if (state.current && state.current !== id) void archiveEmptySessionOnLeave(state.current,true)
  cancelHistoryLoad()
  state.current = id
  setSessionRecovery('loading')
  state.history = emptyHistory()
  const openingHistory=state.history, openingConnection=captureConnection()
  document.body.classList.add('in-session')
  showView('view-session')
  $('btn-rename-session').classList.remove('hidden')
  $('btn-archive-session').classList.toggle('hidden', (state.wbArchived || []).includes(id))
  $('session-cards').innerHTML = ''
  renderSessionTitle(); renderSessionSub(); updateCancelBtn(); updateSessionStatus()
  renderSessionCards()
  $('history').innerHTML = '<div class="empty">' + t('history.loading') + '</div>'
  renderQueue()
  renderSessionPending()
  void refreshCompactionStatus(id)
  getConversationView().reset()
  try { const restored=await restoreCachedHistory();globalThis.DshDiagnostics?.record('history.cache',{phase:restored?'hit':'miss',sessionId:id}) } catch(error) {
    globalThis.DshDiagnostics?.record('history.cache',{phase:'failed',sessionId:id,...globalThis.DshDiagnostics.errorFacts(error)})
    if(state.current!==id||state.history!==openingHistory||!openingConnection.valid())return
    // A broken local cache must not prevent fetching the authoritative history.
    cancelHistoryLoad()
    Object.assign(openingHistory,emptyHistory())
    getConversationView().reset()
  }
  if(state.current!==id||state.history!==openingHistory||!openingConnection.valid())return
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

function shouldDiscardEmptySession(sessionId) {
  const session = state.byId.get(sessionId)
  if (!session || sessionHasPendingActivity(sessionId, session)) return false
  return state.current === sessionId && !state.history.loading && !state.history.renderError
    && !(state.composerImages || []).length && !$('composer-input')?.value?.trim()
    && isEmptySessionHistory(state.history)
}

async function closeSession() {
  globalThis.DshDiagnostics?.record('session.back',{phase:'start',sessionId:state.current,loading:state.history.loading,loaded:state.history.loaded,renderErrors:state.history.renderError?1:0})
  const sessionId = state.current
  const parentId = state.byId.get(sessionId)?.parentSessionId
  if (parentId && parentId !== sessionId) {
    setComposerFullscreen(false);clearComposerImages();hideComposerMenu()
    return openSession(parentId)
  }
  const wasLoading = state.history.loading
  cancelHistoryLoad()
  const connection=captureConnection(),discard=!wasLoading&&shouldDiscardEmptySession(sessionId)
  state.current = null
  state.history = emptyHistory()
  document.body.classList.remove('in-session')
  showView('view-home')
  globalThis.DshDiagnostics?.record('session.back',{phase:'navigate',sessionId})
  renderSessionPending()
  setComposerFullscreen(false)
  clearComposerImages()
  setSessionRecovery('idle')
  $('btn-rename-session').classList.add('hidden')
  $('btn-archive-session').classList.add('hidden')
  hideComposerMenu()
  renderSessions()
  renderWorkbench()
  // Navigation must never wait for history reads or archive RPCs. A later session
  // owns its own navigation even while this best-effort cleanup is still pending.
  if(discard && await archiveEmptySessionOnLeave(sessionId,true) && connection.valid()) {
    removeLocalSessionRecord(sessionId)
    renderSessions();renderWorkbench()
  }
}

/* Android 手势返回/实体返回: 注册后系统不再直接杀 App, 由这里接管导航 */
function bindNativeBack() {
  if (!CAP?.isNativePlatform?.()) return
  try {
    CAP.Plugins?.App?.addListener?.('appStateChange',({isActive})=>{if(isActive)onResume()})
    CAP.Plugins?.App?.addListener?.('backButton', () => {
      if ($('composer-wrap')?.classList.contains('fs')) { setComposerFullscreen(false); return }
      if (customSelectCurrent) { closeCustomSelect(); return }
      if (groupDrawerOpen()) { closeGroupDrawer(); return }
      if (typeof window !== 'undefined' && window.DshImagePreview?.isOpen?.()) { window.DshImagePreview.close(); return }
      if (typeof window !== 'undefined' && window.DshExtensions?.closeShortcuts(true)) return
      if (typeof window !== 'undefined' && window.DshFileInbox?.close()) return
      const dialog = document.querySelector('dialog[open]')
      if (dialog) { dialog.close(); return }
      const openModal = [...document.querySelectorAll('.modal')].find(m => !m.classList.contains('hidden'))
      if (openModal) { if (openModal.id === 'modal-notes') closeNotesModal(); else if (openModal.id === 'modal-archive') closeArchiveConfirm(); else if (openModal.id === 'modal-rename') closeRenameSession(); else if (openModal.id === 'modal-app-version-warning') closeAppVersionWarning(false); else if (openModal.id === 'modal-scan-live') closeLiveScan(''); else openModal.classList.add('hidden'); return }   // 先关弹窗
      if (!$('view-settings').classList.contains('hidden')) {
        if ($('settings-home').classList.contains('hidden')) showSettingsHome()
        else showView('view-home')
        return
      }
      if (!$('view-plugins').classList.contains('hidden')) { showView('view-settings'); return }
      if (document.body.classList.contains('in-session')) { void closeSession(); return } // 会话页 → 回主页
      if (!$('view-files').classList.contains('hidden')) {           // 文件页 → 上级目录 → 主页
        if (state.fs.path && state.fs.initial && state.fs.path !== state.fs.initial) { fsUp(); return }
        showView('view-home'); return
      }
      if ($('view-home').classList.contains('hidden')) { showView('view-home'); return }
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
  const workspace = s.cwd || ''
  const name = workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspace
  $('session-sub').textContent = '📁 ' + (name || t('session.noWorkspace')) + '  ›'
  $('session-sub').title = workspace || t('session.noWorkspace')
}

/** 顶栏状态: 运行中=蓝色流动渐变, 中断/出错=橙红渐变, 空闲=原样式 */
function updateSessionStatus() {
  renderComposerSend()
  const s = state.byId.get(state.current)
  const head = $('session-head')
  if (!head) return
  const composerStatus = $('composer-status')
  const compact = activeCompaction()
  if (composerStatus) {
    const queued = (state.queues[state.current] || []).some(i => i.placement !== 'context')
    composerStatus.classList.toggle('hidden', !s?.running && !compact && !queued)
    composerStatus.classList.toggle('compacting', !!compact)
  }
  const composerText = $('composer-status-text')
  if (composerText) composerText.textContent = compact
    ? (compact.command === 'compact'
        ? t('session.compacting', { elapsed: compactElapsed(compact.startedAt) })
        : t('session.commandRunning', { command: compact.command, elapsed: compactElapsed(compact.startedAt) }))
    : t('composer.running')
  head.classList.remove('running', 'interrupted')
  const queued = (state.queues[state.current] || []).some(i => i.placement !== 'context')
  if (s?.running || queued || compact) head.classList.add('running')
  else if (s?.error) head.classList.add('interrupted')
}

function updateCancelBtn() {
  const s = state.byId.get(state.current)
  const running = s?.running || (state.queues[state.current] || []).some(i => i.placement !== 'context')
  $('btn-cancel').classList.toggle('hidden', !running)
  $('composer-status')?.classList.toggle('hidden', !running && !activeCompaction())
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
function applyReasoningBaseline(items) {
  if (!Array.isArray(items)) return
  state.history.reasoningVersion = (state.history.reasoningVersion || 0) + 1
  state.history.partialReasoning.clear()
  for (const item of items) state.history.partialReasoning.set(reasoningStreamKey(item, item.index), item)
}

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
  } else if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') {
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
function weakStreamTrim() { return !!window.DshNetwork?.streamTrimmed?.() }
function scheduleReasoningRender() {
  if (reasoningRenderTimer) return
  reasoningRenderTimer = setTimeout(() => {
    reasoningRenderTimer = null
    if (!state.current) return
    renderHistory(false, 'fixed')
  }, weakStreamTrim() ? 500 : 80)
}

function partialReasoningHtml() {
  if (weakStreamTrim()) return state.history.partialReasoning.size ? window.DshActivity?.streamNotice?.() || '' : ''
  return [...state.history.partialReasoning.values()]
    .filter(item => item.text)
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || (a.step ?? 0) - (b.step ?? 0) || (a.index ?? 0) - (b.index ?? 0))
    .map(item => window.DshActivity ? window.DshActivity.reasoning({text:item.text,live:true,key:window.DshActivity.reasoningKey(item,item.index,'live-reasoning')}) : `<div class="msg assistant reasoning-live"><div class="role">${esc(t('role.dsh'))}</div><details class="tool" open><summary>${esc(t('block.thinkingLive'))}</summary><div class="tool-text">${esc(truncate(item.text, 12000))}</div></details></div>`)
    .join('')
}


function restoreCachedSessionList() {
  if(state.sessions.length)return
  try{const items=JSON.parse(LS.get(CACHE.sessions,''));if(!Array.isArray(items))return;state.sessions=items.filter(item=>typeof item?.sessionId==='string').slice(0,80);state.byId=new Map(state.sessions.map(item=>[item.sessionId,item]));renderSessions()}catch{}
}

let conversationView = null
function historyCacheScope(server=state.server,token=state.token) { return connectionCacheKey('history',server,token) }
function captureChatImage() {
  const connection=captureConnection(),sessionId=state.current
  return {scope:historyCacheScope(),valid:()=>connection.valid()&&state.current===sessionId}
}
function historySource(value) {
  state.history.source=value
  const el=$('history-source')
  if(el)el.textContent=t(({cache:'history.cached',syncing:'history.syncing',synced:'history.synced',saved:'history.saved',offline:'history.offline',saveFailed:'history.cacheFailed',error:'history.renderFailed'})[value]||'history.synced')
}
function getConversationView() {
  if(!conversationView)conversationView=new window.DshHistory.HistoryView($('history'),{
    html:entry=>eventHtml(entry, {toolNames:state.history.toolNames}),
    errorLabel:()=>t('history.renderFailed'),
    older:()=>loadHistory(false),olderLabel:()=>t('history.earlier'),loadingLabel:()=>t('history.loadingEarlier'),live:partialReasoningHtml,
    retry:()=>loadHistory(true),retryLabel:()=>t('history.retry'),unreadableLabel:()=>I18N.lang==='en'?'No displayable messages on this page. Load earlier records or retry. If DSH reports a migration failure, open the original session in DSH.':'本页历史没有可显示的消息，请加载更早记录或重试。如提示格式迁移失败，请先在 DSH 中打开原会话。',
    changed:view=>{state.history.renderStart=view.start;state.history.renderEnd=view.end;const latest=$('btn-history-latest');if(latest){latest.classList.toggle('hidden',view.atBottom&&view.unread===0&&!state.history.tailEvicted);latest.textContent=t('history.latest')+(view.unread?' ('+view.unread+')':view.hasPending?' · '+(I18N.lang==='en'?'New content':'有新内容'):'')}updateRail(view.domChanged)},
    scrolled:()=>{updateRail()}
  })
  return conversationView
}
function scheduleHistoryCacheSave() {
  clearTimeout(scheduleHistoryCacheSave._t)
  const connection=captureConnection(),id=state.current,history=state.history,scope=historyCacheScope()
  scheduleHistoryCacheSave._t=setTimeout(()=>{if(connection.valid()&&state.current===id&&state.history===history)void saveHistoryCache(scope,id,history)},500)
}
async function saveHistoryCache(scope=historyCacheScope(),id=state.current,history=state.history) {
  if(!id||!history.visible.length||history.tailEvicted)return
  const saved=await window.DshHistory.cacheSave(scope,id,{title:titleOf(state.byId.get(id)),events:history.visible.slice(-250),minSeq:history.visible.slice(-250)[0]?.seq??history.minSeq,hasMore:history.hasMore||history.visible.length>250,partialReasoning:[...history.partialReasoning.values()]})
  if(!saved&&state.current===id&&state.history===history&&scope===historyCacheScope())historySource('saveFailed')
  if(saved&&state.current===id&&state.history===history&&scope===historyCacheScope()&&['synced','saveFailed'].includes(history.source))historySource('saved')
}
async function restoreCachedHistory() {
  const connection=captureConnection(),id=state.current,history=state.history,scope=historyCacheScope()
  if(!id)return false
  const cached=await window.DshHistory.cacheLoad(scope,id,legacyId=>window.DshHistory.decodeLegacy(LS.get(scope,''),legacyId))
  if(!connection.valid()||state.current!==id||state.history!==history||(history.loaded&&!history.cached)||!cached?.events?.length)return false
  history.visible=cached.events.slice(-250).filter(entry=>entry?.seq!=null&&shouldShowEvent(entry.event?.type,entry.event)).sort((a,b)=>a.seq-b.seq)
  history.seqs=new Set(history.visible.map(entry=>entry.seq));history.loaded=true;history.cached=true;history.hasMore=cached.events.length>250||cached.hasMore!==false;history.minSeq=cached.events.length>250?(history.visible[0]?.seq??Infinity):Number.isFinite(cached.minSeq)?cached.minSeq:history.visible[0]?.seq??Infinity
  if(cached.title&&!hasSessionTitle(state.byId.get(id)))hydrateSessionProjections(id,{values:{title:cached.title},asOfSeq:0})
  applyReasoningBaseline(cached.partialReasoning||[]);historySource('cache');setSessionRecovery('cached');renderHistory(true)
  return true
}
function trimVisible(direction='tail') {
  const h=state.history,excess=h.visible.length-5000
  if(excess<=0)return
  const older=direction==='older'||conversationView?.reading
  const removed=older?h.visible.splice(5000):h.visible.splice(0,excess)
  for(const entry of removed)h.seqs.delete(entry.seq)
  if(older)h.tailEvicted=true
  else{h.minSeq=h.visible[0]?.seq??Infinity;h.headEvicted=true;h.hasMore=true}
}

function cancelHistoryLoad() {
  const history=state.history
  if(!history)return
  const controller=history.loadController
  history.loadController=null
  history.loading=false
  controller?.abort()
  clearTimeout(history.syncTimer);history.syncTimer=null
}
function recoverSessionHistory() {
  cancelHistoryLoad()
  scheduleSessionSync()
}
async function loadHistory(reset = true) {
  const connection=captureConnection(),id=state.current,history=state.history
  if(!id||history.loading||(!reset&&Date.now()<(history.retryAfter||0)))return
  const diagnostic=globalThis.DshDiagnostics?.start('history.load',{sessionId:id,server:state.server,reset,cached:!!history.cached,count:history.visible.length})
  const reasoningVersion=history.reasoningVersion||0,hadContent=history.visible.length>0
  const controller=new AbortController()
  history.loadController=controller
  const valid=()=>connection.valid()&&state.current===id&&state.history===history&&history.loadController===controller
  history.loading=true
  history.lastSyncAt=Date.now()
  let v
  // Contain preparation and final DOM failures as well as network errors. Reset
  // the view before replacing its DOM so an identical retry cannot reuse stale nodes.
  const failLoad = (error,renderFailure=false) => {
    diagnostic?.fail(error)
    history.loading=false;history.retryAfter=Date.now()+1500
    if(error.message==='AUTH'){authFailure();return}
    if(history.visible.length&&!renderFailure){try{renderHistory(false,'fixed');history.renderError=!!getConversationView().renderErrors;historySource(history.renderError?'error':'offline');setSessionRecovery(history.renderError?'error':'cached',error.message);return}catch{}}
    history.renderError=true;historySource('error')
    setSessionRecovery('error',error.message)
    getConversationView().reset?.()
    $('history').innerHTML='<div class="history-empty">'+esc(error.message)+'</div>'
    const retry=document.createElement('button');retry.type='button';retry.className='history-page-control';retry.textContent=t('history.retry');retry.addEventListener('click',()=>{void loadHistory(true)});$('history').append(retry)
  }
  try {
    if(reset){if(hadContent)historySource('syncing');else setSessionRecovery('loading')}
    const network=window.DshNetwork?.profile() || {historyPageSize:60,readTimeout:45000}
    const payload={sessionId:id,maxMessages:network.historyPageSize}
    const child=state.subagentSessions?.[id] || state.byId.get(id)
    if(child?.origin==='subagent' && child.parentSessionId) Object.assign(payload,{parentSessionId:child.parentSessionId,subagentMode:child.subagentMode || 'unknown'})
    if(!reset&&Number.isFinite(history.minSeq))payload.beforeSeq=history.minSeq
    getConversationView().more.disabled=true
    getConversationView().more.textContent=getConversationView().options.loadingLabel()
    v=await window.DshNetwork.readWithDeadline(signal=>rpc('session.history',payload,network.readTimeout,signal),network.readTimeout,controller.signal);globalThis.DshDiagnostics?.record('history.load',{phase:'response',traceId:diagnostic?.traceId,sessionId:id,rawCount:Array.isArray(v?.events)?v.events.length:0})
    if(!valid())return
    let liveReasoning, rawSeqs, floor
    liveReasoning=(history.reasoningVersion||0)!==reasoningVersion?new Map(history.partialReasoning):null
    hydrateSessionProjections(id,v.projections);history.loaded=true
    const incoming=v.events||[],prepared=[]
    let approvalChanged=false
    for (const entry of incoming) {
      const ev=entry?.event
      applyReasoningStreamEvent(ev)
      if(ev?.type==='turn/start'||ev?.type==='turn/end')noteSessionTurnTime(id,ev)
      if(collectApprovalEvent(id,ev))approvalChanged=true
      if(ev?.seq==null||!shouldShowEvent(ev.type,ev))continue
      prepared.push({seq:ev.seq,event:ev,view:entry.view})
    }
    rawSeqs=incoming.map(entry=>entry?.event?.seq).filter(Number.isFinite);floor=rawSeqs.length?Math.min(...rawSeqs):Infinity
    if(reset){const retainedOlder=!!v.hasMore&&history.visible.some(entry=>entry.seq<floor);const ceiling=rawSeqs.length?Math.max(...rawSeqs)+1:Infinity;history.visible=rawSeqs.length?window.DshHistory.reconcile(history.visible,prepared,floor,!!v.hasMore,ceiling):[];history.minSeq=retainedOlder?Math.min(history.minSeq,floor):floor;history.tailEvicted=false}
    else{history.visible=window.DshHistory.reconcile(history.visible,prepared,floor,true,payload.beforeSeq);history.minSeq=Math.min(history.minSeq,floor)}
    history.seqs=new Set(history.visible.map(entry=>entry.seq));history.headEvicted=false;trimVisible(reset?'tail':'older')
    if(liveReasoning)history.partialReasoning=liveReasoning;else applyReasoningBaseline(v.partialReasoning)
    history.hasMore=(!!v.hasMore||(reset&&history.headEvicted)) && rawSeqs.length>0 && (reset || floor<payload.beforeSeq)
    try {
      history.loading=false;history.cached=false
      renderSessionTitle();renderSessionSub();renderSessionCards()
      globalThis.DshDiagnostics?.record('history.render',{phase:'start',traceId:diagnostic?.traceId,sessionId:id,count:history.visible.length})
      renderHistory(!hadContent,reset?'fixed':'keep')
      history.renderError=!!getConversationView().renderErrors
      historySource(history.renderError?'error':'synced');setSessionRecovery(history.renderError?'error':'ready')
      if(approvalChanged)renderApprovalRecords()
      $('history-hint').textContent=t('history.count',{n:history.visible.filter(entry=>!['turn/start','turn/end'].includes(entry.event?.type)).length})
      diagnostic?.end({phase:history.renderError?'failed':'rendered',count:history.visible.length,renderedCount:getConversationView().end-getConversationView().start,renderErrors:getConversationView().renderErrors||0})
      if(!history.renderError)scheduleHistoryCacheSave()
    } catch(error) { failLoad(error,true) }
  } catch(error) { if(valid())failLoad(error) }
  finally { if(history.loadController===controller){history.loading=false;history.loadController=null} }
}

function insertLiveEvent(event) {
  const h = state.history
  const approvalChanged = collectApprovalEvent(state.current, event)
  if (approvalChanged) renderApprovalRecords()
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
  window.DshHistory.insertSorted(h.visible, { seq, event })
  trimVisible()
  renderHistory(false, 'fixed')
  scheduleHistoryCacheSave()
}

function isToolEvent(type) { return type === 'tool/call' || type === 'tool/result' }

/** One collapsed row for a turn's tools and reasoning, matching the desktop conversation rhythm. */
function activityGroupHtml(group, ctx) {
  const items = group.items || []
  if (!items.length) return ''
  const tools = items.filter(item => item.kind === 'tool').map(item => item.entry)
  const running = !!group.running
  const failed = tools.some(entry => entry.view?.toolActivity?.error || entry.event?.data?.error)
  const body = items.map(item => item.kind === 'reasoning'
    ? window.DshActivity.reasoning({ text: item.text, key: item.key })
    : eventHtml(item.entry, ctx)).join('')
  return `<details class="chat-activity-group${failed ? ' is-error' : ''}${running ? ' is-running' : ''}" data-activity-key="activity-group:${items[0]?.seq ?? ''}"><summary><span class="activity-group-title">${esc(t('activity.group', { n: items.length }))}</span>${running ? `<span class="activity-group-live"><i aria-hidden="true"></i>${esc(t('activity.groupRunning'))}</span>` : ''}<span class="activity-chevron" aria-hidden="true"></span></summary><div class="activity-group-body">${body}</div></details>`
}

function filteredEntries() {
  const showTools = LS.get('showTools', '1') !== '0'
  const f = state.history.visible.filter(e => showTools || !isToolEvent(e.event?.type))
  state.history.filtered = f
  return f
}

function canForkTurnResult() {
  const session = state.byId.get(state.current)
  return !!session && session.origin !== 'subagent' && session.formatStatus !== 'migration-required' && activeGatewayCapability('operations') === true
}
function bindTurnResultActions() {
  window.DshTurnResults.bind($('history'), {
    capture: () => {
      const connection = captureConnection(), sessionId = state.current, history = state.history
      return { sessionId, entries: history.visible, key: JSON.stringify([connection.server, connection.token]), canFork: canForkTurnResult(),
        valid: () => connection.valid() && state.current === sessionId && state.history === history }
    },
    copy: copyText,
    fork: payload => rpc('session.fork', payload),
    open: async (id, context) => {
      const parent = state.byId.get(context.sessionId)
      if (!context.valid()) return
      // The fork already returned a confirmed ID. Do not wait for a catalog
      // read before opening it: a reconnecting host can leave that read pending.
      if (!state.byId.has(id)) {
        const branch = { ...parent, projections: parent?.projections ? JSON.parse(JSON.stringify(parent.projections)) : undefined,
          sessionId: id, parentSessionId: context.sessionId, origin: 'fork', running: false, blank: false }
        state.byId.set(id, branch)
        state.sessions.unshift(branch)
        renderSessions()
      }
      await openSession(id)
    }
  })
}

function renderHistory(reset=false,mode='auto') {
  const filtered=filteredEntries(),toolNames=new Map()
  for(const entry of state.history.visible){const d=entry.event?.data;if(entry.event?.type==='tool/call'&&d?.callId&&d.name)toolNames.set(d.callId,d.name)}
  state.history.toolNames=toolNames
  $('history-hint').textContent=t('history.count',{n:state.history.visible.filter(entry=>!['turn/start','turn/end'].includes(entry.event?.type)).length})
  let prepared=window.DshActivity?.prepare(filtered)||filtered
  // 弱网精简：尚未返回的调用在完成前不展示，只留已完成的消息与工具结果。
  if(weakStreamTrim())prepared=prepared.filter(entry=>entry.event?.type!=='tool/call'||entry.view?.toolActivity)
  // DSH 0.2.1 also embeds tool blocks in messages; the separated events own the grouped rows.
  state.history.suppressBlockTools = state.history.visible.some(entry => entry.event?.type === 'tool/call')
  if(window.DshActivity?.group)prepared=window.DshActivity.group(prepared)
  // Running is a property of the session's current turn, not of an unpaired call:
  // a finished turn may keep an unmatched call after an interrupt, and the model may be
  // thinking between tools while the last group is still the active one.
  const sessionRunning = !!state.byId.get(state.current)?.running
  const groups = prepared.filter(entry => entry.view?.activityGroup)
  const activeGroup = groups.at(-1)
  if (activeGroup) activeGroup.view.activityGroup.running = sessionRunning
  if (window.DshTurnResults) {
    prepared = window.DshTurnResults.decorate(prepared, state.history.visible, { sessionId: state.current, canFork: canForkTurnResult() })
    bindTurnResultActions()
  }
  if(window.DshActivity?.groupFailures)prepared=window.DshActivity.groupFailures(prepared)
  const hostError = state.runtimeErrors?.get(state.current)
  const recordedError = state.history.visible.some(entry => window.DshActivity?.failure?.(entry.event)?.message === hostError)
  const runtimeHtml = hostError && !recordedError ? window.DshActivity?.failureHtml?.(hostError) || '' : ''
  getConversationView().set(prepared,{reset,follow:mode==='bottom',live:partialReasoningHtml()+runtimeHtml,hasMore:state.history.hasMore,loading:state.history.loading,emptyLabel:t('history.empty')})
  window.DshImagePreview?.hydrate?.($('history'))
}
window.applyStreamPreference=()=>{if(state.current)renderHistory(false,'auto')}

/* 右侧导航条: 用户发言节点 + 拖动快速定位 */
let historyRailLayout=null
function updateRail(rebuild=false) {
  const box=$('history'),thumb=$('rail-thumb'),nodesBox=$('rail-nodes')
  if(!box||!thumb||!nodesBox)return
  const sh=box.scrollHeight,ch=box.clientHeight
  if(sh<=ch){thumb.style.display='none';nodesBox.replaceChildren();historyRailLayout=null;return}
  thumb.style.display=''
  const trackH=Math.max(1,ch-8),thumbH=Math.max(32,ch/sh*trackH),ratio=box.scrollTop/Math.max(1,sh-ch)
  thumb.style.height=thumbH+'px';thumb.style.top=(4+ratio*(trackH-thumbH))+'px'
  if(rebuild||!historyRailLayout||historyRailLayout.height!==sh||historyRailLayout.width!==box.clientWidth){
    const top=box.getBoundingClientRect().top
    const allOffsets=[...box.querySelectorAll('.msg.user')].map(el=>el.getBoundingClientRect().top-top+box.scrollTop)
    const count=Math.min(24,allOffsets.length),offsets=Array.from({length:count},(_,i)=>allOffsets[Math.round(i*(allOffsets.length-1)/Math.max(1,count-1))])
    nodesBox.innerHTML=offsets.map(off=>'<div class="rail-node" data-offset="'+Math.round(off)+'" style="top:'+Math.min(4+trackH,4+off/Math.max(1,sh)*trackH)+'px"></div>').join('')
    historyRailLayout={height:sh,width:box.clientWidth,offsets}
  }
  let active=-1;historyRailLayout.offsets.forEach((offset,i)=>{if(offset<=box.scrollTop+60)active=i})
  for(let i=0;i<nodesBox.children.length;i++)nodesBox.children[i].classList.toggle('active',i===active)
}

function bindRail() {
  const box = $('history')
  const thumb = $('rail-thumb')
  const nodesBox = $('rail-nodes')
  if (!box || !thumb || !nodesBox) return
  nodesBox.addEventListener('click', (e) => {
    const node = e.target.closest('.rail-node')
    if (!node) return
    getConversationView().intentUntil=Date.now()+1500
    getConversationView().reading=true
    box.scrollTo({ top: Math.max(0, Number(node.dataset.offset) - 10), behavior: 'smooth' })
  })
  let drag = null
  thumb.addEventListener('pointerdown', (e) => {
    drag = { y: e.clientY, top: box.scrollTop }
    try { thumb.setPointerCapture(e.pointerId) } catch {}
  })
  thumb.addEventListener('pointermove', (e) => {
    if (!drag) return
    getConversationView().intentUntil=Date.now()+1500
    getConversationView().reading=true
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
  'turn/start', 'turn/end',
  'user/message', 'assistant/message', 'assistant/attempt',
  'tool/call', 'tool/result',
  'agent/status',
  'checkpoint/created', 'compaction/complete', 'compaction/summary',
  'goal/created', 'goal/updated', 'goal/completed', 'goal/cleared',
  'todo/updated', 'plan/updated',
  'question/asked', 'question/resolved',
  'approval/asked', 'approval/resolved'
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
  if (entry.view?.failureGroup) return window.DshActivity.failureGroupHtml(entry.view.failureGroup, item => eventHtml(item, ctx))
  const seq = entry.seq
  const ev = entry.event || {}
  const data = ev.data || {}
  const type = ev.type || 'event'
  const failure = window.DshActivity?.failureHtml?.(window.DshActivity.failure(ev)) || ''
  if (entry.view?.turnResult) return failure + window.DshTurnResults.html(entry.view.turnResult)
  // Successful boundaries stay quiet; failed turns keep their durable explanation.
  if (type === 'turn/start' || type === 'turn/end') return failure
  if (type === 'assistant/attempt') return window.DshActivity?.attemptHtml?.(ev) || ''
  if (entry.view?.activityGroup) return activityGroupHtml(entry.view.activityGroup, ctx)
  if (!shouldShowEvent(type, ev)) return ''
  if (window.DshActivity && isToolEvent(type)) return window.DshActivity.toolEvent(entry)
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
      const body = blocks.map((block,index)=>blockHtml(block,index,{...data,seq,suppressBlockTools:state.history.suppressBlockTools})).join('')
      // Inline tool blocks duplicate the separated tool events; when those events exist the
      // calls live in the activity group, so an assistant message with nothing else disappears.
      if (!body) return ''
      inner = `<div class="msg ${esc(role)}" data-seq="${seq}"><div class="role">${esc(role === 'user' ? t('role.me') : t('role.dsh'))}</div>${body}</div>`
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
  } else if (type === 'approval/asked') {
    const record = state.approvalRecords?.get(data.id)
    inner = record && window.DshApprovalRecords?.lineHtml(record, t)
      || `<div class="approval-event">🔐 ${esc(data.toolName || t('tool.default'))}</div>`
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

function blockHtml(b,index=0,context={}) {
  if (!b || typeof b !== 'object') return `<p>${esc(String(b))}</p>`
  if ((b.type === 'tool-call' || b.type === 'tool-result') && (context.suppressBlockTools || LS.get('showTools', '1') === '0')) return ''
  if (typeof window !== 'undefined' && window.DshActivity) {
    const key='block:'+context.seq+':'+index
    if (b.type==='thinking'||b.type==='reasoning') return window.DshActivity.reasoning({text:b.text??b.content??'',key:window.DshActivity.reasoningKey(context,index,key)})
    if (b.type==='tool-call'||b.type==='tool-result') return window.DshActivity.tool({key,name:b.name||b.toolName,...(b.type==='tool-call'?{args:b.arguments??b.args??b.input}:{result:b.result??b.output??b.content??b,error:!!(b.error||b.ok===false||b.isError)})})
  }
  switch (b.type) {
    case 'text': return window.DshActivity.hasVisibleText(b.text) ? `<div class="md">${window.mdToHtml ? window.mdToHtml(b.text ?? '', { fileLinks: true, imageLabel: t('block.image') }) : esc(b.text ?? '')}</div>` : ''
    case 'file': if (typeof window !== 'undefined' && window.DshChatFiles) return window.DshChatFiles.render(b); return `<div class="tool">📎 ${esc(b.attachment?.name || b.name || 'file')} <small>${esc(b.attachment?.bytes ?? b.bytes ?? '')} bytes</small></div>`
    case 'image': {
      if (b.attachment && window.DshImagePreview) return window.DshImagePreview.attachmentHtml(b.attachment, t('block.image'), state.current)
    const alt = b.name || b.filename || t('block.image')
      return `<button type="button" class="chat-image" data-chat-image aria-label="${esc(t('block.image'))}"><img alt="${esc(alt)}" src="data:${esc(b.mediaType || 'image/png')};base64,${esc(b.data || '')}" draggable="false"></button>`
    }
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

let sessionSubagentsJob = null
function rememberSubagent(entry, parentId) {
  const childId = entry.id
  const child = state.byId.get(childId) || { sessionId: childId, cwd: state.byId.get(parentId)?.cwd || '' }
  Object.assign(child, { parentSessionId: parentId, origin: 'subagent', subagentMode: entry.mode || child.subagentMode || 'unknown' })
  if (entry.label && !child.projections?.values?.title) {
    child.projections ||= { values: {} }
    child.projections.values ||= {}
    child.projections.values.title = entry.label
  }
  state.byId.set(childId, child)
  state.subagentSessions ||= {}
  state.subagentSessions[childId] = child
}
async function openSubagentSession(childId, parentId, entry = {}, rootId = parentId) {
  if (!childId || childId === parentId || state.current !== rootId) return
  rememberSubagent({ ...entry, id: childId }, parentId)
  await openSession(childId)
}
async function loadSessionSubagents(sessionId) {
  if (sessionSubagentsJob?.sessionId === sessionId && sessionSubagentsJob.connection.valid()) return sessionSubagentsJob.promise
  const connection = captureConnection(), job = { sessionId, connection }
  job.promise = (async () => {
    const value = await rpc('subagent.list', { parentSessionId: sessionId })
    return connection.valid() ? value : null
  })()
  sessionSubagentsJob = job
  try { return await job.promise } finally { if (sessionSubagentsJob === job) sessionSubagentsJob = null }
}
let sessionCardsRenderGeneration = 0
async function renderSessionCards() {
  const connection = captureConnection()
  window.DshInsights?.update()
  void refreshInsightEntry()
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
    const collapsed = isGoalCollapsed(sessionId, goal)
    html += `<div data-deck-kind="goal" class="goal-disclosure${collapsed ? ' is-collapsed' : ''}">
      <div id="goal-panel-mobile" class="card goal-card${collapsed ? ' hidden' : ''}">
        <div class="goal-card-head"><div class="card-title">${esc(window.DshSessionDeck?.goalState(goal.phase) || goal.phase || t('goal.title'))}</div>
          <button type="button" class="goal-collapse-btn" data-goal-collapse="1" aria-expanded="true" aria-controls="goal-panel-mobile" title="${esc(t('goal.collapse'))}"><span aria-hidden="true">›</span>${t('goal.collapseShort')}</button>
        </div>
        <div class="goal-obj">${esc(goal.objective || '')}</div>
        <div class="goal-actions">
          ${goal.phase === 'active' ? '<button class="mini-btn" data-goal="pause">' + t('goal.pause') + '</button>' : '<button class="mini-btn" data-goal="resume">' + t('goal.resume') + '</button>'}
          <button class="mini-btn" data-goal="complete">${t('goal.complete')}</button>
          <details class="deck-more" data-deck-details="goal-${esc(goal.id || '')}"><summary>${I18N.lang === 'en' ? 'More' : '更多'}</summary><div class="deck-full-content">${esc(goal.objective || '')}<p>revision ${esc(goal.revision ?? '?')}</p></div><div class="goal-actions"><button class="mini-btn" data-goal="edit">${t('goal.edit')}</button><button class="mini-btn" data-goal="clear">${t('goal.clear')}</button></div></details>
        </div>
      </div>
      <button type="button" class="goal-side-tab${collapsed ? '' : ' hidden'}" data-goal-collapse="0" aria-expanded="false" aria-controls="goal-panel-mobile" aria-label="${esc(t('goal.expand'))}" title="${esc(t('goal.expand'))}"><span aria-hidden="true">‹</span><span>${t('goal.title')}</span><small>${t('goal.collapsedHint')}</small></button>
    </div>`
  }
  if (todos?.items?.length) {
    html += `<div data-deck-kind="todos" class="card">${window.DshSessionDeck?.taskHtml(todos.items) || `<div class="card-title">${t('todos.title')}</div>${todos.items.map(t =>
      `<div><span class="pill ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : ''}">${esc(t.status || 'pending')}</span>${esc(t.content || '')}</div>`
    ).join('')}`}</div>`
  }
  box.innerHTML = html
  box.querySelectorAll('[data-goal]').forEach(btn =>
    btn.addEventListener('click', () => goalAction(btn.dataset.goal)))
  box.querySelectorAll('[data-goal-collapse]').forEach(btn =>
    btn.addEventListener('click', () => {
      const collapse = btn.dataset.goalCollapse === '1'
      const currentGoal = goalOf(state.byId.get(state.current))
      if (!currentGoal) return
      setGoalCollapsed(state.current, currentGoal, collapse)
      void renderSessionCards()
      requestAnimationFrame(() => box.querySelector(`[data-goal-collapse="${collapse ? '0' : '1'}"]`)?.focus())
    }))

  // 子代理
  if (!connection.valid() || renderGeneration !== sessionCardsRenderGeneration || state.current !== sessionId) return
  window.DshSubagents?.configure($('btn-subagents'), {
    sessionId, title: titleOf(s), activity: s.running === true ? 'running' : s.running === false ? 'inactive' : 'unknown', parentId: s.origin === 'subagent' ? s.parentSessionId : null,
    valid: () => connection.valid() && state.current === sessionId,
    read: loadSessionSubagents, remember: rememberSubagent,
    onShow: () => conversationView?.pause(), onClose: () => conversationView?.resume(),
    open: (entry, parentId) => openSubagentSession(entry.id, parentId, entry, sessionId),
    interrupt: interruptSubagent,
  })
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
  const connection = captureConnection(), sessionId = state.current, history = state.history
  const valid = () => connection.valid() && state.current === sessionId && state.history === history
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
  const result = await safeRpc(method, { sessionId, ref }, t('goal.actionFailed'))
  if (result == null || !valid()) return
  if (kind === 'complete') setGoalPhaseLocal('complete')
  if (kind === 'clear') setGoalPhaseLocal('cleared')
  toast(t('goal.actionSubmitted'), 'ok')
  scheduleRefresh()
}

async function interruptSubagent(childId, parentId = state.current) {
  const connection = captureConnection(), rootId = state.current
  if (!confirm(t('subagent.confirmInterrupt'))) return
  const result = await safeRpc('subagent.interrupt', { parentSessionId: parentId, childSessionId: childId, mode: 'continuable' }, t('subagent.interruptFailed'))
  if (result == null || !connection.valid() || state.current !== rootId) return
  toast(t('subagent.interruptSubmitted'), 'ok')
  setTimeout(renderSessionCards, 600)
}

/* ---------------- 发送 / 取消 / 快捷菜单 ---------------- */
const NO_FALLBACK_SLASH_COMMANDS = new Set(['compact', 'export'])
const SLASH_COMMAND_TIMEOUT_MS = 20_000
// 比插件端的 120 秒多留 5 秒，让服务端能返回确定的失败结果而非客户端先中断。
const LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS = 125_000

function slashCommandName(text) {
  const match = /^\/+([^\s/]+)/.exec(String(text || '').trim())
  return match ? match[1].toLowerCase() : ''
}

function sessionLogFilename(sessionId) {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

function sessionLogExportUrl(sessionId, includeToken = false) {
  const url = new URL(apiUrl('/api/session.export'), location.href)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('includeDescendants', 'true')
  // 网关下载由浏览器/DownloadManager 发起，无法附加 Bearer 头时才使用短期既有 token
  // 查询参数兼容通道；同源 DSH 插件页仍只使用它自己的登录 Cookie。
  if (includeToken && state.token) url.searchParams.set('token', state.token)
  return url
}

async function downloadSessionExport(sessionId) {
  const connection = captureConnection()
  const nativePlatform = !!CAP?.isNativePlatform?.()
  const nativeDownload = !!(nativePlatform && window.NativeFile?.downloadToDownloads)
  if (nativePlatform && !nativeDownload) {
    toast(t('fs.downloadUnsupported'), 'err')
    return
  }
  const pluginOrigin = location.pathname === '/remote' || location.pathname.startsWith('/remote/')
  const url = sessionLogExportUrl(sessionId, !nativeDownload && (!!state.server || !pluginOrigin))
  const headers = state.token ? { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() } : {}
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS)
      : undefined
    const preflight = await fetch(url, { method: 'HEAD', headers, ...(signal ? { signal } : {}) })
    if (!connection.valid()) return
    if (preflight.status === 401) { authFailure(); return }
    if (!preflight.ok) throw new Error('HTTP ' + preflight.status)
    const filename = sessionLogFilename(sessionId)
    if (nativeDownload) {
      window.NativeFile.downloadToDownloads(url.href, filename, state.token)
      toast(t('fs.downloadStarted'), 'ok')
      return
    }
    // 浏览器下载目的地由浏览器自身的下载设置决定；同源插件页无需暴露网关 token。
    const anchor = document.createElement('a')
    anchor.href = url.href
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    toast(t('session.exportStarted'), 'ok')
  } catch (e) {
    console.error('session export download failed', e)
    toast(t('session.exportFailed', { msg: e?.message || '' }), 'err')
  }
}

async function runSlashCommand(text, requireExecuted = false) {
  const clean = String(text || '').trim()
  if (!clean.startsWith('/') || !state.current) return false
  const sessionId = state.current, connection = captureConnection()
  const command = slashCommandName(clean)
  const noFallback = command === 'permission' || NO_FALLBACK_SLASH_COMMANDS.has(command)
  try {
    const res = await fetch(apiUrl('/remote/api/command'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() },
      body: JSON.stringify({ sessionId, line: clean, async: true }),
      signal: AbortSignal.timeout(command === 'export' ? LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS : SLASH_COMMAND_TIMEOUT_MS),
    })
    if (!connection.valid() || (state.current !== sessionId && command !== 'compact' && command !== 'export')) return !requireExecuted
    if ([404, 405].includes(res.status) && !noFallback) return false
    if (res.status === 401) { authFailure(); return !requireExecuted }
    if (!res.ok) throw new Error('command response unavailable')
    const data = await res.json()
    if (!connection.valid() || (state.current !== sessionId && command !== 'compact' && command !== 'export')) return !requireExecuted
    if (!data?.ok) throw new Error('command rejected')
    if (data.executed === false) {
      if (!noFallback) return false
      throw new Error('control command not executed')
    }
    if (data.executed !== true) throw new Error('unknown command result')
    if (data.accepted) {
      if (command === 'compact' || command === 'export') {
        setCompactionStatus(sessionId, { ...(data.operation || data.compact), active: true, command, source: 'command' })
      } else {
        state.pendingCommands ||= {}
        state.pendingCommands[sessionId] = command
        const result = await waitCommandOperation(sessionId, data.operation, connection)
        if (!connection.valid() || state.current !== sessionId) return !requireExecuted
        delete state.pendingCommands[sessionId]
        if (result.executed === false && !noFallback) return false
        if (result.phase !== 'complete' || result.executed === false) throw new Error('command did not complete')
      }
    } else if (command === 'export') await downloadSessionExport(sessionId)
    else if (!requireExecuted) toast(t('send.commandExecuted'), 'ok')
    return true
  } catch (error) {
    if (!connection.valid() || state.current !== sessionId) return !requireExecuted
    if (!requireExecuted) toast(t('session.commandTimedOut'), 'err')
    // A lost response may follow execution. Only explicit not-executed responses can fall back.
    return !requireExecuted
  }
}

async function waitCommandOperation(sessionId, initial, connection) {
  if (!initial || !initial.startedAt) throw new Error('missing operation identity')
  const deadline = Date.now() + SLASH_COMMAND_TIMEOUT_MS
  let operation = initial
  while (Date.now() < deadline) {
    if (!connection.valid() || state.current !== sessionId) throw new Error('stale command')
    if (!operation.active) {
      if (!['complete', 'failed'].includes(operation.phase)) throw new Error('unknown operation')
      return operation
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!connection.valid() || state.current !== sessionId) throw new Error('stale command')
    const url = apiUrl('/remote/api/command-status') + '?sessionId=' + encodeURIComponent(sessionId)
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + state.token, ...clientIdHeaders() }, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
    if (!res.ok) throw new Error('command status unavailable')
    const body = await res.json()
    operation = body?.operation
    if (body?.ok !== true || !operation || (initial.id ? operation.id !== initial.id : operation.startedAt !== initial.startedAt)) throw new Error('operation changed')
  }
  throw new Error('command result unconfirmed')
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

let composerSending = false
const composerSendFeedback = new Map()
const steeringInFlight = new Set()
function composerContext() { return `${state.server}\0${state.current}` }
function steerSendingEnabled() { return LS.get('steerSendingEnabled', '0') === '1' }
function composerIsBusy() {
  return !!state.byId.get(state.current)?.running || (state.queues[state.current] || []).some(item => item.placement === 'queued')
}
function composerSendMode(alternate = false) {
  if (window.DshWorkflow?.isMounted()) return alternate && composerIsBusy() ? 'steer' : 'queue'
  if (!steerSendingEnabled() || !composerIsBusy()) return 'queue'
  const preferred = LS.get('busySendMode', 'queue') === 'steer' ? 'steer' : 'queue'
  return alternate ? (preferred === 'queue' ? 'steer' : 'queue') : preferred
}
function renderComposerSend() {
  window.DshWorkflow?.update()
  const enabled = steerSendingEnabled() && composerIsBusy()
  const mode = composerSendMode()
  for (const id of ['btn-send', 'btn-fs-send']) {
    const button = $(id)
    if (!button) continue
    if (composerSending || !button.classList.contains('send-hold-ready')) button.textContent = t(composerSending ? 'send.submitting' : enabled ? `send.${mode}Button` : 'composer.send')
    button.disabled = composerSending
    button.classList.toggle('steer-mode', enabled && mode === 'steer')
    button.title = t(enabled ? 'send.holdHint' : 'composer.send')
    button.setAttribute('aria-label', button.textContent)
  }
  const feedback = composerSendFeedback.get(composerContext())
  const node = $('composer-send-status')
  if (node) {
    node.textContent = feedback ? t(feedback.key, { msg: feedback.message || '' }) : enabled ? t('send.holdHint') : ''
    node.classList.toggle('hidden', !node.textContent)
    node.dataset.phase = feedback?.phase || 'hint'
  }
  window.DshWorkflow?.update()
}
function setComposerSendFeedback(context, key, phase, message = '') {
  composerSendFeedback.set(context, { key, phase, message })
  if (composerSendFeedback.size > 100) composerSendFeedback.delete(composerSendFeedback.keys().next().value)
  renderComposerSend()
}
// No preflight or automatic retry: an ambiguous timeout may already have delivered the message.
async function submitSteer(method, payload, context) {
  if (steeringInFlight.has(context)) {
    if (composerContext() === context) toast(t('send.steerPending'), 'err')
    return null
  }
  steeringInFlight.add(context)
  setComposerSendFeedback(context, 'send.steerPending', 'pending')
  const slow = setTimeout(() => setComposerSendFeedback(context, 'send.steerSlow', 'pending'), 3000)
  try {
    const result = await rpc(method, payload)
    if (!result?.accepted) {
      setComposerSendFeedback(context, 'send.steerUnconfirmed', 'unknown')
      return result
    }
    setComposerSendFeedback(context, 'send.steerAccepted', 'accepted')
    if (composerContext() === context) toast(t('send.steerAccepted'), 'ok')
    return result
  } catch (error) {
    setComposerSendFeedback(context, error.rpcRejected || error.message === 'AUTH' ? 'send.steerRejected' : 'send.steerUnconfirmed', error.rpcRejected ? 'error' : 'unknown', error.message)
    if (error.message === 'AUTH' && composerContext() === context) authFailure()
    return null
  } finally { clearTimeout(slow); steeringInFlight.delete(context) }
}

function bindComposerSend(button) {
  let press = null
  let suppressClickUntil = 0
  const cancel = () => {
    if (!press) return
    clearTimeout(press.timer)
    press = null
    suppressClickUntil = Date.now() + 1000
    button.classList.remove('send-hold-ready')
    renderComposerSend()
  }
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || composerSending || !steerSendingEnabled() || !composerIsBusy()) return
    cancel()
    suppressClickUntil = 0
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, context: composerContext(), mode: composerSendMode(), alternate: composerSendMode(true), ready: false }
    press.timer = setTimeout(() => {
      if (!press || composerSending || composerContext() !== press.context) { cancel(); return }
      press.ready = true
      button.classList.add('send-hold-ready')
      button.textContent = t(press.alternate === 'steer' ? 'send.releaseSteer' : 'send.releaseQueue')
    }, 450)
    button.setPointerCapture?.(event.pointerId)
  })
  button.addEventListener('pointermove', event => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) cancel()
  })
  button.addEventListener('pointerup', event => {
    if (!press || event.pointerId !== press.id) return
    const intent = press
    cancel()
    event.preventDefault()
    if (intent.context === composerContext() && steerSendingEnabled()) void sendMessage(intent.ready ? intent.alternate : intent.mode)
  })
  for (const name of ['pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(name, cancel)
  button.addEventListener('contextmenu', event => { if (press || Date.now() < suppressClickUntil) event.preventDefault() })
  button.addEventListener('keydown', () => { cancel(); suppressClickUntil = 0 })
  button.addEventListener('click', () => { if (Date.now() >= suppressClickUntil) void sendMessage() })
}

async function sendSessionContent(text, images, requestedMode = 'queue') {
  if (state.byId.get(state.current)?.origin === 'subagent') { toast('子代理记录为只读 / Subagent records are read only'); return false }
  const clean = String(text || '').trim()
  if ((!clean && !images.length) || !state.current || composerSending) return false
  const sessionId = state.current
  const context = composerContext()
  const onboardingContext = window.DshOnboarding ? { connection: connectionGeneration, session: sessionId } : null
  const mode = requestedMode === 'steer' && (window.DshWorkflow?.isMounted() || steerSendingEnabled()) && composerIsBusy() ? 'steer' : 'queue'
  if (mode === 'steer' && clean.startsWith('/')) {
    setComposerSendFeedback(context, 'send.steerSlash', 'error')
    return false
  }
  composerSending = true
  const buttons = [$('btn-send'), $('btn-fs-send')].filter(Boolean)
  buttons.forEach(button => { button.disabled = true })
  const pendingPrompts = state.pendingPrompts, sessionActivity = state.sessionActivity
  pendingPrompts.add(sessionId)
  try {
    if (mode === 'steer') setComposerSendFeedback(context, 'send.steerPending', 'pending')
    else { composerSendFeedback.delete(context); renderComposerSend() }
    if (images.length === 0 && clean && await runSlashCommand(clean)) {
      sessionActivity.add(sessionId)
      return true
    }
    const content = [...await encodeComposerImagesFor(images)]
    if (clean) content.push({ type: 'text', text: clean })
    if (composerContext() !== context) {
      setComposerSendFeedback(context, 'send.contextChanged', 'error')
      return false
    }
    setSessionRecovery('resuming')
    const payload = {
      sessionId,
      mode,
      content
    }
    const v = mode === 'steer'
      ? await submitSteer('session.prompt', payload, context)
      : await safeRpc('session.prompt', payload, t('send.failed'))
    if (composerContext() !== context) return !!v?.accepted
    if (v?.accepted) {
      state.sessionActivity.add(sessionId)
      // Optional teaching UI must never turn a confirmed send into a failure.
      if (!clean.startsWith('/')) { try { window.DshOnboarding?.record('message-accepted', onboardingContext) } catch {} }
      if (composerContext() === context) {
        setSessionRecovery('ready')
        noteSessionTurnTime(sessionId, Date.now())
        renderSessions()
        if (mode !== 'steer') toast(images.length ? t('send.imageSent') : (clean.startsWith('/') ? t('send.commandSent') : t('send.sent')), 'ok')
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
    if (mode === 'steer') setComposerSendFeedback(context, 'send.steerRejected', 'error', e?.message || String(e))
    if (composerContext() === context) {
      setSessionRecovery('error', e?.message)
      toast(t('composer.imageReadFailed', { msg: e?.message || e }), 'err')
    }
    return false
  } finally {
    pendingPrompts.delete(sessionId)
    composerSending = false
    buttons.forEach(button => { button.disabled = false })
    renderComposerSend()
  }
}

async function encodeComposerImagesFor(images) {
  return Promise.all(images.map(async item => ({
    type: 'image', mediaType: item.file.type, data: bytesToBase64(new Uint8Array(await item.file.arrayBuffer())),
    ...(item.file.name ? { name: item.file.name } : {})
  })))
}

async function sendMessage(requestedMode) {
  const input = $('composer-input')
  const originalText = input.value
  const text = originalText.trim()
  const context = composerContext()
  const images = state.composerImages.slice()
  if ((!text && !images.length) || !state.current) return
  if (images.length && text.startsWith('/')) { toast(t('composer.imageSlashUnsupported'), 'err'); return }
  const mode = typeof requestedMode === 'string' ? requestedMode : composerSendMode()
  if (await sendSessionContent(text, images, mode) && composerContext() === context) {
    if (input.value === originalText) { input.value = ''; autosize(input) }
    if (state.composerImages.length === images.length && images.every((item, i) => item === state.composerImages[i])) clearComposerImages()
  }
}

function hideComposerMenu() {
  $('composer-menu').classList.add('hidden')
  $('btn-plus').classList.remove('active')
}

// 主机拥有权限模式（沙箱+审批捆绑）与可选目录；Remote 只按主机返回渲染，
// 不为未安装或不存在的预设造选项。旧主机没有该目录时回退三种沙箱模式。
// 目录直接作为“指令”列表中的权限模式行显示，Auto review 可用时同样出现在这里。
function currentPermissionPreset() {
  const perms = state.current ? proj(state.byId.get(state.current), 'permissions') : null
  return typeof perms?.currentValue === 'string' ? perms.currentValue : ''
}

let permissionPresetRequest = 0
function refreshPermissionPresets() {
  const submenu = $('permission-submenu')
  if (!submenu || !window.DshPermissionPresets) return
  const request = ++permissionPresetRequest
  const sessionId = state.current
  const permissionConnection = captureConnection()
  void window.DshPermissionPresets.open({
    container: submenu,
    current: currentPermissionPreset(),
    connection: permissionConnection,
    currentValid: () => permissionConnection.valid() && state.current === sessionId && request === permissionPresetRequest,
    rpc,
    t,
    toast,
    request: async (value) => {
      if (!permissionConnection.valid() || !sessionId || state.current !== sessionId || request !== permissionPresetRequest) return false
      return runSlashCommand('/permission ' + value, true)
    },
    close: hideComposerMenu,
  })
}

function toggleComposerMenu() {
  const menu = $('composer-menu')
  const show = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !show)
  $('btn-plus').classList.toggle('active', show)
  if (show) refreshPermissionPresets()
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
  const connection = captureConnection(), sessionId = state.current, models = state.models
  const request = models.request = (models.request || 0) + 1
  const valid = () => connection.valid() && state.current === sessionId && state.models === models && models.request === request
  models.loading = true
  renderModelMenu()
  try {
    const v = await rpc('session.models', { sessionId })
    if (!valid()) return
    models.groups = v.groups || []
    models.current = v.current || null
    models.failures = v.failures || []
    models.loaded = true
  } catch (e) {
    if (!valid()) return
    if (e.message === 'AUTH') { models.loading = false; renderModelMenu(); authFailure(); return }
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
  const connection = captureConnection(), sessionId = state.current, models = state.models
  const request = models.request = (models.request || 0) + 1
  const v = await safeRpc('session.selectModel', {
    sessionId, provider: cur.provider, model: cur.model, reasoningEffort: effortId
  }, t('models.effortFailed'))
  if (!connection.valid() || state.current !== sessionId || state.models !== models || models.request !== request) return
  if (v?.selected) {
    state.models.current = v.selected
    renderEffortMenu()
    toast(t('models.effortSwitched', { effort: effortId }), 'ok')
  }
}

async function selectSessionModel(provider, modelId) {
  if (!state.current) return
  const connection = captureConnection(), sessionId = state.current, models = state.models
  const request = models.request = (models.request || 0) + 1
  const group = (state.models.groups || []).find(g => g.id === provider)
  const model = (group?.models || []).find(m => m.id === modelId)
  const payload = { sessionId, provider, model: modelId }
  const effort = model?.reasoning?.defaultEffort || model?.reasoning?.efforts?.[0]?.id
  if (effort) payload.reasoningEffort = effort
  const v = await safeRpc('session.selectModel', payload, t('models.switchFailed'))
  if (!connection.valid() || state.current !== sessionId || state.models !== models || models.request !== request) return
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
  $('rename-session-input').value = sessionTitleValue(session)
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

function loadSessionPresets(prefix) {
  return window.DshSessionPresets.open({select:$(prefix+'-agent-preset'),hint:$(prefix+'-agent-preset-hint'),rpc,connection:captureConnection(),rendered:()=>syncCustomSelect($(prefix+'-agent-preset'))})
}
async function newSession(preferredWorkspace = '') {
  if (!state.token) { showView('view-settings'); return }
  if (!workspaceItems().length) await refreshWorkbench()
  const preferred = typeof preferredWorkspace === 'string' && preferredWorkspace || workspaceById(state.workspaceFilter)?.workspaceId || LS.get('lastNewSessionWorkspaceV1', '')
  renderNewSessionWorkspace(preferred)
  void loadSessionPresets('new-session')
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
  if (createSessionInWorkspace.busy) return
  const connection = captureConnection()
  const workspaceId = $('new-session-workspace').value
  if (!workspaceById(workspaceId)) return toast(t('newSession.chooseWorkspace'), 'err')
  const preset = window.DshSessionPresets.selection($('new-session-agent-preset'))
  if (!preset.valid) return toast(window.DshSessionPresets.staleMessage(), 'err')
  const button = $('new-session-create')
  createSessionInWorkspace.busy = true
  button.disabled = true
  try {
    const v = await safeRpc('session.create', { workspaceId: workspaceId, ...preset.payload }, t('home.createFailed'))
    if (!connection.valid() || !v?.sessionId) return
    state.workspaceFilter = workspaceId
    state.fs.workspaceId = workspaceId
    LS.set('workspaceFilterV1', workspaceId)
    LS.set('fsWorkspaceIdV1', workspaceId)
    LS.set('lastNewSessionWorkspaceV1', workspaceId)
    closeNewSessionModal()
    toast(t('home.created'), 'ok')
    const workspace = workspaceById(workspaceId)
    const session = { sessionId: v.sessionId, cwd: workspace?.path || '', running: false, projections: { values: {} } }
    state.byId.set(session.sessionId, session)
    state.sessions.unshift(session)
    void openSession(session.sessionId)
    void refreshSessions()
  } finally { createSessionInWorkspace.busy = false; button.disabled = false }
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
let overviewDetector = null
let overviewPulse = null
function setOverviewText(id,value){const node=$(id);if(overviewPulse)overviewPulse.text(node,value);else if(node)node.textContent=value}
let overviewStarting = true
function overviewChecks() {
  const confirmed=overviewDetector?.model.gateway===true,health=activeGatewayHealth()
  return {
    gateway: !!state.token && (!!state.server || /^https?:$/.test(location.protocol)) && confirmed,
    dsh: dshReachable() && confirmed,
    mux: !!state.streamsOk?.mux && confirmed && health?.events?.mux?.connected!==false,
    host: !!state.streamsOk?.host && confirmed && health?.events?.host?.connected!==false
  }
}
function repairMissingStreams() {
  if(!state.token||!navigator.onLine||state.selectingServer||overviewStarting)return
  if(state.streamMode==='poll'){tryRestoreWs();return}
  for(const [kind,handler,refresh] of [['mux',onMuxFrame,true],['host',onHostFrame,false]]) {
    const ws=streams[kind]
    if((!ws||ws.readyState===WebSocket.CLOSED)&&!streamMeta[kind].retryTimer)openStream(kind,handler,refresh)
  }
}
async function probeOverviewLinks(signal) {
  const connection=captureConnection(),base=String(connection.server||location.origin).replace(/\/+$/,'')
  let timer
  const controller=new AbortController(),cancel=()=>controller.abort()
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)controller.abort()
  timer=setTimeout(cancel,6500)
  const healthRequest=fetch(base+'/health?probe=fresh&t='+Date.now(),{signal:controller.signal,cache:'no-store'}).then(async response=>{
    if(!response.ok)throw Error('health')
    const health=await response.json();if(health?.ok!==true)throw Error('health')
    return health
  }).catch(()=>null).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel)})
  const [health,host]=await Promise.all([healthRequest,refreshHostDescription()])
  if(!connection.valid()||signal.aborted)throw Error('stale check')
  if(health){state.gatewayHealth[base]=health}
  else delete state.gatewayHealth[base]
  return {gateway:!!health}
}
function startOverviewDetection(force=false,identityChanged=false) {
  if(identityChanged)overviewDetector?.pause()
  if(!window.DshLinkCheck)return
  if(!overviewDetector)overviewDetector=new window.DshLinkCheck.LinkCheck({
    active:()=>document.visibilityState==='visible'&&!$('view-activity').classList.contains('hidden'),
    configured:()=>!!state.token&&(!!state.server||/^https?:$/.test(location.protocol)),online:()=>navigator.onLine,
    snapshot:overviewChecks,repair:repairMissingStreams,probe:probeOverviewLinks,changed:renderOverview
  })
  overviewDetector.start(force)
}
window.addEventListener('online',()=>startOverviewDetection(true))
window.addEventListener('offline',()=>startOverviewDetection(true))
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')startOverviewDetection(true);else {overviewDetector?.pause();overviewPulse?.pause()}})

function renderOverview() {
  window.DshWorkflow?.update()
  const ring = $('overview-pulse-ring')
  if (!ring) return
  const checks = overviewChecks()
  const detection=overviewDetector?.model,checking=detection?.phase==='checking'||(detection?.phase==='degraded'&&detection?.probing===true)
  const online = Object.values(checks).filter(Boolean).length
  $('overview-refresh').disabled=detection?.probing===true
  const status = online === 4 ? 'nominal' : online > 0 ? 'degraded' : 'offline'
  const pulseCard = document.querySelector('.overview-pulse-card')
  if (pulseCard) {
    if(!overviewPulse&&window.DshLinkCheck?.PulseVisual)overviewPulse=new window.DshLinkCheck.PulseVisual({card:pulseCard,active:()=>document.visibilityState==='visible'&&!$('view-activity').classList.contains('hidden')})
    overviewPulse?.setChecking(checking)
    overviewPulse?.setLinks(checks)
    pulseCard.classList.remove('status-nominal', 'status-degraded', 'status-offline')
    pulseCard.classList.toggle('status-checking',checking)
    pulseCard.setAttribute('aria-busy',String(checking))
    pulseCard.classList.add('status-' + status)
  }
  setOverviewText('overview-health',checking ? t('overview.checking') : online === 4 ? t('overview.live') : online ? `${online}/4` : t('overview.offlineCore'))
  setOverviewText('overview-health-caption',checking ? `${online}/4` : online === 4 ? t('overview.allLinked') : online ? t('overview.confirmedShort') : t('overview.offlineShort'))
  setOverviewText('overview-status',checking ? t('overview.checking') : t(`overview.${status}`))
  setOverviewText('overview-status-desc',checking ? t('overview.autoChecking',{n:online}) : detection?.phase==='degraded' ? t('overview.autoRetry',{n:online}) : t('overview.components',{n:online}))
  for (const [name, ok] of Object.entries(checks)) {
    const item = document.querySelector(`[data-overview-link="${name}"]`)
    if (!item) continue
    item.classList.toggle('ok', ok)
    item.classList.toggle('off', !ok&&!checking)
    item.classList.toggle('pending',!ok&&checking)
    const value = item.querySelector('b')
    if (value) setOverviewText(value.id || (value.id=`overview-link-${name}`), ok ? t('overview.online') : checking ? t('overview.checkingShort') : t('overview.offlineShort'))
  }

  const pending = [
    ...state.approvals.map(a => ({ kind: 'approval', item: a })),
    ...state.questions.map(q => ({ kind: 'question', item: q }))
  ]
  $('overview-attention-count').textContent = pending.length ? t('overview.pendingCount', { n: pending.length }) : '—'
  $('overview-attention-list').innerHTML = pending.length ? pending.map(({ kind, item }) => {
    const title = sessionLabelOf(state.byId.get(item.sessionId))
    if (kind === 'approval') return `<div class="overview-attention-item" data-overview-approval="${esc(item.approvalId)}">
      <span class="overview-item-mark">⌁</span><span class="overview-item-copy"><span class="overview-item-title">${esc(item.toolName || t('tool.default'))}</span><span class="overview-item-desc">${esc(approvalDetail(item))} · ${esc(title)}</span></span>
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
  renderApprovalRecords()

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
    <span class="overview-item-mark">${s.running ? '●' : '○'}</span><span class="overview-item-copy"><span class="overview-item-title">${esc(sessionLabelOf(s))}</span><span class="overview-item-desc">${s.running ? esc(t('sessions.running')) + ' · ' : ''}${esc(fmtTime(sessionSortTime(s)))}</span></span><span class="overview-item-arrow">›</span>
  </button>`).join('') : `<div class="overview-empty">${t('overview.noSession')}</div>`
  $('overview-session-list').querySelectorAll('[data-overview-session]').forEach(btn => btn.addEventListener('click', () => openSession(btn.dataset.overviewSession)))
}

/* ---------------- 审批记录 ---------------- */
// 审批内容与结果来自会话审计事件（approval/asked + approval/decided）与实时审批帧；
// 只记录主机已写日志的最小字段，不计模型 token，也不改写主机数据。
const APPROVAL_RECORDS_KEY = 'dshApprovalRecordsV1:'
function approvalRecordsKey() { return APPROVAL_RECORDS_KEY + encodeURIComponent(String(state.server || '')) }
function ensureApprovalRecords() {
  if (state.approvalRecordsServer === state.server) return
  flushApprovalRecords()
  state.approvalRecordsServer = state.server
  state.approvalRecords = window.DshApprovalRecords ? window.DshApprovalRecords.restore(LS.get(approvalRecordsKey(), '[]')) : new Map()
}
let approvalRecordsSaveTimer = null
let approvalRecordsPendingSave = null
function flushApprovalRecords() {
  clearTimeout(approvalRecordsSaveTimer); approvalRecordsSaveTimer = null
  const pending = approvalRecordsPendingSave; approvalRecordsPendingSave = null
  if (pending) { try { LS.set(pending.key, pending.value) } catch {} }
}
function resetApprovalRecords() {
  clearTimeout(approvalRecordsSaveTimer); approvalRecordsSaveTimer = null; approvalRecordsPendingSave = null
  state.approvalRecords = new Map(); state.approvalRecordsServer = state.server
}
function saveApprovalRecords() {
  if (!window.DshApprovalRecords) return
  clearTimeout(approvalRecordsSaveTimer)
  approvalRecordsPendingSave = { key: approvalRecordsKey(), value: window.DshApprovalRecords.serialize(state.approvalRecords) }
  approvalRecordsSaveTimer = setTimeout(flushApprovalRecords, 800)
}
function collectApprovalEvent(sessionId, event) {
  ensureApprovalRecords()
  if (!window.DshApprovalRecords?.fromEvent(state.approvalRecords, sessionId, event)) return false
  saveApprovalRecords()
  return true
}
function collectApprovalFrame(frame) {
  ensureApprovalRecords()
  if (!window.DshApprovalRecords?.fromFrame(state.approvalRecords, frame)) return false
  saveApprovalRecords()
  renderApprovalRecords()
  return true
}
function renderApprovalRecords() {
  const box = $('approval-records-list')
  if (!box) return
  ensureApprovalRecords()
  const api = window.DshApprovalRecords
  const rows = api ? api.list(state.approvalRecords, 8) : []
  const count = $('approval-records-count')
  if (count) count.textContent = rows.length ? t('pending.count', { n: rows.length }) : '—'
  box.innerHTML = rows.length
    ? rows.map(record => api.recordHtml(record, t, { session: titleOf(state.byId.get(record.sessionId)) })).join('')
    : '<div class="empty">' + t('approval.recordsEmpty') + '</div>'
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
        <div class="pc-desc">${esc(approvalDetail(a))}</div>
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
  renderSessionPending()
  updatePendingBadge()
  renderOverview()
}

function approvalDetail(a) {
  const lines = []
  if (a?.reason) lines.push(window.DshApprovalRecords?.displayReason(a.reason) || String(a.reason))
  if (a?.arguments !== undefined) lines.push(safeJson(a.arguments))
  if (a?.callId) lines.push(`callId: ${a.callId}`)
  return lines.join('\n') || t('pending.noReason')
}

function renderSessionPending() {
  window.DshFileInbox?.render()
  const box = $('session-pending')
  if (!box) return
  const sessionId = state.current
  const items = [
    ...state.approvals.filter(a => a.sessionId === sessionId).map(a => ({ kind: 'approval', item: a })),
    ...state.questions.filter(q => q.sessionId === sessionId).map(q => ({ kind: 'question', item: q }))
  ]
  box.classList.toggle('hidden', !sessionId || !items.length)
  if (!sessionId || !items.length) { box.innerHTML = ''; return }
  box.innerHTML = `<div class="session-pending-head"><span>${esc(t('overview.attention'))}</span><span>${esc(t('pending.count', { n: items.length }))}</span></div><div class="session-pending-list">${items.map(({ kind, item }) => {
    if (kind === 'approval') return `<article class="pending-card approval" data-session-approval="${esc(item.approvalId)}">${window.DshSessionDeck?.approvalHtml(item, approvalDetail(item)) || `
      <div class="pc-title">${esc(item.toolName || t('tool.default'))}</div>
      <div class="pc-desc">${esc(approvalDetail(item))}</div>
      <div class="goal-actions"><button type="button" class="mini-btn" data-session-approve="1">${t('pending.allow')}</button><button type="button" class="mini-btn" data-session-approve="0">${t('pending.reject')}</button></div>
    `}</article>`
    return `<button type="button" class="pending-card question" data-session-question="${esc(item.rpcId)}" aria-haspopup="dialog">
      <span class="question-card-head"><span class="pc-title">❓ ${esc(item.questions?.[0]?.header || t('notify.questionTitle'))}</span><span class="mini-btn">${t('pending.answer')}</span></span>
      <span class="question-summary">${esc(questionSummary(item))}</span>
    </button>`
  }).join('')}</div>`
  box.querySelectorAll('[data-session-approve]').forEach(button => {
    button.addEventListener('click', () => approveApproval(button.closest('[data-session-approval]')?.dataset.sessionApproval || '', button.dataset.sessionApprove === '1'))
  })
  box.querySelectorAll('[data-session-question]').forEach(button => {
    button.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === button.dataset.sessionQuestion)))
  })
}

async function approveApproval(id, allow) {
  const connection = captureConnection()
  const a = state.approvals.find(x => x.approvalId === id)
  if (!a) return
  let ok
  try {
    ok = await respond(a.rpcId, { sessionId: a.sessionId, approvalId: a.approvalId, outcome: allow ? 'allowed-once' : 'rejected' })
  } catch (e) {
    if (!connection.valid()) return
    if (e.message === 'AUTH') authFailure()
    else toast(t('pending.submitFailed', { msg: e.message || t('fs.networkError') }), 'err')
    return
  }
  if (!connection.valid()) return
  toast(ok ? (allow ? t('pending.allowed') : t('pending.rejected')) : t('pending.stale'), ok ? 'ok' : 'err')
  if (ok) clearPendingNotification({ type: 'approval/resolved', approvalId: a.approvalId })
  state.approvals = state.approvals.filter(x => x.rpcId !== a.rpcId)
  renderPending()
}

function questionSummary(q) {
  return (q.questions || []).map(item => String(item.question || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>]/g, '')).join(' / ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function questionMarkup(item) {
  const text = String(item.question || '')
  return (item.header ? `<strong>${esc(item.header)}</strong>` : '') + (window.mdToHtml ? window.mdToHtml(text, { richContent: false, fileLinks: true }) : esc(text))
}

function fitQuestionViewport() {
  const viewport = window.visualViewport
  const modal = $('modal-question')
  if (!modal || !viewport) return
  modal.style.top = viewport.offsetTop + 'px'
  modal.style.height = viewport.height + 'px'
  modal.style.bottom = 'auto'
}

function openQuestionModal(q) {
  if (!q) return
  state.questionModal = q
  $('question-body').innerHTML = q.questions.map((item, i) => `
    <div class="q-item">
      <div class="q-text md">${questionMarkup(item)}</div>
      ${(item.options || []).map((o, j) => `
        <label class="q-option"><input type="${item.multiSelect ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o.label)}" data-q="${i}"><span>${esc(o.label)}${o.description ? `<div class="muted">${esc(o.description)}</div>` : ''}</span></label>`).join('')}
      <textarea rows="2" placeholder="${t('question.customPlaceholder')}" data-qcustom="${i}"></textarea>
    </div>`).join('')
  $('modal-question').classList.remove('hidden')
  $('question-body').scrollTop = 0
  fitQuestionViewport()
}

async function submitQuestion() {
  const connection = captureConnection()
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
    if (!connection.valid()) return
    if (e.message === 'AUTH') authFailure()
    else toast(t('question.submitFailed', { msg: e.message || t('fs.networkError') }), 'err')
    return
  }
  if (!connection.valid()) return
  if (ok) {
    clearPendingNotification({ type: 'question/resolved', questionRpcId: q.rpcId })
    toast(t('question.submitted'), 'ok')
    if (state.questionModal === q) { $('modal-question').classList.add('hidden'); state.questionModal = null }
    state.questions = state.questions.filter(x => x.rpcId !== q.rpcId)
    renderPending()
  }
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
  const context = composerContext()
  const key = `${sessionId}:${itemId}`
  const s = state.byId.get(sessionId)
  if (!sessionId || !s?.running || state.queueSteering[key]) return
  state.queueSteering[key] = true
  renderQueue()
  try {
    await submitSteer('session.updateQueue', { sessionId, itemId, action: { kind: 'steer' } }, context)
  } finally {
    delete state.queueSteering[key]
    renderQueue()
  }
}
function renderQueue() {
  renderComposerSend()
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
  $('history-hint').textContent = items.length ? t('history.queueAndCount', { q: items.length, n: state.history.visible.filter(entry=>!['turn/start','turn/end'].includes(entry.event?.type)).length }) : t('history.countOnly', { n: state.history.visible.filter(entry=>!['turn/start','turn/end'].includes(entry.event?.type)).length })
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
  const upload = state.fs.upload
  if (upload) {
    upload.cancelled = true
    upload.controller?.abort()
    try { upload.xhr?.abort() } catch {}
  }
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
  const connection = captureConnection()
  if (!state.token) { toast(t('fs.noTokenToast'), 'err'); showView('view-settings'); return }
  if (!state.fs.path) await loadFs(null, { silent: true })
  if (!connection.valid()) return
  $('workspace-parent-path').textContent = state.fs.path || '~'
  $('workspace-name').value = ''
  $('modal-workspace').classList.remove('hidden')
  void loadSessionPresets('workspace')
  setTimeout(() => $('workspace-name').focus(), 50)
}
function closeWorkspaceModal() { $('modal-workspace').classList.add('hidden') }
async function createWorkspace() {
  if (createWorkspace.busy) return
  const preset = window.DshSessionPresets.selection($('workspace-agent-preset'))
  if (!preset.valid) return toast(window.DshSessionPresets.staleMessage(), 'err')
  const name = $('workspace-name').value.trim()
  if (!name) { toast(t('workspace.nameRequired'), 'err'); $('workspace-name').focus(); return }
  const connection = captureConnection()
  createWorkspace.busy = true
  const parent = state.fs.path || ''
  const button = $('workspace-create')
  button.disabled = true
  try {
    const res = await fetch(fsApiUrl('/mkdir', { path: parent, name }), { method: 'POST', headers: fsHeaders() })
    if (res.status === 401) { fsAuthError(401); return }
    const data = await res.json().catch(() => ({}))
    if (!connection.valid()) return
    if (!res.ok) {
      const msg = data.error === 'exists' ? t('workspace.exists') : data.error === 'bad-name' ? t('workspace.invalidName') : data.error || ('HTTP ' + res.status)
      throw new Error(msg)
    }
    closeWorkspaceModal()
    await loadFs(parent || null, { silent: true })
    if (!connection.valid()) return
    let workspace = null
    try {
      const created = await rpc('workspace.create', { path: data.path })
      if (!connection.valid()) return
      workspace = created?.workspace || null
    } catch {}
    if (!connection.valid()) return
    const sessionPayload = workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : { cwd: data.path }
    const v = await safeRpc('session.create', { ...sessionPayload, ...preset.payload }, t('home.createFailed'))
    if (!connection.valid()) return
    if (workspace?.workspaceId) {
      state.workspaceFilter = workspace.workspaceId
      state.fs.workspaceId = workspace.workspaceId
      LS.set('workspaceFilterV1', workspace.workspaceId)
      LS.set('fsWorkspaceIdV1', workspace.workspaceId)
    }
    await refreshSessions()
    if (!connection.valid()) return
    if (v?.sessionId) {
      toast(t('workspace.created'), 'ok')
      openSession(v.sessionId)
    } else {
      toast(t('workspace.createdNoSession'), 'ok')
    }
  } catch (e) {
    if (!connection.valid()) return
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

/** 对话里 Markdown 图片的本地路径：相对路径按当前会话工作区解析，读取走 /fs/file。 */
async function chatImageAttachment(attachmentId, sessionId) {
  const connection = captureConnection()
  if (!sessionId || sessionId !== state.current || !connection.valid()) throw new Error('stale image')
  const result = await rpc('session.attachment', { sessionId, attachmentId })
  if (!connection.valid() || state.current !== sessionId) throw new Error('stale image')
  return result
}
function chatImageRequest(pathValue) {
  const value = String(pathValue || '').trim()
  if (!value) return null
  let target = value
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(value)) {
    const root = state.byId.get(state.current)?.cwd || ''
    if (root) target = root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' : '/') + value.replace(/^\.?[\\/]+/, '')
  }
  return { url: fsApiUrl('/file', { path: target }), headers: fsHeaders() }
}

function fsAuthError(status) {
  if (status === 401) authFailure()
}

async function loadFs(dir, { silent = false, resetRoot = false } = {}) {
  const connection = captureConnection(), request = ++filesRequest
  const valid = () => connection.valid() && request === filesRequest
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
    if (!valid()) return
    if (res.status === 401) { fsAuthError(401); return }
    const data = await res.json().catch(() => ({}))
    if (!valid()) return
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
    if (!valid()) return
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
    const htmlPreview = (data.extension === '.html' || data.extension === '.htm') && !!window.DshGenUi
    $('file-preview-tabs').classList.toggle('hidden', !markdown && !htmlPreview)
    if (markdown) $('file-preview-rendered').innerHTML = window.mdToHtml(data.content || '')
    if (htmlPreview) $('file-preview-rendered').innerHTML = window.DshGenUi.html(data.content || '')
    showFsPreviewMode(markdown || htmlPreview ? 'rendered' : 'source')
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
  up.controller?.abort()
  try { up.xhr?.abort() } catch {}
  try {
    await fetch(fsApiUrl('/upload-control', { path: up.path, name: up.name, session: up.session, action: 'cancel' }), {
      method: 'POST', headers: fsHeaders(), signal: AbortSignal.timeout(15000)
    })
  } catch {}
  if (state.fs.upload !== up) return
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
        method: 'POST', headers: fsHeaders(), signal: AbortSignal.timeout(15000)
      }).catch(() => {})
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
  if (!up || !up.file || up.active) return
  const connection = up.connection ||= captureConnection()
  const valid = () => connection.valid() && state.fs.upload === up && !up.cancelled
  if (!valid()) return
  up.controller = new AbortController()
  up.active = true
  up.cancelled = false
  up.paused = false
  up.pauseRequested = false
  setFsButtons(true, false)

  const uploadChunk = (params, blob) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    up.xhr = xhr
    xhr.open('POST', fsApiUrl('/upload', params))
    xhr.timeout = window.DshNetwork?.profile().weak ? 180000 : 90000
    xhr.ontimeout = () => { if (up.xhr === xhr) up.xhr = null; reject(new Error('上传等待超时，可查询进度后继续')) }
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
    const read = async signal => {
      const res = await fetch(fsApiUrl('/upload-probe', { path: up.path, name: up.name, session: up.session, size: String(up.size) }), { headers: fsHeaders(), signal })
      const json = await res.json()
      return { status: res.status, json }
    }
    const { status, json } = window.DshNetwork?.readWithDeadline
      ? await window.DshNetwork.readWithDeadline(read, window.DshNetwork.profile().readTimeout, up.controller.signal)
      : await read(AbortSignal.timeout(45000))
    if (!valid()) return null
    if (status === 401) { fsAuthError(401); return null }
    if (status !== 200 || !json.ok) throw new Error(json.error || ('HTTP ' + status))
    if (!Number.isSafeInteger(json.partialSize) || json.partialSize < 0 || json.partialSize > up.size) throw new Error('Invalid upload offset')
    up.offset = json.partialSize
    return json
  }

  let overwrite = false
  let wasResumed = false
  let offsetCorrections = 0
  let hasher = new SHA256()
  try {
    const info = await probe()
    if (info === null || !valid()) return
    if (info.partialSize > 0) wasResumed = true
    if (info.targetExists && info.targetSize === up.size && !overwrite) {
      if (!confirm(t('fs.confirmOverwrite'))) { state.fs.upload = null; hideFsProgress(); setFsButtons(false); return }
      overwrite = true
    }
    if (up.offset > 0) await hashFsRange(up.file, hasher, 0, up.offset, up)
    if (!valid()) return
    showFsProgress(Math.round(up.offset / Math.max(1, up.size) * 100), up.offset, up.size)

    while (up.offset < up.size) {
      if (!valid()) return
      const chunkSize = up.chunkSize || (window.DshNetwork?.profile().weak ? 256 * 1024 : FS_CHUNK_SIZE)
      const end = Math.min(up.offset + chunkSize, up.size)
      const blob = up.file.slice(up.offset, end)
      const before = hasher.clone()
      const chunkBytes = new Uint8Array(await blob.arrayBuffer())
      if (!valid()) return
      if (up.pauseRequested) {
        const err = new Error(t('fs.pausedErr')); err.code = 'PAUSED'; throw err
      }
      hasher.update(chunkBytes)
      const isLast = end >= up.size
      const params = { path: up.path, name: up.name, session: up.session, offset: String(up.offset), size: String(up.size) }
      if (isLast) { params.finish = '1'; params.sha256 = hasher.hex() }
      if (overwrite) params.overwrite = '1'
      const startedAt = Date.now()
      const r = await uploadChunk(params, blob)
      if (!valid()) return
      const elapsed = Date.now() - startedAt
      up.chunkSize = elapsed > 15000 ? Math.max(65536, Math.floor(chunkSize / 2)) : elapsed < 2000 ? Math.min(FS_CHUNK_SIZE, chunkSize * 2) : chunkSize
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
        if (++offsetCorrections > 3) throw new Error('Upload offset keeps changing; query progress before retrying')
        if (await probe() === null || !valid()) return
        hasher = new SHA256()
        if (up.offset > 0) await hashFsRange(up.file, hasher, 0, up.offset, up)
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
      if (!valid()) return
      if (up.pauseRequested) { const err = new Error(t('fs.pausedErr')); err.code = 'PAUSED'; throw err }
      let r = await uploadChunk(params, new Blob([]))
      if (!valid()) return
      if (r.status === 401) { fsAuthError(401); return }
      if (r.status === 409 && r.json.error === 'conflict') {
        if (!confirm(t('fs.confirmOverwrite2'))) { state.fs.upload = null; hideFsProgress(); setFsButtons(false); return }
        params.overwrite = '1'
        r = await uploadChunk(params, new Blob([]))
        if (!valid()) return
        if (r.status === 401) { fsAuthError(401); return }
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
    if (!valid() || e?.code === 'CANCELLED') return
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
    up.paused = true
    setFsButtons(true, true)
    toast(t('fs.uploadInterrupted', { msg: e.message }), 'err')
  } finally {
    up.active = false
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
  state.goalEditContext = { connection: captureConnection(), sessionId: state.current, history: state.history }
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
  const context = state.goalEditContext
  const valid = () => context?.connection.valid() && state.current === context.sessionId && state.history === context.history && state.goalEdit === goal
  if (!valid()) { $('modal-goal').classList.add('hidden'); return }
  const objective = $('goal-edit-text')?.value?.trim()
  if (!objective) return toast(t('goal.cannotEmpty'), 'err')
  const result = await safeRpc('goal.edit', { sessionId: context.sessionId, ref: { id: goal.id, revision: goal.revision }, objective }, t('goal.updateFailed'))
  if (result == null || !valid()) return
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
// LS.set silently tolerates quota/security errors. Keep failed writes available to
// the UI, and use sessionStorage so a page reload can retain the acknowledgement.
const announcementStorageFallback = new Map()
function clearAnnouncementFallback(key) {
  announcementStorageFallback.delete(key)
  try { sessionStorage.removeItem(key) } catch {}
}
function readAnnouncementStorage(key, fallback) {
  const saved = LS.get(key, null)
  let pending = announcementStorageFallback.get(key)
  if (!pending) {
    try { pending = JSON.parse(sessionStorage.getItem(key) || 'null') } catch {}
    if (!pending || typeof pending.value !== 'string' || !(pending.previous === null || typeof pending.previous === 'string')) pending = null
  }
  if (pending) {
    // Honor a newer persistent value written by another page, including recovery
    // of our own failed write. A blocked read may still return null.
    if (saved !== null && saved !== pending.previous) {
      clearAnnouncementFallback(key)
      return saved
    }
    announcementStorageFallback.set(key, pending)
    return pending.value
  }
  return saved ?? fallback
}
function writeAnnouncementStorage(key, value) {
  try { LS.set(key, value) } catch {}
  const saved = LS.get(key, null)
  if (saved === value) {
    clearAnnouncementFallback(key)
    return
  }
  const pending = { previous: saved, value }
  const alreadyFailed = announcementStorageFallback.has(key)
  announcementStorageFallback.set(key, pending)
  let backend = 'memory'
  try {
    sessionStorage.setItem(key, JSON.stringify(pending))
    backend = 'session'
  } catch {}
  if (!alreadyFailed) globalThis.DshDiagnostics?.record('announcement.storage', {
    phase: 'failed', storageBackend: backend,
    storageKey: key === ANNOUNCEMENTS_KEY ? 'seen' : key === ANNOUNCEMENT_HISTORY_KEY ? 'history' : 'votes'
  })
}
function resetAnnouncementStorage() {
  for (const key of [ANNOUNCEMENTS_KEY, ANNOUNCEMENT_HISTORY_KEY, ANNOUNCEMENT_VOTES_KEY]) {
    LS.del(key)
    clearAnnouncementFallback(key)
  }
}
function readSeenAnnouncements() {
  try {
    const value = JSON.parse(readAnnouncementStorage(ANNOUNCEMENTS_KEY, '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function markAnnouncementsSeen(items) {
  const ids = [...new Set((items || []).map(item => typeof item === 'string' ? item : item?.id).filter(Boolean))]
  if (!ids.length) return
  const seen = readSeenAnnouncements()
  const now = Date.now()
  for (const id of ids) seen[id] = now
  const keys = Object.keys(seen)
  if (keys.length > 100) {
    keys.sort((a, b) => Number(seen[a]) - Number(seen[b]))
    for (const key of keys.slice(0, keys.length - 100)) delete seen[key]
  }
  writeAnnouncementStorage(ANNOUNCEMENTS_KEY, JSON.stringify(seen))
  renderAnnouncementBoard()
}
function markAnnouncementSeen(id) { markAnnouncementsSeen([id]) }
function readAnnouncementVotes() {
  try {
    const value = JSON.parse(readAnnouncementStorage(ANNOUNCEMENT_VOTES_KEY, '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function announcementVoteKey(announcementId, pollId) {
  return `${announcementId}\u0000${pollId}`
}
function storeAnnouncementVote(announcementId, pollId, optionId) {
  const votes = readAnnouncementVotes()
  votes[announcementVoteKey(announcementId, pollId)] = { ...(optionId ? { optionId } : { submitted: true }), votedAt: Date.now() }
  const keys = Object.keys(votes)
  if (keys.length > 100) {
    keys.sort((a, b) => Number(votes[a]?.votedAt || 0) - Number(votes[b]?.votedAt || 0))
    for (const key of keys.slice(0, keys.length - 100)) delete votes[key]
  }
  writeAnnouncementStorage(ANNOUNCEMENT_VOTES_KEY, JSON.stringify(votes))
  renderAnnouncementBoard()
}
function announcementVote(item) {
  if (!item?.poll?.id) return null
  const saved = readAnnouncementVotes()[announcementVoteKey(item.id, item.poll.id)]
  // `submitted` is only ever written by the form path (storeAnnouncementVote with no
  // optionId), so it already implies a non-legacy poll.
  if (saved?.submitted) return { ...saved, option: { label: I18N.lang === 'en' ? 'Submitted' : '已提交' } }
  if (!saved?.optionId) return null
  const option = item.poll.options.find(entry => entry.id === saved.optionId)
  return option ? { ...saved, option } : null
}
function readAnnouncementHistory() {
  try {
    const value = JSON.parse(readAnnouncementStorage(ANNOUNCEMENT_HISTORY_KEY, '[]'))
    return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string') : []
  } catch { return [] }
}
function storeAnnouncementHistory(items) {
  const merged = new Map(readAnnouncementHistory().map(item => [item.id, item]))
  for (const item of items) if (item?.id) merged.set(item.id, item)
  const list = [...merged.values()].sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0)).slice(0, 50)
  writeAnnouncementStorage(ANNOUNCEMENT_HISTORY_KEY, JSON.stringify(list))
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
      <span class="overview-announcement-copy">${esc(item.summary || item.content)}</span>
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
    return `<details class="announcement-history-item"><summary><span>${esc(item.title)}</span><small>${esc(date)}</small></summary><div class="announcement-history-content">${announcementBodyHtml(item)}${action}${pollAction}</div></details>`
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
function normalizeAnnouncementPresentation(item) {
  if (typeof item?.summary !== 'string' || !Array.isArray(item.sections) || !item.sections.length || item.sections.length > 8) return {}
  const summary = item.summary.trim()
  if (!summary || summary.length > 2000) return {}
  let length = summary.length
  const sections = []
  for (const row of item.sections) {
    if (!row || typeof row.title !== 'string' || typeof row.content !== 'string') return {}
    const title = row.title.trim(), content = row.content.trim()
    if (!title || title.length > 160 || !content || content.length > 10000) return {}
    length += title.length + content.length
    if (length > 20000) return {}
    sections.push({ title, content, expanded: row.expanded === true })
  }
  return { summary, sections }
}
function announcementBodyHtml(item) {
  const text = value => esc(String(value ?? '').replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>')
  const presentation = normalizeAnnouncementPresentation(item)
  if (!presentation.sections) return text(item?.content)
  return `<div class="announcement-summary">${text(presentation.summary)}</div><div class="announcement-sections">` + presentation.sections.map(section =>
    `<details class="announcement-section"${section.expanded ? ' open' : ''}><summary><span class="announcement-section-title">${esc(section.title)}</span><span class="announcement-section-expand">${esc(t('announcement.expand'))}</span><span class="announcement-section-collapse">${esc(t('announcement.collapse'))}</span></summary><div class="announcement-section-body">${text(section.content)}</div></details>`
  ).join('') + '</div>'
}
function normalizeAnnouncementPoll(value, announcementId) {
  if (window.DshAnnouncementForms) return window.DshAnnouncementForms.normalize(value, announcementId)
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
    ...normalizeAnnouncementPresentation(item),
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
  const forms = window.DshAnnouncementForms
  $('announcement-poll-options').innerHTML = poll.legacy === false && forms
    ? forms.render(poll, state.announcementDrafts?.[announcementVoteKey(item.id, poll.id)] || [], !!vote, I18N.lang === 'en')
    : poll.options.map(option => `
    <label class="announcement-poll-option">
      <input type="radio" name="announcement-poll-option" value="${esc(option.id)}"${vote?.optionId === option.id ? ' checked' : ''}${vote ? ' disabled' : ''}>
      <span><strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ''}</span>
    </label>`).join('')
  const status = $('announcement-poll-status')
  status.textContent = vote ? t('announcement.voteThanks', { option: vote.option.label }) : ''
  status.classList.toggle('hidden', !vote)
  const submit = $('announcement-poll-submit')
  submit.classList.toggle('hidden', !!vote)
  submit.disabled = !!vote || !!state.announcementSubmitting
  if (poll.legacy !== false) submit.disabled = !document.querySelector('input[name="announcement-poll-option"]:checked') || !!state.announcementSubmitting
}
function renderAnnouncementPagination() {
  const total = state.announcementItems.length
  const nav = $('announcement-pagination')
  if (!nav) return
  nav.classList.toggle('hidden', total < 2)
  $('announcement-page').textContent = total > 1 ? t('announcement.page', { current: state.announcementIndex + 1, total }) : ''
  $('announcement-prev').disabled = state.announcementIndex <= 0
  $('announcement-next').disabled = state.announcementIndex >= total - 1
}
function renderAnnouncementModal() {
  const item = state.announcementItems[state.announcementIndex]
  if (!item) return
  state.announcement = item
  $('announcement-title').textContent = item.title
  $('announcement-content').innerHTML = announcementBodyHtml(item)
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
  // 同批存在强制公告时，不能借由切到普通公告而绕过“稍后再看”限制。
  $('announcement-later').classList.toggle('hidden', state.announcementItems.some(entry => entry.force))
  renderAnnouncementPagination()
}
function openAnnouncementModal(items, index = 0) {
  const list = (Array.isArray(items) ? items : [items]).filter(item => item?.id)
  if (!list.length) return
  state.announcementItems = list
  state.announcementIndex = Math.max(0, Math.min(Number(index) || 0, list.length - 1))
  renderAnnouncementModal()
  $('modal-announcement').classList.remove('hidden')
  globalThis.DshDiagnostics?.record('announcement.show',{phase:'shown',announcementId:state.announcement?.id,count:list.length})
}
function showAnnouncementAt(index) {
  if (!state.announcementItems.length) return
  state.announcementIndex = Math.max(0, Math.min(index, state.announcementItems.length - 1))
  renderAnnouncementModal()
}
async function submitAnnouncementVote() {
  const item = state.announcement
  const poll = item?.poll
  if (!poll || state.announcementSubmitting) return
  const forms = window.DshAnnouncementForms
  const optionId = document.querySelector('input[name="announcement-poll-option"]:checked')?.value || ''
  const option = poll.options.find(entry => entry.id === optionId)
  const answer = poll.legacy === false && forms ? forms.validate(poll, { answers: forms.read($('announcement-poll-options'), poll) }) : option ? { optionId: option.id } : { error: 'answer required' }
  if (answer.error) {
    const q = poll.questions?.find(row => row.id === answer.questionId)
    return toast((q ? q.question + '：' : '') + (I18N.lang === 'en' ? 'Check required answers and selection limits.' : '请检查必填内容、字数和选项数量。'), 'err')
  }
  const message = forms ? forms.encode(item.id, poll.id, answer) : `Poll ${poll.id}: ${option.id}`
  if (!message) return toast(I18N.lang === 'en' ? 'Answers are too long. Please shorten them.' : '回答总长度过长，请适当精简。', 'err')
  const button = $('announcement-poll-submit')
  const diagnostic=globalThis.DshDiagnostics?.start('announcement.vote',{announcementId:item.id,count:poll.questions?.length||1})
  button.disabled = true
  const connection = captureConnection(), valid = () => connection.valid() && state.announcement === item
  state.announcementSubmitting = true
  const payload = { type: 'poll', message, announcementId: item.id, pollId: poll.id, ...answer, appVersion: state.localVersion }
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
    // 仅旧单选投票保留公网兜底；含填写内容的表单只提交当前网关。
    if ((!res || res.status === 401) && poll.legacy !== false && connection.valid()) {
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
    if (!connection.valid()) { diagnostic?.end({phase:'skipped',reason:'unavailable'}); return }
    if (res?.ok && data.ok) {
      storeAnnouncementVote(item.id, poll.id, answer.optionId || '')
      markAnnouncementSeen(item.id)
      diagnostic?.end({phase:'complete',httpStatus:res.status})
      if (valid()) renderAnnouncementPoll(item)
      renderAnnouncementHistory()
      toast(poll.legacy === false ? (I18N.lang === 'en' ? 'Submitted successfully' : '已成功提交') : t('announcement.voteThanks', { option: option.label }), 'ok')
    } else if (res?.status === 429) {
      diagnostic?.end({phase:'failed',httpStatus:res.status})
      toast(t('announcement.voteAgainLater'), 'err')
      button.disabled = false
    } else {
      diagnostic?.end({phase:'failed',httpStatus:res?.status||0})
      toast(t('announcement.voteFailed', { msg: data.error || res?.status || t('announcement.voteNetworkError') }), 'err')
      button.disabled = false
    }
  } catch (e) {
    diagnostic?.fail(e)
    if (valid()) toast(t('announcement.voteFailed', { msg: e.message || t('announcement.voteNetworkError') }), 'err')
    button.disabled = false
  } finally {
    state.announcementSubmitting = false
    if (connection.valid() && state.announcement?.poll) {
      const active = state.announcement
      button.disabled = !!announcementVote(active) || (active.poll.legacy !== false && !document.querySelector('input[name="announcement-poll-option"]:checked'))
    }
  }
}
function closeAnnouncement(markSeen) {
  if (markSeen) markAnnouncementsSeen(state.announcementItems)
  globalThis.DshDiagnostics?.record('announcement.close',{phase:markSeen?'acknowledged':'dismissed',announcementId:state.announcement?.id,count:state.announcementItems.length})
  state.announcement = null
  state.announcementItems = []
  state.announcementIndex = 0
  $('modal-announcement').classList.add('hidden')
}
async function fetchAnnouncements() {
  const base = updateBase()
  if (!base || !state.localVersion || isAppVersionWarningOpen()) return false
  const diagnostic=globalThis.DshDiagnostics?.start('announcement.fetch')
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    const url = base + '/announcements.json?t=' + Date.now()
    const res = signal ? await fetch(url, { cache: 'no-store', signal }) : await fetch(url, { cache: 'no-store' })
    if (!res.ok) { diagnostic?.end({phase:'failed',httpStatus:res.status,reason:'http'}); return false }
    const raw = await res.text()
    if (raw.length > 512 * 1024) { diagnostic?.end({phase:'failed',reason:'too-large'}); return false }
    const data = JSON.parse(raw)
    const source = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [data])
    const normalized = source.map(item => normalizeAnnouncement(item, base)).filter(Boolean)
    state.announcements = normalized.sort((a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0))
    storeAnnouncementHistory(normalized)
    renderAnnouncementBoard()
    const seen = readSeenAnnouncements()
    const items = normalized.filter(item => !seen[item.id])
      .sort((a, b) => b.publishedAt - a.publishedAt)
    // 新旧界面均提示未读公告；拉取期间新出现的版本提醒仍优先展示。
    if (!items.length || state.announcement || isAppVersionWarningOpen()) { diagnostic?.end({phase:'skipped',count:items.length,reason:state.announcement?'already-open':isAppVersionWarningOpen()?'version-warning':'already-read'}); return false }
    openAnnouncementModal(items)
    diagnostic?.end({phase:'received',count:items.length,httpStatus:res.status})
    return true
  } catch(error) { diagnostic?.fail(error); return false }
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
    if (!silent || !window.DshWorkflow?.isMounted()) openNotesModal(info)
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

let updateDownloadBusy = false
let updateDownloadTimer = null
let updateDownloadSample = null

function updateDownloadProgress(value) {
  const box = $('update-download-progress')
  if (!box) return
  const received = Math.max(0, Number(value.received) || 0)
  const total = Math.max(0, Number(value.total) || 0)
  const now = performance.now()
  if (!updateDownloadSample || received < updateDownloadSample.received) updateDownloadSample = { time: now, received, speed: 0 }
  const elapsed = now - updateDownloadSample.time
  if (elapsed >= 800) updateDownloadSample = { time: now, received, speed: Math.max(0, received - updateDownloadSample.received) * 1000 / elapsed }
  const format = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
  const bar = $('update-download-bar')
  box.classList.remove('hidden')
  if (total > 0) bar.value = Math.min(100, received * 100 / total)
  else bar.removeAttribute('value')
  const phase = value.phase || 'downloading'
  $('update-download-status').textContent = phase === 'error' ? t('update.downloadFailed', { msg: value.error || t('fs.networkError') }) : t(`update.phase.${phase}`)
  $('update-download-detail').textContent = `${total > 0 ? `${Math.min(100, received * 100 / total).toFixed(0)}% · ` : ''}${format(received)}${total > 0 ? ` / ${format(total)}` : ''} · ${format(phase === 'downloading' ? updateDownloadSample.speed : 0)}/s`
}

function finishUpdateDownload() {
  updateDownloadBusy = false
  clearInterval(updateDownloadTimer)
  updateDownloadTimer = null
  $('btn-download-update').disabled = false
  const forceButton=$('btn-force-download-update');if(forceButton)forceButton.disabled=false
}

async function verifyUpdateApk(info, url) {
  const controller = new AbortController()
  let timer
  let received = 0, total = 0, phase = 'downloading'
  const progressTimer = setInterval(() => updateDownloadProgress({ phase, received, total }), 500)
  const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), 60000) }
  try {
    resetTimeout()
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return { ok: false, status: res.status }
    total = Number(res.headers.get('content-length')) || 0
    const chunks = []
    if (res.body?.getReader) {
      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.byteLength
        resetTimeout()
        updateDownloadProgress({ phase: 'downloading', received, total })
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()))
      received = chunks[0].byteLength
    }
    if (total > 0 && total !== received) return { ok: false, corrupted: true }
    const blob = new Blob(chunks, { type: 'application/vnd.android.package-archive' })
    phase = 'verifying'
    updateDownloadProgress({ phase, received, total: total || received })
    const expected = String(info.sha256 || '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(expected)) return { ok: false, corrupted: true }
    const actual = await sha256Hex(await blob.arrayBuffer())
    if (actual !== expected) return { ok: false, corrupted: true }
    return { ok: true, blob }
  } catch (err) { return { ok: false, network: true, msg: err?.message || '' } }
  finally { clearTimeout(timer); clearInterval(progressTimer) }
}

async function downloadUpdate(force = false) {
  if (updateDownloadBusy || (force !== true && !state.updateInfo)) return
  const base=updateBase()
  if(!base){toast(t('update.needServer'),'err');return}
  const connection=captureConnection()
  updateDownloadBusy = true
  updateDownloadSample = null
  $('btn-download-update').disabled = true
  const forceButton=$('btn-force-download-update');if(forceButton)forceButton.disabled=true
  let nativePending=false
  try {
    let info=state.updateInfo
    if(force===true){
      updateDownloadProgress({phase:'checking',received:0,total:0})
      // Same-version patches deliberately bypass only version comparison. Both
      // metadata and APK bytes are fetched afresh; hash verification still applies.
      const response=await fetch(base+'/update.json?t='+Date.now()+'&local='+encodeURIComponent(state.localVersion||''),{cache:'no-store',signal:AbortSignal.timeout(15000)})
      if(!response.ok)throw new Error('HTTP '+response.status)
      info=await response.json()
    }
    if(!connection.valid())return
    const sha256=String(info?.sha256||'').trim().toLowerCase()
    if(!/^[0-9a-f]{64}$/.test(sha256))throw new Error(t('update.hashMissing'))
    const target=new URL(info.apkUrl||'dsh-remote.apk',base+'/')
    if(force===true)target.searchParams.set('dshPatch',Date.now().toString(36)+'-'+sha256.slice(0,16))
    const url=target.href
    updateDownloadProgress({ phase: 'downloading', received: 0, total: 0 })
    if (CAP?.isNativePlatform?.() && window.NativeUpdate?.downloadVerifiedAndInstall && window.NativeUpdate?.getDownloadStatus) {
      if (!window.NativeUpdate.downloadVerifiedAndInstall(url, sha256)) throw new Error(t('update.busy'))
      nativePending=true
      const poll = () => {
        try {
          const value = JSON.parse(window.NativeUpdate.getDownloadStatus())
          updateDownloadProgress(value)
          if (['complete', 'error'].includes(value.phase)) finishUpdateDownload()
        } catch (error) { updateDownloadProgress({ phase: 'error', error: error.message }); finishUpdateDownload() }
      }
      updateDownloadTimer = setInterval(poll, 500)
      poll()
      return
    }
    const result = await verifyUpdateApk(info, url)
    if(!connection.valid())return
    if (!result.ok) throw new Error(result.corrupted ? t(force===true?'update.patchMismatch':'update.corrupted') : result.status ? t('update.serverFileMissing') : result.msg || t('fs.networkError'))
    {
      // 无校验的原生安装入口已移除: 新旧壳统一走下方"下载并本地校验"路径。
      const objectUrl = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = 'dsh-remote.apk'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
      updateDownloadProgress({ phase: 'complete', received: result.blob.size, total: result.blob.size })
    }
  } catch (error) { if(connection.valid())updateDownloadProgress({ phase: 'error', error: error.message }) }
  finally { if(!nativePending)finishUpdateDownload() }
}


/* ---------------- 通知 ---------------- */
const CAP = window.Capacitor || null
const pendingNotificationSeen = new Set()
function notifyPendingRequest(full, title, body) {
  const bridge = window.NativeBackground
  if (bridge?.handlePendingEvent) {
    bridge.handlePendingEvent(bgBase(), state.token || '', JSON.stringify(full), LS.get('notify', '0') === '1')
    return
  }
  const key = connectionGeneration + ':' + (full.payload?.approvalId || full.rpcId)
  if (LS.get('notify', '0') !== '1' || pendingNotificationSeen.has(key)) return
  if (pendingNotificationSeen.size >= 512) pendingNotificationSeen.delete(pendingNotificationSeen.values().next().value)
  pendingNotificationSeen.add(key)
  notify(title, body)
}
function clearPendingNotification(payload) {
  window.NativeBackground?.handlePendingEvent?.(bgBase(), state.token || '', JSON.stringify({ payload }), false)
}

let pendingNavigationBusy = false, pendingNavigationReady = false
async function openPendingNavigation() {
  const bridge = window.NativeBackground
  if (!pendingNavigationReady || pendingNavigationBusy || !bridge?.getPendingNavigation) return
  const raw = bridge.getPendingNavigation()
  if (!raw) return
  pendingNavigationBusy = true
  try {
    const target = JSON.parse(raw)
    const matches = (base, token) => bridge.matchesPendingNavigation(base, token, target.identity)
    if (!matches(bgBase(), state.token || '')) {
      const server = state.servers.find(s => matches(s.url, serverToken(s)))
      if (!server) { toast(t('notify.hostUnavailable'), 'err'); bridge.acknowledgePendingNavigation(raw); return }
      state.activeGroup = server.group
      state.groupActive[server.group] = server.id
      state.server = server.url; state.token = serverToken(server)
      LS.set('token', state.token)
      saveServers(); syncBgConfig(); renderServers(); openStreams()
    }
    bridge.acknowledgePendingNavigation(raw)
    const connection = captureConnection()
    await refreshSessions()
    if (!connection.valid()) return
    if (state.byId.has(target.sessionId)) await openSession(target.sessionId)
    else { showView('view-activity'); toast(t('question.stale'), 'err') }
  } catch (error) { toast(error.message, 'err') }
  finally {
    pendingNavigationBusy = false
    const next = bridge.getPendingNavigation()
    if (next && next !== raw) void openPendingNavigation()
  }
}
window.addEventListener('dsh-pending-navigation', () => void openPendingNavigation())
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
  if (window.NativeBackground?.testNotification) {
    if (!await ensureNotify()) return toast(t('settings.notifyDenied'), 'err')
    const kind = $('test-notify-kind')?.value || 'approval'
    const sent = window.NativeBackground.testNotification(kind)
    applyBgConfigFromNative()
    toast(sent ? (I18N.lang === 'en' ? 'Test notification submitted. Check the selected system channel.' : '测试通知已提交，请检查所选系统通知渠道。') : t('settings.notifyDenied'), sent ? 'ok' : 'err')
    return
  }
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
    const status = $('bg-auth-status')
    if (status) {
      status.removeAttribute('data-i18n')
      status.textContent = cfg.loginExpired ? t('settings.bgAuthFailed') : cfg.enabled && cfg.serviceRunning === false
        ? (I18N.lang === 'en' ? 'Background receiver is not running. Reopen the app or toggle to retry. ' : '后台接收未运行，返回应用或重新开关后重试。') + (cfg.serviceState || '')
        : cfg.enabled && cfg.serviceRunning === true ? (I18N.lang === 'en' ? 'Background receiver is running.' : '后台接收运行中。') + (cfg.lastSuccessAt ? ' ' + new Date(cfg.lastSuccessAt).toLocaleTimeString() : '') : ''
      const blocked = []
      if (cfg.notificationsEnabled === false) blocked.push(I18N.lang === 'en' ? 'System notifications disabled' : '系统通知已关闭')
      if (cfg.attentionChannelEnabled === false) blocked.push(I18N.lang === 'en' ? 'Approval channel disabled' : '审批提醒渠道已关闭')
      if (cfg.taskChannelEnabled === false) blocked.push(I18N.lang === 'en' ? 'Task result channel disabled' : '任务结果渠道已关闭')
      if (blocked.length) status.textContent = [status.textContent, ...blocked].filter(Boolean).join(' · ')
      status.classList.toggle('hidden', !status.textContent)
    }
  } catch {}
}
function saveBgConfig(enabled) {
  const b = bgBridge()
  if (!b?.saveBackgroundConfig) return false
  const base = bgBase()
  const intervalMin = parseFloat($('bg-interval')?.value || '0.5') || 0.5
  const notifyTaskDone = $('opt-task-done')?.checked !== false
  const saved = b.saveBackgroundConfig(JSON.stringify({ enabled, intervalMin, base, token: state.token || '', clientId: CLIENT_ID || '', notifyTaskDone })) !== false
  if (enabled) $('bg-auth-status')?.classList.add('hidden')
  return saved
}
function syncBgConfig() {
  if (state.token && bgBridge()?.saveBackgroundConfig) saveBgConfig(!!$('opt-bg-poll')?.checked)
  void syncPeakReminders()
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

/* ---------------- 插件规则驱动的 Android 峰谷通知 ---------------- */
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

async function cancelPeakReminders() {
  if (!CAP?.isNativePlatform?.()) return false
  const legacyCleaned = await cancelLegacyPeakNotifications()
  const b = bgBridge()
  if (b?.savePeakReminderConfig) return b.savePeakReminderConfig(JSON.stringify({ enabled: false })) !== false && legacyCleaned
  if (!b?.stopPeakReminder) return false
  try {
    const stopped = b.stopPeakReminder() !== false
    return stopped && legacyCleaned
  } catch { return false }
}

async function restorePeakReminders() {
  await cancelLegacyPeakNotifications()
  let enabled = LS.get('peakRemind', '')
  if (!enabled) {
    try { enabled = JSON.parse(bgBridge()?.getPeakReminderConfig?.() || '{}').enabled ? '1' : '0' } catch { enabled = '0' }
  }
  $('opt-peak-remind').checked = enabled === '1'
  LS.set('peakRemind', enabled)
  if (enabled === '1') await syncPeakReminders()
}
let peakReminderRead = 0
async function syncPeakReminders() {
  const b = bgBridge()
  if (!CAP?.isNativePlatform?.() || !b?.savePeakReminderConfig) return false
  const enabled = LS.get('peakRemind', '0') === '1', serial = ++peakReminderRead
  const config = { enabled, base: bgBase(), token: state.token || '', clientId: CLIENT_ID || '' }
  const status = $('peak-remind-status'), say = value => { if (status) status.textContent = value }
  const started = b.savePeakReminderConfig(JSON.stringify(config)) !== false
  if (!enabled) { say(''); return started }
  if (!started) { say(I18N.lang === 'en' ? 'Background receiver failed to start. Check system restrictions.' : '后台提醒未启动，请检查系统限制后重试。'); return false }
  if (!state.token) { say(t('settings.bgNeedToken')); return false }
  say(I18N.lang === 'en' ? 'Reading dsh-cost-meter rules…' : '正在读取 dsh-cost-meter 规则…')
  const connection = captureConnection()
  try {
    const response = await fetch(connection.server + '/remote/api/insights/peak-reminders', { headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': 'app', ...clientIdHeaders() }, signal: AbortSignal.timeout(20000) })
    const data = await response.json()
    if (!connection.valid() || serial !== peakReminderRead) return false
    if (!response.ok || data.ok !== true) throw Error('unavailable')
    b.savePeakReminderConfig(JSON.stringify({ ...config, policy: data }))
    say(data.available !== true ? (I18N.lang === 'en' ? 'No compatible cost-meter rules on this host.' : '主机未提供兼容的费用插件规则，请检查插件和网关版本。')
      : data.enabled === false ? (I18N.lang === 'en' ? 'Reminders are disabled in dsh-cost-meter.' : '费用插件已关闭峰谷提醒，请在 DSH 峰谷计价设置中开启。')
      : (I18N.lang === 'en' ? 'Rules synced. Android will deliver reminders in the background.' : '规则已同步，由 Android 在后台发送通知。'))
    return data.available === true
  } catch {
    if (connection.valid() && serial === peakReminderRead) say(I18N.lang === 'en' ? 'Rules could not refresh. The receiver will retry; only unexpired cached rules apply.' : '规则暂未刷新，后台会重试；仅使用未过期的已缓存规则。')
    return false
  }
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
  const connection = captureConnection()
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
    if (!connection.valid()) return
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
      if (!connection.valid()) return
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
    if (!connection.valid()) return
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
  const connection = captureConnection(), valid = () => connection.valid() && state.modelEditor === editor
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
    if (!valid()) return
    const found = Array.isArray(value?.models) ? value.models.filter(model => model && typeof model.id === 'string' && model.id.trim()) : []
    if (!found.length) throw new Error(t('settings.modelFetchEmpty'))
    const known = new Set(editor.models.map(model => model.id))
    editor.discovered = found
    editor.discoverySelected = new Set(found.filter(model => !known.has(model.id)).map(model => model.id))
  } catch (error) {
    if (!valid()) return
    editor.error = t('settings.modelFetchFailed', { msg: error?.message || String(error) })
  } finally {
    editor.busy = false
  }
  if (valid()) renderModelSettings()
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
  const connection = captureConnection(), valid = () => connection.valid() && state.modelEditor === editor
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
      if (!valid()) return
      editor.namespace = value
    }
    if (editor.keyDraft.trim()) {
      await rpc('credentials.set', { ref: editor.keyRef, value: editor.keyDraft.trim() })
    } else if (editor.clearKey && editor.keyConfigured && editor.keyRef) {
      await rpc('credentials.unset', { ref: editor.keyRef })
    }
    if (!valid()) return
    state.modelEditor = null
    await loadModelSettings(true)
    if (!connection.valid()) return
    toast(t('settings.modelSaved'), 'ok')
  } catch (error) {
    if (!valid()) return
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
function showView(id, pluginRoute = 'manage') {
  window.DshExtensions?.closeShortcuts()
  if (id !== 'view-session') window.DshSubagents?.close()
  document.body?.classList.toggle('viewing-subagent', id === 'view-session' && state.byId.get(state.current)?.origin === 'subagent')
  window.DshWorkflow?.close()
  if (window.DshWorkflow?.isMounted() && id === 'view-activity') id = 'view-home'
  if (id !== 'view-session') conversationView?.pause()
  if (id !== 'view-session' && document.body.classList.contains('in-session') && state.current) void archiveEmptySessionOnLeave(state.current)
  for (const v of ['view-home', 'view-files', 'view-session', 'view-activity', 'view-plugins', 'view-settings']) $(v).classList.toggle('hidden', v !== id)
  // 离开会话页必须清掉 in-session, 否则其他页面顶栏被 body 样式隐藏
  document.body.classList.toggle('in-session', id === 'view-session')
  window.DshFileInbox?.render()
  window.DshSessionDeck?.refresh()
  if (id === 'view-session') conversationView?.resume()
  $('session-actions')?.close()
  $('session-info')?.close()
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === id))
  window.DshMotion?.view($(id))
  window.scrollTo(0, 0)
  if (id === 'view-files' && !state.fs.loaded) {
    const workspace = workspaceById(state.fs.workspaceId)
    loadFs(workspace?.path || null, { silent: true, resetRoot: true })
  }
  if (id === 'view-plugins') openPluginPage(pluginRoute)
  else window.DshExtensions?.close()
  if (id === 'view-settings') showSettingsHome()
  if(id==='view-activity')startOverviewDetection(true);else {overviewDetector?.pause();overviewPulse?.pause()}
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
  overviewDetector?.observe()
  const el = $('conn-badge')
  // mux/host 的打开顺序不稳定；连接状态改变时同步重绘总览，避免后打开的
  // 通道只更新顶栏、总览却永久停留在 3/4。
  renderOverview()
  const cur = currentServerEntry()
  const ms = cur ? state.serverLatency[serverKey(cur)] : undefined
  const curGroup = cur ? cur.group : state.activeGroup
  const curLabel = cur ? (cur.note || cur.url) : (state.server || t('speed.origin'))
  const titleBase = t('conn.titleGroup', { group: curGroup, url: curLabel, ms: Number.isFinite(ms) ? ms + 'ms' : '—' }) + ' · ' + t('conn.refresh')
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
  $('btn-session-more')?.classList.toggle('hidden', !!on)
  $('session-actions')?.close()
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
function applyPairUrl(url, options = {}) {
  try {
    const u = new URL(String(url).trim())
    if (u.protocol !== 'dshremote:' || u.hostname !== 'pair') return false
    const tok = (u.searchParams.get('token') || '').trim()
    const servers = [...new Set(u.searchParams.getAll('server')
      .map(value => value.trim().replace(/\/+$/, ''))
      .filter(value => /^https?:\/\//i.test(value)))]
    if (!tok || !servers.length) return false
    const alreadyPaired = (state.servers || []).some(s => normalizedServerToken(s.token) === tok
      && servers.includes(String(s.url || '').replace(/\/+$/, '')))
    if (options.confirmExisting && !alreadyPaired && (state.token || (state.servers || []).length)) {
      // 深链可被任意应用/网页触发: 已有配置时必须由用户确认，不能静默换服务器和令牌
      const confirmed = window.confirm(t('scan.pairConfirm', { servers: servers.join('\n') }))
      if (!confirmed) return false
    }
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
      if (data?.url && applyPairUrl(data.url, { confirmExisting: true })) {
        toast(t('scan.pairedLink'), 'ok')
        openStreams()
        refreshAll()
      }
    })
    CAP.Plugins?.App?.getLaunchUrl?.().then((data) => {
      if (data?.url) applyPairUrl(data.url, { confirmExisting: true })
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
  doctorSessionHandoff = window.DshDoctorEntry?.restoreSessionConnection?.({state,newId:newServerId,persist:()=>{LS.set('token',state.token);saveServers()}}) === true
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
  const failed = operation.stage !== 'unknown' && (operation.stage === 'failed' || operation.done && operation.ok === false)
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

let dshControlPollContext = null
function dshControlContext() {
  const connection = captureConnection(), url = adminApiUrl('/admin/api/dsh')
  return { ...connection, url }
}

async function pollDshControlOperation(operationId, initial, context = dshControlContext()) {
  let value = initial
  if (context.valid() && value?.done) { renderDshControlOperation(value); return value }
  const deadline = Math.min(Number(initial?.deadlineAt) || Date.now() + 60000, Date.now() + 320000)
  let failures = 0
  while (context.valid() && Date.now() < deadline) {
    renderDshControlOperation(value)
    if (value.done) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(700 * (failures + 1), 3000)))
    if (!context.valid()) return null
    try {
      const res = await fetch(context.url + '?operation=' + encodeURIComponent(operationId), {
        headers: { authorization: 'Bearer ' + context.token }, cache: 'no-store', signal: AbortSignal.timeout(8000)
      })
      if (!context.valid()) return null
      if (res.status === 401) { authFailure(); throw Object.assign(new Error('unauthorized'), { auth: true }) }
      const next = await readDshControlResponse(res)
      if (!context.valid()) return null
      if (!res.ok) {
        if (res.status === 404 || res.status === 429 || res.status >= 500) throw new Error('gateway recovering')
        throw Object.assign(new Error(next.error || next.message || `HTTP ${res.status}`), { dshPayload: { ...next, httpStatus: res.status } })
      }
      if (next.operationId !== operationId) throw new Error('invalid operation response')
      value = next; failures = 0
      if (value.done) { renderDshControlOperation(value); return value }
    } catch (error) {
      if (!context.valid()) return null
      if (error.auth || error.dshPayload) throw error
      failures++
      value = { ...value, done: false, stage: 'recovering', message: t('settings.dshRecovering') }
    }
  }
  return context.valid() ? { ...value, done: true, ok: false, stage: 'unknown', code: 'RESULT_UNKNOWN', message: t('settings.dshResultUnknown') } : null
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
  $('btn-dsh-start').disabled = value.running === true || value.canStart === false
  $('btn-dsh-restart').disabled = value.canRestart === false || value.running === false
  if (box && !dshControlPollPromise) box.classList.add('hidden')
  if (value.canStart === false && value.code) { desc.textContent=dshControlFailureText(value); return }
  const service = value.service || 'dsh-web'
  const serviceState = `${value.activeState || value.state || 'unknown'}/${value.subState || 'unknown'}`
  desc.textContent = value.running
    ? t('settings.dshRunningDetail', { service, pid: value.mainPid || '—', state: serviceState })
    : t('settings.dshStoppedDetail', { service, state: serviceState })
}

async function loadDshControl() {
  if (!state.token || !$('dsh-control-desc')) return
  const context = dshControlContext()
  if (activeGatewayCapability('dshLifecycle') === false) {
    renderDshControlStatus({
      supported: false,
      message: activeGatewayHealth()?.dshControl?.message || t('settings.dshUnsupported')
    })
    return
  }
  try {
    const res = await fetch(context.url, { headers: { authorization: 'Bearer ' + context.token }, cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!context.valid()) return
    if (res.status === 401) return authFailure()
    const value = await readDshControlResponse(res)
    if (!context.valid()) return
    if (!res.ok) throw Object.assign(new Error(value.error || value.message || `HTTP ${res.status}`), { dshPayload: value })
    if (dshControlPollPromise && dshControlPollContext?.valid()) return
    renderDshControlStatus(value)
    if (value.operation?.operationId && !value.operation.done) {
      dshControlPollContext = context
      const job = pollDshControlOperation(value.operation.operationId, value.operation, context)
        .then(result => { if (context.valid() && result) renderDshControlOperation(result) })
        .catch(error => {
          if (context.valid() && !error?.auth) $('dsh-control-desc').textContent = t('settings.dshFailed', { msg: error?.dshPayload ? dshControlFailureText(error.dshPayload) : t('settings.dshResultUnknown') })
        })
        .finally(() => { if (dshControlPollPromise === job) { dshControlPollPromise = null; if (context.valid()) void loadDshControl() } })
      dshControlPollPromise = job
    }
  } catch (error) {
    if (!context.valid()) return
    $('dsh-control-desc').textContent = t('settings.dshStatusFailed', { msg: error?.dshPayload ? dshControlFailureText(error.dshPayload) : t('conn.off') })
  }
}

async function controlDsh(action) {
  if (dshControlPollPromise && dshControlPollContext?.valid()) return
  const context = dshControlContext(), requestId = uuid()
  let release
  const busy = new Promise(resolve => { release = resolve })
  dshControlPollPromise = busy; dshControlPollContext = context
  const label = action === 'start' ? t('settings.dshStart') : t('settings.dshRestart')
  dshControlButtonsBusy(true, true)
  renderDshControlOperation({ action, service: 'dsh-web', accepted: true, done: false, stage: 'queued', elapsedMs: 0, steps: [] })
  try {
    let res
    try { res = await fetch(context.url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + context.token, 'content-type': 'application/json' },
      body: JSON.stringify({ action, requestId }), signal: AbortSignal.timeout(8000),
    }) } catch {
      if (!context.valid()) return
      const recovered = await pollDshControlOperation(requestId, { action, done: false, deadlineAt: Date.now() + 60000 }, context)
      if (context.valid() && recovered) renderDshControlOperation(recovered)
      return
    }
    if (!context.valid()) return
    if (res.status === 401) return authFailure()
    let v = await readDshControlResponse(res)
    if (!context.valid()) return
    if (res.status === 409 && v.operation?.operationId) v = v.operation
    else if (!res.ok) throw Object.assign(new Error(v.error || v.message || `HTTP ${res.status}`), { dshPayload: { ...v, httpStatus: res.status } })

    if (v.accepted && v.operationId) {
      v = await pollDshControlOperation(v.operationId, v, context)
      if (!context.valid() || !v) return
      if (v.stage === 'unknown') { renderDshControlOperation(v); return }
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
    if (!context.valid()) return
    if (error?.auth) return
    const payload = error?.dshPayload
    const message = payload ? dshControlFailureText(payload) : t('settings.dshResultUnknown')
    if (payload) renderDshControlOperation({ action, service: payload.service || 'dsh-web', done: true, ok: false, stage: 'failed', steps: payload.steps || [], ...payload })
    else $('dsh-control-desc').textContent = t('settings.dshFailed', { msg: message })
    toast(t('settings.dshFailed', { msg: message }), 'err')
  } finally {
    release()
    if (dshControlPollPromise === busy) { dshControlPollPromise = null; if (context.valid()) void loadDshControl() }
  }
}

function renderLangBtn() {
  const btn = $('btn-lang')
  if (btn) btn.textContent = I18N.lang === 'zh' ? 'EN' : '中文'
}

const THEME_META = [
  { id: 'default', sw: ['#0D1117', '#21262D', '#58A6FF'] },
  { id: 'dark', sw: ['#161316', '#302323', '#FFB86B'] },
  { id: 'light', sw: ['#F5F7F8', '#FFFFFF', '#176B87'] },
  { id: 'neutral', sw: ['#EEF1E8', '#FAFBF6', '#47643C'] },
  { id: 'mono', sw: ['#050505', '#333333', '#F5F5F5'] },
  { id: 'fish', sw: ['#EAF6FF', '#FFFFFF', '#2F52D0'] },
  { id: 'penguin', sw: ['#EDF3FA', '#FFFFFF', '#2B6CB0'] },
  { id: 'penguin-night', sw: ['#10151B', '#1A222C', '#F2C230'] },
  { id: 'bocchi', sw: ['#FFD9E8', '#FFFFFF', '#D0105A'] },
  { id: 'nijika', sw: ['#FFF3D5', '#FFFFFF', '#94600C'] },
  { id: 'ryo', sw: ['#E9F1FA', '#FFFFFF', '#315D91'] },
  { id: 'kita', sw: ['#FFE9E5', '#FFFFFF', '#B6373C'] }
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
    <button type="button" class="theme-option ${m.id === cur ? 'current' : ''}" data-theme="${m.id}" aria-pressed="${m.id === cur}" title="${t('theme.' + m.id)}">
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


function bindSessionDialogs() {
  if (typeof ResizeObserver !== 'undefined') {
    const wrap=$('composer-wrap')
    const observer=new ResizeObserver(()=>{
      if(!wrap.classList.contains('fs'))document.documentElement.style.setProperty('--composer-height', wrap.getBoundingClientRect().height+'px')
      if(document.body.classList.contains('in-session'))document.documentElement.style.setProperty('--composer-top', $('session-sub').getBoundingClientRect().bottom+'px')
    })
    observer.observe(wrap)
    observer.observe($('session-head'))
    observer.observe($('session-sub'))
  }
  const actions=$('session-actions'), info=$('session-info');
  $('btn-session-more').addEventListener('click',()=>actions.showModal());
  actions.addEventListener('click',e=>{if(e.target===actions)actions.close();else if(e.target.closest('button'))actions.close()},true);
  const openInfo=()=>{const s=state.byId.get(state.current);if(!s)return; $('session-info-name').textContent=titleOf(s);$('session-info-path').textContent=s.cwd||t('session.noWorkspace');$('session-info-id').textContent=s.sessionId;$('btn-copy-session-workspace').disabled=!s.cwd;info.showModal()};
  $('session-title').addEventListener('click',openInfo);
  $('session-sub').addEventListener('click',openInfo);
  $('btn-session-info').addEventListener('click',openInfo);
  info.addEventListener('click',e=>{if(e.target===info||e.target.closest('[data-session-dialog-close]'))info.close()});
  $('btn-copy-session-workspace').addEventListener('click',async()=>{const value=state.byId.get(state.current)?.cwd;if(value&&await copyText(value))toast(t('feedback.copied'),'ok')});
}

function bindUi() {
  bindSessionDialogs()
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
    if (state.current) { renderSessionTitle(); renderSessionSub(); renderSessionCards(); renderHistory(true) }
    else renderModelMenu()
    loadLocalVersion()
    if (state.hostInfo) $('host-desc').textContent = hostDescriptionText(state.hostInfo)
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
  // 会话列表点击与键盘激活共享目标。
  $('session-list').addEventListener('keydown', event => {
    const card = event.target.closest('[data-session-swipe]')
    if (card && event.target === card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); void openSession(card.dataset.id) }
  })
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
      void newSession(newButton.dataset.wbNew)
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
  $('btn-insights').addEventListener('click', () => openInsights())
  $('stats-close').addEventListener('click', () => $('modal-stats').classList.add('hidden'))
  $('conn-badge').addEventListener('click', () => { toast(t('common.refreshing')); openStreams(); void refreshAll() })
  window.DshExtensions?.bindShortcuts({ trigger: $('btn-plugin-shortcuts'), menu: $('plugin-shortcuts-menu'),
    config: () => optionalPluginConfig(), connected: () => !!state.token, hasSession: () => !!state.current,
    beforeOpen: () => { closeFeedbackSheet(); closeGroupDrawer({ restoreFocus: false }) },
    open: route => { if (route === 'context') void openInsights('context', true); else showView('view-plugins', route) } })
  $('overview-refresh').addEventListener('click', () => {
    toast(t('common.refreshing'))
    startOverviewDetection(true)
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
  $('btn-doctor').addEventListener('click', openDoctor)
  $('home-doctor').addEventListener('click', openDoctor)
  $('fb-cancel').addEventListener('click', closeFeedbackModal)
  $('fb-submit').addEventListener('click', submitFeedback)
  $('fb-include-diagnostics').addEventListener('change',()=>{void loadCrashPreview()})
  $('fb-include-crashes').addEventListener('change',()=>{void loadCrashPreview()})
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
  bindComposerSend($('btn-send'))
  bindComposerSend($('btn-fs-send'))
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
      const input = $('composer-input')
      input.value = chip.dataset.cmd + ' '
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
  window.visualViewport?.addEventListener('resize', fitQuestionViewport)
  window.visualViewport?.addEventListener('scroll', fitQuestionViewport)
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
  $('announcement-prev').addEventListener('click', () => showAnnouncementAt(state.announcementIndex - 1))
  $('announcement-next').addEventListener('click', () => showAnnouncementAt(state.announcementIndex + 1))
  $('announcement-later').addEventListener('click', () => closeAnnouncement(false))
  $('announcement-confirm').addEventListener('click', () => closeAnnouncement(true))
  const saveAnnouncementDraft = () => {
    const item = state.announcement
    if (item?.poll?.legacy === false && window.DshAnnouncementForms) {
      state.announcementDrafts ||= Object.create(null)
      state.announcementDrafts[announcementVoteKey(item.id, item.poll.id)] = window.DshAnnouncementForms.read($('announcement-poll-options'), item.poll)
    }
    $('announcement-poll-submit').disabled = !!state.announcementSubmitting
  }
  $('announcement-poll-options').addEventListener('change', saveAnnouncementDraft)
  $('announcement-poll-options').addEventListener('input', saveAnnouncementDraft)
  $('announcement-poll-submit').addEventListener('click', submitAnnouncementVote)
  $('modal-announcement').addEventListener('click', (e) => {
    if (e.target === $('modal-announcement') && !state.announcementItems.some(item => item.force)) closeAnnouncement(false)
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
  window.DshLanDiscovery?.mount($('btn-lan-discover'), result => {
    const url = new URL('dshremote://pair')
    url.searchParams.set('server', result.server); url.searchParams.set('token', result.token)
    if (!applyPairUrl(url.href)) return toast(t('send.failed'), 'err')
    const server = state.servers.find(entry => entry.url === result.server && entry.token === result.token)
    if (server) { server.note = String(result.name || '').slice(0, 40); saveServers(); renderServers() }
    openStreams(); toast(t('scan.paired'), 'ok')
  })
  $('btn-group-add').addEventListener('click', addGroup)
  $('group-select-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleGroupMenu() })
  $('group-drawer-trigger').addEventListener('click', () => { groupDrawerOpen() ? closeGroupDrawer() : openGroupDrawer() })
  $('group-drawer-close').addEventListener('click', () => closeGroupDrawer())
  $('group-drawer-backdrop').addEventListener('click', () => closeGroupDrawer())
  $('group-drawer-list').addEventListener('click', (e) => {
    const option = e.target.closest('[data-quick-group]')
    if (!option) return
    const group = option.dataset.quickGroup
    closeGroupDrawer({ restoreFocus: false })
    if (group !== state.activeGroup) switchGroup(group)
  })
  $('group-drawer-manage').addEventListener('click', () => {
    closeGroupDrawer({ restoreFocus: false })
    showView('view-settings')
    showSettingsPage('servers')
  })
  document.addEventListener('keydown', keepGroupDrawerFocus)
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
  $('btn-download-update').addEventListener('click', () => void downloadUpdate())
  $('btn-force-download-update').addEventListener('click', () => void downloadUpdate(true))
  $('btn-update-expand').addEventListener('click', toggleUpdateExpand)
  $('app-version-later').addEventListener('click', () => closeAppVersionWarning(false))
  $('app-version-update').addEventListener('click', () => closeAppVersionWarning(true))
  $('modal-app-version-warning').addEventListener('click', (e) => {
    if (e.target === $('modal-app-version-warning')) closeAppVersionWarning(false)
  })
  $('btn-reset').addEventListener('click', async () => {
    if (!confirm(t('settings.confirmReset'))) return
    clearTimeout(scheduleHistoryCacheSave._t)
    await window.DshHistory.cacheClear()
    await window.DshImageCache?.clear()
    LS.del('token'); LS.del('notify'); LS.del('server'); LS.del('mobileEnterAction'); LS.del('steerSendingEnabled'); LS.del('busySendMode'); resetAnnouncementStorage()
    if (bgBridge()?.saveBackgroundConfig) saveBgConfig(false)
    location.reload()
  })
  $('mobile-enter-action').value = mobileEnterAction()
  $('opt-steer-send').checked = steerSendingEnabled()
  $('busy-send-mode').value = LS.get('busySendMode', 'queue') === 'steer' ? 'steer' : 'queue'
  $('busy-send-mode').disabled = !steerSendingEnabled()
  $('opt-steer-send').addEventListener('change', event => {
    LS.set('steerSendingEnabled', event.target.checked ? '1' : '0')
    $('busy-send-mode').disabled = !event.target.checked
    renderComposerSend()
  })
  $('busy-send-mode').addEventListener('change', event => {
    LS.set('busySendMode', event.target.value === 'steer' ? 'steer' : 'queue')
    renderComposerSend()
  })
  $('mobile-enter-action').addEventListener('change', (e) => {
    const action = e.target.value === 'send' ? 'send' : 'newline'
    LS.set('mobileEnterAction', action)
    toast(t(action === 'send' ? 'settings.mobileEnterSend' : 'settings.mobileEnterNewline'), 'ok')
  })
  $('opt-notify').checked = LS.get('notify', '0') === '1'
  window.NativeBackground?.setPendingNotificationsEnabled?.($('opt-notify').checked)
  $('opt-notify').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const ok = await ensureNotify()
      if (!ok) { e.target.checked = false; return toast(t('settings.notifyDenied')) }
    }
    LS.set('notify', e.target.checked ? '1' : '0')
    window.NativeBackground?.setPendingNotificationsEnabled?.(e.target.checked)
  })
  $('btn-test-notify').addEventListener('click', sendTestNotification)
  $('btn-announcement-history').addEventListener('click', openAnnouncementHistory)
  // 启动时清理旧版 LocalNotifications 和前台提醒服务，提醒交给 dsh-cost-meter。
  restorePeakReminders()
  $('opt-peak-remind').addEventListener('change', async event => {
    const input = event.target
    if (input.checked) {
      if (!CAP?.isNativePlatform?.() || !bgBridge()?.savePeakReminderConfig) { input.checked = false; return toast(t('peakRemind.browserOnly'), 'err') }
      if (!state.token) { input.checked = false; return toast(t('settings.bgNeedToken'), 'err') }
      if (!await ensureNotify()) { input.checked = false; return toast(t('settings.notifyDenied'), 'err') }
    }
    LS.set('peakRemind', input.checked ? '1' : '0')
    await syncPeakReminders()
  })
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
      const saved = saveBgConfig(true)
      applyBgConfigFromNative()
      toast(saved ? t('settings.bgOn') : (I18N.lang === 'en' ? 'Could not start background receiver. Check system restrictions.' : '后台接收启动失败，请检查系统限制后重试。'), saved ? 'ok' : 'err')
    } else {
      saveBgConfig(false)
      toast(t('settings.bgOff'), 'ok')
    }
  })
  $('bg-interval').addEventListener('change', () => {
    if ($('opt-bg-poll')?.checked) saveBgConfig(true)
  })
  $('opt-task-done')?.addEventListener('change', async event => {
    if (event.target.checked && !await ensureNotify()) { event.target.checked = false; toast(t('settings.notifyDenied'), 'err') }
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
  window.DshImagePreview?.configure?.({ resolvePath: chatImageRequest, resolveAttachment: chatImageAttachment, capture: captureChatImage })

  for (const id of ['history', 'question-body']) window.DshChatFiles?.bind($(id), () => {
    const c=captureConnection(),sessionId=id==='history'?state.current:state.questionModal?.sessionId
    return { ...c,sessionId,cwd:sessionCwd(state.byId.get(sessionId)),native:!!CAP?.isNativePlatform?.(),headers:{authorization:'Bearer '+c.token,...clientIdHeaders()},notice:toast,preview:(path,name)=>window.DshWorkflow?.preview({...c,headers:{authorization:'Bearer '+c.token}},path,name),
      valid:()=>c.valid()&&sessionId===(id==='history'?state.current:state.questionModal?.sessionId) }
  })
  initCustomSelects()

  $('btn-history-latest').addEventListener('click',()=>{getConversationView().latest();if(state.history.tailEvicted)void loadHistory(true)})
  $('history').addEventListener('load',()=>updateRail(true),true)
}

/* App 内真实系统栏 inset(刘海/状态栏/手势条) */
function applyNativeInsets() {
  try {
    const raw = window.NativeUpdate?.getInsets?.()
    if (!raw) return
    const ins = JSON.parse(raw)
    if (ins.mode === 'overlap') document.documentElement.dataset.nativeInsets = 'overlap'
    document.documentElement.style.setProperty('--native-top', (ins.top || 0) + 'px')
    document.documentElement.style.setProperty('--native-bottom', (ins.bottom || 0) + 'px')
  } catch {}
}

window.addEventListener('dsh-native-insets', applyNativeInsets)

async function boot() {
  initToken()
  bindUi()
  syncBgConfig()
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
    overviewStarting=false
    $('token-desc').textContent = t('token.notSetHint')
  } else {
    // 多服务器: 启动时静默测速一次, 选最快的连接(同源页面也参与比较)
    if (!doctorSessionHandoff) await selectFastestServer({ silent: true, reconnect: false })
    await maybeWarnAppBehindGateway({ probe: true })
    overviewStarting=false
    openStreams()
    await Promise.all([refreshAll(),refreshHostDescription()])
    loadDshControl()
  }
  // 网关从中央 HTTPS 公告源读取并在不可达时回退内置文件。前台每 30 秒检查，
  // 回到前台或网络恢复时立即补查；公告优先，避免启动时两个弹窗重叠。
  startAnnouncementPolling()
  scheduleStartupNotices()
  renderPending()
  pendingNavigationReady = true
  void openPendingNavigation()
}

document.addEventListener('DOMContentLoaded', boot)
document.addEventListener('DOMContentLoaded', mountWorkflow)

function mountWorkflow() {
  window.DshWorkflow?.mount({
    desktop: false,
    start: () => { if (!$('view-activity').classList.contains('hidden')) showView('view-home') },
    snapshot: () => ({ token: !!state.token, host: currentServerEntry()?.note || state.server || location.host,
      gateway: activeGatewayHealth()?.ok || !!state.streamsOk?.mux, dsh: dshReachable(),
      mux: !!state.streamsOk?.mux, hostEvents: !!state.streamsOk?.host,
      pending: state.approvals.length + state.questions.length, busy: composerIsBusy(), sending: composerSending }),
    settings: name => { showView('view-settings'); showSettingsPage(name) },
    plugins: () => showView('view-plugins'), models: loadSessionModels, send: sendMessage,
    feedback: openFeedbackModal,
    browse: () => { closeNewSessionModal(); showView('view-files') },
    register: async () => {
      const connection=captureConnection(), path=state.fs.path
      if(!path)return toast('请先选择主机目录','err')
      try {
        const value=await rpc('workspace.create',{path})
        if(!connection.valid()||!value?.workspace)return
        state.wbProjects=[...state.wbProjects.filter(w=>w.workspaceId!==value.workspace.workspaceId),value.workspace]
        state.workspaceFilter=value.workspace.workspaceId;closeWorkspaceModal();await newSession()
      }catch(error){if(connection.valid())toast(error.message,'err')}
    },
    command: runSlashCommand, refresh: refreshAll, retry: () => { startOverviewDetection(true); void refreshAll() },
    operations: () => { const connection=captureConnection(); return { url:apiUrl,headers:{authorization:'Bearer '+connection.token},valid:connection.valid } },
    relay: () => { const connection=captureConnection(); return { url:()=>adminApiUrl('/admin/api/relay'),headers:{authorization:'Bearer '+connection.token},valid:connection.valid,connected:!!connection.token } },
    discover: () => { if (confirm('登记当前绑定目录下的子目录为工作区？')) void refreshWorkbench({ discover: true }) },
    files: () => {
      const workspace = workspaceForSession(state.byId.get(state.current))
      if (workspace) return openWorkspaceFiles(workspace.workspaceId)
      const cwd = sessionCwd(state.byId.get(state.current))
      if (!cwd) return toast('当前会话没有工作目录', 'err')
      state.fs.loaded = true; showView('view-files'); void loadFs(cwd, { resetRoot: true })
    },
    approvalRecords: renderApprovalRecords,
    clearApprovalRecords: resetApprovalRecords,
    clear: clearWorkflowData,
    admin: () => {
      const url = new URL(adminApiUrl('/admin/'), location.href)
      // Open authenticated management through its own login flow. No credential
      // in a newly created URL, browser history, or referrer.
      window.open(url.href, '_blank', 'noopener,noreferrer')
    },
    recover: (row, receipt) => {
      const value = receipt.result?.result?.value
      if (row.method === 'session.create' && value?.sessionId) void openSession(value.sessionId)
      if (row.sessionId === state.current) void resyncCurrentSession()
    },
  })
  mountOnboarding()
}

function mountOnboarding() {
  window.DshOnboarding?.mount({
    snapshot: () => ({ connection: connectionGeneration, session: state.current,
      connected: navigator.onLine !== false && !!state.token && dshReachable()
        && (!!state.streamsOk?.mux || (state.streamMode === 'poll' && !!state.hostInfo)),
      sessionReady: state.sessionRecovery.status === 'ready' && !state.history.loading }),
    actions: {
      connect: () => { showView('view-settings'); showSettingsPage('servers') },
      session: () => { showView('view-home'); return newSession() },
      message: () => { if (state.current) showView('view-session'); else { showView('view-home'); return newSession() } },
      results: () => window.DshWorkflow?.showOperations(),
      files: () => showView('view-files'),
      branch: () => { if (state.current) showView('view-session'); else showView('view-home') },
      doctor: openDoctor,
      feedback: () => openFeedbackModal({ preserveDraft: true }),
    },
    example: value => {
      const input = $('composer-input')
      if (!state.current || input.value.trim()) return false
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      showView('view-session'); input.focus()
      return true
    },
    closePractice: () => {
      closeNewSessionModal(); closeFeedbackModal(); window.DshWorkflow?.close()
    },
  })
}

async function clearWorkflowData(kind) {
  const english = window.I18N?.lang === 'en'
  const messages = { history: english ? 'Clear cached conversation history on this device?' : '清除这台设备的会话历史缓存？主机记录保留。',
    images: english ? 'Clear cached images on this device? Images will download again when viewed.' : '清除本机图片缓存？再次查看时会重新下载。',
    caches: english ? 'Clear history and image caches? Connections and preferences will be kept.' : '清除本机历史和图片缓存？保留连接、凭证与偏好设置。',
    connection: english ? 'Remove this connection, credential and its caches? Other connections will be kept.' : '移除当前地址、保存的凭证及其缓存？其他连接条目保留。',
    all: english ? 'Clear all Remote settings and credentials on this device and stop background reminders?' : '清除本机全部 Remote 配置与凭证，并停止后台轮询和提醒？主机数据保留。' }
  if (!confirm(messages[kind])) return
  if (['history','images','caches'].includes(kind)) {
    clearTimeout(scheduleHistoryCacheSave._t)
    if(kind!=='images')cancelHistoryLoad()
    const results=[]
    if(kind!=='images')results.push(await window.DshHistory.cacheClear())
    if(kind!=='history')results.push(await window.DshImageCache.clear())
    if(results.includes(false))return toast(english?'Some caches could not be cleared. Retry shortly.':'部分缓存未能清除，请稍后重试。','err')
    return toast(english ? 'Cache cleared' : '缓存已清除', 'ok')
  }
  window.NativeBackground?.saveBackgroundConfig?.(JSON.stringify({ enabled:false, base:'', token:'', clientId:'', intervalMin:1, notifyTaskDone:false }))
  window.NativeBackground?.savePeakReminderConfig?.(JSON.stringify({ enabled:false }))
  window.NativeBackground?.setPendingNotificationsEnabled?.(false)
  if (kind === 'connection') {
    const connection=captureConnection(),scope=historyCacheScope()
    cancelHistoryLoad()
    await window.DshImageCache.clear(scope)
    await window.DshHistory.cacheClear(scope)
    if(!connection.valid())return
    const current = currentServerEntry()
    if (current) state.servers = state.servers.filter(server => server.id !== current.id)
    state.groupActive[state.activeGroup] = ''
    state.token = ''; state.server = ''; LS.del('token'); LS.del('server'); saveServers()
    closeStream('mux'); closeStream('host'); stopPolling(); renderServers(); showView('view-settings'); showSettingsPage('servers')
    return
  }
  await cancelPeakReminders()
  cancelHistoryLoad()
  clearTimeout(scheduleHistoryCacheSave._t)
  await window.DshHistory.cacheClear()
  await window.DshImageCache.clear()
  resetAnnouncementStorage()
  window.DshWorkflow.clearStorage()
  location.reload()
}

function openPluginPage(route = 'manage') {
  const connection = captureConnection()
  if (!connection.token) {
    $('plugin-page').textContent = '请先在设置中连接 DSH 主机。'
    return
  }
  window.DshExtensions.mount({
    connection,getWorkspaces: () => workspaceItems(),
    getWorkspaceId: () => workspaceById(state.workspaceFilter)?.workspaceId || workspaceForSession(state.byId.get(state.current))?.workspaceId || '',
    openTeamCaptain: async id => { if (!connection.valid()) return; await openSession(id) },
    openTaskSession: async (id, workspaceId) => {
      if (!connection.valid() || $('view-plugins').classList.contains('hidden')) return
      if (!workspaceItems().some(row => row.workspaceId === workspaceId)) throw Error('unavailable')
      await openSession(id)
    },
    openTeamMember: async (id, parentId) => {
      const selected = state.current
      const catalog = await loadSessionSubagents(parentId)
      if (!connection.valid() || $('view-plugins').classList.contains('hidden') || state.current !== selected) return
      const entry = catalog?.entries?.find(row => row.id === id)
      if (!entry || entry.kind === 'diagnostic') throw Error('unavailable')
      rememberSubagent(entry, parentId)
      await openSession(id)
    },
     getSession: () => state.byId.get(state.current), getTitle: () => sessionTitleValue(state.byId.get(state.current)),
    back: () => showView('view-settings'),
    openContext: () => void openInsights('context', true),
    returnToSession: () => showView('view-session'), scrollTop: () => window.scrollTo(0,0),
    url: path => connection.server + path,
    headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() },
    valid: connection.valid,
  }, $('plugin-page'), route)
}

// Operation logs stay on this device; users can copy or export them.
globalThis.DshDiagnostics?.configure({surface:"mobile",copy:copyText,snapshot:()=>({sessionId:state.current,server:state.server,loading:!!state.history.loading,loaded:!!state.history.loaded,count:state.history.visible.length,...globalThis.DshDiagnostics.nativeSnapshot()})})
globalThis.DshFileInbox?.mount({ capture: captureConnection, url: apiUrl,
  context: () => ({ sessionId: state.current, inChat: !$('view-session').classList.contains('hidden') }),
  sessionTitle: id => sessionTitleValue(state.byId.get(id)), openFiles: () => showView('view-files'),
  headers: connection => ({ authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web', ...clientIdHeaders() }),
  native: () => CAP?.isNativePlatform?.() ? window.NativeFile : null })
globalThis.DshSessionDeck?.mount({ context: () => ({ sessionId: state.current, inChat: !$('view-session').classList.contains('hidden') }) })
