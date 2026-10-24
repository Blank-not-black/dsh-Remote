/* DSH Remote 桌面端 WebUI · 零依赖 · 只引用 --dsr-* 皮肤变量 */
'use strict'

const I18N = window.I18N
const t = (k, v) => I18N.t(k, v)
I18N.init(window.DESKTOP_STR)

const $ = (id) => document.getElementById(id)
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
let doctorSessionHandoff = false
function clientIdHeaders() { return CLIENT_ID ? { 'x-dsh-remote-client-id': CLIENT_ID } : {} }
const CAP = window.Capacitor || null

/* ---------------- 皮肤 ---------------- */
const THEME_META = [
  { id: 'default', sw: ['#0D1117', '#21262D', '#58A6FF'] },
  { id: 'dark', sw: ['#161316', '#302323', '#FFB86B'] },
  { id: 'light', sw: ['#F5F7F8', '#FFFFFF', '#176B87'] },
  { id: 'neutral', sw: ['#EEF1E8', '#FAFBF6', '#47643C'] },
  { id: 'mono', sw: ['#050505', '#333333', '#F5F5F5'] },
  { id: 'fish', sw: ['#EAF6FF', '#FFFFFF', '#2F52D0'] }
]
function themeGet() {
  const v = LS.get('dshTheme', '')
  return THEME_META.some(m => m.id === v) ? v : 'fish'
}
function themeApply() {
  const v = themeGet()
  document.documentElement.setAttribute('data-theme', v)
  const meta = THEME_META.find(m => m.id === v) || THEME_META[0]
  const btn = $('btn-theme')
  if (btn) btn.textContent = t('ds.theme.' + meta.id)
  return meta.id || 'default'
}
function themeSet(id) { LS.set('dshTheme', id); themeApply() }
themeApply()

/* ---------------- 状态 ---------------- */
function emptyDesktopHistory() {
  return { seqs: new Set(), visible: [], hasMore: false, loading: false, minSeq: Infinity, partialReasoning: new Map(), loaded:false, cached:false, tailEvicted:false }
}
const state = {
  token: LS.get('token', ''),
  wsTicket: { token: '', server: '', value: '', expiresAt: 0 },
  server: '',
  servers: [], // { id, url, note, group, token }; connection identity = URL + token
  groups: ['默认'],
  activeGroup: '默认',
  autoSelect: { '默认': true },
  groupActive: { '默认': '' },
  serverLatency: {}, // URL + token -> latest /health latency
  gatewayHealth: {},
  selectingServer: false,
  sessions: [],
  sessionSort: LS.get('sessionSort', 'time') === 'workspace' ? 'workspace' : 'time',
  byId: new Map(),
  current: null,
  sessionRecovery: { status: 'idle', error: '' },
  pendingProjections: new Map(),
  lastStreamResyncAt: 0,
  hostInfo: null,
  history: emptyDesktopHistory(),
  approvals: [],
  approvalRecords: new Map(),
  approvalRecordsServer: null,
  questions: [],
  queues: {},
  sessionActivity: new Set(),
  queueSteering: {},
  compactionBootAt: Date.now(),
  compactions: {},
  pendingCommands: {},
  compactionPollTimer: null,
  compactionClockTimer: null,
  sessionTurnTimes: {},
  questionModal: null,
  streamsOk: { mux: false, host: false },
  errCount: 0,
  streamInfo: {
    mux: { status: 'idle', lastOpenAt: 0, lastCloseAt: 0, lastCloseCode: 0, lastCloseReason: '' },
    host: { status: 'idle', lastOpenAt: 0, lastCloseAt: 0, lastCloseCode: 0, lastCloseReason: '' },
  },
  streamMode: 'ws', // 'ws' | 'poll'
  pollSeq: { mux: 0, host: 0 },
  fs: { path: null, initial: null, loaded: false, roots: [], rootIndex: 0 },
  models: { loaded: false, loading: false, groups: [], current: null, failures: [] },
  workspaces: [],
  wb: { bound: false, path: '', title: '', expanded: false, projects: null, open: null, apiMissing: false },
  archivedIds: [],
  view: 'sessions',
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
      clearTimeout(state.refreshTimer); state.refreshTimer = null
      state.sessions = []; state.byId.clear(); state.pendingProjections.clear(); state.runtimeErrors = new Map()
      state.hostInfo = null
      if(typeof closeStream==='function'&&typeof streamMeta!=='undefined'){closeStream('mux');closeStream('host')}
      state.current = null; state.history = emptyDesktopHistory(); state.subagentSessions = {}; window.DshSubagents?.reset()
      state.models = { loaded: false, loading: false, groups: [], current: null, failures: [] }
      state.approvals = []; state.questions = []; state.questionModal = null
      state.queues = {}; state.queueSteering = {}; state.compactions = {}; state.compactionTerminals = {}; state.compactionSeqs = {}; state.compactionBootAt = Date.now(); state.pendingCommands = {}; state.sessionTurnTimes = {}
      state.sessionActivity = new Set()
      state.fs.path = null; state.fs.initial = null; state.fs.loaded = false; state.fs.roots = []; state.fs.rootIndex = 0
      state.workspaces = []; state.archivedIds = []; state.wb = { bound: false, path: '', projects: null }
      window.DshPluginCenter?.close()
      window.DshInsights?.close()
      window.DshExtensions?.close()
      window.DshExtensions?.invalidateCapabilities()
      if (typeof document !== 'undefined') document.getElementById('btn-insights')?.classList.add('hidden')
      if(typeof document!=='undefined') {
        const identityGeneration=connectionGeneration
        queueMicrotask(()=>{if(identityGeneration===connectionGeneration&&typeof startOverviewDetection==='function')startOverviewDetection(true,true)})
        document.getElementById('history')?.replaceChildren?.()
        const generation=connectionGeneration
        queueMicrotask(()=>{if(generation!==connectionGeneration)return;if(typeof conversationView!=='undefined')conversationView?.reset();if(!state.current&&state.view==='view-chat')showView('view-sessions');restoreCachedSessionList()})
      }
      if (typeof document !== 'undefined') {
        for (const id of ['modal-workspace', 'modal-workbench', 'modal-question', 'modal-new-session', 'modal-rename']) document.getElementById(id)?.classList.add('hidden')
        if (typeof renderNotifStack === 'function') renderNotifStack()
      }
    },
  })
}
function captureConnection() {
  const generation = connectionGeneration, server = state.server, token = state.token
  return { server, token, valid: () => generation === connectionGeneration && server === state.server && token === state.token }
}

const streams = {}
let pollTimer = null
let wsRetryTimer = null
let connTickTimer = null
let reconnectInfo = null

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
function short(id) { return '…' + String(id).slice(-8) }
function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtTokens(n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K'
  return String(Math.round(n))
}
function fmtCost(n) { return '¥' + (Number(n) || 0).toFixed(2) }
function fmtSize(n) {
  n = Number(n) || 0
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB'
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}
function toast(text, kind = '') {
  const el = $('toast')
  el.textContent = text
  el.className = 'ds-toast ' + kind
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600)
}

/* ---------------- 预设提示词 ---------------- */
const PRESETS_KEY = 'dshPromptPresets'
function readPresets() {
  try {
    const v = JSON.parse(LS.get(PRESETS_KEY, '[]') || '[]')
    return Array.isArray(v) ? v.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.text === 'string') : []
  } catch { return [] }
}
function renderPresetMenuDesktop() {
  const btn = $('btn-preset')
  const menu = $('preset-menu')
  if (!btn || !menu) return
  const list = readPresets()
  btn.style.display = ''
  menu.classList.add('hidden')
  if (!list.length) {
    menu.innerHTML = `<div class="ds-empty">${esc(t('ds.presetsEmpty'))}</div><div class="ds-empty ds-presets-guide">${esc(t('ds.presetsGuide'))}</div>`
    return
  }
  menu.innerHTML = list.map(p => `<button class="ds-feedback-item" data-ds-preset="${esc(p.id)}">${esc(p.name)}</button>`).join('')
}
const PRESET_NAME_MAX = 20
const PRESET_TEXT_MAX = 2000
const PRESET_LIMIT = 20
function renderPresetSummary() {
  const home = $('preset-count-home')
  const modal = $('preset-count')
  const n = readPresets().length
  if (home) home.textContent = `· ${n}/${PRESET_LIMIT}`
  if (modal) modal.textContent = `${n}/${PRESET_LIMIT}`
}
function writePresets(list) {
  LS.set(PRESETS_KEY, JSON.stringify(list))
  renderPresetSummary()
  renderPresets()
  renderPresetMenuDesktop()
}
function renderPresets() {
  const box = $('preset-list')
  if (!box) return
  const list = readPresets()
  renderPresetSummary()
  if (!list.length) {
    box.innerHTML = `<div class="ds-preset-empty">${esc(t('presets.empty'))}</div>`
    return
  }
  box.innerHTML = list.map(p => `<div class="ds-preset-row">
    <div class="ds-preset-main"><div class="ds-preset-name">${esc(p.name)}</div><div class="ds-preset-preview">${esc((p.text || '').slice(0, 60))}</div></div>
    <button class="ds-mini-btn" data-preset-edit="${esc(p.id)}">${t('presets.edit')}</button>
    <button class="ds-mini-btn" data-preset-del="${esc(p.id)}">${t('presets.delete')}</button>
  </div>`).join('')
  box.querySelectorAll('[data-preset-edit]').forEach(b => b.addEventListener('click', () => editPreset(b.dataset.presetEdit)))
  box.querySelectorAll('[data-preset-del]').forEach(b => b.addEventListener('click', () => deletePreset(b.dataset.presetDel)))
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
function openPresetModal() {
  renderPresets()
  const modal = $('modal-presets')
  if (modal) modal.classList.remove('hidden')
}
function closePresetModal() {
  const modal = $('modal-presets')
  if (modal) modal.classList.add('hidden')
}
function togglePresetMenuDesktop() {
  const menu = $('preset-menu')
  if (!menu) return
  menu.classList.toggle('hidden')
}
function toggleCmdMenuDesktop() {
  const menu = $('cmd-menu')
  if (!menu) return
  const willOpen = menu.classList.contains('hidden')
  if (willOpen) void refreshPermissionPresetsDesktop()
  menu.classList.toggle('hidden', !willOpen)
}

/* 主机权限模式（沙箱+审批捆绑）目录；直接列在“指令”菜单里，旧主机回退三种沙箱模式。 */
function currentPermissionPreset() {
  const perms = state.current ? proj(state.byId.get(state.current), 'permissions') : null
  return typeof perms?.currentValue === 'string' ? perms.currentValue : ''
}
let permissionPresetRequest = 0
function refreshPermissionPresetsDesktop() {
  const box = $('cmd-perm-inline')
  if (!box || !window.DshPermissionPresets) return
  const request = ++permissionPresetRequest
  const sessionId = state.current
  const permissionConnection = captureConnection()
  return window.DshPermissionPresets.open({
    container: box,
    current: currentPermissionPreset(),
    connection: permissionConnection,
    currentValid: () => permissionConnection.valid() && state.current === sessionId && request === permissionPresetRequest,
    rpc,
    t,
    toast,
    request: async value => {
      if (!permissionConnection.valid() || !sessionId || state.current !== sessionId || request !== permissionPresetRequest) return false
      return runSlashCommand('/permission ' + value, true)
    },
    close: () => { $('cmd-menu')?.classList.add('hidden') },
  })
}

/* ---------------- 模型 / 思考深度 ---------------- */
function toggleModelMenuDesktop() {
  const menu = $('model-menu')
  if (!menu) return
  const willOpen = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !willOpen)
  if (willOpen && !state.models.loaded && !state.models.loading) loadSessionModels()
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
    if (e.message === 'AUTH') { toast(t('ds.toastAuth'), 'err'); state.models.loading = false; renderModelMenu(); return }
    toast(t('models.loadFailed', { msg: e.message }), 'err')
  }
  state.models.loading = false
  renderModelMenu()
}

function renderModelMenu() {
  const box = $('model-menu')
  if (!box) return
  if (state.models.loading) { box.innerHTML = `<div class="ds-model-head">${t('menu.modelTitle')}</div><span>${t('models.loading')}</span>`; return }
  const groups = state.models.groups || []
  if (!groups.length) {
    box.innerHTML = `<div class="ds-model-head">${t('menu.modelTitle')}</div><span>${(state.models.failures || []).map(f => esc(f.name) + ' ' + t('models.unavailable')).join('；') || t('models.none')}</span>`
    return
  }
  const cur = state.models.current
  box.innerHTML = `<div class="ds-model-head">${t('menu.modelTitle')}</div>` + groups.map(g => `
    <div class="ds-model-group">
      <div class="ds-model-provider">${esc(g.name || g.id)}</div>
      <div class="ds-model-chips">${(g.models || []).map(m => {
        const isCur = cur && cur.provider === g.id && cur.model === m.id
        return `<button class="ds-model-chip ${isCur ? 'current' : ''}" data-model="${esc(m.id)}" data-provider="${esc(g.id)}">${esc(m.name || m.id)}</button>`
      }).join('')}</div>
    </div>`).join('') + `<div class="ds-model-effort-group" id="model-effort-group"><div class="ds-model-provider">${t('menu.effortTitle')}</div><div class="ds-model-chips" id="model-efforts"></div></div>`
  box.querySelectorAll('[data-model]').forEach(btn =>
    btn.addEventListener('click', () => selectSessionModel(btn.dataset.provider, btn.dataset.model)))
  renderEffortMenu()
}

function renderEffortMenu() {
  const group = $('model-effort-group')
  const box = $('model-efforts')
  if (!group || !box) return
  const cur = state.models.current
  const provider = (state.models.groups || []).find(g => g.id === cur?.provider)
  const model = (provider?.models || []).find(m => m.id === cur?.model)
  const { efforts, defaultEffort, custom } = reasoningEffortOptions(model)
  group.classList.toggle('hidden', !cur || !efforts.length)
  box.innerHTML = efforts.map(e => {
    const isCur = cur?.reasoningEffort === e.id || (!cur?.reasoningEffort && e.id === defaultEffort)
    return `<button class="ds-model-chip ${isCur ? 'current' : ''}" data-effort="${esc(e.id)}" title="${esc(e.description || '')}">${esc(e.name || e.id)}</button>`
  }).join('') + (custom ? `<span class="ds-effort-hint">${esc(t('models.effortCustomHint'))}</span>` : '')
  box.querySelectorAll('[data-effort]').forEach(btn =>
    btn.addEventListener('click', () => selectSessionEffort(btn.dataset.effort)))
}

function reasoningEffortOptions(model) {
  const raw = Array.isArray(model?.reasoning?.efforts) && model.reasoning.efforts.length
    ? model.reasoning.efforts
    : (Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length ? model.reasoningEfforts : null)
  const names = { low: t('models.effortLow'), high: t('models.effortHigh'), max: t('models.effortMax'), off: t('models.effortOff') }
  if (raw) {
    return {
      efforts: raw.map(e => typeof e === 'string' ? { id: e, name: names[e] || e } : e),
      defaultEffort: model?.reasoning?.defaultEffort,
      custom: !model?.reasoning?.efforts
    }
  }
  return { efforts: ['low', 'high', 'max'].map(id => ({ id, name: names[id] })), defaultEffort: undefined, custom: true }
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
function openFeedbackMenu() {
  $('feedback-menu').classList.remove('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'true')
  const first = $('feedback-menu').querySelector('[role="menuitem"]')
  if (first) first.focus()
}
function closeFeedbackMenu() {
  $('feedback-menu').classList.add('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'false')
}
function toggleFeedbackMenu() {
  $('feedback-menu').classList.contains('hidden') ? openFeedbackMenu() : closeFeedbackMenu()
}
function doctorEnvironment() {
  let report = {}
  try { report = globalThis.DshDiagnostics?.report?.() || {} } catch {}
  const health = activeGatewayHealth()
  let online = false
  try { online = navigator.onLine !== false } catch {}
  return {
    surface: 'Desktop web',
    appVersion: report.client?.version || '',
    gatewayVersion: health?.version || '',
    gatewayOk: health?.ok === true,
    gatewayReachable: health?.upstreamReachable,
    dshVersion: state.hostInfo?.version || '',
    host: currentServerEntry()?.note || state.server || location.host,
    mux: state.streamsOk?.mux ? 'connected' : state.streamMode || 'unknown',
    hostEvents: state.streamsOk?.host ? 'connected' : state.streamMode || 'unknown',
    online,
  }
}
function openDoctor() {
  closeFeedbackMenu()
  if (!window.DshDoctor) {
    toast(t('ds.feedbackSubmitFailed', { msg: 'doctor unavailable' }), 'err')
    return
  }
  const session = state.byId.get(state.current)
  const cwd = sessionCwd(session)
  const workspace = workspaceItems().find(item => item.path === cwd)
  const connection=captureConnection(), accessToken=state.token
  window.DshDoctor.open({
    connection,
    loadTarget:()=>window.DshDoctorEntry.loadTarget({url:apiUrl,headers:{authorization:'Bearer '+accessToken},connection}),
    surface: 'desktop',
    rpc: (method, payload) => rpc(method, payload),
    openSession: async id => { await openSession(id); return connection.valid() && state.current===id && !$('view-chat').classList.contains('hidden') },
    workspaceId: workspace?.workspaceId || '',
    cwd: cwd || '',
    environment: doctorEnvironment,
    diagnostics: () => globalThis.DshDiagnostics?.report?.(),
    exportDiagnostics: () => globalThis.DshDiagnostics?.download?.(),
    copy: copyText,
    toast,
  })
}
function openFeedbackModal() {
  document.querySelectorAll('#fb-chips .ds-fb-chip').forEach(b => b.classList.toggle('current', b.dataset.fbType === 'bug'))
  $('fb-msg').value = ''
  $('fb-contact').value = ''
  $('fb-include-diagnostics').checked = false
  $('fb-include-crashes').checked = false
  $('fb-crash-details').open = false
  void loadCrashPreview()
  $('modal-feedback').classList.remove('hidden')
  setTimeout(() => $('fb-msg').focus(), 50)
}
function closeFeedbackModal() { $('modal-feedback').classList.add('hidden') }
function openDonateModal() {
  const m = $('modal-donate')
  if (m) m.classList.remove('hidden')
}
/* ---------------- 更新内容弹窗 ---------------- */
const NOTES_KEY = 'seenNotesVersion'
let notesVersion = ''
let notesPages = []
let notesPage = 0
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
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const sa = String(pa.pre).split('.'), sb = String(pb.pre).split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i] ?? '', y = sb[i] ?? ''
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d }
    else if (nx !== ny) return nx ? -1 : 1
    else { const d = x.localeCompare(y); if (d) return d }
  }
  return 0
}
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
  pageEl.textContent = t('ds.notesPage', { current: idx + 1, total })
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
    const seen = LS.get(NOTES_KEY, '')
    let entries
    if (seen) entries = history.filter(h => cmpVersion(h.version, seen) > 0)
    else entries = history.slice(0, 3)
    if (!entries.length) return
    notesVersion = latestStable
    const vEl = $('notes-version')
    if (vEl) vEl.textContent = 'v' + latestStable
    renderNotesVersionPages(entries.slice().reverse())
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
async function checkNotesOnStart() {
  if (typeof window !== 'undefined' && window.DshWorkflow?.isMounted()) return
  try {
    const res = await fetch('../update.json?t=' + Date.now(), { cache: 'no-store' })
    if (!res.ok || res.redirected || !String(res.headers.get('content-type') || '').includes('application/json')) return
    const info = await res.json()
    if (!info || typeof info !== 'object' || !info.version) return
    if (typeof window !== 'undefined' && window.DshWorkflow?.isMounted()) return
    openNotesModal(info)
  } catch {}
}
async function loadCrashPreview() {
  const connection=captureConnection(),preview=$('fb-crash-preview')
  preview.textContent=t('ds.feedbackCrashLoading')
  try {
    const response=await fetch(apiUrl('/crash-logs'),{headers:{authorization:'Bearer '+connection.token},signal:AbortSignal.timeout(5000),cache:'no-store'})
    if(!response.ok)throw new Error('unavailable')
    const data=await response.json()
    if(connection.valid())preview.textContent=JSON.stringify(data.upload,null,2)
  }catch{if(connection.valid())preview.textContent=t('ds.feedbackCrashUnavailable')}
}
async function submitFeedback() {
  const type = document.querySelector('#fb-chips .ds-fb-chip.current')?.dataset.fbType || 'bug'
  const message = $('fb-msg').value.trim()
  const contact = $('fb-contact').value.trim()
  const includeDiagnostics = $('fb-include-diagnostics').checked
  const includeCrashLogs = $('fb-include-crashes').checked
  if (!message) { toast(t('ds.feedbackEmpty'), 'err'); return }
  if (message.length > 2000) { toast(t('ds.feedbackTooLong'), 'err'); return }
  const btn = $('fb-submit')
  btn.disabled = true
  const diagnostic=globalThis.DshDiagnostics?.start('feedback.submit')
  try {
    const res = await fetch(apiUrl('/feedback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ type, message, contact, appVersion: '', includeDiagnostics, includeCrashLogs })
    })
    diagnostic?.end({phase:res.ok?'complete':'failed',httpStatus:res.status})
    let json = {}
    try { json = await res.json() } catch {}
    if (res.ok && json.ok) { toast(t('ds.feedbackSubmitted'), 'ok'); closeFeedbackModal() }
    else if (res.status === 429) { toast(t('ds.feedbackRateLimited'), 'err') }
    else { toast(t('ds.feedbackSubmitFailed', { msg: json.error || res.status }), 'err') }
  } catch(error) {
    diagnostic?.fail(error)
    toast(t('ds.feedbackSubmitFailed', { msg: t('ds.feedbackNetworkError') }), 'err')
  } finally {
    btn.disabled = false
  }
}
function showTip(text, anchorRect) {
  const tip = $('ds-tip')
  if (!tip) return
  tip.textContent = text
  tip.classList.remove('hidden')
  const margin = 8
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  let left = anchorRect.left + anchorRect.width / 2 - tw / 2
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin))
  let top = anchorRect.top - th - 10
  if (top < margin) top = anchorRect.bottom + 10
  tip.style.left = left + 'px'
  tip.style.top = top + 'px'
}
function hideTip() { const tip = $('ds-tip'); if (tip) tip.classList.add('hidden') }

