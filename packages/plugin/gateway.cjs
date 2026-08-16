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
 *   DSH_REMOTE_FS_ROOT       文件传输允许根, 默认 ~, 多个用 ':' 分隔
 *   DSH_REMOTE_FS_MAX_UPLOAD 上传字节上限, 默认 2147483648 (2GB)
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

// ---------- /fs 文件传输 ----------
// 允许访问的根目录: DSH_REMOTE_FS_ROOT 用 ':' 分隔多个根, 默认仅 ~。
// 所有 /fs/* 路径 resolve 后都必须位于某个根内, 已存在的路径还会用 realpath
// 复核一次, 防止 ../ 穿越与符号链接逃逸。
const FS_DEFAULT_ROOT = path.resolve(os.homedir())
const FS_ROOTS = (process.env.DSH_REMOTE_FS_ROOT || FS_DEFAULT_ROOT)
  .split(':')
  .filter(Boolean)
  .map(r => path.resolve(r.trim() === '~' ? FS_DEFAULT_ROOT : r.trim()))
const FS_MAX_UPLOAD = Number(process.env.DSH_REMOTE_FS_MAX_UPLOAD) || 2 * 1024 * 1024 * 1024
let FS_ROOT_REALS = null
function fsRootReals() {
  if (!FS_ROOT_REALS) {
    FS_ROOT_REALS = FS_ROOTS.map(r => { try { return fs.realpathSync(r) } catch { return null } }).filter(Boolean)
  }
  return FS_ROOT_REALS
}
function fsInsideReal(real) {
  for (const root of fsRootReals()) {
    if (real === root || real.startsWith(root + path.sep)) return true
  }
  return false
}

const FS_MIME = {
  ...MIME,
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.epub': 'application/epub+zip',
  '.wasm': 'application/wasm',
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

const TOKEN_FROM_ENV = !!process.env.TOKEN
let TOKEN = loadToken()

/** 一键轮换令牌: 写回 TOKEN_FILE 并立即生效(旧令牌/旧连接全部失效)。 */
function rotateToken() {
  if (TOKEN_FROM_ENV) return { error: 'token-from-env', detail: '令牌来自 TOKEN 环境变量, 请修改环境变量后重启' }
  const next = crypto.randomBytes(24).toString('base64url')
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    fs.writeFileSync(TOKEN_FILE, next + '\n', { mode: 0o600 })
  } catch (err) {
    return { error: 'write-failed', detail: err.message }
  }
  TOKEN = next
  return { ok: true, token: next }
}

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
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim())
  if (!m) return { core: [0, 0, 0], pre: null }
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || null }
}
function cmpVersion(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i] - pb.core[i]
    if (d) return d
  }
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const sa = String(pa.pre).split('.'), sb = String(pb.pre).split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i] ?? '', y = sb[i] ?? ''
    if (x === y) continue
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d }
    else if (nx !== ny) return nx ? -1 : 1
    else { const d = x.localeCompare(y); if (d) return d }
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
  // 兼容旧版 App(版本比较不认 -rc): 无 local 参数的请求把 0.5.2-rc.1 显示为 0.5.2,
  // 引导升级到新 APK; 新 App 带 ?local= 拿到真实 rc 版本, 不会循环提示。
  if (pathname === '/update.json') {
    fs.readFile(path.join(PUBLIC_DIR, 'update.json'), 'utf8', (err, raw) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('404 Not Found')
        return
      }
      let json = {}
      try { json = JSON.parse(raw) } catch {}
      if (!url.searchParams.has('local')) {
        json = { ...json, version: String(json.version || '').replace(/-.*$/, '') }
      }
      cors(res)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(json))
    })
    return
  }
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
        mode: 'gateway',
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
        token: TOKEN,
        tokenFromEnv: TOKEN_FROM_ENV,
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
  if (sub === '/token/rotate' && req.method === 'POST') {
    if (!authorized(req, url)) {
      authFailures++
      touchDevice(req, { failedAuth: true })
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const r = rotateToken()
    if (!r.ok) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: r.error, detail: r.detail }))
      return
    }
    // 旧令牌立即失效: 断开已连接的 App/浏览器, 让它们重新扫码/输入
    for (const d of devices.values()) {
      if (d.kind !== 'admin') kickDevice(d.ip)
    }
    touchDevice(req)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, token: r.token, tokenMasked: r.token.slice(0, 4) + '…' + r.token.slice(-4) }))
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

