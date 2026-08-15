#!/usr/bin/env node
/**
 * DSH Remote 网关 —— 零依赖 Node 服务
 *
 * 作用:
 *   1. 静态托管 mobile web 控制台 (public/) 与管理页 (/admin)
 *   2. 把 /api/* 请求(HTTP + WebSocket)代理到本机 DSH (127.0.0.1:3080)
 *   3. Bearer Token 认证 + 已连接设备/请求状态监控
 *
 * 用法:
 *   node gateway.js                    # 默认 0.0.0.0:8787
 *   PORT=9000 TOKEN=xxx node gateway.js
 *   DSH_UPSTREAM=http://127.0.0.1:3080 node gateway.js
 *
 * 环境变量:
 *   PORT        监听端口, 默认 8787
 *   HOST        监听地址, 默认 0.0.0.0
 *   DSH_UPSTREAM  DSH web 服务地址, 默认 http://127.0.0.1:3080
 *   TOKEN       访问令牌; 不设置则读 TOKEN_FILE, 仍没有则自动生成
 *   TOKEN_FILE  令牌文件, 默认 ~/.dsh-remote/token
 */
'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '0.0.0.0'
const UPSTREAM = new URL(process.env.DSH_UPSTREAM || 'http://127.0.0.1:3080')
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(os.homedir(), '.dsh-remote', 'token')
const NOTES_FILE = process.env.DSH_REMOTE_NOTES || path.join(os.homedir(), '.dsh-remote', 'device-notes.json')
const STARTED_AT = Date.now()

// 更新检查: GitHub 为默认源, 可用环境变量覆盖(国内镜像 / 代理)
const UPDATE_CHECK_URL = process.env.UPDATE_CHECK_URL ||
  'https://api.github.com/repos/Blank-not-black/dsh-Remote/releases/latest'
const UPDATE_INTERVAL_MS = Number(process.env.UPDATE_INTERVAL_MS) || 6 * 3600 * 1000
const latestState = { version: null, url: null, tag: null, checkedAt: 0, error: '' }

function gatewayVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'version.json'), 'utf8'))
    return v.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
const VERSION = gatewayVersion()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive'
}

// ---------- token ----------
function loadToken() {
  if (process.env.TOKEN) return process.env.TOKEN
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  const token = crypto.randomBytes(24).toString('base64url')
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  } catch {}
  return token
}

const TOKEN = loadToken()

function tokenOf(req, url) {
  const auth = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m) return m[1]
  return url.searchParams.get('token')
}

function authorized(req, url) {
  return tokenOf(req, url) === TOKEN
}

// ---------- 设备监控 ----------
const devices = new Map()   // ip -> device
let totalRequests = 0
let authFailures = 0

function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')) } catch { return {} }
}
function saveNotes(notes) {
  try {
    fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true })
    fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2))
  } catch {}
}
const deviceNotes = loadNotes()

function ipOf(req) {
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown'
}

function kindOf(req) {
  const marked = req.headers['x-dsh-remote-client']
  if (marked === 'app') return 'app'
  if (marked === 'web') return 'web'
  if (marked === 'admin') return 'admin'
  const ua = String(req.headers['user-agent'] || '')
  if (/DSHRemoteApp/i.test(ua)) return 'app'
  return 'browser'
}

function touchDevice(req, extra = {}) {
  const ip = ipOf(req)
  totalRequests++
  let d = devices.get(ip)
  if (!d) {
    d = {
      ip, kind: kindOf(req), ua: '', firstSeen: Date.now(), lastSeen: 0,
      requests: 0, authFailures: 0, channels: {}, sockets: new Set()
    }
    devices.set(ip, d)
  }
  d.lastSeen = Date.now()
  d.requests++
  if (extra.channel) d.channels[extra.channel] = true
  if (extra.closeChannel) d.channels[extra.closeChannel] = false
  if (extra.failedAuth) d.authFailures++
  const marked = req.headers['x-dsh-remote-client']
  if (marked) d.kind = marked
  const ua = String(req.headers['user-agent'] || '')
  if (ua && ua.length > d.ua.length) d.ua = ua
  return d
}

