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
window.mountAdminRelaySettings = () => window.DshRelaySettings?.mount($('relay-settings'), {
  connection: () => { const saved=token;return {url:route=>API+route,headers:adminHeaders({},saved),valid:()=>token===saved} },
  path:'/relay', credentials:'same-origin'
})
// 沙箱 iframe/隐私模式里 localStorage 可能抛 SecurityError, 不能让它杀死整个页面
const store = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  del(k) { try { localStorage.removeItem(k) } catch {} }
}
let token = store.get('dshAdminToken') || new URLSearchParams(location.search).get('token') || ''
function adminHeaders(extra = {}, accessToken = token) {
  const headers = { 'x-dsh-remote-client': 'admin', ...extra }
  // /remote/* 可能由 Caddy Basic Auth 保护。插件路由自身已在 DSH 登录态内，
  // 这里不能再写 Authorization: Bearer，否则会覆盖浏览器的 Basic 凭据并形成 401 循环。
  if (!pluginMode && accessToken) headers.authorization = 'Bearer ' + accessToken
  return headers
}
let timer = null
let gatewayRunning = false
let gatewayBusy = false
let shownToken = token
let lastState = null
let qrShown = false
let qrToken = ''
let qrLabel = ''
let deviceKeyBusy = false
let lanBusy = false, lanCode = '', lanExpiry = 0, lanRevision = 0, lanRead = null
const lanText = (zh, en) => I18N.lang === 'en' ? en : zh
function lanError(code) {
  return {
    DEVICE_KEYS_REQUIRED: lanText('请先启用独立设备密钥。', 'Enable independent device keys first.'),
    LAN_LISTENER_REQUIRED: lanText('网关目前仅允许本机访问，请改用可从局域网访问的监听地址。', 'The gateway only accepts local connections. Configure a LAN-accessible listener.'),
    DISCOVERY_PORT_UNAVAILABLE: lanText('发现端口被占用，请检查是否运行了其他网关。', 'The discovery port is occupied. Check for another gateway.'),
    GATEWAY_UNAVAILABLE: lanText('网关暂不可用，请检查运行状态。', 'The gateway is unavailable. Check its status.'),
    PAIRING_CLOSED: lanText('配对已关闭，请重新开放。', 'Pairing is closed. Open a new window.'),
  }[code] || lanText('操作失败，请检查网关后重试。', 'Operation failed. Check the gateway and try again.')
}
function renderLan(state = {}) {
  $('lan-pairing-title').textContent = lanText('局域网发现与配对', 'LAN discovery and pairing')
  $('lan-pairing-hint').textContent = lanText('需先启用上方的独立设备密钥，再开放配对。Android 手机可搜索同一 Wi-Fi 下的电脑，输入限时配对码连接。配对码仅显示本次，成功后自动关闭；扫码与手动连接仍可使用。', 'Enable independent device keys above, then open pairing. Find this computer from the Android app on the same Wi-Fi and enter the one-time code. Pairing closes after success; QR and manual connections remain available.')
  $('btn-lan-open').textContent = lanText('开放 10 分钟配对', 'Open pairing for 10 minutes')
  $('btn-lan-close').textContent = lanText('关闭配对', 'Close pairing')
  const enabled = state.enabled === true
  if (!enabled || state.expiresAt !== lanExpiry || Date.now() >= lanExpiry) lanCode = ''
  $('lan-pairing-code').textContent = lanCode
  $('lan-pairing-code').hidden = !lanCode
  $('btn-lan-open').disabled = lanBusy || !lastState?.deviceKeys?.enabled
  $('btn-lan-close').disabled = lanBusy || !enabled
  $('lan-pairing-status').textContent = enabled ? lanText('配对开放至 ', 'Pairing open until ') + new Date(state.expiresAt).toLocaleTimeString()
    : state.error ? lanError(state.error) : lanText('当前未开放配对。', 'Pairing is closed.')
}
async function refreshLan() {
  if (lanBusy || lanRead || !lastState) return
  const savedToken = token, revision = lanRevision, job = {}
  lanRead = job
  try {
    const response = await fetch(API + '/lan', { headers: adminHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(5000) })
    const state = await response.json()
    if (savedToken !== token || lanBusy || revision !== lanRevision) return
    if (!response.ok) { lanCode = ''; renderLan({ error: state.error || 'GATEWAY_UNAVAILABLE' }); return }
    renderLan(state)
  } catch { if (savedToken === token && !lanBusy && revision === lanRevision) { lanCode = ''; renderLan({ error: 'GATEWAY_UNAVAILABLE' }) } }
  finally { if (lanRead === job) lanRead = null }
}
async function changeLan(enabled) {
  if (lanBusy) return
  lanRevision++
  lanBusy = true
  $('btn-lan-open').disabled = true; $('btn-lan-close').disabled = true
  const savedToken = token, revision = lanRevision
  try {
    const response = await fetch(API + '/lan', { method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
      credentials: 'same-origin', signal: AbortSignal.timeout(8000), body: JSON.stringify({ enabled }) })
    const state = await response.json()
    if (savedToken !== token || revision !== lanRevision) return
    if (!response.ok || !state.ok) throw Error(state.error || 'PAIRING_FAILED')
    lanCode = state.code || ''; lanExpiry = state.expiresAt || 0
    lanBusy = false; renderLan(state)
  } catch (error) { if (savedToken === token && revision === lanRevision) { lanCode = ''; lanBusy = false; renderLan({ error: error.message }); toast(lanError(error.message), 'err') } }
  finally { if (revision === lanRevision) lanBusy = false }
}
$('btn-lan-open').addEventListener('click', () => changeLan(true))
$('btn-lan-close').addEventListener('click', () => changeLan(false))
const revealedDeviceKeys = new Set()
let gatewayPort = 8787
let gatewayPortLoaded = false
let loginStartup = null
let loginStartupBusy = false
let loginStartupGeneration = 0
function renderLoginStartup() {
  const state = loginStartup
  const key = !state ? 'unavailable' : !state.supported ? 'unsupported' : state.code === 'STARTUP_CONFLICT' ? 'conflict'
    : state.code ? 'broken' : state.enabled ? 'on' : 'off'
  $('login-startup-status').textContent = t('startup.' + key)
  const btn = $('btn-login-startup')
  btn.disabled = loginStartupBusy || !state?.supported || state.code === 'STARTUP_CONFLICT'
  btn.textContent = t('startup.' + (loginStartupBusy ? 'busy' : state?.enabled ? 'disable' : 'enable'))
  $('btn-login-startup-repair').classList.toggle('hidden', state?.code !== 'STARTUP_FILES_MISSING')
  $('btn-login-startup-repair').disabled = loginStartupBusy
  $('btn-login-startup-refresh').disabled = loginStartupBusy
}
async function loadLoginStartup() {
  if (loginStartupBusy) return
  const generation = ++loginStartupGeneration, accessToken = token
  try {
    const res = await fetch(`${API}/autostart`, { headers: adminHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(20000) })
    const out = await res.json()
    if (generation !== loginStartupGeneration || token !== accessToken) return
    loginStartup = res.ok && out.ok ? out : null
  } catch { if (generation === loginStartupGeneration && token === accessToken) loginStartup = null }
  if (generation === loginStartupGeneration && token === accessToken) renderLoginStartup()
}
async function changeLoginStartup(enabled) {
  if (loginStartupBusy) return
  loginStartupBusy = true
  ++loginStartupGeneration
  const accessToken = token
  renderLoginStartup()
  try {
    const res = await fetch(`${API}/autostart`, { method: 'POST', headers: adminHeaders({ 'content-type': 'application/json' }),
      credentials: 'same-origin', signal: AbortSignal.timeout(30000), body: JSON.stringify({ enabled }) })
    const out = await res.json()
    if (token !== accessToken) return
    if (!res.ok || !out.ok) throw Error(out.detail || out.error || t('toast.opFailed'))
    loginStartup = out
    toast(t('startup.' + (out.enabled ? 'savedOn' : 'savedOff')), 'ok')
  } catch (error) { if (token === accessToken) toast(error.message || t('toast.opFailed'), 'err') }
  finally {
    loginStartupBusy = false
    renderLoginStartup()
    if (token || pluginMode) void loadLoginStartup()
  }
}
$('btn-login-startup').addEventListener('click', () => changeLoginStartup(!loginStartup?.enabled))
$('btn-login-startup-repair').addEventListener('click', () => changeLoginStartup(true))
$('btn-login-startup-refresh').addEventListener('click', loadLoginStartup)
let doctorExpanded = store.get('dshAdminDoctorCollapsed') !== '1'
let doctorChecks = []
const HOST_IP_SELECTION_KEY = 'dshAdminEnabledHostIPsV1'
const MANUAL_HOST_IP_KEY = 'dshAdminManualHostIPsV1'
const setup = window.DshSetup?.mount($('admin-setup'), {
  base: pluginMode ? '/remote/' : '/',
  canStart: pluginMode,
  inConsole: true,
  start: () => pluginMode ? $('btn-gateway').click() : $('doctor-card').scrollIntoView({ behavior: 'smooth' }),
  console: () => { window.DshConsole?.select('diagnostics'); $('doctor-card').scrollIntoView({ behavior: 'smooth' }) },
  deviceKey: () => $('btn-device-key-add').click(), hosts: st => enabledHostIPs(st),
})
window.addEventListener('dsh-remote-setup', event => setup?.show(event.detail?.step))
document.addEventListener('dsh-remote-section', event => {
  if (event.detail.section !== 'devices') {
    qrShown = false; qrToken = ''; qrLabel = ''
    $('pair-box').classList.add('hidden')
    revealedDeviceKeys.clear()
    if (lastState) renderDeviceKeys(lastState,lastState.mode === 'gateway')
    setup?.conceal?.()
  }
})

