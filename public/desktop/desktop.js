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
const CAP = window.Capacitor || null

/* ---------------- 皮肤 ---------------- */
const THEME_META = [
  { id: 'default', sw: ['#0B0E1A', '#151B33', '#5B8CFF'] },
  { id: 'dark', sw: ['#05348B', '#0D438F', '#F9A647'] },
  { id: 'light', sw: ['#EFEEEC', '#FAF8F5', '#E6BC7B'] },
  { id: 'neutral', sw: ['#DDD4B8', '#585818', '#832D15'] }
]
function themeGet() {
  let v = LS.get('dshTheme', '')
  if (!THEME_META.some(m => m.id === v)) v = ''
  return v
}
function themeApply() {
  const v = themeGet()
  if (!v) document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', v)
  const meta = THEME_META.find(m => m.id === v) || THEME_META[0]
  const btn = $('btn-theme')
  if (btn) btn.textContent = t('ds.theme.' + meta.id)
  return meta.id || 'default'
}
function themeSet(id) { LS.set('dshTheme', id); themeApply() }
themeApply()

/* ---------------- 状态 ---------------- */
const state = {
  token: LS.get('token', ''),
  server: '',
  servers: [],
  groups: ['默认'],
  activeGroup: '默认',
  autoSelect: { '默认': true },
  groupActive: { '默认': '' },
  serverLatency: {},
  selectingServer: false,
  sessions: [],
  byId: new Map(),
  current: null,
  history: { seqs: new Set(), visible: [], hasMore: false, loading: false, minSeq: Infinity },
  approvals: [],
  questions: [],
  questionModal: null,
  streamsOk: { mux: false, host: false },
  errCount: 0,
  streamMode: 'ws', // 'ws' | 'poll'
  pollSeq: { mux: 0, host: 0 },
  fs: { path: null, initial: null, loaded: false },
  view: 'sessions'
}
const streams = {}
let pollTimer = null
let wsRetryTimer = null

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
  btn.style.display = list.length ? '' : 'none'
  menu.classList.add('hidden')
  menu.innerHTML = list.map(p => `<button class="ds-feedback-item" data-ds-preset="${esc(p.id)}">${esc(p.name)}</button>`).join('')
}
function togglePresetMenuDesktop() {
  const menu = $('preset-menu')
  if (!menu) return
  if (!readPresets().length) return
  menu.classList.toggle('hidden')
}
function toggleCmdMenuDesktop() {
  const menu = $('cmd-menu')
  if (!menu) return
  menu.classList.toggle('hidden')
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
function openFeedbackModal() {
  document.querySelectorAll('#fb-chips .ds-fb-chip').forEach(b => b.classList.toggle('current', b.dataset.fbType === 'bug'))
  $('fb-msg').value = ''
  $('fb-contact').value = ''
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
  if (!info?.version || String(info.version).includes('-rc')) return
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
  try {
    const res = await fetch('../update.json?t=' + Date.now())
    if (!res.ok) return
    openNotesModal(await res.json())
  } catch {}
}
async function submitFeedback() {
  const type = document.querySelector('#fb-chips .ds-fb-chip.current')?.dataset.fbType || 'bug'
  const message = $('fb-msg').value.trim()
  const contact = $('fb-contact').value.trim()
  if (!message) { toast(t('ds.feedbackEmpty'), 'err'); return }
  if (message.length > 2000) { toast(t('ds.feedbackTooLong'), 'err'); return }
  const btn = $('fb-submit')
  btn.disabled = true
  try {
    const res = await fetch(apiUrl('/feedback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: JSON.stringify({ type, message, contact, appVersion: '' })
    })
    let json = {}
    try { json = await res.json() } catch {}
    if (res.ok && json.ok) { toast(t('ds.feedbackSubmitted'), 'ok'); closeFeedbackModal() }
    else if (res.status === 429) { toast(t('ds.feedbackRateLimited'), 'err') }
    else { toast(t('ds.feedbackSubmitFailed', { msg: json.error || res.status }), 'err') }
  } catch {
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
async function rpc(method, payload = {}) {
  const res = await fetch(apiUrl('/api/' + method), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web' },
    body: JSON.stringify({ type: 'client-request', rpcId: uuid(), method, payload })
  })
  if (res.status === 401) throw new Error('AUTH')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const full = await res.json()
  if (!full?.result) throw new Error('bad response')
  if (!full.result.ok) throw new Error(full.result.error?.message || 'dsh error')
  return full.result.value
}
async function respond(rpcId, value) {
  const res = await fetch(apiUrl('/api/respond'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web' },
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } })
  })
  if (res.status === 401) throw new Error('AUTH')
  const receipt = await res.json()
  return receipt?.accepted === true
}
async function safeRpc(method, payload, errText) {
  try { return await rpc(method, payload) }
  catch (e) {
    if (e.message === 'AUTH') { toast(t('ds.toastAuth'), 'err'); return null }
    toast(errText ? `${errText}：${e.message}` : e.message, 'err')
    return null
  }
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

function migrateServersV1() {
  if (LS.get('servers-v2', null) !== null) return
  let arr = null
  try { arr = JSON.parse(LS.get('servers', '')) } catch {}
  if (!Array.isArray(arr)) {
    const legacy = LS.get('server', '')
    arr = legacy ? [legacy] : []
  }
  const urls = arr.map(s => String(s || '').trim().replace(/\/+$/, '')).filter(s => /^https?:\/\//i.test(s))
  state.servers = urls.map((url, i) => ({ id: 's' + (i + 1), url, note: '', group: '默认' }))
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
  state.servers = data.servers.filter(s => s && typeof s.url === 'string').map(s => ({ id: s.id || newServerId(), url: s.url.replace(/\/+$/, ''), note: s.note || '', group: s.group || '默认' }))
  state.groups = Array.isArray(data.groups) && data.groups.length ? data.groups : ['默认']
  state.activeGroup = state.groups.includes(data.activeGroup) ? data.activeGroup : '默认'
  state.autoSelect = data.autoSelect || {}
  state.groupActive = data.groupActive || {}
  ensureGroup('默认')
  for (const s of state.servers) ensureGroup(s.group)
  const manual = state.groupActive[state.activeGroup]
  const manualSrv = manual ? state.servers.find(s => s.id === manual) : null
  state.server = manualSrv ? manualSrv.url : (activeServers()[0]?.url || '')
}
function saveServers() {
  LS.set('servers-v2', JSON.stringify({
    servers: state.servers, groups: state.groups, activeGroup: state.activeGroup,
    autoSelect: state.autoSelect, groupActive: state.groupActive,
  }))
}
function serverCandidates() {
  const list = activeServers().map(s => s.url)
  if (location.origin && !list.includes(location.origin)) list.push(location.origin)
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
    return res.ok ? Math.round(performance.now() - t0) : Infinity
  } catch { return Infinity } finally { clearTimeout(timer) }
}
async function selectFastestServer({ silent = false, reconnect = true } = {}) {
  if (state.selectingServer) return null
  state.selectingServer = true
  try {
    if (!silent) toast(t('ds.speedTesting'))
    const candidates = serverCandidates()
    let chosen = ''
    let best = null
    let ms = Infinity
    if (state.autoSelect[state.activeGroup] !== false) {
      for (const u of candidates) state.serverLatency[u] = await pingServer(u)
      best = candidates.filter(u => Number.isFinite(state.serverLatency[u])).sort((a, b) => state.serverLatency[a] - state.serverLatency[b])[0] || null
      chosen = best || (state.server || '')
      ms = best ? state.serverLatency[best] : Infinity
    } else {
      const manual = state.groupActive[state.activeGroup]
      const manualSrv = manual ? state.servers.find(s => s.id === manual) : null
      chosen = manualSrv ? manualSrv.url : (activeServers()[0]?.url || '')
      if (chosen) { state.serverLatency[chosen] = await pingServer(chosen); ms = state.serverLatency[chosen] }
    }
    renderServers()
    if (chosen !== state.server) {
      state.server = chosen
      if (best) { const srv = state.servers.find(s => s.url === best); if (srv) state.groupActive[state.activeGroup] = srv.id }
      saveServers()
      if (!silent) {
        if (chosen) toast(t('ds.speedSwitched', { url: chosen, ms: Number.isFinite(ms) ? ms : 0 }), 'ok')
      }
      if (reconnect && state.token) { openStreams(); refreshSessions() }
    } else if (!silent) {
      if (best) toast(t('ds.speedAlreadyBest', { url: chosen, ms: state.serverLatency[best] }), 'ok')
      else if (chosen) toast(t('ds.speedManualUsing', { url: chosen, ms: Number.isFinite(ms) ? ms : '—' }), 'ok')
      else toast(t('ds.speedAllDown'), 'err')
    }
    return chosen
  } finally { state.selectingServer = false }
}

function serverTitle(s) { return s.note || s.url }
function renderGroupSelect() {
  const label = $('group-select-label')
  const menu = $('group-select-menu')
  if (!label || !menu) return
  label.textContent = state.activeGroup
  menu.innerHTML = state.groups.map(g => `<button type="button" class="ds-group-option ${g === state.activeGroup ? 'current' : ''}" data-group-option="${esc(g)}">${esc(g)}${g === state.activeGroup ? ' ✓' : ''}</button>`).join('')
  menu.querySelectorAll('[data-group-option]').forEach(b => b.addEventListener('click', () => {
    closeGroupMenu()
    if (b.dataset.groupOption !== state.activeGroup) switchGroup(b.dataset.groupOption)
  }))
}
function toggleGroupMenu() { $('group-select-menu').classList.toggle('hidden') }
function closeGroupMenu() { $('group-select-menu').classList.add('hidden') }

function renderServers() {
  const box = $('server-list')
  if (!box) return
  renderGroupSelect()
  box.innerHTML = state.groups.map(g => {
    const list = groupServers(g)
    const auto = state.autoSelect[g] !== false
    const activeManual = state.groupActive[g] || ''
    return `<div class="ds-srv-group" data-group="${esc(g)}">
      <div class="ds-srv-head">
        <button class="ds-srv-name" data-group-name="${esc(g)}" title="${t('ds.groupsSwitchHint')}">${g === state.activeGroup ? '▾' : '▸'} ${esc(g)} <span class="ds-srv-count">${list.length}</span></button>
        <button class="ds-mini" data-speed-group="${esc(g)}" title="${t('ds.speedTest')}">⚡</button>
        <label class="ds-switch" title="${t('ds.groupsAutoSelect')}"><input type="checkbox" data-auto-group="${esc(g)}" ${auto ? 'checked' : ''}><span class="ds-slider"></span></label>
        ${g !== '默认' ? `<button class="ds-mini" data-del-group="${esc(g)}" title="${t('ds.groupsDelete')}">✕</button>` : ''}
      </div>
      <div class="ds-srv-body ${g === state.activeGroup ? '' : 'hidden'}">
        ${list.map(s => {
          const ms = state.serverLatency[s.url]
          let badge = `<span class="ds-server-badge">${t('ds.serversUntested')}</span>`
          if (Number.isFinite(ms)) badge = `<span class="ds-server-badge ${s.url === state.server ? 'good' : ''}">${ms}ms${s.url === state.server ? t('ds.serversCurrent') : ''}</span>`
          else if (ms !== undefined) badge = `<span class="ds-server-badge bad">${t('ds.serversUnreachable')}</span>`
          const activeInGroup = auto ? s.url === state.server : s.id === activeManual
          return `<div class="ds-server-row ${activeInGroup ? 'active' : ''}" data-use-server="${esc(s.id)}">
            <span class="ds-server-main"><span class="ds-server-note">${esc(serverTitle(s))}</span>${s.note ? `<span class="ds-server-url">${esc(s.url)}</span>` : ''}</span>${badge}
            <button class="ds-mini" data-edit-server="${esc(s.id)}" title="${t('ds.serversEdit')}">✎</button>
            <button class="ds-mini" data-del-server="${esc(s.id)}" title="${t('ds.serversDelete')}">✕</button>
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
    state.server = s.url
    saveServers()
    renderServers()
    toast(t('ds.serversManualSelected', { url: serverTitle(s) }), 'ok')
    if (state.token) { openStreams(); refreshSessions() }
  }))
  const cur = state.servers.find(s => s.url === state.server)
  const curGroup = cur ? cur.group : state.activeGroup
  const curLabel = cur ? (cur.note || cur.url) : (state.server || t('ds.origin'))
  const curMs = state.serverLatency[state.server]
  $('server-desc').textContent = t('ds.serversCurrentDesc', { group: curGroup, url: curLabel, ms: Number.isFinite(curMs) ? curMs + 'ms' : '—' })
  updateConn()
}

