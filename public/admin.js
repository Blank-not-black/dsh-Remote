/* DSH Remote 网关管理页 · 零依赖 */
'use strict'

const $ = (id) => document.getElementById(id)
let token = localStorage.getItem('dshAdminToken') || new URLSearchParams(location.search).get('token') || ''
let timer = null

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
  if (!token) return
  try {
    const res = await fetch('/admin/api/state', {
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
  $('conn-badge').textContent = '已连接'
  $('conn-badge').className = 'conn-badge on'
  $('token-full').textContent = token
  const upOk = st.upstream.reachable
  const hostIPs = (st.lanIPs || []).join('、') || '127.0.0.1'
  const latestHtml = st.latest?.newer
    ? `<div class="v">v${st.latest.version} 可用</div><div class="k">当前 v${st.version} · <a href="${st.latest.url || '#'}" target="_blank" rel="noopener" style="color:var(--orange)">去下载</a></div>`
    : `<div class="v">v${st.version}</div><div class="k">${st.latest?.error ? '更新检查: ' + st.latest.error : st.latest?.version ? '已是最新(来源检查)' : '未检查更新'}</div>`
  $('stats').innerHTML = `
    <div class="stat-card"><div class="v">v${st.version}</div><div class="k">网关版本</div></div>
    <div class="stat-card ${st.latest?.newer ? 'warn' : 'ok'}">${latestHtml}</div>
    <div class="stat-card ok"><div class="v" style="font-size:15px">${hostIPs}</div><div class="k">主机 IP · ${st.hostname} (手机连这个地址)</div></div>
    <div class="stat-card ${upOk ? 'ok' : 'warn'}"><div class="v">${upOk ? '可达' : '不可达'}</div><div class="k">DSH 上游 ${st.upstream.url}</div></div>
    <div class="stat-card"><div class="v">${st.onlineCount}/${st.deviceCount}</div><div class="k">设备在线 / 累计</div></div>
    <div class="stat-card"><div class="v">${st.totalRequests}</div><div class="k">总请求数</div></div>
    <div class="stat-card"><div class="v">${st.authFailures}</div><div class="k">认证失败</div></div>
    <div class="stat-card"><div class="v">${fmtUptime(st.uptimeSec)}</div><div class="k">运行时长 · ${st.host}:${st.port}</div></div>`

  $('device-summary').textContent = `${st.devices.length} 个 IP · 每 5 秒刷新`
  const rows = st.devices.map(d => `
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
  $('device-rows').innerHTML = rows
  $('device-empty').classList.toggle('hidden', st.devices.length > 0)
  document.querySelectorAll('[data-kick]').forEach(btn =>
    btn.addEventListener('click', () => kick(btn.dataset.kick)))
  document.querySelectorAll('[data-note-ip]').forEach(btn =>
    btn.addEventListener('click', () => setNote(btn.dataset.noteIp, btn.dataset.note)))
}

async function setNote(ip, current) {
  const name = prompt('给 ' + ip + ' 设置备注（留空清除）：', current || '')
  if (name === null) return
  const res = await fetch('/admin/api/note', {
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
  const res = await fetch('/admin/api/kick', {
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
  localStorage.setItem('dshAdminToken', t)
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
  localStorage.removeItem('dshAdminToken')
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
$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(token)
    toast('令牌已复制', 'ok')
  } catch {
    toast('复制失败，请手动选择', 'err')
  }
})

if (token) {
  $('token-input').value = token
  showMain()
  loadState()
  timer = setInterval(loadState, 5000)
}
