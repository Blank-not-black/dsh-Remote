'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const { EventEmitter } = require('node:events')
const { line, send, link } = require('./wire.cjs')
const { signingText, fault } = require('./registry.cjs')

function gatewayAddress(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fault('LOCAL_GATEWAY_REQUIRED')
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) }
}
function enroll(origin, code, publicKey, ca) {
  const url = new URL('/relay/v1/enroll', origin)
  if (new URL(origin).origin !== String(origin).replace(/\/$/, '') || url.protocol !== 'https:' || url.username || url.password) return Promise.reject(fault('HTTPS_ORIGIN_REQUIRED'))
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ code, publicKey }))
    const request = https.request(url, { method: 'POST', ca, headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 12000 }, response => {
      const chunks = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) request.destroy(); else chunks.push(chunk) })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          let code = 'ENROLLMENT_REJECTED'
          try {
            const candidate = JSON.parse(Buffer.concat(chunks).toString('utf8')).error
            if (['INVALID_AUTHORIZATION', 'HOST_ALREADY_BOUND', 'REGISTRY_BUSY', 'TRY_LATER', 'INVALID_PUBLIC_KEY', 'INVALID_ENROLLMENT'].includes(candidate)) code = candidate
          } catch {}
          return reject(fault(code, response.statusCode))
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(fault('INVALID_SERVER_RESPONSE')) }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => reject(fault('ENROLLMENT_CONNECTION_FAILED', 503)))
    request.end(data)
  })
}