async function addServer() {
  const input = $('server-input')
  let raw = (input?.value || '').trim().replace(/\/+$/, '')
  if (!raw) return toast(t('ds.serversNeedAddress'), 'err')
  try { const u = new URL(raw); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad') }
  catch { return toast(t('ds.serversBadProtocol'), 'err') }
  if (state.servers.some(s => s.url === raw)) return toast(t('ds.serversDuplicate'), 'err')
  const note = (prompt(t('ds.serversPromptNote')) || '').trim()
  state.servers.push({ id: newServerId(), url: raw, note, group: state.activeGroup })
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
  if (state.servers.some(x => x.id !== id && x.url === raw)) return toast(t('ds.serversDuplicate'), 'err')
  const note = prompt(t('ds.serversPromptEditNote', { url: raw }), s.note || '')
  if (note === null) return
  const group = prompt(t('ds.serversPromptEditGroup'), s.group || '默认')
  if (group === null) return
  const wasActive = state.server === s.url
  s.url = raw; s.note = note.trim(); s.group = ensureGroup(group.trim() || '默认')
  if (wasActive) state.server = raw
  saveServers(); renderServers(); toast(t('ds.serversEdited'), 'ok')
  if (wasActive && state.token) selectFastestServer({ silent: true })
}
function removeServer(id) {
  const s = state.servers.find(x => x.id === id)
  if (!s) return
  state.servers = state.servers.filter(x => x.id !== id)
  const wasActive = state.server === s.url
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
function openStreams() {
  if (!state.token) return
  if (state.streamMode === 'poll') stopPolling()
  state.streamMode = 'ws'
  openStream('mux', onMuxFrame, true)
  openStream('host', onHostFrame, false)
}
function openStream(kind, handler, refreshOnOpen) {
  if (!state.token) return
  let base
  if (state.server) base = state.server.replace(/^http/, 'ws')
  else { const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'; base = `${proto}//${location.host}` }
  const ws = new WebSocket(`${base}/api/events.${kind}?token=${encodeURIComponent(state.token)}&client=web`)
  try { streams[kind]?.close() } catch {}
  streams[kind] = ws
  ws.onopen = () => {
    state.streamsOk[kind] = true
    state.errCount = 0
    if (state.streamMode === 'poll') { stopPolling(); state.streamMode = 'ws' }
    updateConn()
    if (kind === 'mux') { state.approvals = []; state.questions = []; renderNotifStack() }
    if (refreshOnOpen) refreshSessions()
  }
  ws.onmessage = (msg) => {
    state.streamsOk[kind] = true
    state.errCount = 0
    updateConn()
    try { handler(JSON.parse(msg.data)) } catch {}
  }
  ws.onclose = () => {
    state.streamsOk[kind] = false
    state.errCount++
    updateConn()
    if (state.streamMode === 'poll') return
    if (state.errCount >= 3) { enterPollMode(); return }
    if (state.servers.length && state.errCount % 5 === 0) setTimeout(() => selectFastestServer({ silent: true }), 300)
    if (streams[kind] === ws) setTimeout(() => openStream(kind, handler, refreshOnOpen), 1200)
  }
  ws.onerror = () => { try { ws.close() } catch {} }
}

/* ---------------- 轮询降级模式 ---------------- */
function enterPollMode() {
  if (state.streamMode === 'poll') return
  state.streamMode = 'poll'
  state.pollSeq = { mux: 0, host: 0 }
  state.streamsOk = { mux: false, host: false }
  try { streams.mux?.close() } catch {}
  try { streams.host?.close() } catch {}
  streams.mux = null
  streams.host = null
  refreshSessions()
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
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined
    const headers = { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web' }
    res = signal ? await fetch(apiUrl(`/api/events.poll?kind=${kind}&since=${since}`), { signal, headers }) : await fetch(apiUrl(`/api/events.poll?kind=${kind}&since=${since}`), { headers })
  } catch { return }
  if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
  if (!res.ok) return
  let data
  try { data = await res.json() } catch { return }
  if (!data || !Array.isArray(data.events)) return
  if (typeof data.latestSeq === 'number' && data.latestSeq < since) state.pollSeq[kind] = 0
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
  openStream('mux', onMuxFrame, true)
  openStream('host', onHostFrame, false)
}
function onMuxFrame(full) {
  const f = full.payload
  if (!f) return
  if (f.type === 'session/event') return onSessionEvent(f.sessionId, f.event)
  if (f.type === 'approval/requested') {
    state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId)
    state.approvals.push({ ...f, rpcId: full.rpcId })
    renderNotifStack()
    return
  }
  if (f.type === 'approval/resolved') { state.approvals = state.approvals.filter(a => a.approvalId !== f.approvalId); renderNotifStack(); return }
  if (f.type === 'question/requested') {
    state.questions = state.questions.filter(q => q.rpcId !== full.rpcId)
    state.questions.push({ ...f, rpcId: full.rpcId })
    renderNotifStack()
    return
  }
  if (f.type === 'question/resolved') { state.questions = state.questions.filter(q => q.rpcId !== f.questionRpcId); renderNotifStack(); return }
  if (f.type === 'session/projection') { applyProjection(f.sessionId, f.key, f.value, f.seq); return }
  if (f.type === 'stream/error') toast(f.error?.message || 'stream error', 'err')
}
function onHostFrame(full) {
  const f = full.payload
  if (!f) return
  if (['host/session-added', 'host/session-removed', 'host/workspace-changed', 'host/workspace-removed', 'host/workspace-order-changed', 'host/archived-sessions-changed'].includes(f.type)) refreshSessions()
  if (f.type === 'host/session-status') {
    const s = state.byId.get(f.sessionId)
    if (s) { s.running = f.running; if (state.current === f.sessionId) renderSessions() }
  }
}
function applyProjection(sessionId, key, value, seq) {
  const s = state.byId.get(sessionId)
  if (s) {
    s.projections = s.projections || { asOfSeq: 0, values: {} }
    s.projections.values = s.projections.values || {}
    s.projections.values[key] = value
    s.projections.asOfSeq = Math.max(s.projections.asOfSeq || 0, seq || 0)
  }
  if (state.current === sessionId) renderSessions()
  if (['title', 'goal', 'todos', 'plan', 'sessionListMetadata'].includes(key)) refreshSessions()
}
function proj(s, key, d) { return s?.projections?.values?.[key] ?? d }
function titleOf(s) { return proj(s, 'title') || short(s.sessionId) }
function onSessionEvent(sessionId, event) {
  if (state.current === sessionId && event) {
    const h = state.history
    const seq = event.seq
    if (seq != null && !h.seqs.has(seq) && shouldShowEvent(event.type)) {
      h.seqs.add(seq)
      h.visible.push({ seq, event })
      h.visible.sort((a, b) => a.seq - b.seq)
      renderHistory()
    }
  }
}

/* ---------------- 会话 ---------------- */
async function refreshSessions() {
  const v = await safeRpc('session.list', {}, '')
  if (!v) { renderSessions(); return }
  state.sessions = v.items || []
  state.byId = new Map(state.sessions.map(s => [s.sessionId, s]))
  renderSessions()
}
function renderSessions() {
  const items = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const html = items.map(s => {
    const title = titleOf(s)
    return `<button class="ds-session-item ${state.current === s.sessionId ? 'current' : ''}" data-id="${esc(s.sessionId)}">
      <span class="ds-session-title">${esc(title)}</span>
      <span class="ds-session-meta"><span class="ds-session-dot ${s.running ? 'running' : ''}"></span>${fmtTime(s.updatedAt)}</span>
    </button>`
  }).join('') || `<div class="ds-empty">${t('ds.sessionsEmpty')}</div>`
  $('session-list').innerHTML = html
  $('mobile-session-list').innerHTML = html
  document.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openSession(b.dataset.id)))
}