/* ---------------- API ---------------- */
function apiUrl(path) { return (state.server || '') + path }
let wsTicketPromise = null
let wsTicketConnection = null
async function getWsTicket() {
  // Only share an in-flight request; never reuse a previous handshake ticket.
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
        headers: { authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() }
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
async function rpc(method, payload = {}, timeoutMs = 45000, cancellation = null) {
  const diagnostic=globalThis.DshDiagnostics?.start('rpc',{method,sessionId:payload.sessionId,server:state.server})
  try {
  const opts = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() },
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
  if (!full?.result) throw new Error('bad response')
  if (!full.result.ok) {
    const err = full.result.error || {}
    const error = new Error(err.code === 'session/migration-required' ? t('session.migrationRequired') : err.message || 'dsh error')
    error.code = err.code
    throw error
  }
  diagnostic?.end({phase:'complete'})
  return full.result.value
  } catch(error) { diagnostic?.fail(error);throw error }
}
async function respond(rpcId, value) {
  const opts = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() },
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
    if (e.message === 'AUTH') { toast(t('ds.toastAuth'), 'err'); return null }
    if (e.operationPending) { toast(e.message, 'err'); return null }
    toast(errText ? `${errText}：${e.message}` : e.message, 'err')
    return null
  }
}
let hostDescribePromise = null
let hostDescribeConnection = null
let hostDescribeRetryTimer = null
let hostDescribeFailures = 0

function scheduleHostDescribeRetryDesktop() {
  if (!state.token || hostDescribeRetryTimer) return
  const delays = [2000, 5000, 15000, 30000, 60000]
  const delay = delays[Math.min(Math.max(0, hostDescribeFailures - 1), delays.length - 1)]
  hostDescribeRetryTimer = setTimeout(() => {
    hostDescribeRetryTimer = null
    void refreshHostDescriptionDesktop()
  }, delay)
}

async function refreshHostDescriptionDesktop({ notify = false } = {}) {
  if (!state.token) return null
  if (hostDescribePromise && hostDescribeConnection?.valid()) return hostDescribePromise
  const connection = captureConnection()
  hostDescribeConnection = connection
  const job = (async () => {
    try {
      const host = await rpc('host.describe', {}, 5000)
      if (!connection.valid()) return null
      state.hostInfo = host
      hostDescribeFailures = 0
      if (hostDescribeRetryTimer) clearTimeout(hostDescribeRetryTimer)
      hostDescribeRetryTimer = null
      renderOverviewDesktop()
      return host
    } catch (error) {
      if (!connection.valid()) return null
      hostDescribeFailures++
      scheduleHostDescribeRetryDesktop()
      if (notify) toast(error.message === 'AUTH' ? t('ds.toastAuth') : error.message, 'err')
      return null
    } finally {
      if (hostDescribePromise === job) { hostDescribePromise = null; hostDescribeConnection = null }
    }
  })()
  hostDescribePromise = job
  return job
}
function uuid() {
  try { return crypto.randomUUID() } catch { return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2) }
}

/* ---------------- 多服务端分组管理（与 App 共用 servers-v2） ---------------- */
function newServerId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }
function ensureGroup(name) {
  if (!name) name = '默认'
  if (!state.groups.includes(name)) state.groups.push(name)
  if (!(name in state.autoSelect)) state.autoSelect[name] = true
  if (!(name in state.groupActive)) state.groupActive[name] = ''
  return name
}
function groupServers(g) { return state.servers.filter(s => s.group === g) }
function activeServers() { return groupServers(state.activeGroup) }
function normalizedServerToken(token) { return typeof token === 'string' ? token.trim() : '' }
function serverIdentity(url, token) {
  return `${String(url || '').replace(/\/+$/, '')}\u0000${normalizedServerToken(token)}`
}
function serverKey(server) { return serverIdentity(server?.url ?? server, server?.token) }
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

function migrateServersV1() {
  if (LS.get('servers-v2', null) !== null) return
  let arr = null
  try { arr = JSON.parse(LS.get('servers', '')) } catch {}
  if (!Array.isArray(arr)) {
    const legacy = LS.get('server', '')
    arr = legacy ? [legacy] : []
  }
  const urls = arr.map(s => String(s || '').trim().replace(/\/+$/, '')).filter(s => /^https?:\/\//i.test(s))
  state.servers = urls.map((url, i) => ({ id: 's' + (i + 1), url, note: '', group: '默认', token: normalizedServerToken(state.token) }))
  state.groups = ['默认']; state.activeGroup = '默认'
  state.autoSelect = { '默认': true }; state.groupActive = { '默认': '' }
  const active = LS.get('activeServer', '')
  if (active === 'origin') state.server = ''
  else {
    const hit = state.servers.find(s => s.url === active)
    state.server = hit ? hit.url : (state.servers[0]?.url || '')
    state.groupActive['默认'] = hit ? hit.id : (state.servers[0]?.id || '')
  }
  saveServers()
}
function loadServers() {
  let data = null
  try { data = JSON.parse(LS.get('servers-v2', '')) } catch {}
  if (!data || !Array.isArray(data.servers)) { migrateServersV1(); return }
  const legacyToken = normalizedServerToken(state.token || LS.get('token', ''))
  state.servers = data.servers.filter(s => s && typeof s.url === 'string').map(s => ({ id: s.id || newServerId(), url: s.url.replace(/\/+$/, ''), note: s.note || '', group: s.group || '默认', token: s.token == null ? legacyToken : normalizedServerToken(s.token) }))
  state.groups = Array.isArray(data.groups) && data.groups.length ? data.groups : ['默认']
  state.activeGroup = state.groups.includes(data.activeGroup) ? data.activeGroup : '默认'
  state.autoSelect = data.autoSelect || {}
  state.groupActive = data.groupActive || {}
  ensureGroup('默认')
  for (const s of state.servers) ensureGroup(s.group)
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
    servers: state.servers, groups: state.groups, activeGroup: state.activeGroup,
    autoSelect: state.autoSelect, groupActive: state.groupActive,
  }))
}
function serverCandidates() {
  const list = activeServers().map(s => ({ ...s, token: serverToken(s) }))
  if (location.origin && !list.some(s => s.url === location.origin)) list.push({ id: 'origin', url: location.origin, token: state.token, origin: true })
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
      renderOverviewDesktop()
    }
    return Math.round(performance.now() - t0)
  } catch { return Infinity } finally { clearTimeout(timer) }
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
    if (!silent) toast(t('ds.speedTesting'))
    const candidates = serverCandidates()
    let chosen = ''
    let chosenToken = state.token
    let best = null
    let ms = Infinity
    if (state.autoSelect[state.activeGroup] !== false) {
      const measured = await Promise.all(candidates.map(async (server) => [server, await pingServer(server.url)]))
      if (!valid()) return null
      for (const [server, latency] of measured) state.serverLatency[serverKey(server)] = latency
      best = candidates.filter(server => Number.isFinite(state.serverLatency[serverKey(server)])).sort((a, b) => state.serverLatency[serverKey(a)] - state.serverLatency[serverKey(b)])[0] || null
      const sameOrigin = best?.url === location.origin && best.origin
      chosen = best ? (sameOrigin ? '' : best.url) : (state.server || '')
      chosenToken = best ? serverToken(best) : state.token
      ms = best ? state.serverLatency[serverKey(best)] : Infinity
    } else {
      const manual = state.groupActive[state.activeGroup]
      const manualSrv = manual ? state.servers.find(s => s.id === manual) : null
      chosen = manualSrv ? manualSrv.url : (activeServers()[0]?.url || '')
      chosenToken = manualSrv ? serverToken(manualSrv) : state.token
      if (chosen) {
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
      resetFsForServerDesktop()
      state.server = chosen
      state.token = chosenToken
      LS.set('token', state.token)
      if (best) { const srv = state.servers.find(s => s.id === best.id); if (srv) state.groupActive[state.activeGroup] = srv.id }
      saveServers()
      renderServers()
      if (!silent) {
        if (chosen) toast(t('ds.speedSwitched', { url: chosen, ms: Number.isFinite(ms) ? ms : 0 }), 'ok')
      }
      if (reconnect && state.token) { openStreams(); refreshSessions() }
    } else if (!silent) {
      if (best) toast(t('ds.speedAlreadyBest', { url: chosen, ms: state.serverLatency[serverKey(best)] }), 'ok')
      else if (chosen) toast(t('ds.speedManualUsing', { url: chosen, ms: Number.isFinite(ms) ? ms : '—' }), 'ok')
      else toast(t('ds.speedAllDown'), 'err')
    }
    return chosen
  } finally { if (request === selectFastestServer.request) state.selectingServer = false }
}

function serverTitle(s) { return s.note || s.url }
function renderGroupSelect() {
  const label = $('group-select-label')
  const menu = $('group-select-menu')
  if (!label || !menu) return
  label.textContent = state.activeGroup
  $('group-select-btn')?.setAttribute('aria-label', t('ds.groupsCurrentLabel', { group: state.activeGroup }))
  menu.innerHTML = state.groups.map(g => `<button type="button" class="ds-group-option ${g === state.activeGroup ? 'current' : ''}" data-group-option="${esc(g)}">${esc(g)}${g === state.activeGroup ? ' ✓' : ''}</button>`).join('')
  menu.querySelectorAll('[data-group-option]').forEach(b => b.addEventListener('click', () => {
    closeGroupMenu()
    if (b.dataset.groupOption !== state.activeGroup) switchGroup(b.dataset.groupOption)
  }))
}
function toggleGroupMenu() { $('group-select-menu').classList.toggle('hidden') }
function closeGroupMenu() { $('group-select-menu').classList.add('hidden') }

let desktopGroupDrawerReturnFocus = null

function desktopGroupDrawerOpen() {
  return !$('ds-group-drawer')?.classList.contains('hidden')
}

function renderDesktopGroupDrawer() {
  const trigger = $('ds-group-drawer-trigger')
  const brandGroup = $('ds-brand-group-name')
  const current = $('ds-group-drawer-current')
  const list = $('ds-group-drawer-list')
  if (brandGroup) brandGroup.textContent = state.activeGroup
  if (trigger) trigger.setAttribute('aria-label', t('ds.groupsDrawerOpen') + '：' + state.activeGroup)
  if (current) current.textContent = state.activeGroup
  if (!list) return
  list.innerHTML = state.groups.map(group => {
    const servers = groupServers(group)
    const selected = group === state.activeGroup
    return `<button type="button" class="ds-group-drawer-option ${selected ? 'current' : ''}" data-ds-quick-group="${esc(group)}" ${selected ? 'aria-current="true"' : ''}>
      <span class="ds-group-drawer-mark" aria-hidden="true"></span>
      <span class="ds-group-drawer-copy"><span class="ds-group-drawer-name">${esc(group)}</span><span class="ds-group-drawer-meta">${t('ds.groupsServerCount', { count: servers.length })}</span></span>
      <span class="ds-group-drawer-check" aria-hidden="true">${selected ? '✓' : ''}</span>
    </button>`
  }).join('')
}

function openDesktopGroupDrawer() {
  const drawer = $('ds-group-drawer')
  const backdrop = $('ds-group-drawer-backdrop')
  const trigger = $('ds-group-drawer-trigger')
  if (!drawer || !backdrop || !trigger) return
  renderDesktopGroupDrawer()
  desktopGroupDrawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger
  drawer.classList.remove('hidden')
  backdrop.classList.remove('hidden')
  trigger.setAttribute('aria-expanded', 'true')
  requestAnimationFrame(() => (drawer.querySelector('[data-ds-quick-group].current') || drawer.querySelector('[data-ds-quick-group]') || drawer).focus({ preventScroll: true }))
}

function closeDesktopGroupDrawer({ restoreFocus = true } = {}) {
  const drawer = $('ds-group-drawer')
  const backdrop = $('ds-group-drawer-backdrop')
  const trigger = $('ds-group-drawer-trigger')
  if (!drawer || !backdrop || drawer.classList.contains('hidden')) return
  drawer.classList.add('hidden')
  backdrop.classList.add('hidden')
  trigger?.setAttribute('aria-expanded', 'false')
  if (restoreFocus) (desktopGroupDrawerReturnFocus || trigger)?.focus({ preventScroll: true })
  desktopGroupDrawerReturnFocus = null
}

function keepDesktopGroupDrawerFocus(event) {
  if (!desktopGroupDrawerOpen()) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDesktopGroupDrawer()
    return
  }
  if (event.key !== 'Tab') return
  const drawer = $('ds-group-drawer')
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
  renderDesktopGroupDrawer()
  box.innerHTML = state.groups.map(g => {
    const list = groupServers(g)
    const auto = state.autoSelect[g] !== false
    const activeManual = state.groupActive[g] || ''
    return `<div class="ds-srv-group" data-group="${esc(g)}">
      <div class="ds-srv-head">
        <button class="ds-srv-name" data-group-name="${esc(g)}" title="${t('ds.groupsSwitchHint')}"><span class="ds-srv-label">${g === state.activeGroup ? '▾' : '▸'} ${esc(g)}</span><span class="ds-srv-count">${list.length}</span></button>
        <button class="ds-mini" data-speed-group="${esc(g)}" title="${t('ds.speedTest')}">⚡</button>
        <label class="ds-switch" title="${t('ds.groupsAutoSelect')}"><input type="checkbox" data-auto-group="${esc(g)}" ${auto ? 'checked' : ''}><span class="ds-slider"></span></label>
        ${g !== '默认' ? `<button class="ds-mini" data-del-group="${esc(g)}" title="${t('ds.groupsDelete')}">✕</button>` : ''}
      </div>
      <div class="ds-srv-body ${g === state.activeGroup ? '' : 'hidden'}">
        ${list.map(s => {
          const ms = state.serverLatency[serverKey(s)]
          const active = s.url === state.server && serverToken(s) === state.token
          // One status per row keeps long addresses readable.
          let badge = `<span class="ds-server-badge">${t('ds.serversUntested')}</span>`
          if (!s.token) badge = `<span class="ds-server-badge bad">${t('ds.serversTokenMissing')}</span>`
          else if (Number.isFinite(ms)) badge = `<span class="ds-server-badge ${active ? 'good' : ''}">${ms}ms${active ? t('ds.serversCurrent') : ''}</span>`
          else if (ms !== undefined) badge = `<span class="ds-server-badge bad">${t('ds.serversUnreachable')}</span>`
          else if (active) badge = `<span class="ds-server-badge good">${t('ds.serversCurrentOnly')}</span>`
          const activeInGroup = auto ? active : s.id === activeManual
          return `<div class="ds-server-row ${activeInGroup ? 'active' : ''}" data-use-server="${esc(s.id)}">
            <span class="ds-server-main"><span class="ds-server-note" title="${esc(serverTitle(s))}">${esc(serverTitle(s))}</span>${s.note ? `<span class="ds-server-url">${esc(s.url)}</span>` : ''}</span>${badge}
            <button class="ds-mini ds-server-edit" data-edit-server="${esc(s.id)}" title="${t('ds.serversEdit')}" aria-label="${t('ds.serversEdit')}">✎</button>
            <button class="ds-mini ds-server-del" data-del-server="${esc(s.id)}" aria-label="${t('ds.serversDelete')}">✕</button>
          </div>`
        }).join('') || `<div class="ds-empty">${t('ds.groupsNoServer')}</div>`}
      </div>
    </div>`
  }).join('')
  box.querySelectorAll('[data-group-name]').forEach(b => {
    b.addEventListener('click', () => switchGroup(b.dataset.groupName))
    b.addEventListener('dblclick', () => renameGroup(b.dataset.groupName))
  })
  box.querySelectorAll('[data-speed-group]').forEach(b => b.addEventListener('click', () => { state.activeGroup = b.dataset.speedGroup; saveServers(); selectFastestServer({ silent: false }) }))
  box.querySelectorAll('[data-auto-group]').forEach(chk => chk.addEventListener('change', (e) => {
    const g = e.target.dataset.autoGroup
    state.autoSelect[g] = e.target.checked
    saveServers()
    if (g === state.activeGroup) selectFastestServer({ silent: false })
    toast(t(e.target.checked ? 'ds.groupsAutoOn' : 'ds.groupsAutoOff', { group: g }), 'ok')
  }))
  box.querySelectorAll('[data-del-group]').forEach(b => b.addEventListener('click', () => deleteGroup(b.dataset.delGroup)))
  box.querySelectorAll('[data-del-server]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); removeServer(b.dataset.delServer) }))
  box.querySelectorAll('[data-edit-server]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editServer(b.dataset.editServer) }))
  box.querySelectorAll('[data-use-server]').forEach(row => row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    const id = row.dataset.useServer
    const s = state.servers.find(x => x.id === id)
    if (!s) return
    if (state.autoSelect[s.group] !== false) { editServer(id); return }
    state.groupActive[s.group] = id
    state.activeGroup = s.group
    if (state.server !== s.url) resetFsForServerDesktop()
    state.server = s.url
    state.token = serverToken(s)
    LS.set('token', state.token)
    saveServers()
    renderServers()
    toast(t('ds.serversManualSelected', { url: serverTitle(s) }), 'ok')
    if (state.token) { openStreams(); refreshSessions() }
  }))
  const cur = currentServerEntry()
  const curGroup = cur ? cur.group : state.activeGroup
  const curLabel = cur ? (cur.note || cur.url) : (state.server || t('ds.origin'))
  const curMs = cur ? state.serverLatency[serverKey(cur)] : undefined
  $('server-desc').textContent = t('ds.serversCurrentDesc', { group: curGroup, url: curLabel }) + (Number.isFinite(curMs) ? ' · ' + curMs + 'ms' : '')
  updateConn()
}

