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
 *   DSH_REMOTE_FS_ROOT       文件传输允许根, 默认 ~, 使用系统路径分隔符配置多根
 *   DSH_REMOTE_FS_MAX_UPLOAD 上传字节上限, 默认 2147483648 (2GB)
 *   DSH_REMOTE_WORKBENCH     工作台绑定文件, 默认 ~/.dsh-remote/workbench.json
 */
'use strict'

const http = require('node:http')
const https = require('node:https')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

let statsCore = null
let statsStore = null
try {
  statsCore = require('./gateway-stats.cjs')
  statsStore = new statsCore.StatsStore()
} catch (err) {
  console.warn('[stats] 统计模块初始化失败, 统计 API 将不可用: ' + (err?.message || err))
}

const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '0.0.0.0'

function durationEnv(name, fallback, min, max) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

// 远程/VPN 用户的 RTT 和短暂抖动明显高于同机连接，默认使用 30s Ping、90s
// Pong 等待；关闭心跳时才退回到可选的硬空闲超时。0 是明确的禁用值。
const WS_PING_MS = durationEnv('GATEWAY_WS_PING_MS', 30000, 0, 10 * 60 * 1000)
const WS_PONG_TIMEOUT_MS = durationEnv('GATEWAY_WS_PONG_TIMEOUT_MS', 90000, 1000, 15 * 60 * 1000)
const WS_IDLE_MS = durationEnv('GATEWAY_WS_IDLE_MS', 180000, 0, 24 * 60 * 60 * 1000)
const WS_UPGRADE_TIMEOUT_MS = durationEnv('GATEWAY_WS_UPGRADE_TIMEOUT_MS', 15000, 1000, 5 * 60 * 1000)
const UPSTREAM_REQUEST_TIMEOUT_MS = durationEnv('GATEWAY_UPSTREAM_TIMEOUT_MS', 30000, 1000, 10 * 60 * 1000)
const UPSTREAM = new URL(process.env.DSH_UPSTREAM || 'http://127.0.0.1:3080')
const UPSTREAM_TRANSPORT = UPSTREAM.protocol === 'https:' ? https : http
const UPSTREAM_PORT = Number(UPSTREAM.port) || (UPSTREAM.protocol === 'https:' ? 443 : 80)
const UPSTREAM_AUTHORITY = `${UPSTREAM.hostname}${UPSTREAM.port ? ':' + UPSTREAM.port : ''}`
const DSH_HEALTH_PATH = String(process.env.DSH_HEALTH_PATH || '/').startsWith('/')
  ? String(process.env.DSH_HEALTH_PATH || '/')
  : '/' + String(process.env.DSH_HEALTH_PATH)
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(os.homedir(), '.dsh-remote', 'token')
const NOTES_FILE = process.env.DSH_REMOTE_NOTES || path.join(os.homedir(), '.dsh-remote', 'device-notes.json')
const WORKBENCH_FILE = process.env.DSH_REMOTE_WORKBENCH || path.join(os.homedir(), '.dsh-remote', 'workbench.json')
const STARTED_AT = Date.now()
const DSH_SERVICE = String(process.env.DSH_REMOTE_DSH_SERVICE || 'dsh-web').trim()
const HTTP_REQUEST_TIMEOUT_MS = durationEnv('GATEWAY_HTTP_REQUEST_TIMEOUT_MS', 15 * 60 * 1000, 0, 24 * 60 * 60 * 1000)
const HTTP_HEADERS_TIMEOUT_MS = durationEnv('GATEWAY_HTTP_HEADERS_TIMEOUT_MS', 120000, 1000, 10 * 60 * 1000)
const HTTP_KEEPALIVE_TIMEOUT_MS = durationEnv('GATEWAY_HTTP_KEEPALIVE_TIMEOUT_MS', 65000, 1000, 10 * 60 * 1000)

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
// 允许访问的根目录: DSH_REMOTE_FS_ROOT 使用系统路径分隔符分隔多个根,
// POSIX 为 ':'、Windows 为 ';'；默认仅 ~。
// 所有 /fs/* 路径 resolve 后都必须位于某个根内, 已存在的路径还会用 realpath
// 复核一次, 防止 ../ 穿越与符号链接逃逸。
const FS_DEFAULT_ROOT = path.resolve(os.homedir())
const FS_ROOTS = (process.env.DSH_REMOTE_FS_ROOT || FS_DEFAULT_ROOT)
  .split(path.delimiter)
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
const WS_TICKET_TTL_MS = durationEnv('GATEWAY_WS_TICKET_TTL_MS', 90000, 10000, 10 * 60 * 1000)
const wsTickets = new Map()

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
  wsTickets.clear()
  return { ok: true, token: next }
}

function tokenOf(req, url) {
  const auth = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m) return m[1]
  return url.searchParams.get('token')
}

function authorized(req, url, options = {}) {
  if (tokenOf(req, url) === TOKEN) return true
  if (options.consumeTicket) {
    const ticket = url.searchParams.get('ticket')
    const record = ticket && wsTickets.get(ticket)
    if (record && record.expiresAt > Date.now()) {
      record.uses--
      if (record.uses <= 0) wsTickets.delete(ticket)
      return true
    }
    if (ticket) wsTickets.delete(ticket)
  }
  return false
}

