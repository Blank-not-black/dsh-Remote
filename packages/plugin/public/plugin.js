/* DSH Remote 插件端快速状态面板 · 零依赖 */
'use strict'

const $ = (id) => document.getElementById(id)
const API = '/remote/admin/api'
let latest = null
let busy = false
let usageBusy = false
let usageLoadedAt = 0

function text(id, value) { const el = $(id); if (el) el.textContent = value == null ? '—' : String(value) }
function escapeText(value) { return String(value ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) }
function openConsole() { window.open('/remote/admin/', '_blank', 'noopener') }
function closePanel() { window.parent.postMessage({ source: 'dsh-remote-plugin', type: 'close' }, location.origin) }
function fmtTokens(value) {
  const n = Number(value) || 0
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K'
  return String(Math.round(n))
}
function fmtCost(value) { return '¥' + (Number(value) || 0).toFixed(2) }
function renderUsage(days) {
  const section = $('plugin-usage')
  const empty = $('plugin-usage-empty')
  if (!section) return
  if (!Array.isArray(days) || !days.length) {
    section.classList.add('empty')
    empty?.classList.remove('hidden')
    text('plugin-usage-date', '—')
    text('plugin-token-total', '—')
    text('plugin-peak-share', '0%')
    text('plugin-cost', '—')
    text('plugin-cost-split', '等待网关统计')
    if ($('plugin-token-track')) $('plugin-token-track').innerHTML = ''
    $('plugin-usage-ring')?.style.setProperty('--plugin-peak', '0%')
    return
  }
  const today = days[days.length - 1] || {}
  const total = today.total || {}
  const input = Number(total.input) || 0
  const cache = (Number(total.cacheRead) || 0) + (Number(total.cacheWrite) || 0)
  const output = Number(total.output) || 0
  const totalTokens = input + cache + output
  const peakCost = Number(today.peak?.cost) || 0
  const offCost = Number(today.off?.cost) || 0
  const totalCost = peakCost + offCost
  const peakShare = totalCost > 0 ? Math.round(peakCost / totalCost * 100) : 0
  const share = (n) => totalTokens ? Math.max(0, n / totalTokens * 100) : 0
  section.classList.remove('empty')
  empty?.classList.add('hidden')
  text('plugin-usage-date', today.date || '—')
  text('plugin-token-total', fmtTokens(totalTokens))
  text('plugin-peak-share', peakShare + '%')
  text('plugin-cost', fmtCost(totalCost))
  text('plugin-cost-split', `高峰 ${fmtCost(peakCost)} · 空闲 ${fmtCost(offCost)}`)
  const track = $('plugin-token-track')
  if (track) track.innerHTML = `<i class="input" style="width:${share(input)}%"></i><i class="cache" style="width:${share(cache)}%"></i><i class="output" style="width:${share(output)}%"></i>`
  $('plugin-usage-ring')?.style.setProperty('--plugin-peak', peakShare + '%')
}
async function loadUsage() {
  if (usageBusy) return
  usageBusy = true
  try {
    const res = await fetch(`${API}/stats/summary?days=7`, { headers: { 'x-dsh-remote-client': 'plugin' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const out = await res.json()
    renderUsage(out.days || [])
  } catch {
    renderUsage([])
  } finally {
    usageLoadedAt = Date.now()
    usageBusy = false
  }
}

function setBusy(value) {
  busy = value
  $('plugin-primary').disabled = value
  $('plugin-toggle').disabled = value
}

function render(st) {
  latest = st
  const gateway = st.mode === 'gateway'
  const healthy = gateway && st.upstream?.reachable !== false
  const installed = st.gatewayInstalled !== false
  const hero = $('plugin-hero')
  hero.classList.toggle('ok', healthy)
  hero.classList.toggle('warn', gateway && !healthy)
  hero.classList.toggle('off', !gateway)

  text('plugin-status', healthy ? '系统运行正常' : gateway ? '网关需要关注' : installed ? '网关待启动' : 'DSH 已连接')
  text('plugin-status-desc', healthy
    ? `${st.onlineCount || 0} 台设备在线 · 最近请求 ${st.totalRequests || 0} 次`
    : gateway ? 'DSH 上游暂时不可达，请打开控制台诊断' : installed ? '本地网关尚未运行，启动后即可远程连接' : '插件已连接 DSH，但未检测到网关程序')
  text('plugin-status-meta', healthy ? '本地服务可用' : gateway ? '需要查看诊断' : installed ? '本地服务未启动' : '仅 DSH 内嵌模式')

  const primary = $('plugin-primary')
  primary.textContent = healthy ? '打开控制台' : installed ? '启动网关' : '查看控制台'
  primary.dataset.action = healthy ? 'console' : installed ? 'start' : 'console'
  text('plugin-toggle-label', gateway ? '停止网关' : '启动网关')
  $('plugin-toggle').classList.toggle('hidden', !installed)

  text('plugin-version', st.version ? 'v' + st.version : '—')
  text('plugin-gateway-version', gateway ? (st.version ? 'v' + st.version : '运行中') : '未运行')
  text('plugin-devices', `${st.onlineCount || 0} / ${st.deviceCount || 0}`)
  text('plugin-host', (st.lanIPs || []).find(x => x && x !== '127.0.0.1') || st.host || '127.0.0.1')
  if (!gateway) {
    usageLoadedAt = Date.now()
    renderUsage([])
  } else if (Date.now() - usageLoadedAt > 30000) {
    loadUsage()
  }
  $('plugin-error').classList.add('hidden')
}

async function load() {
  try {
    const res = await fetch(`${API}/state`, { headers: { 'x-dsh-remote-client': 'plugin' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    render(await res.json())
  } catch (e) {
    $('plugin-hero').classList.remove('ok', 'warn')
    $('plugin-hero').classList.add('off')
    text('plugin-status', '无法读取状态')
    text('plugin-status-desc', 'DSH Remote 插件暂时无法访问本地服务')
    text('plugin-status-meta', '请稍后重试')
    $('plugin-error').textContent = '状态读取失败：' + escapeText(e.message || e)
    $('plugin-error').classList.remove('hidden')
  }
}

async function toggleGateway() {
  if (busy) return
  setBusy(true)
  const action = latest?.mode === 'gateway' ? 'stop' : 'start'
  try {
    const res = await fetch(`${API}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-remote-client': 'plugin' },
      body: JSON.stringify({ action }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    await new Promise(resolve => setTimeout(resolve, 650))
    await load()
  } catch (e) {
    $('plugin-error').textContent = '网关操作失败：' + (e.message || e)
    $('plugin-error').classList.remove('hidden')
  } finally { setBusy(false) }
}

async function copyToken() {
  const token = latest?.token || ''
  if (!token) return
  try {
    await navigator.clipboard.writeText(token)
    const button = $('plugin-copy')
    const old = button.lastChild
    if (old) old.textContent = '已复制'
    setTimeout(() => { if (old) old.textContent = '复制令牌' }, 1400)
  } catch {
    $('plugin-error').textContent = '复制失败，请从控制台手动复制'
    $('plugin-error').classList.remove('hidden')
  }
}

$('plugin-close').addEventListener('click', closePanel)
$('plugin-console').addEventListener('click', openConsole)
$('plugin-toggle').addEventListener('click', toggleGateway)
$('plugin-copy').addEventListener('click', copyToken)
$('plugin-primary').addEventListener('click', () => {
  if ($('plugin-primary').dataset.action === 'start') toggleGateway()
  else openConsole()
})

load()
loadUsage()
setInterval(load, 5000)
setInterval(loadUsage, 30000)