async function addServer() {
  const input = $('server-input')
  let raw = (input?.value || '').trim().replace(/\/+$/, '')
  if (!raw) return toast(t('ds.serversNeedAddress'), 'err')
  try { const u = new URL(raw); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad') }
  catch { return toast(t('ds.serversBadProtocol'), 'err') }
  const token = normalizedServerToken(state.token)
  if (state.servers.some(s => serverIdentity(s.url, serverToken(s)) === serverIdentity(raw, token))) return toast(t('ds.serversDuplicate'), 'err')
  const note = (prompt(t('ds.serversPromptNote')) || '').trim()
  state.servers.push({ id: newServerId(), url: raw, note, group: state.activeGroup, token })
  saveServers()
  if (input) input.value = ''
  renderServers()
  toast(t('ds.serversAdded'), 'ok')
  if (state.token) selectFastestServer({ silent: false })
}
function editServer(id) {
  const s = state.servers.find(x => x.id === id)
  if (!s) return
  const raw = (prompt(t('ds.serversPromptEditUrl'), s.url) || '').trim().replace(/\/+$/, '')
  if (!raw) return
  try { const u = new URL(raw); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad') }
  catch { return toast(t('ds.serversBadProtocol'), 'err') }
  const tokenInput = prompt(t('ds.serversPromptEditToken'), '')
  if (tokenInput === null) return
  const token = normalizedServerToken(tokenInput) || serverToken(s)
  if (state.servers.some(x => x.id !== id && serverIdentity(x.url, serverToken(x)) === serverIdentity(raw, token))) return toast(t('ds.serversDuplicate'), 'err')
  const note = prompt(t('ds.serversPromptEditNote', { url: raw }), s.note || '')
  if (note === null) return
  const group = prompt(t('ds.serversPromptEditGroup'), s.group || '默认')
  if (group === null) return
  const wasActive = state.server === s.url && state.token === serverToken(s)
  const changedActiveUrl = wasActive && state.server !== raw
  s.url = raw; s.note = note.trim(); s.group = ensureGroup(group.trim() || '默认'); s.token = token
  if (wasActive) {
    if (changedActiveUrl) resetFsForServerDesktop()
    state.server = raw
    state.token = token
    LS.set('token', token)
  }
  saveServers(); renderServers(); toast(t('ds.serversEdited'), 'ok')
  if (wasActive && state.token) selectFastestServer({ silent: true })
}
function removeServer(id) {
  const s = state.servers.find(x => x.id === id)
  if (!s) return
  state.servers = state.servers.filter(x => x.id !== id)
  const wasActive = state.server === s.url && state.token === serverToken(s)
  for (const g of state.groups) if (state.groupActive[g] === id) state.groupActive[g] = ''
  saveServers(); renderServers()
  if (wasActive) { toast(t('ds.serversRemovedActive')); selectFastestServer({ silent: true }) }
}
function switchGroup(name) {
  if (!state.groups.includes(name)) return
  state.activeGroup = name
  saveServers(); renderServers()
  toast(t('ds.groupsSwitched', { group: name }), 'ok')
  selectFastestServer({ silent: false })
}
function addGroup() {
  const name = (prompt(t('ds.groupsPromptAdd')) || '').trim()
  if (!name) return
  if (state.groups.includes(name)) return toast(t('ds.groupsDuplicate'), 'err')
  ensureGroup(name); state.activeGroup = name
  saveServers(); renderServers(); toast(t('ds.groupsAdded', { group: name }), 'ok')
}
function renameGroup(oldName) {
  if (oldName === '默认') return
  const name = (prompt(t('ds.groupsPromptRename', { group: oldName }), oldName) || '').trim()
  if (!name || name === oldName) return
  if (state.groups.includes(name)) return toast(t('ds.groupsDuplicate'), 'err')
  const idx = state.groups.indexOf(oldName)
  state.groups[idx] = name
  for (const s of state.servers) if (s.group === oldName) s.group = name
  if (state.activeGroup === oldName) state.activeGroup = name
  state.autoSelect[name] = state.autoSelect[oldName] !== false
  delete state.autoSelect[oldName]
  state.groupActive[name] = state.groupActive[oldName] || ''
  delete state.groupActive[oldName]
  saveServers(); renderServers(); toast(t('ds.groupsRenamed', { group: name }), 'ok')
}
function deleteGroup(name) {
  if (name === '默认') return toast(t('ds.groupsCannotDeleteDefault'), 'err')
  if (!state.groups.includes(name)) return
  if (!confirm(t('ds.groupsConfirmDelete', { group: name }))) return
  state.groups = state.groups.filter(g => g !== name)
  for (const s of state.servers) if (s.group === name) s.group = '默认'
  delete state.autoSelect[name]; delete state.groupActive[name]
  if (state.activeGroup === name) state.activeGroup = '默认'
  saveServers(); renderServers(); toast(t('ds.groupsDeleted'), 'ok')
  if (state.token) selectFastestServer({ silent: true })
}

/* ---------------- 事件流 (WebSocket + 轮询降级) ---------------- */
const streamMeta = {
  mux: { generation: 0, attempt: 0, failures: 0, retryTimer: null },
  host: { generation: 0, attempt: 0, failures: 0, retryTimer: null },
}

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
  if (state.server) base = state.server.replace(/^http/, 'ws')
  else { const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; base = `${proto}//${location.host}` }
  const auth = ticket ? `ticket=${encodeURIComponent(ticket)}` : `token=${encodeURIComponent(state.token)}`
  const clientId = CLIENT_ID ? `&clientId=${encodeURIComponent(CLIENT_ID)}` : ''
  const streamUrl = `${base}/api/events.${kind}?${auth}&client=web${clientId}`
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
    if (kind === 'mux') { state.approvals = []; state.questions = []; renderNotifStack() }
    if (refreshOnOpen) refreshSessions()
    if (allStreamsOpen()) {
      resyncAfterStreamOpen()
      void pingServer(state.server || location.origin)
      void refreshHostDescriptionDesktop()
    }
  }
  ws.onmessage = (msg) => {
    if (!streamIsCurrent(kind, ws, generation)) return
    state.streamsOk[kind] = true
    updateConn()
    try { handler(JSON.parse(msg.data)) } catch {}
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
  refreshSessions()
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
    const headers = { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() }
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
  if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
  if (!res.ok) return
  if (!valid()) return
  if (!data || !Array.isArray(data.events)) return
  const reset = data.reset === true || (!!data.epoch && !!cursors[kind + 'Epoch'] && cursors[kind + 'Epoch'] !== data.epoch) || data.truncated === true || (typeof data.latestSeq === 'number' && data.latestSeq < since)
  if (reset) {
    state.pollSeq[kind] = 0
    if (kind === 'mux') renderNotifStack()
    refreshSessions()
    if (state.current) void resyncCurrentSession()
  }
  if (data.epoch) cursors[kind + 'Epoch'] = data.epoch
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token) { recoverSessionHistory();openStreams() }
  if (document.visibilityState === 'visible' && state.token &&
      (streams.mux?.readyState !== WebSocket.OPEN || streams.host?.readyState !== WebSocket.OPEN)) {
    repairMissingStreams()
  }
})

setInterval(sessionSyncTick, 15000)

function onMuxFrame(full) {
  const f = full.payload
  if (!f) return
  if (f.type === 'session/reasoning') {
    if (f.sessionId === state.current) { applyReasoningBaseline(f.partialReasoning); scheduleReasoningRender() }
    return
  }
  if (f.type === 'session/event') return onSessionEvent(f.sessionId, f.event, { replay: f.replay === true })
  if (f.type === 'approval/requested') {
    state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId)
    state.approvals.push({ ...f, rpcId: full.rpcId })
    collectApprovalFrame(f)
    renderNotifStack()
    return
  }
  if (f.type === 'approval/resolved') { collectApprovalFrame(f); state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId); renderNotifStack(); return }
  if (f.type === 'question/requested') {
    state.questions = state.questions.filter(q => q.rpcId !== full.rpcId)
    state.questions.push({ ...f, rpcId: full.rpcId })
    renderNotifStack()
    return
  }
  if (f.type === 'question/resolved') {
    state.questions = state.questions.filter(q => q.rpcId !== f.questionRpcId)
    if (state.questionModal?.rpcId === f.questionRpcId) { $('modal-question').classList.add('hidden'); state.questionModal = null }
    renderNotifStack(); return
  }
  if (f.type === 'session/queue') { state.queues[f.sessionId] = f.items || []; renderQueue(); return }
  if (f.type === 'session/projection') { applyProjection(f.sessionId, f.key, f.value, f.seq); return }
  if (f.type === 'stream/error') toast(f.error?.message || 'stream error', 'err')
  if (f.type === 'session/stream-error' && f.sessionId === state.current) { const message=f.error?.code==='session/migration-required'?t('session.migrationRequired'):f.error?.message;setSessionRecovery('error',message);toast(message,'err') }
}
function onHostFrame(full) {
  const f = full.payload
  if (!f) return
  if (['host/session-added', 'host/session-removed', 'host/workspace-changed', 'host/workspace-removed', 'host/workspace-order-changed', 'host/archived-sessions-changed'].includes(f.type)) scheduleSessionsRefresh()
  if (f.type === 'host/session-activity') {
    const session = state.byId.get(f.sessionId)
    if (session) { session.updatedAt = Number(f.updatedAt) || Date.now(); renderSessions(); renderOverviewDesktop() }
    scheduleSessionSync(f.sessionId)
    return
  }
  if (f.type === 'host/session-status') {
    if (f.running && state.runtimeErrors?.delete(f.sessionId) && state.current === f.sessionId) renderHistory()
    const s = state.byId.get(f.sessionId)
    if (s) { s.running = f.running; if (f.running) s.error = false; if (state.current === f.sessionId) { renderSessions(); renderQueue(); updateComposerStatus() } renderOverviewDesktop() }
    if (!f.running) scheduleSessionSync(f.sessionId)
  }
  if (f.type === 'host/agent-error') {
    const s = state.byId.get(f.sessionId)
    if (s) { s.error = true; s.running = false }
    rememberRuntimeError(f.sessionId, f.message)
    if (state.current === f.sessionId) { renderQueue(); updateComposerStatus(); toast(String(f.message || ''), 'err') }
  }
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
  if (next?.active === true) {
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
        ? t('ds.compactFailed', { msg: next.message || t('ds.sessionRecoveryFailed') })
        : t('ds.commandFailed', { command, msg: next.message || t('ds.sessionRecoveryFailed') }), 'err')
      else toast(command === 'compact' ? t('ds.compactComplete') : t('ds.commandComplete', { command }), 'ok')
    }
  }
  ensureCompactionMonitoring()
  if (state.current === sessionId) updateComposerStatus()
}
async function refreshCompactionStatus(sessionId = state.current) {
  if (!sessionId) return
  const connection = captureConnection()
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    const url = new URL(connection.server + '/remote/api/command-status', location.href)
    url.searchParams.set('sessionId', sessionId)
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() }, ...(signal ? { signal } : {}) })
    if (!connection.valid()) return
    if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
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
      if (operation.phase === 'failed') toast(t('ds.commandFailed', { command: pending, msg: operation.message || t('ds.sessionRecoveryFailed') }), 'err')
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
  if (!state.compactionClockTimer) state.compactionClockTimer = setInterval(() => { if (activeCompaction()) updateComposerStatus() }, 1000)
  if (!state.compactionPollTimer) state.compactionPollTimer = setInterval(() => {
    const compact = activeCompaction()
    if (compact && compact.source !== 'event') void refreshCompactionStatus()
  }, 3000)
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
  if (state.current === sessionId) {
    renderSessions()
    window.DshInsights?.update()
    if (['goal', 'todos'].includes(key)) renderSessionCards()
  }
  if (['title', 'goal', 'todos', 'plan', 'sessionListMetadata'].includes(key)) scheduleSessionsRefresh()
}
function setSessionRecovery(status, error = '') {
  state.sessionRecovery = { status, error: String(error || '') }
  updateSessionActions()
}
function recoveryLabel() {
  const status = state.sessionRecovery.status
  if (status === 'loading' || status === 'resuming') return t('ds.sessionRecovering')
  if (status === 'error') return t('ds.sessionRecoveryFailed')
  return ''
}
function resyncCurrentSession() {
  if (!state.current) return Promise.resolve()
  return loadHistory().then(() => {
    if (state.current) { renderSessionCards(); updateComposerStatus(); updateSessionActions() }
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
  void refreshSessions().then(() => resyncCurrentSession())
}
function proj(s, key, d) { return s?.projections?.values?.[key] ?? d }
function optionalPluginConfig(connection = captureConnection()) {
  return { connection, valid: connection.valid, url: path => connection.server + path,
    headers: { authorization: 'Bearer ' + connection.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() } }
}
function availableInsightTabs(capabilities) {
  return [...(capabilities.context ? ['context'] : []), ...(capabilities.cost ? ['cost'] : [])]
}
async function refreshInsightEntry() {
  const control = $('btn-insights'), id = state.current, connection = captureConnection()
  if (!control || !id || !connection.token || !window.DshExtensions) { control?.classList.add('hidden'); return }
  const capabilities = await window.DshExtensions.getCapabilities(optionalPluginConfig(connection))
  if (!connection.valid() || state.current !== id) return
  const tabs = availableInsightTabs(capabilities)
  control.classList.toggle('hidden', !tabs.length)
  const label = t(tabs.length === 2 ? 'ds.insights' : tabs[0] === 'cost' ? 'ds.insightsCost' : 'ds.insightsContext')
  control.textContent = label; control.title = label; control.setAttribute('aria-label', label)
}
async function openInsights(tab = 'context', fullPage = false) {
  const connection = captureConnection(), id = state.current
  const capabilities = await window.DshExtensions.getCapabilities(optionalPluginConfig(connection))
  if (!connection.valid() || state.current !== id || !id) return
  const allowedTabs = availableInsightTabs(capabilities)
  if (!allowedTabs.length) { void refreshInsightEntry(); return }
  window.DshInsights?.close()
  const view = fullPage ? conversationView : null, wasPaused = view?.paused
  view?.pause()
  window.DshInsights?.open({ tab, fullPage, allowedTabs, connection, url: path => connection.server + path,
    getSession: () => state.byId.get(state.current), getTitle: () => titleOf(state.byId.get(state.current)),
    onFullPage: selected => void openInsights(selected, true),
    onClose: () => { if (view && !wasPaused && connection.valid() && state.current === id && state.view === 'view-chat') view.resume() } })
}
function sessionTitleValue(s) {
  const value = proj(s, 'title', '')
  return value == null ? '' : String(value).trim()
}
function hasSessionTitle(s) { return !!sessionTitleValue(s) }
function titleOf(s) { return sessionTitleValue(s) || (s?.sessionId ? t('ds.sessionUntitled') : t('ds.sessions')) }
function sessionLabelOf(s) {
  const title = titleOf(s)
  if (!s?.sessionId || hasSessionTitle(s)) return title
  return `${title} · ${String(s.sessionId).slice(-8)}`
}
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
function onSessionEvent(sessionId, event, meta = {}) {
  if (collectApprovalEvent(sessionId, event)) renderApprovalRecordsDesktop()
  observeCompactionEvent(sessionId, event, meta)
  const failedSession = state.byId.get(sessionId)
  if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error' && failedSession) {
    failedSession.error = true; failedSession.running = false
    if (state.current === sessionId) { renderQueue(); updateComposerStatus() }
  }
  if (event?.type === 'turn/start' || event?.type === 'turn/end') {
    noteSessionTurnTime(sessionId, event)
    renderSessions()
    if (event.type === 'turn/start') state.runtimeErrors?.delete(sessionId)
    if (event.type === 'turn/end' && !meta.replay) scheduleSessionSync(sessionId)
  }
  const session = state.byId.get(sessionId)
  if((event?.type==='session/title'||event?.type==='title')&&event.data?.title&&session){session.projections??={values:{}};session.projections.values??={};session.projections.values.title=event.data.title;if(state.current===sessionId)updateSessionActions()}
  if (event?.type === 'agent/status' && session) {
    if (event.data?.running) state.runtimeErrors?.delete(sessionId)
    else if (!meta.replay) scheduleSessionSync(sessionId)
    session.running = !!event.data?.running
    if (state.current === sessionId) { renderQueue(); updateComposerStatus() }
  }
  if (state.current === sessionId && event) {
    const h = state.history
    const reasoningChanged = applyReasoningStreamEvent(event)
    if (event.type === 'assistant/chunk' || event.type === 'reasoning-chunks') {
      if (reasoningChanged) scheduleReasoningRender()
      return
    }
    const seq = event.seq
    if (seq != null && !h.seqs.has(seq) && shouldShowEvent(event.type, event)) {
      h.seqs.add(seq)
      window.DshHistory.insertSorted(h.visible, { seq, event })
      trimVisible()
      renderHistory()
      scheduleHistoryCacheSave()
    }
    if (String(event.type || '').startsWith('goal/') || String(event.type || '').startsWith('todo/')) renderSessionCards()
  }
}

/* ---------------- 会话 ---------------- */
function scheduleSessionsRefresh() {
  if (state.refreshTimer) return
  const connection = captureConnection()
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; if (connection.valid()) void refreshSessions() }, 150)
}
async function refreshSessions() {
  if(typeof restoreCachedSessionList==='function')restoreCachedSessionList()
  const connection = captureConnection(), request = ++sessionsRequest
  const v = await safeRpc('session.list', {}, '')
  if (!connection.valid() || request !== sessionsRequest) return
  if (!v) { renderSessions(); renderOverviewDesktop(); return }
  state.sessions = v.items || []
  state.byId = new Map(state.sessions.map(s => [s.sessionId, s]))
  for (const [id, child] of Object.entries(state.subagentSessions || {})) {
    const listed = state.byId.get(id)
    const merged = listed ? { ...child, ...listed, parentSessionId: child.parentSessionId, subagentMode: child.subagentMode, origin: 'subagent' } : child
    state.byId.set(id, merged)
    state.subagentSessions[id] = merged
  }
  applyPendingProjections()
  try{LS.set(historyCacheScope()+':sessions',JSON.stringify(state.sessions.slice(0,80)))}catch{}
  if(typeof window!=='undefined')window.DshDoctorEntry?.consumeSessionLink(openSession,state.byId)
  renderSessions()
  scheduleWorkbenchRefresh()
  renderOverviewDesktop()
}
function sessionCwd(s) { return typeof s?.cwd === 'string' ? s.cwd.trim() : '' }
function sessionWorkspaceLabel(s) {
  const cwd = sessionCwd(s)
  return cwd || t('ds.workspaceUnknown')
}
function sessionSortTime(s) {
  return Math.max(Number(state.sessionTurnTimes[s?.sessionId]) || 0, Number(s?.updatedAt) || 0, Number(s?.createdAt) || 0)
}
function sessionWorkspaceOrderKey(s) {
  return 'path:' + (sessionWorkspaceLabel(s) || 'workspace-unknown')
}
function commitWorkspaceGroupOrder(order) {
  saveWorkbenchOrder(value => { value.workspaceIds = order.map(String) })
  renderSessions()
  toast(t('ds.wbOrderSaved'), 'ok')
}
function noteSessionTurnTime(sessionId, eventOrTime) {
  const raw = typeof eventOrTime === 'object' ? eventOrTime?.time : eventOrTime
  const time = Number(raw) > 0 ? Number(raw) : Date.now()
  if (!sessionId || !Number.isFinite(time)) return
  state.sessionTurnTimes[sessionId] = Math.max(Number(state.sessionTurnTimes[sessionId]) || 0, time)
}
function workspaceDisplayName(label) {
  const value = String(label || '').trim()
  if (!value || value === t('ds.workspaceUnknown')) return value || t('ds.workspaceUnknown')
  const clean = value.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
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
  const allItems = sortedSessions()
  const wbIds = new Set()
  if (state.wb.bound && state.wb.projects) for (const w of state.wb.projects) for (const id of (w.sessionIds || [])) wbIds.add(id)
  const root = state.wb.bound ? state.wb.path : ''
  const archivedSet = new Set(state.archivedIds || [])
  const visible = allItems.filter(s => {
    if (!state.wb.bound) return true
    if (archivedSet.has(s.sessionId)) return true
    return !(wbIds.has(s.sessionId) || wbStrictInside(s.cwd, root))
  })
  const archived = visible.filter(s => archivedSet.has(s.sessionId))
  const main = visible.filter(s => !archivedSet.has(s.sessionId))
  const showArchived = LS.get('dsShowArchivedV1', '0') === '1'
  const renderSession = s => {
      const workspace = sessionWorkspaceLabel(s)
      const workspaceName = workspaceDisplayName(workspace)
      const title = sessionLabelOf(s)
      return `<button class="ds-session-item ${state.current === s.sessionId ? 'current' : ''}" data-id="${esc(s.sessionId)}">
        <span class="ds-session-title">${esc(title)}</span>
        <span class="ds-session-workspace" title="${esc(workspace)}">⌂ ${esc(workspaceName)}</span>
        <span class="ds-session-meta"><span class="ds-session-dot ${s.running ? 'running' : ''}"></span>${fmtTime(sessionSortTime(s))}</span>
      </button>`
  }
  const renderItems = (items) => {
    if (state.sessionSort !== 'workspace') return items.map(renderSession).join('')
    const groups = []
    const byKey = new Map()
    for (const session of items) {
      const key = sessionWorkspaceOrderKey(session)
      let group = byKey.get(key)
      if (!group) {
        group = { key, label: workspaceDisplayName(sessionWorkspaceLabel(session)), path: sessionWorkspaceLabel(session), items: [] }
        byKey.set(key, group)
        groups.push(group)
      }
      group.items.push(session)
    }
    const { value } = workbenchOrderScopeValue()
    return orderedItems(groups, value.workspaceIds, group => group.key).map(group => `<div class="ds-session-workspace-group" data-workspace-group="${esc(group.key)}" data-motion-key="${esc(group.key)}">
      <div class="ds-session-group" data-reorder-handle title="${esc(group.path)}"><span class="ds-session-group-drag-handle" aria-hidden="true">⠿</span><span class="ds-session-group-icon" aria-hidden="true">⌂</span><span class="ds-session-group-name">${esc(group.label)}</span></div>
      ${orderedWorkspaceSessions(group.key, group.items).map(renderSession).join('')}
    </div>`).join('')
  }
  const divider = archived.length ? `<button class="ds-archived-toggle" type="button" data-archived-toggle>${esc(showArchived ? t('wb.archivedShown') : t('wb.archivedHidden'))}</button>` : ''
  const hiddenByWorkbench = allItems.length - visible.length
  const html = renderItems(main) + divider + (showArchived ? renderItems(archived) : '') || `<div class="ds-empty">${esc(hiddenByWorkbench ? t('wb.flatHidden', { n: hiddenByWorkbench }) : t('ds.sessionsEmpty'))}</div>`
  $('session-list').innerHTML = html
  $('mobile-session-list').innerHTML = html
  window.DshMotion?.list($('session-list'), '.ds-session-item')
  window.DshMotion?.list($('mobile-session-list'), '.ds-session-item')
  for (const list of [$('session-list'), $('mobile-session-list')].filter(Boolean)) {
    window.DshMotion?.bindLongPressReorder(list, '.ds-session-workspace-group', {
      handleSelector: '.ds-session-group',
      onCommit: ({ order }) => commitWorkspaceGroupOrder(order)
    })
    window.DshMotion?.bindLongPressReorder(list, '.ds-session-item', {
      groupSelector: '.ds-session-workspace-group',
      handleSelector: '.ds-session-item',
      onCommit: ({ item, order }) => commitWorkspaceSessionOrder(item.closest('[data-workspace-group]')?.dataset.workspaceGroup, order)
    })
  }
  $('session-list').classList.toggle('workspace-sorted', state.sessionSort === 'workspace')
  $('mobile-session-list').classList.toggle('workspace-sorted', state.sessionSort === 'workspace')
  const sort = $('session-sort')
  if (sort) sort.value = state.sessionSort
  document.querySelectorAll('[data-archived-toggle]').forEach(b => b.addEventListener('click', () => {
    LS.set('dsShowArchivedV1', LS.get('dsShowArchivedV1', '0') === '1' ? '0' : '1')
    renderSessions()
  }))
  document.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openSession(b.dataset.id)))
  renderWorkbench()
}