function issueWsTicket() {
  const now = Date.now()
  for (const [ticket, record] of wsTickets) {
    if (record.expiresAt <= now) wsTickets.delete(ticket)
  }
  const ticket = crypto.randomBytes(24).toString('base64url')
  wsTickets.set(ticket, { expiresAt: now + WS_TICKET_TTL_MS, uses: 4 })
  return { ticket, expiresAt: now + WS_TICKET_TTL_MS }
}

// ---------- 设备监控 ----------
const devices = new Map()   // ip -> device
// 设备 TTL 是“记录保留时间”，和下方 online 判断的 60s 活跃窗口是两回事：
// online 只看最近 60s 是否有请求；TTL 用于防止长期运行的网关内存/响应无限膨胀。
const DEVICE_TTL_MS = 24 * 60 * 60 * 1000
let totalRequests = 0
let authFailures = 0
const runtimeState = {
  uncaughtExceptions: 0,
  unhandledRejections: 0,
  lastErrorAt: 0,
  lastError: '',
}

function pruneDevices(now = Date.now()) {
  for (const [ip, d] of devices) {
    if (now - d.lastSeen > DEVICE_TTL_MS) devices.delete(ip)
  }
}

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
  pruneDevices()
  const ip = ipOf(req)
  const clientId = String(extra.clientId || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 96)
  const deviceKey = clientId ? `${ip}|${clientId}` : ip
  totalRequests++
  let d = devices.get(deviceKey)
  if (!d) {
    d = {
      id: deviceKey, ip, clientId, kind: kindOf(req), ua: '', firstSeen: Date.now(), lastSeen: 0,
      requests: 0, authFailures: 0, channels: {}, channelCounts: {}, sockets: new Set()
    }
    devices.set(deviceKey, d)
  }
  d.lastSeen = Date.now()
  d.requests++
  if (extra.channel) {
    d.channelCounts[extra.channel] = (d.channelCounts[extra.channel] || 0) + 1
    d.channels[extra.channel] = true
  }
  if (extra.closeChannel) {
    const count = Math.max(0, (d.channelCounts[extra.closeChannel] || 1) - 1)
    d.channelCounts[extra.closeChannel] = count
    d.channels[extra.closeChannel] = count > 0
  }
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
      id: d.id,
      clientId: d.clientId || '',
      note: deviceNotes[d.ip] || '',
      kind: d.kind,
      ua: d.ua,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      requests: d.requests,
      authFailures: d.authFailures,
      channels: { ...d.channels },
      channelCounts: { ...d.channelCounts },
      online: Date.now() - d.lastSeen < 60_000
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}

function kickDevice(ip) {
  const targets = [...devices.values()].filter(d => d.id === ip || d.ip === ip)
  if (!targets.length) return 0
  let n = 0
  for (const d of targets) {
    for (const sock of d.sockets) {
      try { sock.destroy() } catch {}
      n++
    }
    d.sockets.clear()
    d.channels = {}
    d.channelCounts = {}
  }
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
    (isHttps
      ? (process.env.HTTPS_PROXY || process.env.https_proxy)
      : (process.env.HTTP_PROXY || process.env.http_proxy)) || ''
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
const CORS_ORIGINS = new Set(String(process.env.DSH_REMOTE_CORS_ORIGINS || '')
  .split(',').map(v => v.trim()).filter(Boolean))
const BUILTIN_CORS_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
])

function cors(res, req = res.req) {
  const origin = String(req?.headers?.origin || '').trim()
  let allowed = !origin
  if (origin) {
    allowed = CORS_ORIGINS.has('*') || CORS_ORIGINS.has(origin) || BUILTIN_CORS_ORIGINS.has(origin)
    if (!allowed) {
      try {
        const originUrl = new URL(origin)
        const requestHost = String(req?.headers?.host || '').toLowerCase()
        const localhostApp = ['http:', 'https:', 'capacitor:', 'ionic:'].includes(originUrl.protocol) && originUrl.hostname === 'localhost'
        allowed = localhostApp || ((originUrl.protocol === 'http:' || originUrl.protocol === 'https:') && originUrl.host.toLowerCase() === requestHost)
      } catch {}
    }
  }
  if (allowed) res.setHeader('access-control-allow-origin', origin || '*')
  res.setHeader('vary', 'Origin')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-dsh-remote-client')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-max-age', '600')
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

function execFileResult(file, args, timeout = 5000) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      })
    })
  })
}

async function dshServiceStatus() {
  if (process.platform === 'win32') {
    return { ok: true, supported: false, running: false, service: DSH_SERVICE, message: 'Windows 请配置 DSH_REMOTE_DSH_SERVICE 后接入任务计划程序' }
  }
  if (!/^[A-Za-z0-9_.@-]+$/.test(DSH_SERVICE)) {
    return { ok: false, supported: false, running: false, service: DSH_SERVICE, message: '服务名配置不合法' }
  }
  const r = await execFileResult('systemctl', ['--user', 'is-active', DSH_SERVICE], 3000)
  return { ok: true, supported: true, running: r.stdout === 'active', service: DSH_SERVICE, state: r.stdout || 'unknown', detail: r.stderr || '' }
}

