/* DSH Remote 网关/插件管理页 · 零依赖 */
'use strict'

const $ = (id) => document.getElementById(id)
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
  if (sec < 60) return sec + ' 秒'
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟'
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时 ' + Math.floor(sec % 3600 / 60) + ' 分'
  return Math.floor(sec / 86400) + ' 天 ' + Math.floor(sec % 86400 / 3600) + ' 小时'
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
      toast('令牌无效', 'err')
      logout()
    } else {
      $('conn-badge').textContent = '连接失败'
      $('conn-badge').className = 'conn-badge off'
    }
  }
}

function render(st) {
  lastState = st
  const isPlugin = st.mode === 'plugin'
  const isGateway = st.mode === 'gateway'
  shownToken = st.token || token
  $('conn-badge').textContent = isPlugin ? '内嵌' : isGateway ? '网关' : '已连接'
  $('conn-badge').className = 'conn-badge ' + (isPlugin || isGateway ? 'on' : 'off')
  $('conn-badge').title = isGateway ? '新标签页打开网关管理面板' : '网关未运行'
  $('token-full').textContent = shownToken || (isPlugin ? '插件模式 · 未接网关, 无需令牌' : '未获取到令牌')
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
    ? (gatewayRunning ? '停止中…' : '启动中…')
    : (gatewayRunning ? '停止网关' : '启动网关')
  $('btn-gateway').disabled = gatewayBusy
  const upOk = st.upstream.reachable
  const hostIPs = (st.lanIPs || []).join('、') || '127.0.0.1'
  const latestHtml = st.latest?.newer
    ? `<div class="v">v${st.latest.version} 可用</div><div class="k">当前 v${st.version} · <a href="${st.latest.url || '#'}" target="_blank" rel="noopener" style="color:var(--orange)">去下载</a></div>`
    : `<div class="v">v${st.version}</div><div class="k">${isPlugin ? 'DSH 内嵌 · 免网关' : st.latest?.error ? '更新检查: ' + st.latest.error : st.latest?.version ? '已是最新(来源检查)' : '未检查更新'}</div>`
  $('stats').innerHTML = `
    <div class="stat-card"><div class="v">v${st.version}</div><div class="k">${isPlugin ? '插件版本' : '网关版本'}</div></div>
    <div class="stat-card ${st.latest?.newer ? 'warn' : 'ok'}">${latestHtml}</div>
    <div class="stat-card ok"><div class="v" style="font-size:15px">${hostIPs}</div><div class="k">主机 IP · ${st.hostname}${isPlugin ? ' (手机连 8787 网关)' : ' (手机连这个地址)'}</div></div>
    <div class="stat-card ${upOk ? 'ok' : 'warn'}"><div class="v">${upOk ? '可达' : '不可达'}</div><div class="k">DSH 上游 ${st.upstream.url}</div></div>
    <div class="stat-card"><div class="v">${st.onlineCount}/${st.deviceCount}</div><div class="k">设备在线 / 累计</div></div>
    <div class="stat-card"><div class="v">${st.totalRequests}</div><div class="k">总请求数</div></div>
    <div class="stat-card"><div class="v">${st.authFailures}</div><div class="k">认证失败</div></div>
    <div class="stat-card"><div class="v">${fmtUptime(st.uptimeSec)}</div><div class="k">运行时长 · ${st.host}:${st.port}</div></div>`

  $('device-summary').textContent = isPlugin
    ? (st.gatewayInstalled ? '网关已安装 · 当前未运行' : '未检测到网关程序')
    : `${st.devices.length} 个 IP · 每 5 秒刷新`
  if (isPlugin && !st.devices.length) {
    $('device-rows').innerHTML = ''
    const rel = 'https://github.com/Blank-not-black/dsh-Remote/releases/latest/download/'
    const apkBtn = `<a class="mini-btn" href="${rel}dsh-remote.apk" target="_blank" rel="noopener">下载手机 App</a>`
    if (!st.gatewayInstalled) {
      // 只有插件包真的没有内置网关程序时, 才引导下载网关
      const isWin = /windows|win32/i.test(navigator.userAgent)
      const gwAsset = isWin ? 'dsh-remote-win-x64.exe' : 'dsh-remote-linux-x64'
      $('device-empty').innerHTML = `
        <div>本插件包未包含网关程序：下载对应系统的网关并运行</div>
        <div class="empty-actions">
          <a class="mini-btn" href="${rel}${gwAsset}" target="_blank" rel="noopener">下载网关 (${isWin ? 'Windows x64' : 'Linux x64'})</a>
          ${apkBtn}
        </div>
        <div class="muted" style="margin-top:10px">运行网关后回到本页刷新，即可看到设备监控与完整令牌</div>`
    } else {
      $('device-empty').innerHTML = `
        <div>网关已随插件安装，当前未运行 — 点击上方「启动网关」开启</div>
        <div class="empty-actions">${apkBtn}</div>
        <div class="muted" style="margin-top:10px">启动后本页会自动刷新为网关模式（完整设备监控 + 令牌）</div>`
    }
    $('device-empty').classList.remove('hidden')
  } else {
    // 网关模式: 清掉可能残留的引导文案, 设备为空时只显示中性提示
    $('device-empty').textContent = '暂无设备记录'
    $('device-empty').classList.toggle('hidden', st.devices.length > 0)
    $('device-rows').innerHTML = st.devices.map(d => `
    <tr>
      <td><span class="dot ${d.online ? 'on' : 'off'}"></span>${d.online ? '在线' : '离线'}</td>
      <td>${d.note ? `<b>${d.note.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</b>` : '<span class="muted">—</span>'}<button class="mini-btn" data-note-ip="${d.ip}" data-note="${d.note.replace(/"/g, '&quot;')}" style="margin-left:6px;padding:1px 7px">备注</button></td>
      <td><span class="badge ${d.kind}">${d.kind === 'app' ? '手机App' : d.kind === 'admin' ? '管理页' : d.kind === 'web' ? '浏览器' : '未知'}</span></td>
      <td class="mono">${d.ip}</td>
      <td class="mono">${d.channels.mux ? 'mux' : ''}${d.channels.mux && d.channels.host ? ' · ' : ''}${d.channels.host ? 'host' : ''}${!d.channels.mux && !d.channels.host ? '—' : ''}</td>
      <td>${d.requests}</td>
      <td>${fmtTime(d.lastSeen)}</td>
      <td class="ua" title="${d.ua.replace(/"/g, '&quot;')}">${d.ua || '—'}</td>
      <td>${d.online && d.kind !== 'admin' ? `<button class="mini-btn" data-kick="${d.ip}">断开</button>` : ''}</td>
    </tr>`).join('')
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
    const t = pairTarget(st)
    const qr = window.qrcode(0, 'M')
    qr.addData(t.url)
    qr.make()
    $('pair-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    $('pair-hint').textContent = `${t.base} · App「设置 → 扫码连接」，或系统相机扫一扫自动打开 App`
    box.classList.remove('hidden')
  } catch (e) {
    $('pair-qr').textContent = '二维码生成失败'
    box.classList.remove('hidden')
  }
}

async function setNote(ip, current) {
  const name = prompt('给 ' + ip + ' 设置备注（留空清除）：', current || '')
  if (name === null) return
  const res = await fetch(`${API}/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
    body: JSON.stringify({ ip, name })
  })
  if (res.ok) {
    toast('备注已保存', 'ok')
    setTimeout(loadState, 300)
  } else {
    toast('保存失败', 'err')
  }
}

async function kick(ip) {
  if (!confirm('断开该设备的连接？')) return
  const res = await fetch(`${API}/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
    body: JSON.stringify({ ip })
  })
  if (res.ok) {
    toast('已断开 ' + ip, 'ok')
    setTimeout(loadState, 400)
  } else {
    toast('操作失败', 'err')
  }
}

function enter() {
  const t = $('token-input').value.trim()
  if (!t) return
  token = t
  store.set('dshAdminToken', t)
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
  $('conn-badge').textContent = '未认证'
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
    toast('令牌已复制', 'ok')
  } catch {
    toast('复制失败，请手动选择', 'err')
  }
})