const emptySessionCleanup = new Set()
async function archiveEmptySessionOnLeave(sessionId, leaving = false) {
  const base = state.server, connection=captureConnection()
  const protectedSession = () => !connection.valid() || state.server !== base || (!leaving && state.current !== sessionId)
    || !!state.byId.get(sessionId)?.parentSessionId || state.byId.get(sessionId)?.origin === 'subagent'
    || !state.byId.has(sessionId) || state.byId.get(sessionId)?.running
    || state.sessionActivity?.has(sessionId) || state.pendingPrompts?.has(sessionId)
    || (state.queues[sessionId] || []).length > 0
    || (state.composerImages || []).length > 0 || !!$('composer')?.value?.trim()
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
  state.history = emptyDesktopHistory()
  const openingHistory=state.history, openingConnection=captureConnection()
  state.models = { loaded: false, loading: false, groups: [], current: null, failures: [] }
  showView('view-chat')
  $('ds-title').textContent = titleOf(state.byId.get(id)) || t('ds.sessions')
  updateSessionActions()
  getConversationView().reset()
  $('history').innerHTML = `<div class="ds-empty">${t('ds.historyLoading')}</div>`
  renderSessions()
  renderSessionCards()
  renderQueue()
  renderSessionPendingDesktop()
  updateComposerStatus()
  void refreshCompactionStatus(id)
  try { const restored=await restoreCachedHistory();globalThis.DshDiagnostics?.record('history.cache',{phase:restored?'hit':'miss',sessionId:id}) } catch(error) {
    globalThis.DshDiagnostics?.record('history.cache',{phase:'failed',sessionId:id,...globalThis.DshDiagnostics.errorFacts(error)})
    if(state.current!==id||state.history!==openingHistory||!openingConnection.valid())return
    // A broken local cache must not prevent fetching the authoritative history.
    cancelHistoryLoad()
    Object.assign(openingHistory,emptyDesktopHistory())
    getConversationView().reset()
  }
  if(state.current!==id||state.history!==openingHistory||!openingConnection.valid())return
  await loadHistory()
}
async function closeSession() {
  globalThis.DshDiagnostics?.record('session.back',{phase:'start',sessionId:state.current,loading:state.history.loading,loaded:state.history.loaded,renderErrors:state.history.renderError?1:0})
  const sessionId = state.current
  const parentId = state.byId.get(sessionId)?.parentSessionId
  if (parentId && parentId !== sessionId) return openSession(parentId)
  const wasLoading = state.history.loading
  cancelHistoryLoad()
  const cleanup=sessionId&&!wasLoading&&state.history.loaded&&!state.history.loading&&!state.history.renderError
  state.current = null
  setSessionRecovery('idle')
  state.history = emptyDesktopHistory()
  showView('view-sessions')
  globalThis.DshDiagnostics?.record('session.back',{phase:'navigate',sessionId})
  const cards = $('session-cards')
  if (cards) cards.innerHTML = ''
  renderQueue()
  renderSessionPendingDesktop()
  updateComposerStatus()
  updateSessionActions()
  if(cleanup)await archiveEmptySessionOnLeave(sessionId,true)
}

function restoreCachedSessionList() {
  if(state.sessions.length)return
  try{const items=JSON.parse(LS.get(historyCacheScope()+':sessions',''));if(!Array.isArray(items))return;state.sessions=items.filter(item=>typeof item?.sessionId==='string').slice(0,80);state.byId=new Map(state.sessions.map(item=>[item.sessionId,item]));renderSessions()}catch{}
}

let conversationView = null
function historyCacheScope() { const hash=new SHA256();hash.update(new TextEncoder().encode(JSON.stringify([state.server||location.origin,state.token])));return 'historyCacheV2:'+hash.hex() }
function historySource(value) {
  state.history.source=value
  const el=$('history-source')
  if(el)el.textContent=t(({cache:'ds.historyCached',syncing:'ds.historySyncing',synced:'ds.historySynced',saved:'ds.historySaved',offline:'ds.historyOffline',saveFailed:'ds.historyCacheFailed',error:'ds.historyRenderFailed'})[value]||'ds.historySynced')
}
function getConversationView() {
  if(!conversationView)conversationView=new window.DshHistory.HistoryView($('history'),{
    html:entry=>eventHtml(entry),
    errorLabel:()=>t('ds.historyRenderFailed'),
    older:()=>loadHistory(false),olderLabel:()=>t('ds.historyEarlier'),loadingLabel:()=>t('ds.historyLoadingEarlier'),live:partialReasoningHtml,
    retry:()=>loadHistory(true),retryLabel:()=>t('ds.historyRetry'),unreadableLabel:()=>I18N.lang==='en'?'No displayable messages on this page. Load earlier records or retry. If DSH reports a migration failure, open the original session in DSH.':'本页历史没有可显示的消息，请加载更早记录或重试。如提示格式迁移失败，请先在 DSH 中打开原会话。',
    changed:view=>{state.history.renderStart=view.start;state.history.renderEnd=view.end;const latest=$('btn-history-latest');if(latest){latest.classList.toggle('hidden',view.atBottom&&view.unread===0&&!state.history.tailEvicted);latest.textContent=t('ds.historyLatest')+(view.unread?' ('+view.unread+')':view.hasPending?' · '+(I18N.lang==='en'?'New content':'有新内容'):'')}},
    scrolled:()=>{}
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
    if(error.message==='AUTH'){return}
    if(history.visible.length&&!renderFailure){try{renderHistory(false,'fixed');history.renderError=!!getConversationView().renderErrors;historySource(history.renderError?'error':'offline');setSessionRecovery(history.renderError?'error':'cached',error.message);return}catch{}}
    history.renderError=true;historySource('error')
    setSessionRecovery('error',error.message)
    getConversationView().reset?.()
    $('history').innerHTML='<div class="history-empty">'+esc(error.message)+'</div>'
    const retry=document.createElement('button');retry.type='button';retry.className='history-page-control';retry.textContent=t('ds.historyRetry');retry.addEventListener('click',()=>{void loadHistory(true)});$('history').append(retry)
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
      updateSessionActions();renderSessionCards()
      globalThis.DshDiagnostics?.record('history.render',{phase:'start',traceId:diagnostic?.traceId,sessionId:id,count:history.visible.length})
      renderHistory(!hadContent,reset?'fixed':'keep')
      history.renderError=!!getConversationView().renderErrors
      historySource(history.renderError?'error':'synced');setSessionRecovery(history.renderError?'error':'ready')
      if(approvalChanged)renderApprovalRecordsDesktop()
      diagnostic?.end({phase:history.renderError?'failed':'rendered',count:history.visible.length,renderedCount:getConversationView().end-getConversationView().start,renderErrors:getConversationView().renderErrors||0})
      if(!history.renderError)scheduleHistoryCacheSave()
    } catch(error) { failLoad(error,true) }
  } catch(error) { if(valid())failLoad(error) }
  finally { if(history.loadController===controller){history.loading=false;history.loadController=null} }
}


const INTERESTING_EVENTS = new Set([
  'turn/start', 'turn/end',
  'user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result',
  'agent/status', 'checkpoint/created', 'compaction/complete', 'compaction/summary',
  'goal/created', 'goal/updated', 'goal/completed', 'goal/cleared',
  'todo/updated', 'plan/updated', 'question/asked', 'question/resolved',
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
function reasoningStreamKey(data, index) { return `${data?.turn ?? '?'}:${data?.step ?? '?'}:${index ?? '?'}` }
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
      h.partialReasoning.set(key, { turn: data.turn, step: data.step, index: chunk.index, text: String(chunk.block.text ?? chunk.block.content ?? '') })
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
      if (item.turn === data.turn && item.step === data.step) { h.partialReasoning.delete(key); changed = true }
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
    if (state.current) renderHistory()
  }, weakStreamTrim() ? 500 : 80)
}
function partialReasoningHtml() {
  if (weakStreamTrim()) return state.history.partialReasoning.size ? window.DshActivity?.streamNotice?.() || '' : ''
  return [...state.history.partialReasoning.values()]
    .filter(item => item.text)
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0) || (a.step ?? 0) - (b.step ?? 0) || (a.index ?? 0) - (b.index ?? 0))
    .map(item => window.DshActivity ? window.DshActivity.reasoning({text:item.text,live:true,key:window.DshActivity.reasoningKey(item,item.index,'live-reasoning')}) : `<div class="ds-msg assistant ds-reasoning-live"><div class="role">${esc(t('ds.role.dsh'))}</div><details open><summary>${esc(t('block.thinkingLive'))}</summary><div>${esc(item.text)}</div></details></div>`)
    .join('')
}
function safeJson(v) { try { return JSON.stringify(v, null, 2) } catch { return String(v) } }
function blockHtml(b,index=0,context={}) {
  if (!b) return ''
  if ((b.type === 'tool-call' || b.type === 'tool-result') && context.suppressBlockTools) return ''
  if (typeof window !== 'undefined' && window.DshActivity) {
    const key='block:'+context.seq+':'+index
    if (b.type==='thinking'||b.type==='reasoning') return window.DshActivity.reasoning({text:b.text??b.content??'',key:window.DshActivity.reasoningKey(context,index,key)})
    if (b.type==='tool-call'||b.type==='tool-result') return window.DshActivity.tool({key,name:b.name||b.toolName,...(b.type==='tool-call'?{args:b.arguments??b.args??b.input}:{result:b.result??b.output??b.content??b,error:!!(b.error||b.ok===false||b.isError)})})
  }
  if (b.type === 'text') return `<div class="md">${window.mdToHtml ? window.mdToHtml(b.text ?? '', { fileLinks: true, imageLabel: t('block.image') }) : esc(b.text ?? '')}</div>`
  if (b.type === 'file' && typeof window !== 'undefined' && window.DshChatFiles) return window.DshChatFiles.render(b)
  if (b.type === 'file') return `<div class="ds-tool">📎 ${esc(b.attachment?.name || b.name || 'file')} <small>${esc(b.attachment?.bytes ?? b.bytes ?? '')} bytes</small></div>`
  if (b.type === 'thinking' || b.type === 'reasoning') return `<details><summary>${esc(t('block.thinking'))}</summary><div style="opacity:.82">${esc(b.text ?? b.content ?? '')}</div></details>`
  if (b.type === 'tool-call') return `<div>🔧 ${esc(b.name || '')}</div>`
  if (b.type === 'tool-result') return `<div>📦</div>`
  if (b.type === 'image') {
    if (b.attachment && window.DshImagePreview) return window.DshImagePreview.attachmentHtml(b.attachment, t('block.image'), state.current)
    const alt = b.name || b.filename || t('block.image')
    return `<button type="button" class="chat-image" data-chat-image aria-label="${esc(t('block.image'))}"><img alt="${esc(alt)}" src="data:${esc(b.mediaType || 'image/png')};base64,${esc(b.data || '')}" draggable="false"></button>`
  }
  return ''
}
function systemReminderText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && typeof b === 'object' && b.type === 'text' && String(b.text ?? '').trimStart().startsWith('<system-reminder>'))
    .map(b => String(b.text ?? ''))
    .join('\n')
}
function activityGroupHtml(group) {
  const items = group.items || []
  if (!items.length) return ''
  const tools = items.filter(item => item.kind === 'tool').map(item => item.entry)
  const running = !!group.running
  const failed = tools.some(entry => entry.view?.toolActivity?.error || entry.event?.data?.error)
  const body = items.map(item => item.kind === 'reasoning'
    ? window.DshActivity.reasoning({ text: item.text, key: item.key })
    : eventHtml(item.entry)).join('')
  return `<details class="chat-activity-group${failed ? ' is-error' : ''}${running ? ' is-running' : ''}" data-activity-key="activity-group:${items[0]?.seq ?? ''}"><summary><span class="activity-group-title">${esc(t('ds.activity.group', { n: items.length }))}</span>${running ? `<span class="activity-group-live"><i aria-hidden="true"></i>${esc(t('ds.activity.groupRunning'))}</span>` : ''}<span class="activity-chevron" aria-hidden="true"></span></summary><div class="activity-group-body">${body}</div></details>`
}