// ---------- /fs 文件传输: 实现 ----------
function fsJson(res, status, body) {
  cors(res)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function fsAuthorized(req, url, res) {
  const ok = authorized(req, url)
  touchDevice(req, ok ? {} : { failedAuth: true })
  if (!ok) {
    authFailures++
    fsJson(res, 401, { error: 'unauthorized' })
    return false
  }
  return true
}

/** 把用户给的 path 解析为绝对路径并做词法根检查; 返回 {abs} 或 {error}。 */
function fsResolve(input) {
  const raw = String(input ?? '').trim()
  let abs
  if (!raw || raw === '~') abs = FS_ROOTS[0]
  else if (raw.startsWith('~/')) abs = path.resolve(FS_DEFAULT_ROOT, raw.slice(2))
  else if (path.isAbsolute(raw)) abs = path.resolve(raw)
  else abs = path.resolve(FS_ROOTS[0], raw) // 相对路径按默认根解析
  for (const root of FS_ROOTS) {
    if (abs === root || abs.startsWith(root + path.sep)) return { abs }
  }
  return { error: 'forbidden' }
}

/** realpath 复核: 符号链接目标也必须落在允许根内。 */
function fsRealChecked(abs) {
  let real
  try {
    real = fs.realpathSync(abs)
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' }
  }
  if (!fsInsideReal(real)) return { error: 'forbidden' }
  return { abs: real }
}

function fsContentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download'
  const star = encodeURIComponent(name).replace(/['()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`
}

/** 单段 Range: bytes=a-b / bytes=a- / bytes=-n。多段或不合法返回 null(按 200 整文件处理)。 */
function fsParseRange(header, size) {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m) return null
  const s = m[1], e = m[2]
  if (s === '' && e === '') return null
  if (s === '') { // 末尾 n 字节
    const n = Number(e)
    if (!Number.isFinite(n) || n <= 0) return null
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(s)
  if (!Number.isFinite(start) || start < 0) return null
  if (e === '') return { start, end: size - 1 }
  const end = Number(e)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

function fsList(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  const resolved = fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })

  let st
  try { st = fs.statSync(checked.abs) } catch (err) {
    return fsJson(res, err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' })
  }
  if (!st.isDirectory()) return fsJson(res, 400, { error: 'not-a-directory' })

  let dirents
  try { dirents = fs.readdirSync(checked.abs, { withFileTypes: true }) } catch {
    return fsJson(res, 403, { error: 'permission-denied' })
  }
  const entries = []
  for (const d of dirents) {
    const full = path.join(checked.abs, d.name)
    try {
      // 符号链接指向允许根之外时直接不展示, 点进去/下载也必然被 realpath 复核拒绝
      if (d.isSymbolicLink()) {
        const real = fs.realpathSync(full)
        if (!fsInsideReal(real)) continue
      }
      const info = fs.statSync(full)
      if (!info.isFile() && !info.isDirectory()) continue
      entries.push({
        name: d.name,
        type: info.isDirectory() ? 'dir' : 'file',
        size: info.isDirectory() ? 0 : info.size,
        mtimeMs: Math.round(info.mtimeMs)
      })
    } catch {
      // 单个条目无权限/已消失: 跳过, 不让整个列表失败
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
  })
  fsJson(res, 200, { path: resolved.abs, entries })
}

function fsFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  const resolved = fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })

  let st
  try { st = fs.statSync(checked.abs) } catch (err) {
    return fsJson(res, err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' })
  }
  if (!st.isFile()) return fsJson(res, 400, { error: 'not-a-file' })

  const range = fsParseRange(req.headers.range, st.size)
  if (range && range.start >= st.size) {
    cors(res)
    res.writeHead(416, {
      'content-type': 'application/json; charset=utf-8',
      'content-range': `bytes */${st.size}`,
      'accept-ranges': 'bytes'
    })
    res.end(JSON.stringify({ error: 'range-not-satisfiable', size: st.size }))
    return
  }

  const ext = path.extname(checked.abs).toLowerCase()
  cors(res)
  res.writeHead(range ? 206 : 200, {
    'content-type': FS_MIME[ext] || 'application/octet-stream',
    'content-length': range ? range.end - range.start + 1 : st.size,
    'content-disposition': fsContentDisposition(path.basename(checked.abs)),
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${st.size}` } : {})
  })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = range
    ? fs.createReadStream(checked.abs, { start: range.start, end: range.end })
    : fs.createReadStream(checked.abs)
  stream.on('error', () => { try { res.destroy() } catch {} })
  stream.pipe(res)
}

function fsValidName(name) {
  if (typeof name !== 'string') return false
  if (!name || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  if (path.basename(name) !== name) return false
  return true
}

/** 流式计算文件 SHA-256(十六进制)。2GB 也就一次顺序读, 落盘前校验足够快。 */
function sha256FileHex(file, cb) {
  const hash = crypto.createHash('sha256')
  let stream
  try {
    stream = fs.createReadStream(file)
  } catch (err) {
    cb(err)
    return
  }
  stream.on('error', (err) => cb(err))
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', () => cb(null, hash.digest('hex')))
}

/* 进行中的续传写流: 取消时先 destroy 再删分片, 避免“先删后写”竞态 */
const activeUploads = new Map()
function fsActiveKey(dirReal, name, session) {
  return dirReal + '\n' + name + '\n' + (session || '')
}

/** 打开上传目标: 同名冲突/符号链接/临时文件都在这层判定。 */
function fsOpenUploadTarget(res, url, dirLex, dirReal, name) {
  if (!fsValidName(name)) {
    fsJson(res, 400, { error: 'bad-name', detail: '文件名不能为空且不能包含路径分隔符' })
    return null
  }
  const target = path.join(dirReal, name)
  const overwrite = url.searchParams.get('overwrite') === '1' || url.searchParams.get('overwrite') === 'true'
  let exists = false
  try {
    const st = fs.lstatSync(target)
    exists = true
    if (st.isSymbolicLink()) {
      fsJson(res, 403, { error: 'symlink-forbidden', detail: '拒绝覆盖符号链接' })
      return null
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fsJson(res, 403, { error: 'permission-denied', detail: err.message })
      return null
    }
  }
  if (exists && !overwrite) {
    fsJson(res, 409, { error: 'conflict', detail: '文件已存在, 追加 overwrite=1 可覆盖' })
    return null
  }
  const tmp = path.join(dirReal, `.${name}.dsh-remote-part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  let stream
  try {
    stream = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 })
  } catch (err) {
    fsJson(res, 403, { error: 'permission-denied', detail: err.message })
    return null
  }
  return { stream, tmp, target, displayPath: path.join(dirLex, name), name, overwrite, bytes: 0 }
}