function upgradeChannel(origin, ca) {
  const target = new URL(origin)
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return Promise.reject(fault('HTTPS_ORIGIN_REQUIRED'))
  return new Promise((resolve, reject) => {
    const request = https.request(new URL('/relay/v1/tunnel', target), { ca, headers: { connection: 'Upgrade', upgrade: 'dsh-relay-v1' }, timeout: 12000 })
    request.on('upgrade', (response, socket, head) => {
      request.setTimeout(0)
      if (String(response.headers.upgrade).toLowerCase() !== 'dsh-relay-v1') { socket.destroy(); return reject(fault('INVALID_TUNNEL_UPGRADE')) }
      socket.pause()
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    request.on('response', response => { response.resume(); reject(fault('TUNNEL_UPGRADE_REJECTED', response.statusCode)) })
    request.on('timeout', () => request.destroy())
    request.on('error', () => reject(fault('TUNNEL_CONNECTION_FAILED', 503)))
    request.end()
  })
}

class RelayClient extends EventEmitter {
  constructor({ grantId, privateKey, tunnelHost, tunnelPort, tunnelOrigin, expiresAt, gateway = 'http://127.0.0.1:8787', ca, poolSize = 4, reconnectMs = 1500 }) {
    super()
    if (!/^[a-f0-9]{16}$/.test(grantId || '') || !Number.isInteger(Number(tunnelPort)) || tunnelPort < 1 || tunnelPort > 65535 || !Number.isFinite(expiresAt)) throw fault('INVALID_CLIENT_CONFIG')
    this.grantId = grantId; this.privateKey = crypto.createPrivateKey(privateKey)
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw fault('INVALID_PRIVATE_KEY')
    this.target = gatewayAddress(gateway)
    this.tunnelHost = tunnelHost; this.tunnelPort = Number(tunnelPort); this.expiresAt = expiresAt; this.ca = ca
    this.tunnelOrigin = tunnelOrigin
    this.poolSize = Math.min(6, Math.max(1, poolSize)); this.reconnectMs = reconnectMs
    this.context = null; this.running = false; this.timer = null; this.failures = 0; this.controlSocket = null; this.epoch = 0
  }
  async authenticate(role, session = '', context) {
    const socket = this.tunnelOrigin ? await upgradeChannel(this.tunnelOrigin, this.ca) : tls.connect({ host: this.tunnelHost, port: this.tunnelPort, servername: net.isIP(this.tunnelHost) ? undefined : this.tunnelHost, ca: this.ca, minVersion: 'TLSv1.2', rejectUnauthorized: true })
    socket.on('error', () => {}); socket.setNoDelay(true); socket.setKeepAlive(true, 30000)
    if (context) { context.sockets.add(socket); socket.once('close', () => context.sockets.delete(socket)) }
    else this.controlSocket = socket
    try {
      const challenge = await line(socket)
      if (challenge.type !== 'challenge' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce || '')) throw fault('INVALID_CHALLENGE')
      const signature = crypto.sign(null, signingText(challenge.nonce, this.grantId, role, session), this.privateKey).toString('base64url')
      send(socket, { grantId: this.grantId, role, session, signature })
      const accepted = await line(socket)
      if (accepted.type === 'rejected' && accepted.code === 'AUTHORIZATION_INACTIVE') throw fault('AUTHORIZATION_INACTIVE', 403)
      if (!this.running || Date.now() >= this.expiresAt || accepted.type !== (role === 'control' ? 'accepted' : 'parked')) throw fault('CONNECTION_NOT_ACCEPTED')
      return { socket, accepted }
    } catch (error) { socket.destroy(); throw error }
  }
  start() { if (!this.running) { this.running = true; this.epoch++; this.connect() }; return this }
  async connect() {
    if (!this.running) return
    if (Date.now() >= this.expiresAt) { this.stop(); this.emit('status', 'expired'); return }
    let context
    const epoch = this.epoch
    try {
      const { socket, accepted } = await this.authenticate('control')
      if (epoch !== this.epoch) { socket.destroy(); return }
      context = { socket, session: accepted.session, sockets: new Set([socket]), pending: 0, closing: false, retryTimer: null }
      this.context = context; this.failures = 0
      if (accepted.usage) this.emit('usage', accepted.usage)
      this.emit('status', 'online'); this.refill(context)
      while (this.running && !context.closing) {
        const message = await line(socket, 65000)
        if (message.type === 'usage') { this.emit('usage', message.usage); continue }
        if (message.type !== 'ping') throw fault('INVALID_CONTROL_MESSAGE')
        if (message.usage) this.emit('usage', message.usage)
        send(socket, { type: 'pong' })
      }
    } catch (error) {
      if (error.code === 'AUTHORIZATION_INACTIVE') { this.stop(); this.emit('status', 'authorization-inactive') }
      else if (this.running) this.emit('status', 'reconnecting')
    }
    finally {
      if (context) this.dispose(context)
      if (context && this.controlSocket === context.socket) this.controlSocket = null
      if (this.running && epoch === this.epoch) {
        const wait = Math.min(60000, this.reconnectMs * 2 ** Math.min(this.failures++, 6))
        this.timer = setTimeout(() => this.connect(), wait)
      }
    }
  }
  refill(context) {
    if (!this.running || context.closing || this.context !== context || Date.now() >= this.expiresAt) return
    while (context.pending < this.poolSize) { context.pending++; this.work(context) }
  }
  async work(context) {
    let pending = true, remote, local, failed = false
    try {
      const accepted = await this.authenticate('work', context.session, context)
      remote = accepted.socket
      const start = await line(remote, 60000)
      if (start.type !== 'start' || context.closing || this.context !== context) throw fault('STALE_WORK')
      context.pending--; pending = false
      this.refill(context)
      local = net.connect(this.target); context.sockets.add(local)
      local.setNoDelay(true)
      const connectTimer = setTimeout(() => local.destroy(), 5000)
      local.once('connect', () => clearTimeout(connectTimer))
      local.once('close', () => clearTimeout(connectTimer))
      // A work channel is single-use. Failed writes are never replayed.
      link(remote, local)
      await new Promise(resolve => remote.once('close', resolve))
    } catch (error) {
      failed = true
      if (error.code === 'AUTHORIZATION_INACTIVE') { this.stop(); this.emit('status', 'authorization-inactive') }
    }
    finally {
      remote?.destroy(); local?.destroy()
      if (remote) context.sockets.delete(remote)
      if (local) context.sockets.delete(local)
      if (pending) context.pending--
      if (!context.closing && this.running && this.context === context) {
        // Retry failed pool connections at most once per second, not in a hot loop.
        if (failed) {
          if (!context.retryTimer) context.retryTimer = setTimeout(() => { context.retryTimer = null; this.refill(context) }, 1000)
        } else this.refill(context)
      }
    }
  }
  dispose(context) {
    context.closing = true; clearTimeout(context.retryTimer)
    for (const socket of context.sockets) socket.destroy()
    context.sockets.clear()
    if (this.context === context) this.context = null
  }
  stop() {
    this.running = false; this.epoch++; clearTimeout(this.timer); this.controlSocket?.destroy()
    if (this.context) this.dispose(this.context)
  }
}

async function main() {
  const args = require('./options.cjs')(process.argv.slice(2))
  if (!args.state) throw fault('STATE_DIRECTORY_REQUIRED')
  const root = path.resolve(args.state)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const ca = args.ca ? fs.readFileSync(args.ca) : undefined
  const configFile = path.join(root, 'connection.json')
  const keyFile = path.join(root, 'host-private.pem')
  const stopFile = path.join(root, 'stop.request')
  if (args._[0] === 'enroll') {
    const invite = JSON.parse(fs.readFileSync(args.invite, 'utf8'))
    const gateway = args.gateway || 'http://127.0.0.1:8787'
    gatewayAddress(gateway)
    if (!fs.existsSync(keyFile)) {
      const keys = crypto.generateKeyPairSync('ed25519')
      fs.writeFileSync(keyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
    }
    const key = crypto.createPrivateKey(fs.readFileSync(keyFile))
    const pub = crypto.createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString()
    const config = await enroll(invite.server, invite.code, pub, ca)
    fs.writeFileSync(configFile, JSON.stringify({ ...config, gateway }, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ publicUrl: config.publicUrl, expiresAt: config.expiresAt }))
  } else if (args._[0] === 'run') {
    if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile)
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    const client = new RelayClient({ ...config, privateKey: fs.readFileSync(keyFile), ca })
    let stopTimer
    const stop = () => { clearInterval(stopTimer); client.stop(); setTimeout(() => process.exit(0), 100) }
    client.on('status', status => { console.log(JSON.stringify({ status })); if (['expired', 'authorization-inactive'].includes(status)) stop() })
    stopTimer = setInterval(() => { if (fs.existsSync(stopFile)) stop() }, 500)
    process.once('SIGTERM', stop); process.once('SIGINT', stop)
    client.start()
  } else if (args._[0] === 'stop') {
    fs.writeFileSync(stopFile, 'stop\n', { mode: 0o600 })
    console.log('Relay stop requested.')
  } else throw fault('USE_ENROLL_RUN_OR_STOP')
}
if (require.main === module) main().catch(error => { console.error(error.code || 'CLIENT_FAILED'); process.exitCode = 1 })
module.exports = { RelayClient, enroll, gatewayAddress }
