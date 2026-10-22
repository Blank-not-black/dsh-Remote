/* DSH Remote 插件端快速状态面板 · 零依赖 */
'use strict'

const $ = (id) => document.getElementById(id)
const API = '/remote/admin/api'
let latest = null
let busy = false
let usageBusy = false
let usageLoadedAt = 0
let usageData = null
const setup = window.DshSetup?.mount($('plugin-setup'), {
  base: '/remote/', start: () => toggleGateway(), console: () => openConsole(null,'diagnostics'), deviceKey: () => openConsole(null,'devices'),
})

function text(id, value) { const el = $(id); if (el) el.textContent = value == null ? '—' : String(value) }
function escapeText(value) { return String(value ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) }
function openConsole(event, section = '') {
  event?.preventDefault()
  // Desktop 拒绝 dsh-app: 弹窗；在当前 iframe 导航，沿用宿主认证与抽屉。
  const target = '/remote/admin/' + (section ? '#remote/' + section : '')
  if (location.protocol === 'dsh-app:') location.assign(target)
  else window.open(target, '_blank', 'noopener')
}
function closePanel() { window.parent.postMessage({ source: 'dsh-remote-plugin', type: 'close' }, location.origin) }
function renderUsage(data, phase = '') {
  const target = $('plugin-cost-data')
  const html = window.DshInsights?.costHtml(data, phase, true, false, true) || '额度组件暂不可用'
  if (target && target.innerHTML !== html) target.innerHTML = html
}
async function loadUsage() {
  if (usageBusy) return
  usageBusy = true
  $('plugin-usage-refresh').disabled = true
  try {
    const res = await fetch(`${API}/cost`, { credentials: 'same-origin', signal: AbortSignal.timeout(20000), headers: { 'x-dsh-remote-client': 'plugin' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const out = await res.json()
    usageData = out
    renderUsage(out)
  } catch {
    renderUsage(usageData, 'error')
  } finally {
    usageLoadedAt = Date.now()
    usageBusy = false
    $('plugin-usage-refresh').disabled = false
  }
}

function setBusy(value) {
  busy = value
  $('plugin-primary').disabled = value
  if ($('plugin-toggle')) $('plugin-toggle').disabled = value
}

function render(st) {
  latest = st
  setup?.update(st)
  const gateway = st.mode === 'gateway' || st.gatewayRunning === true
  const authError = st.gatewayAuthError || ''
  const healthy = st.mode === 'gateway' && !authError && st.upstream?.reachable === true
  const model = typeof window !== 'undefined' ? window.DshRemoteUI?.derive(st) : null
  const installed = st.gatewayInstalled !== false
  const hero = $('plugin-hero')
  hero.classList.toggle('ok', healthy)
  hero.classList.toggle('warn', gateway && !healthy)
  hero.classList.toggle('off', !gateway)

  text('plugin-status', healthy ? '系统运行正常' : gateway ? '网关需要关注' : installed ? '网关待启动' : 'DSH 已连接')
  text('plugin-status-desc', healthy
    ? `${model?.onlineCount ?? (st.devices || []).filter(d => d.online && (d.kind === 'app' || d.kind === 'web')).length} 个在线连接`
    : authError || (gateway ? st.upstream?.reachable === false ? 'DSH 上游暂时不可达，请打开控制台诊断' : '连接状态尚未确认，请打开控制台检查' : installed ? '本地网关尚未运行，启动后即可远程连接' : '插件已连接 DSH，但未检测到网关程序'))
  text('plugin-status-meta', healthy ? '本地服务可用' : gateway ? '需要查看诊断' : installed ? '本地服务未启动' : '仅 DSH 内嵌模式')

  const primary = $('plugin-primary')
  const hasClient = (st.devices || []).some(d => d.online && (d.kind === 'app' || d.kind === 'web'))
  const pairedBefore = (st.devices || []).some(d => d.kind === 'app' || d.kind === 'web') || st.deviceKeys?.entries?.length
  primary.textContent = healthy && !hasClient ? pairedBefore ? '添加手机' : '安装 App 并连接手机' : healthy ? '添加手机' : gateway ? '检查连接' : installed ? '启动网关' : '查看控制台'
  primary.dataset.action = healthy && typeof setup?.show === 'function' ? 'setup' : gateway ? 'console' : installed ? 'start' : 'console'
  text('plugin-toggle-label', gateway ? '停止网关' : '启动网关')
  $('plugin-toggle-icon')?.setAttribute('data-morph-state', gateway ? 'open' : 'closed')
  $('plugin-toggle')?.classList.toggle('hidden', !installed)

  text('plugin-version', st.version ? 'v' + st.version : '—')
  text('plugin-gateway-version', gateway ? ('v' + (st.gatewayVersion || st.version || '未知')) : '未运行')
  text('plugin-devices', `${st.onlineCount || 0} / ${st.deviceCount || 0}`)
  text('plugin-host', (st.lanIPs || []).find(x => x && x !== '127.0.0.1') || st.host || '127.0.0.1')
  if (typeof window !== 'undefined' && window.DshRemoteUI) {
    const ui = window.DshRemoteUI
    const path = $('plugin-health-path'), list = $('plugin-client-list')
    const pathHtml = ui.pathHtml(model), clientHtml = ui.clientHtml(st)
    if (path && path.innerHTML !== pathHtml) path.innerHTML = pathHtml
    if (list && list.innerHTML !== clientHtml) list.innerHTML = clientHtml
    text('plugin-online-title', ui.t('online'))
    text('plugin-console', ui.t('console'))
    text('plugin-pair', ui.t('pair'))
    text('plugin-about', ui.t('help'))
    if ($('plugin-pair')) $('plugin-pair').disabled = !model.authenticated
    if (model.phase === 'ready') text('plugin-status', ui.t('ready'))
    else if (!authError) text('plugin-status', ui.t(model.phase))
  }
  $('plugin-error').classList.add('hidden')
}

let stateLoadPromise = null
async function load() {
  if (stateLoadPromise) return stateLoadPromise
  stateLoadPromise = readState().finally(() => { stateLoadPromise = null })
  return stateLoadPromise
}
async function readState() {
  try {
    const res = await fetch(`${API}/state`, { headers: { 'x-dsh-remote-client': 'plugin' },
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    render(await res.json())
  } catch (e) {
    setup?.update(null)
    if (typeof window !== 'undefined' && window.DshRemoteUI) {
      const path = $('plugin-health-path')
      if (path) path.innerHTML = window.DshRemoteUI.pathHtml(window.DshRemoteUI.derive(null))
    }
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
  const action = latest?.mode === 'gateway' || latest?.gatewayRunning === true ? 'stop' : 'start'
  try {
    const res = await fetch(`${API}/gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-remote-client': 'plugin' },
      body: JSON.stringify({ action }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const out = await res.json()
    if (!out.ok) throw new Error(out.error || '网关操作未完成')
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
$('plugin-doctor')?.addEventListener('click', () => {
  const report=value=>{text('plugin-error',value);$('plugin-error').classList.remove('hidden')}
  if(typeof window.DshDoctorEntry?.open!=='function'){report('诊疗组件未能加载，请刷新页面后重试。');return}
  window.DshDoctorEntry.open({state:()=>latest,pluginMode:true,copy:async value=>{try{await navigator.clipboard.writeText(value);return true}catch{return false}},toast:report})
})
$('plugin-console').addEventListener('click', openConsole)
if (location.protocol === 'dsh-app:') $('plugin-about').addEventListener('click', openConsole)
$('plugin-toggle')?.addEventListener('click', toggleGateway)
$('plugin-copy')?.addEventListener('click', copyToken)
$('plugin-pair')?.addEventListener('click', () => {
  if ($('plugin-setup')) $('plugin-setup').hidden = false
  setup?.show(2)
})
$('plugin-primary').addEventListener('click', () => {
  if ($('plugin-primary').dataset.action === 'start') toggleGateway()
  else if ($('plugin-primary').dataset.action === 'setup' && setup?.show) {
    if ($('plugin-setup')) $('plugin-setup').hidden = false
    setup.show()
  }
  else openConsole()
})

load()
setInterval(load, 5000)
$('plugin-usage-refresh').addEventListener('click', loadUsage)
loadUsage()
setInterval(() => { if (document.visibilityState !== 'hidden' && Date.now() - usageLoadedAt >= 30000) void loadUsage() }, 30000)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - usageLoadedAt >= 30000) void loadUsage() })