/** 上传管道: 计数限量, 成功后 rename(先写 .part 再原子落位)。 */
function fsUploadPipe(res, url, dirLex, dirReal, name) {
  const up = fsOpenUploadTarget(res, url, dirLex, dirReal, name)
  return up ? fsUploadPipeFromTarget(res, up) : null
}

function fsUploadPipeFromTarget(res, up) {
  let finished = false
  const cleanup = () => {
    if (finished) return
    finished = true
    try { up.stream.destroy() } catch {}
    try { fs.unlinkSync(up.tmp) } catch {}
  }
  up.stream.on('error', () => {
    if (finished) return
    finished = true
    try { fs.unlinkSync(up.tmp) } catch {}
    if (!res.headersSent) fsJson(res, 500, { error: 'write-failed' })
    else try { res.destroy() } catch {}
  })
  return {
    write(chunk) {
      if (finished) return
      up.bytes += chunk.length
      if (up.bytes > FS_MAX_UPLOAD) {
        cleanup()
        if (!res.headersSent) fsJson(res, 413, { error: 'too-large', limit: FS_MAX_UPLOAD })
        else try { res.destroy() } catch {}
        return
      }
      up.stream.write(chunk)
    },
    end() {
      if (finished) return
      finished = true
      up.stream.end(() => {
        try {
          if (up.overwrite) fs.rmSync(up.target, { force: true })
          fs.renameSync(up.tmp, up.target)
        } catch (err) {
          try { fs.unlinkSync(up.tmp) } catch {}
          if (!res.headersSent) return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
          return
        }
        fsJson(res, 201, { ok: true, path: up.displayPath, name: up.name, size: up.bytes })
      })
    },
    abort(status, msg) {
      cleanup()
      if (!res.headersSent) fsJson(res, status, { error: msg })
      else try { res.destroy() } catch {}
    }
  }
}

