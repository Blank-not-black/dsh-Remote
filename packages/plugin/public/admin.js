/* DSH Remote 网关/插件管理页 · 零依赖 */
'use strict'

const $ = (id) => document.getElementById(id)
const I18N = window.I18N
const t = (k, v) => I18N.t(k, v)
I18N.init(window.ADMIN_STR)
// 插件内嵌(/remote/ 或 ?embedded=1)直接进管理面板, 不需要任何令牌门禁;
// 独立网关模式(/admin/)仍保留令牌输入。路径判断兼容无尾斜杠 /remote。
const pluginMode = location.pathname === '/remote'
  || location.pathname.startsWith('/remote/')
  || new URLSearchParams(location.search).get('embedded') === '1'
const API = pluginMode ? '/remote/admin/api' : '/admin/api'
// 沙箱 iframe/隐私模式里 localStorage 可能抛 SecurityError, 不能让它杀死整个页面
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  del(k) { try { localStorage.removeItem(k) } catch {} }
}
let token = store.get('dshAdminToken') || new URLSearchParams(location.search).get('token') || ''
let timer = null
let gatewayRunning = false
let gatewayBusy = false
let shownToken = token
let lastState = null
let qrShown = false
let qrToken = ''
let qrLabel = ''
let deviceKeyBusy = false
let gatewayPort = 8787
let gatewayPortLoaded = false
let doctorExpanded = store.get('dshAdminDoctorCollapsed') !== '1'
let doctorChecks = []

function onlineClientDevices(st) {
  return (st.devices || []).filter(device => device.online && (device.kind === 'app' || device.kind === 'web'))
}

function firewallCommand(st) {
  const port = Number(st.port || gatewayPort) || 8787
  const ip = (st.lanIPs || []).find(value => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value || ''))
  let cidr = 'LocalSubnet'
  if (/^10\./.test(ip || '')) cidr = '10.0.0.0/8'
  else if (/^192\.168\./.test(ip || '')) cidr = '192.168.0.0/16'
  else if (/^172\./.test(ip || '')) cidr = '172.16.0.0/12'
  else if (/^100\./.test(ip || '')) cidr = '100.64.0.0/10'
  if (st.platform === 'win32') return `New-NetFirewallRule -DisplayName "DSH Remote ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -RemoteAddress ${cidr} -Action Allow -Profile Private`
  if (st.platform === 'darwin') return `系统设置 → 网络 → 防火墙；仅允许 Node.js / DSH Remote 接受可信网络入站连接（TCP ${port}）`
  return `sudo ufw allow from ${cidr} to any port ${port} proto tcp\n# firewalld: sudo firewall-cmd --zone=home --add-source=${cidr} --permanent && sudo firewall-cmd --zone=home --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`
}

function buildDoctorChecks(st) {
  const isGateway = st.mode === 'gateway'
  const port = Number(st.port || gatewayPort) || 8787
  const ip = (st.lanIPs || []).find(value => value && value !== '127.0.0.1' && value !== '0.0.0.0')
  const base = ip ? `http://${ip}:${port}` : ''
  const clients = onlineClientDevices(st)
  const events = st.events || {}
  const realtime = !!(events.mux?.connected && events.host?.connected)
  return [
    { id: 'dsh', status: st.upstream?.reachable ? 'pass' : 'fail', title: t('doctor.dsh'), detail: t(st.upstream?.reachable ? 'doctor.dshPass' : 'doctor.dshFail') },
    { id: 'gateway', status: isGateway ? 'pass' : 'fail', title: t('doctor.gateway'), detail: isGateway ? t('doctor.gatewayPass', { host: st.host, port }) : t('doctor.gatewayFail'), action: !isGateway && pluginMode ? 'start' : '' },
    { id: 'network', status: isGateway && ip && st.host !== '127.0.0.1' ? 'pass' : 'fail', title: t('doctor.network'), detail: base ? t('doctor.networkPass', { base }) : t('doctor.networkFail'), action: base ? 'address' : '' },
    { id: 'firewall', status: clients.length ? 'pass' : 'warn', title: t('doctor.firewall'), detail: t(clients.length ? 'doctor.firewallPass' : 'doctor.firewallWarn', { port }), action: clients.length ? '' : 'firewall' },
    { id: 'device', status: clients.length ? 'pass' : 'warn', title: t('doctor.device'), detail: t(clients.length ? 'doctor.devicePass' : 'doctor.deviceWait', { n: clients.length }), action: isGateway && !clients.length ? 'qr' : '' },
    { id: 'realtime', status: realtime ? 'pass' : 'warn', title: t('doctor.realtime'), detail: t(realtime ? 'doctor.realtimePass' : 'doctor.realtimeFail') },
  ]
}