async function openSession(id) {
  state.current = id
  state.history = { seqs: new Set(), visible: [], hasMore: false, loading: false, minSeq: Infinity }
  showView('view-chat')
  $('ds-title').textContent = titleOf(state.byId.get(id)) || t('ds.sessions')
  $('history').innerHTML = `<div class="ds-empty">${t('ds.historyLoading')}</div>`
  renderSessions()
  await loadHistory()
}
function closeSession() {
  state.current = null
  state.history = { seqs: new Set(), visible: [], hasMore: false, loading: false, minSeq: Infinity }
  showView('view-sessions')
}
async function loadHistory() {
  const id = state.current
  if (!id || state.history.loading) return
  state.history.loading = true
  let v
  try { v = await rpc('session.history', { sessionId: id, maxMessages: 60 }) }
  catch (e) {
    state.history.loading = false
    if (e.message === 'AUTH') return
    $('history').innerHTML = `<div class="ds-empty">${e.message}</div>`
    return
  }
  for (const entry of v.events || []) {
    const ev = entry?.event
    const seq = ev?.seq
    if (seq == null || state.history.seqs.has(seq)) continue
    if (!shouldShowEvent(ev.type)) continue
    state.history.seqs.add(seq)
    state.history.visible.push({ seq, event: ev })
  }
  state.history.visible.sort((a, b) => a.seq - b.seq)
  state.history.hasMore = !!v.hasMore
  state.history.loading = false
  renderHistory()
}