function fsUploadRaw(req, res, url, dirLex, dirReal) {
  const name = url.searchParams.get('name') || ''
  const pipe = fsUploadPipe(res, url, dirLex, dirReal, name)
  if (!pipe) return
  req.on('aborted', () => pipe.abort(400, 'client-aborted'))
  req.on('error', () => pipe.abort(400, 'client-aborted'))
  req.on('data', (chunk) => pipe.write(chunk))
  req.on('end', () => pipe.end())
}

/** 零依赖流式 multipart 解析: 只取第一个文件部分, 2GB 也不会整块进内存。 */
function fsUploadMultipart(req, res, url, dirLex, dirReal, boundary) {
  const queryName = url.searchParams.get('name') || ''
  const marker = Buffer.from('\r\n--' + boundary)
  let head = Buffer.alloc(0)
  let tail = Buffer.alloc(0)
  let state = 'headers' // headers -> data -> done
  let pipe = null

  const fail = (status, msg) => {
    if (pipe) pipe.abort(status, msg)
    else if (!res.headersSent) fsJson(res, status, { error: msg })
  }

  const process = (buf) => {
    if (state === 'done') return
    if (state === 'headers') {
      head = Buffer.concat([head, buf])
      if (head.length > 64 * 1024) return fail(400, 'multipart-headers-too-large')
      const idx = head.indexOf('\r\n\r\n')
      if (idx === -1) return
      const headerText = head.slice(0, idx).toString('utf8')
      let partName = queryName
      if (!partName) {
        const m = /filename="([^"]*)"/i.exec(headerText)
        partName = m ? path.basename(String(m[1]).replace(/\\/g, '/')) : ''
      }
      if (!fsValidName(partName)) return fail(400, 'bad-name')
      pipe = fsUploadPipe(res, url, dirLex, dirReal, partName)
      if (!pipe) { state = 'done'; return }
      const rest = head.slice(idx + 4)
      head = null
      state = 'data'
      if (rest.length) process(rest)
      return
    }
    // data: 滑动窗口找 \r\n--boundary, 未命中时保留尾部防跨 chunk 边界
    buf = Buffer.concat([tail, buf])
    const idx = buf.indexOf(marker)
    if (idx === -1) {
      const keep = Math.min(buf.length, marker.length - 1)
      if (buf.length > keep) pipe.write(buf.slice(0, buf.length - keep))
      tail = buf.slice(buf.length - keep)
      return
    }
    if (idx > 0) pipe.write(buf.slice(0, idx))
    state = 'done'
    pipe.end()
  }

  req.on('aborted', () => { if (pipe) pipe.abort(400, 'client-aborted') })
  req.on('error', () => { if (pipe) pipe.abort(400, 'client-aborted') })
  req.on('data', (chunk) => process(chunk))
  req.on('end', () => {
    if (state === 'headers') return fail(400, 'no-file-part')
    if (state === 'data' && pipe) {
      if (tail.length) pipe.write(tail)
      pipe.end()
    }
  })
}

