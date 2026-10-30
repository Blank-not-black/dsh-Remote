'use strict'
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Transform } = require('node:stream')
const { Registry, fault, live, signingText } = require('./registry.cjs')
const { line, send, link } = require('./wire.cjs')
const { DailyQuota, MonthlyQuota, meteredSocket } = require('./quota.cjs')
const { basicPolicy, imageResponse, basicBody } = require('./basic-policy.cjs')
const { createSponsorPortal } = require('./sponsorship.cjs')

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function headersOf(input, upgrade = false) {
  const denied = new Set([...HOP, ...String(input.connection || '').toLowerCase().split(',').map(s => s.trim())])
  const out = {}
  for (const [key, value] of Object.entries(input)) if (!denied.has(key.toLowerCase()) && value !== undefined) out[key] = value
  if (upgrade) { out.connection = 'Upgrade'; out.upgrade = 'websocket' }
  else out.connection = 'close'
  return out
}
function reply(res, status, code) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: code }))
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

class FileRate extends Transform {
  constructor(rate) {
    super(); this.rate = rate; this.nextAt = 0; this.timer = null
    this.once('close', () => clearTimeout(this.timer))
  }
  _transform(chunk, encoding, done) {
    let offset = 0
    const step = () => {
      if (this.destroyed) return
      const wait = this.nextAt - performance.now()
      if (wait > 1) { this.timer = setTimeout(step, wait); return }
      const end = Math.min(offset + 16384, chunk.length)
      this.push(chunk.subarray(offset, end))
      this.nextAt = Math.max(performance.now(), this.nextAt) + (end - offset) / this.rate * 1000
      offset = end
      if (offset === chunk.length) done()
      else step()
    }
    step()
  }
}