const INTERESTING_EVENTS = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'agent/status', 'checkpoint/created', 'compaction/complete', 'compaction/summary',
  'goal/created', 'goal/updated', 'goal/completed', 'goal/cleared',
  'todo/updated', 'plan/updated', 'question/asked', 'question/resolved',
  'approval/asked', 'approval/resolved', 'session/title', 'title'
])
function shouldShowEvent(type) { return INTERESTING_EVENTS.has(type) }
function safeJson(v) { try { return JSON.stringify(v, null, 2) } catch { return String(v) } }
function blockHtml(b) {
  if (!b) return ''
  if (b.type === 'text') return `<span>${esc(b.text ?? '')}</span>`
  if (b.type === 'reasoning') return `<span style="opacity:.75">${esc(b.text ?? '')}</span>`
  if (b.type === 'tool-call') return `<div>🔧 ${esc(b.name || '')}</div>`
  if (b.type === 'tool-result') return `<div>📦</div>`
  if (b.type === 'image') return `<div>🖼</div>`
  return ''
}
function systemReminderText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b && typeof b === 'object' && b.type === 'text' && String(b.text ?? '').trimStart().startsWith('<system-reminder>'))
    .map(b => String(b.text ?? ''))
    .join('\n')
}
function eventHtml(entry) {
  const ev = entry.event || {}
  const data = ev.data || {}
  const type = ev.type || 'event'
  if (!shouldShowEvent(type)) return ''
  if (type === 'user/message' || type === 'assistant/message') {
    const msg = data.message || {}
    const role = data.role || msg.role || (type.startsWith('user') ? 'user' : 'assistant')
    const blocks = msg.content || data.content || []
    const sysText = type === 'user/message' ? systemReminderText(blocks) : ''
    if (sysText) {
      const shown = sysText.length > 400 ? sysText.slice(0, 400) + '…' : sysText
      return `<details class="event ds-tool"><summary>${esc(t('ds.eventSystemReminder'))}</summary><pre>${esc(shown)}</pre></details>`
    }
    const text = blocks.map(blockHtml).join('')
    return `<div class="ds-msg ${esc(role)}"><div class="role">${esc(role === 'user' ? t('ds.role.me') : t('ds.role.dsh'))}</div>${text || '<span style="opacity:.6">…</span>'}</div>`
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
  if (type === 'approval/asked') return `<div class="ds-tool">🔐 ${esc(t('ds.approvalTitle'))} · ${esc(data.toolName || '')}</div>`
  if (type === 'question/asked') return `<div class="ds-tool">❓ ${esc(data.question || '')}</div>`
  return `<div class="ds-tool">${esc(type)}</div>`
}
function renderHistory() {
  const box = $('history')
  const items = state.history.visible
  box.innerHTML = items.map(eventHtml).join('') || `<div class="ds-empty">${t('ds.historyEmpty')}</div>`
  box.scrollTop = box.scrollHeight
}
async function runSlashCommand(text) {
  const clean = String(text || '').trim()
  if (!clean.startsWith('/') || !state.current) return false
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(20000)
      : undefined
    const res = await fetch(apiUrl('/remote/api/command'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web' },
      body: JSON.stringify({ sessionId: state.current, line: clean }),
      ...(signal ? { signal } : {})
    })
    if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return true }
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    if (data?.ok === false) return true
    return data?.ok === true && data.executed === true
  } catch (e) {
    console.error('slash command bridge failed', e)
  }
  return false
}