/* ---------- /fs/upload 断点续传 ----------
 * 分块模式: POST /fs/upload?path=..&name=..&session=<uuid>&offset=N[&finish=1][&overwrite=1]
 *   - 每一块是 raw body, 服务端写到 .<name>.dsh-remote-part-<session> 的 offset 处
 *   - offset=0 重开; offset<已有大小 = 回卷重写; offset>已有大小 = 409 offset-mismatch
 *   - finish=1 时原子 rename 到目标名; 否则返回 {partial:true,size,offset}
 * 查询进度: GET /fs/upload-probe?path=..&name=..&session=<uuid>
 */
function fsPartPath(dirReal, name, session) {
  const s = String(session || 'default').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'default'
  return path.join(dirReal, `.${name}.dsh-remote-part-${s}`)
}

function fsTargetState(target) {
  try {
    const st = fs.lstatSync(target)
    if (st.isSymbolicLink()) return { status: 403, error: 'symlink-forbidden', detail: '拒绝覆盖符号链接' }
    return { exists: true }
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false }
    return { status: 403, error: 'permission-denied', detail: err.message }
  }
}

function fsUploadProbe(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  touchDevice(req)
  const resolved = fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })
  const name = url.searchParams.get('name') || ''
  if (!fsValidName(name)) return fsJson(res, 400, { error: 'bad-name' })
  const part = fsPartPath(checked.abs, name, url.searchParams.get('session') || 'default')
  let partialSize = 0, partExists = false
  try {
    const st = fs.statSync(part)
    if (st.isFile()) { partialSize = st.size; partExists = true }
  } catch {}
  const target = fsTargetState(path.join(checked.abs, name))
  let targetSize = 0
  if (target.exists) {
    try { targetSize = fs.statSync(path.join(checked.abs, name)).size } catch {}
  }
  fsJson(res, 200, {
    ok: true,
    name,
    partialSize,
    partExists,
    targetExists: !!target.exists,
    targetSize
  })
}

