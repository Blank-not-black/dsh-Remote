/* DSH Remote 移动控制台 · 零依赖 */
'use strict'

const I18N = window.I18N
const t = (k, v) => I18N.t(k, v)
I18N.init(window.APP_STR)

/* ---------------- 状态 ---------------- */
const LS = {
  get(k, d) { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  del(k) { try { localStorage.removeItem(k) } catch {} }
}

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
  server: '',             // 当前生效的网关地址, 空 = 同源(浏览器模式)
  servers: [],            // 服务器列表: [{id,url,note,group}]
  groups: ['默认'],       // 组名列表(顺序保留)
  activeGroup: '默认',    // 当前连接组
  autoSelect: { '默认': true },   // 组内自动测速选优 / 手动指定
  groupActive: { '默认': '' },    // 每组当前生效的 server id(手动模式)
  serverLatency: {},      // url -> 最近一次 /health 测速毫秒数
  selectingServer: false, // 防重入: 测速/切换中
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
  refreshTimer: null,
  fs: { path: null, initial: null, loaded: false, upload: null },
  models: { loaded: false, loading: false, groups: [], current: null, failures: [] }
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

function fmtCost(n) {
  return '¥' + (Number(n) || 0).toFixed(2)
}

function bucketTokens(b) {
  return (b.input || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.output || 0)
}

/* ---------------- Token 统计页 ---------------- */
async function loadStats() {
  const cards = $('stats-cards')
  const chart = $('stats-chart')
  const note = $('stats-note')
  if (!state.token) {
    cards.innerHTML = ''
    chart.innerHTML = `<div class="stats-empty">${t('statsPage.gatewayDown')}</div>`
    note.textContent = ''
    $('stats-legend').innerHTML = ''
    return
  }
  try {
    const res = await fetch(apiUrl('/stats/summary?days=7'), {
      headers: { authorization: 'Bearer ' + state.token, 'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web' }
    })
    if (res.status === 401) { authFailure(); return }
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = await res.json()
    renderStats(json.days || [])
  } catch (e) {
    cards.innerHTML = ''
    chart.innerHTML = `<div class="stats-empty">${t('statsPage.gatewayDown')}</div>`
    note.textContent = ''
    $('stats-legend').innerHTML = ''
  }
}

function renderStats(days) {
  const cards = $('stats-cards')
  const chart = $('stats-chart')
  const note = $('stats-note')
  if (!days.length) {
    cards.innerHTML = ''
    chart.innerHTML = `<div class="stats-empty">${t('statsPage.empty')}</div>`
    note.textContent = t('statsPage.note')
    $('stats-sub').textContent = ''
    $('stats-legend').innerHTML = ''
    return
  }
  const today = days[days.length - 1]
  const totalTokens = bucketTokens(today.total)
  const peakCost = today.peak.cost || 0
  const offCost = today.off.cost || 0
  const totalCost = peakCost + offCost
  const peakShare = totalCost > 0 ? Math.round(peakCost / totalCost * 100) : 0
  cards.innerHTML = `
    <div class="scard span2"><div class="v">${fmtTokens(totalTokens)} <span style="font-size:11px;font-weight:500;color:var(--dsr-muted)">${t('statsPage.todayTokens')}</span></div>
      <div class="bucket-grid">
        <div class="b"><span class="n">${t('statsPage.input')}</span><span class="t">${fmtTokens(today.total.input)}</span></div>
        <div class="b"><span class="n">${t('statsPage.cacheRead')}</span><span class="t">${fmtTokens(today.total.cacheRead)}</span></div>
        <div class="b"><span class="n">${t('statsPage.cacheWrite')}</span><span class="t">${fmtTokens(today.total.cacheWrite)}</span></div>
        <div class="b"><span class="n">${t('statsPage.output')}</span><span class="t">${fmtTokens(today.total.output)}</span></div>
      </div></div>
    <div class="scard"><div class="v">${fmtCost(totalCost)}</div><div class="k">${t('statsPage.todayCost')}<br>${t('statsPage.peak')} ${fmtCost(peakCost)}<br>${t('statsPage.off')} ${fmtCost(offCost)}</div></div>
    <div class="scard"><div class="v">${peakShare}%</div><div class="k">${t('statsPage.peakShare')}<br>${t('statsPage.days', { n: days.length })}</div></div>`
  $('stats-sub').textContent = today.date
  note.textContent = t('statsPage.note')
  $('stats-legend').innerHTML = `<span class="lg"><span class="sw peak"></span>${t('statsPage.peak')}</span><span class="lg"><span class="sw off"></span>${t('statsPage.off')}</span>`
  const maxCost = Math.max(...days.map(d => (d.total.cost || 0)), 0.0001)
  chart.innerHTML = days.map(d => {
    const cost = d.total.cost || 0
    // 峰/谷按该日实际费用占比堆叠, 柱总高按当日费用相对窗口最大值; 不再加最小高度, 保证占比真实
    const peakH = cost > 0 ? Math.round((d.peak.cost || 0) / cost * 100) : 0
    const offH = cost > 0 ? Math.max(0, 100 - peakH) : 0
    const totalH = cost > 0 ? Math.max(3, Math.round(cost / maxCost * 100)) : 0
    const label = d.date.slice(5)
    return `<div class="stats-bar" title="${d.date} · ${t('statsPage.peak')} ${fmtCost(d.peak.cost)} · ${t('statsPage.off')} ${fmtCost(d.off.cost)} · tokens ${fmtTokens(bucketTokens(d.total))}">
      <div class="bars" style="height:${totalH}%">
        <div class="seg peak" style="height:${peakH}%"></div>
        <div class="seg off" style="height:${offH}%"></div>
      </div>
      <div class="val">${cost > 0 ? fmtCost(cost) : ''}</div>
      <div class="lbl">${label}</div>
    </div>`
  }).join('')
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
  if (!full?.result) throw new Error(t('err.badResponse'))
  if (!full.result.ok) {
    const err = full.result.error || {}
    throw new Error(err.message || t('err.dshError'))
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
  state.servers = urls.map((url, i) => ({ id: 's' + (i + 1), url, note: '', group: '默认' }))
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
  state.servers = data.servers.filter(s => s && typeof s.url === 'string')
    .map(s => ({ id: s.id || newServerId(), url: s.url.replace(/\/+$/, ''), note: s.note || '', group: s.group || '默认' }))
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
  state.server = manualSrv ? manualSrv.url : (activeServers()[0]?.url || '')
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
  const list = activeServers().map(s => s.url)
  // 浏览器控制台: 当前页面(同源网关)也作为候选, 通常 0 跳内最快
  if (!CAP?.isNativePlatform?.() && location.origin && !list.includes(location.origin)) list.push(location.origin)
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
  } catch {
    return Infinity
  } finally {
    clearTimeout(timer)
  }
}

async function selectFastestServer({ silent = false, reconnect = true } = {}) {
  if (state.selectingServer) return null
  state.selectingServer = true
  try {
    if (!silent) toast(t('speed.testing'))
    const candidates = serverCandidates()
    let chosen = ''
    let best = null
    let ms = Infinity

    if (state.autoSelect[state.activeGroup] !== false) {
      for (const u of candidates) state.serverLatency[u] = await pingServer(u)
      best = candidates
        .filter(u => Number.isFinite(state.serverLatency[u]))
        .sort((a, b) => state.serverLatency[a] - state.serverLatency[b])[0] || null
      const sameOrigin = !CAP?.isNativePlatform?.() && best === location.origin
      chosen = best ? (sameOrigin && !activeServers().some(s => s.url === best) ? '' : best) : (state.server || '')
      ms = best ? state.serverLatency[best] : Infinity
    } else {
      const manual = state.groupActive[state.activeGroup]
      const manualSrv = manual ? state.servers.find(s => s.id === manual) : null
      chosen = manualSrv ? manualSrv.url : (activeServers()[0]?.url || '')
      if (chosen && !silent) {
        state.serverLatency[chosen] = await pingServer(chosen)
        ms = state.serverLatency[chosen]
      }
    }

    renderServers()
    if (chosen !== state.server) {
      state.server = chosen
      if (state.autoSelect[state.activeGroup] !== false && best) {
        const srv = state.servers.find(s => s.url === best)
        if (srv) state.groupActive[state.activeGroup] = srv.id
      }
      saveServers()
      if (!silent) {
        if (chosen) toast(t('speed.switched', { url: chosen, ms: Number.isFinite(ms) ? ms : 0 }), 'ok')
        else toast(t('speed.switchedOrigin'), 'ok')
      }
      if (reconnect && state.token) { openStreams(); refreshAll() }
    } else if (!silent) {
      if (best) toast(t('speed.alreadyBest', { url: chosen || t('speed.origin'), ms: state.serverLatency[best] }), 'ok')
      else if (chosen) toast(t('speed.manualUsing', { url: chosen, ms: Number.isFinite(ms) ? ms : '—' }), 'ok')
      else toast(t('speed.allDown'), 'err')
    }
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
          const ms = state.serverLatency[s.url]
          let badge = `<span class="server-badge">${t('servers.untested')}</span>`
          if (Number.isFinite(ms)) badge = `<span class="server-badge ${s.url === state.server ? 'good' : ''}">${ms}ms${s.url === state.server ? t('servers.current') : ''}</span>`
          else if (ms !== undefined) badge = '<span class="server-badge bad">' + t('servers.unreachable') + '</span>'
          const activeInGroup = auto ? s.url === state.server : s.id === activeManual
          return `<div class="server-row ${activeInGroup ? 'active' : ''}" data-use-server="${esc(s.id)}">
            <span class="server-main"><span class="server-note">${esc(serverTitle(s))}</span>${s.note ? `<span class="server-url">${esc(s.url)}</span>` : ''}</span>${badge}
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
    state.server = s.url
    saveServers()
    renderServers()
    toast(t('servers.manualSelected', { url: serverTitle(s) }), 'ok')
    if (state.token) { openStreams(); refreshAll() }
  }))

  const cur = state.servers.find(s => s.url === state.server)
  const curNote = cur ? (cur.note || cur.url) : ''
  const curGroup = cur ? cur.group : state.activeGroup
  const curMs = state.serverLatency[state.server]
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
  if (state.servers.some(s => s.url === raw)) return toast(t('servers.duplicate'))
  let note = prompt(t('servers.promptNote'), '') || ''
  state.servers.push({ id: newServerId(), url: raw, note: note.trim(), group: state.activeGroup })
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
  if (state.servers.some(x => x.id !== id && x.url === raw)) return toast(t('servers.duplicate'))
  const note = prompt(t('servers.promptEditNote', { url: raw }), s.note || '')
  if (note === null) return
  const group = prompt(t('servers.promptEditGroup'), s.group || '默认')
  if (group === null) return
  const wasActive = state.server === s.url
  s.url = raw
  s.note = note.trim()
  s.group = ensureGroup(group.trim() || '默认')
  if (wasActive) state.server = raw
  saveServers()
  renderServers()
  toast(t('servers.edited'), 'ok')
  if (wasActive && state.token) selectFastestServer({ silent: true })
}

function removeServer(id) {
  const s = state.servers.find(x => x.id === id)
  if (!s) return
  state.servers = state.servers.filter(x => x.id !== id)
  const wasActive = state.server === s.url
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

/* ---------------- 事件流 (WebSocket) ---------------- */
const streams = {}
state.streamsOk = { mux: false, host: false }

function openStreams() {
  if (!state.token) return
  openStream('mux', onMuxFrame, true)
  openStream('host', onHostFrame, false)
}

function openStream(kind, handler, refreshOnOpen) {
  if (!state.token) return
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
    // mux 每次(重)连接都会重放“仍待处理”的审批/提问基线:
    // 先清空旧列表, 避免“桌面已自定义回答, 手机漏收 question/resolved”后永久残留。
    if (kind === 'mux') {
      state.approvals = []
      state.questions = []
      renderPending()
    }
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
    if (state.errCount === 3) toast(t('conn.reconnecting'), 'err')
    // 多服务器: 连续掉线若干次就重测速, 自动换到当前可达的最快地址
    if (state.servers.length && state.errCount % 5 === 0) setTimeout(() => selectFastestServer({ silent: true }), 300)
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
  if (s) s.updatedAt = Date.now()
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
  cacheWrite(CACHE.sessions, state.sessions.slice(0, 80))
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
    const badge = goal ? `<span class="sc-badge ${goal.phase === 'active' ? 'goal-active' : ''}">${esc(t('sessions.goalBadge', { phase: goal.phase || '?' }))}</span>` : ''
    const queueBadge = queueN ? `<span class="sc-badge">${esc(t('sessions.queueBadge', { n: queueN }))}</span>` : ''
    return `<div class="session-card ${state.current === s.sessionId ? 'current' : ''}" data-id="${esc(s.sessionId)}">
      <div class="sc-title">${esc(title)}</div>
      <div class="sc-meta">
        <span class="sc-dot ${dots.join(' ')}"></span>
        <span>${fmtTime(s.updatedAt)}</span>
        ${s.running ? '<span>' + t('sessions.running') + '</span>' : ''}
        ${badge}${queueBadge}
      </div>
      <span class="sc-arrow">›</span>
    </div>`
  }).join('')
  $('home-empty').classList.toggle('hidden', items.length > 0)
  const running = state.sessions.filter(s => s.running).length
  const pending = state.approvals.length + state.questions.length
  $('stat-strip').innerHTML = `
    <div class="stat running"><div class="v">${running}</div><div class="k">${t('sessions.statRunning')}</div></div>
    <div class="stat pending"><div class="v">${pending}</div><div class="k">${t('sessions.statPending')}</div></div>
    <div class="stat ctx"><div class="v">${items.length}</div><div class="k">${t('sessions.statTotal')}</div></div>`
  updatePendingBadge()
}

/* ---------------- 会话详情 ---------------- */
async function openSession(id) {
  state.current = id
  state.history = emptyHistory()
  document.body.classList.add('in-session')
  showView('view-session')
  renderSessionTitle(); renderSessionSub(); updateCancelBtn(); updateSessionStatus()
  $('history').innerHTML = '<div class="empty">' + t('history.loading') + '</div>'
  await loadHistory(true)
  renderSessionCards()
  refreshSessions()
}

function closeSession() {
  state.current = null
  state.history = emptyHistory()
  document.body.classList.remove('in-session')
  hideComposerMenu()
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
  $('session-sub').textContent = parts.join(' · ')
}

/** 顶栏状态: 运行中=蓝色流动渐变, 中断/出错=橙红渐变, 空闲=原样式 */
function updateSessionStatus() {
  const s = state.byId.get(state.current)
  const head = $('session-head')
  if (!head) return
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
  const h = emptyHistory()
  for (const e of cached.events) {
    if (!e?.seq) continue
    h.seqs.add(e.seq)
    h.visible.push(e)
  }
  h.visible.sort((a, b) => a.seq - b.seq)
  state.history = h
  $('history-hint').textContent = t('history.offlineCache', { n: h.visible.length })
  renderHistory(true)
  return true
}

async function loadHistory(reset) {
  const id = state.current
  if (!id || state.history.loading) return
  state.history.loading = true
  const moreBtn = $('history-more')
  if (moreBtn) moreBtn.classList.add('hidden')
  const payload = { sessionId: id, maxMessages: 60 }
  if (!reset && state.history.minSeq !== Infinity) payload.beforeSeq = state.history.minSeq

  let v
  try {
    v = await rpc('session.history', payload)
  } catch (e) {
    state.history.loading = false
    if (e.message === 'AUTH') { authFailure(); return }
    if (restoreCachedHistory()) toast(t('history.cacheFallback'), 'ok')
    else toast(t('history.loadFailed', { msg: e.message }), 'err')
    return
  }

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
  $('history-hint').textContent = state.history.visible.length ? t('history.count', { n: state.history.visible.length }) : ''
  scheduleHistoryCacheSave()
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
  if (!len) {
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
    inner = `<div class="msg ${esc(role)}" data-seq="${seq}"><div class="role">${esc(role === 'user' ? t('role.me') : t('role.dsh'))}</div>${blocks.map(blockHtml).join('')}</div>`
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
    case 'text': return `<div>${renderMarkdown(b.text ?? '')}</div>`
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
  const sub = await safeRpc('subagent.list', { parentSessionId: state.current })
  if (sub?.entries?.length) {
    const rows = sub.entries.map(e => {
      if (e.kind === 'diagnostic') return `<div class="card-row"><span class="k">${t('subagent.diagnostic')}</span><span class="v">${esc(e.reason)}</span></div>`
      const label = e.label || short(e.id)
      const running = e.activity === 'running'
      return `<div class="card-row"><span class="k">${running ? '▶ ' : ''}${esc(label)}</span><span class="v">${esc(e.mode)} ${running ? t('subagent.running') : ''}${e.mode === 'continuable' && running ? ` <button class="mini-btn" data-sub-interrupt="${esc(e.id)}">${t('subagent.interrupt')}</button>` : ''}</span></div>`
    }).join('')
    box.insertAdjacentHTML('beforeend', `<div class="card"><div class="card-title">${t('subagent.title')}</div>${rows}</div>`)
    box.querySelectorAll('[data-sub-interrupt]').forEach(btn =>
      btn.addEventListener('click', () => interruptSubagent(btn.dataset.subInterrupt)))
  }
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
  await safeRpc(method, { sessionId: state.current, ref }, t('goal.actionFailed'))
  toast(t('goal.actionSubmitted'), 'ok')
  scheduleRefresh()
}

async function interruptSubagent(childId) {
  if (!confirm(t('subagent.confirmInterrupt'))) return
  await safeRpc('subagent.interrupt', { parentSessionId: state.current, childSessionId: childId, mode: 'continuable' }, t('subagent.interruptFailed'))
  toast(t('subagent.interruptSubmitted'), 'ok')
  setTimeout(renderSessionCards, 600)
}

/* ---------------- 发送 / 取消 / 快捷菜单 ---------------- */
async function sendSessionText(text) {
  const clean = String(text || '').trim()
  if (!clean || !state.current) return false
  $('btn-send').disabled = true
  const v = await safeRpc('session.prompt', {
    sessionId: state.current,
    mode: 'queue',
    content: [{ type: 'text', text: clean }]
  }, t('send.failed'))
  $('btn-send').disabled = false
  if (v?.accepted) { toast(clean.startsWith('/') ? t('send.commandSent') : t('send.sent'), 'ok'); return true }
  if (v?.command?.text) { toast(t('send.commandExecuted'), 'ok'); return true }
  return false
}

async function sendMessage() {
  const input = $('composer-input')
  const text = input.value.trim()
  if (!text || !state.current) return
  if (await sendSessionText(text)) { input.value = ''; autosize(input) }
}

function hideComposerMenu() {
  $('composer-menu').classList.add('hidden')
  $('btn-plus').classList.remove('active')
}

function toggleComposerMenu() {
  const menu = $('composer-menu')
  const show = menu.classList.contains('hidden')
  menu.classList.toggle('hidden', !show)
  $('btn-plus').classList.toggle('active', show)
  if (show && !state.models.loaded && !state.models.loading) loadSessionModels()
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
  const efforts = model?.reasoning?.efforts || []
  group.classList.toggle('hidden', !efforts.length)
  box.innerHTML = efforts.map(e => {
    const isCur = cur?.reasoningEffort === e.id || (!cur?.reasoningEffort && e.id === model.reasoning.defaultEffort)
    return `<button class="menu-chip ${isCur ? 'current' : ''}" data-effort="${esc(e.id)}" title="${esc(e.description || '')}">${esc(e.name || e.id)}</button>`
  }).join('')
  box.querySelectorAll('[data-effort]').forEach(btn =>
    btn.addEventListener('click', () => selectSessionEffort(btn.dataset.effort)))
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
  if (v?.accepted) toast(t('session.stopRequested'), 'ok')
}

async function newSession() {
  const v = await safeRpc('session.create', {}, t('home.createFailed'))
  if (!v?.sessionId) return
  toast(t('home.created'), 'ok')
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
}

async function approveApproval(id, allow) {
  const a = state.approvals.find(x => x.approvalId === id)
  if (!a) return
  const ok = await respond(a.rpcId, { sessionId: a.sessionId, approvalId: a.approvalId, outcome: allow ? 'allowed-once' : 'rejected' })
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
  const ok = await respond(q.rpcId, { sessionId: q.sessionId, answer: { answers } })
  if (ok) { toast(t('question.submitted'), 'ok'); $('modal-question').classList.add('hidden'); state.questions = state.questions.filter(x => x.rpcId !== q.rpcId); renderPending() }
  else toast(t('question.stale'), 'err')
}

/* ---------------- 后台任务 ---------------- */
function renderQueue() {
  const s = state.byId.get(state.current)
  if (!s) return
  const items = state.queues[state.current] || []
  updateCancelBtn()
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
    'x-dsh-remote-client': CAP?.isNativePlatform?.() ? 'app' : 'web'
  }
}

function fsJoin(dir, name) {
  return dir.replace(/\/+$/, '') + '/' + name
}

function fsParent(p) {
  const clean = String(p || '').replace(/\/+$/, '')
  const idx = clean.lastIndexOf('/')
  if (idx <= 0) return clean === '' ? '' : '/'
  return clean.slice(0, idx)
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
    state.fs.loaded = true
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
    return `<div class="fs-row" data-name="${esc(e.name)}" data-type="${esc(e.type)}">
      <span class="fs-ico">${isDir ? '📁' : '📄'}</span>
      <span class="fs-meta">
        <span class="fs-name">${esc(e.name)}</span>
        <span class="fs-sub">${isDir ? t('fs.dir') : fmtSize(e.size)} · ${fmtFullTime(e.mtimeMs)}</span>
      </span>
      <span class="fs-arrow">${isDir ? '›' : '↓'}</span>
    </div>`
  }).join('')
  list.querySelectorAll('.fs-row').forEach(row =>
    row.addEventListener('click', () => fsOpenEntry(row.dataset.name, row.dataset.type)))
}

function fsOpenEntry(name, type) {
  if (!name) return
  const p = fsJoin(state.fs.path, name)
  if (type === 'dir') return loadFs(p)
  downloadFsFile(name)
}

function downloadFsFile(name) {
  const p = fsJoin(state.fs.path, name)
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
    const res = await fetch(fsApiUrl('/upload-probe', { path: up.path, name: up.name, session: up.session }), { headers: fsHeaders() })
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
      const params = { path: up.path, name: up.name, session: up.session, offset: String(up.offset) }
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
      const params = { path: up.path, name: up.name, session: up.session, offset: String(up.offset), finish: '1', sha256: expected }
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
  if (state.fs.path === state.fs.initial) {
    toast(t('fs.alreadyRoot'))
    return
  }
  loadFs(fsParent(state.fs.path))
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
  await safeRpc('goal.edit', { sessionId: state.current, ref: { id: goal.id, revision: goal.revision }, objective }, t('goal.updateFailed'))
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

async function checkUpdate(silent) {
  if (!state.localVersion) {
    $('update-desc').textContent = t('update.noVersion')
    resetUpdateExpand()
    if (!silent) toast(t('update.noVersion'), 'err')
    return
  }
  const base = state.server
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

/* ---------------- 峰谷计费提醒(每天 9/12/14/18 点本地通知) ---------------- */
const PEAK_REMIND_NOTIFS = [
  { id: 8801, hour: 9, periodKey: 'peak0912', enterKey: 'enterPeak' },
  { id: 8802, hour: 12, periodKey: 'off1214', enterKey: 'enterOff' },
  { id: 8803, hour: 14, periodKey: 'peak1418', enterKey: 'enterPeak' },
  { id: 8804, hour: 18, periodKey: 'off1809', enterKey: 'enterOff' },
]
function peakRemindOn() { return LS.get('peakRemind', '0') === '1' }

async function schedulePeakReminders() {
  if (!CAP?.isNativePlatform?.()) return false
  const L = CAP.Plugins?.LocalNotifications
  if (!L?.schedule) return false
  try {
    await L.schedule({
      notifications: PEAK_REMIND_NOTIFS.map(n => ({
        id: n.id,
        title: 'DSH Remote',
        body: `${t('peakRemind.' + n.enterKey)} · ${t('peakRemind.' + n.periodKey)}`,
        schedule: { every: 'day', on: { hour: n.hour, minute: 0 } },
      }))
    })
    return true
  } catch { return false }
}

async function cancelPeakReminders() {
  if (!CAP?.isNativePlatform?.()) return false
  const L = CAP.Plugins?.LocalNotifications
  if (!L?.cancel) return false
  try {
    await L.cancel({ notifications: PEAK_REMIND_NOTIFS.map(n => ({ id: n.id })) })
    return true
  } catch { return false }
}

/* ---------------- 视图切换 ---------------- */
function showView(id) {
  for (const v of ['view-home', 'view-files', 'view-session', 'view-activity', 'view-stats', 'view-settings']) $(v).classList.toggle('hidden', v !== id)
  // 离开会话页必须清掉 in-session, 否则其他页面顶栏被 body 样式隐藏
  document.body.classList.toggle('in-session', id === 'view-session')
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === id))
  window.scrollTo(0, 0)
  if (id === 'view-files' && !state.fs.loaded) loadFs(null, { silent: true })
  if (id === 'view-stats') loadStats()
}

function updateConn() {
  const ok = !!state.streamsOk?.mux
  const el = $('conn-badge')
  el.textContent = ok ? t('conn.on') : t('conn.off')
  el.className = 'conn-badge ' + (ok ? 'on' : 'off')
  const cur = state.servers.find(s => s.url === state.server)
  const ms = state.serverLatency[state.server]
  const curGroup = cur ? cur.group : state.activeGroup
  const curLabel = cur ? (cur.note || cur.url) : (state.server || t('speed.origin'))
  el.title = t('conn.titleGroup', { group: curGroup, url: curLabel, ms: Number.isFinite(ms) ? ms + 'ms' : '—' })
}

function autosize(el) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

/* ---------------- 初始化 ---------------- */
/** 解析 dshremote://pair?token=..&server=.. 配对二维码 */
function applyPairUrl(url) {
  try {
    const u = new URL(String(url).trim())
    if (u.protocol !== 'dshremote:' || u.hostname !== 'pair') return false
    const tok = (u.searchParams.get('token') || '').trim()
    const server = (u.searchParams.get('server') || '').trim().replace(/\/+$/, '')
    if (!tok || !/^https?:\/\//i.test(server)) return false
    state.token = tok
    LS.set('token', tok)
    state.server = server
    if (!state.servers.some(s => s.url === server)) {
      state.servers.unshift({ id: newServerId(), url: server, note: '', group: state.activeGroup })
    }
    saveServers()
    renderServers()
    $('token-desc').textContent = t('token.savedScan')
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

/** App 内扫码: 官方 Camera 拍照/相册 + jsQR 本地解码(无 Google ML Kit/GMS 依赖, 国内可用)。
 *  冗余路径 1: 系统相机扫 dshremote:// 二维码直接唤起 App(见 bindNativeLinks);
 *  冗余路径 2: 设置页手动粘贴令牌。 */
async function scanPair() {
  if (!CAP?.isNativePlatform?.()) {
    toast(t('scan.browserHint'), 'err')
    return
  }
  const camera = CAP.Plugins?.Camera
  if (!camera?.getPhoto) { toast(t('scan.unsupported'), 'err'); return }
  try {
    const perm = await camera.requestPermissions?.({ permissions: ['camera'] })
    if (perm && perm.camera !== 'granted') { toast(t('scan.permissionDenied'), 'err'); return }
    const photo = await camera.getPhoto({
      resultType: 'dataUrl',
      source: 'PROMPT', // 拍照 / 从相册选择都行, 相册可扫截图
      quality: 85,
      correctOrientation: true,
      saveToGallery: false,
      promptLabelHeader: t('scan.promptHeader'),
      promptLabelPhoto: t('scan.promptPhoto'),
      promptLabelPicture: t('scan.promptGallery'),
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
  $('token-desc').textContent = state.token ? t('token.savedLocal') : t('token.notSet')
  $('server-desc').textContent = state.server || t('servers.defaultDesc')
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
    renderPending(); renderQueue(); renderJobs()
    updateConn()
    if (state.current) { renderSessionTitle(); renderSessionSub(); renderSessionCards(); renderHistory(true) }
    else renderModelMenu()
    loadLocalVersion()
    if (state.hostInfo) $('host-desc').textContent = t('settings.hostDesc', { version: state.hostInfo.version, cwd: state.hostInfo.cwd, n: state.hostInfo.attachedSessions })
    $('token-desc').textContent = state.token ? t('token.savedLocal') : t('token.notSet')
  })
  $('btn-theme').addEventListener('click', openThemePanel)
  $('theme-close').addEventListener('click', () => $('modal-theme').classList.add('hidden'))
  renderServers()
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
  $('btn-refresh').addEventListener('click', () => { toast(t('common.refreshing')); openStreams(); refreshAll() })
  $('btn-admin').addEventListener('click', () => {
    location.href = state.server ? state.server.replace(/\/+$/, '') + '/admin' : 'admin'
  })
  $('btn-new-session').addEventListener('click', newSession)
  $('btn-cancel').addEventListener('click', cancelSession)
  $('btn-send').addEventListener('click', sendMessage)
  $('btn-plus').addEventListener('click', toggleComposerMenu)
  $('composer-menu').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cmd]')
    if (chip) { hideComposerMenu(); sendSessionText(chip.dataset.cmd) }
  })
  $('btn-model-refresh').addEventListener('click', loadSessionModels)
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
  $('btn-scan-pair').addEventListener('click', scanPair)
  $('btn-change-token').addEventListener('click', () => {
    const input = prompt(t('token.prompt'), state.token)
    if (input && input.trim()) { state.token = input.trim(); LS.set('token', input.trim()); $('token-desc').textContent = t('token.saved'); toast(t('token.savedReconnect'), 'ok'); openStreams(); refreshAll() }
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
    const v = await safeRpc('host.describe', {}, t('settings.probeFailed'))
    if (v) {
      state.hostInfo = v
      $('host-desc').textContent = t('settings.hostDesc', { version: v.version, cwd: v.cwd, n: v.attachedSessions })
    }
  })
  $('btn-check-update').addEventListener('click', () => checkUpdate(false))
  $('btn-download-update').addEventListener('click', downloadUpdate)
  $('btn-update-expand').addEventListener('click', toggleUpdateExpand)
  $('btn-reset').addEventListener('click', () => {
    if (!confirm(t('settings.confirmReset'))) return
    LS.del('token'); LS.del('notify'); LS.del('server')
    location.reload()
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
      await schedulePeakReminders()
      toast(t('peakRemind.on'), 'ok')
    } else {
      await cancelPeakReminders()
      toast(t('peakRemind.off'), 'ok')
    }
    LS.set('peakRemind', e.target.checked ? '1' : '0')
  })
  // 已开启则启动时重新调度, 防止系统清理后丢失
  if (peakRemindOn() && CAP?.isNativePlatform?.()) schedulePeakReminders()
  $('opt-tools').checked = LS.get('showTools', '1') !== '0'
  $('opt-tools').addEventListener('change', (e) => {
    LS.set('showTools', e.target.checked ? '1' : '0')
    if (state.current) renderHistory(true)
    toast(e.target.checked ? t('settings.toolsShown') : t('settings.toolsHidden'), 'ok')
  })

  // 文件页
  $('fs-up').addEventListener('click', fsUp)
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
  renderLangBtn()
  bindNativeBack()
  bindNativeLinks()
  applyNativeInsets()
  updateConn()
  loadLocalVersion()
  if (!state.token) {
    showView('view-settings')
    $('token-desc').textContent = t('token.notSetHint')
  } else {
    // 多服务器: 启动时静默测速一次, 选最快的连接(同源页面也参与比较)
    await selectFastestServer({ silent: true, reconnect: false })
    openStreams()
    await refreshAll()
    const host = await safeRpc('host.describe', {}, '')
    if (host) { state.hostInfo = host; $('host-desc').textContent = t('settings.hostDesc', { version: host.version, cwd: host.cwd, n: host.attachedSessions }) }
    // 启动后自动检查一次更新(静默)
    setTimeout(() => checkUpdate(true), 4000)
  }
  renderPending()
}

document.addEventListener('DOMContentLoaded', boot)
