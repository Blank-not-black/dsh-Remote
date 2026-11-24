'use strict'

const { createHmac, randomUUID } = require('node:crypto')
const { currentGrant, live } = require('./registry.cjs')

function operationsSnapshot(state, at, { readHost, readQuota, readTraffic, readAlerts, alertChannel }) {
  const orders = { pending: 0, approved: 0, oldestPendingAt: null }
  for (const row of state.sponsorship.applications) {
    if (row.status === 'approved') orders.approved++
    if (row.status !== 'submitted') continue
    orders.pending++
    if (Number.isFinite(row.submittedAt)) orders.oldestPendingAt = Math.min(orders.oldestPendingAt ?? Infinity, row.submittedAt)
  }

  const hosts = { active: 0, bound: 0, online: 0, paired: 0, devices: 0, pairingUnknown: 0 }
  const quota = { usedBytes: 0, limitBytes: 0, remainingBytes: 0, nearLimit: 0, exhausted: 0, unavailable: 0 }
  for (const rawGrant of state.grants) {
    if (rawGrant.plan !== 'sponsor-basic') continue
    const grant = currentGrant(rawGrant, at)
    if (!live(grant, at)) continue
    hosts.active++
    if (grant.publicKey) {
      hosts.bound++
      const status = readHost?.(grant, at)
      if (status?.online) hosts.online++
      if (status?.pairedDevices == null) hosts.pairingUnknown++
      else if (status.pairedDevices > 0) {
        hosts.paired++
        hosts.devices += status.pairedDevices
      }
    }
    let usage
    try { usage = readQuota?.(grant) } catch {}
    if (!usage || usage.unavailable || [usage.usedBytes, usage.limitBytes, usage.remainingBytes].some(value => !Number.isSafeInteger(value) || value < 0)) {
      quota.unavailable++
      continue
    }
    quota.usedBytes += usage.usedBytes
    quota.limitBytes += usage.limitBytes
    quota.remainingBytes += usage.remainingBytes
    if (usage.exhausted) quota.exhausted++
    else if (usage.usedBytes >= usage.limitBytes * 0.8) quota.nearLimit++
  }
  const alerts = (readAlerts?.() || []).slice(0, 20).map(({ event, at, code, count, source, durationSeconds }) =>
    ({ event, at, code, count, source, durationSeconds }))
  return { at, orders, hosts, quota, traffic: readTraffic?.(), alerts, alertChannel }
}

const alertLabels = {
  SPONSOR_RELAY_ORDER_SUBMITTED: '新订单待审核',
  SPONSOR_RELAY_SUSTAINED_TRAFFIC: '持续高流量',
  SPONSOR_RELAY_REQUEST_SURGE: '请求量激增',
  SPONSOR_RELAY_POLICY_REJECTIONS: '传输策略拒绝激增',
  SPONSOR_RELAY_ROUTE_AUTH_FAILURES: '路由认证失败激增',
  SPONSOR_RELAY_FAILURE_SURGE: '中转故障激增',
  SPONSOR_RELAY_HOST_OFFLINE: '主机控制连接持续离线',
  SPONSOR_RELAY_QUOTA_ALERT: '流量额度告警'
}
const MAX_ATTEMPTS = 3

function createOperationsNotifier({ deliver, url, reportFailure, batchMs = 30_000, retryMs = 60_000 }) {
  const pending = new Map()
  let timer, batch, stopped = false
  function schedule(delay) {
    if (timer || stopped) return
    timer = setTimeout(flush, delay)
    timer.unref()
  }

  async function flush() {
    timer = null
    if (!batch) {
      const details = [...pending.values()].map(({ label, count }) => label + ' · ' + count + ' 条')
      pending.clear()
      batch = { attempts: 0, message: {
        subject: 'DSH Remote 云中转运营提醒',
        text: details.join('\n') + '\n\n运营监控\n' + url,
        idempotencyKey: 'relay-operations-' + randomUUID()
      } }
    }
    const current = batch
    try {
      await deliver(current.message)
      batch = null
    } catch {
      if (++current.attempts < MAX_ATTEMPTS) {
        schedule(retryMs)
        return
      }
      batch = null
      try { reportFailure?.({ event: 'SPONSOR_RELAY_OPERATOR_ALERT_FAILED' }) } catch {}
    }
    if (pending.size) schedule(batchMs)
  }

  return {
    notify({ event }) {
      if (stopped || !Object.hasOwn(alertLabels, event)) return
      const label = alertLabels[event]
      if (pending.has(event)) pending.get(event).count++
      else pending.set(event, { label, count: 1 })
      if (!batch) schedule(batchMs)
    },
    close() {
      stopped = true
      clearTimeout(timer)
      pending.clear()
    }
  }
}

function hermesAlertDelivery({ url, secret, fetcher = fetch, now = Date.now }) {
  let target
  try { target = new URL(url) } catch { return null }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash ||
    typeof secret !== 'string' || secret.length < 32 || !secret.trim()) return null

  return async ({ subject, text, idempotencyKey }) => {
    const body = JSON.stringify({ event_type: 'dsh_remote.relay_alert', subject, message: text })
    const timestamp = String(Math.floor(now() / 1000))
    const signature = createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex')
    const response = await fetcher(target, {
      method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', 'x-request-id': idempotencyKey,
        'x-webhook-timestamp': timestamp, 'x-webhook-signature-v2': signature }
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw Error('Hermes rejected alert delivery')
    }
    const result = await response.json()
    if (!['delivered', 'duplicate'].includes(result.status)) throw Error('Hermes did not confirm alert delivery')
  }
}

module.exports = { operationsSnapshot, createOperationsNotifier, hermesAlertDelivery }