function normalizedHostIPs(st) {
  const detected = Array.isArray(st?.lanIPs) ? st.lanIPs : []
  return [...new Set([...detected, ...manualHostIPs(st)].map(validManualHost).filter(Boolean))]
}

function validManualHost(value) {
  const host = String(value || '').trim()
  if (!host || host.length > 253 || host === '0.0.0.0' || host === '127.0.0.1') return ''
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return ''
  if (/^\d+(?:\.\d+){3}$/.test(host) && host.split('.').some(part => Number(part) > 255)) return ''
  const labels = host.split('.')
  if (labels.some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return ''
  return host
}

function hostIPScope(st) {
  return [st?.hostname || location.hostname || 'host', st?.host || ''].join('|')
}

function manualHostIPScope(st) {
  return st?.hostname || location.hostname || 'host'
}

function hostIPPreferences() {
  try {
    const value = JSON.parse(store.get(HOST_IP_SELECTION_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function manualHostPreferences() {
  try {
    const value = JSON.parse(store.get(MANUAL_HOST_IP_KEY) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function manualHostIPs(st) {
  const values = manualHostPreferences()[manualHostIPScope(st)]
  return Array.isArray(values) ? [...new Set(values.map(validManualHost).filter(Boolean))] : []
}

function saveManualHostIPs(st, values) {
  const prefs = manualHostPreferences()
  prefs[manualHostIPScope(st)] = [...new Set(values.map(validManualHost).filter(Boolean))]
  store.set(MANUAL_HOST_IP_KEY, JSON.stringify(prefs))
}

function enabledHostIPs(st) {
  const all = normalizedHostIPs(st)
  if (!all.length) return []
  const saved = hostIPPreferences()[hostIPScope(st)]
  if (!Array.isArray(saved)) return all
  const selected = all.filter(ip => saved.includes(ip))
  return selected.length ? selected : all
}

function saveEnabledHostIPs(st, selected) {
  const prefs = hostIPPreferences()
  prefs[hostIPScope(st)] = normalizedHostIPs(st).filter(ip => selected.includes(ip))
  store.set(HOST_IP_SELECTION_KEY, JSON.stringify(prefs))
}

function addManualHostIP() {
  if (!lastState) return
  const input = prompt(t('hostIPs.addPrompt'), '')
  if (input === null) return
  const host = validManualHost(input)
  if (!host) {
    toast(t('hostIPs.invalid'), 'err')
    return
  }
  if (normalizedHostIPs(lastState).includes(host)) {
    toast(t('hostIPs.exists'), 'err')
    return
  }
  saveManualHostIPs(lastState, [...manualHostIPs(lastState), host])
  saveEnabledHostIPs(lastState, [...enabledHostIPs(lastState), host])
  render(lastState)
}

function removeManualHostIP(st, host) {
  saveManualHostIPs(st, manualHostIPs(st).filter(value => value !== host))
  render(st)
}

function renderHostIPs(st) {
  const all = normalizedHostIPs(st)
  const selected = enabledHostIPs(st)
  const manual = new Set(manualHostIPs(st))
  const rows = $('host-ip-rows')
  const empty = $('host-ip-empty')
  const summary = $('host-ip-summary')
  if (!rows || !empty || !summary) return
  summary.textContent = all.length
    ? t('hostIPs.summary', { enabled: selected.length, total: all.length })
    : t('hostIPs.empty')
  rows.innerHTML = all.map(ip => `<tr>
    <td class="host-ip-toggle"><label class="host-ip-switch" title="${esc(t('hostIPs.enable'))}"><input type="checkbox" data-host-ip-toggle="${esc(ip)}" ${selected.includes(ip) ? 'checked' : ''}><span aria-hidden="true"></span></label></td>
    <td class="mono host-ip-value">${esc(ip)}</td>
    <td class="host-ip-use">${esc(t(selected.includes(ip) ? 'hostIPs.enabled' : 'hostIPs.disabled'))}${manual.has(ip) ? ` <button class="mini-btn host-ip-remove" type="button" data-host-ip-remove="${esc(ip)}">${esc(t('hostIPs.remove'))}</button>` : ''}</td>
  </tr>`).join('')
  empty.classList.toggle('hidden', all.length > 0)
  rows.querySelectorAll('[data-host-ip-toggle]').forEach(input => input.addEventListener('change', () => {
    const ip = input.dataset.hostIpToggle
    const next = enabledHostIPs(st).filter(value => value !== ip)
    if (input.checked) next.push(ip)
    if (!next.length) {
      input.checked = true
      toast(t('hostIPs.keepOne'), 'err')
      return
    }
    saveEnabledHostIPs(st, next)
    render(st)
  }))
  rows.querySelectorAll('[data-host-ip-remove]').forEach(button => button.addEventListener('click', () => {
    removeManualHostIP(st, button.dataset.hostIpRemove)
  }))
}

function onlineClientDevices(st) {
  return (st.devices || []).filter(device => device.online && (device.kind === 'app' || device.kind === 'web'))
}

function firewallCommand(st) {
  const port = Number(st.port || gatewayPort) || 8787
  const ip = enabledHostIPs(st).find(value => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value || ''))
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
  const ip = enabledHostIPs(st).find(value => value && value !== '127.0.0.1' && value !== '0.0.0.0')
  const base = ip ? `http://${ip}:${port}` : ''
  const clients = onlineClientDevices(st)
  const events = st.events || {}
  const realtime = !!(events.mux?.connected && events.host?.connected)
  return [
    { id: 'dsh', status: st.upstream?.reachable === true ? 'pass' : st.upstream?.reachable === false ? 'fail' : 'warn', title: t('doctor.dsh'), detail: st.upstream?.reachable == null ? window.DshRemoteUI?.t('waiting') || '尚未确认' : t(st.upstream.reachable ? 'doctor.dshPass' : 'doctor.dshFail') },
    { id: 'gateway', status: isGateway && !st.gatewayAuthError ? 'pass' : st.gatewayRunning ? 'warn' : 'fail', title: t('doctor.gateway'), detail: st.gatewayAuthError || (isGateway ? t('doctor.gatewayPass', { host: st.host, port }) : st.gatewayRunning ? window.DshRemoteUI?.t('attention') || '管理状态尚未确认' : t('doctor.gatewayFail')), action: !isGateway && !st.gatewayRunning && pluginMode ? 'start' : '' },
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

async function loadGatewayConfig() {
  if (!pluginMode) return
  try {
    const res = await fetch(`${API}/config`, {
      headers: adminHeaders(), credentials: 'same-origin'
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

function toast(text, kind = '') {
  const el = $('toast')
  el.textContent = text
  el.className = 'toast ' + kind
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600)
}

/* ---------------- 反馈 ---------------- */
function openFeedbackMenu() {
  const menu = $('fb-menu')
  // Escape header clipping/stacking contexts. The top layer remains inside
  // this iframe, so also constrain the menu to its actual viewport.
  if (menu.parentElement !== document.body) document.body.append(menu)
  menu.classList.remove('hidden')
  if (typeof menu.showPopover === 'function') {
    menu.setAttribute('popover', 'manual')
    menu.showPopover()
  }
  positionFeedbackMenu()
  $('btn-feedback').setAttribute('aria-expanded', 'true')
  const first = $('fb-menu').querySelector('[role="menuitem"]')
  if (first) first.focus()
}
function closeFeedbackMenu() {
  const menu = $('fb-menu')
  if (typeof menu.hidePopover === 'function' && menu.matches(':popover-open')) menu.hidePopover()
  menu.classList.add('hidden')
  $('btn-feedback').setAttribute('aria-expanded', 'false')
}
function toggleFeedbackMenu() {
  $('fb-menu').classList.contains('hidden') ? openFeedbackMenu() : closeFeedbackMenu()
}
function positionFeedbackMenu() {
  const menu = $('fb-menu')
  if (menu.classList.contains('hidden')) return
  const trigger = $('btn-feedback').getBoundingClientRect()
  const gap = 8, width = Math.max(0, Math.min(280, window.innerWidth - gap * 2))
  menu.style.width = width + 'px'
  menu.style.maxHeight = Math.max(0, window.innerHeight - gap * 2) + 'px'
  const height = menu.getBoundingClientRect().height
  const left = Math.max(gap, Math.min(trigger.right - width, window.innerWidth - width - gap))
  const below = trigger.bottom + gap
  const top = below + height <= window.innerHeight - gap ? below : Math.max(gap, Math.min(trigger.top - gap - height, window.innerHeight - height - gap))
  menu.style.left = left + 'px'; menu.style.top = top + 'px'
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
  const keyHtml = entries.map(entry => {
    const note = entry.note || t('deviceKeys.neverUsed')
    const ip = entry.lastIp || t('deviceKeys.neverUsed')
    return `<div class="device-key-grid" data-device-key-id="${esc(entry.id)}">
      <div class="device-key-note" data-label="${esc(t('deviceKeys.note'))}"><span>${esc(note)}</span><button class="mini-btn" type="button" data-device-key-note="${esc(entry.id)}">${esc(t('deviceKeys.edit'))}</button></div>
      <div class="device-key-ip" data-label="${esc(t('deviceKeys.ip'))}">${esc(ip)}</div>
      <code data-label="Token">${revealedDeviceKeys.has(entry.id) ? esc(entry.token) : '•••• •••• ••••'}</code>
      <div class="device-key-actions">
        <button class="mini-btn" type="button" data-device-key-show="${esc(entry.id)}">${esc(window.DshRemoteUI?.t(revealedDeviceKeys.has(entry.id) ? 'hide' : 'show') || '显示令牌')}</button>
        <button class="mini-btn" type="button" data-device-key-qr="${esc(entry.id)}">${esc(t('qrCode'))}</button>
        <button class="mini-btn" type="button" data-device-key-rotate="${esc(entry.id)}">${esc(t('rotateToken'))}</button>
        <button class="mini-btn" type="button" data-device-key-copy="${esc(entry.id)}">${esc(t('copyToken'))}</button>
        <button class="mini-btn danger" type="button" data-device-key-revoke="${esc(entry.id)}">${esc(t('deviceKeys.revoke'))}</button>
      </div>
    </div>`
  }).join('')
  if ($('device-key-rows').innerHTML !== keyHtml) $('device-key-rows').innerHTML = keyHtml
}

let stateLoadJob = null
async function loadState() {
  if (!token && !pluginMode) return
  if (stateLoadJob?.token === token) return stateLoadJob.promise
  const job = { token }
  stateLoadJob = job
  job.promise = readState(job).finally(() => { if (stateLoadJob === job) stateLoadJob = null })
  return job.promise
}
async function readState(job) {
  try {
    const res = await fetch(`${API}/state`, {
      headers: adminHeaders({}, job.token), credentials: 'same-origin',
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined
    })
    if (stateLoadJob !== job || token !== job.token) return
    if (!res.ok && res.status !== 401) throw new Error('HTTP ' + res.status)
    if (res.status === 401) throw new Error(pluginMode ? 'AUTH_LAYER' : 'AUTH')
    if (pluginMode && !String(res.headers.get('content-type') || '').includes('application/json')) throw new Error('AUTH_LAYER')
    const st = await res.json()
    if (stateLoadJob !== job || token !== job.token) return
    render(st)
  } catch (e) {
    if (stateLoadJob !== job || token !== job.token) return
    setup?.update(null)
    window.DshConsole?.update(null)
    qrShown = false; qrToken = ''; qrLabel = ''
    $('pair-box').classList.add('hidden')
    revealedDeviceKeys.clear()
    if (lastState) renderDeviceKeys(lastState,lastState.mode === 'gateway')
    if (e.message === 'AUTH') {
      toast(t('toast.tokenInvalid'), 'err')
      logout()
    } else if (e.message === 'AUTH_LAYER') {
      $('conn-badge').textContent = t('toast.authLayer')
      $('conn-badge').className = 'conn-badge off'
    } else {
      $('conn-badge').textContent = t('toast.connFailed')
      $('conn-badge').className = 'conn-badge off'
    }
  }
}

function render(st) {
  lastState = st
  void refreshLan()
  const isPlugin = st.mode === 'plugin'
  const isGateway = st.mode === 'gateway'
  shownToken = st.gatewayAuthError ? '' : st.token || token
  setup?.update({ ...st, token: shownToken })
  $('conn-badge').textContent = t(st.gatewayRunning ? 'badge.gateway' : isPlugin ? 'badge.embedded' : isGateway ? 'badge.gateway' : 'badge.connected')
  $('conn-badge').className = 'conn-badge ' + (isPlugin || isGateway ? 'on' : 'off')
  $('conn-badge').title = st.gatewayAuthError || t(isGateway ? 'badge.gateway.title' : 'badge.gatewayDown')
  $('token-full').textContent = shownToken || t(st.gatewayAuthError ? 'token.unavailable' : isPlugin ? 'token.pluginNoGateway' : 'token.unavailable')
  // 主机端插件模式: 显示真实令牌(复制可用), 只隐藏退出按钮; 令牌门禁本身不存在
  $('btn-copy').classList.toggle('hidden', !shownToken)
  $('btn-logout').classList.toggle('hidden', pluginMode)
  // 二维码与轮换只在网关模式下可用(二维码里有完整令牌, 不能在没有网关时生成)
  $('btn-qr').classList.toggle('hidden', isGateway !== true || !shownToken)
  $('btn-rotate').classList.toggle('hidden', isGateway !== true || !shownToken || !!st.tokenFromEnv)
  renderDeviceKeys(st, isGateway)
  renderHostIPs(st)
  renderQr(st)
  renderDoctor(st)
  // 网关开关: 仅插件内嵌页提供, 网关运行/停止两种状态
  gatewayRunning = isGateway || st.gatewayRunning === true
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
  const upOk = st.upstream?.reachable === true
  const hero = $('admin-hero')
  if (hero) {
    const heroState = st.gatewayAuthError ? 'attention' : isGateway ? (upOk ? 'running' : 'attention') : isPlugin ? 'plugin' : 'offline'
    hero.className = 'admin-hero ' + heroState
    const titleKey = heroState === 'running' ? 'hero.running' : heroState === 'attention' ? 'hero.attention' : heroState === 'plugin' ? 'hero.plugin' : 'hero.offline'
    const descKey = heroState === 'running' ? 'hero.runningDesc' : heroState === 'attention' ? 'hero.attentionDesc' : heroState === 'plugin' ? 'hero.pluginDesc' : 'hero.offlineDesc'
    $('admin-hero-title').textContent = t(titleKey)
    $('admin-hero-desc').textContent = heroState === 'running'
      ? t(descKey, { online: st.onlineCount || 0, requests: st.totalRequests || 0 })
      : st.gatewayAuthError || t(descKey)
    $('admin-hero-status').textContent = st.gatewayAuthError ? t('hero.attention') : isGateway ? (upOk ? t('stat.reachable') : t('stat.unreachable')) : t(isPlugin ? 'badge.embedded' : 'badge.gatewayDown')
    const action = $('admin-hero-action')
    if (action) {
      const actionKey = heroState === 'plugin' ? 'hero.startGateway' : heroState === 'offline' ? 'hero.copyToken' : 'hero.openDevices'
      action.textContent = t(actionKey)
      action.dataset.heroAction = heroState === 'plugin' ? 'start' : heroState === 'offline' ? 'copy' : 'devices'
    }
  }
  const latestHtml = st.latest?.newer
    ? `<div class="v">${t('stat.updateAvailable', { version: st.latest.version })}</div><div class="k">${t('stat.currentV', { version: st.version })} · <a href="${st.latest.url || '#'}" target="_blank" rel="noopener" style="color:var(--dsr-accent-strong)">${t('stat.download')}</a></div>`
    : `<div class="v">v${st.version}</div><div class="k">${isPlugin ? t('stat.embedded') : st.latest?.error ? t('stat.updateCheck', { error: st.latest.error }) : st.latest?.version ? t('stat.latest') : t('stat.notChecked')}</div>`
  $('stats').innerHTML = `
    <div class="stat-card"><div class="v">v${st.version}</div><div class="k">${t(isPlugin ? 'stat.pluginVersion' : 'stat.gatewayVersion')}</div></div>
    <div class="stat-card ${st.latest?.newer ? 'warn' : 'ok'}">${latestHtml}</div>
    <div class="stat-card ${upOk ? 'ok' : 'warn'}"><div class="v">${t(upOk ? 'stat.reachable' : 'stat.unreachable')}</div><div class="k">${t('stat.dshUpstream', { url: st.upstream.url })}</div></div>
    <div class="stat-card"><div class="v">${st.onlineCount}/${st.deviceCount}</div><div class="k">${t('stat.devicesOnline')}</div></div>
    <div class="stat-card"><div class="v">${st.totalRequests}</div><div class="k">${t('stat.totalRequests')}</div></div>
    <div class="stat-card"><div class="v">${st.authFailures}</div><div class="k">${t('stat.authFailures')}</div></div>
    <div class="stat-card"><div class="v">${fmtUptime(st.uptimeSec)}</div><div class="k">${t('stat.uptime', { host: st.host, port: st.port })}</div></div>`

  $('device-summary').textContent = st.gatewayAuthError || (isPlugin
    ? t(st.gatewayInstalled ? 'device.installedNotRunning' : 'device.noGatewayBinary')
    : t('device.ipRefresh', { n: st.devices.length }))
  if (isPlugin && !st.devices.length) {
    $('device-rows').innerHTML = ''
    const rel = 'https://github.com/Blank-not-black/dsh-Remote/releases/latest/download/'
    const apkBtn = `<a class="mini-btn" href="#admin-setup">${t('device.downloadApp')}</a>`
    if (st.gatewayAuthError) {
      $('device-empty').textContent = st.gatewayAuthError
    } else if (!st.gatewayInstalled) {
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
    const deviceHtml = st.devices.map(d => {
      const kindText = t(d.kind === 'app' ? 'device.kind.app' : d.kind === 'admin' ? 'device.kind.admin' : d.kind === 'web' ? 'device.kind.web' : 'device.kind.unknown')
      const noteHtml = d.note ? `<b>${d.note.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</b>` : '<span class="muted">—</span>'
      const ch = `${d.channels.mux ? 'mux' : ''}${d.channels.mux && d.channels.host ? ' · ' : ''}${d.channels.host ? 'host' : ''}${!d.channels.mux && !d.channels.host ? '—' : ''}`
      return `
    <tr data-remote-key="${esc(d.id || d.ip)}">
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
    if (window.DshRemoteUI) window.DshRemoteUI.reconcileRows($('device-rows'),deviceHtml)
    else $('device-rows').innerHTML = deviceHtml
  }
  window.DshConsole?.update({ ...st, token: shownToken })
}

function pairTarget(st, accessToken) {
  const port = st.port || 8787
  const hosts = enabledHostIPs(st).slice()
  if (!hosts.length) {
    const fallback = st.host && st.host !== '0.0.0.0' ? String(st.host).trim() : location.hostname
    if (fallback) hosts.push(fallback)
  }
  const bases = hosts.map(host => `http://${host}:${port}`)
  const query = new URLSearchParams({ token: String(accessToken || '') })
  for (const base of bases) query.append('server', base)
  return {
    url: `dshremote://pair?${query.toString()}`,
    base: bases[0] || '',
    bases
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
    headers: adminHeaders({ 'content-type': 'application/json' }), credentials: 'same-origin',
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
    headers: adminHeaders({ 'content-type': 'application/json' }), credentials: 'same-origin',
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
      headers: adminHeaders({ 'content-type': 'application/json' }), credentials: 'same-origin',
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
  window.DshConsole?.select('devices')
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
  timer = setInterval(loadState, 5000)
}

function showMain() {
  $('login-view').classList.add('hidden')
  $('main-view').classList.remove('hidden')
}

function logout() {
  lanRevision++; lanBusy = false; lanCode = ''; lanExpiry = 0
  $('lan-pairing-code').textContent = ''; $('lan-pairing-code').hidden = true
  token = ''
  store.del('dshAdminToken')
  clearInterval(timer)
  $('main-view').classList.add('hidden')
  $('login-view').classList.remove('hidden')
  $('conn-badge').textContent = t('unauth')
  $('conn-badge').className = 'conn-badge off'
  $('token-input').value = ''
  revealedDeviceKeys.clear()
  $('device-key-rows').innerHTML = ''
  window.DshConsole?.update(null)
  window.DshConsole?.conceal()
  setup?.conceal?.()
}

$('btn-login').addEventListener('click', enter)
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter() })
$('btn-logout').addEventListener('click', logout)
$('device-key-enabled').addEventListener('change', (event) => setDeviceKeyMode(event.target.checked))
$('btn-device-key-add').addEventListener('click', createDeviceKey)
$('device-key-rows').addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  for (const [name,handler] of [['note',editDeviceKeyNote],['qr',showDeviceKeyQr],['rotate',rotateDeviceKey],['copy',copyDeviceKey],['revoke',revokeDeviceKey]]) {
    const id=button.dataset['deviceKey'+name[0].toUpperCase()+name.slice(1)]
    if (id) { handler(lastState?.deviceKeys?.entries?.find(entry=>entry.id===id)); return }
  }
  const id=button.dataset.deviceKeyShow
  if(id) {
    if(revealedDeviceKeys.has(id))revealedDeviceKeys.delete(id);else revealedDeviceKeys.add(id)
    if(lastState)renderDeviceKeys(lastState,lastState.mode==='gateway')
  }
})
$('device-rows').addEventListener('click', event => {
  const kickButton=event.target.closest('[data-kick]')
  if(kickButton)return kick(kickButton.dataset.kick)
  const noteButton=event.target.closest('[data-note-ip]')
  if(noteButton)setNote(noteButton.dataset.noteIp,noteButton.dataset.note)
})
// 插件内嵌: 收起面板按钮 → postMessage 给父窗口(同源)关闭右侧抽屉
$('btn-close-drawer').addEventListener('click', () => {
  window.parent.postMessage({ source: 'dsh-remote-admin', type: 'close' }, location.origin)
})
$('admin-hero-action').addEventListener('click', () => {
  const action = $('admin-hero-action').dataset.heroAction
  if (action === 'start') return $('btn-gateway').click()
  if (action === 'copy') return $('btn-copy').click()
  window.DshConsole?.select('devices')
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
    window.DshConsole?.select('devices')
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

$('btn-host-ip-add').addEventListener('click', addManualHostIP)

/* 右上角「网关」徽章: 新标签页打开独立网关管理面板(带 token 免登录) */
$('conn-badge').addEventListener('click', () => {
  const st = lastState
  if (!st || st.mode !== 'gateway') { toast(t('toast.gatewayDown'), 'err'); return }
  const host = location.protocol === 'dsh-app:' ? '127.0.0.1' : location.hostname || '127.0.0.1'
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
      headers: adminHeaders({}, token || shownToken), credentials: 'same-origin'
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
  if (gatewayRunning && !confirm(window.DshRemoteUI?.t('runtimeHint') || '停止网关会中断连接，继续？')) return
  gatewayBusy = true
  const btn = $('btn-gateway')
  btn.disabled = true
  btn.textContent = t(gatewayRunning ? 'stopping' : 'starting')
  try {
    const res = await fetch(`${API}/gateway`, {
      method: 'POST',
      headers: adminHeaders({ 'content-type': 'application/json' }), credentials: 'same-origin',
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
  setTimeout(loadLoginStartup, 800)
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
      headers: adminHeaders({ 'content-type': 'application/json' }), credentials: 'same-origin',
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
      setTimeout(loadLoginStartup, 1000)
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
  { id: 'default', sw: ['#0D1117', '#21262D', '#58A6FF'] },
  { id: 'dark', sw: ['#161316', '#302323', '#FFB86B'] },
  { id: 'light', sw: ['#F5F7F8', '#FFFFFF', '#176B87'] },
  { id: 'neutral', sw: ['#EEF1E8', '#FAFBF6', '#47643C'] },
  { id: 'mono', sw: ['#050505', '#333333', '#F5F5F5'] },
  { id: 'fish', sw: ['#EAF6FF', '#FFFFFF', '#2F52D0'] }
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

$('btn-lang').addEventListener('click', () => {
  I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh')
  renderLangBtn()
  renderThemeBtn()
  renderLoginStartup()
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
for(const id of ['btn-ai-doctor','admin-doctor'])$(id)?.addEventListener('click', () => {
  closeFeedbackMenu()
  if(typeof window.DshDoctorEntry?.open!=='function'){toast('诊疗组件未能加载，请刷新页面后重试。','err');return}
  window.DshDoctorEntry.open({state:()=>lastState,pluginMode,token:()=>token,copy:async text=>{try{await navigator.clipboard.writeText(text);return true}catch{return false}},toast})
})
$('fb-menu').addEventListener('click', (e) => {
  if (e.target.closest('a[role="menuitem"]')) closeFeedbackMenu()
})
document.addEventListener('click', (e) => {
  if (!e.target.closest('#btn-feedback,#fb-menu')) closeFeedbackMenu()
})
window.addEventListener('resize', positionFeedbackMenu)
window.addEventListener('scroll', closeFeedbackMenu, { passive: true })
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
  loginStartup = null
  renderLoginStartup()
  loadLoginStartup()
  timer = setInterval(loadState, 5000)
}

if (pluginMode) {
  $('login-view').classList.add('hidden')
  $('btn-console').classList.add('hidden')
  if (location.protocol === 'dsh-app:' && window.parent !== window) $('btn-plugin-panel').classList.remove('hidden')
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