function createBroker({ file, cert, key, frontTls = false, sweepMs = 500, heartbeatMs = 20000, fileBytesPerSecond = 102400, quotaOptions, sponsor }) {
  const registry = new Registry(file)
  const config = registry.read()
  const quota = new DailyQuota(path.join(path.dirname(path.resolve(file)), 'daily-quota.json'), quotaOptions)
  const monthlyQuota = new MonthlyQuota(path.join(path.dirname(path.resolve(file)), 'monthly-quota.json'), registry, quotaOptions)
  const portal = sponsor ? createSponsorPortal({ file, ...sponsor }) : null
  const ledger = id => registry.get(id)?.plan === 'sponsor-basic' ? monthlyQuota : quota
  const quotaError = id => registry.get(id)?.plan === 'sponsor-basic' ? 'MONTHLY_QUOTA_EXCEEDED' : 'DAILY_QUOTA_EXCEEDED'
  const runtimes = new Map()
  const allSockets = new Set()
  const enrollmentRates = new Map()
  let closing = false
  let fileTransfers = 0
  let sponsorRequests = 0
  function runtime(id) {
    if (!runtimes.has(id)) runtimes.set(id, { id, control: null, session: null, pool: [], sockets: new Set(), traffic: new Set(), waiting: [], active: 0, usage: { upstreamBytes: 0, downstreamBytes: 0, requests: 0 } })
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
    r.control = null; r.session = null; r.pool = []
  }
  function valid(r) {
    const grant = registry.get(r.id)
    return live(grant) && grant.publicKey && r.fingerprint === grant.publicKey
  }
  function usage(r) { try { return ledger(r.id).view(r.id) } catch { return { unavailable: true } } }
  function quotaChanged(r) {
    if (r.control && !r.control.destroyed) send(r.control, { type: 'usage', usage: usage(r) })
  }
  function closeTraffic(r) {
    quotaChanged(r)
    for (const socket of [...r.traffic]) socket.destroy()
    for (const waiter of r.waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(fault('DAILY_QUOTA_EXCEEDED', 429)) }
  }
  function checkQuota(r) { if (ledger(r.id).view(r.id).exhausted) throw fault(quotaError(r.id), 429) }
  function give(r, socket) {
    if (socket.destroyed) return
    if (!valid(r) || !r.control || r.control.destroyed) return socket.destroy()
    const waiter = r.waiting.shift()
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(socket) }
    else if (r.pool.length < 8) r.pool.push(socket)
    else socket.destroy()
  }
  async function take(r) {
    if (!valid(r)) throw fault('AUTHORIZATION_INACTIVE', 403)
    checkQuota(r)
    if (!r.control || r.control.destroyed) throw fault('HOST_OFFLINE', 503)
    if (r.active >= 32) throw fault('HOST_BUSY', 503)
    while (r.pool.length) { const socket = r.pool.shift(); if (!socket.destroyed) return socket }
    if (r.waiting.length >= 8) throw fault('HOST_BUSY', 503)
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null }
      item.timer = setTimeout(() => { r.waiting = r.waiting.filter(w => w !== item); reject(fault('HOST_BUSY', 503)) }, 3000)
      r.waiting.push(item)
    })
  }
  const acceptTunnel = async socket => {
    track(socket); socket.setNoDelay(true); socket.setKeepAlive(true, 30000)
    try {
      const nonce = crypto.randomBytes(32).toString('base64url')
      send(socket, { type: 'challenge', nonce })
      const auth = await line(socket)
      const grant = registry.get(auth.grantId)
      if (!grant?.publicKey || !['control', 'work'].includes(auth.role) || !/^[A-Za-z0-9_-]{86}$/.test(auth.signature || '')) throw fault('INVALID_AUTHORIZATION', 403)
      const r = runtime(grant.id)
      if (!crypto.verify(null, signingText(nonce, grant.id, auth.role, auth.session || ''), grant.publicKey, Buffer.from(auth.signature, 'base64url'))) throw fault('INVALID_AUTHORIZATION', 403)
      if (!live(grant)) throw fault('AUTHORIZATION_INACTIVE', 403)
      if (auth.role === 'control') {
        if (auth.session) throw fault('INVALID_AUTHORIZATION', 403)
        // A duplicate connection never replaces a live host or its public traffic.
        if (r.control && !r.control.destroyed) throw fault('HOST_ALREADY_ONLINE', 409)
        r.control = socket; r.session = crypto.randomBytes(24).toString('base64url'); r.fingerprint = grant.publicKey
        track(socket, r)
        const session = r.session
        send(socket, { type: 'accepted', session, usage: usage(r) })
        socket.once('close', () => { if (r.session === session) disconnect(r) })
        const heartbeat = setInterval(() => send(socket, { type: 'ping', usage: usage(r) }), heartbeatMs)
        socket.once('close', () => clearInterval(heartbeat))
        while (!socket.destroyed) {
          const message = await line(socket, heartbeatMs * 3)
          if (message.type !== 'pong') throw fault('INVALID_CONTROL_MESSAGE')
        }
      } else {
        if (!r.control || !auth.session || auth.session !== r.session || !valid(r)) throw fault('STALE_HOST_SESSION', 403)
        track(socket, r)
        send(socket, { type: 'parked' })
        give(r, socket)
        // Idle parked channels are replaced before stale NAT state accumulates.
        const expiry = setTimeout(() => { if (r.pool.includes(socket)) socket.destroy() }, 45000)
        socket.once('close', () => { clearTimeout(expiry); r.pool = r.pool.filter(s => s !== socket) })
      }
    } catch (error) {
      if (error.code === 'AUTHORIZATION_INACTIVE') {
        send(socket, { type: 'rejected', code: 'AUTHORIZATION_INACTIVE' }); socket.end()
        const cleanup = setTimeout(() => socket.destroy(), 1000); cleanup.unref()
      } else socket.destroy()
    }
  }
  const tunnel = tls.createServer({ cert, key, minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, acceptTunnel)
  tunnel.on('tlsClientError', () => {})
  tunnel.maxConnections = sponsor ? 1024 : 256

  function tenant(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
    const grant = registry.read().grants.find(g => g.domain === host)
    if (!grant) throw fault('UNKNOWN_HOST', 404)
    if (!live(grant)) throw fault('AUTHORIZATION_INACTIVE', 403)
    if (!grant.publicKey) throw fault('HOST_NOT_ENROLLED', 503)
    const r = runtime(grant.id)
    if (req.socket.relayTenant && req.socket.relayTenant !== r.id) throw fault('HOST_MISMATCH', 421)
    if (!req.socket.relayTenant) { req.socket.relayTenant = r.id; track(req.socket, r) }
    return r
  }
  function upstream(req, work, upgrade) {
    send(work, { type: 'start' })
    const r = runtime(req.socket.relayTenant)
    const metered = meteredSocket(work, bytes => ledger(r.id).consume(r.id, bytes), () => closeTraffic(r))
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
    let work, request, r, counted = false, fileSlot = false, upload, download, sponsorSlot = false
    const release = () => {
      if (counted) { counted = false; r.active-- }
      if (fileSlot) { fileSlot = false; fileTransfers-- }
      if (sponsorSlot) { sponsorSlot = false; sponsorRequests-- }
      upload?.destroy(); download?.destroy()
    }
    try {
      r = tenant(req)
      const mode = registry.get(r.id)?.plan === 'sponsor-basic' ? basicPolicy(req) : null
      let buffered = null
      if (registry.get(r.id)?.plan === 'sponsor-basic' && (mode || req.method === 'POST' && req.url.startsWith('/api/'))) {
        if (sponsorRequests >= 4) throw fault('HOST_BUSY', 503)
        sponsorRequests++; sponsorSlot = true
        buffered = await basicBody(req)
      }
      const pathname = new URL(req.url, 'http://relay.invalid').pathname
      if (!mode && (pathname === '/fs' || pathname.startsWith('/fs/'))) {
        if (fileTransfers >= 2) throw fault('FILE_TRANSFER_BUSY', 429)
        fileTransfers++; fileSlot = true
      }
      work = await take(r)
      if (req.destroyed && !req.complete || res.destroyed) { work.destroy(); release(); return }
      if (r.active >= 32) throw fault('HOST_BUSY', 503)
      r.active++; counted = true; r.usage.requests++
      res.once('close', release); res.once('finish', release)
      request = upstream(req, work, false)
      req.on('data', chunk => { r.usage.upstreamBytes += chunk.length })
      req.once('aborted', () => request.destroy())
      res.once('close', () => request.destroy())
      request.on('error', error => { release(); work.destroy(); reply(res, error.status || 503, error.code?.endsWith('QUOTA_EXCEEDED') ? quotaError(r.id) : 'HOST_CONNECTION_LOST') })
      request.on('response', response => {
        if (res.destroyed) { response.destroy(); return }
        if (mode) { void imageResponse(response, res, mode); return }
        res.writeHead(response.statusCode, headersOf(response.headers))
        response.on('data', chunk => { r.usage.downstreamBytes += chunk.length })
        response.on('error', () => res.destroy())
        if (fileSlot) {
          download = new FileRate(fileBytesPerSecond)
          download.on('error', () => res.destroy())
          response.pipe(download).pipe(res)
        } else response.pipe(res)
      })
      if (fileSlot) {
        upload = new FileRate(fileBytesPerSecond)
        upload.on('error', () => request.destroy())
        req.pipe(upload).pipe(request)
      } else if (buffered) { r.usage.upstreamBytes += buffered.length; request.end(buffered) }
      else req.pipe(request)
      work.resume()
    } catch (error) {
      work?.destroy(); release()
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
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-relay-v1\r\n\r\n')
      if (head.length) socket.unshift(head)
      acceptTunnel(socket)
      return
    }
    let work, r, request, counted = false
    const fail = error => {
      work?.destroy()
      if (socket.destroyed) return
      const status = error?.status || 503
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    try {
      if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') throw fault('INVALID_UPGRADE')
      r = tenant(req)
      if (registry.get(r.id)?.plan === 'sponsor-basic' && (basicPolicy(req) || !/^\/api\/events\.(?:mux|host)(?:\?|$)/.test(req.url))) throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
      work = await take(r)
      if (socket.destroyed) { work.destroy(); return }
      if (r.active >= 32) throw fault('HOST_BUSY', 503)
      r.active++; counted = true
      work.once('close', () => { if (counted) { counted = false; r.active-- } })
      request = upstream(req, work, true)
      request.on('error', fail)
      socket.once('close', () => request.destroy())
      request.on('response', response => {
        const headers = headersOf(response.headers)
        socket.write(`HTTP/1.1 ${response.statusCode} ${http.STATUS_CODES[response.statusCode] || 'Response'}\r\n` + Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
        response.pipe(socket)
      })
      request.on('upgrade', (response, remote, remoteHead) => {
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
      try { if (r.control && !valid(r)) disconnect(r) } catch { disconnect(r) }
    }
  }, sweepMs)
  sweep.unref()
  return { registry, front, tunnel,
    quota,
    monthlyQuota, portal,
    stats: () => [...runtimes.values()].map(r => ({ grantId: r.id, online: Boolean(r.control && !r.control.destroyed), active: r.active, pooled: r.pool.filter(s => !s.destroyed).length, ...r.usage, daily: usage(r) })),
    async close() {
      if (closing) return
      closing = true; clearInterval(sweep)
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
  const sponsor = process.env.DSH_RELAY_SPONSOR_ENABLED === '1' ? { adminToken: process.env.DSH_RELAY_SPONSOR_ADMIN_TOKEN, maxUsers: Number(process.env.DSH_RELAY_SPONSOR_MAX_USERS || 79), accepting: process.env.DSH_RELAY_SPONSOR_ACCEPTING !== '0', contactEmail: process.env.DSH_RELAY_SPONSOR_CONTACT_EMAIL || '', ...(process.env.DSH_RELAY_SPONSOR_QR ? { qrFile: process.env.DSH_RELAY_SPONSOR_QR } : {}) } : null
  const broker = createBroker({ file: args.state, cert: args.cert && fs.readFileSync(args.cert), key: args.key && fs.readFileSync(args.key), sponsor })
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