function eventHtml(entry) {
  if (entry.view?.failureGroup) return window.DshActivity.failureGroupHtml(entry.view.failureGroup, item => eventHtml(item))
  const ev = entry.event || {}
  const data = ev.data || {}
  const type = ev.type || 'event'
  const failure = window.DshActivity?.failureHtml?.(window.DshActivity.failure(ev)) || ''
  if (entry.view?.turnResult) return failure + window.DshTurnResults.html(entry.view.turnResult)
  if (type === 'turn/start' || type === 'turn/end') return failure
  if (type === 'assistant/attempt') return window.DshActivity?.attemptHtml?.(ev) || ''
  if (entry.view?.activityGroup) return activityGroupHtml(entry.view.activityGroup)
  if (!shouldShowEvent(type, ev)) return ''
  if (window.DshActivity && (type==='tool/call'||type==='tool/result')) return window.DshActivity.toolEvent(entry)
  if (type === 'user/message' || type === 'assistant/message') {
    const msg = data.message || {}
    const role = data.role || msg.role || (type.startsWith('user') ? 'user' : 'assistant')
    const blocks = msg.content || data.content || []
    const sysText = type === 'user/message' ? systemReminderText(blocks) : ''
    if (sysText) {
      const shown = sysText.length > 400 ? sysText.slice(0, 400) + '…' : sysText
      return `<details class="event ds-tool ds-event-detail"><summary>${esc(t('ds.eventSystemReminder'))}</summary><pre>${esc(shown)}</pre></details>`
    }
    if (type === 'user/message' && !isHumanUserMessage(ev)) return ''
    const text = blocks.map((block,index)=>blockHtml(block,index,{...data,seq:entry.seq,suppressBlockTools:state.history.suppressBlockTools})).join('')
    if (!text) return ''
    return `<div class="ds-msg ${esc(role)}"><div class="role">${esc(role === 'user' ? t('ds.role.me') : t('ds.role.dsh'))}</div>${text}</div>`
  }
  if (type === 'tool/call') {
    const name = data.name || data.toolName || t('ds.toolDefault')
    const step = (data.turn != null ? ` · turn ${data.turn}` : '') + (data.step != null ? `.${data.step}` : '')
    return `<details class="ds-tool"><summary>🔧 ${esc(name)}${esc(step)}</summary><pre>${esc(safeJson(data.arguments ?? data.args ?? data.input ?? data))}</pre></details>`
  }
  if (type === 'tool/result') {
    const callId = data.callId || data.message?.source?.callId || ''
    const text = data.text || data.content || safeJson(data.message?.content ?? data)
    return `<details class="ds-tool"><summary>📦 ${esc(callId)}</summary><pre>${esc(safeJson(text))}</pre></details>`
  }
  if (type === 'approval/asked') {
    const record = state.approvalRecords?.get(data.id)
    if (record && window.DshApprovalRecords) return window.DshApprovalRecords.lineHtml(record, t)
    return `<div class="approval-event">🔐 ${esc(data.toolName || t('ds.toolDefault'))}</div>`
  }
  if (type === 'question/asked') return `<div class="ds-tool">❓ ${esc(data.question || '')}</div>`
  return `<div class="ds-tool">${esc(type)}</div>`
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
      // A confirmed fork remains usable while the session catalog is stalled.
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

function renderHistory(reset=false, mode='auto') {
  let prepared=window.DshActivity?.prepare(state.history.visible)||state.history.visible
  if(weakStreamTrim())prepared=prepared.filter(entry=>entry.event?.type!=='tool/call'||entry.view?.toolActivity)
  state.history.suppressBlockTools = state.history.visible.some(entry => entry.event?.type === 'tool/call')
  if(window.DshActivity?.group)prepared=window.DshActivity.group(prepared)
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
  getConversationView().set(prepared,{reset,follow:mode==='bottom',live:partialReasoningHtml()+runtimeHtml,hasMore:state.history.hasMore,loading:state.history.loading,emptyLabel:t('ds.historyEmpty')})
  window.DshImagePreview?.hydrate?.($('history'))
}
window.applyStreamPreference=()=>{if(state.current)renderHistory(false,'auto')}

/* ---------------- 会话信息卡（goal / todo / 子代理） ---------------- */
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
  const box = $('session-cards')
  const s = state.byId.get(sessionId)
  if (!box) return
  if (!s) { box.innerHTML = ''; return }
  const goal = goalOf(s)
  const todos = proj(s, 'todos')
  let html = ''
  if (goal && !isGoalTerminal(goal)) {
    const collapsed = isGoalCollapsed(sessionId, goal)
    html += `<div class="ds-goal-disclosure${collapsed ? ' is-collapsed' : ''}">
      <div id="goal-panel-desktop" class="ds-card ds-goal-card${collapsed ? ' hidden' : ''}">
        <div class="ds-goal-card-head"><div class="ds-card-title">${t('goal.title')}</div>
          <button type="button" class="ds-goal-collapse-btn" data-goal-collapse="1" aria-expanded="true" aria-controls="goal-panel-desktop" title="${esc(t('goal.collapse'))}"><span aria-hidden="true">›</span>${t('goal.collapseShort')}</button>
        </div>
        <div class="ds-goal-obj">${esc(goal.objective || '')}</div>
        <div class="ds-goal-phase">phase: ${esc(goal.phase || '?')} · revision ${goal.revision ?? '?'}</div>
        <div class="ds-goal-actions">
          ${goal.phase === 'active' ? `<button class="ds-mini-btn" data-goal="pause">${t('goal.pause')}</button>` : `<button class="ds-mini-btn" data-goal="resume">${t('goal.resume')}</button>`}
          <button class="ds-mini-btn" data-goal="complete">${t('goal.complete')}</button>
          <button class="ds-mini-btn" data-goal="edit">${t('goal.edit')}</button>
          <button class="ds-mini-btn" data-goal="clear">${t('goal.clear')}</button>
        </div>
      </div>
      <button type="button" class="ds-goal-side-tab${collapsed ? '' : ' hidden'}" data-goal-collapse="0" aria-expanded="false" aria-controls="goal-panel-desktop" aria-label="${esc(t('goal.expand'))}" title="${esc(t('goal.expand'))}"><span aria-hidden="true">‹</span><span>${t('goal.title')}</span><small>${t('goal.collapsedHint')}</small></button>
    </div>`
  }
  if (todos?.items?.length) {
    html += `<div class="ds-card"><div class="ds-card-title">${t('todos.title')}</div>${todos.items.map(item =>
      `<div class="ds-todo-row"><span class="ds-pill ${item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'active' : ''}">${esc(item.status || 'pending')}</span><span>${esc(item.content || '')}</span></div>`
    ).join('')}</div>`
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
  if (!goal) return toast(t('goal.none'), 'err')
  const ref = { id: goal.id, revision: goal.revision }
  if (kind === 'edit') {
    const objective = prompt(t('goal.editPrompt'), goal.objective || '')
    if (objective === null) return
    if (!objective.trim()) return toast(t('goal.cannotEmpty'), 'err')
    const result = await safeRpc('goal.edit', { sessionId, ref, objective: objective.trim() }, t('goal.updateFailed'))
    if (result == null || !valid()) return
    toast(t('goal.updated'), 'ok')
    refreshSessions()
    renderSessionCards()
    return
  }
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
  refreshSessions()
  renderSessionCards()
}

async function interruptSubagent(childId, parentId = state.current) {
  const connection = captureConnection(), rootId = state.current
  if (!confirm(t('subagent.confirmInterrupt'))) return
  const result = await safeRpc('subagent.interrupt', { parentSessionId: parentId, childSessionId: childId, mode: 'continuable' }, t('subagent.interruptFailed'))
  if (result == null || !connection.valid() || state.current !== rootId) return
  toast(t('subagent.interruptSubmitted'), 'ok')
  setTimeout(renderSessionCards, 600)
}

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

async function downloadSessionExport(sessionId) {
  const connection = captureConnection()
  const url = new URL(apiUrl('/api/session.export'), location.href)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('includeDescendants', 'true')
  if (state.token && (state.server || !(location.pathname === '/remote' || location.pathname.startsWith('/remote/')))) url.searchParams.set('token', state.token)
  const headers = state.token ? { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() } : {}
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS)
      : undefined
    const preflight = await fetch(url, { method: 'HEAD', headers, ...(signal ? { signal } : {}) })
    if (!connection.valid()) return
    if (preflight.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
    if (!preflight.ok) throw new Error('HTTP ' + preflight.status)
    const anchor = document.createElement('a')
    anchor.href = url.href
    anchor.download = sessionLogFilename(sessionId)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    toast(t('ds.exportStarted'), 'ok')
  } catch (e) {
    console.error('session export download failed', e)
    toast(t('ds.exportFailed', { msg: e?.message || '' }), 'err')
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
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() },
      body: JSON.stringify({ sessionId, line: clean, async: true }),
      signal: AbortSignal.timeout(command === 'export' ? LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS : SLASH_COMMAND_TIMEOUT_MS),
    })
    if (!connection.valid() || (state.current !== sessionId && command !== 'compact' && command !== 'export')) return !requireExecuted
    if ([404, 405].includes(res.status) && !noFallback) return false
    if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return !requireExecuted }
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
    else if (!requireExecuted) toast(t('ds.commandExecuted'), 'ok')
    return true
  } catch (error) {
    if (!connection.valid() || state.current !== sessionId) return !requireExecuted
    if (!requireExecuted) toast(t('ds.commandTimedOut'), 'err')
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

async function sendMessage(requestedMode = 'queue') {
  if (state.byId.get(state.current)?.origin === 'subagent') { toast('子代理记录为只读 / Subagent records are read only'); return false }
  const input = $('composer')
  const originalText = input.value, text = originalText.trim()
  if (!text || !state.current) return
  const sessionId = state.current, connection = captureConnection(), history = state.history
  const pending = sendMessage.pending ||= new Set()
  if (pending.has(history)) return
  pending.add(history)
  const valid = () => connection.valid() && state.current === sessionId && state.history === history
  try {
    state.sessionActivity.add(sessionId)
    if (await runSlashCommand(text)) { if (valid() && input.value === originalText) input.value = ''; return }
    if (!valid()) return
    setSessionRecovery('resuming')
    const v = await safeRpc('session.prompt', {
      sessionId,
      mode: requestedMode === 'steer' && state.byId.get(sessionId)?.running ? 'steer' : 'queue',
      content: [{ type: 'text', text }]
    }, '')
    if (!valid()) return
    if (v?.accepted) {
      if (input.value === originalText) input.value = ''
      setSessionRecovery('ready'); noteSessionTurnTime(sessionId, Date.now()); renderSessions(); toast(t('ds.toastSent'), 'ok')
    }
    else setSessionRecovery('error')
  } finally { pending.delete(history); window.DshWorkflow?.update() }
}

async function cancelSession() {
  if (!state.current) return
  if (!confirm(t('ds.sessionStopConfirm'))) return
  const sessionId = state.current, connection = captureConnection()
  const v = await safeRpc('session.cancel', { sessionId }, t('ds.sessionStopFailed'))
  if (!connection.valid() || state.current !== sessionId) return
  if (v?.accepted) { setSessionRecovery('ready'); toast(t('ds.sessionStopRequested'), 'ok') }
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
  const connection = captureConnection()
  const title = $('rename-session-input').value.trim()
  if (!title) return toast(t('ds.sessionRenameEmpty'), 'err')
  const button = $('rename-confirm')
  button.disabled = true
  setSessionRecovery('resuming')
  try {
    const value = await safeRpc('session.rename', { sessionId, title }, t('ds.sessionRenameFailed'))
    if (!connection.valid() || renamePendingSessionId !== sessionId) return
    if (value == null) { setSessionRecovery('error'); return }
    if (value.title) applyProjection(sessionId, 'title', value.title, value.seq)
    closeRenameSession()
    setSessionRecovery('ready')
    toast(t('ds.sessionRenamed'), 'ok')
    await refreshSessions()
  } finally {
    button.disabled = false
  }
}

async function archiveCurrentSession() {
  const sessionId = state.current
  if (!sessionId || !confirm(t('ds.sessionArchiveConfirm'))) return
  const connection = captureConnection()
  const value = await safeRpc('workspace.archiveSession', { sessionId }, t('ds.toastOpFailed'))
  if (!value || !connection.valid()) return
  if (Array.isArray(value.archivedSessionIds)) state.archivedIds = value.archivedSessionIds
  toast(t('ds.sessionArchived'), 'ok')
  if (state.current === sessionId) await closeSession()
  await refreshSessions()
}

function updateComposerStatus() {
  window.DshWorkflow?.update()
  const status = $('composer-status')
  if (!status) return
  const compact = activeCompaction()
  status.classList.toggle('hidden', !state.byId.get(state.current)?.running && !compact)
  status.classList.toggle('compacting', !!compact)
  const text = $('composer-status-text')
  if (text) text.textContent = compact
    ? (compact.command === 'compact'
        ? t('ds.compacting', { elapsed: compactElapsed(compact.startedAt) })
        : t('ds.commandRunning', { command: compact.command, elapsed: compactElapsed(compact.startedAt) }))
    : t('ds.composerRunning')
  updateSessionActions()
}
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
  const box = $('queue-dock')
  if (!box) return
  const sessionId = state.current
  const s = state.byId.get(sessionId)
  const items = (state.queues[sessionId] || []).filter(item => item?.placement === 'queued')
  box.classList.toggle('hidden', !items.length)
  box.innerHTML = items.length ? `<div class="ds-queue-dock-head"><span>⌁</span><span>${esc(t('queue.title'))} · ${items.length}</span></div><div class="ds-queue-dock-list">${items.map(item => {
    const key = `${sessionId}:${item.id}`
    const busy = !!state.queueSteering[key]
    return `<div class="ds-queue-dock-item"><span class="ds-queue-dock-preview" title="${esc(queuePreview(item))}">${esc(queuePreview(item))}</span><button type="button" class="ds-mini-btn ds-queue-dock-action" data-queue-steer="${esc(item.id)}" title="${esc(s?.running ? t('queue.steer') : t('queue.steerUnavailable'))}" ${s?.running && !busy ? '' : 'disabled'}>${busy ? '…' : esc(t('queue.steer'))}</button></div>`
  }).join('')}</div>` : ''
  box.querySelectorAll('[data-queue-steer]').forEach(button => {
    button.addEventListener('click', () => steerQueueItem(button.dataset.queueSteer))
  })
  updateComposerStatus()
}

/* ---------------- 审批/提问通知卡片栈 ---------------- */
function serverLabel() {
  const cur = currentServerEntry()
  return cur ? (cur.note || cur.url) : (state.server || location.host)
}
function desktopApprovalDetail(a) {
  const lines = []
  if (a?.reason) lines.push(String(a.reason))
  if (a?.arguments !== undefined) lines.push(safeJson(a.arguments))
  if (a?.callId) lines.push(`callId: ${a.callId}`)
  return lines.join('\n') || t('ds.approvalReason', { reason: '' })
}
function renderSessionPendingDesktop() {
  const box = $('session-pending')
  if (!box) return
  const sessionId = state.current
  const items = [
    ...state.approvals.filter(a => a.sessionId === sessionId).map(a => ({ kind: 'approval', item: a })),
    ...state.questions.filter(q => q.sessionId === sessionId).map(q => ({ kind: 'question', item: q }))
  ]
  box.classList.toggle('hidden', !sessionId || !items.length)
  if (!sessionId || !items.length) { box.innerHTML = ''; return }
  box.innerHTML = `<div class="ds-session-pending-head"><span>${esc(t('ds.attention'))}</span><span>${items.length}</span></div><div class="ds-session-pending-list">${items.map(({ kind, item }) => {
    if (kind === 'approval') return `<article class="ds-notif-card" data-session-approval="${esc(item.approvalId)}">
      <div class="ds-notif-head">🔐 ${t('ds.approvalTitle')}</div>
      <div class="ds-notif-title">${esc(item.toolName || t('ds.toolDefault'))}</div>
      <div class="ds-notif-body">${esc(desktopApprovalDetail(item))}</div>
      <div class="ds-notif-actions"><button type="button" class="ds-btn allow" data-session-approve="1">${t('ds.allow')}</button><button type="button" class="ds-btn reject" data-session-approve="0">${t('ds.reject')}</button></div>
    </article>`
    return `<button type="button" class="ds-notif-card question" data-session-question="${esc(item.rpcId)}" aria-haspopup="dialog">
      <span class="ds-question-card-head"><span class="ds-notif-head">❓ ${esc(item.questions?.[0]?.header || t('ds.questionNotify'))}</span><span class="ds-btn">${t('ds.submit')}</span></span>
      <span class="ds-question-summary">${esc(questionSummary(item))}</span>
    </button>`
  }).join('')}</div>`
  box.querySelectorAll('[data-session-approve]').forEach(button => button.addEventListener('click', () => approveApproval(button.closest('[data-session-approval]')?.dataset.sessionApproval || '', button.dataset.sessionApprove === '1')))
  box.querySelectorAll('[data-session-question]').forEach(button => button.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === button.dataset.sessionQuestion))))
}
/* ---------------- 审批记录 ---------------- */
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
  renderApprovalRecordsDesktop()
  return true
}
function renderApprovalRecordsDesktop() {
  const box = $('ds-approval-records-list')
  if (!box) return
  ensureApprovalRecords()
  const api = window.DshApprovalRecords
  const rows = api ? api.list(state.approvalRecords, 8) : []
  const count = $('ds-approval-records-count')
  if (count) count.textContent = rows.length ? t('ds.pendingCount', { n: rows.length }) : '—'
  box.innerHTML = rows.length
    ? rows.map(record => api.recordHtml(record, t, { session: titleOf(state.byId.get(record.sessionId)) })).join('')
    : '<div class="empty">' + t('approval.recordsEmpty') + '</div>'
}

