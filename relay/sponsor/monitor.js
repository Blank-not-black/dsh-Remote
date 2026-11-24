'use strict'

const $ = id => document.getElementById(id)
const put = (id, value) => { $(id).textContent = value }
const formatTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
})
const time = value => formatTime.format(value)
const labels = {
  SPONSOR_RELAY_SUSTAINED_TRAFFIC: '持续高流量',
  SPONSOR_RELAY_REQUEST_SURGE: '请求量激增',
  SPONSOR_RELAY_POLICY_REJECTIONS: '传输策略拒绝激增',
  SPONSOR_RELAY_ROUTE_AUTH_FAILURES: '路由认证失败激增',
  SPONSOR_RELAY_FAILURE_SURGE: '中转故障激增',
  SPONSOR_RELAY_HOST_OFFLINE: '主机控制连接持续离线',
  SPONSOR_RELAY_QUOTA_ALERT: '流量额度告警'
}
const reasons = { MONTHLY_QUOTA_EXCEEDED: '服务期额度已用完', QUOTA_STORAGE_UNAVAILABLE: '额度账本暂不可读' }
let token = '', request, lastTime, samples = []

function bytes(value) {
  for (const [unit, scale] of [['GB', 1e9], ['MB', 1e6], ['KB', 1e3]]) {
    if (value >= scale) return (value / scale).toFixed(1) + ' ' + unit
  }
  return value + ' B'
}

function drawTraffic() {
  const canvas = $('traffic-chart'), width = canvas.clientWidth, height = canvas.clientHeight
  if (!width || !height) return
  const scale = window.devicePixelRatio || 1
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(scale, scale)
  const max = Math.max(1, ...samples.map(sample => sample.bytes)), stride = width / 60
  context.fillStyle = getComputedStyle(canvas).getPropertyValue('--accent')
  samples.forEach((sample, index) => {
    const bar = sample.bytes / max * height
    context.fillRect((60 - samples.length + index) * stride, height - bar, Math.max(1, stride - 1), bar)
  })
}

function showSnapshot({ at, orders, hosts, quota, traffic, alerts, alertChannel }) {
  put('pending-orders', orders.pending)
  put('approved-orders', orders.approved)
  put('active-hosts', hosts.active)
  put('bound-hosts', hosts.bound)
  put('online-hosts', hosts.online)
  put('paired-hosts', hosts.paired)
  put('order-age', orders.oldestPendingAt == null ? '' : '最早待审提交于北京时间 ' + time(orders.oldestPendingAt))
  put('pairing-summary', hosts.devices + ' 台有效配对设备，' + hosts.pairingUnknown + ' 台已绑定主机的配对状态未知。')
  put('used-quota', bytes(quota.usedBytes) + ' / ' + bytes(quota.limitBytes))
  put('quota-alerts', quota.nearLimit + ' / ' + quota.exhausted)
  put('quota-status', '各主机当前服务期合计剩余 ' + bytes(quota.remainingBytes) + '。接近上限指已用达 80% 且未用满。' +
    (quota.unavailable ? quota.unavailable + ' 台主机的额度暂不可读。' : ''))
  samples = traffic?.samples || []
  const total = samples.reduce((sum, sample) => sum + sample.bytes, 0)
  const peak = Math.max(0, ...samples.map(sample => sample.bytes))
  put('traffic-total', samples.length ? '合计 ' + bytes(total) + '，峰值 ' + bytes(peak) + '/分钟，本分钟 ' + bytes(samples.at(-1).bytes) : '暂无流量采样。')
  put('alert-channel-status', { hermes: '已配置 Hermes 提醒。', email: '已配置邮件提醒。' }[alertChannel] || '尚未配置外部提醒。')
  $('operational-alerts').replaceChildren(...alerts.map(alert => {
    const item = document.createElement('li')
    const detail = alert.durationSeconds != null
      ? '持续 ' + Math.floor(alert.durationSeconds / 60) + ' 分钟，请求失败 ' + alert.count + ' 次'
      : reasons[alert.code] || alert.code
    item.textContent = [time(alert.at), labels[alert.event] || alert.event, detail].filter(Boolean).join(' · ')
    return item
  }))
  $('alerts-none').hidden = alerts.length > 0
  lastTime = at
  $('monitor-login').hidden = true
  $('monitor-content').hidden = false
  put('monitor-status', '更新于北京时间 ' + time(at))
  drawTraffic()
}

function logout(status = '') {
  request?.abort()
  request = undefined
  token = ''
  lastTime = undefined
  samples = []
  $('monitor-content').hidden = true
  $('monitor-login').hidden = false
  $('monitor-token').value = ''
  $('monitor-refresh').disabled = false
  $('monitor-login').querySelector('button').disabled = false
  $('monitor-content').querySelectorAll('dd, p').forEach(node => { if (node.id !== 'alerts-none') node.textContent = '' })
  $('operational-alerts').replaceChildren()
  $('traffic-chart').width = 0
  put('monitor-status', status)
}

async function refresh() {
  if (!token || request) return
  const current = request = new AbortController()
  const timer = setTimeout(() => current.abort(), 8000)
  const buttons = [$('monitor-refresh'), $('monitor-login').querySelector('button')]
  buttons.forEach(button => { button.disabled = true })
  try {
    const response = await fetch('/sponsor/api/operations', {
      headers: { authorization: 'Bearer ' + token }, credentials: 'omit', cache: 'no-store', signal: current.signal
    })
    if (request !== current) return
    if (response.status === 401) { logout('监控密钥无效，请重新输入。'); return }
    if (!response.ok) throw Error()
    const data = await response.json()
    if (request === current) showSnapshot(data)
  } catch {
    if (request === current) put('monitor-status', lastTime == null ? '暂时读不到监控数据，请重试。' : '刷新失败。当前显示北京时间 ' + time(lastTime) + ' 的数据。')
  } finally {
    clearTimeout(timer)
    if (request === current) {
      request = undefined
      buttons.forEach(button => { button.disabled = false })
    }
  }
}

$('monitor-login').addEventListener('submit', event => {
  event.preventDefault()
  if (request) return
  token = $('monitor-token').value.trim()
  $('monitor-token').value = ''
  void refresh()
})
$('monitor-logout').addEventListener('click', () => logout())
$('monitor-refresh').addEventListener('click', () => void refresh())
window.addEventListener('resize', drawTraffic)
window.addEventListener('pagehide', () => logout())
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
setInterval(() => { if (!document.hidden && !$('monitor-content').hidden) void refresh() }, 30000)