function deviceViews() {
  return [...devices.values()]
    .map(d => ({
      ip: d.ip,
      note: deviceNotes[d.ip] || '',
      kind: d.kind,
      ua: d.ua,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      requests: d.requests,
      authFailures: d.authFailures,
      channels: { ...d.channels },
      online: Date.now() - d.lastSeen < 60_000
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}

function kickDevice(ip) {
  const d = devices.get(ip)
  if (!d) return 0
  let n = 0
  for (const sock of d.sockets) {
    try { sock.destroy() } catch {}
    n++
  }
  d.sockets.clear()
  d.channels = {}
  return n
}

// ---------- GitHub/镜像 更新检查 ----------
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(Number)
  const pb = String(b || '').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

function httpGetJson(url, cb) {
  let u
  try { u = new URL(url) } catch (e) { cb(new Error('更新源地址无效')); return }
  const isHttps = u.protocol === 'https:'
  const lib = isHttps ? https : http
  const proxyEnv = process.env.UPDATE_PROXY ||
    (isHttps ? process.env.HTTPS_PROXY : process.env.HTTP_PROXY) || ''
  const done = (err, value) => { if (settled) return; settled = true; cb(err, value) }
  let settled = false
  const timer = setTimeout(() => done(new Error('检查超时')), 6000)

  const request = (agent) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      method: 'GET',
      path: u.pathname + u.search,
      headers: {
        'user-agent': 'dsh-remote-gateway/' + VERSION,
        accept: 'application/json'
      },
      agent
    }, (res) => {
      let body = ''
      res.on('data', c => { body += c; if (body.length > 512 * 1024) res.destroy() })
      res.on('end', () => {
        if (res.statusCode >= 400) return done(new Error('HTTP ' + res.statusCode))
        try { done(null, JSON.parse(body)) } catch (e) { done(e) }
      })
      res.on('error', (e) => done(e))
    })
    req.on('error', (e) => done(e))
    req.end()
  }

  if (proxyEnv) {
    try {
      const p = new URL(proxyEnv)
      if (isHttps) {
        // https 经 http CONNECT 隧道
        const connect = http.request({
          hostname: p.hostname,
          port: p.port || 80,
          method: 'CONNECT',
          path: `${u.hostname}:${u.port || 443}`
        })
        connect.setTimeout(5000, () => { connect.destroy(); done(new Error('代理超时')) })
        connect.on('connect', (res, socket) => {
          if (res.statusCode !== 200) { socket.destroy(); return done(new Error('代理拒绝 ' + res.statusCode)) }
          const agent = new https.Agent({ keepAlive: true, createConnection: () => socket })
          request(agent)
        })
        connect.on('error', (e) => done(e))
        connect.end()
        return
      }
      // http 代理: 完整 URL + 主机头
      const req = http.request({
        hostname: p.hostname,
        port: p.port || 80,
        method: 'GET',
        path: url,
        headers: { host: u.host, 'user-agent': 'dsh-remote-gateway/' + VERSION, accept: 'application/json' }
      }, (res) => {
        let body = ''
        res.on('data', c => { body += c; if (body.length > 512 * 1024) res.destroy() })
        res.on('end', () => {
          if (res.statusCode >= 400) return done(new Error('HTTP ' + res.statusCode))
          try { done(null, JSON.parse(body)) } catch (e) { done(e) }
        })
        res.on('error', (e) => done(e))
      })
      req.on('error', (e) => done(e))
      req.end()
      return
    } catch (e) {
      done(e)
      return
    }
  }
  request(undefined)
}

function checkForUpdates(verbose) {
  httpGetJson(UPDATE_CHECK_URL, (err, data) => {
    latestState.checkedAt = Date.now()
    if (err) {
      latestState.error = err.message || String(err)
      if (verbose) console.log('  检查更新失败(可忽略): ' + latestState.error)
      return
    }
    latestState.error = ''
    const ver = String(data?.tag_name || data?.name || '').replace(/^v/i, '')
    latestState.version = ver || null
    latestState.tag = data?.tag_name || null
    latestState.url = data?.html_url || null
    if (latestState.version && cmpVersion(latestState.version, VERSION) > 0) {
      console.log(`  ⚡ 发现新版本 v${latestState.version} (当前 v${VERSION})`)
      console.log('    下载: ' + (latestState.url || UPDATE_CHECK_URL))
    } else if (verbose) {
      console.log(`  已是最新版本 v${VERSION}`)
    }
  })
}

// ---------- CORS ----------
function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-dsh-remote-client')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
}