$('btn-qr').addEventListener('click', () => {
  qrShown = !qrShown
  renderQr(lastState || { mode: '', token: shownToken })
})

/* 右上角「网关」徽章: 新标签页打开独立网关管理面板(带 token 免登录) */
$('conn-badge').addEventListener('click', () => {
  const st = lastState
  if (!st || st.mode !== 'gateway') { toast('网关未运行', 'err'); return }
  const host = location.hostname || '127.0.0.1'
  const port = st.port || 8787
  const url = `http://${host}:${port}/admin?token=${encodeURIComponent(shownToken || token)}`
  try {
    window.open(url, '_blank', 'noopener')
  } catch {
    toast('浏览器阻止了新窗口，请允许弹窗', 'err')
  }
})

$('btn-rotate').addEventListener('click', async () => {
  if (!confirm('轮换后旧令牌立即失效，手机与浏览器都需要重新扫码/输入。继续？')) return
  try {
    const res = await fetch(`${API}/token/rotate`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + (token || shownToken), 'x-dsh-remote-client': 'admin' }
    })
    const out = await res.json().catch(() => ({}))
    if (out.ok && out.token) {
      token = out.token
      store.set('dshAdminToken', out.token)
      toast('令牌已轮换，请重新给设备配对', 'ok')
      setTimeout(loadState, 300)
    } else {
      toast(out.detail || out.error || '轮换失败', 'err')
    }
  } catch (e) {
    toast('轮换失败：' + (e.message || e), 'err')
  }
})

$('btn-gateway').addEventListener('click', async () => {
  if (gatewayBusy) return
  gatewayBusy = true
  const btn = $('btn-gateway')
  btn.disabled = true
  btn.textContent = gatewayRunning ? '停止中…' : '启动中…'
  try {
    const res = await fetch(`${API}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-dsh-remote-client': 'admin' },
      body: JSON.stringify({ action: gatewayRunning ? 'stop' : 'start' })
    })
    const out = await res.json().catch(() => ({}))
    if (out.ok) {
      toast(out.started ? '网关已启动' : out.running ? '网关已在运行' : gatewayRunning ? '网关已停止' : (out.pending ? '网关启动中，稍后刷新' : '已执行'), 'ok')
    } else {
      toast(out.error || '操作失败', 'err')
    }
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'err')
  }
  gatewayBusy = false
  setTimeout(loadState, 700)
})

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