async function serveDshControl(req, res, url) {
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }
  if (!authorized(req, url)) {
    authFailures++
    touchDevice(req, { failedAuth: true })
    cors(res)
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  touchDevice(req, { kind: 'admin' })
  if (req.method === 'GET') {
    cors(res)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(await dshServiceStatus()))
    return
  }
  if (req.method !== 'POST') {
    cors(res)
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  let body = {}
  try { body = JSON.parse((await readBody(req, 4096)) || '{}') } catch {}
  const action = body?.action
  if (action !== 'start' && action !== 'restart') {
    cors(res)
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'action 必须是 start 或 restart' }))
    return
  }
  if (process.platform === 'win32' || !/^[A-Za-z0-9_.@-]+$/.test(DSH_SERVICE)) {
    cors(res)
    res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, supported: false, error: '当前系统未配置可控的 dsh-web 服务', service: DSH_SERVICE }))
    return
  }
  const r = await execFileResult('systemctl', ['--user', action, DSH_SERVICE], 10000)
  const status = await dshServiceStatus()
  cors(res)
  res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ...status, ok: r.ok, action, detail: r.stderr || r.stdout || '' }))
}

// ---------- 事件轮询缓冲 ----------
// 网关每个通道只维护一条到 DSH 的 mux/host WebSocket，同时把事件写入
// 内存环形缓冲并广播给已认证客户端；前端在 WebSocket 被隧道/受限网络
// 阻断时改走 GET /api/events.poll 增量拉取。
const EVENT_BUFFER_MAX = durationEnv('GATEWAY_EVENT_BUFFER_MAX', 1000, 100, 10000)
const EVENT_MAX_STRING = 16 * 1024
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const eventBuffers = { mux: [], host: [] }
const eventNextSeq = { mux: 1, host: 1 }
const collectorClients = { mux: new Set(), host: new Set() }
const collectorReplay = { mux: new Map(), host: new Map() }
const eventCollectorState = {
  mux: { connected: false, lastEventAt: 0, lastConnectAt: 0, reconnects: 0, lastError: '', lastCloseCode: 0, lastCloseReason: '', attempt: 0, clients: 0, framesBroadcast: 0, lastBroadcastAt: 0 },
  host: { connected: false, lastEventAt: 0, lastConnectAt: 0, reconnects: 0, lastError: '', lastCloseCode: 0, lastCloseReason: '', attempt: 0, clients: 0, framesBroadcast: 0, lastBroadcastAt: 0 },
}

/** 递归截断超大字段，避免单条超大事件撑爆环形缓冲。 */
function truncateEventValue(v, depth = 0) {
  if (typeof v === 'string') return v.length > EVENT_MAX_STRING ? v.slice(0, EVENT_MAX_STRING) + '…[truncated]' : v
  if (Array.isArray(v)) {
    if (depth > 3 || v.length > 200) return v.slice(0, 200)
    return v.map(x => truncateEventValue(x, depth + 1))
  }
  if (v && typeof v === 'object' && depth <= 3) {
    const out = {}
    for (const k of Object.keys(v)) out[k] = truncateEventValue(v[k], depth + 1)
    return out
  }
  return v
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key || '') + WS_GUID).digest('base64')
}

function encodeWsText(text) {
  const payload = Buffer.from(String(text), 'utf8')
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  if (payload.length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

function rememberCollectorReplay(kind, full, raw) {
  const payload = full?.payload
  if (!payload || typeof payload !== 'object') return
  const replay = collectorReplay[kind]
  let key = ''
  if (payload.type === 'session/subscribed' && payload.sessionId) key = `session:${payload.sessionId}`
  else if (payload.type === 'approval/requested' && payload.approvalId) key = `approval:${payload.approvalId}`
  else if (payload.type === 'question/requested' && full.rpcId) key = `question:${full.rpcId}`
  else if (payload.type === 'approval/resolved' && payload.approvalId) replay.delete(`approval:${payload.approvalId}`)
  else if (payload.type === 'question/resolved' && payload.questionRpcId) replay.delete(`question:${payload.questionRpcId}`)
  else if (payload.type === 'host/session-removed' && payload.sessionId) replay.delete(`session:${payload.sessionId}`)
  if (!key) return
  replay.delete(key)
  replay.set(key, raw)
  while (replay.size > 500) replay.delete(replay.keys().next().value)
}

function broadcastCollectorFrame(kind, raw) {
  const state = eventCollectorState[kind]
  const frame = encodeWsText(raw)
  for (const socket of collectorClients[kind]) {
    if (socket.destroyed || !socket.writable) {
      collectorClients[kind].delete(socket)
      continue
    }
    try { socket.write(frame) } catch { try { socket.destroy() } catch {} }
  }
  state.clients = collectorClients[kind].size
  state.framesBroadcast++
  state.lastBroadcastAt = Date.now()
}

function pushEvent(kind, full, raw = JSON.stringify(full)) {
  if (!eventBuffers[kind] || !full || typeof full !== 'object') return
  if (eventCollectorState[kind]) eventCollectorState[kind].lastEventAt = Date.now()
  const buf = eventBuffers[kind]
  buf.push({ seq: eventNextSeq[kind]++, ts: Date.now(), event: truncateEventValue(full) })
  if (buf.length > EVENT_BUFFER_MAX) buf.shift()
  rememberCollectorReplay(kind, full, raw)
  broadcastCollectorFrame(kind, raw)
}

function serveWsTicket(req, res, url) {
  if (req.method === 'OPTIONS') {
    cors(res, req)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  if (!authorized(req, url)) {
    authFailures++
    touchDevice(req, { failedAuth: true })
    cors(res, req)
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  cors(res, req)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ok: true, ...issueWsTicket() }))
}

function serveEventPoll(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!authorized(req, url)) {
    authFailures++
    touchDevice(req, { failedAuth: true })
    cors(res)
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  touchDevice(req)
  const kind = url.searchParams.get('kind')
  if (kind !== 'mux' && kind !== 'host') {
    cors(res)
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'bad-kind', detail: 'kind 必须是 mux 或 host' }))
    return
  }
  const sinceRaw = url.searchParams.get('since')
  const since = sinceRaw === null ? 0 : Number(sinceRaw)
  if (!Number.isSafeInteger(since) || since < 0) {
    cors(res)
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'bad-since', detail: 'since 必须是非负整数' }))
    return
  }
  const buf = eventBuffers[kind]
  const events = buf.filter(r => r.seq > since)
  const latestSeq = buf.length ? buf[buf.length - 1].seq : 0
  const truncated = buf.length > 0 && since < buf[0].seq - 1
  cors(res)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify({ ok: true, kind, since, latestSeq, truncated, events }))
}