// ---------- 静态文件 ----------
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('405 Method Not Allowed')
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('400 Bad Request')
    return
  }
  if (pathname === '/') pathname = '/index.html'
  if (pathname === '/admin') pathname = '/admin.html'
  const apkOverride = pathname === '/dsh-remote.apk'
  const baseDir = apkOverride ? path.join(ROOT, 'apk') : PUBLIC_DIR
  const filePath = path.normalize(path.join(baseDir, pathname))
  if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('403 Forbidden')
    return
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('404 Not Found')
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    cors(res)
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=300',
      'content-length': st.size
    })
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(filePath).pipe(res)
  })
}

// ---------- 管理 API ----------
function upstreamReachable(cb) {
  const req = http.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    method: 'GET',
    path: '/health',
    timeout: 1500
  }, (res) => {
    res.resume()
    cb(true)
  })
  req.on('error', () => cb(false))
  req.on('timeout', () => { req.destroy(); cb(false) })
  req.end()
}

function serveAdminApi(req, res, url) {
  const sub = url.pathname.slice('/admin/api'.length) || '/'
  if (sub === '/state' && req.method === 'GET') {
    if (!authorized(req, url)) {
      authFailures++
      touchDevice(req, { failedAuth: true })
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    upstreamReachable((reachable) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        version: VERSION,
        pid: process.pid,
        hostname: os.hostname(),
        lanIPs: lanAddresses(),
        startedAt: STARTED_AT,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        host: HOST,
        port: PORT,
        upstream: { url: UPSTREAM.origin, reachable },
        latest: {
          version: latestState.version,
          tag: latestState.tag,
          url: latestState.url,
          checkedAt: latestState.checkedAt,
          error: latestState.error,
          newer: !!(latestState.version && cmpVersion(latestState.version, VERSION) > 0)
        },
        tokenMasked: TOKEN.slice(0, 4) + '…' + TOKEN.slice(-4),
        tokenLength: TOKEN.length,
        totalRequests,
        authFailures,
        deviceCount: devices.size,
        onlineCount: [...devices.values()].filter(d => Date.now() - d.lastSeen < 60_000).length,
        devices: deviceViews()
      }))
    })
    return
  }
  if (sub === '/shutdown' && req.method === 'POST') {
    if (!authorized(req, url)) {
      authFailures++
      touchDevice(req, { failedAuth: true })
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, bye: true }))
    // 给响应留出发送时间, 然后退出; 由插件/系统按需再拉起
    setTimeout(() => {
      console.log('[shutdown] 收到管理端停止指令, 网关退出')
      process.exit(0)
    }, 150)
    return
  }
  if (sub === '/note' && req.method === 'POST') {
    if (!authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      try {
        const { ip, name } = JSON.parse(body || '{}')
        if (typeof ip !== 'string' || typeof name !== 'string') throw new Error('bad')
        const note = name.trim().slice(0, 40)
        if (note) deviceNotes[ip] = note
        else delete deviceNotes[ip]
        saveNotes(deviceNotes)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'bad-request' }))
      }
    })
    return
  }
  if (sub === '/kick' && req.method === 'POST') {
    if (!authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 1024) req.destroy() })
    req.on('end', () => {
      try {
        const ip = JSON.parse(body || '{}').ip
        const n = typeof ip === 'string' ? kickDevice(ip) : 0
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ kicked: n }))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'bad-request' }))
      }
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'not-found' }))
}

// ---------- /api 代理 ----------
function proxyApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }
  const ok = authorized(req, url)
  touchDevice(req, ok ? {} : { failedAuth: true })
  if (!ok) {
    authFailures++
    cors(res)
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (['host', 'authorization', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
      'proxy-connection', 'accept-encoding', 'origin', 'referer',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
      'x-dsh-remote-client'].includes(key)) continue
    headers[k] = v
  }
  headers.host = UPSTREAM.host

  const upstreamReq = http.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    method: req.method,
    path: url.pathname + url.search,
    headers
  }, (upstreamRes) => {
    const out = { ...upstreamRes.headers }
    delete out['content-length']
    cors(res)
    res.writeHead(upstreamRes.statusCode || 502, out)
    upstreamRes.pipe(res)
  })

  upstreamReq.on('error', (err) => {
    cors(res)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'upstream-unreachable', detail: String(err.message || err) }))
  })

  req.on('error', () => { upstreamReq.destroy() })
  req.on('aborted', () => { upstreamReq.destroy() })
  req.pipe(upstreamReq)
}