async function sendMessage() {
  const input = $('composer')
  const text = input.value.trim()
  if (!text || !state.current) return
  if (await runSlashCommand(text)) { input.value = ''; return }
  input.value = ''
  const v = await safeRpc('session.prompt', { sessionId: state.current, text }, '')
  if (v) toast(t('ds.toastSent'), 'ok')
}

/* ---------------- 审批/提问通知卡片栈 ---------------- */
function serverLabel() {
  const cur = state.servers.find(s => s.url === state.server)
  return cur ? (cur.note || cur.url) : (state.server || location.host)
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
      const reason = a.reason || a.arguments ? safeJson(a.arguments ?? a.reason ?? '') : ''
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
}
async function approveApproval(id, allow) {
  const a = state.approvals.find(x => x.approvalId === id)
  if (!a) return
  const ok = await respond(a.rpcId, { sessionId: a.sessionId, approvalId: a.approvalId, outcome: allow ? 'allowed-once' : 'rejected' })
  toast(ok ? (allow ? t('ds.allowed') : t('ds.rejected')) : t('ds.stale'), ok ? 'ok' : 'err')
  state.approvals = state.approvals.filter(x => x.approvalId !== id)
  renderNotifStack()
}
function openQuestionModal(q) {
  if (!q) return
  state.questionModal = q
  $('question-body').innerHTML = q.questions.map((item, i) => `
    <div class="ds-q-item">
      <div class="ds-q-text">${esc(item.header ? item.header + '：' : '')}${esc(item.question)}</div>
      ${(item.options || []).map((o, j) => `
        <label class="ds-q-option"><input type="${item.multiSelect ? 'checkbox' : 'radio'}" name="q${i}" value="${esc(o.label)}"><span>${esc(o.label)}${o.description ? `<div class="muted">${esc(o.description)}</div>` : ''}</span></label>`).join('')}
      <textarea rows="2" placeholder="${t('ds.questionCustom')}" data-qcustom="${i}"></textarea>
    </div>`).join('')
  $('modal-question').classList.remove('hidden')
}
async function submitQuestion() {
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
  const ok = await respond(q.rpcId, { sessionId: q.sessionId, answer: { answers } })
  if (ok) {
    toast(t('ds.questionSubmitted'), 'ok')
    $('modal-question').classList.add('hidden')
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
  return { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': 'web' }
}
function fsParent(p) {
  if (!p) return null
  const parts = String(p).split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}
async function loadFs(dir, silent) {
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
    if (res.status === 401) { toast(t('ds.toastAuth'), 'err'); return }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !Array.isArray(data.entries)) throw new Error(data.error || ('HTTP ' + res.status))
    state.fs.path = data.path
    if (!state.fs.initial) state.fs.initial = data.path
    state.fs.loaded = true
    $('fs-path').textContent = data.path
    $('fs-list').innerHTML = (data.entries || []).map(e => `
      <div class="ds-fs-row" data-fs-path="${esc(e.path)}" data-fs-dir="${e.type === 'dir' ? '1' : '0'}">
        <span>${e.type === 'dir' ? '📁' : '📄'}</span>
        <span class="ds-fs-name">${esc(e.name)}</span>
        <span class="ds-fs-size">${e.type === 'dir' ? '' : fmtSize(e.size)}</span>
      </div>`).join('') || `<div class="ds-empty">${t('ds.fsEmpty')}</div>`
    $('fs-list').querySelectorAll('[data-fs-path]').forEach(row => row.addEventListener('click', () => {
      if (row.dataset.fsDir === '1') loadFs(row.dataset.fsPath)
      else window.open(fsApiUrl('/file', { path: row.dataset.fsPath, token: state.token }), '_blank')
    }))
  } catch (e) {
    $('fs-path').textContent = target || '~'
    $('fs-list').innerHTML = `<div class="ds-empty">${esc(e.message || t('ds.toastConnFailed'))}</div>`
  }
}
function fsUp() {
  if (state.fs.path && state.fs.initial && state.fs.path !== state.fs.initial) {
    loadFs(fsParent(state.fs.path))
  }
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
    return
  }
  try {
    const res = await fetch(apiUrl('/stats/summary?days=7'), { headers: { authorization: 'Bearer ' + state.token } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    renderStats(json.days || [])
  } catch {
    $('stats-cards').innerHTML = `<div class="ds-empty">${t('ds.statsGatewayDown')}</div>`
  }
}
function renderStats(days) {
  if (!days.length) {
    $('stats-cards').innerHTML = `<div class="ds-empty">${t('ds.statsEmpty')}</div>`
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
}

/* ---------------- 视图与连接状态 ---------------- */
function showView(id) {
  state.view = id
  for (const v of ['view-sessions', 'view-chat', 'view-files', 'view-settings']) $(v).classList.toggle('hidden', v !== id)
  document.querySelectorAll('.ds-nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === id))
  const titles = { 'view-sessions': 'ds.sessions', 'view-chat': 'ds.sessions', 'view-files': 'ds.files', 'view-settings': 'ds.settings' }
  if (id === 'view-chat') { const s = state.byId.get(state.current); $('ds-title').textContent = s ? titleOf(s) : t('ds.sessions') }
  else $('ds-title').textContent = t(titles[id])
  if (id === 'view-files' && !state.fs.loaded) loadFs(null, true)
  if (id === 'view-settings') showSettingsHome()
}

const SETTINGS_GROUPS = ['general', 'servers', 'notify', 'theme', 'about']
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
}
function updateConn() {
  const el = $('conn-badge')
  const cur = state.servers.find(s => s.url === state.server)
  const group = cur ? cur.group : state.activeGroup
  const label = cur ? (cur.note || cur.url) : (state.server || t('ds.origin'))
  if (state.streamMode === 'poll') {
    el.textContent = '●'
    el.className = 'ds-conn off'
    el.title = t('ds.connPollTitle')
    $('server-badge').textContent = t('ds.currentServer', { group, url: label })
    return
  }
  const any = Object.values(state.streamsOk).some(Boolean)
  const all = state.streamsOk.mux && state.streamsOk.host
  el.textContent = '●'
  el.className = 'ds-conn ' + (all ? 'on' : any ? 'ing' : '')
  el.title = all ? t('ds.connOn') : any ? t('ds.connIng') : t('ds.connOff')
  $('server-badge').textContent = t('ds.currentServer', { group, url: label })
}

/* ---------------- 初始化 ---------------- */
function bindUi() {
  $('btn-new-session').addEventListener('click', async () => {
    const v = await safeRpc('session.create', {}, '')
    if (v?.sessionId) { await refreshSessions(); openSession(v.sessionId) }
  })
  $('btn-mobile-nav').addEventListener('click', () => {
    const list = $('mobile-session-list')
    list.style.display = list.style.display === 'none' ? 'flex' : 'none'
  })
  document.querySelectorAll('.ds-nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)))
  $('session-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]')
    if (item) openSession(item.dataset.id)
  })
  $('btn-send').addEventListener('click', sendMessage)
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage() }
  })
  renderPresetMenuDesktop()
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
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#preset-menu') && !e.target.closest('#btn-preset')) $('preset-menu')?.classList.add('hidden')
    if (!e.target.closest('#cmd-menu') && !e.target.closest('#btn-cmd')) $('cmd-menu')?.classList.add('hidden')
  })
  $('btn-stats-top').addEventListener('click', toggleStatsDrawer)
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

  $('view-settings').addEventListener('click', (e) => {
    const group = e.target.closest('[data-settings-group]')
    if (group) { showSettingsPage(group.dataset.settingsGroup); return }
    if (e.target.closest('[data-settings-back]')) { showSettingsHome(); return }
  })
  $('btn-server-speed').addEventListener('click', () => selectFastestServer({ silent: false }))
  $('btn-server-add').addEventListener('click', addServer)
  $('btn-group-add').addEventListener('click', addGroup)
  $('group-select-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleGroupMenu() })
  document.addEventListener('click', (e) => { if (!e.target.closest('#group-select')) closeGroupMenu() })
  $('server-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addServer() } })

  $('btn-copy-token').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.token); toast(t('ds.toastCopied'), 'ok') }
    catch { toast(t('ds.toastOpFailed'), 'err') }
  })
  $('btn-theme').addEventListener('click', () => {
    const cur = themeGet() || 'default'
    const idx = THEME_META.findIndex(m => m.id === cur)
    themeSet(THEME_META[(idx + 1) % THEME_META.length].id)
  })
  $('btn-lang').addEventListener('click', () => {
    I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh')
    $('btn-lang').textContent = I18N.lang === 'zh' ? 'EN' : '中文'
    renderServers(); renderSessions(); updateConn(); themeApply()
  })
  $('fs-up').addEventListener('click', fsUp)
  $('fs-refresh').addEventListener('click', () => loadFs(state.fs.path || null))
  $('btn-question-submit').addEventListener('click', submitQuestion)
  $('btn-question-cancel').addEventListener('click', () => { $('modal-question').classList.add('hidden'); toast(t('ds.ignored'), 'ok') })
}

async function start() {
  loadServers()
  renderServers()
  showView('view-sessions')
  const urlToken = new URLSearchParams(location.search).get('token')
  if (urlToken) { state.token = urlToken; LS.set('token', urlToken); history.replaceState(null, '', location.pathname) }
  if (!state.token) {
    const input = prompt(t('ds.tokenTitle'))
    if (input && input.trim()) { state.token = input.trim(); LS.set('token', state.token) }
  }
  $('token-desc').textContent = state.token ? '● ' + state.token.slice(0, 12) + '…' : t('ds.toastAuth')
  bindUi()
  updateConn()
  checkNotesOnStart()
  if (state.token) {
    if (state.servers.length) await selectFastestServer({ silent: true, reconnect: false })
    openStreams()
    refreshSessions()
  }
}

start()