function renderDoctor(st) {
  doctorChecks = buildDoctorChecks(st)
  const passed = doctorChecks.filter(check => check.status === 'pass').length
  const remaining = doctorChecks.length - passed
  const allGood = remaining === 0
  const card = $('doctor-card')
  card.classList.toggle('expanded', doctorExpanded)
  $('doctor-toggle').setAttribute('aria-expanded', String(doctorExpanded))
  $('doctor-progress').textContent = `${passed}/${doctorChecks.length}`
  $('doctor-subtitle').textContent = t(allGood ? 'doctor.ready' : 'doctor.needsWork', { n: remaining })
  $('doctor-summary').textContent = t(allGood ? 'doctor.allGood' : 'doctor.partial')
  $('doctor-summary').classList.toggle('ok', allGood)
  const actionText = { start: 'doctor.start', qr: 'doctor.showQr', address: 'doctor.copyAddress', firewall: 'doctor.copyCommand' }
  $('doctor-steps').innerHTML = doctorChecks.map(check => `<div class="doctor-step ${check.status}">
    <span class="doctor-mark" aria-hidden="true">${check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : '·'}</span>
    <span class="doctor-copy"><strong>${esc(check.title)}</strong><span>${esc(check.detail)}</span></span>
    ${check.action ? `<button class="mini-btn doctor-action" type="button" data-doctor-action="${check.action}">${esc(t(actionText[check.action]))}</button>` : ''}
  </div>`).join('')
}

async function doctorCopy(value, messageKey) {
  try {
    await navigator.clipboard.writeText(value)
    toast(t(messageKey), 'ok')
  } catch {
    toast(t('toast.copyFailed'), 'err')
  }
}

const STATS_API = pluginMode ? API + '/stats' : '/stats'
let statsTimer = null

function fmtTokens(n) {
  n = Number(n) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K'
  return String(Math.round(n))
}

function fmtCost(n) {
  return '¥' + (Number(n) || 0).toFixed(2)
}

function bucketTokens(b) {
  return (b.input || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.output || 0)
}

