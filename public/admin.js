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

function toast(text, kind = '') {
  const el = $('toast')
  el.textContent = text
  el.className = 'toast ' + kind
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600)
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
  renderQr(st)
  // 网关开关: 仅插件内嵌页提供, 网关运行/停止两种状态
  gatewayRunning = isGateway
  $('btn-gateway').classList.toggle('hidden', !pluginMode)
  $('btn-gateway').textContent = gatewayBusy
    ? t(gatewayRunning ? 'stopping' : 'starting')
    : t(gatewayRunning ? 'stopGateway' : 'startGateway')
  $('btn-gateway').disabled = gatewayBusy
  const upOk = st.upstream.reachable
  const hostIPs = (st.lanIPs || []).join(t('stat.ipSep')) || '127.0.0.1'
  const latestHtml = st.latest?.newer
    ? `<div class="v">${t('stat.updateAvailable', { version: st.latest.version })}</div><div class="k">${t('stat.currentV', { version: st.version })} · <a href="${st.latest.url || '#'}" target="_blank" rel="noopener" style="color:var(--dsr-accent-strong)">${t('stat.download')}</a></div>`
    : `<div class="v">v${st.version}</div><div class="k">${isPlugin ? t('stat.embedded') : st.latest?.error ? t('stat.updateCheck', { error: st.latest.error }) : st.latest?.version ? t('stat.latest') : t('stat.notChecked')}</div>`
  $('stats').innerHTML = `
    <div class="stat-card"><div class="v">v${st.version}</div><div class="k">${t(isPlugin ? 'stat.pluginVersion' : 'stat.gatewayVersion')}</div></div>
    <div class="stat-card ${st.latest?.newer ? 'warn' : 'ok'}">${latestHtml}</div>
    <div class="stat-card ok"><div class="v" style="font-size:13px">${hostIPs}</div><div class="k">${t('stat.hostIP', { hostname: st.hostname })}${isPlugin ? t('stat.phoneGateway') : t('stat.phoneThis')}</div></div>
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

function pairTarget(st) {
  const ip = (st.lanIPs || []).find(x => x && x !== '127.0.0.1' && x !== '0.0.0.0') || (st.lanIPs || [])[0]
  const host = ip || (st.host && st.host !== '0.0.0.0' ? st.host : location.hostname)
  const port = st.port || 8787
  const base = `http://${host}:${port}`
  return {
    url: `dshremote://pair?token=${encodeURIComponent(shownToken)}&server=${encodeURIComponent(base)}`,
    base
  }
}

function renderQr(st) {
  const box = $('pair-box')
  if (!qrShown || !shownToken || st.mode !== 'gateway') {
    box.classList.add('hidden')
    return
  }
  try {
    const pt = pairTarget(st)
    const qr = window.qrcode(0, 'M')
    qr.addData(pt.url)
    qr.make()
    $('pair-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    $('pair-hint').textContent = t('pair.hint', { base: pt.base })
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
  token = ''
  store.del('dshAdminToken')
  clearInterval(timer)
  $('main-view').classList.add('hidden')
  $('login-view').classList.remove('hidden')
  $('conn-badge').textContent = t('unauth')
  $('conn-badge').className = 'conn-badge off'
  $('token-input').value = ''
}

$('btn-login').addEventListener('click', enter)
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') enter() })
$('btn-logout').addEventListener('click', logout)
// 插件内嵌: 收起面板按钮 → postMessage 给父窗口(同源)关闭右侧抽屉
$('btn-close-drawer').addEventListener('click', () => {
  window.parent.postMessage({ source: 'dsh-remote-admin', type: 'close' }, location.origin)
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

$('btn-lang').addEventListener('click', () => {
  I18N.setLang(I18N.lang === 'zh' ? 'en' : 'zh')
  renderLangBtn()
  renderThemeBtn()
  if (lastState) render(lastState)
  else if (!token && !pluginMode) $('conn-badge').textContent = t('unauth')
})

$('btn-theme').addEventListener('click', openThemePanel)
$('theme-close').addEventListener('click', () => $('modal-theme').classList.add('hidden'))

function start(showLogin) {
  if (!showLogin) {
    $('login-view').classList.add('hidden')
  } else {
    $('login-view').classList.remove('hidden')
  }
  showMain()
  loadState()
  timer = setInterval(loadState, 5000)
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