/** 网关自带上游事件采集：mux/host 各一条 WS，断线自动重连。 */
function startEventCollector(kind) {
  if (typeof WebSocket !== 'function') return null
  const state = eventCollectorState[kind]
  let ws = null
  let stopped = false
  let retryTimer = null
  let connectTimer = null
  const scheme = UPSTREAM.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${UPSTREAM_AUTHORITY}/api/events.${kind}?client=web`
  const schedule = () => {
    if (stopped || retryTimer) return
    const attempt = state.attempt++
    const base = Math.min(1500 * Math.pow(2, attempt), 60000)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    retryTimer = setTimeout(() => { retryTimer = null; connect() }, delay)
    retryTimer.unref?.()
  }
  const connect = () => {
    if (stopped) return
    try {
      ws = new WebSocket(url)
    } catch (err) {
      state.lastError = String(err?.message || err)
      schedule()
      return
    }
    const current = ws
    connectTimer = setTimeout(() => {
      if (ws === current && current.readyState === 0) {
        state.lastError = 'websocket connect timeout'
        try { current.close() } catch {}
      }
    }, WS_UPGRADE_TIMEOUT_MS)
    connectTimer.unref?.()
    ws.onopen = () => {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
      if (state) {
        state.connected = true
        state.lastConnectAt = Date.now()
        state.lastError = ''
        state.attempt = 0
      }
      if (stopped) { try { ws.close() } catch {} }
    }
    ws.onmessage = (ev) => {
      if (stopped) return
      try {
        const data = typeof ev.data === 'string' ? ev.data : Buffer.isBuffer(ev.data) ? ev.data.toString() : String(ev.data)
        pushEvent(kind, JSON.parse(data), data)
      } catch {}
    }
    ws.onclose = () => {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
      if (state) {
        state.connected = false
        state.reconnects++
        state.lastCloseCode = Number(current?.closeCode) || 0
        state.lastCloseReason = String(current?.closeReason || '')
      }
      ws = null
      schedule()
    }
    ws.onerror = (err) => {
      if (state) state.lastError = String(err?.message || 'websocket error')
      try { current.close() } catch {}
    }
  }
  connect()
  return {
    kind,
    close() {
      stopped = true
      clearTimeout(retryTimer)
      clearTimeout(connectTimer)
      retryTimer = null
      connectTimer = null
      try { ws?.close() } catch {}
    }
  }
}

// ---------- 统计 API ----------
let statsScanning = false
async function scanStatsOnce(delay) {
  if (statsScanning || !statsStore) return
  statsScanning = true
  if (delay) await new Promise(r => setTimeout(r, delay))
  try {
    const out = await statsStore.scanAll()
    if (out.files) console.log(`[stats] 历史回填扫描完成: ${out.processed} 个新事件 (${out.files} 个会话文件)`)
  } catch (err) {
    console.warn('[stats] 历史回填扫描失败: ' + (err?.message || err))
  } finally {
    statsScanning = false
  }
}

function serveStats(req, res, url) {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (!statsStore) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'stats unavailable' }))
    return
  }
  if (!authorized(req, url)) {
    authFailures++
    touchDevice(req, { failedAuth: true })
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  touchDevice(req)
  const pathname = url.pathname

  if (pathname === '/stats/summary' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, days: statsStore.summary(url.searchParams.get('days')) }))
    return
  }

  if (pathname === '/stats/detail' && req.method === 'GET') {
    const date = url.searchParams.get('date') || statsCore.beijingDate(Date.now())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid date', expect: 'YYYY-MM-DD' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, ...statsStore.detail(date) }))
    return
  }

  if (pathname === '/stats/ingest' && req.method === 'POST') {
    let body = ''
    req.on('data', c => { body += c; if (body.length > 256 * 1024) req.destroy() })
    req.on('end', () => {
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid json' }))
        return
      }
      const sessionId = payload.sessionId
      const event = payload.event
      if (!sessionId || !event || typeof event !== 'object') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'sessionId 与 event 必填' }))
        return
      }
      // 统计是旁路能力，不能让同步落盘阻塞插件的实时事件链路；
      // 先确认已入队，具体聚合由 StatsStore 自己串行处理。
      setImmediate(() => {
        statsStore.ingestEvent(sessionId, event, payload.fallbackModel).then((out) => {
          if (out.gap) scanStatsOnce(3000)
        }).catch((err) => {
          console.warn('[stats] 实时事件落盘失败: ' + (err?.message || err))
        })
      })
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, queued: true }))
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'not found' }))
}

// ---------- 反馈提交 ----------
const feedbackThrottle = new Map()   // ip -> 上次受理时间戳
const FEEDBACK_WINDOW_MS = 60 * 1000
// 反馈收集器: 环境变量可覆盖, 默认 Tailscale 内网地址
const FEEDBACK_URL = process.env.DSH_REMOTE_FEEDBACK_URL || 'http://100.84.128.29/submit'

function maskIp(ip) {
  if (!ip) return 'unknown'
  const s = String(ip).replace(/^::ffff:/, '')
  if (s.includes(':')) {
    const groups = s.split(':').filter(Boolean)
    return (groups.slice(0, 2).join(':') || '::') + '::x'
  }
  const parts = s.split('.')
  if (parts.length === 4) return parts.slice(0, 3).join('.') + '.x'
  return s
}

function serveFeedback(req, res, url) {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  if (!authorized(req, url)) {
    authFailures++
    touchDevice(req, { failedAuth: true })
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  touchDevice(req)

  let body = ''
  req.on('data', c => { body += c; if (body.length > 16 * 1024) req.destroy() })
  req.on('end', () => {
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }
    const type = payload.type
    const message = String(payload.message || '').trim()
    const contact = String(payload.contact || '').trim()
    const appVersion = String(payload.appVersion || '').trim()
    if (!['bug', 'suggestion', 'other'].includes(type)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid type', expect: 'bug|suggestion|other' }))
      return
    }
    if (!message) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'message required' }))
      return
    }
    if (message.length > 2000) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'message too long', max: 2000 }))
      return
    }
    if (contact.length > 200) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'contact too long', max: 200 }))
      return
    }

    const ip = ipOf(req)
    const now = Date.now()
    const last = feedbackThrottle.get(ip) || 0
    if (now - last < FEEDBACK_WINDOW_MS) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(Math.ceil((FEEDBACK_WINDOW_MS - (now - last)) / 1000)) })
      res.end(JSON.stringify({ error: 'rate_limited', retryAfter: Math.ceil((FEEDBACK_WINDOW_MS - (now - last)) / 1000) }))
      return
    }

    // 转发收集器(收集器服务端已做校验/节流/落盘)。节流只在收集器确认成功后占位,
    // 失败(429/502/网络错误)不占位, 用户可立即重试。
    fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type,
        message,
        contact: contact || undefined,
        appVersion: appVersion || 'unknown',
        gatewayVersion: VERSION,
        clientIp: maskIp(ip)
      }),
      signal: AbortSignal.timeout(8000)
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}))
      if (r.status === 429) {
        res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'rate_limited' }))
      } else if (r.ok && data.ok) {
        feedbackThrottle.set(ip, now)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'upstream_error' }))
      }
    }).catch(() => {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'feedback_service_unavailable' }))
    })
  })
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
    const lastModified = st.mtime.toUTCString()
    const mtimeSec = Math.floor(st.mtime.getTime() / 1000) * 1000
    cors(res)
    const ims = req.headers['if-modified-since']
    if (ims && new Date(ims).getTime() >= mtimeSec) {
      res.writeHead(304, { 'last-modified': lastModified })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=300',
      'content-length': st.size,
      'last-modified': lastModified
    })
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(filePath).pipe(res)
  })
}

// ---------- 管理 API ----------
function upstreamReachable(cb) {
  const req = UPSTREAM_TRANSPORT.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM_PORT,
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
  if (sub === '/dsh') return serveDshControl(req, res, url)
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

/** POST /fs/mkdir?path=<parent>&name=<directory> 创建一个工作区目录。 */
function fsMkdir(req, res, url) {
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
    if (!fs.statSync(checked.abs).isDirectory()) return fsJson(res, 400, { error: 'not-a-directory' })
  } catch (err) {
    return fsJson(res, err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' })
  }

  const name = url.searchParams.get('name') || ''
  if (!fsValidName(name)) return fsJson(res, 400, { error: 'bad-name', detail: '目录名不能为空且不能包含路径分隔符' })
  const target = path.join(checked.abs, name)
  try {
    fs.mkdirSync(target)
  } catch (err) {
    if (err.code === 'EEXIST') return fsJson(res, 409, { error: 'exists' })
    return fsJson(res, ['EACCES', 'EPERM', 'EROFS'].includes(err.code) ? 403 : 400, { error: 'mkdir-failed', detail: err.message })
  }
  fsJson(res, 201, { ok: true, name, path: path.join(resolved.abs, name) })
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
  if (sub === '/mkdir') return fsMkdir(req, res, url)
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

// ---------- /workbench 工作台绑定 ----------
// 工作台绑定一个文件夹；其下的子文件夹由客户端映射为 DSH 项目工作区。
function workbenchPathInfo(rawPath) {
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) return { error: 'bad-path' }
  const abs = path.resolve(rawPath)
  let st
  try { st = fs.statSync(abs) } catch (err) {
    return { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' }
  }
  if (!st.isDirectory()) return { error: 'not-a-directory' }
  const checked = fsRealChecked(abs)
  if (checked.error) return { error: checked.error === 'forbidden' ? 'outside-roots' : checked.error }
  return { path: checked.abs }
}

function loadWorkbench() {
  try {
    const raw = JSON.parse(fs.readFileSync(WORKBENCH_FILE, 'utf8'))
    if (!raw || typeof raw.path !== 'string' || !raw.path) return null
    const checked = workbenchPathInfo(raw.path)
    return checked.path ? { path: checked.path } : null
  } catch {
    return null
  }
}

function saveWorkbench(binding) {
  try {
    fs.mkdirSync(path.dirname(WORKBENCH_FILE), { recursive: true })
    fs.writeFileSync(WORKBENCH_FILE, JSON.stringify(binding, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

function serveWorkbench(req, res, url) {
  const sub = url.pathname.slice('/workbench'.length)
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return

  if (sub === '' && req.method === 'GET') {
    const binding = loadWorkbench()
    fsJson(res, 200, {
      bound: !!binding,
      path: binding?.path || null,
      title: binding ? path.basename(binding.path) : null
    })
    return
  }

  if (sub === '/bind' && req.method === 'POST') {
    let body = ''
    let done = false
    const fail = (status, payload) => {
      if (done || res.headersSent) return
      done = true
      fsJson(res, status, payload)
    }
    req.on('data', chunk => {
      if (done) return
      body += chunk
      if (Buffer.byteLength(body) > 4096) {
        req.destroy()
        fail(413, { error: 'too-large' })
      }
    })
    req.on('error', () => { if (!done) done = true })
    req.on('end', () => {
      if (done) return
      try {
        const rawPath = JSON.parse(body || '{}')?.path
        const checked = workbenchPathInfo(rawPath)
        if (checked.error) {
          const status = checked.error === 'forbidden' ? 403 : 400
          fail(status, { error: checked.error, detail: checked.error === 'outside-roots' ? '绑定目录必须在文件传输允许根目录内' : undefined })
          return
        }
        if (!saveWorkbench({ path: checked.path })) {
          fail(500, { error: 'save-failed' })
          return
        }
        done = true
        fsJson(res, 200, { bound: true, path: checked.path, title: path.basename(checked.path) })
      } catch {
        fail(400, { error: 'bad-request' })
      }
    })
    return
  }

  if (sub === '/unbind' && req.method === 'POST') {
    try { fs.rmSync(WORKBENCH_FILE, { force: true }) } catch {}
    fsJson(res, 200, { bound: false })
    return
  }

  res.writeHead(405, { allow: 'GET, POST' })
  res.end()
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
  // /remote/* 由 DSH 插件端点处理；插件侧用网关自身 token 鉴权。
  if (url.pathname.startsWith('/remote/')) {
    headers.authorization = 'Bearer ' + TOKEN
  }

  let responseDone = false
  const upstreamReq = UPSTREAM_TRANSPORT.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM_PORT,
    method: req.method,
    path: url.pathname + url.search,
    headers
  }, (upstreamRes) => {
    const out = { ...upstreamRes.headers }
    delete out['content-length']
    cors(res)
    res.writeHead(upstreamRes.statusCode || 502, out)
    upstreamRes.on('error', (err) => {
      if (responseDone || res.destroyed) return
      responseDone = true
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'upstream-response-error', detail: String(err.message || err) }))
    })
    upstreamRes.pipe(res)
  })

  upstreamReq.setTimeout(UPSTREAM_REQUEST_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error('upstream request timeout'))
  })
  upstreamReq.on('error', (err) => {
    if (responseDone || res.destroyed) return
    responseDone = true
    cors(res)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'upstream-unreachable', detail: String(err.message || err) }))
  })

  req.on('error', () => { upstreamReq.destroy() })
  req.on('aborted', () => { upstreamReq.destroy() })
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy()
  })
  req.pipe(upstreamReq)
}

// ---------- 其它 ----------
async function serveHealth(res) {
  let upstreamOk = false
  let upstreamReachable = false
  let upstreamStatus = 0
  let upstreamError = ''
  let timer = null
  try {
    const ctrl = new AbortController()
    timer = setTimeout(() => ctrl.abort(), 5000)
    const probeUrl = new URL(DSH_HEALTH_PATH, UPSTREAM).toString()
    const probe = await fetch(probeUrl, { signal: ctrl.signal, cache: 'no-store' })
    upstreamReachable = true
    upstreamStatus = probe.status
    upstreamOk = probe.ok
  } catch (err) {
    upstreamError = String(err?.message || err || '')
  } finally {
    if (timer) clearTimeout(timer)
  }
  cors(res)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    ok: true,
    service: 'dsh-remote',
    version: VERSION,
    pid: process.pid,
    upstream: UPSTREAM.origin,
    upstreamProbe: DSH_HEALTH_PATH,
    upstreamOk,
    upstreamReachable,
    upstreamStatus,
    ...(upstreamError ? { upstreamError } : {}),
    events: eventCollectorState,
    runtime: runtimeState,
  }))
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
    if (url.pathname === '/workbench' || url.pathname.startsWith('/workbench/')) return serveWorkbench(req, res, url)
    if (url.pathname === '/feedback') return serveFeedback(req, res, url)
    if (url.pathname.startsWith('/admin/api')) return serveAdminApi(req, res, url)
    if (url.pathname.startsWith('/stats')) return serveStats(req, res, url)
    if (url.pathname === '/api/ws-ticket') return serveWsTicket(req, res, url)
    if (url.pathname === '/api/events.poll') return serveEventPoll(req, res, url)
    if (url.pathname.startsWith('/remote/')) return proxyApi(req, res, url)
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
// 长连接与 VPN 上传需要比 Node 默认值更宽松的请求窗口；WebSocket upgrade
// 完成后不受 HTTP requestTimeout 影响，升级握手另由 WS_UPGRADE_TIMEOUT_MS 管理。
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS
server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS
server.keepAliveTimeout = HTTP_KEEPALIVE_TIMEOUT_MS
server.timeout = 0

// 最后一层护栏: 任何未捕获异常只记录不退出(网关单点服务, 不能因单请求竞态离线)
process.on('uncaughtException', (err) => {
  runtimeState.uncaughtExceptions++
  runtimeState.lastErrorAt = Date.now()
  runtimeState.lastError = String(err?.message || err || 'uncaught exception')
  try { console.error('[uncaughtException]', err?.stack || String(err)) } catch {}
})
process.on('unhandledRejection', (err) => {
  runtimeState.unhandledRejections++
  runtimeState.lastErrorAt = Date.now()
  runtimeState.lastError = String(err?.message || err || 'unhandled rejection')
  try { console.error('[unhandledRejection]', err?.stack || String(err)) } catch {}
})

function wsPingFrame(masked) {
  if (!masked) return Buffer.from([0x89, 0x00])
  const mask = crypto.randomBytes(4)
  return Buffer.concat([Buffer.from([0x89, 0x80]), mask])
}

/**
 * 原始 TCP 透传也要维护 WebSocket 控制帧活性:
 * - 浏览器侧收到网关的未掩码 Ping 后会自动回 Pong;
 * - DSH 侧作为 WebSocket 服务端会自动回网关的掩码 Ping;
 * - 业务事件可以长时间静默, 不能再把“无业务数据”当作死连接。
 */
function startWsHeartbeat(clientSocket, upstreamSocket, destroyBoth) {
  let clientActivity = Date.now()
  let upstreamActivity = Date.now()
  let lastClientPing = 0
  let lastUpstreamPing = 0
  let timer = null

  const touchClient = () => { clientActivity = Date.now() }
  const touchUpstream = () => { upstreamActivity = Date.now() }
  clientSocket.on('data', touchClient)
  upstreamSocket.on('data', touchUpstream)

  const intervalMs = WS_PING_MS > 0
    ? Math.max(100, Math.min(Math.round(WS_PING_MS / 4), 5000))
    : WS_IDLE_MS > 0 ? Math.max(1000, Math.min(Math.round(WS_IDLE_MS / 4), 5000)) : 0
  if (intervalMs > 0) {
    timer = setInterval(() => {
      const now = Date.now()
      if (WS_PING_MS > 0) {
        if (now - clientActivity > WS_PONG_TIMEOUT_MS || now - upstreamActivity > WS_PONG_TIMEOUT_MS) {
          destroyBoth()
          return
        }
        if (now - lastClientPing >= WS_PING_MS && !clientSocket.destroyed) {
          clientSocket.write(wsPingFrame(false))
          lastClientPing = now
        }
        if (now - lastUpstreamPing >= WS_PING_MS && !upstreamSocket.destroyed) {
          upstreamSocket.write(wsPingFrame(true))
          lastUpstreamPing = now
        }
      } else if ((now - clientActivity > WS_IDLE_MS) || (now - upstreamActivity > WS_IDLE_MS)) {
        destroyBoth()
      }
    }, intervalMs)
    timer.unref?.()
  }

  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}

function startWsClientHeartbeat(socket, destroy) {
  let activity = Date.now()
  let lastPing = 0
  let timer = null
  socket.on('data', () => { activity = Date.now() })
  const intervalMs = WS_PING_MS > 0
    ? Math.max(100, Math.min(Math.round(WS_PING_MS / 4), 5000))
    : WS_IDLE_MS > 0 ? Math.max(1000, Math.min(Math.round(WS_IDLE_MS / 4), 5000)) : 0
  if (intervalMs > 0) {
    timer = setInterval(() => {
      const now = Date.now()
      if (WS_PING_MS > 0) {
        if (now - activity > WS_PONG_TIMEOUT_MS) {
          destroy()
          return
        }
        if (now - lastPing >= WS_PING_MS && !socket.destroyed) {
          socket.write(wsPingFrame(false))
          lastPing = now
        }
      } else if (now - activity > WS_IDLE_MS) {
        destroy()
      }
    }, intervalMs)
    timer.unref?.()
  }
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}

function acceptCollectorClient(req, socket, head, kind, device) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    if (device) {
      device.sockets.delete(socket)
      const count = Math.max(0, (device.channelCounts[kind] || 1) - 1)
      device.channelCounts[kind] = count
      device.channels[kind] = count > 0
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  )
  if (head?.length) socket.unshift(head)
  socket.setNoDelay(true)
  collectorClients[kind].add(socket)
  eventCollectorState[kind].clients = collectorClients[kind].size
  for (const raw of collectorReplay[kind].values()) {
    if (socket.destroyed || !socket.writable) break
    try { socket.write(encodeWsText(raw)) } catch { break }
  }
  const stopHeartbeat = startWsClientHeartbeat(socket, () => socket.destroy())
  const release = () => {
    stopHeartbeat()
    collectorClients[kind].delete(socket)
    eventCollectorState[kind].clients = collectorClients[kind].size
    if (device) {
      device.sockets.delete(socket)
      const count = Math.max(0, (device.channelCounts[kind] || 1) - 1)
      device.channelCounts[kind] = count
      device.channels[kind] = count > 0
    }
  }
  socket.once('close', release)
  socket.once('error', () => { try { socket.destroy() } catch {} })
}

function writeUpgradeFailure(socket, statusCode, statusMessage) {
  if (socket.destroyed || !socket.writable) return
  const text = `upstream websocket upgrade failed: ${statusCode} ${statusMessage || ''}`.trim()
  const body = Buffer.from(text + '\n')
  const headers =
    `HTTP/1.1 ${statusCode} ${statusMessage || 'Bad Gateway'}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n\r\n`
  socket.end(Buffer.concat([Buffer.from(headers), body]))
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://dsh-remote.local')
  if (!url.pathname.startsWith('/api/')) {
    socket.destroy()
    return
  }
  const ok = authorized(req, url, { consumeTicket: true })
  const channel = url.pathname.includes('events.mux') ? 'mux' : url.pathname.includes('events.host') ? 'host' : null
  const clientId = url.searchParams.get('clientId') || ''
  const deviceExtra = ok && channel ? { channel, clientId } : { failedAuth: !ok, clientId }
  const d = touchDevice(req, deviceExtra)
  if (!ok) {
    authFailures++
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    try { socket.destroy() } catch {}
    return
  }

  if (channel) {
    d.sockets.add(socket)
    acceptCollectorClient(req, socket, head, channel, d)
    return
  }

  if (d) d.sockets.add(socket)
  const release = () => {
    d.sockets.delete(socket)
    try { socket.destroy() } catch {}
  }
  socket.once('close', release)

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

  let upgraded = false
  let handshakeTimer = null
  const finishHandshake = () => {
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = null
  }
  const upstreamReq = UPSTREAM_TRANSPORT.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM_PORT,
    method: req.method,
    path: url.pathname + url.search,
    headers
  })
  socket.once('close', () => {
    finishHandshake()
    if (!upgraded) upstreamReq.destroy()
  })

  upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
    upgraded = true
    finishHandshake()
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
    const destroyBoth = () => {
      heartbeatStop()
      upSocket.destroy()
      socket.destroy()
    }
    const close = () => {
      heartbeatStop()
      upSocket.destroy()
      socket.destroy()
    }
    const heartbeatStop = startWsHeartbeat(socket, upSocket, destroyBoth)
    upSocket.on('error', close)
    socket.on('error', close)
    upSocket.on('close', () => { heartbeatStop(); if (!socket.destroyed) socket.end() })
    socket.on('close', () => { heartbeatStop(); if (!upSocket.destroyed) upSocket.end() })
  })

  upstreamReq.on('response', (upRes) => {
    finishHandshake()
    if (upgraded || socket.destroyed) { upRes.resume(); return }
    upRes.resume()
    writeUpgradeFailure(socket, upRes.statusCode || 502, upRes.statusMessage)
    socket.destroy()
  })

  upstreamReq.setTimeout(WS_UPGRADE_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error('websocket upgrade timeout'))
  })
  handshakeTimer = setTimeout(() => {
    upstreamReq.destroy(new Error('websocket upgrade timeout'))
  }, WS_UPGRADE_TIMEOUT_MS)
  handshakeTimer.unref?.()

  upstreamReq.on('error', (err) => {
    finishHandshake()
    if (!socket.destroyed) {
      writeUpgradeFailure(socket, 502, err?.message || 'Bad Gateway')
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
  // 事件轮询缓冲：网关自身上游 WS 采集，断线自动重连
  startEventCollector('mux')
  startEventCollector('host')
  // 启动 8 秒后首查, 之后每 6 小时查一次 GitHub/镜像最新版
  setTimeout(() => checkForUpdates(false), 8000)
  setInterval(() => checkForUpdates(false), UPDATE_INTERVAL_MS)
  // 统计回填: 启动 2 秒后全量扫描一次, 之后每 5 分钟增量扫描(seq 游标保证幂等)
  scanStatsOnce(2000)
  setInterval(() => scanStatsOnce(0), 5 * 60 * 1000)
})