async function loadStats() {
  if (!token && !pluginMode) return
  try {
    const res = await fetch(`${STATS_API}/summary?days=7`, {
      headers: { authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' }
    })
    if (!res.ok) {
      if (res.status === 401) return
      throw new Error('HTTP ' + res.status)
    }
    const json = await res.json()
    renderStats(json.days || [])
  } catch (e) {
    $('stats-cards').innerHTML = ''
    $('stats-chart').innerHTML = `<div class="stats-empty">${t('stats.gatewayDown')}</div>`
    $('stats-sub').textContent = ''
    $('stats-note').textContent = ''
    $('stats-legend').innerHTML = ''
  }
}

async function loadGatewayConfig() {
  if (!pluginMode) return
  try {
    const res = await fetch(`${API}/config`, {
      headers: { authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' }
    })
    const out = await res.json().catch(() => ({}))
    if (out.ok) {
      gatewayPort = Number(out.port) || 8787
      gatewayPortLoaded = true
      const row = $('gateway-port-row')
      const input = $('gateway-port-input')
      if (row) row.classList.toggle('hidden', !pluginMode)
      if (input && document.activeElement !== input) input.value = gatewayPort
      const cur = $('gateway-port-current')
      if (cur) cur.textContent = t('gatewayPort.current', { port: gatewayPort })
    }
  } catch {}
}

function renderStats(days) {
  if (!days.length) {
    $('stats-cards').innerHTML = ''
    $('stats-chart').innerHTML = `<div class="stats-empty">${t('stats.empty')}</div>`
    $('stats-sub').textContent = ''
    $('stats-note').textContent = t('stats.note')
    $('stats-legend').innerHTML = ''
    return
  }
  const today = days[days.length - 1]
  const totalTokens = bucketTokens(today.total)
  const peakCost = today.peak.cost || 0
  const offCost = today.off.cost || 0
  const totalCost = peakCost + offCost
  const peakShare = totalCost > 0 ? Math.round(peakCost / totalCost * 100) : 0
  $('stats-cards').innerHTML = `
    <div class="stat-card"><div class="v">${fmtTokens(totalTokens)} <span style="font-size:12px;font-weight:500;color:var(--dsr-muted)">${t('stats.todayTokens')}</span></div>
      <div class="bucket-grid">
        <div class="b"><span class="n">${t('stats.input')}</span><span class="t">${fmtTokens(today.total.input)}</span></div>
        <div class="b"><span class="n">${t('stats.cacheRead')}</span><span class="t">${fmtTokens(today.total.cacheRead)}</span></div>
        <div class="b"><span class="n">${t('stats.cacheWrite')}</span><span class="t">${fmtTokens(today.total.cacheWrite)}</span></div>
        <div class="b"><span class="n">${t('stats.output')}</span><span class="t">${fmtTokens(today.total.output)}</span></div>
      </div></div>
    <div class="stat-card"><div class="v">${fmtCost(totalCost)}</div><div class="k">${t('stats.todayCost')} · ${t('stats.peak')} ${fmtCost(peakCost)} / ${t('stats.off')} ${fmtCost(offCost)}</div></div>
    <div class="stat-card ${peakShare >= 50 ? 'warn' : 'ok'}"><div class="v">${peakShare}%</div><div class="k">${t('stats.peakShare')} · ${t('stats.days', { n: days.length })}</div></div>`
  $('stats-sub').textContent = today.date
  $('stats-note').textContent = t('stats.note')
  $('stats-legend').innerHTML = `<span class="lg"><span class="sw peak"></span>${t('stats.peak')}</span><span class="lg"><span class="sw off"></span>${t('stats.off')}</span>`

  // 近 7 日柱状图: 柱总高按当日费用相对窗口最大值, 柱内峰/谷按当日实际占比堆叠
  const maxCost = Math.max(...days.map(d => (d.total.cost || 0)), 0.0001)
  $('stats-chart').innerHTML = days.map(d => {
    const cost = d.total.cost || 0
    const peakH = cost > 0 ? Math.round((d.peak.cost || 0) / cost * 100) : 0
    const offH = cost > 0 ? Math.max(0, 100 - peakH) : 0
    const totalH = cost > 0 ? Math.max(3, Math.round(cost / maxCost * 100)) : 0
    const label = d.date.slice(5)
    return `<div class="stats-bar" title="${d.date} · ${t('stats.peak')} ${fmtCost(d.peak.cost)} · ${t('stats.off')} ${fmtCost(d.off.cost)} · tokens ${fmtTokens(bucketTokens(d.total))}">
      <div class="bars" style="height:${totalH}%">
        <div class="seg peak" style="height:${peakH}%"></div>
        <div class="seg off" style="height:${offH}%"></div>
      </div>
      <div class="val">${cost > 0 ? fmtCost(cost) : ''}</div>
      <div class="lbl">${label}</div>
    </div>`
  }).join('')
}

function toast(text, kind = '') {
  const el = $('toast')
  el.textContent = text
  el.className = 'toast ' + kind
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600)
}

/* ---------------- 反馈 ---------------- */
function openFeedbackMenu() {
  $('fb-menu').classList.remove('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'true')
  const first = $('fb-menu').querySelector('[role="menuitem"]')
  if (first) first.focus()
}
function closeFeedbackMenu() {
  $('fb-menu').classList.add('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'false')
}
function toggleFeedbackMenu() {
  $('fb-menu').classList.contains('hidden') ? openFeedbackMenu() : closeFeedbackMenu()
}

function fmtUptime(sec) {
  if (sec < 60) return sec + t('unit.sec')
  if (sec < 3600) return Math.floor(sec / 60) + t('unit.min')
  if (sec < 86400) return Math.floor(sec / 3600) + t('unit.hour') + Math.floor(sec % 3600 / 60) + t('unit.minShort')
  return Math.floor(sec / 86400) + t('unit.day') + Math.floor(sec % 86400 / 3600) + t('unit.hour')
}

function fmtTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function esc(value) {
  return String(value ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
}

function renderDeviceKeys(st, isGateway) {
  const config = st.deviceKeys || { supported: false, enabled: false, entries: [] }
  const supported = isGateway && config.supported !== false
  const enabled = supported && config.enabled === true
  const toggleWrap = $('device-key-toggle')
  toggleWrap.classList.toggle('hidden', !isGateway && !pluginMode)
  const toggle = $('device-key-enabled')
  toggle.checked = enabled
  toggle.disabled = !supported || deviceKeyBusy
  $('btn-device-key-add').classList.toggle('hidden', !enabled)
  $('btn-device-key-add').disabled = deviceKeyBusy
  $('shared-token-row').classList.toggle('hidden', enabled)
  $('device-key-panel').classList.toggle('hidden', !enabled)
  if (!enabled) {
    $('device-key-rows').innerHTML = ''
    $('device-key-empty').classList.add('hidden')
    return
  }
  const entries = Array.isArray(config.entries) ? config.entries : []
  $('device-key-empty').classList.toggle('hidden', entries.length > 0)
  $('device-key-rows').innerHTML = entries.map(entry => {
    const note = entry.note || t('deviceKeys.neverUsed')
    const ip = entry.lastIp || t('deviceKeys.neverUsed')
    return `<div class="device-key-grid" data-device-key-id="${esc(entry.id)}">
      <div class="device-key-note" data-label="${esc(t('deviceKeys.note'))}"><span>${esc(note)}</span><button class="mini-btn" type="button" data-device-key-note="${esc(entry.id)}">${esc(t('deviceKeys.edit'))}</button></div>
      <div class="device-key-ip" data-label="${esc(t('deviceKeys.ip'))}">${esc(ip)}</div>
      <code data-label="Token">${esc(entry.token)}</code>
      <div class="device-key-actions">
        <button class="mini-btn" type="button" data-device-key-qr="${esc(entry.id)}">${esc(t('qrCode'))}</button>
        <button class="mini-btn" type="button" data-device-key-rotate="${esc(entry.id)}">${esc(t('rotateToken'))}</button>
        <button class="mini-btn" type="button" data-device-key-copy="${esc(entry.id)}">${esc(t('copyToken'))}</button>
        <button class="mini-btn danger" type="button" data-device-key-revoke="${esc(entry.id)}">${esc(t('deviceKeys.revoke'))}</button>
      </div>
    </div>`
  }).join('')
  const byId = id => entries.find(entry => entry.id === id)
  document.querySelectorAll('[data-device-key-note]').forEach(button => button.addEventListener('click', () => editDeviceKeyNote(byId(button.dataset.deviceKeyNote))))
  document.querySelectorAll('[data-device-key-qr]').forEach(button => button.addEventListener('click', () => showDeviceKeyQr(byId(button.dataset.deviceKeyQr))))
  document.querySelectorAll('[data-device-key-rotate]').forEach(button => button.addEventListener('click', () => rotateDeviceKey(byId(button.dataset.deviceKeyRotate))))
  document.querySelectorAll('[data-device-key-copy]').forEach(button => button.addEventListener('click', () => copyDeviceKey(byId(button.dataset.deviceKeyCopy))))
  document.querySelectorAll('[data-device-key-revoke]').forEach(button => button.addEventListener('click', () => revokeDeviceKey(byId(button.dataset.deviceKeyRevoke))))
}

async function loadState() {
  if (!token && !pluginMode) return
  try {
    const res = await fetch(`${API}/state`, {
      headers: { authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' }
    })
    if (res.status === 401) throw new Error('AUTH')
    const st = await res.json()
    render(st)
  } catch (e) {
    if (e.message === 'AUTH') {
      toast(t('toast.tokenInvalid'), 'err')
      logout()
    } else {
      $('conn-badge').textContent = t('toast.connFailed')
      $('conn-badge').className = 'conn-badge off'
    }
  }
}

function render(st) {
  lastState = st
  const isPlugin = st.mode === 'plugin'
  const isGateway = st.mode === 'gateway'
  shownToken = st.token || token
  $('conn-badge').textContent = t(isPlugin ? 'badge.embedded' : isGateway ? 'badge.gateway' : 'badge.connected')
  $('conn-badge').className = 'conn-badge ' + (isPlugin || isGateway ? 'on' : 'off')
  $('conn-badge').title = t(isGateway ? 'badge.gateway.title' : 'badge.gatewayDown')
  $('token-full').textContent = shownToken || t(isPlugin ? 'token.pluginNoGateway' : 'token.unavailable')
  // 主机端插件模式: 显示真实令牌(复制可用), 只隐藏退出按钮; 令牌门禁本身不存在
  $('btn-copy').classList.toggle('hidden', !shownToken)
  $('btn-logout').classList.toggle('hidden', pluginMode)
  // 二维码与轮换只在网关模式下可用(二维码里有完整令牌, 不能在没有网关时生成)
  $('btn-qr').classList.toggle('hidden', isGateway !== true || !shownToken)
  $('btn-rotate').classList.toggle('hidden', isGateway !== true || !shownToken || !!st.tokenFromEnv)
  renderDeviceKeys(st, isGateway)
  renderQr(st)
  renderDoctor(st)
  // 网关开关: 仅插件内嵌页提供, 网关运行/停止两种状态
  gatewayRunning = isGateway
  $('btn-gateway').classList.toggle('hidden', !pluginMode)
  $('btn-gateway').textContent = gatewayBusy
    ? t(gatewayRunning ? 'stopping' : 'starting')
    : t(gatewayRunning ? 'stopGateway' : 'startGateway')
  $('btn-gateway').disabled = gatewayBusy
  // 网关端口配置: 仅插件内嵌页提供
  $('gateway-port-row').classList.toggle('hidden', !pluginMode || !gatewayPortLoaded)
  if (pluginMode) {
    const cur = $('gateway-port-current')
    if (cur) cur.textContent = t('gatewayPort.current', { port: gatewayPort })
  }
  const upOk = st.upstream.reachable
  const hero = $('admin-hero')
  if (hero) {
    const heroState = isGateway ? (upOk ? 'running' : 'attention') : isPlugin ? 'plugin' : 'offline'
    hero.className = 'admin-hero ' + heroState
    const titleKey = heroState === 'running' ? 'hero.running' : heroState === 'attention' ? 'hero.attention' : heroState === 'plugin' ? 'hero.plugin' : 'hero.offline'
    const descKey = heroState === 'running' ? 'hero.runningDesc' : heroState === 'attention' ? 'hero.attentionDesc' : heroState === 'plugin' ? 'hero.pluginDesc' : 'hero.offlineDesc'
    $('admin-hero-title').textContent = t(titleKey)
    $('admin-hero-desc').textContent = heroState === 'running'
      ? t(descKey, { online: st.onlineCount || 0, requests: st.totalRequests || 0 })
      : t(descKey)
    $('admin-hero-status').textContent = isGateway ? (upOk ? t('stat.reachable') : t('stat.unreachable')) : t(isPlugin ? 'badge.embedded' : 'badge.gatewayDown')
    const action = $('admin-hero-action')
    if (action) {
      const actionKey = heroState === 'plugin' ? 'hero.startGateway' : heroState === 'offline' ? 'hero.copyToken' : 'hero.openDevices'
      action.textContent = t(actionKey)
      action.dataset.heroAction = heroState === 'plugin' ? 'start' : heroState === 'offline' ? 'copy' : 'devices'
    }
  }
  const hostIPs = (st.lanIPs || []).join(t('stat.ipSep')) || '127.0.0.1'
  const latestHtml = st.latest?.newer
    ? `<div class="v">${t('stat.updateAvailable', { version: st.latest.version })}</div><div class="k">${t('stat.currentV', { version: st.version })} · <a href="${st.latest.url || '#'}" target="_blank" rel="noopener" style="color:var(--dsr-accent-strong)">${t('stat.download')}</a></div>`
    : `<div class="v">v${st.version}</div><div class="k">${isPlugin ? t('stat.embedded') : st.latest?.error ? t('stat.updateCheck', { error: st.latest.error }) : st.latest?.version ? t('stat.latest') : t('stat.notChecked')}</div>`
  $('stats').innerHTML = `
    <div class="stat-card"><div class="v">v${st.version}</div><div class="k">${t(isPlugin ? 'stat.pluginVersion' : 'stat.gatewayVersion')}</div></div>
    <div class="stat-card ${st.latest?.newer ? 'warn' : 'ok'}">${latestHtml}</div>
    <div class="stat-card ok"><div class="v" style="font-size:13px">${hostIPs}</div><div class="k">${t('stat.hostIP', { hostname: st.hostname })}${isPlugin ? t('stat.phoneGateway', { port: gatewayPort }) : t('stat.phoneThis')}</div></div>
    <div class="stat-card ${upOk ? 'ok' : 'warn'}"><div class="v">${t(upOk ? 'stat.reachable' : 'stat.unreachable')}</div><div class="k">${t('stat.dshUpstream', { url: st.upstream.url })}</div></div>
    <div class="stat-card"><div class="v">${st.onlineCount}/${st.deviceCount}</div><div class="k">${t('stat.devicesOnline')}</div></div>
    <div class="stat-card"><div class="v">${st.totalRequests}</div><div class="k">${t('stat.totalRequests')}</div></div>
    <div class="stat-card"><div class="v">${st.authFailures}</div><div class="k">${t('stat.authFailures')}</div></div>
    <div class="stat-card"><div class="v">${fmtUptime(st.uptimeSec)}</div><div class="k">${t('stat.uptime', { host: st.host, port: st.port })}</div></div>`

  $('device-summary').textContent = isPlugin
    ? t(st.gatewayInstalled ? 'device.installedNotRunning' : 'device.noGatewayBinary')
    : t('device.ipRefresh', { n: st.devices.length })
  if (isPlugin && !st.devices.length) {
    $('device-rows').innerHTML = ''
    const rel = 'https://github.com/Blank-not-black/dsh-Remote/releases/latest/download/'
    const apkBtn = `<a class="mini-btn" href="${rel}dsh-remote.apk" target="_blank" rel="noopener">${t('device.downloadApp')}</a>`
    if (!st.gatewayInstalled) {
      // 只有插件包真的没有内置网关程序时, 才引导下载网关
      const isWin = /windows|win32/i.test(navigator.userAgent)
      const gwAsset = isWin ? 'dsh-remote-win-x64.exe' : 'dsh-remote-linux-x64'
      $('device-empty').innerHTML = `
        <div>${t('device.noBinaryGuide')}</div>
        <div class="empty-actions">
          <a class="mini-btn" href="${rel}${gwAsset}" target="_blank" rel="noopener">${t('device.downloadGateway', { os: isWin ? 'Windows x64' : 'Linux x64' })}</a>
          ${apkBtn}
        </div>
        <div class="muted" style="margin-top:10px">${t('device.afterRunGuide')}</div>`
    } else {
      $('device-empty').innerHTML = `
        <div>${t('device.installedGuide')}</div>
        <div class="empty-actions">${apkBtn}</div>
        <div class="muted" style="margin-top:10px">${t('device.afterStartGuide')}</div>`
    }
    $('device-empty').classList.remove('hidden')
  } else {
    // 网关模式: 清掉可能残留的引导文案, 设备为空时只显示中性提示
    $('device-empty').textContent = t('noDevices')
    $('device-empty').classList.toggle('hidden', st.devices.length > 0)
    $('device-rows').innerHTML = st.devices.map(d => {
      const kindText = t(d.kind === 'app' ? 'device.kind.app' : d.kind === 'admin' ? 'device.kind.admin' : d.kind === 'web' ? 'device.kind.web' : 'device.kind.unknown')
      const noteHtml = d.note ? `<b>${d.note.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</b>` : '<span class="muted">—</span>'
      const ch = `${d.channels.mux ? 'mux' : ''}${d.channels.mux && d.channels.host ? ' · ' : ''}${d.channels.host ? 'host' : ''}${!d.channels.mux && !d.channels.host ? '—' : ''}`
      return `
    <tr>
      <td data-label="${t('th.status')}"><span class="dot ${d.online ? 'on' : 'off'}"></span>${t(d.online ? 'device.online' : 'device.offline')}</td>
      <td data-label="${t('th.name')}">${noteHtml}<button class="mini-btn" data-note-ip="${d.ip}" data-note="${d.note.replace(/"/g, '&quot;')}" style="margin-left:6px;padding:1px 7px">${t('device.note')}</button></td>
      <td data-label="${t('th.type')}"><span class="badge ${d.kind}">${kindText}</span></td>
      <td data-label="${t('th.ip')}" class="mono nowrap">${d.ip}</td>
      <td data-label="${t('th.channels')}" class="mono nowrap">${ch}</td>
      <td data-label="${t('th.requests')}">${d.requests}</td>
      <td data-label="${t('th.lastSeen')}" class="nowrap">${fmtTime(d.lastSeen)}</td>
      <td data-label="${t('th.ua')}" class="ua" title="${d.ua.replace(/"/g, '&quot;')}">${d.ua || '—'}</td>
      <td class="act">${d.online && d.kind !== 'admin' ? `<button class="mini-btn" data-kick="${d.ip}">${t('device.kick')}</button>` : ''}</td>
    </tr>`
    }).join('')
  }
  document.querySelectorAll('[data-kick]').forEach(btn =>
    btn.addEventListener('click', () => kick(btn.dataset.kick)))
  document.querySelectorAll('[data-note-ip]').forEach(btn =>
    btn.addEventListener('click', () => setNote(btn.dataset.noteIp, btn.dataset.note)))
}

function pairTarget(st, accessToken) {
  const ip = (st.lanIPs || []).find(x => x && x !== '127.0.0.1' && x !== '0.0.0.0') || (st.lanIPs || [])[0]
  const host = ip || (st.host && st.host !== '0.0.0.0' ? st.host : location.hostname)
  const port = st.port || 8787
  const base = `http://${host}:${port}`
  return {
    url: `dshremote://pair?token=${encodeURIComponent(accessToken)}&server=${encodeURIComponent(base)}`,
    base
  }
}

function renderQr(st) {
  const box = $('pair-box')
  const accessToken = qrToken || shownToken
  if (!qrShown || !accessToken || st.mode !== 'gateway') {
    box.classList.add('hidden')
    return
  }
  try {
    const pt = pairTarget(st, accessToken)
    const qr = window.qrcode(0, 'M')
    qr.addData(pt.url)
    qr.make()
    $('pair-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    $('pair-hint').textContent = `${qrLabel ? qrLabel + ' · ' : ''}${t('pair.hint', { base: pt.base })}`
    box.classList.remove('hidden')
  } catch (e) {
    $('pair-qr').textContent = t('pair.failed')
    box.classList.remove('hidden')
  }
}

async function setNote(ip, current) {
  const name = prompt(t('prompt.note', { ip }), current || '')
  if (name === null) return
  const res = await fetch(`${API}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
    body: JSON.stringify({ ip, name })
  })
  if (res.ok) {
    toast(t('toast.noteSaved'), 'ok')
    setTimeout(loadState, 300)
  } else {
    toast(t('toast.noteFailed'), 'err')
  }
}

async function kick(ip) {
  if (!confirm(t('confirm.kick'))) return
  const res = await fetch(`${API}/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
    body: JSON.stringify({ ip })
  })
  if (res.ok) {
    toast(t('toast.kicked', { ip }), 'ok')
    setTimeout(loadState, 400)
  } else {
    toast(t('toast.opFailed'), 'err')
  }
}

async function deviceKeyMutation(action, payload = {}) {
  deviceKeyBusy = true
  const toggle = $('device-key-enabled')
  if (toggle) toggle.disabled = true
  try {
    const res = await fetch(`${API}/device-keys/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
      body: JSON.stringify(payload),
    })
    const out = await res.json().catch(() => ({}))
    if (!res.ok || !out.ok) throw new Error(out.detail || out.error || `HTTP ${res.status}`)
    return out
  } catch (error) {
    toast(t('deviceKeys.failed', { msg: error?.message || error }), 'err')
    return null
  } finally {
    deviceKeyBusy = false
    if (toggle) toggle.disabled = false
  }
}

async function setDeviceKeyMode(enabled) {
  const toggle = $('device-key-enabled')
  const confirmKey = enabled ? 'deviceKeys.enableConfirm' : 'deviceKeys.disableConfirm'
  if (!confirm(t(confirmKey))) {
    toggle.checked = !enabled
    return
  }
  const out = await deviceKeyMutation('mode', { enabled })
  if (!out) {
    toggle.checked = !enabled
    return
  }
  qrShown = false
  qrToken = ''
  qrLabel = ''
  toast(t(enabled ? 'deviceKeys.enabled' : 'deviceKeys.disabled'), 'ok')
  await loadState()
}

async function createDeviceKey() {
  const note = prompt(t('deviceKeys.notePrompt'), '')
  if (note === null) return
  const out = await deviceKeyMutation('create', { note })
  if (!out) return
  toast(t('deviceKeys.created'), 'ok')
  await loadState()
  if (out.entry) showDeviceKeyQr(out.entry)
}

async function editDeviceKeyNote(entry) {
  if (!entry) return
  const note = prompt(t('deviceKeys.notePrompt'), entry.note || '')
  if (note === null) return
  const out = await deviceKeyMutation('note', { id: entry.id, note })
  if (!out) return
  toast(t('deviceKeys.saved'), 'ok')
  await loadState()
}

function showDeviceKeyQr(entry) {
  if (!entry?.token) return
  qrToken = entry.token
  qrLabel = entry.note || ''
  qrShown = true
  renderQr(lastState || { mode: '', token: '' })
  $('pair-box').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
}

async function copyDeviceKey(entry) {
  if (!entry?.token) return
  try {
    await navigator.clipboard.writeText(entry.token)
    toast(t('toast.tokenCopied'), 'ok')
  } catch {
    toast(t('toast.copyFailed'), 'err')
  }
}

async function rotateDeviceKey(entry) {
  if (!entry || !confirm(t('deviceKeys.rotateConfirm'))) return
  const out = await deviceKeyMutation('rotate', { id: entry.id })
  if (!out) return
  qrShown = false
  qrToken = ''
  qrLabel = ''
  toast(t('deviceKeys.rotated'), 'ok')
  await loadState()
}

async function revokeDeviceKey(entry) {
  if (!entry || !confirm(t('deviceKeys.revokeConfirm'))) return
  const out = await deviceKeyMutation('revoke', { id: entry.id })
  if (!out) return
  if (qrToken === entry.token) {
    qrShown = false
    qrToken = ''
    qrLabel = ''
  }
  toast(t('deviceKeys.revoked'), 'ok')
  await loadState()
}

function enter() {
  const val = $('token-input').value.trim()
  if (!val) return
  token = val
  store.set('dshAdminToken', val)
  history.replaceState(null, '', location.pathname)
  showMain()
  loadState()
  loadStats()
  timer = setInterval(loadState, 5000)
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = setInterval(loadStats, 30000)
}

function showMain() {
  $('login-view').classList.add('hidden')
  $('main-view').classList.remove('hidden')
}

function logout() {
  token = ''
  store.del('dshAdminToken')
  clearInterval(timer)
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
  $('main-view').classList.add('hidden')
  $('login-view').classList.remove('hidden')
  $('conn-badge').textContent = t('unauth')
  $('conn-badge').className = 'conn-badge off'
  $('token-input').value = ''
}

$('btn-login').addEventListener('click', enter)
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter() })
$('btn-logout').addEventListener('click', logout)
$('device-key-enabled').addEventListener('change', (event) => setDeviceKeyMode(event.target.checked))
$('btn-device-key-add').addEventListener('click', createDeviceKey)
// 插件内嵌: 收起面板按钮 → postMessage 给父窗口(同源)关闭右侧抽屉
$('btn-close-drawer').addEventListener('click', () => {
  window.parent.postMessage({ source: 'dsh-remote-admin', type: 'close' }, location.origin)
})
$('admin-hero-action').addEventListener('click', () => {
  const action = $('admin-hero-action').dataset.heroAction
  if (action === 'start') return $('btn-gateway').click()
  if (action === 'copy') return $('btn-copy').click()
  $('device-rows').closest('.table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
})
$('doctor-toggle').addEventListener('click', () => {
  doctorExpanded = !doctorExpanded
  store.set('dshAdminDoctorCollapsed', doctorExpanded ? '0' : '1')
  if (lastState) renderDoctor(lastState)
})
$('doctor-refresh').addEventListener('click', () => {
  $('doctor-subtitle').textContent = t('doctor.checking')
  loadState()
})
$('doctor-copy-report').addEventListener('click', () => {
  const report = doctorChecks.map(check => `[${check.status.toUpperCase()}] ${check.title}: ${check.detail}`).join('\n')
  doctorCopy(`DSH Remote Doctor\n${report}`, 'doctor.reportCopied')
})
$('doctor-steps').addEventListener('click', (event) => {
  const button = event.target.closest('[data-doctor-action]')
  if (!button || !lastState) return
  const action = button.dataset.doctorAction
  if (action === 'start') return $('btn-gateway').click()
  if (action === 'address') return doctorCopy(pairTarget(lastState, shownToken || token).base, 'doctor.addressCopied')
  if (action === 'firewall') return doctorCopy(firewallCommand(lastState), 'doctor.commandCopied')
  if (action === 'qr') {
    const firstKey = lastState.deviceKeys?.enabled && lastState.deviceKeys.entries?.[0]
    if (firstKey) showDeviceKeyQr(firstKey)
    else {
      qrToken = shownToken
      qrLabel = ''
      qrShown = true
      renderQr(lastState)
      $('pair-box').scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    }
  }
})
$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shownToken || token)
    toast(t('toast.tokenCopied'), 'ok')
  } catch {
    toast(t('toast.copyFailed'), 'err')
  }
})

$('btn-qr').addEventListener('click', () => {
  qrToken = shownToken
  qrLabel = ''
  qrShown = !qrShown
  renderQr(lastState || { mode: '', token: shownToken })
})

/* 右上角「网关」徽章: 新标签页打开独立网关管理面板(带 token 免登录) */
$('conn-badge').addEventListener('click', () => {
  const st = lastState
  if (!st || st.mode !== 'gateway') { toast(t('toast.gatewayDown'), 'err'); return }
  const host = location.hostname || '127.0.0.1'
  const port = st.port || 8787
  const url = `http://${host}:${port}/admin?token=${encodeURIComponent(shownToken || token)}`
  try {
    window.open(url, '_blank', 'noopener')
  } catch {
    toast(t('toast.popupBlocked'), 'err')
  }
})

$('btn-rotate').addEventListener('click', async () => {
  if (!confirm(t('confirm.rotate'))) return
  try {
    const res = await fetch(`${API}/token/rotate`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + (token || shownToken), 'x-dsh-remote-client': 'admin' }
    })
    const out = await res.json().catch(() => ({}))
    if (out.ok && out.token) {
      token = out.token
      store.set('dshAdminToken', out.token)
      toast(t('toast.rotated'), 'ok')
      setTimeout(loadState, 300)
    } else {
      toast(out.detail || out.error || t('toast.rotateFailed'), 'err')
    }
  } catch (e) {
    toast(t('toast.rotateFailedMsg', { msg: e.message || e }), 'err')
  }
})

$('btn-gateway').addEventListener('click', async () => {
  if (gatewayBusy) return
  gatewayBusy = true
  const btn = $('btn-gateway')
  btn.disabled = true
  btn.textContent = t(gatewayRunning ? 'stopping' : 'starting')
  try {
    const res = await fetch(`${API}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
      body: JSON.stringify({ action: gatewayRunning ? 'stop' : 'start' })
    })
    const out = await res.json().catch(() => ({}))
    if (out.ok) {
      toast(out.started ? t('toast.gatewayStarted') : out.running ? t('toast.gatewayAlready') : gatewayRunning ? t('toast.gatewayStopped') : (out.pending ? t('toast.gatewayPending') : t('toast.done')), 'ok')
    } else {
      toast(out.error || t('toast.opFailed'), 'err')
    }
  } catch (e) {
    toast(t('toast.opFailedMsg', { msg: e.message || e }), 'err')
  }
  gatewayBusy = false
  setTimeout(loadState, 700)
})

$('btn-save-port').addEventListener('click', async () => {
  const input = $('gateway-port-input')
  const raw = input.value.trim()
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    toast(t('toast.portInvalid'), 'err')
    return
  }
  const btn = $('btn-save-port')
  const wasRunning = gatewayRunning
  btn.disabled = true
  try {
    const res = await fetch(`${API}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
      body: JSON.stringify({ port })
    })
    const out = await res.json().catch(() => ({}))
    if (out.ok) {
      const saved = Number(out.port) || port
      const effective = Number(out.effectivePort || out.port) || saved
      if (out.effectivePort && effective !== saved) {
        toast(t('toast.portEnv', { port: effective }), 'ok')
      } else if (wasRunning) {
        toast(t('toast.portSaved', { port: effective }), 'ok')
      } else {
        toast(t('toast.portSavedIdle', { port: effective }), 'ok')
      }
      loadGatewayConfig()
      setTimeout(loadState, 800)
    } else {
      toast(out.error || t('toast.portFailedMsg', { msg: res.status }), 'err')
    }
  } catch (e) {
    toast(t('toast.portFailedMsg', { msg: e.message || e }), 'err')
  }
  btn.disabled = false
})

function renderLangBtn() {
  const btn = $('btn-lang')
  if (btn) btn.textContent = I18N.lang === 'zh' ? 'EN' : '中文'
  document.title = t('login.title')
}

const THEME_META = [
  { id: 'default', sw: ['#0B0E1A', '#151B33', '#5B8CFF'] },
  { id: 'dark', sw: ['#05348B', '#0D438F', '#F9A647'] },
  { id: 'light', sw: ['#EFEEEC', '#FAF8F5', '#E6BC7B'] },
  { id: 'neutral', sw: ['#DDD4B8', '#585818', '#832D15'] }
]

function renderThemeBtn() {
  const cur = window.DSHTheme.get()
  const meta = THEME_META.find(m => m.id === cur)
  const label = $('theme-label')
  const swatch = $('theme-swatch')
  if (label) label.textContent = t('theme.' + cur)
  if (swatch && meta) swatch.style.background = meta.sw[0]
  const btn = $('btn-theme')
  if (btn) btn.title = t('theme.' + cur)
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

$('btn-lang').addEventListener('click', () => {
  I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh')
  renderLangBtn()
  renderThemeBtn()
  if (lastState) render(lastState)
  else if (!token && !pluginMode) $('conn-badge').textContent = t('unauth')
})

$('btn-theme').addEventListener('click', openThemePanel)
$('theme-close').addEventListener('click', () => $('modal-theme').classList.add('hidden'))
// 赞赏支持
$('btn-donate').addEventListener('click', openDonateModal)
$('donate-close').addEventListener('click', () => $('modal-donate').classList.add('hidden'))
$('modal-donate').addEventListener('click', (e) => { if (e.target === $('modal-donate')) $('modal-donate').classList.add('hidden') })
// 反馈
$('btn-feedback').addEventListener('click', (e) => { e.stopPropagation(); toggleFeedbackMenu() })
$('fb-menu').addEventListener('click', (e) => {
  if (e.target.closest('a[role="menuitem"]')) closeFeedbackMenu()
})
document.addEventListener('click', (e) => {
  if (!e.target.closest('.fb-wrap')) closeFeedbackMenu()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('fb-menu').classList.contains('hidden')) { closeFeedbackMenu(); $('btn-feedback').focus() }
})

function start(showLogin) {
  if (!showLogin) {
    $('login-view').classList.add('hidden')
  } else {
    $('login-view').classList.remove('hidden')
  }
  showMain()
  loadState()
  loadGatewayConfig()
  loadStats()
  timer = setInterval(loadState, 5000)
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = setInterval(loadStats, 30000)
}

if (pluginMode) {
  $('login-view').classList.add('hidden')
  $('btn-console').classList.add('hidden')
  $('btn-close-drawer').classList.remove('hidden')
  start(false)
} else if (token) {
  $('token-input').value = token
  start(false)
} else {
  $('main-view').classList.add('hidden')
  $('login-view').classList.remove('hidden')
}
renderLangBtn()
renderThemeBtn()