function fsUploadResumable(req, res, url, dirLex, dirReal) {
  const name = url.searchParams.get('name') || ''
  if (!fsValidName(name)) return fsJson(res, 400, { error: 'bad-name', detail: '文件名不能为空且不能包含路径分隔符' })
  const session = url.searchParams.get('session') || ''
  if (!session) return fsJson(res, 400, { error: 'missing-session', detail: '断点续传需要 session 参数' })
  const offsetRaw = url.searchParams.get('offset')
  const offset = Number(offsetRaw)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return fsJson(res, 400, { error: 'bad-offset', detail: 'offset 必须是非负整数' })
  }
  const finish = url.searchParams.get('finish') === '1' || url.searchParams.get('complete') === '1'
  const overwrite = url.searchParams.get('overwrite') === '1' || url.searchParams.get('overwrite') === 'true'
  const sha256Expected = (url.searchParams.get('sha256') || '').trim().toLowerCase()
  if (sha256Expected && !/^[0-9a-f]{64}$/.test(sha256Expected)) {
    return fsJson(res, 400, { error: 'bad-sha256', detail: 'sha256 必须是 64 位十六进制' })
  }
  const part = fsPartPath(dirReal, name, session)
  const target = path.join(dirReal, name)

  // 已有分片尺寸对齐: 回卷重写允许, 越界/缺洞拒绝
  let existing = 0
  try {
    const st = fs.statSync(part)
    if (!st.isFile()) return fsJson(res, 409, { error: 'part-conflict', detail: '分片路径被占用' })
    existing = st.size
  } catch (err) {
    if (err.code !== 'ENOENT') return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
  }
  if (offset === 0) {
    try { if (existing > 0) fs.truncateSync(part, 0) } catch (err) {
      return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
    }
  } else {
    if (offset > existing) return fsJson(res, 409, { error: 'offset-mismatch', partialSize: existing, detail: 'offset 超过已有分片大小, 请先 probe' })
    if (offset < existing) {
      try { fs.truncateSync(part, offset) } catch (err) {
        return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
      }
    }
  }

  if (finish) {
    const st = fsTargetState(target)
    if (st.status) return fsJson(res, st.status, { error: st.error, detail: st.detail })
    if (st.exists && !overwrite) {
      return fsJson(res, 409, { error: 'conflict', detail: '文件已存在, overwrite=1 可覆盖' })
    }
  }

  let stream
  try {
    stream = fs.createWriteStream(part, { flags: offset === 0 ? 'w' : 'r+', start: offset, mode: 0o600 })
  } catch (err) {
    return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
  }
  const activeKey = fsActiveKey(dirReal, name, session)
  activeUploads.set(activeKey, stream)

  let bytes = 0
  let finished = false
  const abort = (status, msg, extra = {}) => {
    if (finished) return
    finished = true
    activeUploads.delete(activeKey)
    try { stream.destroy() } catch {}
    // 网络中断时保留分片, 客户端 probe 后续传; 只有超限/写失败才删
    if (status === 413 || status === 500) { try { fs.unlinkSync(part) } catch {} }
    if (!res.headersSent) fsJson(res, status, { error: msg, ...extra })
    else try { res.destroy() } catch {}
  }

  stream.on('error', (err) => {
    abort(500, err.code === 'ENOENT' ? 'part-missing' : 'write-failed', { detail: err.message })
  })
  req.on('aborted', () => abort(400, 'client-aborted', { partialSize: offset + bytes }))
  req.on('error', () => abort(400, 'client-aborted', { partialSize: offset + bytes }))
  req.on('data', (chunk) => {
    if (finished) return
    bytes += chunk.length
    if (offset + bytes > FS_MAX_UPLOAD) {
      abort(413, 'too-large', { limit: FS_MAX_UPLOAD })
      return
    }
    stream.write(chunk)
  })
  req.on('end', () => {
    if (finished) return
    finished = true
    stream.end(() => {
      activeUploads.delete(activeKey)
      const total = offset + bytes
      try {
        const st = fs.statSync(part)
        if (!st.isFile() || st.size !== total) throw new Error('part-size-mismatch')
        if (!finish) {
          fsJson(res, 200, { ok: true, partial: true, name, size: total, offset: total, session })
          return
        }
        const commit = (actualSha256) => {
          try {
            const ts = fsTargetState(target)
            if (ts.status) return fsJson(res, ts.status, { error: ts.error, detail: ts.detail })
            if (ts.exists && !overwrite) return fsJson(res, 409, { error: 'conflict', detail: '文件已存在, overwrite=1 可覆盖' })
            if (ts.exists) fs.rmSync(target, { force: true })
            fs.renameSync(part, target)
            fsJson(res, 201, { ok: true, name, path: path.join(dirLex, name), size: total, resumed: offset > 0, session, ...(actualSha256 ? { sha256: actualSha256 } : {}) })
          } catch (err) {
            if (!res.headersSent) fsJson(res, 403, { error: 'write-failed', detail: err.message })
            else try { res.destroy() } catch {}
          }
        }
        if (sha256Expected) {
          // 落盘前校验: 不匹配保留分片并返回 422, 客户端可重传或取消
          sha256FileHex(part, (err, actual) => {
            if (err) return fsJson(res, 403, { error: 'checksum-failed', detail: err.message })
            if (actual !== sha256Expected) {
              return fsJson(res, 422, { error: 'checksum-mismatch', expected: sha256Expected, actual, partialSize: total, session })
            }
            commit(actual)
          })
        } else {
          commit(null)
        }
      } catch (err) {
        if (!res.headersSent) fsJson(res, 403, { error: 'write-failed', detail: err.message })
        else try { res.destroy() } catch {}
      }
    })
  })
}