// ---------- 其它 ----------
function serveHealth(res) {
  cors(res)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, service: 'dsh-remote', version: VERSION, upstream: UPSTREAM.origin }))
}

function lanAddresses() {
  const out = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address)
    }
  }
  return out
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://dsh-remote.local')
    if (url.pathname.startsWith('/admin/api')) return serveAdminApi(req, res, url)
    if (url.pathname.startsWith('/api/')) return proxyApi(req, res, url)
    if (url.pathname === '/health') return serveHealth(res)
    touchDevice(req)
    return serveStatic(req, res, url)
  } catch (err) {
    // 响应已发一半(客户端中断/上游竞态)时绝不能再次写头, 否则进程崩溃
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal', detail: String(err?.message || err) }))
      } else {
        res.destroy()
      }
    } catch {}
  }
})

// 最后一层护栏: 任何未捕获异常只记录不退出(网关单点服务, 不能因单请求竞态离线)
process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err?.stack || String(err)) } catch {}
})
process.on('unhandledRejection', (err) => {
  try { console.error('[unhandledRejection]', err?.stack || String(err)) } catch {}
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://dsh-remote.local')
  if (!url.pathname.startsWith('/api/')) {
    socket.destroy()
    return
  }
  const ok = authorized(req, url)
  const channel = url.pathname.includes('events.mux') ? 'mux' : url.pathname.includes('events.host') ? 'host' : null
  const d = touchDevice(req, ok && channel ? { channel } : { failedAuth: !ok })
  if (d) d.sockets.add(socket)
  const release = () => {
    d.sockets.delete(socket)
    if (channel) d.channels[channel] = false
    try { socket.destroy() } catch {}
  }
  socket.on('close', release)
  if (!ok) {
    authFailures++
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    release()
    return
  }

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (['host', 'authorization', 'connection', 'upgrade', 'sec-websocket-key',
      'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol',
      'proxy-connection', 'accept-encoding', 'origin', 'referer',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
      'x-dsh-remote-client'].includes(key)) continue
    headers[k] = v
  }
  headers.host = UPSTREAM.host
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'
  if (req.headers['sec-websocket-key']) headers['sec-websocket-key'] = req.headers['sec-websocket-key']
  if (req.headers['sec-websocket-version']) headers['sec-websocket-version'] = req.headers['sec-websocket-version']
  if (req.headers['sec-websocket-protocol']) headers['sec-websocket-protocol'] = req.headers['sec-websocket-protocol']
  if (req.headers['sec-websocket-extensions']) headers['sec-websocket-extensions'] = req.headers['sec-websocket-extensions']

  const upstreamReq = http.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    method: req.method,
    path: url.pathname + url.search,
    headers
  })

  upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
    if (socket.destroyed) { upSocket.destroy(); return }
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`)
      else if (v !== undefined) lines.push(`${k}: ${v}`)
    }
    lines.push('', '')
    socket.write(lines.join('\r\n'))
    if (upHead?.length) upSocket.unshift(upHead)
    if (head?.length) socket.unshift(head)
    socket.setNoDelay(true)
    upSocket.setNoDelay(true)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    const close = () => { upSocket.destroy(); socket.destroy() }
    upSocket.on('error', close)
    socket.on('error', close)
    upSocket.on('close', () => socket.end())
    socket.on('close', () => upSocket.end())
  })

  upstreamReq.on('error', () => {
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      socket.destroy()
    }
  })
  upstreamReq.end()
})

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(PORT, HOST, () => {
  console.log('DSH Remote 网关 v' + VERSION + ' 已启动')
  console.log('  本机:  http://127.0.0.1:' + PORT + '/?token=' + TOKEN)
  for (const ip of lanAddresses()) {
    console.log('  手机(同一网络): http://' + ip + ':' + PORT + '/?token=' + TOKEN)
  }
  console.log('  管理页: http://127.0.0.1:' + PORT + '/admin')
  if (HOST === '127.0.0.1') {
    console.log('  提示: 监听在 127.0.0.1, 手机请改用 Tailscale serve 或设置 HOST=0.0.0.0')
  }
  console.log('  上游:  ' + UPSTREAM.origin + '  (Ctrl+C 退出)')
  // 启动 8 秒后首查, 之后每 6 小时查一次 GitHub/镜像最新版
  setTimeout(() => checkForUpdates(false), 8000)
  setInterval(() => checkForUpdates(false), UPDATE_INTERVAL_MS)
})