function renderNotifStack() {
  const stack = $('notif-stack')
  const items = [
    ...state.approvals.map(a => ({ kind: 'approval', a })),
    ...state.questions.map(q => ({ kind: 'question', q }))
  ]
  stack.innerHTML = items.map(it => {
    if (it.kind === 'approval') {
      const a = it.a
      const reason = desktopApprovalDetail(a)
      return `<div class="ds-notif-card" data-approval="${esc(a.approvalId)}" tabindex="0">
        <div class="ds-notif-head">🔐 ${t('ds.approvalTitle')} · ${esc(serverLabel())} · ${fmtTime(a.time || Date.now())}</div>
        <div class="ds-notif-title">${esc(a.toolName || t('ds.toolDefault'))}</div>
        <div class="ds-notif-body">${esc(reason.slice(0, 500))}</div>
        <div class="ds-notif-actions">
          <button class="ds-btn allow" data-approve="1">${t('ds.allow')}</button>
          <button class="ds-btn reject" data-approve="0">${t('ds.reject')}</button>
          <button class="ds-btn" data-ignore-approval>${t('ds.ignore')}</button>
        </div>
      </div>`
    }
    const q = it.q
    const text = q.questions?.map(x => x.question).join(' / ') || ''
    return `<div class="ds-notif-card question" data-question="${esc(q.rpcId)}" tabindex="0">
      <div class="ds-notif-head">❓ ${t('ds.questionNotify')} · ${esc(serverLabel())} · ${fmtTime(q.time || Date.now())}</div>
      <div class="ds-notif-title">${esc(text.slice(0, 120))}</div>
      <div class="ds-notif-actions">
        <button class="ds-btn" data-open-question>${t('ds.submit')}</button>
        <button class="ds-btn" data-ignore-question>${t('ds.ignore')}</button>
      </div>
    </div>`
  }).join('')
  stack.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => approveApproval(b.closest('[data-approval]')?.dataset.approval || '', b.dataset.approve === '1')))
  stack.querySelectorAll('[data-ignore-approval]').forEach(b => b.addEventListener('click', () => { toast(t('ds.ignored'), 'ok') }))
  stack.querySelectorAll('[data-open-question]').forEach(b => b.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === b.closest('[data-question]')?.dataset.question))))
  stack.querySelectorAll('[data-ignore-question]').forEach(b => b.addEventListener('click', () => { toast(t('ds.ignored'), 'ok') }))
  // Esc 忽略最上方卡片
  stack.querySelectorAll('.ds-notif-card').forEach(card => card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toast(t('ds.ignored'), 'ok')
  }))
  renderSessionPendingDesktop()
  renderOverviewDesktop()
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
    if (e.message === 'AUTH') toast(t('ds.toastAuth'), 'err')
    else toast(t('ds.pendingSubmitFailed', { msg: e.message || t('ds.feedbackNetworkError') }), 'err')
    return
  }
  if (!connection.valid()) return
  toast(ok ? (allow ? t('ds.allowed') : t('ds.rejected')) : t('ds.stale'), ok ? 'ok' : 'err')
  state.approvals = state.approvals.filter(x => x.rpcId !== a.rpcId)
  renderNotifStack()
}
function questionSummary(q) {
  return (q.questions || []).map(item => String(item.question || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`#>]/g, '')).join(' / ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function questionMarkup(item) {
  const text = String(item.question || '')
  return (item.header ? `<strong>${esc(item.header)}</strong>` : '') + (window.mdToHtml ? window.mdToHtml(text, { richContent: false, fileLinks: true }) : esc(text))
}

function openQuestionModal(q) {
  if (!q) return
  state.questionModal = q
  $('question-body').innerHTML = q.questions.map((item, i) => `
    <div class="ds-q-item">
      <div class="ds-q-text md">${questionMarkup(item)}</div>
      ${(item.options || []).map((o, j) => `
        <label class="ds-q-option"><input type="${item.multiSelect ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description ? `<div class="muted">${esc(o.description)}</div>` : ''}</span></label>`).join('')}
      <textarea rows="2" placeholder="${t('ds.questionCustom')}" data-qcustom="${i}"></textarea>
    </div>`).join('')
  $('modal-question').classList.remove('hidden')
  $('question-body').scrollTop = 0
}
async function submitQuestion() {
  const connection = captureConnection()
  const q = state.questionModal
  if (!q) return
  const answers = q.questions.map((item, i) => {
    const sel = [...$('question-body').querySelectorAll(`input[name="q${i}"]:checked`)].map(x => x.value)
    const custom = $('question-body').querySelector(`[data-qcustom="${i}"]`)?.value?.trim()
    const ans = { id: item.id, selected: sel }
    if (custom) ans.custom = custom
    if (!sel.length && !custom) return null
    return ans
  }).filter(Boolean)
  if (!answers.length) return toast(t('ds.questionNeedAnswer'), 'err')
  let ok
  try {
    ok = await respond(q.rpcId, { sessionId: q.sessionId, answer: { answers } })
  } catch (e) {
    if (!connection.valid()) return
    if (e.message === 'AUTH') toast(t('ds.toastAuth'), 'err')
    else toast(t('ds.pendingSubmitFailed', { msg: e.message || t('ds.feedbackNetworkError') }), 'err')
    return
  }
  if (!connection.valid()) return
  if (ok) {
    toast(t('ds.questionSubmitted'), 'ok')
    if (state.questionModal === q) { $('modal-question').classList.add('hidden'); state.questionModal = null }
    state.questions = state.questions.filter(x => x.rpcId !== q.rpcId)
    renderNotifStack()
  } else toast(t('ds.stale'), 'err')
}

/* ---------------- 文件传输 ---------------- */
function fsApiUrl(sub, params = {}) {
  const u = new URL(apiUrl('/fs' + sub), location.href)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, v)
  }
  return u.href
}
function fsHeaders() {
  return { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() }
}

/** Local image paths inside Markdown: resolve relative to the open session workspace. */
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
function fsParent(p) {
  const meta = fsPathMeta(p)
  if (!meta.value) return null
  if (meta.root && fsPathEqual(meta.value, meta.root)) return meta.root
  const idx = meta.value.lastIndexOf(meta.separator)
  if (idx < 0) return meta.root || null
  const parent = meta.value.slice(0, idx)
  return meta.root && parent.length < meta.root.length ? meta.root : (parent || meta.root)
}
function fsJoin(dir, name) {
  const meta = fsPathMeta(dir)
  if (!meta.value) return String(name || '')
  return meta.value.endsWith(meta.separator) ? meta.value + name : meta.value + meta.separator + name
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
function fsPathEqual(left, right) { return fsPathKey(left) === fsPathKey(right) }
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
function resetFsForServerDesktop() {
  state.fs.path = null
  state.fs.initial = null
  state.fs.loaded = false
  state.fs.roots = []
  state.fs.rootIndex = 0
  const select = $('fs-root')
  if (select) select.classList.add('hidden')
}
async function openWorkspaceModal() {
  const connection = captureConnection()
  if (!state.token) { toast(t('ds.toastAuth'), 'err'); showView('view-settings'); return }
  if (!state.fs.path) await loadFs(null, true)
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
  if (!name) { toast(t('ds.workspaceNameRequired'), 'err'); $('workspace-name').focus(); return }
  const connection = captureConnection()
  createWorkspace.busy = true
  const parent = state.fs.path || ''
  const button = $('workspace-create')
  button.disabled = true
  try {
    const res = await fetch(fsApiUrl('/mkdir', { path: parent, name }), { method: 'POST', headers: fsHeaders() })
    if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
    const data = await res.json().catch(() => ({}))
    if (!connection.valid()) return
    if (!res.ok) {
      const msg = data.error === 'exists' ? t('ds.workspaceExists') : data.error === 'bad-name' ? t('ds.workspaceInvalidName') : data.error || ('HTTP ' + res.status)
      throw new Error(msg)
    }
    closeWorkspaceModal()
    await loadFs(parent || null, true)
    if (!connection.valid()) return
    let workspace = null
    try {
      const created = await rpc('workspace.create', { path: data.path })
      if (!connection.valid()) return
      workspace = created?.workspace || null
    } catch {}
    if (!connection.valid()) return
    if (workspace?.workspaceId) {
      state.workspaces = [...state.workspaces.filter(item => item.workspaceId !== workspace.workspaceId), workspace]
    }
    const sessionPayload = workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : { cwd: data.path }
    const v = await safeRpc('session.create', { ...sessionPayload, ...preset.payload }, t('ds.toastOpFailed'))
    if (!connection.valid()) return
    await refreshSessions()
    if (!connection.valid()) return
    if (v?.sessionId) {
      if (workspace?.workspaceId) LS.set('lastNewSessionWorkspaceV1', workspace.workspaceId)
      toast(t('ds.workspaceCreated'), 'ok')
      openSession(v.sessionId)
    } else {
      toast(t('ds.workspaceCreatedNoSession'), 'ok')
    }
  } catch (e) {
    if (!connection.valid()) return
    toast(`${t('ds.workspaceCreateFailed')}：${e.message || t('ds.feedbackNetworkError')}`, 'err')
  } finally {
    createWorkspace.busy = false
    button.disabled = false
  }
}
async function loadFs(dir, silent) {
  const connection = captureConnection(), request = ++filesRequest
  const valid = () => connection.valid() && request === filesRequest
  if (!state.token) {
    $('fs-path').textContent = t('ds.toastAuth')
    $('fs-list').innerHTML = `<div class="ds-empty">${t('ds.toastAuth')}</div>`
    return
  }
  const target = dir ?? state.fs.path ?? ''
  if (!silent) {
    $('fs-list').innerHTML = `<div class="ds-empty">${t('ds.loading')}</div>`
    $('fs-path').textContent = target ? '…' + target.slice(-40) : t('ds.loading')
  }
  try {
    const res = await fetch(fsApiUrl('/list', target ? { path: target } : {}), { headers: fsHeaders() })
    if (!valid()) return
    if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
    const data = await res.json().catch(() => ({}))
    if (!valid()) return
    if (!res.ok || !Array.isArray(data.entries)) throw new Error(data.error || ('HTTP ' + res.status))
    state.fs.path = data.path
    if (!state.fs.initial) state.fs.initial = data.path
    if (Array.isArray(data.roots) && data.roots.length) state.fs.roots = data.roots.map(value => String(value || '')).filter(Boolean)
    if (!state.fs.roots.length) state.fs.roots = [data.path]
    const rootIndex = state.fs.roots.findIndex(root => fsPathInside(data.path, root))
    if (rootIndex >= 0) state.fs.rootIndex = rootIndex
    state.fs.loaded = true
    renderFsRootsDesktop()
    $('fs-path').textContent = data.path
    $('fs-list').innerHTML = (data.entries || []).map(e => `
      <div class="ds-fs-row" data-fs-path="${esc(e.path || fsJoin(data.path, e.name))}" data-fs-dir="${e.type === 'dir' ? '1' : '0'}">
        <span class="ds-fs-type">${desktopFsIconSvg(e.type === 'dir')}</span>
        <span class="ds-fs-name">${esc(e.name)}</span>
        <span class="ds-fs-size">${e.type === 'dir' ? '' : fmtSize(e.size)}</span>
      </div>`).join('') || `<div class="ds-empty">${t('ds.fsEmpty')}</div>`
    $('fs-list').querySelectorAll('[data-fs-path]').forEach(row => row.addEventListener('click', () => {
      if (row.dataset.fsDir === '1') loadFs(row.dataset.fsPath)
      else window.open(fsApiUrl('/file', { path: row.dataset.fsPath, token: state.token }), '_blank')
    }))
  } catch (e) {
    if (!valid()) return
    $('fs-path').textContent = target || '~'
    $('fs-list').innerHTML = `<div class="ds-empty">${esc(e.message || t('ds.toastConnFailed'))}</div>`
  }
}

function renderFsRootsDesktop() {
  const select = $('fs-root')
  if (!select) return
  select.classList.toggle('hidden', state.fs.roots.length <= 1)
  select.innerHTML = state.fs.roots.map((root, index) => `<option value="${index}"${index === state.fs.rootIndex ? ' selected' : ''}>${esc(root)}</option>`).join('')
}

function desktopFsIconSvg(isDir) {
  return isDir
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5h6l2 2H20a1 1 0 0 1 1 1v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a1 1 0 0 1 .5-1Z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5v4h4M8 13h8M8 16h6"/></svg>'
}
function fsUp() {
  if (!state.fs.path || !state.fs.initial) return
  const parent = fsParent(state.fs.path)
  if (fsPathEqual(state.fs.path, state.fs.initial) || !fsPathInside(parent, state.fs.initial)) return
  loadFs(parent)
}

/* ---------------- 工作台绑定 / 项目会话 ---------------- */
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
function workspaceItems() {
  return (state.workspaces || []).filter(w => w && typeof w.workspaceId === 'string' && w.workspaceId && typeof w.path === 'string' && w.path)
}
function workspaceById(workspaceId) {
  return workspaceItems().find(w => w.workspaceId === workspaceId) || null
}
function workspaceName(workspace) {
  return String(workspace?.title || wbBaseName(workspace?.path) || workspace?.path || '').trim()
}
function workspaceOptionLabel(workspace) {
  const name = workspaceName(workspace)
  return workspace.path && workspace.path !== name ? `${name} — ${workspace.path}` : name
}
function workspaceOptionsHtml(selected = '') {
  return workspaceItems().map(workspace => `<option value="${esc(workspace.workspaceId)}"${workspace.workspaceId === selected ? ' selected' : ''}>${esc(workspaceOptionLabel(workspace))}</option>`).join('')
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
function wbFsParent(p) {
  if (!p) return null
  const raw = String(p)
  const separator = raw.includes('\\') ? '\\' : '/'
  const index = raw.lastIndexOf(separator)
  if (index <= 0 || /^[A-Za-z]:$/.test(raw.slice(0, index))) return null
  return raw.slice(0, index)
}
async function wbGateway(method, pathname, body) {
  const options = { method, headers: { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() } }
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json'
    options.body = JSON.stringify(body)
  }
  const res = await fetch(apiUrl(pathname), options)
  if (res.status === 401) throw new Error('AUTH')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
  return data
}
const WORKBENCH_ORDER_CACHE_KEY = 'workbenchOrderV1'
function workbenchOrderScope() { return String(state.server || location.origin || 'default') }
function workbenchOrderStore() {
  let value = null
  try { value = JSON.parse(LS.get(WORKBENCH_ORDER_CACHE_KEY, '{}')) } catch {}
  if (!value || typeof value !== 'object') value = {}
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
  LS.set(WORKBENCH_ORDER_CACHE_KEY, JSON.stringify(store))
}
function commitWorkspaceOrder(order) {
  saveWorkbenchOrder(value => { value.workspaceIds = order.map(String) })
  renderWorkbench()
  toast(t('ds.wbOrderSaved'), 'ok')
}
function commitWorkspaceSessionOrder(workspaceId, order) {
  if (!workspaceId) return
  saveWorkbenchOrder(value => {
    value.sessionIds ||= {}
    value.sessionIds[String(workspaceId)] = order.map(String)
  })
  renderWorkbench()
  toast(t('ds.wbOrderSaved'), 'ok')
}
async function refreshWorkbench({ silent = false, discover = false } = {}) {
  const connection = captureConnection(), request = ++workbenchRequest
  const valid = () => connection.valid() && request === workbenchRequest
  const sharedRead = (name, read) => window.DshNetwork?.shareRead ? window.DshNetwork.shareRead(JSON.stringify([connection.server, connection.token, name]), read) : read()
  if (!state.token) { renderWorkbench(); return }
  const workspaceRead = sharedRead('workspace.list', () => connection.valid() ? safeRpc('workspace.list', {}, '') : null)
  let wb = null
  try {
    wb = await sharedRead('workbench', () => connection.valid() ? wbGateway('GET', '/workbench') : null)
    if (!valid()) return
    state.wb.apiMissing = false
  } catch (e) {
    if (!valid()) return
    if (e.message === 'AUTH') { toast(t('ds.toastAuth'), 'err'); return }
    if (!silent) toast(t('wb.loadFailed', { msg: e.message }), 'err')
    if (!state.wb.bound && /404/.test(e.message)) state.wb.apiMissing = true
  }
  const wl = await workspaceRead
  if (!valid()) return
  if(wl){
    state.archivedIds = Array.isArray(wl.archivedSessionIds) ? wl.archivedSessionIds : []
    state.workspaces = Array.isArray(wl.items) ? wl.items.slice() : []
  }
  if (!wb) { renderWorkbench(); renderSessions(); return }
  if (!wb.bound) {
    state.wb = { bound: false, path: '', title: '', expanded: false, projects: null, open: null, apiMissing: false }
    renderWorkbench()
    renderSessions()
    return
  }
  state.wb.bound = true
  state.wb.path = wb.path || ''
  state.wb.title = wb.title || ''
  if (!wl) { renderWorkbench(); renderSessions(); return }
  const items = Array.isArray(wl.items) ? wl.items.slice() : []
  if (discover) try {
    const listRes = await fetch(fsApiUrl('/list', { path: state.wb.path }), { headers: fsHeaders() })
    if (!valid()) return
    if (listRes.ok) {
      const listData = await listRes.json().catch(() => ({}))
      if (!valid()) return
      if (Array.isArray(listData.entries)) {
        const diskDirs = new Set(listData.entries.filter(e => e.type === 'dir').map(e => wbPathKey(wbJoin(state.wb.path, e.name))))
        for (let i = items.length - 1; i >= 0; i--) {
          if (!diskDirs.has(wbPathKey(items[i].path))) items.splice(i, 1)
        }
        const have = new Set(items.map(w => wbPathKey(w.path)))
        for (const entry of listData.entries) {
          if (entry.type !== 'dir') continue
          const projectPath = wbJoin(state.wb.path, entry.name)
          if (have.has(wbPathKey(projectPath))) continue
          try {
            const created = await rpc('workspace.create', { path: projectPath })
            if (!valid()) return
            if (created?.workspace) {
              items.push(created.workspace)
              state.workspaces.push(created.workspace)
              have.add(wbPathKey(projectPath))
            }
          } catch {}
          if (!valid()) return
        }
      }
    }
  } catch {}
  if (!valid()) return
  state.wb.projects = orderedWorkspaceItems(items
    .filter(w => wbStrictInside(w.path, state.wb.path))
    .sort((a, b) => String(a.title || wbBaseName(a.path)).localeCompare(String(b.title || wbBaseName(b.path)), 'zh-CN', { numeric: true })))
  renderWorkbench()
  renderSessions()
}
function renderWorkbench() {
  const box = $('workbench-box')
  if (!box) return
  const unbound = $('wb-unbound')
  const bound = $('wb-bound')
  const hint = $('wb-api-hint')
  if (!state.wb.bound) {
    unbound.classList.remove('hidden')
    bound.classList.add('hidden')
    hint?.classList.toggle('hidden', !state.wb.apiMissing)
    return
  }
  unbound.classList.add('hidden')
  bound.classList.remove('hidden')
  $('wb-head-text').textContent = t('wb.bound', { title: state.wb.title || wbBaseName(state.wb.path) })
  $('wb-head').setAttribute('aria-expanded', state.wb.expanded ? 'true' : 'false')
  $('wb-caret').textContent = state.wb.expanded ? '▾' : '▸'
  const panel = $('wb-panel')
  panel.classList.toggle('hidden', !state.wb.expanded)
  if (!state.wb.expanded) return
  const projects = orderedWorkspaceItems(state.wb.projects || [])
  const archivedSet = new Set(state.archivedIds || [])
  let html = `<div class="ds-wb-panel-title">${esc(t('wb.projects'))}</div>`
  html += projects.length ? projects.map(w => {
    const id = String(w.workspaceId || '')
    const sessions = orderedWorkspaceSessions(id, (w.sessionIds || []).map(sid => state.byId.get(sid)).filter(isVisibleSession).filter(s => !archivedSet.has(s.sessionId)).sort((a, b) => sessionSortTime(b) - sessionSortTime(a)))
    const open = state.wb.open === id
    return `<div class="ds-wb-project ${open ? 'open' : ''}" data-wb-project="${esc(id)}" data-motion-key="${esc(id)}">
      <button type="button" class="ds-wb-project-head" data-wb-head="${esc(id)}">
        <span class="ds-wb-drag-handle" data-reorder-handle aria-hidden="true">⠿</span>
        <span class="ds-wb-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="ds-wb-project-title" title="${esc(w.path)}">${esc(w.title || wbBaseName(w.path) || short(id))}</span>
        <span class="ds-wb-project-count">${sessions.length}</span>
      </button>
      <div class="ds-wb-project-body ${open ? '' : 'hidden'}">
        <button type="button" class="ds-mini-btn ds-wb-new-session" data-wb-new="${esc(id)}">+ ${esc(t('wb.newSession'))}</button>
        ${sessions.length ? sessions.map(s => `<button type="button" class="ds-wb-session ${state.current === s.sessionId ? 'current' : ''}" data-wb-session="${esc(s.sessionId)}" data-motion-key="${esc(s.sessionId)}"><span class="ds-wb-session-drag-handle" data-reorder-handle aria-hidden="true">⠿</span><span class="ds-wb-session-dot ${s.running ? 'running' : ''}"></span><span class="ds-wb-session-title">${esc(sessionLabelOf(s))}</span></button>`).join('') : `<div class="ds-wb-session-empty">${esc(t('wb.noSessions'))}</div>`}
      </div>
    </div>`
  }).join('') : `<div class="ds-wb-empty">${esc(t('wb.noProjects'))}</div>`
  html += `<button type="button" class="ds-mini-btn ds-wb-unbind-panel" data-wb-unbind-panel>${esc(t('wb.unbind'))}</button>`
  if (window.DshMotion?.relayout) {
    window.DshMotion.relayout(panel, '.ds-wb-project', () => { panel.innerHTML = html })
  } else panel.innerHTML = html
  window.DshMotion?.list(panel, '.ds-wb-session')
  window.DshMotion?.bindLongPressReorder(panel, '.ds-wb-project', {
    handleSelector: '.ds-wb-project-head',
    excludeSelector: '[data-wb-new]',
    onCommit: ({ order }) => commitWorkspaceOrder(order)
  })
  window.DshMotion?.bindLongPressReorder(panel, '.ds-wb-session', {
    groupSelector: '.ds-wb-project',
    handleSelector: '.ds-wb-session',
    onCommit: ({ item, order }) => commitWorkspaceSessionOrder(item.closest('[data-wb-project]')?.dataset.wbProject, order)
  })
  panel.querySelectorAll('[data-wb-head]').forEach(button => button.addEventListener('click', () => {
    state.wb.open = state.wb.open === button.dataset.wbHead ? null : button.dataset.wbHead
    renderWorkbench()
  }))
  panel.querySelectorAll('[data-wb-new]').forEach(button => button.addEventListener('click', async () => {
    void openNewSessionModal(button.dataset.wbNew)
  }))
  panel.querySelectorAll('[data-wb-session]').forEach(button => button.addEventListener('click', () => openSession(button.dataset.wbSession)))
  panel.querySelectorAll('[data-wb-unbind-panel]').forEach(button => button.addEventListener('click', unbindWorkbench))
}
function renderNewSessionWorkspace(preferredId = '') {
  const items = workspaceItems()
  const select = $('new-session-workspace')
  if (!select) return
  const current = workspaceById(preferredId || select.value)?.workspaceId || items[0]?.workspaceId || ''
  select.innerHTML = workspaceOptionsHtml(current)
  select.disabled = !items.length
  const workspace = workspaceById(select.value)
  $('new-session-workspace-name').textContent = workspace ? workspaceName(workspace) : ''
  $('new-session-workspace-path').textContent = workspace?.path || ''
  $('new-session-empty').classList.toggle('hidden', !!items.length)
  $('new-session-create').disabled = !workspace
}
function loadSessionPresets(prefix) {
  return window.DshSessionPresets.open({select:$(prefix+'-agent-preset'),hint:$(prefix+'-agent-preset-hint'),rpc,connection:captureConnection()})
}
async function openNewSessionModal(preferredWorkspace = '') {
  if (!state.token) return showView('view-settings')
  if (!workspaceItems().length) await refreshWorkbench({ silent: true })
  renderNewSessionWorkspace(typeof preferredWorkspace === 'string' && preferredWorkspace || LS.get('lastNewSessionWorkspaceV1', ''))
  void loadSessionPresets('new-session')
  $('modal-new-session').classList.remove('hidden')
  setTimeout(() => $('new-session-workspace')?.focus(), 50)
}
function closeNewSessionModal() { $('modal-new-session').classList.add('hidden') }
async function createSessionInWorkspace() {
  if (createSessionInWorkspace.busy) return
  const connection = captureConnection()
  const workspaceId = $('new-session-workspace').value
  if (!workspaceById(workspaceId)) return toast(t('ds.newSessionChooseWorkspace'), 'err')
  const preset = window.DshSessionPresets.selection($('new-session-agent-preset'))
  if (!preset.valid) return toast(window.DshSessionPresets.staleMessage(), 'err')
  createSessionInWorkspace.busy = true
  const button = $('new-session-create')
  button.disabled = true
  try {
    const value = await safeRpc('session.create', { workspaceId, ...preset.payload }, '')
    if (!connection.valid() || !value?.sessionId) return
    LS.set('lastNewSessionWorkspaceV1', workspaceId)
    closeNewSessionModal()
    const workspace = workspaceById(workspaceId)
    const session = { sessionId: value.sessionId, cwd: workspace?.path || '', running: false, projections: { values: {} } }
    state.byId.set(session.sessionId, session)
    state.sessions.unshift(session)
    void openSession(session.sessionId)
    void refreshSessions()
  } finally {
    createSessionInWorkspace.busy = false
    button.disabled = false
  }
}
const wbFs = { path: null, initial: null }
function openWorkbenchModal() {
  $('modal-workbench').classList.remove('hidden')
  wbFs.path = null
  wbFs.initial = null
  wbFsLoad(null)
  setTimeout(() => $('wb-path-input').focus(), 50)
}
function closeWorkbenchModal() { wbFs.request = (wbFs.request || 0) + 1; $('modal-workbench').classList.add('hidden') }
async function wbFsLoad(dir) {
  const connection = captureConnection(), request = wbFs.request = (wbFs.request || 0) + 1
  const valid = () => connection.valid() && request === wbFs.request
  const box = $('wb-fs-list')
  const target = dir ?? wbFs.path ?? ''
  box.innerHTML = `<div class="ds-empty">${esc(t('ds.loading'))}</div>`
  $('wb-fs-path').textContent = target ? '…' + target.slice(-40) : '~'
  try {
    const res = await fetch(fsApiUrl('/list', target ? { path: target } : {}), { headers: fsHeaders() })
    const data = await res.json().catch(() => ({}))
    if (!valid()) return
    if (!res.ok || !Array.isArray(data.entries)) throw new Error(data.error || ('HTTP ' + res.status))
    wbFs.path = data.path
    if (!wbFs.initial) wbFs.initial = data.path
    $('wb-fs-path').textContent = data.path
    const dirs = (data.entries || []).filter(e => e.type === 'dir')
    box.innerHTML = dirs.length ? dirs.map(e => {
      const p = wbJoin(data.path, e.name)
      return `<div class="ds-wb-fs-row" data-wb-dir="${esc(p)}"><span class="ds-fs-type">${desktopFsIconSvg(true)}</span><span class="ds-wb-fs-name">${esc(e.name)}</span><button type="button" class="ds-btn ds-wb-select" data-wb-select="${esc(p)}">${esc(t('wb.selectDir'))}</button></div>`
    }).join('') : `<div class="ds-empty">${esc(t('wb.empty'))}</div>`
    box.querySelectorAll('[data-wb-dir]').forEach(row => row.addEventListener('click', e => { if (!e.target.closest('[data-wb-select]')) wbFsLoad(row.dataset.wbDir) }))
    box.querySelectorAll('[data-wb-select]').forEach(button => button.addEventListener('click', () => bindWorkbench(button.dataset.wbSelect)))
  } catch (e) {
    if (!valid()) return
    $('wb-fs-path').textContent = target || '~'
    box.innerHTML = `<div class="ds-empty">${esc(e.message || t('ds.toastConnFailed'))}</div>`
  }
}
function wbFsUp() {
  if (wbFs.path && wbFs.initial && wbFs.path !== wbFs.initial) {
    const parent = wbFsParent(wbFs.path)
    if (parent) wbFsLoad(parent)
  }
}
async function bindWorkbench(rawPath) {
  const connection = captureConnection()
  const value = String(rawPath || '').trim()
  if (!value) return toast(t('wb.pathEmpty'), 'err')
  try {
    const wb = await wbGateway('POST', '/workbench/bind', { path: value })
    if (!connection.valid()) return
    state.wb = { bound: true, path: wb.path || value, title: wb.title || '', expanded: true, projects: null, open: null, apiMissing: false }
    const paths = [state.wb.path]
    try {
      const res = await fetch(fsApiUrl('/list', { path: state.wb.path }), { headers: fsHeaders() })
      const data = await res.json().catch(() => ({}))
      if (!connection.valid()) return
      for (const e of data.entries || []) if (e.type === 'dir') paths.push(wbJoin(state.wb.path, e.name))
    } catch {}
    for (const projectPath of paths) {
      if (!connection.valid()) return
      try { await rpc('workspace.create', { path: projectPath }) } catch {}
    }
    if (!connection.valid()) return
    closeWorkbenchModal()
    await refreshWorkbench({ silent: true })
    if (!connection.valid()) return
    await refreshSessions()
    if (!connection.valid()) return
    toast(t('wb.boundOk', { path: state.wb.path }), 'ok')
  } catch (e) {
    if (!connection.valid()) return
    if (e.message === 'AUTH') return toast(t('ds.toastAuth'), 'err')
    toast(t('wb.bindFailed', { msg: e.message }), 'err')
  }
}
async function unbindWorkbench() {
  if (!confirm(t('wb.unbindConfirm'))) return
  const connection = captureConnection()
  try {
    await wbGateway('POST', '/workbench/unbind')
    if (!connection.valid()) return
    state.wb = { bound: false, path: '', title: '', expanded: false, projects: null, open: null, apiMissing: false }
    renderWorkbench()
    renderSessions()
    toast(t('wb.unboundOk'), 'ok')
  } catch (e) {
    if (!connection.valid()) return
    if (e.message === 'AUTH') return toast(t('ds.toastAuth'), 'err')
    toast(t('wb.unbindFailed', { msg: e.message }), 'err')
  }
}
let wbRefreshTimer = null
function scheduleWorkbenchRefresh() {
  clearTimeout(wbRefreshTimer)
  wbRefreshTimer = setTimeout(() => refreshWorkbench({ silent: true }), 400)
}

/* ---------------- 统计 ---------------- */
function bucketTokens(b) { return (b.input || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.output || 0) }
let statsDrawerOpened = false
function toggleStatsDrawer() {
  const drawer = $('stats-drawer')
  if (!drawer) return
  const willOpen = drawer.classList.contains('hidden')
  drawer.classList.toggle('hidden')
  drawer.setAttribute('aria-hidden', willOpen ? 'false' : 'true')
  if (willOpen && !statsDrawerOpened) { statsDrawerOpened = true; loadStats() }
}
async function loadStats() {
  if (!state.token) {
    $('stats-cards').innerHTML = `<div class="ds-empty">${t('ds.statsGatewayDown')}</div>`
    $('stats-token-chart').innerHTML = ''
    $('stats-token-legend').innerHTML = ''
    return
  }
  try {
    const res = await fetch(apiUrl('/stats/summary?days=7'), { headers: { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web', ...clientIdHeaders() } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    renderStats(json.days || [])
  } catch {
    $('stats-cards').innerHTML = `<div class="ds-empty">${t('ds.statsGatewayDown')}</div>`
    $('stats-token-chart').innerHTML = ''
    $('stats-token-legend').innerHTML = ''
  }
}
function renderStats(days) {
  if (!days.length) {
    $('stats-cards').innerHTML = `<div class="ds-empty">${t('ds.statsEmpty')}</div>`
    $('stats-token-chart').innerHTML = ''
    $('stats-token-legend').innerHTML = ''
    return
  }
  const today = days[days.length - 1]
  const totalTokens = bucketTokens(today.total)
  const peakCost = today.peak.cost || 0
  const offCost = today.off.cost || 0
  const totalCost = peakCost + offCost
  const peakShare = totalCost > 0 ? Math.round(peakCost / totalCost * 100) : 0
  $('stats-cards').innerHTML = `
    <div class="ds-stat-card"><div class="v">${fmtTokens(totalTokens)}</div><div class="k">${t('ds.statsTodayTokens')}
      <div class="ds-bucket-grid">
        <div class="b"><span class="n">${t('ds.statsInput')}</span><span class="t">${fmtTokens(today.total.input)}</span></div>
        <div class="b"><span class="n">${t('ds.statsCacheRead')}</span><span class="t">${fmtTokens(today.total.cacheRead)}</span></div>
        <div class="b"><span class="n">${t('ds.statsCacheWrite')}</span><span class="t">${fmtTokens(today.total.cacheWrite)}</span></div>
        <div class="b"><span class="n">${t('ds.statsOutput')}</span><span class="t">${fmtTokens(today.total.output)}</span></div>
      </div></div></div>
    <div class="ds-stat-card"><div class="v">${fmtCost(totalCost)}</div><div class="k">${t('ds.statsTodayCost')}<br>${t('ds.statsPeak')} ${fmtCost(peakCost)} / ${t('ds.statsOff')} ${fmtCost(offCost)}</div></div>
    <div class="ds-stat-card"><div class="v">${peakShare}%</div><div class="k">${t('ds.statsPeakShare')}<br>${t('ds.statsDays', { n: days.length })}</div></div>`
  $('stats-legend').innerHTML = `<span class="sw peak"></span>${t('ds.statsPeak')} <span class="sw off"></span>${t('ds.statsOff')}`
  $('stats-token-legend').innerHTML = `<span class="sw token"></span>${t('ds.statsTokenTotal')}`
  $('stats-note').textContent = t('ds.statsNote')
  const maxCost = Math.max(...days.map(d => (d.total.cost || 0)), 0.0001)
  $('stats-chart').innerHTML = days.map(d => {
    const cost = d.total.cost || 0
    const peakH = cost > 0 ? Math.round((d.peak.cost || 0) / cost * 100) : 0
    const offH = cost > 0 ? Math.max(0, 100 - peakH) : 0
    const totalH = cost > 0 ? Math.max(3, Math.round(cost / maxCost * 100)) : 0
    const tip = `${d.date}\n${t('ds.statsPeak')} ${fmtCost(d.peak.cost)}\n${t('ds.statsOff')} ${fmtCost(d.off.cost)}`
    return `<div class="ds-stats-bar" data-tip="${esc(tip)}">
      <div class="bars" style="height:${totalH}%"><div class="seg peak" style="height:${peakH}%"></div><div class="seg off" style="height:${offH}%"></div></div>
      <div class="val">${cost > 0 ? fmtCost(cost) : ''}</div>
      <div class="lbl">${d.date.slice(5)}</div>
    </div>`
  }).join('')
  const maxTokens = Math.max(...days.map(d => bucketTokens(d.total)), 1)
  $('stats-token-chart').innerHTML = days.map(d => {
    const tokens = bucketTokens(d.total)
    const totalH = tokens > 0 ? Math.max(3, Math.round(tokens / maxTokens * 100)) : 0
    const tip = `${d.date}\n${t('ds.statsTokenTotal')} ${fmtTokens(tokens)}\n${t('ds.statsInput')} ${fmtTokens(d.total.input)} · ${t('ds.statsOutput')} ${fmtTokens(d.total.output)}`
    return `<div class="ds-stats-bar" data-tip="${esc(tip)}">
      <div class="bars token" style="height:${totalH}%"></div>
      <div class="val">${tokens > 0 ? fmtTokens(tokens) : ''}</div>
      <div class="lbl">${d.date.slice(5)}</div>
    </div>`
  }).join('')
}

/* ---------------- 视图与连接状态 ---------------- */
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
  const [health,host]=await Promise.all([healthRequest,refreshHostDescriptionDesktop()])
  if(!connection.valid()||signal.aborted)throw Error('stale check')
  if(health){state.gatewayHealth[base]=health}
  else delete state.gatewayHealth[base]
  return {gateway:!!health}
}
function startOverviewDetection(force=false,identityChanged=false) {
  if(identityChanged)overviewDetector?.pause()
  if(!window.DshLinkCheck)return
  if(!overviewDetector)overviewDetector=new window.DshLinkCheck.LinkCheck({
    active:()=>document.visibilityState==='visible'&&!$('view-overview').classList.contains('hidden'),
    configured:()=>!!state.token&&(!!state.server||/^https?:$/.test(location.protocol)),online:()=>navigator.onLine,
    snapshot:overviewChecks,repair:repairMissingStreams,probe:probeOverviewLinks,changed:renderOverviewDesktop
  })
  overviewDetector.start(force)
}
window.addEventListener('online',()=>startOverviewDetection(true))
window.addEventListener('offline',()=>startOverviewDetection(true))
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')startOverviewDetection(true);else {overviewDetector?.pause();overviewPulse?.pause()}})

function renderOverviewDesktop() {
  window.DshWorkflow?.update()
  const ring = $('ds-overview-pulse-ring')
  if (!ring) return
  const checks = overviewChecks()
  const detection=overviewDetector?.model,checking=detection?.phase==='checking'||(detection?.phase==='degraded'&&detection?.probing===true)
  const online = Object.values(checks).filter(Boolean).length
  $('ds-overview-refresh').disabled=detection?.probing===true
  const status = online === 4 ? 'Nominal' : online > 0 ? 'Degraded' : 'Offline'
  const pulseCard = document.querySelector('.ds-overview-pulse-card')
  if (pulseCard) {
    if(!overviewPulse&&window.DshLinkCheck?.PulseVisual)overviewPulse=new window.DshLinkCheck.PulseVisual({card:pulseCard,active:()=>document.visibilityState==='visible'&&!$('view-overview').classList.contains('hidden')})
    overviewPulse?.setChecking(checking)
    overviewPulse?.setLinks(checks)
    pulseCard.classList.remove('status-nominal', 'status-degraded', 'status-offline')
    pulseCard.classList.toggle('status-checking',checking)
    pulseCard.setAttribute('aria-busy',String(checking))
    pulseCard.classList.add('status-' + status.toLowerCase())
  }
  setOverviewText('ds-overview-health',checking ? t('ds.checking') : online === 4 ? t('ds.live') : online ? `${online}/4` : t('ds.offlineCore'))
  setOverviewText('ds-overview-health-caption',checking ? `${online}/4` : online === 4 ? t('ds.allLinked') : online ? t('ds.confirmedShort') : t('ds.offlineShort'))
  setOverviewText('ds-overview-status',checking ? t('ds.checking') : t(`ds.system${status}`))
  setOverviewText('ds-overview-status-desc',checking ? t('ds.autoChecking',{n:online}) : detection?.phase==='degraded' ? t('ds.autoRetry',{n:online}) : t('ds.components',{n:online}))
  for (const [name, ok] of Object.entries(checks)) {
    const item = document.querySelector(`[data-ds-overview-link="${name}"]`)
    if (!item) continue
    item.classList.toggle('ok', ok)
    item.classList.toggle('off', !ok&&!checking)
    item.classList.toggle('pending',!ok&&checking)
    const value = item.querySelector('b')
    if (value) setOverviewText(value.id || (value.id=`ds-overview-link-${name}`), ok ? t('ds.online') : checking ? t('ds.checkingShort') : t('ds.offlineShort'))
  }

  const pending = [
    ...state.approvals.map(a => ({ kind: 'approval', item: a })),
    ...state.questions.map(q => ({ kind: 'question', item: q }))
  ]
  $('ds-overview-attention-count').textContent = pending.length ? t('ds.pendingCount', { n: pending.length }) : '—'
  $('ds-overview-attention-list').innerHTML = pending.length ? pending.map(({ kind, item }) => {
    const title = sessionLabelOf(state.byId.get(item.sessionId))
    if (kind === 'approval') return `<div class="ds-overview-attention-item" data-ds-overview-approval="${esc(item.approvalId)}">
      <span class="ds-overview-mark">⌁</span><span class="ds-overview-copy"><span class="ds-overview-item-title">${esc(item.toolName || t('ds.toolDefault'))}</span><span class="ds-overview-item-desc">${esc(desktopApprovalDetail(item))} · ${esc(title)}</span></span>
      <span class="ds-overview-actions"><button class="ds-btn allow" data-ds-overview-approve="1">${t('ds.allow')}</button><button class="ds-btn reject" data-ds-overview-approve="0">${t('ds.reject')}</button></span>
    </div>`
    return `<button type="button" class="ds-overview-attention-item question" data-ds-overview-question="${esc(item.rpcId)}">
      <span class="ds-overview-mark">?</span><span class="ds-overview-copy"><span class="ds-overview-item-title">${esc(item.questions?.[0]?.question || t('ds.questionNotify'))}</span><span class="ds-overview-item-desc">${esc(title)}</span></span><span class="ds-overview-arrow">›</span>
    </button>`
  }).join('') : `<div class="ds-overview-empty">${t('ds.nothingPending')}</div>`
  $('ds-overview-attention-list').querySelectorAll('[data-ds-overview-approve]').forEach(btn => btn.addEventListener('click', () => approveApproval(btn.closest('[data-ds-overview-approval]')?.dataset.dsOverviewApproval || '', btn.dataset.dsOverviewApprove === '1')))
  $('ds-overview-attention-list').querySelectorAll('[data-ds-overview-question]').forEach(btn => btn.addEventListener('click', () => openQuestionModal(state.questions.find(q => q.rpcId === btn.dataset.dsOverviewQuestion))))
  renderApprovalRecordsDesktop()

  const topSessions = topLevelSessions()
  const running = topSessions.filter(s => s.running).length
  const sessions = topSessions.sort((a, b) => Number(b.running) - Number(a.running) || (sessionSortTime(b) - sessionSortTime(a))).slice(0, 6)
  const primary = $('ds-overview-primary-action')
  if (primary) {
    let action = 'new'
    let label = t('ds.action.newSession')
    let sessionId = ''
    if (!state.token) {
      action = 'settings'
      label = t('ds.action.connect')
    } else if (online > 0 && online < 4) {
      action = 'refresh'
      label = t('ds.action.refresh')
    } else if (pending.length) {
      action = 'attention'
      label = t('ds.action.attention')
    } else if (sessions.length) {
      action = 'session'
      sessionId = sessions[0].sessionId
      label = t('ds.action.openSession')
    }
    primary.textContent = label
    primary.dataset.dsOverviewAction = action
    primary.dataset.dsOverviewSession = sessionId
  }
  $('ds-overview-dsh-version').textContent = state.hostInfo?.version || '—'
  $('ds-overview-gateway-version').textContent = checks.gateway ? t('ds.online') : t('ds.offlineShort')
  $('ds-overview-active-sessions').textContent = String(running)
  $('ds-overview-connection-mode').textContent = state.token ? t(state.streamMode === 'poll' ? 'ds.poll' : 'ds.liveWs') : '—'
  $('ds-overview-active-count').textContent = running ? t('ds.activeCount', { n: running }) : ''
  $('ds-overview-session-list').innerHTML = sessions.length ? sessions.map(s => `<button type="button" class="ds-overview-session-item ${s.running ? 'running' : ''}" data-ds-overview-session="${esc(s.sessionId)}">
    <span class="ds-overview-mark">${s.running ? '●' : '○'}</span><span class="ds-overview-copy"><span class="ds-overview-item-title">${esc(sessionLabelOf(s))}</span><span class="ds-overview-item-desc">${s.running ? esc(t('ds.running')) + ' · ' : ''}${esc(fmtTime(sessionSortTime(s)))}</span></span><span class="ds-overview-arrow">›</span>
  </button>`).join('') : `<div class="ds-overview-empty">${t('ds.noSessions')}</div>`
  $('ds-overview-session-list').querySelectorAll('[data-ds-overview-session]').forEach(btn => btn.addEventListener('click', () => openSession(btn.dataset.dsOverviewSession)))
}

const narrowSidebarQuery = window.matchMedia('(max-width: 1023px)')
function setMobileSidebar(open) {
  const sidebar = $('ds-sidebar')
  const backdrop = $('ds-sidebar-backdrop')
  const trigger = $('btn-mobile-nav')
  if (!sidebar || !backdrop || !trigger) return
  const visible = !!open && narrowSidebarQuery.matches
  sidebar.classList.toggle('mobile-open', visible)
  backdrop.classList.toggle('hidden', !visible)
  trigger.setAttribute('aria-expanded', String(visible))
  sidebar.inert = narrowSidebarQuery.matches && !visible
  $('ds-app')?.classList.toggle('mobile-nav-open', visible)
}

function openDesktopPlugins(route = 'manage') {
  const connection=captureConnection()
  if(!connection.token){$('desktop-plugin-page').textContent=t('ds.toastAuth');return}
  window.DshExtensions.mount({connection,getWorkspaces: () => state.workspaces || [],
    getWorkspaceId: () => (state.workspaces || []).find(w => (w.sessionIds || []).includes(state.current))?.workspaceId || '',
    openTeamCaptain: async id => { if (!connection.valid()) return; await openSession(id) },
    openTaskSession: async (id, workspaceId) => {
      if (!connection.valid() || state.view !== 'view-plugins') return
      if (!(state.workspaces || []).some(row => row.workspaceId === workspaceId)) throw Error('unavailable')
      await openSession(id)
    },
    openTeamMember: async (id, parentId) => {
      const selected = state.current
      const catalog = await loadSessionSubagents(parentId)
      if (!connection.valid() || state.view !== 'view-plugins' || state.current !== selected) return
      const entry = catalog?.entries?.find(row => row.id === id)
      if (!entry || entry.kind === 'diagnostic') throw Error('unavailable')
      rememberSubagent(entry, parentId)
      await openSession(id)
    },
    back:()=>showView('view-settings'),getSession:()=>state.byId.get(state.current),getTitle:()=>titleOf(state.byId.get(state.current)),openContext:()=>void openInsights('context',true),scrollTop:()=>{$('view-plugins').scrollTop=0},url:path=>connection.server+path,headers:{authorization:'Bearer '+connection.token,'x-dsh-remote-client':'web',...clientIdHeaders()},valid:connection.valid},$('desktop-plugin-page'),route)
}

function showView(id) {
  if (id !== 'view-chat') window.DshSubagents?.close()
  document.body?.classList.toggle('viewing-subagent', id === 'view-chat' && state.byId.get(state.current)?.origin === 'subagent')
  window.DshWorkflow?.close()
  if (window.DshWorkflow?.isMounted() && id === 'view-overview') id = 'view-sessions'
  if (id !== 'view-chat') conversationView?.pause()
  if (state.view === 'view-chat' && id !== 'view-chat' && state.current) void archiveEmptySessionOnLeave(state.current)
  state.view = id
  document.body?.classList.toggle('workflow-at-start', !!window.DshWorkflow?.isMounted() && id === 'view-sessions')
  for (const v of ['view-overview', 'view-sessions', 'view-chat', 'view-files', 'view-plugins', 'view-settings']) $(v).classList.toggle('hidden', v !== id)
  if (id === 'view-chat') conversationView?.resume()
  document.querySelectorAll('.ds-nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === id))
  if (narrowSidebarQuery.matches) setMobileSidebar(false)
  window.DshMotion?.view($(id))
  const titles = { 'view-overview': 'ds.overview', 'view-sessions': 'ds.sessions', 'view-chat': 'ds.sessions', 'view-files': 'ds.files', 'view-settings': 'ds.settings', 'view-plugins': 'ds.plugins' }
  if (id === 'view-chat') { const s = state.byId.get(state.current); $('ds-title').textContent = s ? titleOf(s) : t('ds.sessions') }
  else $('ds-title').textContent = t(titles[id])
  if (id === 'view-overview') {startOverviewDetection(true);renderOverviewDesktop()}
  else {overviewDetector?.pause();overviewPulse?.pause()}
  if (id === 'view-files' && !state.fs.loaded) loadFs(null, true)
  if (id === 'view-settings') showSettingsHome()
  if (id === 'view-plugins') openDesktopPlugins()
  else window.DshExtensions?.close()
  updateSessionActions()
}

function updateSessionActions() {
  const active = state.view === 'view-chat' && !!state.current
  $('btn-subagents')?.classList.toggle('hidden', !active)
  $('btn-rename-session')?.classList.toggle('hidden', !active)
  $('btn-archive-session')?.classList.toggle('hidden', !active || state.archivedIds.includes(state.current))
  $('ds-session-status')?.classList.toggle('hidden', !active || !recoveryLabel())
  if (!active) $('ds-workspace')?.classList.add('hidden')
  if (active) {
    const s = state.byId.get(state.current)
    $('ds-title').textContent = s ? titleOf(s) : t('ds.sessions')
    const workspace = s?.cwd || ''
    $('ds-workspace').textContent = '📁 ' + (workspace.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || t('ds.noWorkspace')) + '  ›'
    $('ds-workspace').title = workspace
    $('ds-workspace').classList.remove('hidden')
    $('ds-session-status').textContent = recoveryLabel()
  }
  const running = !!state.byId.get(state.current)?.running || (state.queues[state.current] || []).some(i => i.placement !== 'context')
  $('btn-cancel')?.classList.toggle('hidden', !active || !running)
}

const SETTINGS_GROUPS = ['general', 'servers', 'theme', 'about']
function showSettingsHome() {
  const home = $('settings-home')
  if (!home) return
  home.classList.remove('hidden')
  for (const name of SETTINGS_GROUPS) $('settings-page-' + name)?.classList.add('hidden')
}
function showSettingsPage(name) {
  const home = $('settings-home')
  if (!home || !SETTINGS_GROUPS.includes(name)) return
  home.classList.add('hidden')
  for (const g of SETTINGS_GROUPS) $('settings-page-' + g)?.classList.toggle('hidden', g !== name)
  if (name === 'general') renderPresetSummary()
}
function updateConn() {
  overviewDetector?.observe()
  const el = $('conn-badge')
  // 双实时通道可能按任意顺序打开，连接刷新必须同时刷新系统总览。
  renderOverviewDesktop()
  const cur = currentServerEntry()
  const group = cur ? cur.group : state.activeGroup
  const label = cur ? (cur.note || cur.url) : (state.server || t('ds.origin'))
  const serverText = t('ds.currentServer', { group, url: label })
  if (!navigator.onLine) {
    el.textContent = t('ds.connOffline')
    el.className = 'ds-conn off'
    el.title = serverText
    $('server-badge').textContent = serverText
    return
  }
  if (state.streamMode === 'poll') {
    el.textContent = '●'
    el.className = 'ds-conn off'
    el.title = t('ds.connPollTitle')
    $('server-badge').textContent = serverText
    return
  }
  const any = Object.values(state.streamsOk).some(Boolean)
  const all = state.streamsOk.mux && state.streamsOk.host
  if (!all && reconnectInfo) {
    const remain = Math.max(0, Math.ceil((reconnectInfo.at - Date.now()) / 1000))
    el.textContent = remain > 0 ? t('ds.connReconnectIn', { n: remain }) : t('ds.connReconnecting')
    el.className = 'ds-conn ing'
    el.title = t('ds.connReconnecting') + ' · ' + serverText
    $('server-badge').textContent = serverText
    return
  }
  if (!all && state.errCount > 0 && !any) {
    el.textContent = t('ds.connFailed')
    el.className = 'ds-conn off'
    el.title = serverText
    $('server-badge').textContent = serverText
    return
  }
  el.textContent = '●'
  el.className = 'ds-conn ' + (all ? 'on' : any ? 'ing' : '')
  el.title = all ? t('ds.connOn') : any ? t('ds.connIng') : t('ds.connOff')
  $('server-badge').textContent = serverText
}

/* ---------------- 初始化 ---------------- */

function bindSessionDialogs() {
  const actions=$('session-actions'), info=$('session-info');
  $('btn-session-more').addEventListener('click',()=>actions.showModal());
  actions.addEventListener('click',e=>{if(e.target===actions)actions.close();else if(e.target.closest('button'))actions.close()},true);
  const openInfo=()=>{const s=state.byId.get(state.current);if(!s)return; $('session-info-name').textContent=titleOf(s);$('session-info-path').textContent=s.cwd||t('ds.noWorkspace');$('session-info-id').textContent=s.sessionId;$('btn-copy-session-workspace').disabled=!s.cwd;info.showModal()};
  $('ds-title').addEventListener('click',openInfo);
  $('ds-workspace').addEventListener('click',openInfo);
  $('btn-session-info').addEventListener('click',openInfo);
  info.addEventListener('click',e=>{if(e.target===info||e.target.closest('[data-session-dialog-close]'))info.close()});
  $('btn-copy-session-workspace').addEventListener('click',async()=>{const value=state.byId.get(state.current)?.cwd;if(value&&await copyText(value))toast(t('ds.copied'),'ok')});
}

function bindUi() {
  bindSessionDialogs()
  getConversationView()
  $('btn-history-latest').addEventListener('click',()=>{getConversationView().latest();if(state.history.tailEvicted)void loadHistory(true)})
  $('btn-new-session').addEventListener('click', openNewSessionModal)
  $('btn-new-workspace').addEventListener('click', openWorkspaceModal)
  $('session-sort')?.addEventListener('change', (e) => {
    state.sessionSort = e.target.value === 'workspace' ? 'workspace' : 'time'
    LS.set('sessionSort', state.sessionSort)
    renderSessions()
  })
  $('btn-mobile-nav').addEventListener('click', () => setMobileSidebar(!$('ds-sidebar').classList.contains('mobile-open')))
  $('ds-sidebar-backdrop').addEventListener('click', () => setMobileSidebar(false))
  narrowSidebarQuery.addEventListener?.('change', () => setMobileSidebar(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('ds-sidebar').classList.contains('mobile-open')) {
      setMobileSidebar(false)
      $('btn-mobile-nav').focus()
    }
  })
  document.querySelectorAll('.ds-nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)))
  $('ds-overview-refresh').addEventListener('click',()=>{startOverviewDetection(true);if(state.token)void refreshSessions()})
  $('ds-overview-primary-action').addEventListener('click', () => {
    const button = $('ds-overview-primary-action')
    const action = button.dataset.dsOverviewAction
    if (action === 'session' && button.dataset.dsOverviewSession) return openSession(button.dataset.dsOverviewSession)
    if (action === 'new') return $('btn-new-session').click()
    if (action === 'settings') return showView('view-settings')
    if (action === 'refresh') return $('ds-overview-refresh').click()
    const first = document.querySelector('.ds-overview-attention-item')
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (first.matches('button')) first.focus({ preventScroll: true })
    }
  })
  $('session-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-archived-toggle]')) {
      LS.set('dsShowArchivedV1', LS.get('dsShowArchivedV1', '0') === '1' ? '0' : '1')
      renderSessions()
      return
    }
    const item = e.target.closest('[data-id]')
    if (item) openSession(item.dataset.id)
  })
  $('btn-wb-bind').addEventListener('click', openWorkbenchModal)
  $('btn-wb-bind-manual').addEventListener('click', () => bindWorkbench($('wb-path-input').value))
  $('wb-path-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); bindWorkbench($('wb-path-input').value) }
  })
  $('wb-fs-up').addEventListener('click', wbFsUp)
  $('wb-fs-home').addEventListener('click', () => wbFsLoad(wbFs.initial || null))
  $('btn-wb-modal-close').addEventListener('click', closeWorkbenchModal)
  $('modal-workbench').addEventListener('click', e => { if (e.target === $('modal-workbench')) closeWorkbenchModal() })
  $('wb-head').addEventListener('click', () => {
    state.wb.expanded = !state.wb.expanded
    if (state.wb.expanded && !state.wb.projects) refreshWorkbench({ silent: false })
    else renderWorkbench()
  })
  $('btn-wb-path').addEventListener('click', () => { if (state.wb.path) toast(t('wb.boundPath', { path: state.wb.path }), 'ok') })
  $('btn-wb-unbind').addEventListener('click', unbindWorkbench)
  $('btn-send').addEventListener('click', sendMessage)
  $('btn-cancel').addEventListener('click', cancelSession)
  $('btn-rename-session').addEventListener('click', () => renameSession())
  $('btn-archive-session').addEventListener('click', archiveCurrentSession)
  $('rename-cancel').addEventListener('click', closeRenameSession)
  $('rename-confirm').addEventListener('click', confirmRenameSession)
  $('rename-session-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) confirmRenameSession() })
  $('modal-rename').addEventListener('click', e => { if (e.target === $('modal-rename')) closeRenameSession() })
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage() }
  })
  renderPresetMenuDesktop()
  renderPresetSummary()
  $('btn-cmd').addEventListener('click', (e) => { e.stopPropagation(); toggleCmdMenuDesktop() })
  $('cmd-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-ds-cmd]')
    if (item) {
      const input = $('composer')
      input.value = item.dataset.dsCmd + ' '
      input.focus()
      $('cmd-menu').classList.add('hidden')
    }
  })
  $('btn-preset').addEventListener('click', (e) => { e.stopPropagation(); togglePresetMenuDesktop() })
  $('preset-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-ds-preset]')
    if (item) {
      const found = readPresets().find(x => x.id === item.dataset.dsPreset)
      if (found) {
        const input = $('composer')
        input.value = found.text
        input.focus()
      }
      $('preset-menu').classList.add('hidden')
    }
  })
  $('btn-model').addEventListener('click', (e) => { e.stopPropagation(); toggleModelMenuDesktop() })
  $('model-menu').addEventListener('click', (e) => {
    if (e.target.closest('[data-model]') || e.target.closest('[data-effort]')) e.stopPropagation()
  })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#preset-menu') && !e.target.closest('#btn-preset')) $('preset-menu')?.classList.add('hidden')
    if (!e.target.closest('#cmd-menu') && !e.target.closest('#btn-cmd')) $('cmd-menu')?.classList.add('hidden')
    if (!e.target.closest('#model-menu') && !e.target.closest('#btn-model')) $('model-menu')?.classList.add('hidden')
  })
  $('btn-stats-top').addEventListener('click', toggleStatsDrawer)
  for (const id of ['history', 'question-body']) window.DshChatFiles?.bind($(id), () => {
    const c=captureConnection(),sessionId=id==='history'?state.current:state.questionModal?.sessionId
    return { ...c,sessionId,cwd:sessionCwd(state.byId.get(sessionId)),native:false,headers:{authorization:'Bearer '+c.token,...clientIdHeaders()},notice:toast,preview:(path,name)=>window.DshWorkflow?.preview({...c,headers:{authorization:'Bearer '+c.token}},path,name),
      valid:()=>c.valid()&&sessionId===(id==='history'?state.current:state.questionModal?.sessionId) }
  })
  $('btn-insights').addEventListener('click', () => openInsights())
  $('stats-drawer-close').addEventListener('click', toggleStatsDrawer)
  // 赞赏支持
  $('btn-donate').addEventListener('click', openDonateModal)
  $('btn-donate-about').addEventListener('click', openDonateModal)
  $('btn-donate-close').addEventListener('click', () => $('modal-donate').classList.add('hidden'))
  // 更新内容弹窗
  $('notes-close').addEventListener('click', closeNotesModal)
  $('notes-prev').addEventListener('click', () => scrollNotes(-1))
  $('notes-next').addEventListener('click', () => scrollNotes(1))
  $('notes-pages').addEventListener('scroll', updateNotesPage)
  $('workspace-cancel').addEventListener('click', closeWorkspaceModal)
  $('workspace-create').addEventListener('click', createWorkspace)
  $('workspace-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createWorkspace() })
  $('modal-workspace').addEventListener('click', (e) => { if (e.target === $('modal-workspace')) closeWorkspaceModal() })
  $('new-session-workspace').addEventListener('change', () => renderNewSessionWorkspace())
  $('new-session-cancel').addEventListener('click', closeNewSessionModal)
  $('new-session-create').addEventListener('click', createSessionInWorkspace)
  $('modal-new-session').addEventListener('click', (e) => { if (e.target === $('modal-new-session')) closeNewSessionModal() })
  $('modal-notes').addEventListener('click', (e) => { if (e.target === $('modal-notes')) closeNotesModal() })
  // 反馈
  $('btn-feedback').addEventListener('click', (e) => { e.stopPropagation(); toggleFeedbackMenu() })
  $('feedback-menu').addEventListener('click', (e) => {
    if (e.target.closest('a[role="menuitem"]')) closeFeedbackMenu()
  })
  $('btn-copy-link').addEventListener('click', async () => {
    const ok = await copyText(FEEDBACK_LINKS.repo)
    toast(t(ok ? 'ds.feedbackCopied' : 'ds.feedbackCopyFailed'), ok ? 'ok' : 'err')
    closeFeedbackMenu()
  })
  $('btn-write-feedback').addEventListener('click', () => { closeFeedbackMenu(); openFeedbackModal() })
  $('btn-doctor').addEventListener('click', openDoctor)
  $('fb-cancel').addEventListener('click', closeFeedbackModal)
  $('fb-submit').addEventListener('click', submitFeedback)
  document.querySelectorAll('#fb-chips .ds-fb-chip').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('#fb-chips .ds-fb-chip').forEach(b => b.classList.toggle('current', b === btn))
    }))
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ds-feedback')) closeFeedbackMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('feedback-menu').classList.contains('hidden')) { closeFeedbackMenu(); $('btn-feedback').focus() }
  })
  // 统计柱状图悬停提示: 自定义 tooltip, 限制在视口内, 避免原生 title 溢出抽屉
  $('stats-chart').addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.ds-stats-bar')
    if (bar && bar.dataset.tip) showTip(bar.dataset.tip, bar.getBoundingClientRect())
  })
  $('stats-chart').addEventListener('mouseleave', hideTip)
  $('stats-token-chart').addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.ds-stats-bar')
    if (bar && bar.dataset.tip) showTip(bar.dataset.tip, bar.getBoundingClientRect())
  })
  $('stats-token-chart').addEventListener('mouseleave', hideTip)

  $('view-settings').addEventListener('click', (e) => {
    const group = e.target.closest('[data-settings-group]')
    if (group) { showSettingsPage(group.dataset.settingsGroup); return }
    if (e.target.closest('[data-settings-back]')) { showSettingsHome(); return }
  })
  $('btn-manage-presets').addEventListener('click', openPresetModal)
  $('btn-preset-add').addEventListener('click', addPreset)
  $('btn-presets-close').addEventListener('click', closePresetModal)
  $('modal-presets').addEventListener('click', (e) => { if (e.target === $('modal-presets')) closePresetModal() })
  $('btn-server-speed').addEventListener('click', () => selectFastestServer({ silent: false }))
  $('btn-server-add').addEventListener('click', addServer)
  $('btn-group-add').addEventListener('click', addGroup)
  $('group-select-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleGroupMenu() })
  $('ds-group-drawer-trigger').addEventListener('click', () => { desktopGroupDrawerOpen() ? closeDesktopGroupDrawer() : openDesktopGroupDrawer() })
  $('ds-group-drawer-close').addEventListener('click', () => closeDesktopGroupDrawer())
  $('ds-group-drawer-backdrop').addEventListener('click', () => closeDesktopGroupDrawer())
  $('ds-group-drawer-list').addEventListener('click', (e) => {
    const option = e.target.closest('[data-ds-quick-group]')
    if (!option) return
    const group = option.dataset.dsQuickGroup
    closeDesktopGroupDrawer({ restoreFocus: false })
    if (group !== state.activeGroup) switchGroup(group)
  })
  $('ds-group-drawer-manage').addEventListener('click', () => {
    closeDesktopGroupDrawer({ restoreFocus: false })
    showView('view-settings')
    showSettingsPage('servers')
  })
  document.addEventListener('keydown', keepDesktopGroupDrawerFocus)
  document.addEventListener('click', (e) => { if (!e.target.closest('#group-select')) closeGroupMenu() })
  $('server-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addServer() } })

  $('btn-copy-token').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.token); toast(t('ds.toastCopied'), 'ok') }
    catch { toast(t('ds.toastOpFailed'), 'err') }
  })
  $('desktop-token-save').addEventListener('click', () => void saveAccessTokenDesktop())
  $('desktop-token-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void saveAccessTokenDesktop() }
  })
  $('btn-theme').addEventListener('click', () => {
    const cur = themeGet() || 'default'
    const idx = THEME_META.findIndex(m => m.id === cur)
    themeSet(THEME_META[(idx + 1) % THEME_META.length].id)
  })
  $('btn-lang').addEventListener('click', () => {
    I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh')
    $('btn-lang').textContent = I18N.lang === 'zh' ? 'EN' : '中文'
    renderServers(); renderSessions(); renderNotifStack(); renderOverviewDesktop(); updateConn(); themeApply(); void refreshInsightEntry()
  })
  $('fs-up').addEventListener('click', fsUp)
  $('fs-root').addEventListener('change', (event) => {
    const index = Math.min(Number(event.target.value) || 0, Math.max(0, state.fs.roots.length - 1))
    state.fs.rootIndex = index
    state.fs.initial = null
    loadFs(state.fs.roots[index] || null, true)
  })
  $('fs-new-workspace').addEventListener('click', openWorkspaceModal)
  $('fs-refresh').addEventListener('click', () => loadFs(state.fs.path || null))
  $('btn-question-submit').addEventListener('click', submitQuestion)
  $('btn-question-cancel').addEventListener('click', () => { $('modal-question').classList.add('hidden'); toast(t('ds.ignored'), 'ok') })
}

async function saveAccessTokenDesktop() {
  const value = $('desktop-token-input').value.trim()
  if (!value) return
  state.token = value; LS.set('token', value)
  const current = state.servers.find(s => s.id === state.groupActive[state.activeGroup]) || state.servers.find(s => s.url === (state.server || location.origin))
  if (current) current.token = value
  saveServers(); $('desktop-token-input').value = ''
  $('token-desc').textContent = '● ' + value.slice(0, 12) + '…'
  showView('view-overview'); openStreams()
  await Promise.all([refreshSessions(), refreshHostDescriptionDesktop()])
  void refreshWorkbench({ silent: true })
}

async function start() {
  const urlToken = new URLSearchParams(location.search).get('token')?.trim() || ''
  if (urlToken) {
    state.token = urlToken
    LS.set('token', urlToken)
    history.replaceState(null, '', location.pathname)
  }
  loadServers()
  doctorSessionHandoff = window.DshDoctorEntry?.restoreSessionConnection?.({state,newId:newServerId,persist:()=>{LS.set('token',state.token);saveServers()}}) === true
  renderServers()
  showView(window.DshWorkflow?.isMounted() ? 'view-sessions' : 'view-overview')
  if (urlToken) {
    state.token = urlToken
    const currentId = state.groupActive[state.activeGroup]
    const current = state.servers.find(s => s.id === currentId) || state.servers.find(s => s.url === state.server)
    if (current) current.token = urlToken
    LS.set('token', urlToken)
    saveServers()
  }
  $('token-desc').textContent = state.token ? '● ' + state.token.slice(0, 12) + '…' : t('ds.toastAuth')
  bindUi()
  window.DshImagePreview?.configure?.({ resolvePath: chatImageRequest, resolveAttachment: chatImageAttachment })
  if (!state.token) { showView('view-settings'); $('desktop-token-input').focus() }
  renderWorkbench()
  updateConn()
  checkNotesOnStart()
  if (state.token) {
    if (!doctorSessionHandoff) await selectFastestServer({ silent: true, reconnect: false })
    overviewStarting=false
    openStreams()
    await Promise.all([refreshSessions(),refreshHostDescriptionDesktop()])
    refreshWorkbench({ silent: true })
  }
  overviewStarting=false
  renderOverviewDesktop()
}

start()
mountWorkflowDesktop()

function mountWorkflowDesktop() {
  window.DshWorkflow?.mount({
    desktop:true, start:()=>{if(state.view==='view-overview')showView('view-sessions')},
    snapshot:()=>({token:!!state.token,host:currentServerEntry()?.note || state.server || location.host,
      gateway:activeGatewayHealth()?.ok || !!state.streamsOk?.mux,dsh:dshReachable(),
      mux:!!state.streamsOk?.mux,hostEvents:!!state.streamsOk?.host,pending:state.approvals.length+state.questions.length,
      busy:!!state.byId.get(state.current)?.running,sending:sendMessage.pending?.has(state.history)}),
    settings:name=>{showView('view-settings');showSettingsPage(name)},plugins:()=>showView('view-plugins'),
    feedback:openFeedbackModal,
    browse:()=>{closeNewSessionModal();showView('view-files')},
    register:async()=>{
      const connection=captureConnection(),path=state.fs.path;if(!path)return toast('请先选择主机目录','err')
      try{const value=await rpc('workspace.create',{path});if(!connection.valid()||!value?.workspace)return
        state.workspaces=[...state.workspaces.filter(w=>w.workspaceId!==value.workspace.workspaceId),value.workspace]
        closeWorkspaceModal();renderNewSessionWorkspace(value.workspace.workspaceId);await createSessionInWorkspace()
      }catch(error){if(connection.valid())toast(error.message,'err')}
    },
    command:runSlashCommand,send:sendMessage,refresh:refreshSessions,retry:()=>{startOverviewDetection(true);void refreshSessions()},
    operations:()=>{const connection=captureConnection();return {url:apiUrl,headers:{authorization:'Bearer '+connection.token},valid:connection.valid}},
    relay:()=>{const connection=captureConnection();return {url:()=>apiUrl('/admin/api/relay'),headers:{authorization:'Bearer '+connection.token},valid:connection.valid,connected:!!connection.token}},
    discover:()=>{if(confirm('登记当前绑定目录下的子目录为工作区？'))void refreshWorkbench({discover:true})},
    files:()=>{const cwd=sessionCwd(state.byId.get(state.current));if(!cwd)return toast('当前会话没有工作目录','err');state.fs.loaded=true;showView('view-files');void loadFs(cwd,true)},
    admin:()=>window.open(new URL(apiUrl('/admin/'),location.href).href,'_blank','noopener,noreferrer'),
    approvalRecords: renderApprovalRecordsDesktop,
    clearApprovalRecords: resetApprovalRecords,
    clear:async kind=>{
      const text=kind==='history'?'清除本机历史缓存？主机记录保留。':kind==='connection'?'移除当前地址和保存的凭证？其他连接条目保留。':'清除本机全部 Remote 配置与凭证？主机数据保留。'
      if(!confirm(text))return
      clearTimeout(scheduleHistoryCacheSave._t)
      if(kind==='connection'){
        const current=currentServerEntry();if(current)state.servers=state.servers.filter(s=>s.id!==current.id)
        state.groupActive[state.activeGroup]='';state.token='';state.server='';LS.del('token');LS.del('server');saveServers()
        closeStream('mux');closeStream('host');stopPolling();renderServers();showView('view-settings');showSettingsPage('servers');return
      }
      await window.DshHistory.cacheClear()
      if(kind==='all'){window.DshWorkflow.clearStorage();location.reload()}else toast('历史缓存已清除','ok')
    },
    recover:(row,receipt)=>{const value=receipt.result?.result?.value;if(row.method==='session.create'&&value?.sessionId)void openSession(value.sessionId);if(row.sessionId===state.current)void resyncCurrentSession()},
  })
}

// Operation logs stay on this device; users can copy or export them.
globalThis.DshDiagnostics?.configure({surface:"desktop",copy:copyText,snapshot:()=>({sessionId:state.current,server:state.server,loading:!!state.history.loading,loaded:!!state.history.loaded,count:state.history.visible.length,...globalThis.DshDiagnostics.nativeSnapshot()})})
