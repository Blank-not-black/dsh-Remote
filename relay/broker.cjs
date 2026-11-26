'use strict'
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { FileRate } = require('./file-rate.cjs')
const { Registry, fault, live, isEarlyTest, signingText } = require('./registry.cjs')
const { line, send, link } = require('./wire.cjs')
const { DailyQuota, MonthlyQuota, meteredSocket } = require('./quota.cjs')
const { basicPolicy, imageResponse, basicBody, relayFileRequest } = require('./basic-policy.cjs')
const { basicHttp, rejectOverrides, validateOperation, validateResponse, ByteLimit } = require('./basic-http.cjs')
const { createTrafficMonitor } = require('./traffic-alert.cjs')
const { createOperationsNotifier, hermesAlertDelivery } = require('./operations.cjs')
const { createSponsorPortal, resendMailer } = require('./sponsorship.cjs')
const { headersOf } = require('./http-headers.cjs')

const SPONSOR_BUFFER_LIMIT = 96 * 1024 * 1024
const FILE_TRANSFER_LIMIT = 5
const IDLE_POOL_MS = 150000
const IDLE_POOL_JITTER_MS = 30000
const MAX_PENDING_TUNNELS = 256
const CHALLENGE_TIMEOUT_MS = 3000
const TENANT_CHANNEL_LIMIT = 32
const UPGRADE_RATE = 100
const UPGRADE_BURST = 300
const TENANT_UPGRADE_RATE = 10
const TENANT_UPGRADE_BURST = 20
// A token bucket keeps upgrade floods from eating the shared connection budget.
function rateBucket(rate, burst, now = Date.now()) { return { rate, burst, tokens: burst, at: now } }
function takeRateToken(bucket, now = Date.now()) {
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + (now - bucket.at) / 1000 * bucket.rate)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function reply(res, status, code) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
}
function observedFault(code, diagnosticCode, status = 503) {
  return Object.assign(fault(code, status), { diagnosticCode })
}
async function body(req) {
  const parts = []; let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 8192) throw fault('BODY_TOO_LARGE', 413)
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw fault('INVALID_JSON') }
}

