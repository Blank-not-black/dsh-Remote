'use strict'
const http = require('node:http')
const https = require('node:https')
const { headersOf } = require('./http-headers.cjs')
const { basicPolicy, basicBody, imageResponse } = require('./basic-policy.cjs')
const { link } = require('./wire.cjs')
const { fault } = require('./registry.cjs')
const { FileRate } = require('./file-rate.cjs')

// Attached only to authenticated reverse work streams, never a listening port.
// Access authentication remains owned by the real local gateway.
class E2eeEndpoint {
  constructor({ identity, target, policy, expiresAt, devices }) {
    if (!['standard', 'sponsor-basic'].includes(policy) || !Number.isFinite(expiresAt)) throw fault('E2EE_POLICY_REQUIRED')
    this.policy = policy; this.expiresAt = expiresAt; this.sockets = new Set(); this.active = 0; this.buffered = 0; this.files = 0
    this.devices = devices
    this.expiryTimer = setInterval(() => {
      for (const socket of this.sockets) if (Date.now() >= this.expiresAt || socket.deviceId && !this.devices?.active(socket.deviceId)) socket.destroy()
    }, 1000); this.expiryTimer.unref()
    this.server = https.createServer({ cert: identity.certificate, key: identity.privateKey,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', handshakeTimeout: 10000,
      ALPNProtocols: ['http/1.1'] }, (req, res) => this.proxy(req, res))
    this.target = target
    this.server.headersTimeout = 15000; this.server.requestTimeout = 120000
    this.server.maxHeadersCount = 100
    this.server.on('secureConnection', socket => this.track(socket))
    this.server.on('tlsClientError', (_, socket) => socket.destroy())
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    this.plainServer = http.createServer((req, res) => this.proxy(req, res))
    this.plainServer.headersTimeout = 15000; this.plainServer.requestTimeout = 120000; this.plainServer.maxHeadersCount = 100
    this.plainServer.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
  }
  track(socket) { this.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => this.sockets.delete(socket)) }
  accept(socket) {
    if (Date.now() >= this.expiresAt || this.sockets.size >= 64) return socket.destroy()
    this.track(socket); this.server.emit('connection', socket); socket.resume()
  }
  acceptPlain(socket) {
    if (Date.now() >= this.expiresAt || this.sockets.size >= 64) return socket.destroy()
    this.track(socket); this.plainServer.emit('connection', socket); socket.resume()
  }
  check(req, upgrade = false) {
    if (!req.url.startsWith('/') || req.url.startsWith('//')) throw fault('INVALID_REQUEST_TARGET')
    if (Date.now() >= this.expiresAt) throw fault('AUTHORIZATION_INACTIVE', 403)
    if (this.devices) req.socket.deviceId = this.devices.authorize(req.headers['x-dsh-relay-device'])
    if (this.active >= 16) throw fault('HOST_BUSY', 503)
    if (this.policy !== 'sponsor-basic') return null
    const mode = basicPolicy(req)
    if (upgrade && (mode || req.method !== 'GET' || !/^\/api\/events\.(?:mux|host)(?:\?|$)/.test(req.url))) throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
    return mode
  }
  request(req, upgrade) {
    // target is parsed once by gatewayAddress(), never chosen by the request.
    const headers = headersOf(req.headers, upgrade)
    delete headers['x-dsh-relay-device']
    const request = http.request({ ...this.target, method: req.method, path: req.url, headers, agent: false })
    request.on('socket', socket => require('./gateway-sockets.cjs').track(socket))
    request.setTimeout(120000, () => request.destroy())
    return request
  }
  async proxy(req, res) {
    let request, counted = false, buffered = false, file = false, upload, download
    const release = () => {
      if (counted) { counted = false; this.active-- }; if (buffered) { buffered = false; this.buffered-- }
      if (file) { file = false; this.files-- }; upload?.destroy(); download?.destroy()
    }
    const fail = error => {
      release()
      if (res.headersSent) return res.destroy()
      res.writeHead(error.status || 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: error.code || 'HOST_CONNECTION_LOST' }))
    }
    try {
      const mode = this.check(req)
      const pathname = new URL(req.url, 'http://relay.invalid').pathname
      if (!mode && (pathname === '/fs' || pathname.startsWith('/fs/'))) {
        if (this.files >= 2) throw fault('FILE_TRANSFER_BUSY', 429)
        this.files++; file = true
      }
      if (this.policy === 'sponsor-basic' && (mode || req.method === 'POST' && req.url.startsWith('/api/'))) {
        if (this.buffered >= 4) throw fault('HOST_BUSY', 503)
        this.buffered++; buffered = true
      }
      this.active++; counted = true
      res.once('close', release); res.once('finish', release)
      const body = this.policy === 'sponsor-basic' ? await basicBody(req) : null
      if (res.destroyed || req.aborted) { release(); return }
      request = this.request(req, false)
      req.once('aborted', () => request.destroy()); res.once('close', () => request.destroy())
      request.on('error', fail)
      request.on('response', response => {
        if (res.destroyed) return response.destroy()
        if (mode) { void imageResponse(response, res, mode); return }
        res.writeHead(response.statusCode, headersOf(response.headers))
        response.on('error', () => res.destroy())
        if (file) {
          download = new FileRate(102400); download.on('error', () => res.destroy()); response.pipe(download).pipe(res)
        } else response.pipe(res)
      })
      if (body) request.end(body)
      else if (file) {
        upload = new FileRate(102400); upload.on('error', () => request.destroy()); req.pipe(upload).pipe(request)
      } else req.pipe(request)
    } catch (error) { request?.destroy(); fail(error) }
  }
  upgrade(req, socket, head) {
    let request, counted = false
    const release = () => { if (counted) { counted = false; this.active-- } }
    const fail = error => {
      request?.destroy(); release()
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.status || 503} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    try {
      if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.method !== 'GET') throw fault('INVALID_UPGRADE')
      this.check(req, true); this.active++; counted = true
      socket.once('close', () => { release(); request?.destroy() })
      request = this.request(req, true); request.on('error', fail)
      request.on('response', response => {
        socket.write(`HTTP/1.1 ${response.statusCode} Rejected\r\n` + Object.entries(headersOf(response.headers)).map(([k,v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
        response.on('error', () => socket.destroy()); response.pipe(socket)
      })
      request.on('upgrade', (response, remote, remoteHead) => {
        if (socket.destroyed) return remote.destroy()
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(headersOf(response.headers, true)).map(([k,v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
        if (head.length) remote.write(head)
        if (remoteHead.length) socket.write(remoteHead)
        link(socket, remote)
      })
      request.end()
    } catch (error) { fail(error) }
  }
  close() { clearInterval(this.expiryTimer); for (const socket of this.sockets) socket.destroy(); this.server.close(); this.plainServer.close() }
}
module.exports = { E2eeEndpoint }