/* POST /fs/upload-control?path&name&session&action=cancel
 * 取消续传: 停止在途写流并删除分片(暂停由客户端 abort 完成, 分片保留)。 */
function fsUploadControl(req, res, url) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  touchDevice(req)
  const resolved = fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })
  const name = url.searchParams.get('name') || ''
  if (!fsValidName(name)) return fsJson(res, 400, { error: 'bad-name' })
  const session = url.searchParams.get('session') || 'default'
  const action = url.searchParams.get('action') || ''
  if (action !== 'cancel' && action !== 'abort') return fsJson(res, 400, { error: 'bad-action', detail: 'action 只支持 cancel' })

  const part = fsPartPath(checked.abs, name, session)
  const active = activeUploads.get(fsActiveKey(checked.abs, name, session))
  if (active) {
    try { active.destroy() } catch {}
    activeUploads.delete(fsActiveKey(checked.abs, name, session))
  }
  // 等写流关闭后再删, 防止 write 把分片重新创建出来
  setTimeout(() => {
    let removed = false
    try { fs.unlinkSync(part); removed = true } catch (err) {
      if (err.code !== 'ENOENT') return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
    }
    fsJson(res, 200, { ok: true, cancelled: true, removed, session })
  }, 80)
}

function serveFs(req, res, url) {
  const sub = url.pathname.slice('/fs'.length)

  // 跨域预检: 浏览器控制台可能从 DSH /remote 页访问网关(Authorization 非简单头)
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }

  if (sub === '/list') return fsList(req, res, url)
  if (sub === '/file') return fsFile(req, res, url)
  if (sub === '/upload-probe') return fsUploadProbe(req, res, url)
  if (sub === '/upload-control') return fsUploadControl(req, res, url)

  if (sub === '/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!fsAuthorized(req, url, res)) return
    touchDevice(req)
    const resolved = fsResolve(url.searchParams.get('path') ?? '')
    if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
    const checked = fsRealChecked(resolved.abs)
    if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })
    try {
      const st = fs.statSync(checked.abs)
      if (!st.isDirectory()) return fsJson(res, 400, { error: 'not-a-directory' })
    } catch (err) {
      return fsJson(res, err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' })
    }
    const contentLength = Number(req.headers['content-length'])
    if (Number.isFinite(contentLength) && contentLength > FS_MAX_UPLOAD) {
      return fsJson(res, 413, { error: 'too-large', limit: FS_MAX_UPLOAD })
    }
    // 带 session/offset 进入分块续传模式; 不带则保持 raw/multipart 一次性上传
    if (url.searchParams.has('session') || url.searchParams.has('offset')) {
      return fsUploadResumable(req, res, url, resolved.abs, checked.abs)
    }
    const contentType = String(req.headers['content-type'] || '')
    if (contentType.startsWith('multipart/form-data')) {
      const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
      const boundary = (m ? (m[1] || m[2]) : '').trim()
      if (!boundary) return fsJson(res, 400, { error: 'bad-multipart', detail: '缺少 boundary' })
      return fsUploadMultipart(req, res, url, resolved.abs, checked.abs, boundary)
    }
    return fsUploadRaw(req, res, url, resolved.abs, checked.abs)
  }

  fsJson(res, 404, { error: 'not-found' })
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
    if (url.pathname === '/fs' || url.pathname.startsWith('/fs/')) return serveFs(req, res, url)
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
