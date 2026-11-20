'use strict'

const WINDOW_MS = 60_000
const COOLDOWN_MS = 15 * WINDOW_MS
const HIGH_BYTES = 16 * 1024 * 1024
const EVENT_LIMIT = 100
const FAILURE_SOURCES = new Map([
  ...['INVALID_RELAY_ROUTE_TOKEN', 'RELAY_ROUTING_OVERRIDE_NOT_ALLOWED', 'FILE_TRANSFER_NOT_ALLOWED',
    'RELAY_ROUTE_NOT_ALLOWED', 'RPC_ROUTE_MISMATCH', 'BODY_TOO_LARGE', 'INVALID_JSON',
    'E2EE_TRANSPORT_REQUIRED'].map(code => [code, 'client']),
  ...['HOST_NOT_ENROLLED', 'HOST_TRANSPORT_NOT_ADVERTISED', 'UPSTREAM_HTTP_4XX', 'UPSTREAM_HTTP_403',
    'UPSTREAM_HTTP_426', 'UPSTREAM_HTTP_5XX', 'UPSTREAM_HTTP_503', 'UPSTREAM_UPGRADE_REJECTED',
    'RELAY_RESPONSE_TOO_LARGE', 'RELAY_RESPONSE_TYPE_NOT_ALLOWED'].map(code => [code, 'host']),
  ...['RELAY_BUFFER_LIMIT', 'RELAY_TENANT_CONCURRENCY_LIMIT', 'QUOTA_STORAGE_UNAVAILABLE'].map(code => [code, 'relay']),
  ...['HOST_CONTROL_DISCONNECTED', 'HOST_WORK_QUEUE_FULL', 'HOST_WORK_TIMEOUT', 'HOST_CONNECTION_LOST',
    'HOST_RESPONSE_INTERRUPTED', 'RELAY_TUNNEL_INTERRUPTED', 'IMAGE_RESPONSE_REJECTED'].map(code => [code, 'unknown'])
])
const REASONS = new Map([
  ['INVALID_RELAY_ROUTE_TOKEN', 'route-auth'],
  ...['RELAY_ROUTING_OVERRIDE_NOT_ALLOWED', 'FILE_TRANSFER_NOT_ALLOWED', 'RELAY_ROUTE_NOT_ALLOWED',
    'RPC_ROUTE_MISMATCH', 'BODY_TOO_LARGE', 'RELAY_RESPONSE_TOO_LARGE', 'RELAY_RESPONSE_TYPE_NOT_ALLOWED'].map(code => [code, 'policy'])
])

// Keep one observation per authorization, shared across its connections.
// A warning is operational evidence of sustained traffic, not a policy decision.
function observeTraffic(runtime, bytes, { report, now = () => performance.now(), highBytes = HIGH_BYTES }) {
  const time = now()
  const window = Math.floor(time / WINDOW_MS)
  const sample = runtime.trafficObservation ||= { window, bytes: 0, consecutive: 0, nextAlertAt: 0 }
  if (sample.window !== window) {
    sample.consecutive = sample.window === window - 1 && sample.bytes >= highBytes ? sample.consecutive + 1 : 0
    sample.window = window
    sample.bytes = 0
  }
  sample.bytes += bytes
  if (sample.consecutive < 2 || sample.bytes < highBytes || sample.nextAlertAt > time) return
  sample.nextAlertAt = time + COOLDOWN_MS
  report({ event: 'SPONSOR_RELAY_SUSTAINED_TRAFFIC', grantId: runtime.id,
    consecutiveWindows: sample.consecutive + 1, windowSeconds: WINDOW_MS / 1000,
    thresholdBytes: highBytes, currentWindowBytes: sample.bytes })
}

function createTrafficMonitor({ report, now = () => performance.now(), wallNow = Date.now, highBytes, highRequests = 180, highRejects = 12, highFailures = 12 } = {}) {
  const recent = [], failures = new Map(), aggregate = {}
  const since = wallNow()
  function publish(event) {
    const entry = { ...event, at: wallNow() }
    recent.push(entry)
    if (recent.length > EVENT_LIMIT) recent.shift()
    try { report?.(entry) } catch {}
  }
  function count(runtime, type, threshold, event, code) {
    const at = now(), minute = Math.floor(at / WINDOW_MS), counters = runtime.alertCounters ||= new Map()
    const sample = counters.get(type) || { minute, count: 0, nextAlertAt: 0 }
    if (sample.minute !== minute) { sample.minute = minute; sample.count = 0 }
    counters.set(type, sample)
    if (++sample.count < threshold || sample.nextAlertAt > at) return
    sample.nextAlertAt = at + COOLDOWN_MS
    publish({ event, ...(runtime.id ? { grantId: runtime.id } : {}), windowSeconds: WINDOW_MS / 1000, count: sample.count,
      ...(code ? { code } : {}), ...(event === 'SPONSOR_RELAY_FAILURE_SURGE' ? { source: FAILURE_SOURCES.get(code) } : {}) })
  }
  function failure(code) {
    const source = FAILURE_SOURCES.get(code)
    if (!source) return
    const previous = failures.get(code)
    failures.set(code, { code, source, total: (previous?.total || 0) + 1, lastAt: wallNow() })
    count(aggregate, code, highFailures, 'SPONSOR_RELAY_FAILURE_SURGE', code)
  }
  return {
    list: () => recent.slice().reverse(),
    diagnostics: () => ({ since, failures: [...failures.values()].sort((left, right) => right.total - left.total) }),
    bytes: (runtime, bytes) => observeTraffic(runtime, bytes, { report: publish, now, highBytes }),
    request: runtime => count(runtime, 'requests', highRequests, 'SPONSOR_RELAY_REQUEST_SURGE'),
    failure,
    upstreamStatus(status, upgrade = false) {
      if ([403, 426, 503].includes(status)) failure('UPSTREAM_HTTP_' + status)
      else if (status >= 500) failure('UPSTREAM_HTTP_5XX')
      else if (status >= 400) failure('UPSTREAM_HTTP_4XX')
      else if (upgrade) failure('UPSTREAM_UPGRADE_REJECTED')
    },
    reject(runtime, code, diagnosticCode = code) {
      failure(diagnosticCode)
      if (!runtime) return
      const type = code === 'INVALID_RELAY_ROUTE_TOKEN' && diagnosticCode !== code ? null : REASONS.get(code)
      if (type) count(runtime, type, highRejects, type === 'policy' ? 'SPONSOR_RELAY_POLICY_REJECTIONS' : 'SPONSOR_RELAY_ROUTE_AUTH_FAILURES', code)
      if (code === 'QUOTA_STORAGE_UNAVAILABLE' || code === 'MONTHLY_QUOTA_EXCEEDED')
        count(runtime, code, 1, 'SPONSOR_RELAY_QUOTA_ALERT', code)
    }
  }
}

module.exports = { createTrafficMonitor }