function createBroker({ file, cert, key, frontTls = false, sweepMs = 500, heartbeatMs = 20000, fileBytesPerSecond = 102400,
  fileTransferLimit = FILE_TRANSFER_LIMIT, idlePoolMs = IDLE_POOL_MS, idlePoolJitterMs = IDLE_POOL_JITTER_MS, channelLimit = TENANT_CHANNEL_LIMIT,
  tenantUpgradeRate = TENANT_UPGRADE_RATE, tenantUpgradeBurst = TENANT_UPGRADE_BURST,
  upgradeRate = UPGRADE_RATE, upgradeBurst = UPGRADE_BURST, challengeTimeoutMs = CHALLENGE_TIMEOUT_MS,
  maxPendingTunnels = MAX_PENDING_TUNNELS, quotaOptions, sponsor, trafficAlerts }) {
  const registry = new Registry(file)
  const config = registry.read()
  const quota = new DailyQuota(path.join(path.dirname(path.resolve(file)), 'daily-quota.json'), quotaOptions)
  const monthlyQuota = new MonthlyQuota(path.join(path.dirname(path.resolve(file)), 'monthly-quota.json'), registry, quotaOptions)
  const recipient = sponsor?.alertTo
  const emailDelivery = typeof sponsor?.sendMail === 'function' && typeof recipient === 'string' && recipient.length <= 254
    && /^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(recipient)
    ? mail => sponsor.sendMail({ ...mail, to: recipient }) : null
  const hermesDelivery = sponsor?.hermes && hermesAlertDelivery(sponsor.hermes)
  const deliver = hermesDelivery || emailDelivery
  const alertChannel = hermesDelivery ? 'hermes' : emailDelivery ? 'email' : null
  const notifier = deliver ? createOperationsNotifier({ deliver, url: new URL('/sponsor/monitor', config.origin).href,
    reportFailure: entry => trafficAlerts?.report?.({ ...entry, channel: alertChannel }) }) : null
  if (sponsor?.hermes && !hermesDelivery || recipient && !emailDelivery) {
    trafficAlerts?.report?.({ event: 'SPONSOR_RELAY_OPERATOR_ALERT_UNCONFIGURED' })
  }
  const monitor = createTrafficMonitor({ ...trafficAlerts, report(entry) {
    notifier?.notify(entry)
    trafficAlerts?.report?.(entry)
  } })
  const portal = sponsor ? createSponsorPortal({
    file, publicOrigin: config.origin, ...sponsor,
    alertChannel,
    onSubmitted: () => notifier?.notify({ event: 'SPONSOR_RELAY_ORDER_SUBMITTED' }),
    readAlerts: monitor.list, readDiagnostics: monitor.diagnostics, readTraffic: monitor.traffic,
    readQuota: grant => monthlyQuota.view(grant.id, grant),
    readHost(grant, at) {
      const r = runtimes.get(grant.id)
      const online = !!r?.control && !r.control.destroyed && r.fingerprint === grant.publicKey && r.periodStartsAt === grant.periodStartsAt
      const devices = online ? r.e2ee?.devices : null
      return { online, pairedDevices: devices ? devices.filter(device => device.expiresAt > at).length : null }
    },
    readUsage: id => {
      const control = runtimes.get(id)?.control
      return { ...ledger(id).view(id), online: !!control && !control.destroyed }
    }
  }) : null
  const ledger = id => registry.get(id)?.plan === 'sponsor-basic' ? monthlyQuota : quota
  const quotaError = id => registry.get(id)?.plan === 'sponsor-basic' ? 'MONTHLY_QUOTA_EXCEEDED' : 'DAILY_QUOTA_EXCEEDED'
  const runtimes = new Map()
  const allSockets = new Set()
  const enrollmentRates = new Map()
  let closing = false
  let fileTransfers = 0
  let sponsorRequests = 0
  let sponsorBufferedBytes = 0
  let pendingTunnels = 0
  const tunnelRate = rateBucket(upgradeRate, upgradeBurst)
  function reserveSponsorBuffer(bytes) {
    if (sponsorBufferedBytes + bytes > SPONSOR_BUFFER_LIMIT) throw observedFault('HOST_BUSY', 'RELAY_BUFFER_LIMIT')
    sponsorBufferedBytes += bytes
    return () => { sponsorBufferedBytes -= bytes }
  }
  function runtime(id) {
    if (!runtimes.has(id)) runtimes.set(id, { id, control: null, session: null, pool: [], sockets: new Set(), traffic: new Set(), waiting: [], active: 0, ws: 0, lastPongAt: 0, upgrades: rateBucket(tenantUpgradeRate, tenantUpgradeBurst), usage: { upstreamBytes: 0, downstreamBytes: 0, requests: 0 } })
    return runtimes.get(id)
  }
  function track(socket, r) {
    allSockets.add(socket); r?.sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => { allSockets.delete(socket); r?.sockets.delete(socket) })
  }
  function disconnect(r) {
    for (const waiter of r.waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(fault('AUTHORIZATION_INACTIVE', 403)) }
    for (const socket of [...r.sockets]) socket.destroy()
    r.control = null; r.session = null; r.pool = []; r.e2ee = null; r.lastPongAt = 0
  }
  function valid(r) {
    const grant = registry.get(r.id)
    return live(grant) && grant.publicKey && r.fingerprint === grant.publicKey
      && r.periodStartsAt === grant.periodStartsAt
      && (!r.e2ee || r.e2ee.policy === (grant.plan === 'sponsor-basic' ? 'sponsor-basic' : 'standard'))
  }
  function usage(r) { try { return ledger(r.id).view(r.id) } catch { return { unavailable: true } } }
  function controlPlan(grant) {
    if (live(grant) && grant.plan === 'sponsor-basic') return { authorization: { expiresAt: grant.serviceExpiresAt || grant.expiresAt } }
    return live(grant) && isEarlyTest(grant) ? { authorization: { displayPlan: 'early-test', expiresAt: grant.expiresAt } } : {}
  }
  function quotaChanged(r) {
    if (r.control && !r.control.destroyed) send(r.control, { type: 'usage', usage: usage(r), ...controlPlan(registry.get(r.id)) })
  }
  function closeTraffic(r) {
    quotaChanged(r)
    for (const socket of [...r.traffic]) socket.destroy()
    for (const waiter of r.waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(fault(quotaError(r.id), 429)) }
  }
  function canTransfer(view, fallback) { return !view.unavailable && (!view.exhausted || fallback && view.fallbackRemainingBytes > 0) }
  function closeExhaustedTraffic(r) {
    const view = usage(r)
    if (!canTransfer(view, true)) return closeTraffic(r)
    if (!view.exhausted) return
    quotaChanged(r)
    for (const socket of r.traffic) if (!socket.relayFallback) socket.destroy()
  }
  function checkQuota(r, fallback) {
    if (canTransfer(ledger(r.id).view(r.id), fallback)) return
    closeExhaustedTraffic(r)
    throw fault(quotaError(r.id), 429)
  }
  function charge(r, bytes, basic, fallback = false) {
    try {
      const grant = registry.get(r.id)
      if (!live(grant) || r.periodStartsAt !== grant.periodStartsAt) throw fault('AUTHORIZATION_INACTIVE', 403)
      const allowed = basic ? monthlyQuota.consume(r.id, bytes, fallback, grant) : quota.consume(r.id, bytes)
      if (basic && allowed) monitor.bytes(r, bytes)
      if (basic && !allowed) monitor.reject(r, 'MONTHLY_QUOTA_EXCEEDED')
      return allowed
    } catch (error) {
      if (basic) monitor.reject(r, error.code)
      throw error
    }
  }
  function give(r, socket) {
    if (socket.destroyed) return
    if (!valid(r) || !r.control || r.control.destroyed) return socket.destroy()
    const waiter = r.waiting.shift()
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(socket) }
    else if (r.pool.length < 8) r.pool.push(socket)
    else socket.destroy()
  }
  async function take(r, fallback = false, channel = 'http') {
    if (!valid(r)) {
      const grant = registry.get(r.id)
      if ((!r.control || r.control.destroyed) && live(grant) && grant.publicKey) {
        throw observedFault('AUTHORIZATION_INACTIVE', 'HOST_CONTROL_DISCONNECTED', 403)
      }
      throw fault('AUTHORIZATION_INACTIVE', 403)
    }
    checkQuota(r, fallback)
    if (!r.control || r.control.destroyed) throw observedFault('HOST_OFFLINE', 'HOST_CONTROL_DISCONNECTED')
    if (channel === 'ws' ? r.ws >= channelLimit : r.active >= channelLimit) throw observedFault('HOST_BUSY', 'RELAY_TENANT_CONCURRENCY_LIMIT')
    while (r.pool.length) { const socket = r.pool.shift(); if (!socket.destroyed) return socket }
    if (r.waiting.length >= 8) throw observedFault('HOST_BUSY', 'HOST_WORK_QUEUE_FULL')
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null }
      item.timer = setTimeout(() => { r.waiting = r.waiting.filter(w => w !== item); reject(observedFault('HOST_BUSY', 'HOST_WORK_TIMEOUT')) }, 3000)
      r.waiting.push(item)
    })
  }
  const acceptTunnel = async socket => {
    if (pendingTunnels >= maxPendingTunnels) return socket.destroy()
    pendingTunnels++
    track(socket); socket.setNoDelay(true); socket.setKeepAlive(true, 30000)
    try {
      const nonce = crypto.randomBytes(32).toString('base64url')
      send(socket, { type: 'challenge', nonce })
      const auth = await line(socket, challengeTimeoutMs)
      const grant = registry.get(auth.grantId)
      if (!grant?.publicKey || !['control', 'work'].includes(auth.role) || !/^[A-Za-z0-9_-]{86}$/.test(auth.signature || '')) throw fault('INVALID_AUTHORIZATION', 403)
      const r = runtime(grant.id)
      if (auth.e2ee && (auth.role !== 'control' || !['policy,routeTokenHash','allowPlain,policy,routeTokenHash','devices,policy,routeTokenHash','allowPlain,devices,policy,routeTokenHash'].includes(Object.keys(auth.e2ee).sort().join(','))
          || auth.e2ee.devices !== undefined && (!Array.isArray(auth.e2ee.devices) || auth.e2ee.devices.length > 32
            || auth.e2ee.devices.some(d => !d || Object.keys(d).sort().join(',') !== 'expiresAt,id,routeTokenHash' || !/^[a-f0-9]{32}$/.test(d.id || '') || !/^[a-f0-9]{64}$/.test(d.routeTokenHash || '') || !Number.isFinite(d.expiresAt) || d.expiresAt > (grant.serviceExpiresAt || grant.expiresAt))
            || new Set(auth.e2ee.devices.map(d => d.id)).size !== auth.e2ee.devices.length)
          || auth.e2ee.allowPlain !== undefined && typeof auth.e2ee.allowPlain !== 'boolean'
          || !/^[a-f0-9]{64}$/.test(auth.e2ee.routeTokenHash || '') || auth.e2ee.policy !== (grant.plan === 'sponsor-basic' ? 'sponsor-basic' : 'standard'))) throw fault('INVALID_AUTHORIZATION', 403)
      if (!crypto.verify(null, signingText(nonce, grant.id, auth.role, auth.session || '', auth.e2ee), grant.publicKey, Buffer.from(auth.signature, 'base64url'))) throw fault('INVALID_AUTHORIZATION', 403)
      if (!live(grant)) throw fault('AUTHORIZATION_INACTIVE', 403)
      if (auth.role === 'control') {
        if (auth.session) throw fault('INVALID_AUTHORIZATION', 403)
        // A duplicate connection never replaces a live host. A control that has missed two
        // heartbeats may be half-open after a network switch, so a fresh signed control takes
        // over instead of leaving the host unreachable for the whole pong timeout.
        if (r.control && !r.control.destroyed) {
          if (!r.lastPongAt || Date.now() - r.lastPongAt <= heartbeatMs * 2) throw fault('HOST_ALREADY_ONLINE', 409)
          const stale = r.control
          r.control = null; r.session = null; r.lastPongAt = 0
          stale.destroy()
        }
        r.control = socket; r.session = crypto.randomBytes(24).toString('base64url'); r.fingerprint = grant.publicKey
        r.periodStartsAt = grant.periodStartsAt
        r.e2ee = auth.e2ee || null
        r.lastPongAt = Date.now()
        track(socket, r)
        const session = r.session
        send(socket, { type: 'accepted', session, usage: usage(r), ...controlPlan(grant), ...(r.e2ee ? { e2ee: true } : {}) })
        socket.once('close', () => { if (r.session === session) disconnect(r) })
        const heartbeat = setInterval(() => {
          if (closing || socket.destroyed) return
          try { send(socket, { type: 'ping', usage: usage(r), ...controlPlan(registry.get(r.id)) }) }
          catch { socket.destroy() }
        }, heartbeatMs)
        socket.once('close', () => clearInterval(heartbeat))
        while (!socket.destroyed) {
          const message = await line(socket, heartbeatMs * 3)
          if (message.type !== 'pong') throw fault('INVALID_CONTROL_MESSAGE')
          r.lastPongAt = Date.now()
        }
      } else {
        if (!r.control || !auth.session || auth.session !== r.session || !valid(r)) throw fault('STALE_HOST_SESSION', 403)
        track(socket, r)
        const idleMs = idlePoolMs + Math.floor(Math.random() * idlePoolJitterMs)
        send(socket, { type: 'parked', idleMs })
        give(r, socket)
        // Retire idle parked channels before stale NAT state accumulates, and tell the host so
        // it refills at once instead of treating the close as a failed channel.
        const expiry = setTimeout(() => {
          if (!r.pool.includes(socket)) return
          try { socket.end(JSON.stringify({ type: 'retire' }) + '\n') } catch { socket.destroy() }
          const forced = setTimeout(() => socket.destroy(), 1000); forced.unref()
          socket.once('close', () => clearTimeout(forced))
        }, idleMs)
        socket.once('close', () => { clearTimeout(expiry); r.pool = r.pool.filter(s => s !== socket) })
      }
    } catch (error) {
      if (error.code === 'AUTHORIZATION_INACTIVE') {
        send(socket, { type: 'rejected', code: 'AUTHORIZATION_INACTIVE' }); socket.end()
        const cleanup = setTimeout(() => socket.destroy(), 1000); cleanup.unref()
      } else if (error.code === 'HOST_ALREADY_ONLINE') {
        // Tell the host to retry quickly instead of inheriting the long reconnect backoff.
        send(socket, { type: 'rejected', code: 'HOST_ALREADY_ONLINE', retryAfterMs: 2000 }); socket.end()
        const cleanup = setTimeout(() => socket.destroy(), 1000); cleanup.unref()
      } else socket.destroy()
    } finally { pendingTunnels-- }
  }
  const tunnel = tls.createServer({ cert, key, minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, socket => {
    if (!takeRateToken(tunnelRate)) return socket.destroy()
    acceptTunnel(socket)
  })
  tunnel.on('tlsClientError', () => {})
  tunnel.maxConnections = sponsor ? 1024 : 256

  function tenant(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
    const grant = registry.byDomain(host)
    if (!grant) throw fault('UNKNOWN_HOST', 404)
    if (!live(grant)) throw fault('AUTHORIZATION_INACTIVE', 403)
    if (!grant.publicKey) {
      if (grant.plan === 'sponsor-basic') monitor.failure('HOST_NOT_ENROLLED')
      throw fault('HOST_NOT_ENROLLED', 503)
    }
    const r = runtime(grant.id)
    if (req.socket.relayTenant && req.socket.relayTenant !== r.id) throw fault('HOST_MISMATCH', 421)
    if (!req.socket.relayTenant) { req.socket.relayTenant = r.id; track(req.socket, r) }
    return r
  }
  function upstream(req, work, upgrade, basic, fallback = false) {
    send(work, { type: 'start' })
    const r = runtime(req.socket.relayTenant)
    const metered = meteredSocket(work, bytes => charge(r, bytes, basic, fallback), () => closeExhaustedTraffic(r))
    metered.relayFallback = fallback
    r.traffic.add(metered); metered.once('close', () => r.traffic.delete(metered))
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => metered
    const headers = headersOf(req.headers, upgrade)
    // A local gateway only sees transport forwarding metadata, never a cloud credential.
    delete headers['proxy-authorization']
    const request = http.request({ method: req.method, path: req.url, headers, agent })
    request.setTimeout(120000, () => request.destroy())
    return request
  }
  async function proxy(req, res) {
    let work, request, r, basic, counted = false, fileSlot = false, upload, download, sponsorSlot = false
    let releaseRequestBuffer, releaseImageBuffer
    const releaseRequestBody = () => {
      releaseRequestBuffer?.()
      releaseRequestBuffer = null
    }
    const release = () => {
      if (counted) { counted = false; r.active-- }
      if (fileSlot) { fileSlot = false; fileTransfers-- }
      if (sponsorSlot) { sponsorSlot = false; sponsorRequests-- }
      releaseRequestBody()
      releaseImageBuffer?.()
      releaseImageBuffer = null
      upload?.destroy(); download?.destroy()
    }
    try {
      r = tenant(req)
      basic = registry.get(r.id)?.plan === 'sponsor-basic'
      if (r.e2ee) throw fault('E2EE_TRANSPORT_REQUIRED', 426)
      const packedFile = basic && relayFileRequest(req) && usage(r).fileTransfer === true
      if (basic) { monitor.request(r); if (packedFile) rejectOverrides(req) }
      const policy = basic && !packedFile ? basicHttp(req) : null
      const mode = policy?.image
      let buffered = null
      if (policy && (mode || req.method === 'POST' && policy.route.startsWith('/api/'))) {
        if (sponsorRequests >= 64) throw observedFault('HOST_BUSY', 'RELAY_BUFFER_LIMIT')
        const bytes = req.headers['transfer-encoding'] ? policy.requestBytes : Number(req.headers['content-length'] || 0)
        releaseRequestBuffer = reserveSponsorBuffer(bytes)
        sponsorRequests++; sponsorSlot = true
        buffered = await basicBody(req)
        validateOperation(policy.route, buffered)
      }
      const pathname = new URL(req.url, 'http://relay.invalid').pathname
      if (packedFile || !mode && (pathname === '/fs' || pathname.startsWith('/fs/'))) {
        if (fileTransfers >= fileTransferLimit) throw fault('FILE_TRANSFER_BUSY', 429)
        fileTransfers++; fileSlot = true
      }
      work = await take(r, basic && !packedFile)
      if (req.destroyed && !req.complete || res.destroyed) { work.destroy(); release(); return }
      if (r.active >= channelLimit) throw observedFault('HOST_BUSY', 'RELAY_TENANT_CONCURRENCY_LIMIT')
      r.active++; counted = true; r.usage.requests++
      res.once('close', release); res.once('finish', release)
      request = upstream(req, work, false, basic, basic && !packedFile)
      req.on('data', chunk => { r.usage.upstreamBytes += chunk.length })
      req.once('aborted', () => request.destroy())
      res.once('close', () => { if (!res.writableFinished) request.destroy() })
      request.on('error', error => {
        release(); work.destroy()
        if (req.aborted || res.destroyed || res.writableEnded) return
        if (basic && !error.status) monitor.failure('HOST_CONNECTION_LOST')
        reply(res, error.status || 503, error.code?.endsWith('QUOTA_EXCEEDED') ? quotaError(r.id) : 'HOST_CONNECTION_LOST')
      })
      request.on('response', response => {
        if (res.destroyed) { response.destroy(); return }
        if (basic) monitor.upstreamStatus(response.statusCode)
        if (mode) {
          const bytes = Math.min(policy.responseBytes, Number(response.headers['content-length'] ?? policy.responseBytes))
          try { releaseImageBuffer = reserveSponsorBuffer(bytes) } catch (error) {
            monitor.reject(r, error.code, error.diagnosticCode)
            reply(res, error.status, error.code); response.destroy(); return
          }
          res.once('finish', () => { if (res.statusCode === 403 && response.statusCode !== 403) monitor.reject(r, 'FILE_TRANSFER_NOT_ALLOWED', 'IMAGE_RESPONSE_REJECTED') })
          void imageResponse(response, res, mode); return
        }
        if (policy) {
          try { validateResponse(req, response, policy) } catch (error) {
            monitor.reject(r, error.code)
            reply(res, error.status, error.code); response.destroy(); return
          }
        }
        res.writeHead(response.statusCode, headersOf(response.headers))
        response.on('data', chunk => { r.usage.downstreamBytes += chunk.length })
        response.on('error', error => {
          if (basic && !res.destroyed && !error.status) monitor.failure('HOST_RESPONSE_INTERRUPTED')
          res.destroy()
        })
        if (fileSlot) {
          download = new FileRate(fileBytesPerSecond)
          download.on('error', () => res.destroy())
        } else if (policy) {
          download = new ByteLimit(policy.responseBytes, 'RELAY_RESPONSE_TOO_LARGE', 502)
          download.on('error', error => { monitor.reject(r, error.code); response.destroy(); res.destroy() })
        }
        if (download) response.pipe(download).pipe(res)
        else response.pipe(res)
      })
      if (fileSlot) {
        upload = new FileRate(fileBytesPerSecond)
        upload.on('error', () => request.destroy())
        req.pipe(upload).pipe(request)
      } else if (buffered) {
        r.usage.upstreamBytes += buffered.length
        request.once('finish', releaseRequestBody)
        request.end(buffered)
        buffered = null
      }
      else if (policy?.requestBytes) {
        upload = new ByteLimit(policy.requestBytes, 'BODY_TOO_LARGE', 413)
        upload.on('error', error => { monitor.reject(r, error.code); reply(res, error.status, error.code); request.destroy() })
        req.pipe(upload).pipe(request)
      } else if (policy) request.end()
      else req.pipe(request)
      work.resume()
    } catch (error) {
      work?.destroy(); release()
      if (basic && !req.aborted && !res.destroyed) monitor.reject(r, error.code, error.diagnosticCode)
      if (error.code?.endsWith('QUOTA_EXCEEDED') && r) {
        const view = ledger(r.id).view(r.id)
        res.writeHead(429, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(Math.max(1, Math.ceil((view.resetsAt-Date.now())/1000))) })
        return res.end(JSON.stringify({ error: error.code, daily: view, ...(view.period === 'month' ? { monthly: view } : {}) }))
      }
      reply(res, error.status || 503, error.code || 'RELAY_UNAVAILABLE')
    }
  }
  const frontHandler = async (req, res) => {
    try {
      const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
      if (host !== new URL(config.origin).hostname) return proxy(req, res)
      if (portal && await portal.handle(req, res)) return
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true,"service":"dsh-relay-pilot"}')
      }
      if (req.method !== 'POST' || req.url !== '/relay/v1/enroll') return reply(res, 404, 'NOT_FOUND')
      const ip = req.socket.remoteAddress
      const now = Date.now()
      let rate = enrollmentRates.get(ip)
      if (!rate || rate.until < now) { rate = { until: now + 60000, count: 0 }; enrollmentRates.set(ip, rate) }
      if (++rate.count > 20) return reply(res, 429, 'TRY_LATER')
      const input = await body(req)
      if (Object.keys(input).some(k => !['code', 'publicKey'].includes(k))) throw fault('INVALID_ENROLLMENT')
      const result = registry.enroll(input.code, input.publicKey)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result))
    } catch (error) { reply(res, error.status || 503, error.code || 'RELAY_UNAVAILABLE') }
  }
  const front = frontTls ? https.createServer({ cert, key, minVersion: 'TLSv1.2' }, frontHandler) : http.createServer(frontHandler)
  front.headersTimeout = 15000; front.requestTimeout = 120000
  front.maxConnections = sponsor ? 1024 : 256
  front.on('connection', socket => track(socket))
  front.on('upgrade', async (req, socket, head) => {
    const controlHost = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '') === new URL(config.origin).hostname
    if (controlHost && req.method === 'GET' && req.url === '/relay/v1/tunnel' && String(req.headers.upgrade).toLowerCase() === 'dsh-relay-v1') {
      if (!takeRateToken(tunnelRate)) return socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-relay-v1\r\n\r\n')
      if (head.length) socket.unshift(head)
      acceptTunnel(socket)
      return
    }
    let work, r, request, basic, counted = false, failed = false
    const fail = error => {
      if (failed) return
      failed = true
      if (basic && !socket.destroyed) monitor.reject(r, error?.code, error?.diagnosticCode)
      work?.destroy()
      if (socket.destroyed) return
      const status = error?.status || 503
      const body = JSON.stringify({ error: error?.code || 'RELAY_UNAVAILABLE' })
      const retry = status === 429 || status === 503 ? 'Retry-After: 1\r\n' : ''
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Service Unavailable'}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
        + `${retry}Connection: close\r\n\r\n${body}`)
    }
    try {
      const encrypted = req.url === '/relay/v1/e2ee' && String(req.headers.upgrade).toLowerCase() === 'dsh-e2ee-v1'
      const plain = req.url === '/relay/v1/plain' && String(req.headers.upgrade).toLowerCase() === 'dsh-relay-plain-v1'
      if (req.method === 'GET' && (encrypted || plain)) {
        socket.pause()
        r = tenant(req)
        basic = registry.get(r.id)?.plan === 'sponsor-basic'
        if (basic) rejectOverrides(req)
        const token = /^DSHRelay ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''))?.[1]
        const hash = token && crypto.createHash('sha256').update(token).digest()
        const routeValid = () => r.e2ee && hash && (r.e2ee.devices === undefined
          ? crypto.timingSafeEqual(hash, Buffer.from(r.e2ee.routeTokenHash, 'hex'))
          : r.e2ee.devices.some(d => d.expiresAt > Date.now() && crypto.timingSafeEqual(hash, Buffer.from(d.routeTokenHash, 'hex'))))
        if (!routeValid()) {
          // A host that is merely offline must not look like a terminal route-token failure.
          if (!r.control || r.control.destroyed) throw observedFault('HOST_OFFLINE', 'HOST_CONTROL_DISCONNECTED')
          if (!r.e2ee) throw observedFault('INVALID_RELAY_ROUTE_TOKEN', 'HOST_TRANSPORT_NOT_ADVERTISED', 403)
          throw fault('INVALID_RELAY_ROUTE_TOKEN', 403)
        }
        if (!takeRateToken(r.upgrades)) throw observedFault('HOST_BUSY', 'RELAY_UPGRADE_RATE_LIMIT', 429)
        if (basic) monitor.request(r)
        if (plain && !r.e2ee.allowPlain) throw fault('PLAIN_RELAY_NOT_SUPPORTED', 403)
        const session = r.session
        work = await take(r, basic, 'ws')
        if (socket.destroyed) { work.destroy(); return }
        if (!valid(r) || r.session !== session || !routeValid()) throw fault('AUTHORIZATION_INACTIVE', 403)
        if (r.ws >= channelLimit) throw observedFault('HOST_BUSY', 'RELAY_TENANT_CONCURRENCY_LIMIT')
        r.ws++; counted = true; r.usage.requests++
        work.once('close', () => { if (counted) { counted = false; r.ws-- } })
        send(work, { type: 'start', transport: encrypted ? 'e2ee-v1' : 'relay-plain-v1' })
        const metered = meteredSocket(work, (bytes, direction) => {
          r.usage[direction === 'upstream' ? 'upstreamBytes' : 'downstreamBytes'] += bytes
          return charge(r, bytes, basic, basic)
        }, () => closeExhaustedTraffic(r))
        r.traffic.add(metered); metered.once('close', () => r.traffic.delete(metered))
        if (basic) metered.once('error', error => { if (!socket.destroyed && !error.status) monitor.failure('RELAY_TUNNEL_INTERRUPTED') })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ' + (encrypted ? 'dsh-e2ee-v1' : 'dsh-relay-plain-v1') + '\r\n\r\n')
        if (head.length) socket.unshift(head)
        link(socket, metered)
        return
      }
      if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') throw fault('INVALID_UPGRADE')
      r = tenant(req)
      basic = registry.get(r.id)?.plan === 'sponsor-basic'
      if (r.e2ee) throw fault('E2EE_TRANSPORT_REQUIRED', 426)
      if (basic) { monitor.request(r); rejectOverrides(req) }
      if (!takeRateToken(r.upgrades)) throw observedFault('HOST_BUSY', 'RELAY_UPGRADE_RATE_LIMIT', 429)
      if (basic && (basicPolicy(req) || !/^\/api\/events\.(?:mux|host)(?:\?|$)/.test(req.url))) throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
      work = await take(r, basic, 'ws')
      if (socket.destroyed) { work.destroy(); return }
      if (r.ws >= channelLimit) throw observedFault('HOST_BUSY', 'RELAY_TENANT_CONCURRENCY_LIMIT')
      r.ws++; counted = true
      work.once('close', () => { if (counted) { counted = false; r.ws-- } })
      request = upstream(req, work, true, basic, basic)
      request.on('error', error => {
        if (basic && !failed && !socket.destroyed && !error.status) monitor.failure('HOST_CONNECTION_LOST')
        fail(error)
      })
      socket.once('close', () => request.destroy())
      request.on('response', response => {
        if (socket.destroyed) { response.destroy(); return }
        if (basic) {
          monitor.upstreamStatus(response.statusCode, true)
          // A failed WebSocket handshake has no use for an unbounded payload.
          response.destroy()
          fail(fault('RELAY_UPGRADE_REJECTED', response.statusCode >= 400 ? response.statusCode : 502))
          return
        }
        const headers = headersOf(response.headers)
        socket.write(`HTTP/1.1 ${response.statusCode} ${http.STATUS_CODES[response.statusCode] || 'Response'}\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
        response.on('error', () => socket.destroy())
        response.pipe(socket)
      })
      request.on('upgrade', (response, remote, remoteHead) => {
        if (socket.destroyed) return remote.destroy()
        const headers = headersOf(response.headers, true)
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
        if (head.length) remote.write(head)
        if (remoteHead.length) socket.write(remoteHead)
        socket.on('data', chunk => { r.usage.upstreamBytes += chunk.length })
        remote.on('data', chunk => { r.usage.downstreamBytes += chunk.length })
        link(socket, remote)
      })
      request.end(); work.resume()
    } catch (error) { fail(error) }
  })
  const sweep = setInterval(() => {
    for (const [ip, rate] of enrollmentRates) if (rate.until < Date.now()) enrollmentRates.delete(ip)
    for (const r of runtimes.values()) {
      try {
        if (r.control && !valid(r)) disconnect(r)
        if (r.traffic.size) {
          const view = usage(r)
          if (view.unavailable && registry.get(r.id)?.plan === 'sponsor-basic') monitor.reject(r, 'QUOTA_STORAGE_UNAVAILABLE')
          if (view.exhausted || view.unavailable) closeExhaustedTraffic(r)
        }
      } catch { disconnect(r) }
    }
  }, sweepMs)
  sweep.unref()
  return { registry, front, tunnel,
    quota,
    monthlyQuota, portal,
    stats: () => [...runtimes.values()].map(r => ({ grantId: r.id, online: Boolean(r.control && !r.control.destroyed), active: r.active, ws: r.ws, pooled: r.pool.filter(s => !s.destroyed).length, ...r.usage, daily: usage(r) })),
    async close() {
      if (closing) return
      closing = true; clearInterval(sweep)
      notifier?.close()
      for (const r of runtimes.values()) disconnect(r)
      for (const socket of allSockets) socket.destroy()
      await Promise.all([front, tunnel].map(server => new Promise(resolve => server.listening ? server.close(resolve) : resolve())))
      quota.checkpoint()
      monthlyQuota.checkpoint()
    },
  }
}

if (require.main === module) {
  const args = require('./options.cjs')(process.argv.slice(2))
  if (Boolean(args.cert) !== Boolean(args.key)) throw new Error('Both TLS certificate and key are required')
  const sponsor = process.env.DSH_RELAY_SPONSOR_ENABLED === '1' ? {
    adminToken: process.env.DSH_RELAY_SPONSOR_ADMIN_TOKEN,
    maxUsers: Number(process.env.DSH_RELAY_SPONSOR_MAX_USERS || 79),
    accepting: process.env.DSH_RELAY_SPONSOR_ACCEPTING !== '0',
    sendMail: resendMailer({ apiKey: process.env.DSH_RELAY_SPONSOR_MAIL_KEY, from: process.env.DSH_RELAY_SPONSOR_MAIL_FROM }),
    operationsToken: process.env.DSH_RELAY_SPONSOR_OPERATIONS_TOKEN,
    alertTo: process.env.DSH_RELAY_SPONSOR_ALERT_TO,
    ...(process.env.DSH_RELAY_SPONSOR_HERMES_URL || process.env.DSH_RELAY_SPONSOR_HERMES_SECRET ? {
      hermes: { url: process.env.DSH_RELAY_SPONSOR_HERMES_URL, secret: process.env.DSH_RELAY_SPONSOR_HERMES_SECRET }
    } : {}),
    trustProxy: process.env.DSH_RELAY_TRUST_PROXY === '1',
    contactEmail: process.env.DSH_RELAY_SPONSOR_CONTACT_EMAIL || '',
    ...(process.env.DSH_RELAY_SPONSOR_QR ? { qrFile: process.env.DSH_RELAY_SPONSOR_QR } : {})
  } : null
  const broker = createBroker({
    file: args.state, cert: args.cert && fs.readFileSync(args.cert), key: args.key && fs.readFileSync(args.key), sponsor,
    trafficAlerts: { report: event => console.warn(JSON.stringify(event)) },
  })
  broker.front.listen(Number(args.port || 18080), '127.0.0.1')
  if (args['tunnel-port']) {
    if (!args.cert || !args.key) throw new Error('Direct TLS listener requires a certificate and key')
    broker.tunnel.listen(Number(args['tunnel-port']), args['tunnel-bind'] || '127.0.0.1')
  }
  const usageTimer = setInterval(() => {
    const file = path.join(path.dirname(path.resolve(args.state)), 'usage.json')
    const temp = file + '.tmp'
    try { fs.writeFileSync(temp, JSON.stringify({ at: Date.now(), tenants: broker.stats() }), { mode: 0o600 }); fs.renameSync(temp, file) } catch {}
  }, 5000)
  const stop = async () => { clearInterval(usageTimer); await broker.close(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  console.log('Relay pilot started; HTTP ingress is loopback-only. No credentials are logged.')
}
module.exports = { createBroker }
