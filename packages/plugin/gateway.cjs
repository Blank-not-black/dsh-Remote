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
 *   DSH_REMOTE_DEVICE_KEYS 独立设备密钥状态文件, 默认 ~/.dsh-remote/device-keys.json
 *   DSH_REMOTE_FS_ROOT       文件传输额外允许根, 默认 ~, 使用系统路径分隔符配置多根
 *   DSH_REMOTE_FS_MAX_UPLOAD 上传字节上限, 默认 2147483648 (2GB)
 *   DSH_REMOTE_WORKBENCH     工作台绑定文件, 默认 ~/.dsh-remote/workbench.json
 *   DSH_REMOTE_ADVERTISE_HOSTS 额外写入配对二维码的宿主 IP/主机名, 逗号或空白分隔
 *   DSH_REMOTE_DSH_CONTROL_MODE DSH 生命周期后端: auto/systemd/windows/disabled
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
const ANNOUNCEMENTS_FILE = process.env.DSH_REMOTE_ANNOUNCEMENTS_FILE || path.join(PUBLIC_DIR, 'announcements.json')
const DEFAULT_ANNOUNCEMENTS_URL = 'https://vm-0-2-ubuntu.tail1f6fc4.ts.net/announcements.json'
const ANNOUNCEMENTS_URL = process.env.DSH_REMOTE_ANNOUNCEMENTS_URL === undefined
  ? DEFAULT_ANNOUNCEMENTS_URL
  : String(process.env.DSH_REMOTE_ANNOUNCEMENTS_URL || '').trim()
const ANNOUNCEMENTS_CACHE_MS = durationEnv('DSH_REMOTE_ANNOUNCEMENTS_CACHE_MS', 15_000, 100, 10 * 60_000)
const ANNOUNCEMENTS_MAX_BYTES = 512 * 1024
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
const DSH_UPSTREAM_COOKIE_FILE = process.env.DSH_REMOTE_DSH_COOKIE_FILE || path.join(os.homedir(), '.dsh-remote', 'dsh-upstream.cookie')
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(os.homedir(), '.dsh-remote', 'token')
const NOTES_FILE = process.env.DSH_REMOTE_NOTES || path.join(os.homedir(), '.dsh-remote', 'device-notes.json')
const DEVICE_KEYS_FILE = process.env.DSH_REMOTE_DEVICE_KEYS || path.join(os.homedir(), '.dsh-remote', 'device-keys.json')
const WORKBENCH_FILE = process.env.DSH_REMOTE_WORKBENCH || path.join(os.homedir(), '.dsh-remote', 'workbench.json')
const STARTED_AT = Date.now()
const DSH_SERVICE = String(process.env.DSH_REMOTE_DSH_SERVICE || 'dsh-web').trim()
const SYSTEMCTL = String(process.env.DSH_REMOTE_SYSTEMCTL || 'systemctl').trim() || 'systemctl'
const WINDOWS_SC = String(process.env.DSH_REMOTE_WINDOWS_SC || 'sc.exe').trim() || 'sc.exe'
const DSH_CONTROL_MODE_RAW = String(process.env.DSH_REMOTE_DSH_CONTROL_MODE || 'auto').trim().toLowerCase()
const DSH_CONTROL_MODE = ['auto', 'systemd', 'windows', 'disabled'].includes(DSH_CONTROL_MODE_RAW) ? DSH_CONTROL_MODE_RAW : 'auto'
const DSH_CONTROL_TIMEOUT_MS = durationEnv('DSH_REMOTE_DSH_CONTROL_TIMEOUT_MS', 45000, 2000, 5 * 60 * 1000)
const DSH_CONTROL_POLL_MS = durationEnv('DSH_REMOTE_DSH_CONTROL_POLL_MS', 500, 50, 5000)
const HTTP_REQUEST_TIMEOUT_MS = durationEnv('GATEWAY_HTTP_REQUEST_TIMEOUT_MS', 15 * 60 * 1000, 0, 24 * 60 * 60 * 1000)
const HTTP_HEADERS_TIMEOUT_MS = durationEnv('GATEWAY_HTTP_HEADERS_TIMEOUT_MS', 120000, 1000, 10 * 60 * 1000)
const HTTP_KEEPALIVE_TIMEOUT_MS = durationEnv('GATEWAY_HTTP_KEEPALIVE_TIMEOUT_MS', 65000, 1000, 10 * 60 * 1000)

/** 读取插件兑换的新版 DSH 会话 Cookie；动态读取允许 DSH 重启后原地刷新。 */
function dshUpstreamCookie() {
  try {
    const value = fs.readFileSync(DSH_UPSTREAM_COOKIE_FILE, 'utf8').trim()
    if (!value.includes('=') || value.length > 4096 || /[\0\r\n]/.test(value)) return ''
    return value
  } catch {
    return ''
  }
}

function dshUpstreamHeaders(base = {}) {
  const headers = { ...base }
  const cookie = dshUpstreamCookie()
  if (cookie) headers.cookie = cookie
  return headers
}

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

function validAdvertisedHost(value) {
  const host = String(value || '').trim()
  if (!host || host.length > 253 || host === '0.0.0.0' || host === '127.0.0.1') return ''
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return ''
  if (/^\d+(?:\.\d+){3}$/.test(host) && host.split('.').some(part => Number(part) > 255)) return ''
  const labels = host.split('.')
  if (labels.some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return ''
  return host
}

function configuredAdvertisedHosts() {
  return [...new Set(String(process.env.DSH_REMOTE_ADVERTISE_HOSTS || '')
    .split(/[\s,]+/)
    .map(validAdvertisedHost)
    .filter(Boolean))]
}

function containerRuntimeDetected() {
  if (fs.existsSync('/.dockerenv')) return true
  try { return /(?:docker|containerd|kubepods|podman|lxc)/i.test(fs.readFileSync('/proc/1/cgroup', 'utf8')) } catch { return false }
}

function dshControlSupport() {
  if (DSH_CONTROL_MODE === 'disabled') {
    return { supported: false, code: 'EXTERNAL_LIFECYCLE', message: '当前 DSH 由 Docker、面板或其他外部平台管理' }
  }
  if (process.platform === 'win32') {
    if (DSH_CONTROL_MODE === 'systemd') return { supported: false, code: 'CONTROL_MODE_MISMATCH', message: 'Windows 环境不能使用 systemd 控制 DSH' }
    return { supported: true, manager: 'windows' }
  }
  if (DSH_CONTROL_MODE === 'windows') return { supported: false, code: 'CONTROL_MODE_MISMATCH', message: '当前系统不能使用 Windows Service 控制 DSH' }
  if (DSH_CONTROL_MODE === 'systemd' || (process.env.DSH_REMOTE_SYSTEMCTL && SYSTEMCTL !== 'systemctl')) {
    return { supported: true, manager: 'systemd' }
  }
  if (containerRuntimeDetected()) {
    return { supported: false, code: 'EXTERNAL_LIFECYCLE', message: '当前网关运行在容器中，DSH 生命周期应由 Docker、面板或其他外部平台管理' }
  }
  if (!fs.existsSync('/run/systemd/system')) {
    return { supported: false, code: 'EXTERNAL_LIFECYCLE', message: '当前环境没有 systemd，DSH 可能由 Docker、面板或其他外部平台管理' }
  }
  return { supported: true, manager: 'systemd' }
}

const ADVERTISED_HOSTS = configuredAdvertisedHosts()
const DSH_CONTROL_SUPPORT = dshControlSupport()
const VERSION = gatewayVersion()
const PROTOCOL_VERSION = 1
const CAPABILITIES = Object.freeze({
  wsTicket: 1,
  eventPolling: 1,
  workspaceFiles: 2,
  imagePromptTransport: 1,
  dshLifecycle: DSH_CONTROL_SUPPORT.supported ? 2 : 0,
  centralAnnouncements: 2,
  feedback: 1,
  deviceKeys: 1,
  healthProbes: 1,
  resumableUploads: 2,
})

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
function fsConfiguredRoot(value) {
  const raw = String(value || '').trim()
  if (!raw || raw === '~') return raw === '~' ? FS_DEFAULT_ROOT : ''
  if (/^~[\\/]/.test(raw)) return path.resolve(FS_DEFAULT_ROOT, raw.slice(2))
  return path.resolve(raw)
}
const FS_ROOTS = (process.env.DSH_REMOTE_FS_ROOT || FS_DEFAULT_ROOT)
  .split(path.delimiter)
  .map(fsConfiguredRoot)
  .filter(Boolean)
const FS_WORKSPACE_CACHE_MS = durationEnv('DSH_REMOTE_FS_WORKSPACE_CACHE_MS', 15_000, 1000, 10 * 60_000)
const FS_MAX_UPLOAD = Number(process.env.DSH_REMOTE_FS_MAX_UPLOAD) || 2 * 1024 * 1024 * 1024
const FS_UPLOAD_TTL_MS = durationEnv('DSH_REMOTE_FS_UPLOAD_TTL_MS', 24 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000)
let FS_ROOT_REALS = null
let fsWorkspaceRootsCache = { roots: [], reals: [], fetchedAt: 0 }
let fsWorkspaceRootsFetch = null
function fsRootReals() {
  if (!FS_ROOT_REALS) {
    FS_ROOT_REALS = FS_ROOTS.map(r => { try { return fs.realpathSync(r) } catch { return null } }).filter(Boolean)
  }
  return FS_ROOT_REALS
}
function fsInsideReal(real) {
  for (const root of [...fsRootReals(), ...fsWorkspaceRootsCache.reals]) {
    if (fsInsideRoot(real, root)) return true
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
const FS_PREVIEW_MAX = 1024 * 1024
const FS_PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.py', '.css', '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
  '.ini', '.conf', '.env', '.sh', '.bash', '.zsh', '.fish', '.sql', '.java', '.kt',
  '.kts', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.vue',
  '.svelte', '.gradle', '.properties', '.gitignore', '.dockerfile'
])

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

function newAccessToken() {
  return crypto.randomBytes(24).toString('base64url')
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

function normalizeDeviceKey(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 96)
  const accessToken = String(value.token || '').trim()
  if (!id || accessToken.length < 16 || accessToken.length > 256) return null
  return {
    id,
    note: String(value.note || '').trim().slice(0, 40),
    token: accessToken,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Number(value.createdAt) || Date.now(),
    lastUsedAt: Number(value.lastUsedAt) || 0,
    lastIp: String(value.lastIp || '').slice(0, 128),
    lastKind: String(value.lastKind || '').slice(0, 24),
  }
}

function loadDeviceKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DEVICE_KEYS_FILE, 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      keys: Array.isArray(parsed?.keys) ? parsed.keys.map(normalizeDeviceKey).filter(Boolean).slice(0, 100) : [],
    }
  } catch {
    return { enabled: false, keys: [] }
  }
}

const deviceKeyState = loadDeviceKeys()
let deviceKeysSaveTimer = null

function saveDeviceKeys() {
  try {
    fs.mkdirSync(path.dirname(DEVICE_KEYS_FILE), { recursive: true })
    fs.writeFileSync(DEVICE_KEYS_FILE, JSON.stringify({ version: 1, ...deviceKeyState }, null, 2) + '\n', { mode: 0o600 })
    try { fs.chmodSync(DEVICE_KEYS_FILE, 0o600) } catch {}
    return true
  } catch (err) {
    console.warn('[device-keys] 保存失败: ' + (err?.message || err))
    return false
  }
}

function scheduleDeviceKeysSave() {
  if (deviceKeysSaveTimer) return
  deviceKeysSaveTimer = setTimeout(() => {
    deviceKeysSaveTimer = null
    saveDeviceKeys()
  }, 500)
  deviceKeysSaveTimer.unref?.()
}

function createDeviceKey(note = '') {
  const now = Date.now()
  const record = {
    id: crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex'),
    note: String(note || '').trim().slice(0, 40) || '新设备',
    token: newAccessToken(),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0,
    lastIp: '',
    lastKind: '',
  }
  deviceKeyState.keys.push(record)
  if (!saveDeviceKeys()) {
    deviceKeyState.keys.pop()
    return null
  }
  return record
}

function deviceKeyViews() {
  return deviceKeyState.keys.map(record => ({ ...record }))
}

function findDeviceKeyByToken(value) {
  return deviceKeyState.keys.find(record => safeTokenEqual(value, record.token)) || null
}

function authKind(req) {
  const marked = String(req.headers['x-dsh-remote-client'] || '')
  return marked === 'app' || marked === 'web' || marked === 'admin' ? marked : kindOf(req)
}

function rememberDeviceKeyUse(record, req) {
  if (!record) return
  const now = Date.now()
  const nextIp = ipOf(req)
  const nextKind = authKind(req)
  const needsSave = now - record.lastUsedAt > 30_000 || record.lastIp !== nextIp || record.lastKind !== nextKind
  record.lastUsedAt = now
  record.lastIp = nextIp
  record.lastKind = nextKind
  if (needsSave) scheduleDeviceKeysSave()
}

/** 一键轮换令牌: 写回 TOKEN_FILE 并立即生效(旧令牌/旧连接全部失效)。 */
function rotateToken() {
  if (TOKEN_FROM_ENV) return { error: 'token-from-env', detail: '令牌来自 TOKEN 环境变量, 请修改环境变量后重启' }
  const next = newAccessToken()
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
  const presented = tokenOf(req, url)
  if (!deviceKeyState.enabled && safeTokenEqual(presented, TOKEN)) {
    req.dshRemoteAuth = { type: 'shared', id: 'shared' }
    return true
  }
  if (deviceKeyState.enabled) {
    const record = findDeviceKeyByToken(presented)
    if (record) {
      req.dshRemoteAuth = { type: 'device', id: record.id }
      rememberDeviceKeyUse(record, req)
      return true
    }
  }
  if (options.consumeTicket) {
    const ticket = url.searchParams.get('ticket')
    const record = ticket && wsTickets.get(ticket)
    if (record && record.expiresAt > Date.now()) {
      req.dshRemoteAuth = record.auth || { type: 'shared', id: 'shared' }
      record.uses--
      if (record.uses <= 0) wsTickets.delete(ticket)
      return true
    }
    if (ticket) wsTickets.delete(ticket)
  }
  return false
}

function adminAuthorized(req, url) {
  const ok = safeTokenEqual(tokenOf(req, url), TOKEN)
  if (ok) req.dshRemoteAuth = { type: 'admin', id: 'admin' }
  return ok
}

function controlAuthorized(req, url) {
  return adminAuthorized(req, url) || authorized(req, url)
}

function issueWsTicket(auth) {
  const now = Date.now()
  for (const [ticket, record] of wsTickets) {
    if (record.expiresAt <= now) wsTickets.delete(ticket)
  }
  const ticket = crypto.randomBytes(24).toString('base64url')
  wsTickets.set(ticket, { expiresAt: now + WS_TICKET_TTL_MS, uses: 4, auth: auth || { type: 'shared', id: 'shared' } })
  return { ticket, expiresAt: now + WS_TICKET_TTL_MS }
}

// ---------- 设备监控 ----------
const devices = new Map()   // ip[|clientId] -> device
const legacyDeviceAliases = new Map() // ip -> { clientId, ua, expiresAt }
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
  for (const [ip, alias] of legacyDeviceAliases) {
    if (!alias || alias.expiresAt <= now) legacyDeviceAliases.delete(ip)
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

function mergeDeviceRecords(target, legacy) {
  if (!target || !legacy || target === legacy) return
  target.firstSeen = Math.min(target.firstSeen || Date.now(), legacy.firstSeen || Date.now())
  target.lastSeen = Math.max(target.lastSeen || 0, legacy.lastSeen || 0)
  target.requests += legacy.requests || 0
  target.authFailures += legacy.authFailures || 0
  target.credentialId ||= legacy.credentialId || ''
  if (!target.ua || (legacy.ua && legacy.ua.length > target.ua.length)) target.ua = legacy.ua
  for (const channel of new Set([...Object.keys(legacy.channelCounts || {}), ...Object.keys(target.channelCounts || {})])) {
    target.channelCounts[channel] = (target.channelCounts[channel] || 0) + (legacy.channelCounts?.[channel] || 0)
    target.channels[channel] = !!(target.channelCounts[channel] || target.channels[channel] || legacy.channels?.[channel])
  }
  for (const socket of legacy.sockets || []) target.sockets.add(socket)
}

function legacyDeviceFor(ip, clientId, req) {
  if (!clientId) return null
  const legacy = devices.get(ip)
  if (!legacy || legacy.clientId) return null
  const requestUa = String(req.headers['user-agent'] || '')
  const sameUa = requestUa && legacy.ua && requestUa === legacy.ua
  const legacyBackgroundPoll = /^Dalvik\/2\.1\.0/i.test(legacy.ua || '') && req.headers['x-dsh-remote-client'] === 'app'
  if (!sameUa && !legacyBackgroundPoll) return null
  return legacy
}

function knownDeviceForLegacy(ip, req) {
  const requestUa = String(req.headers['user-agent'] || '')
  if (!requestUa) return null
  const candidates = [...devices.values()].filter(d => {
    if (d.ip !== ip || !d.clientId) return false
    return (d.ua && d.ua === requestUa) || (d.kind === 'app' && /^Dalvik\/2\.1\.0/i.test(requestUa))
  })
  return candidates.length === 1 ? candidates[0] : null
}

function touchDevice(req, extra = {}) {
  pruneDevices()
  const ip = ipOf(req)
  const headerClientId = req.headers['x-dsh-remote-client-id']
  let clientId = String(extra.clientId || headerClientId || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 96)
  const requestUa = String(req.headers['user-agent'] || '')
  if (!clientId) {
    const alias = legacyDeviceAliases.get(ip)
    if (alias && alias.expiresAt > Date.now() && alias.ua && alias.ua === requestUa) clientId = alias.clientId
    else clientId = knownDeviceForLegacy(ip, req)?.clientId || ''
  }
  const deviceKey = clientId ? `${ip}|${clientId}` : ip
  totalRequests++
  let d = devices.get(deviceKey)
  if (!d) {
    d = {
      id: deviceKey, ip, clientId, kind: kindOf(req), ua: '', firstSeen: Date.now(), lastSeen: 0,
      credentialId: '', requests: 0, authFailures: 0, channels: {}, channelCounts: {}, sockets: new Set()
    }
    devices.set(deviceKey, d)
  }
  if (clientId && deviceKey !== ip) {
    const legacy = legacyDeviceFor(ip, clientId, req)
    if (legacy && legacy !== d) {
      mergeDeviceRecords(d, legacy)
      devices.delete(ip)
      legacyDeviceAliases.set(ip, { clientId, ua: legacy.ua, expiresAt: Date.now() + DEVICE_TTL_MS })
    }
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
  if (req.dshRemoteAuth?.type === 'device') d.credentialId = req.dshRemoteAuth.id
  const marked = req.headers['x-dsh-remote-client']
  if (marked) d.kind = marked
  const ua = requestUa
  if (ua && ua.length > d.ua.length) d.ua = ua
  return d
}

function deviceViews() {
  return [...devices.values()]
    .map(d => ({
      ip: d.ip,
      id: d.id,
      clientId: d.clientId || '',
      credentialId: d.credentialId || '',
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

function kickCredential(credentialId) {
  const targets = [...devices.values()].filter(d => d.credentialId === credentialId)
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

function kickRemoteClients() {
  let n = 0
  for (const d of devices.values()) {
    if (d.kind === 'admin') continue
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

function deviceKeysPayload() {
  return {
    supported: true,
    enabled: deviceKeyState.enabled,
    entries: deviceKeyViews(),
  }
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
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-dsh-remote-client, x-dsh-remote-client-id')
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
        signal: error?.signal || '',
        killed: error?.killed === true,
        timedOut: error?.code === 'ETIMEDOUT' || (error?.killed === true && error?.signal === 'SIGTERM'),
        error: String(error?.message || '').trim(),
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      })
    })
  })
}

function parseSystemdShow(output) {
  const values = {}
  for (const line of String(output || '').split(/\r?\n/)) {
    const split = line.indexOf('=')
    if (split > 0) values[line.slice(0, split)] = line.slice(split + 1)
  }
  return values
}

function classifySystemctlFailure(result) {
  const detail = [result?.stderr, result?.stdout, result?.error].filter(Boolean).join(' · ').slice(0, 1000)
  if (result?.timedOut) return { code: 'COMMAND_TIMEOUT', message: 'systemctl 命令执行超时', detail }
  if (result?.code === 'ENOENT' || /ENOENT|not found/i.test(detail)) return { code: 'SYSTEMCTL_NOT_FOUND', message: '系统中找不到 systemctl', detail }
  if (/Failed to connect to bus|No medium found|user bus|DBUS/i.test(detail)) return { code: 'SYSTEMD_UNAVAILABLE', message: '无法连接当前用户的 systemd 会话', detail }
  if (/access denied|permission denied|not authorized|authentication is required/i.test(detail)) return { code: 'PERMISSION_DENIED', message: '当前用户无权控制 DSH 服务', detail }
  return { code: 'COMMAND_FAILED', message: 'systemctl 未能接受 DSH 控制命令', detail }
}

const WINDOWS_SERVICE_STATE_NAMES = Object.freeze({
  1: 'STOPPED',
  2: 'START_PENDING',
  3: 'STOP_PENDING',
  4: 'RUNNING',
  5: 'CONTINUE_PENDING',
  6: 'PAUSE_PENDING',
  7: 'PAUSED',
})

function parseWindowsServiceQuery(output) {
  const text = String(output || '')
  const state = /\bSTATE\s*:\s*(\d+)(?:\s+([^\r\n(]+))?/i.exec(text)
  if (!state) return null
  const stateCode = Number(state[1])
  const stateName = WINDOWS_SERVICE_STATE_NAMES[stateCode] || String(state[2] || 'UNKNOWN').trim().split(/\s+/)[0].toUpperCase()
  const pid = /\bPID\s*:\s*(\d+)/i.exec(text)
  const pending = [2, 3, 5, 6].includes(stateCode)
  return {
    stateCode,
    stateName,
    pending,
    running: stateCode === 4,
    mainPid: Number(pid?.[1]) || 0,
  }
}

function classifyWindowsServiceFailure(result) {
  const detail = [result?.stderr, result?.stdout, result?.error].filter(Boolean).join(' · ').slice(0, 1000)
  const code = String(result?.code ?? '')
  if (result?.timedOut) return { code: 'COMMAND_TIMEOUT', message: 'Windows 服务控制命令超时', detail }
  if (code === 'ENOENT') return { code: 'SERVICE_CONTROL_NOT_FOUND', message: '系统中找不到 sc.exe', detail }
  if (code === '1060' || /1060|does not exist|cannot find the file specified|找不到指定的服务/i.test(detail)) {
    return { code: 'SERVICE_NOT_FOUND', message: `未找到 Windows 服务 ${DSH_SERVICE}`, detail }
  }
  if (code === '1058' || /1058|disabled|禁用/i.test(detail)) return { code: 'SERVICE_DISABLED', message: `Windows 服务 ${DSH_SERVICE} 已被禁用`, detail }
  if (/access is denied|permission denied|not authorized|需要提升|拒绝访问/i.test(detail)) return { code: 'PERMISSION_DENIED', message: '当前用户无权控制 Windows DSH 服务', detail }
  if (code === 'SERVICE_STOP_TIMEOUT') return { code, message: `Windows 服务 ${DSH_SERVICE} 停止超时`, detail }
  return { code: 'COMMAND_FAILED', message: 'Windows 服务控制命令失败', detail }
}

function classifyDshServiceFailure(result) {
  return process.platform === 'win32' ? classifyWindowsServiceFailure(result) : classifySystemctlFailure(result)
}

async function windowsServiceStatus() {
  const r = await execFileResult(WINDOWS_SC, ['queryex', DSH_SERVICE], 5000)
  if (!r.ok) {
    const failure = classifyWindowsServiceFailure(r)
    if (failure.code === 'SERVICE_NOT_FOUND') {
      return { ok: true, supported: false, running: false, service: DSH_SERVICE, ...failure }
    }
    return { ok: false, supported: false, running: false, service: DSH_SERVICE, ...failure }
  }
  const parsed = parseWindowsServiceQuery([r.stdout, r.stderr].filter(Boolean).join('\n'))
  if (!parsed) {
    return {
      ok: false, supported: false, running: false, service: DSH_SERVICE,
      code: 'STATUS_PARSE_FAILED', message: '无法解析 Windows DSH 服务状态', detail: r.stdout || r.stderr || 'sc.exe 没有返回 STATE',
    }
  }
  const activeState = parsed.running ? 'active' : parsed.stateCode === 7 ? 'paused' : parsed.pending ? 'activating' : 'inactive'
  return {
    ok: true,
    supported: true,
    running: parsed.running,
    service: DSH_SERVICE,
    state: activeState,
    loadState: 'loaded',
    activeState,
    subState: parsed.stateName.toLowerCase(),
    unitFileState: 'windows-service',
    mainPid: parsed.mainPid,
    result: '',
    execMainStatus: 0,
    serviceStateCode: parsed.stateCode,
    serviceState: parsed.stateName,
  }
}

async function dshServiceStatus() {
  if (!/^[A-Za-z0-9_.@-]+$/.test(DSH_SERVICE)) {
    return { ok: false, supported: false, running: false, service: DSH_SERVICE, code: 'INVALID_SERVICE', message: 'DSH_REMOTE_DSH_SERVICE 服务名配置不合法' }
  }
  if (!DSH_CONTROL_SUPPORT.supported) {
    return { ok: true, supported: false, running: false, service: DSH_SERVICE, ...DSH_CONTROL_SUPPORT }
  }
  if (process.platform === 'win32') return windowsServiceStatus()
  const r = await execFileResult(SYSTEMCTL, [
    '--user', 'show', DSH_SERVICE,
    '--property=Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,Result,ExecMainStatus',
    '--no-pager'
  ], 5000)
  if (!r.ok) {
    const failure = classifySystemctlFailure(r)
    return { ok: false, supported: false, running: false, service: DSH_SERVICE, ...failure }
  }
  const value = parseSystemdShow(r.stdout)
  const loadState = value.LoadState || 'unknown'
  const activeState = value.ActiveState || 'unknown'
  const subState = value.SubState || 'unknown'
  const mainPid = Number(value.MainPID) || 0
  if (loadState === 'not-found') {
    return {
      ok: true, supported: false, running: false, service: DSH_SERVICE,
      code: 'SERVICE_NOT_FOUND', message: `未找到 systemd 用户服务 ${DSH_SERVICE}`,
      loadState, activeState, subState, mainPid,
    }
  }
  return {
    ok: true,
    supported: true,
    running: activeState === 'active' && (subState === 'running' || subState === 'exited'),
    service: value.Id || DSH_SERVICE,
    state: activeState,
    loadState,
    activeState,
    subState,
    unitFileState: value.UnitFileState || '',
    mainPid,
    result: value.Result || '',
    execMainStatus: Number(value.ExecMainStatus) || 0,
  }
}

async function executeDshServiceAction(action, initial) {
  if (process.platform !== 'win32') {
    return execFileResult(SYSTEMCTL, ['--user', '--no-block', action, DSH_SERVICE], 5000)
  }
  if (action === 'restart' && initial?.running) {
    const stop = await execFileResult(WINDOWS_SC, ['stop', DSH_SERVICE], 5000)
    if (!stop.ok) {
      const current = await windowsServiceStatus()
      if (!current.supported || current.running || current.serviceStateCode !== 1) return stop
    }
    let stopped = false
    const checks = Math.max(1, Math.ceil(DSH_CONTROL_TIMEOUT_MS / Math.max(50, DSH_CONTROL_POLL_MS)))
    for (let i = 0; i < checks; i++) {
      const current = await windowsServiceStatus()
      if (!current.supported) {
        return { ok: false, code: current.code || 'SERVICE_STATUS_FAILED', error: current.message, stderr: current.detail }
      }
      if (current.serviceStateCode === 1) { stopped = true; break }
      await delay(DSH_CONTROL_POLL_MS)
    }
    if (!stopped) return { ok: false, code: 'SERVICE_STOP_TIMEOUT', error: `Windows 服务 ${DSH_SERVICE} 停止超时` }
  }
  return execFileResult(WINDOWS_SC, ['start', DSH_SERVICE], 5000)
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function probeDshUpstream() {
  const startedAt = Date.now()
  try {
    const probe = await fetch(new URL(DSH_HEALTH_PATH, UPSTREAM), {
      headers: dshUpstreamHeaders(),
      signal: AbortSignal.timeout(Math.min(2500, UPSTREAM_REQUEST_TIMEOUT_MS)),
      cache: 'no-store',
    })
    return {
      ok: probe.ok,
      reachable: true,
      status: probe.status,
      elapsedMs: Date.now() - startedAt,
      error: probe.ok ? '' : `DSH HTTP ${probe.status}`,
    }
  } catch (err) {
    return { ok: false, reachable: false, status: 0, elapsedMs: Date.now() - startedAt, error: String(err?.message || err || '连接失败').slice(0, 500) }
  }
}

let dshControlOperation = null

function dshOperationStep(operation, stage, message, extra = {}) {
  const now = Date.now()
  operation.stage = stage
  operation.message = message
  operation.updatedAt = now
  Object.assign(operation, extra)
  if (operation.done) operation.elapsedMs = now - operation.startedAt
  operation.steps.push({ stage, message, at: now, elapsedMs: now - operation.startedAt })
}

function failDshOperation(operation, code, message, detail = '', status = null) {
  dshOperationStep(operation, 'failed', message, {
    ok: false,
    done: true,
    code,
    detail: String(detail || '').slice(0, 1000),
    ...(status ? { status } : {}),
  })
  if (status) operation.observed = status
  operation.evidence = { observed: status || operation.observed || null, upstream: operation.upstream || null, events: operation.events || null }
}

function dshEventChannelStatus() {
  const pick = kind => ({
    connected: eventCollectorState[kind].connected,
    attempt: eventCollectorState[kind].attempt,
    lastError: eventCollectorState[kind].lastError,
  })
  const mux = pick('mux')
  const host = pick('host')
  return { ok: mux.connected && host.connected, mux, host }
}

function reconnectDshEventCollectors() {
  eventCollectors.mux?.reconnectNow()
  eventCollectors.host?.reconnectNow()
}

async function runDshControlOperation(operation) {
  try {
    const manager = process.platform === 'win32' ? 'Windows 服务' : 'systemd 用户服务'
    dshOperationStep(operation, 'checking', `正在检查 ${manager} ${DSH_SERVICE}`)
    const initial = await dshServiceStatus()
    operation.initialStatus = initial
    operation.observed = initial
    if (!initial.supported) {
      failDshOperation(operation, initial.code || 'UNSUPPORTED', initial.message || '当前 DSH 服务不可控', initial.detail, initial)
      return
    }
    if (operation.action === 'start' && initial.running) {
      dshOperationStep(operation, 'complete', `DSH 已在运行（${initial.service}，PID ${initial.mainPid || '未知'}）`, {
        ok: true, done: true, code: 'ALREADY_RUNNING', status: initial, upstream: await probeDshUpstream(),
      })
      return
    }

    dshOperationStep(operation, 'command', `正在向 ${manager} 提交 DSH ${operation.action === 'start' ? '启动' : '重启'}命令`)
    const command = await executeDshServiceAction(operation.action, initial)
    operation.command = { ok: command.ok, code: command.code, signal: command.signal }
    if (!command.ok) {
      const failure = classifyDshServiceFailure(command)
      failDshOperation(operation, failure.code, failure.message, failure.detail, await dshServiceStatus())
      return
    }

    dshOperationStep(operation, 'waiting-service', `命令已接受，正在等待 ${initial.service} 进入运行状态`)
    const initialPid = initial.mainPid || 0
    let restartObserved = operation.action === 'start' || !initial.running || initialPid <= 0
    let waitingUpstreamReported = false
    let waitingEventsReported = false
    let lastEventReconnectAt = 0
    let lastStatus = initial
    let lastProbe = null
    const deadline = Date.now() + DSH_CONTROL_TIMEOUT_MS
    while (Date.now() < deadline) {
      const status = await dshServiceStatus()
      lastStatus = status
      operation.status = status
      operation.observed = status
      if (!status.supported) {
        failDshOperation(operation, status.code || 'STATUS_FAILED', status.message || '无法读取 DSH 服务状态', status.detail, status)
        return
      }
      if (operation.action === 'restart' && (status.mainPid > 0 && status.mainPid !== initialPid || status.activeState !== 'active')) restartObserved = true
      if (status.activeState === 'failed') {
        failDshOperation(operation, 'SERVICE_FAILED', `DSH 服务进入 failed 状态（Result=${status.result || 'unknown'}，ExecMainStatus=${status.execMainStatus}）`, '', status)
        return
      }
      if (status.running && restartObserved) {
        if (!waitingUpstreamReported) {
          waitingUpstreamReported = true
          dshOperationStep(operation, 'waiting-upstream', `服务进程已运行（PID ${status.mainPid || '未知'}），正在等待 DSH HTTP 接口 ${UPSTREAM.origin}${DSH_HEALTH_PATH} 恢复`)
        }
        lastProbe = await probeDshUpstream()
        operation.upstream = lastProbe
        if (lastProbe.ok) {
          if (!waitingEventsReported) {
            waitingEventsReported = true
            dshOperationStep(operation, 'waiting-events', `DSH HTTP 已恢复（${lastProbe.status}），正在连接 mux/host 实时消息通道`)
          }
          if (Date.now() - lastEventReconnectAt >= 1500) {
            lastEventReconnectAt = Date.now()
            reconnectDshEventCollectors()
          }
          const events = dshEventChannelStatus()
          operation.events = events
          if (events.ok) {
            dshOperationStep(operation, 'complete', `DSH ${operation.action === 'start' ? '启动' : '重启'}成功：服务已运行，HTTP ${lastProbe.status}，实时通道已连接，PID ${status.mainPid || '未知'}`, {
              ok: true, done: true, code: 'SUCCESS', status, upstream: lastProbe, events,
            })
            operation.evidence = { observed: status, upstream: lastProbe, events }
            return
          }
        }
      }
      await delay(DSH_CONTROL_POLL_MS)
    }
    if (!lastStatus.running || !restartObserved) {
      const reason = operation.action === 'restart' && !restartObserved
        ? `未观察到 ${initial.service} 进程完成重启（初始 PID ${initialPid || '未知'}，当前 PID ${lastStatus.mainPid || '未知'}）`
        : `${initial.service} 未在 ${Math.round(DSH_CONTROL_TIMEOUT_MS / 1000)} 秒内进入运行状态（${lastStatus.activeState}/${lastStatus.subState}）`
      failDshOperation(operation, 'SERVICE_TIMEOUT', reason, '', lastStatus)
      return
    }
    if (lastProbe?.ok) {
      const events = dshEventChannelStatus()
      failDshOperation(
        operation,
        'EVENTS_TIMEOUT',
        `DSH 服务和 HTTP 已恢复，但 mux/host 实时消息通道未在 ${Math.round(DSH_CONTROL_TIMEOUT_MS / 1000)} 秒内连接`,
        ['mux', 'host'].map(kind => `${kind}: ${events[kind].connected ? 'connected' : events[kind].lastError || `retry ${events[kind].attempt}`}`).join(' · '),
        lastStatus,
      )
      operation.events = events
      return
    }
    failDshOperation(operation, 'UPSTREAM_TIMEOUT', `服务进程已运行，但 DSH HTTP 接口在 ${Math.round(DSH_CONTROL_TIMEOUT_MS / 1000)} 秒内未恢复`, lastProbe?.error || '', lastStatus)
  } catch (err) {
    failDshOperation(operation, 'INTERNAL_ERROR', 'DSH 控制流程发生未预期错误', String(err?.stack || err))
  }
}

async function serveDshControl(req, res, url) {
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }
  if (!controlAuthorized(req, url)) {
    authFailures++
    touchDevice(req, { failedAuth: true })
    cors(res)
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  touchDevice(req, { kind: 'admin' })
  if (req.method === 'GET') {
    const operationId = String(url.searchParams.get('operation') || '').trim()
    cors(res)
    if (operationId) {
      if (!dshControlOperation || dshControlOperation.operationId !== operationId) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, done: true, code: 'OPERATION_NOT_FOUND', error: '找不到该 DSH 控制操作，网关可能已重启' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        ...dshControlOperation,
        elapsedMs: dshControlOperation.done
          ? dshControlOperation.elapsedMs
          : Date.now() - dshControlOperation.startedAt,
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    const status = await dshServiceStatus()
    res.end(JSON.stringify({ ...status, operation: dshControlOperation && !dshControlOperation.done ? dshControlOperation : null }))
    return
  }
  if (req.method !== 'POST') {
    cors(res)
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  let body = {}
  try { body = JSON.parse((await readBody(req, 4096)) || '{}') } catch (err) {
    cors(res)
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, code: 'INVALID_JSON', error: '请求体不是有效 JSON', detail: String(err?.message || err) }))
    return
  }
  const action = body?.action
  if (action !== 'start' && action !== 'restart') {
    cors(res)
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, code: 'INVALID_ACTION', error: 'action 必须是 start 或 restart' }))
    return
  }
  if (dshControlOperation && !dshControlOperation.done) {
    cors(res)
    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, code: 'OPERATION_IN_PROGRESS', error: '已有 DSH 控制操作正在执行', operation: dshControlOperation }))
    return
  }
  const now = Date.now()
  dshControlOperation = {
    operationId: crypto.randomUUID(), action, service: DSH_SERVICE,
    desired: { service: DSH_SERVICE, running: true, action },
    observed: null,
    evidence: null,
    ok: false, accepted: true, done: false, stage: 'queued', code: 'ACCEPTED',
    message: `已接收 DSH ${action === 'start' ? '启动' : '重启'}请求，等待检查服务`,
    startedAt: now, updatedAt: now, steps: [],
  }
  setImmediate(() => { void runDshControlOperation(dshControlOperation) })
  cors(res)
  res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(dshControlOperation))
}

// ---------- 事件轮询缓冲 ----------
// 网关每个通道只维护一条到 DSH 的 mux/host WebSocket，同时把事件写入
// 内存环形缓冲并广播给已认证客户端；前端在 WebSocket 被隧道/受限网络
// 阻断时改走 GET /api/events.poll 增量拉取。
const EVENT_BUFFER_MAX = durationEnv('GATEWAY_EVENT_BUFFER_MAX', 1000, 100, 10000)
const EVENT_POLL_WAIT_MAX = durationEnv('GATEWAY_EVENT_POLL_WAIT_MS', 25000, 0, 60000)
const EVENT_MAX_STRING = 16 * 1024
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const eventBuffers = { mux: [], host: [] }
const eventNextSeq = { mux: 1, host: 1 }
const collectorClients = { mux: new Set(), host: new Set() }
const collectorReplay = { mux: new Map(), host: new Map() }
const eventPollWaiters = { mux: new Set(), host: new Set() }
const eventCollectorState = {
  mux: { connected: false, lastEventAt: 0, lastConnectAt: 0, reconnects: 0, lastError: '', lastCloseCode: 0, lastCloseReason: '', attempt: 0, clients: 0, framesBroadcast: 0, lastBroadcastAt: 0 },
  host: { connected: false, lastEventAt: 0, lastConnectAt: 0, reconnects: 0, lastError: '', lastCloseCode: 0, lastCloseReason: '', attempt: 0, clients: 0, framesBroadcast: 0, lastBroadcastAt: 0 },
}
const eventCollectors = { mux: null, host: null }

// DSH 0.1.2-alpha.1 replaced dotted RPC names and the two downlink sockets with
// generated slash RPCs over one logical-stream mux.  Keep the public Remote
// contract stable here so older DSH releases and newer generated Remotes can
// both serve the same zero-build clients.
let upstreamApiFlavor = 'unknown'
let upstreamApiFlavorProbe = null
const modernState = {
  home: '',
  eventClientId: '',
  sessions: new Map(),
  sessionCursors: new Map(),
  workspaces: { items: [], archivedSessionIds: [] },
  pendingEvents: new Map(),
}

async function callUpstreamRemote(endpoint, args, rpcId = crypto.randomUUID()) {
  const target = new URL('/api/' + endpoint, UPSTREAM)
  const response = await fetch(target, {
    method: 'POST',
    headers: dshUpstreamHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

async function detectUpstreamApiFlavor(force = false) {
  if (!force && upstreamApiFlavor !== 'unknown') return upstreamApiFlavor
  if (!force && upstreamApiFlavorProbe) return upstreamApiFlavorProbe
  upstreamApiFlavorProbe = (async () => {
    try {
      const probe = await callUpstreamRemote('session/list', { _request: {} })
      upstreamApiFlavor = probe.status === 200
        && probe.body?.result?.ok === true
        && Array.isArray(probe.body?.result?.value?.items)
        ? 'modern'
        : 'legacy'
      if (upstreamApiFlavor === 'modern' && probe.body?.result?.ok) {
        updateModernSessions(probe.body.result.value?.items)
      }
    } catch {
      upstreamApiFlavor = 'legacy'
    } finally {
      upstreamApiFlavorProbe = null
    }
    return upstreamApiFlavor
  })()
  return upstreamApiFlavorProbe
}

function updateModernSessions(items) {
  if (!Array.isArray(items)) return
  modernState.sessions.clear()
  for (const item of items) {
    if (!item?.sessionId) continue
    modernState.sessions.set(item.sessionId, item)
    const cursor = Number(item.projections?.asOfSeq)
    if (Number.isSafeInteger(cursor) && cursor >= -1) modernState.sessionCursors.set(item.sessionId, cursor)
  }
}

function legacyEnvelope(rpcId, result) {
  return { rpcId, result }
}

function modernError(message, code = 'upstream-incompatible', details = {}) {
  return { ok: false, error: { code, message, details } }
}

function legacyHistoryValue(value, summary) {
  const records = Array.isArray(value?.records) ? value.records : []
  return {
    events: records.map(record => ({ event: record?.event })).filter(entry => entry.event),
    hasMore: !!value?.hasMore,
    ...(summary?.projections ? { projections: summary.projections } : {}),
  }
}

async function refreshModernSessions() {
  const response = await callUpstreamRemote('session/list', { _request: {} })
  if (response.status === 200 && response.body?.result?.ok) updateModernSessions(response.body.result.value?.items)
  return response
}

async function translateModernRpc(method, payload, rpcId) {
  let endpoint = ''
  let args = {}
  let transform = value => value

  if (method === 'host.describe') {
    return legacyEnvelope(rpcId, { ok: true, value: { home: modernState.home || os.homedir(), canOpenPath: false } })
  }
  if (method === 'workspace.list') {
    return legacyEnvelope(rpcId, { ok: true, value: modernState.workspaces })
  }
  if (method === 'session.list') {
    const response = await refreshModernSessions()
    return response.body || legacyEnvelope(rpcId, modernError('DSH session/list returned no JSON response'))
  }
  if (method === 'session.history') {
    let summary = modernState.sessions.get(payload.sessionId)
    if (!summary) {
      await refreshModernSessions()
      summary = modernState.sessions.get(payload.sessionId)
    }
    const throughSeq = modernState.sessionCursors.get(payload.sessionId) ?? Number(summary?.projections?.asOfSeq)
    if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) {
      return legacyEnvelope(rpcId, modernError('DSH did not expose a history cursor for this session', 'session-not-found'))
    }
    endpoint = 'session/page'
    args = { request: {
      address: { kind: 'session', sessionId: payload.sessionId },
      throughSeq,
      ...(payload.beforeSeq === undefined ? {} : { beforeSeq: payload.beforeSeq }),
      ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
    } }
    transform = value => legacyHistoryValue(value, summary)
  } else if (method === 'session.models') {
    endpoint = 'session/modelCatalog'
    args = {}
    transform = catalog => {
      const summary = modernState.sessions.get(payload.sessionId)
      const projected = summary?.projections?.values?.modelSelection
      const current = projected?.next || projected?.lastUsed || catalog?.default
      return {
        current,
        routable: !!current && (!Array.isArray(catalog?.routableProviders) || catalog.routableProviders.includes(current.provider)),
        groups: catalog?.groups || [],
        failures: catalog?.failures || [],
      }
    }
  } else if (method.startsWith('session.')) {
    const verb = method.slice('session.'.length)
    if (!['search', 'create', 'selectModel', 'rename', 'fork', 'prompt', 'attachment', 'updateQueue', 'cancel'].includes(verb)) return null
    endpoint = 'session/' + verb
    const request = verb === 'prompt' && !payload.requestId
      ? { ...payload, requestId: crypto.randomUUID() }
      : payload
    args = verb === 'search' ? { request } : { request }
  } else if (method.startsWith('workspace.')) {
    const verb = method.slice('workspace.'.length)
    if (!['create', 'rename', 'delete', 'insertBefore', 'insertSessionBefore', 'archiveSession'].includes(verb)) return null
    endpoint = 'workspace/' + verb
    args = { request: payload }
  } else if (method.startsWith('goal.')) {
    const verb = method.slice('goal.'.length)
    if (!['create', 'edit', 'pause', 'resume', 'complete', 'clear'].includes(verb)) return null
    endpoint = 'goals/' + verb
    args = verb === 'create'
      ? { agentId: payload.sessionId, request: { objective: payload.objective, ...(payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: payload.maxGoalRounds }) } }
      : { agentId: payload.sessionId, ref: payload.ref, ...(verb === 'edit' ? { request: { ...(payload.objective === undefined ? {} : { objective: payload.objective }), ...(payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: payload.maxGoalRounds }) } } : {}) }
    transform = value => verb === 'create'
      ? value
      : verb === 'clear'
        ? { cleared: true }
        : { ref: { id: value?.id, revision: value?.revision } }
  } else if (method === 'subagent.list') {
    endpoint = 'subagents/list'
    args = { parentSessionId: payload.parentSessionId }
  } else if (method === 'subagent.interrupt') {
    endpoint = 'subagents/interruptByParent'
    args = { childSessionId: payload.childSessionId, parentSessionId: payload.parentSessionId, mode: payload.mode }
  } else if (method === 'settings.describe') {
    endpoint = 'settings/describe'
    args = {}
  } else if (method === 'settings.mutate') {
    endpoint = 'settings/mutate'
    args = { ns: payload.ns, ops: payload.ops, expectedRevision: payload.expectedRevision }
  } else if (method === 'settings.openDocument') {
    endpoint = 'settings/openSettingsDocument'
    args = {}
  } else if (method.startsWith('credentials.')) {
    const verb = method.slice('credentials.'.length)
    if (!['describe', 'set', 'unset'].includes(verb)) return null
    endpoint = 'credentials/' + verb
    args = verb === 'describe' ? { refs: payload.refs } : verb === 'set' ? { ref: payload.ref, value: payload.value } : { ref: payload.ref }
    if (verb !== 'describe') transform = () => ({})
  } else if (method === 'llm.providers') {
    endpoint = 'llm/listConfigurableProviders'
    args = {}
    transform = values => ({ providers: (Array.isArray(values) ? values : []).map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath || [],
      active: true,
      ...(entry.declared === undefined ? {} : { declared: entry.declared }),
    })) })
  } else if (method === 'llm.discoverModels') {
    endpoint = 'llm/discoverModels'
    args = {
      settingsNs: payload.settingsNs,
      request: Object.fromEntries(Object.entries(payload).filter(([key, value]) => key !== 'settingsNs' && value !== undefined)),
    }
    transform = models => ({ models: Array.isArray(models) ? models : [] })
  } else {
    return null
  }

  const response = await callUpstreamRemote(endpoint, args, rpcId)
  if (!response.body?.result?.ok) return response.body || legacyEnvelope(rpcId, modernError(`DSH ${endpoint} returned no JSON response`))
  return legacyEnvelope(rpcId, { ok: true, value: transform(response.body.result.value) })
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
  flushEventPollWaiters(kind)
}

function eventPollPayload(kind, since, waitSupported = false) {
  const buf = eventBuffers[kind]
  const events = buf.filter(r => r.seq > since)
  const latestSeq = buf.length ? buf[buf.length - 1].seq : 0
  const truncated = buf.length > 0 && since < buf[0].seq - 1
  return { ok: true, kind, since, latestSeq, truncated, waitSupported, events }
}

function sendEventPollResponse(waiter, payload) {
  if (waiter.req.destroyed || waiter.res.destroyed) return
  cors(waiter.res)
  waiter.res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  waiter.res.end(JSON.stringify(payload))
}

function finishEventPollWaiter(waiter, send = true) {
  if (!eventPollWaiters[waiter.kind]?.delete(waiter)) return
  clearTimeout(waiter.timer)
  if (send) sendEventPollResponse(waiter, eventPollPayload(waiter.kind, waiter.since, true))
}

function flushEventPollWaiters(kind) {
  for (const waiter of [...eventPollWaiters[kind]]) {
    const payload = eventPollPayload(kind, waiter.since, true)
    if (payload.events.length) finishEventPollWaiter(waiter, true)
  }
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
  res.end(JSON.stringify({ ok: true, ...issueWsTicket(req.dshRemoteAuth) }))
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
  const waitRaw = url.searchParams.get('wait')
  const requestedWait = waitRaw === null ? 0 : Number(waitRaw)
  if (!Number.isFinite(requestedWait) || requestedWait < 0) {
    cors(res)
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'bad-wait', detail: 'wait 必须是非负数字' }))
    return
  }
  const wait = Math.min(Math.floor(requestedWait), EVENT_POLL_WAIT_MAX)
  const waitSupported = wait > 0 && EVENT_POLL_WAIT_MAX > 0
  const payload = eventPollPayload(kind, since, waitSupported)
  if (payload.events.length || wait <= 0 || EVENT_POLL_WAIT_MAX <= 0) {
    cors(res)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(payload))
    return
  }
  const waiter = { req, res, kind, since, timer: null }
  eventPollWaiters[kind].add(waiter)
  waiter.timer = setTimeout(() => finishEventPollWaiter(waiter, true), wait)
  waiter.timer.unref?.()
  req.once('close', () => finishEventPollWaiter(waiter, false))
  // 事件可能刚好在首次检查和加入等待集合之间到达，加入后再检查一次避免漏唤醒。
  if (eventPollPayload(kind, since, true).events.length) finishEventPollWaiter(waiter, true)
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
    let current
    try {
      const headers = dshUpstreamHeaders()
      current = Object.keys(headers).length ? new WebSocket(url, { headers }) : new WebSocket(url)
      ws = current
    } catch (err) {
      state.lastError = String(err?.message || err)
      state.connected = false
      state.reconnects++
      schedule()
      return
    }
    let finished = false
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer)
      connectTimer = null
    }
    // Node WebSocket 在 CONNECTING 阶段失败时可能只触发 error，
    // 调用 close() 后不保证再触发 close。每次尝试因此必须有一个
    // 幂等的收口，任何 error/close/timeout 都只安排一次重连。
    const finishAndRetry = (closeCode = 0, closeReason = '') => {
      if (finished) return
      finished = true
      clearConnectTimer()
      state.connected = false
      state.lastCloseCode = Number(closeCode) || 0
      state.lastCloseReason = String(closeReason || '')
      if (ws === current) ws = null
      if (stopped) return
      state.reconnects++
      schedule()
    }
    connectTimer = setTimeout(() => {
      if (!finished && ws === current && current.readyState === 0) {
        state.lastError = 'websocket connect timeout'
        finishAndRetry()
        try { current.close() } catch {}
      }
    }, WS_UPGRADE_TIMEOUT_MS)
    connectTimer.unref?.()
    current.onopen = () => {
      if (finished || ws !== current || stopped) {
        try { current.close() } catch {}
        return
      }
      clearConnectTimer()
      state.connected = true
      state.lastConnectAt = Date.now()
      state.lastError = ''
      state.attempt = 0
    }
    current.onmessage = (ev) => {
      if (stopped) return
      try {
        const data = typeof ev.data === 'string' ? ev.data : Buffer.isBuffer(ev.data) ? ev.data.toString() : String(ev.data)
        pushEvent(kind, JSON.parse(data), data)
      } catch {}
    }
    current.onclose = (ev) => {
      finishAndRetry(ev?.code, ev?.reason)
    }
    current.onerror = (err) => {
      if (finished) return
      state.lastError = String(err?.error?.message || err?.message || 'websocket error')
      finishAndRetry()
      try { current.close() } catch {}
    }
  }
  connect()
  return {
    kind,
    reconnectNow() {
      if (stopped || state.connected || ws?.readyState === 0) return
      clearTimeout(retryTimer)
      retryTimer = null
      state.attempt = 0
      connect()
    },
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

function legacyPush(kind, payload, rpcId = crypto.randomUUID()) {
  pushEvent(kind, { rpcId, payload })
}

function openModernSessionStream(ws, sessionId) {
  if (!sessionId || ws.readyState !== 1) return
  const streamId = 'session:' + sessionId
  ws.send(JSON.stringify({
    type: 'open', streamId, endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId } } } },
  }))
}

function applyModernControlFrame(value) {
  if (value?.type === 'baseline') {
    for (const [sessionId, items] of Object.entries(value.value?.queues || {})) {
      legacyPush('mux', { type: 'session/queue', sessionId, items })
    }
    for (const [sessionId, jobs] of Object.entries(value.value?.jobs || {})) {
      legacyPush('mux', { type: 'session/jobs', sessionId, jobs })
    }
    for (const [sessionId, block] of Object.entries(value.value?.projections || {})) {
      for (const [key, projection] of Object.entries(block?.values || {})) {
        legacyPush('mux', { type: 'session/projection', sessionId, key, value: projection, seq: block?.asOfSeq ?? 0 })
      }
    }
    return
  }
  if (value?.type === 'queue') legacyPush('mux', { type: 'session/queue', sessionId: value.sessionId, items: value.items || [] })
  else if (value?.type === 'jobs') legacyPush('mux', { type: 'session/jobs', sessionId: value.sessionId, jobs: value.jobs || [] })
  else if (value?.type === 'projection') legacyPush('mux', {
    type: 'session/projection', sessionId: value.sessionId, key: value.key, value: value.value, seq: value.seq,
  })
}

function applyModernWorkspaceFrame(value) {
  if (value?.type === 'baseline') {
    modernState.workspaces = {
      items: Array.isArray(value.value?.items) ? value.value.items : [],
      archivedSessionIds: Array.isArray(value.value?.archivedSessionIds) ? value.value.archivedSessionIds : [],
    }
    return
  }
  if (value?.type === 'upsert' && value.workspace) {
    const items = modernState.workspaces.items.filter(item => item.workspaceId !== value.workspace.workspaceId)
    items.push(value.workspace)
    modernState.workspaces = { ...modernState.workspaces, items }
    legacyPush('host', { type: 'host/workspace-changed', workspace: value.workspace })
  } else if (value?.type === 'remove') {
    modernState.workspaces = {
      ...modernState.workspaces,
      items: modernState.workspaces.items.filter(item => item.workspaceId !== value.workspaceId),
    }
    legacyPush('host', { type: 'host/workspace-removed', workspaceId: value.workspaceId })
  } else if (value?.type === 'order') {
    const byId = new Map(modernState.workspaces.items.map(item => [item.workspaceId, item]))
    const ordered = (value.workspaceIds || []).map(id => byId.get(id)).filter(Boolean)
    for (const item of modernState.workspaces.items) if (!value.workspaceIds?.includes(item.workspaceId)) ordered.push(item)
    modernState.workspaces = { ...modernState.workspaces, items: ordered }
    legacyPush('host', { type: 'host/workspace-order-changed', workspaceIds: value.workspaceIds || [] })
  } else if (value?.type === 'archived') {
    modernState.workspaces = { ...modernState.workspaces, archivedSessionIds: value.archivedSessionIds || [] }
    legacyPush('host', { type: 'host/archived-sessions-changed', archivedSessionIds: value.archivedSessionIds || [] })
  }
}

function applyModernSessionFrame(sessionId, value) {
  if (value?.type === 'snapshot') {
    modernState.sessionCursors.set(sessionId, value.cursor)
    legacyPush('mux', { type: 'session/subscribed', sessionId, lastSeq: value.cursor })
    for (const record of value.records || []) {
      if (record?.event) legacyPush('mux', { type: 'session/event', sessionId, event: record.event })
    }
    for (const [key, projection] of Object.entries(value.projections?.values || {})) {
      legacyPush('mux', { type: 'session/projection', sessionId, key, value: projection, seq: value.projections?.asOfSeq ?? value.cursor })
    }
    return
  }
  if (value?.type === 'event' && value.event) {
    modernState.sessionCursors.set(sessionId, value.event.seq)
    legacyPush('mux', { type: 'session/event', sessionId, event: value.event })
  }
}

function resolveModernPendingEvent(eventId, cancelled = false) {
  const pending = modernState.pendingEvents.get(eventId)
  if (!pending) return
  modernState.pendingEvents.delete(eventId)
  if (pending.event === 'approval/request') {
    legacyPush('mux', {
      type: 'approval/resolved', sessionId: pending.sessionId, approvalId: eventId,
      outcome: cancelled ? 'cancelled' : pending.outcome,
    })
  } else if (pending.event === 'user-questions/request') {
    legacyPush('mux', {
      type: 'question/resolved', sessionId: pending.sessionId, questionRpcId: eventId,
      outcome: cancelled ? 'cancelled' : 'answered',
    })
  }
}

function applyModernRemoteEvent(ws, value) {
  if (value?.type === 'ready') {
    modernState.eventClientId = value.clientId || ''
    modernState.home = value.host?.home || modernState.home
    return
  }
  if (value?.type === 'cancel') {
    resolveModernPendingEvent(value.eventId, true)
    return
  }
  if (value?.type === 'waterfall') {
    const sessionId = value.agentId
    modernState.pendingEvents.set(value.eventId, { event: value.event, sessionId, outcome: '' })
    if (value.event === 'approval/request') {
      legacyPush('mux', {
        type: 'approval/requested', sessionId, approvalId: value.eventId,
        toolName: value.request?.toolName || '',
        ...(value.request?.callId === undefined ? {} : { callId: value.request.callId }),
        ...(value.request?.reason === undefined ? {} : { reason: value.request.reason }),
      }, value.eventId)
    } else if (value.event === 'user-questions/request') {
      legacyPush('mux', { type: 'question/requested', sessionId, questions: value.request?.questions || [] }, value.eventId)
    }
    return
  }
  if (value?.type !== 'emit') return
  const args = value.args || []
  if (value.event === 'api-session/added') {
    const summary = args[0]
    if (summary?.sessionId) {
      modernState.sessions.set(summary.sessionId, summary)
      openModernSessionStream(ws, summary.sessionId)
      legacyPush('host', {
        type: 'host/session-added', sessionId: summary.sessionId, blank: !!summary.blank,
        ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
        ...(summary.origin === undefined ? {} : { origin: summary.origin }),
        ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
      })
    }
  } else if (value.event === 'api-session/removed') {
    modernState.sessions.delete(args[0])
    modernState.sessionCursors.delete(args[0])
    try { ws.send(JSON.stringify({ type: 'cancel', streamId: 'session:' + args[0] })) } catch {}
    legacyPush('host', { type: 'host/session-removed', sessionId: args[0] })
  } else if (value.event === 'api-session/status') {
    legacyPush('host', { type: 'host/session-status', sessionId: args[0], running: !!args[1] })
  } else if (value.event === 'api-session/error') {
    legacyPush('host', { type: 'host/agent-error', sessionId: args[0], message: String(args[1] || '') })
  } else {
    legacyPush('host', { type: 'host/remote-event', event: value.event, args })
  }
}

function startModernEventCollector() {
  if (typeof WebSocket !== 'function') return null
  let ws = null
  let stopped = false
  let retryTimer = null
  let connectTimer = null
  let attempt = 0
  const scheme = UPSTREAM.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${scheme}://${UPSTREAM_AUTHORITY}/api/remote.mux`
  const setConnected = (connected, error = '') => {
    for (const state of Object.values(eventCollectorState)) {
      state.connected = connected
      if (connected) {
        state.lastConnectAt = Date.now()
        state.lastError = ''
        state.attempt = 0
      } else if (error) state.lastError = error
    }
  }
  const schedule = () => {
    if (stopped || retryTimer) return
    const delay = Math.round(Math.min(1500 * Math.pow(2, attempt++), 60000) * (0.8 + Math.random() * 0.4))
    retryTimer = setTimeout(() => { retryTimer = null; connect() }, delay)
    retryTimer.unref?.()
  }
  const connect = () => {
    if (stopped) return
    let current
    try {
      const headers = dshUpstreamHeaders()
      current = Object.keys(headers).length ? new WebSocket(url, { headers }) : new WebSocket(url)
      ws = current
    } catch (error) {
      setConnected(false, String(error?.message || error))
      schedule()
      return
    }
    let finished = false
    const finish = (code = 0, reason = '', error = '') => {
      if (finished) return
      finished = true
      clearTimeout(connectTimer)
      modernState.eventClientId = ''
      setConnected(false, error)
      for (const state of Object.values(eventCollectorState)) {
        state.lastCloseCode = Number(code) || 0
        state.lastCloseReason = String(reason || '')
        state.reconnects++
      }
      if (ws === current) ws = null
      if (!stopped) schedule()
    }
    connectTimer = setTimeout(() => {
      finish(0, '', 'websocket connect timeout')
      try { current.close() } catch {}
    }, WS_UPGRADE_TIMEOUT_MS)
    connectTimer.unref?.()
    current.onopen = () => {
      if (finished || stopped || ws !== current) return
      clearTimeout(connectTimer)
      attempt = 0
      setConnected(true)
      current.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
      current.send(JSON.stringify({ type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: {} } }))
      current.send(JSON.stringify({ type: 'open', streamId: 'workspaces', endpoint: 'workspace/follow', payload: { args: {} } }))
      for (const sessionId of modernState.sessions.keys()) openModernSessionStream(current, sessionId)
    }
    current.onmessage = ev => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : Buffer.isBuffer(ev.data) ? ev.data.toString() : String(ev.data)
        const frame = JSON.parse(data)
        if (frame.type === 'error') {
          const message = frame.error?.message || 'modern stream error'
          for (const state of Object.values(eventCollectorState)) state.lastError = message
          legacyPush('mux', { type: 'stream/error', error: frame.error || { message } })
          return
        }
        if (frame.type !== 'item') return
        if (frame.streamId === 'events') applyModernRemoteEvent(current, frame.value)
        else if (frame.streamId === 'control') applyModernControlFrame(frame.value)
        else if (frame.streamId === 'workspaces') applyModernWorkspaceFrame(frame.value)
        else if (frame.streamId.startsWith('session:')) applyModernSessionFrame(frame.streamId.slice(8), frame.value)
      } catch {}
    }
    current.onclose = ev => finish(ev?.code, ev?.reason)
    current.onerror = err => {
      finish(0, '', String(err?.error?.message || err?.message || 'websocket error'))
      try { current.close() } catch {}
    }
  }
  connect()
  return {
    kind: 'modern',
    reconnectNow() {
      if (stopped || ws?.readyState === 0 || ws?.readyState === 1) return
      clearTimeout(retryTimer)
      retryTimer = null
      attempt = 0
      connect()
    },
    close() {
      stopped = true
      clearTimeout(retryTimer)
      clearTimeout(connectTimer)
      try { ws?.close() } catch {}
    },
  }
}

async function startCompatibleEventCollectors() {
  if (await detectUpstreamApiFlavor() === 'modern') {
    const collector = startModernEventCollector()
    eventCollectors.mux = collector
    eventCollectors.host = collector
    return
  }
  eventCollectors.mux = startEventCollector('mux')
  eventCollectors.host = startEventCollector('host')
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
// 反馈收集器: 环境变量可覆盖, 默认使用 Tailscale Funnel 提供的公网 HTTPS
// 入口。这里是公开的 ts.net 域名，不要求提交反馈的用户加入 tailnet。
const FEEDBACK_URL = process.env.DSH_REMOTE_FEEDBACK_URL || 'https://vm-0-2-ubuntu.tail1f6fc4.ts.net/submit'

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

let announcementsCache = null
let announcementsFetch = null

function parseAnnouncements(raw) {
  if (Buffer.byteLength(raw, 'utf8') > ANNOUNCEMENTS_MAX_BYTES) throw new Error('announcements too large')
  const data = JSON.parse(raw)
  const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [data])
  if (items.length > 200 || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('invalid announcements payload')
  }
  return { data: Array.isArray(data) ? { items: data } : data, items }
}

function localAnnouncements() {
  try {
    const raw = fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8')
    const parsed = parseAnnouncements(raw)
    return { ...parsed, raw: JSON.stringify(parsed.data), source: 'local', stale: false, fetchedAt: Date.now() }
  } catch {
    const data = { items: [] }
    return { data, items: data.items, raw: JSON.stringify(data), source: 'empty', stale: false, fetchedAt: Date.now() }
  }
}

function safeAnnouncementsUrl(value) {
  const target = new URL(value)
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(target.hostname)
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
    throw new Error('central announcements URL must use HTTPS')
  }
  return target.href
}

async function loadCentralAnnouncements(force = false) {
  const now = Date.now()
  if (!ANNOUNCEMENTS_URL) return localAnnouncements()
  if (!force && announcementsCache && now - announcementsCache.fetchedAt < ANNOUNCEMENTS_CACHE_MS) return announcementsCache
  if (announcementsFetch) return announcementsFetch
  announcementsFetch = (async () => {
    try {
      const headers = { accept: 'application/json' }
      if (announcementsCache?.etag) headers['if-none-match'] = announcementsCache.etag
      const res = await fetch(safeAnnouncementsUrl(ANNOUNCEMENTS_URL), {
        headers,
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      })
      safeAnnouncementsUrl(res.url)
      if (res.status === 304 && announcementsCache) {
        announcementsCache = { ...announcementsCache, fetchedAt: now, stale: false }
        return announcementsCache
      }
      if (!res.ok) throw new Error(`central announcements HTTP ${res.status}`)
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared > ANNOUNCEMENTS_MAX_BYTES) throw new Error('announcements too large')
      const raw = await res.text()
      const parsed = parseAnnouncements(raw)
      announcementsCache = {
        ...parsed,
        raw: JSON.stringify(parsed.data),
        source: 'central',
        stale: false,
        fetchedAt: now,
        etag: String(res.headers.get('etag') || ''),
      }
      return announcementsCache
    } catch (err) {
      if (announcementsCache?.source === 'central') {
        return { ...announcementsCache, stale: true, error: String(err?.message || err) }
      }
      return { ...localAnnouncements(), error: String(err?.message || err) }
    } finally {
      announcementsFetch = null
    }
  })()
  return announcementsFetch
}

async function serveAnnouncements(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const snapshot = await loadCentralAnnouncements()
  cors(res)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(snapshot.raw),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-dsh-announcements-source': snapshot.source,
    ...(snapshot.stale ? { warning: '110 - "Response is stale"' } : {}),
  })
  if (req.method === 'HEAD') res.end()
  else res.end(snapshot.raw)
}

function findPollVote(items, announcementId, pollId, optionId) {
  const announcement = items.find(item => String(item?.id || '').trim() === announcementId)
  const poll = announcement?.poll
  if (!poll || String(poll.id || '').trim() !== pollId || !Array.isArray(poll.options)) return { error: 'poll not found' }
  const option = poll.options.find(item => String(item?.id || '').trim() === optionId)
  if (!option) return { error: 'poll option not found' }
  const optionLabel = String(option.label || '').trim().slice(0, 200)
  if (!optionLabel) return { error: 'poll option invalid' }
  return { announcementId, pollId, optionId, optionLabel }
}

async function validatePollVote(payload) {
  const announcementId = String(payload.announcementId || '').trim()
  const pollId = String(payload.pollId || '').trim()
  const optionId = String(payload.optionId || '').trim()
  if (!announcementId || !pollId || !optionId) return { error: 'poll fields required' }
  if (announcementId.length > 120 || pollId.length > 120 || optionId.length > 120) return { error: 'poll fields too long' }
  let snapshot = await loadCentralAnnouncements()
  let result = findPollVote(snapshot.items, announcementId, pollId, optionId)
  // 中央公告刚发布、网关缓存尚未到期时，投票请求触发一次强制刷新，避免出现公告可见但选项暂不可投。
  if (result.error && ANNOUNCEMENTS_URL) {
    snapshot = await loadCentralAnnouncements(true)
    result = findPollVote(snapshot.items, announcementId, pollId, optionId)
  }
  return result
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
  req.on('end', async () => {
    let payload
    try {
      payload = JSON.parse(body || '{}')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }
    const type = payload.type
    let message = String(payload.message || '').trim()
    const contact = String(payload.contact || '').trim()
    const appVersion = String(payload.appVersion || '').trim()
    if (!['bug', 'suggestion', 'other', 'poll'].includes(type)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'invalid type', expect: 'bug|suggestion|other|poll' }))
      return
    }
    const pollVote = type === 'poll' ? await validatePollVote(payload) : null
    if (pollVote?.error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: pollVote.error }))
      return
    }
    // 公网收集器的旧版只保留 type/message 等通用字段。同时发送结构化
    // 字段和稳定的 message 编码，旧收集器也能用 scripts/summarize-polls.mjs 汇总。
    if (pollVote) message = 'POLL ' + JSON.stringify({ announcementId: pollVote.announcementId, pollId: pollVote.pollId, optionId: pollVote.optionId })
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
        clientIp: maskIp(ip),
        ...(pollVote || {})
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
  if (pathname === '/announcements.json') {
    void serveAnnouncements(req, res)
    return
  }
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
    headers: dshUpstreamHeaders(),
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
    if (!adminAuthorized(req, url)) {
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
        platform: process.platform,
        hostname: os.hostname(),
        lanIPs: lanAddresses(),
        startedAt: STARTED_AT,
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        host: HOST,
        port: PORT,
        protocol: { version: PROTOCOL_VERSION },
        capabilities: CAPABILITIES,
        dshControl: DSH_CONTROL_SUPPORT,
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
        deviceKeys: deviceKeysPayload(),
        totalRequests,
        authFailures,
        deviceCount: devices.size,
        onlineCount: [...devices.values()].filter(d => Date.now() - d.lastSeen < 60_000).length,
        events: eventCollectorState,
        devices: deviceViews()
      }))
    })
    return
  }
  if (sub.startsWith('/device-keys/') && req.method === 'POST') {
    if (!adminAuthorized(req, url)) {
      authFailures++
      touchDevice(req, { failedAuth: true })
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 8192) req.destroy()
    })
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'bad-request', detail: '请求内容不是有效 JSON' }))
        return
      }
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      if (sub === '/device-keys/mode') {
        if (typeof payload.enabled !== 'boolean') return send(400, { error: 'bad-request', detail: 'enabled 必须是布尔值' })
        if (payload.enabled && deviceKeyState.keys.length === 0 && !createDeviceKey(payload.note || '我的设备')) {
          return send(500, { error: 'write-failed', detail: '无法创建首个设备密钥' })
        }
        const previous = deviceKeyState.enabled
        deviceKeyState.enabled = payload.enabled
        if (!saveDeviceKeys()) {
          deviceKeyState.enabled = previous
          return send(500, { error: 'write-failed', detail: '无法保存独立设备密钥设置' })
        }
        wsTickets.clear()
        const disconnected = kickRemoteClients()
        return send(200, { ok: true, disconnected, deviceKeys: deviceKeysPayload() })
      }
      if (sub === '/device-keys/create') {
        if (deviceKeyState.keys.length >= 100) return send(409, { error: 'too-many-device-keys', detail: '设备密钥数量已达到上限' })
        const record = createDeviceKey(payload.note)
        return record
          ? send(201, { ok: true, entry: { ...record }, deviceKeys: deviceKeysPayload() })
          : send(500, { error: 'write-failed', detail: '无法保存设备密钥' })
      }
      const id = String(payload.id || '').trim()
      const index = deviceKeyState.keys.findIndex(record => record.id === id)
      if (index < 0) return send(404, { error: 'device-key-not-found', detail: '找不到该设备密钥' })
      const record = deviceKeyState.keys[index]
      if (sub === '/device-keys/note') {
        const previous = { note: record.note, updatedAt: record.updatedAt }
        record.note = String(payload.note || '').trim().slice(0, 40)
        record.updatedAt = Date.now()
        if (!saveDeviceKeys()) {
          Object.assign(record, previous)
          return send(500, { error: 'write-failed', detail: '无法保存备注' })
        }
        return send(200, { ok: true, entry: { ...record } })
      }
      if (sub === '/device-keys/rotate') {
        const previous = { token: record.token, updatedAt: record.updatedAt, lastUsedAt: record.lastUsedAt }
        record.token = newAccessToken()
        record.updatedAt = Date.now()
        record.lastUsedAt = 0
        if (!saveDeviceKeys()) {
          Object.assign(record, previous)
          return send(500, { error: 'write-failed', detail: '无法轮换设备令牌' })
        }
        wsTickets.clear()
        const disconnected = kickCredential(record.id)
        return send(200, { ok: true, disconnected, entry: { ...record } })
      }
      if (sub === '/device-keys/revoke') {
        deviceKeyState.keys.splice(index, 1)
        if (!saveDeviceKeys()) {
          deviceKeyState.keys.splice(index, 0, record)
          return send(500, { error: 'write-failed', detail: '无法退出设备' })
        }
        wsTickets.clear()
        const disconnected = kickCredential(record.id)
        return send(200, { ok: true, disconnected, id: record.id })
      }
      return send(404, { error: 'not-found' })
    })
    return
  }
  if (sub === '/token/rotate' && req.method === 'POST') {
    if (!adminAuthorized(req, url)) {
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
    kickRemoteClients()
    touchDevice(req)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, token: r.token, tokenMasked: r.token.slice(0, 4) + '…' + r.token.slice(-4) }))
    return
  }
  if (sub === '/shutdown' && req.method === 'POST') {
    if (!adminAuthorized(req, url)) {
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
    if (!adminAuthorized(req, url)) {
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
    if (!adminAuthorized(req, url)) {
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
function fsJson(res, status, body, extraHeaders = {}) {
  cors(res)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
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

function fsInsideRootFor(pathApi, abs, root, caseInsensitive = false) {
  let candidate = pathApi.resolve(String(abs || ''))
  let boundary = pathApi.resolve(String(root || ''))
  if (caseInsensitive) {
    candidate = candidate.toLowerCase()
    boundary = boundary.toLowerCase()
  }
  const relative = pathApi.relative(boundary, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + pathApi.sep) && !pathApi.isAbsolute(relative))
}

function fsInsideRoot(abs, root) {
  return fsInsideRootFor(path, abs, root, process.platform === 'win32')
}

function fsWorkspacePath(value) {
  const raw = String(value?.path || value?.cwd || value?.root || '').trim()
  if (!raw || !path.isAbsolute(raw)) return ''
  return path.resolve(raw)
}

async function loadFsWorkspaceRoots(force = false) {
  const now = Date.now()
  if (!force && now - fsWorkspaceRootsCache.fetchedAt < FS_WORKSPACE_CACHE_MS) return fsWorkspaceRootsCache
  if (fsWorkspaceRootsFetch) return fsWorkspaceRootsFetch
  fsWorkspaceRootsFetch = (async () => {
    try {
      let value
      if (await detectUpstreamApiFlavor() === 'modern') {
        value = modernState.workspaces
      } else {
        const target = new URL('/api/workspace.list', UPSTREAM)
        const res = await fetch(target, {
          method: 'POST',
          headers: dshUpstreamHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace.list', payload: {} }),
          signal: AbortSignal.timeout(Math.min(8000, UPSTREAM_REQUEST_TIMEOUT_MS)),
        })
        if (!res.ok) throw new Error(`workspace.list HTTP ${res.status}`)
        const body = await res.json()
        value = body?.result?.ok ? body.result.value : null
      }
      const items = Array.isArray(value?.items) ? value.items : []
      const roots = [...new Set(items.map(fsWorkspacePath).filter(Boolean))]
      const reals = roots.map(root => { try { return fs.realpathSync(root) } catch { return null } }).filter(Boolean)
      fsWorkspaceRootsCache = { roots, reals, fetchedAt: Date.now() }
    } catch {
      // DSH 重启期间保留上次成功的工作区根；缓存为空时仍仅允许显式 FS_ROOTS。
      fsWorkspaceRootsCache = { ...fsWorkspaceRootsCache, fetchedAt: Date.now() }
    } finally {
      fsWorkspaceRootsFetch = null
    }
    return fsWorkspaceRootsCache
  })()
  return fsWorkspaceRootsFetch
}

/** 把用户给的 path 解析为绝对路径，并仅允许显式根或 DSH 已登记工作区。 */
async function fsResolve(input) {
  const raw = String(input ?? '').trim()
  let abs
  if (!raw || raw === '~') abs = FS_ROOTS[0]
  else if (/^~[\\/]/.test(raw)) abs = path.resolve(FS_DEFAULT_ROOT, raw.slice(2))
  else if (path.isAbsolute(raw)) abs = path.resolve(raw)
  else abs = path.resolve(FS_ROOTS[0], raw) // 相对路径按默认根解析
  if (FS_ROOTS.some(root => fsInsideRoot(abs, root))) return { abs }
  let workspaces = await loadFsWorkspaceRoots(false)
  if (workspaces.roots.some(root => fsInsideRoot(abs, root))) return { abs }
  // 新建/刚加入的工作区可能还没进入 15s 缓存，未命中时强制刷新一次。
  workspaces = await loadFsWorkspaceRoots(true)
  if (workspaces.roots.some(root => fsInsideRoot(abs, root))) return { abs }
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

function fsEntityTag(st) {
  return `"${Number(st.size).toString(16)}-${Math.floor(Number(st.mtimeMs)).toString(16)}"`
}

function fsIfRangeMatches(value, etag, mtimeMs) {
  if (!value) return true
  if (String(value).trim() === etag) return true
  const time = Date.parse(String(value))
  return Number.isFinite(time) && time >= Math.floor(Number(mtimeMs) / 1000) * 1000
}

async function fsList(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  const resolved = await fsResolve(url.searchParams.get('path') ?? '')
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
        path: full,
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
  fsJson(res, 200, {
    path: resolved.abs,
    entries,
    roots: FS_ROOTS,
    platform: process.platform,
    separator: path.sep,
  })
}

async function fsFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  const resolved = await fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })

  let st
  try { st = fs.statSync(checked.abs) } catch (err) {
    return fsJson(res, err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' })
  }
  if (!st.isFile()) return fsJson(res, 400, { error: 'not-a-file' })

  const etag = fsEntityTag(st)
  const lastModified = st.mtime.toUTCString()
  if (!req.headers.range && req.headers['if-none-match'] === etag) {
    cors(res)
    res.writeHead(304, { etag, 'last-modified': lastModified, 'cache-control': 'no-cache' })
    res.end()
    return
  }
  const range = fsIfRangeMatches(req.headers['if-range'], etag, st.mtimeMs)
    ? fsParseRange(req.headers.range, st.size)
    : null
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
    etag,
    'last-modified': lastModified,
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

async function fsPreview(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  const resolved = await fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })

  let st
  try { st = fs.statSync(checked.abs) } catch (err) {
    return fsJson(res, err.code === 'ENOENT' ? 404 : 403, { error: err.code === 'ENOENT' ? 'not-found' : 'permission-denied' })
  }
  if (!st.isFile()) return fsJson(res, 400, { error: 'not-a-file' })

  const name = path.basename(checked.abs)
  const lowerName = name.toLowerCase()
  const extension = lowerName === 'dockerfile' ? '.dockerfile' : path.extname(lowerName)
  if (!FS_PREVIEW_EXTENSIONS.has(extension)) {
    return fsJson(res, 415, { error: 'preview-unsupported', extension })
  }
  if (st.size > FS_PREVIEW_MAX) {
    return fsJson(res, 413, { error: 'preview-too-large', size: st.size, limit: FS_PREVIEW_MAX })
  }

  let content
  try {
    const bytes = fs.readFileSync(checked.abs)
    if (bytes.includes(0)) return fsJson(res, 415, { error: 'preview-binary' })
    content = bytes.toString('utf8')
  } catch (err) {
    return fsJson(res, 403, { error: 'permission-denied', detail: err.message })
  }
  fsJson(res, 200, { name, path: resolved.abs, extension, size: st.size, content })
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
const uploadPartDirs = new Set()
function fsActiveKey(dirReal, name, session) {
  return dirReal + '\n' + name + '\n' + (session || '')
}

function rememberUploadDir(dirReal) {
  uploadPartDirs.add(dirReal)
}

function uploadDirHasActive(dirReal) {
  const prefix = dirReal + '\n'
  for (const key of activeUploads.keys()) if (key.startsWith(prefix)) return true
  return false
}

function cleanupExpiredUploadParts(dirReal = '') {
  const dirs = dirReal ? [dirReal] : [...uploadPartDirs]
  const now = Date.now()
  for (const dir of dirs) {
    if (uploadDirHasActive(dir)) continue
    let entries
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (!name.startsWith('.') || !name.includes('.dsh-remote-part-')) continue
      const file = path.join(dir, name)
      try {
        const st = fs.statSync(file)
        if (st.isFile() && now - st.mtimeMs > FS_UPLOAD_TTL_MS) fs.unlinkSync(file)
      } catch {}
    }
  }
}

const uploadCleanupTimer = setInterval(() => cleanupExpiredUploadParts(), 15 * 60 * 1000)
uploadCleanupTimer.unref?.()

function fsUploadHeaders(offset, length = null, expiresAt = null) {
  const headers = { 'upload-offset': String(Math.max(0, Number(offset) || 0)) }
  if (Number.isSafeInteger(length) && length >= 0) headers['upload-length'] = String(length)
  if (Number.isFinite(expiresAt)) headers['upload-expires'] = new Date(expiresAt).toUTCString()
  return headers
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

async function fsUploadProbe(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  touchDevice(req)
  const resolved = await fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })
  rememberUploadDir(checked.abs)
  cleanupExpiredUploadParts(checked.abs)
  const name = url.searchParams.get('name') || ''
  if (!fsValidName(name)) return fsJson(res, 400, { error: 'bad-name' })
  const part = fsPartPath(checked.abs, name, url.searchParams.get('session') || 'default')
  let partialSize = 0, partExists = false
  let expiresAt = null
  try {
    const st = fs.statSync(part)
    if (st.isFile()) { partialSize = st.size; partExists = true; expiresAt = st.mtimeMs + FS_UPLOAD_TTL_MS }
  } catch {}
  const lengthRaw = url.searchParams.get('size')
  const uploadLength = lengthRaw === null || lengthRaw === '' ? null : Number(lengthRaw)
  if (uploadLength !== null && (!Number.isSafeInteger(uploadLength) || uploadLength < 0)) {
    return fsJson(res, 400, { error: 'bad-length', detail: 'size 必须是非负整数' })
  }
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
    targetSize,
    uploadLength,
    expiresAt
  }, fsUploadHeaders(partialSize, uploadLength, expiresAt))
}

/** POST /fs/mkdir?path=<parent>&name=<directory> 创建一个工作区目录。 */
async function fsMkdir(req, res, url) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  touchDevice(req)
  const resolved = await fsResolve(url.searchParams.get('path') ?? '')
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
  rememberUploadDir(dirReal)
  cleanupExpiredUploadParts(dirReal)
  const name = url.searchParams.get('name') || ''
  if (!fsValidName(name)) return fsJson(res, 400, { error: 'bad-name', detail: '文件名不能为空且不能包含路径分隔符' })
  const session = url.searchParams.get('session') || ''
  if (!session) return fsJson(res, 400, { error: 'missing-session', detail: '断点续传需要 session 参数' })
  const queryOffsetRaw = url.searchParams.get('offset')
  const headerOffsetRaw = req.headers['upload-offset']
  const offsetRaw = queryOffsetRaw ?? headerOffsetRaw
  const offset = Number(offsetRaw)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return fsJson(res, 400, { error: 'bad-offset', detail: 'offset 必须是非负整数' })
  }
  if (queryOffsetRaw !== null && headerOffsetRaw !== undefined && Number(headerOffsetRaw) !== offset) {
    return fsJson(res, 400, { error: 'offset-mismatch', detail: 'URL offset 与 Upload-Offset 不一致' })
  }
  const lengthRaw = url.searchParams.get('size') ?? req.headers['upload-length']
  const uploadLength = lengthRaw === null || lengthRaw === undefined || lengthRaw === '' ? null : Number(lengthRaw)
  if (uploadLength !== null && (!Number.isSafeInteger(uploadLength) || uploadLength < 0)) {
    return fsJson(res, 400, { error: 'bad-length', detail: 'size/Upload-Length 必须是非负整数' })
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
        if (uploadLength !== null && total > uploadLength) {
          fsJson(res, 409, { error: 'length-exceeded', size: total, uploadLength, session }, fsUploadHeaders(total, uploadLength, Date.now() + FS_UPLOAD_TTL_MS))
          return
        }
        if (!finish) {
          fsJson(res, 200, { ok: true, partial: true, name, size: total, offset: total, session, uploadLength }, fsUploadHeaders(total, uploadLength, Date.now() + FS_UPLOAD_TTL_MS))
          return
        }
        if (uploadLength !== null && total !== uploadLength) {
          fsJson(res, 409, { error: 'length-incomplete', size: total, uploadLength, session }, fsUploadHeaders(total, uploadLength, Date.now() + FS_UPLOAD_TTL_MS))
          return
        }
        const commit = (actualSha256) => {
          try {
            const ts = fsTargetState(target)
            if (ts.status) return fsJson(res, ts.status, { error: ts.error, detail: ts.detail })
            if (ts.exists && !overwrite) return fsJson(res, 409, { error: 'conflict', detail: '文件已存在, overwrite=1 可覆盖' })
            if (ts.exists) fs.rmSync(target, { force: true })
            fs.renameSync(part, target)
            fsJson(res, 201, { ok: true, name, path: path.join(dirLex, name), size: total, resumed: offset > 0, session, uploadLength, ...(actualSha256 ? { sha256: actualSha256 } : {}) }, fsUploadHeaders(total, uploadLength))
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
              return fsJson(res, 422, { error: 'checksum-mismatch', expected: sha256Expected, actual, partialSize: total, session }, fsUploadHeaders(total, uploadLength, Date.now() + FS_UPLOAD_TTL_MS))
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
async function fsUploadControl(req, res, url) {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  if (!fsAuthorized(req, url, res)) return
  touchDevice(req)
  const resolved = await fsResolve(url.searchParams.get('path') ?? '')
  if (resolved.error) return fsJson(res, resolved.error === 'forbidden' ? 403 : 404, { error: resolved.error })
  const checked = fsRealChecked(resolved.abs)
  if (checked.error) return fsJson(res, checked.error === 'forbidden' ? 403 : 404, { error: checked.error })
  rememberUploadDir(checked.abs)
  cleanupExpiredUploadParts(checked.abs)
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

async function serveFs(req, res, url) {
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
  if (sub === '/preview') return fsPreview(req, res, url)
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
    const resolved = await fsResolve(url.searchParams.get('path') ?? '')
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
async function proxyModernApi(req, res, url) {
  if (req.method !== 'POST' || url.pathname.startsWith('/remote/')) return false
  if (await detectUpstreamApiFlavor() !== 'modern') return false
  let raw = ''
  try {
    raw = await new Promise((resolve, reject) => {
      req.setEncoding('utf8')
      req.on('data', chunk => {
        raw += chunk
        if (raw.length > 4 * 1024 * 1024) reject(new Error('request body too large'))
      })
      req.once('end', () => resolve(raw))
      req.once('error', reject)
      req.once('aborted', () => reject(new Error('request aborted')))
    })
    const body = JSON.parse(raw || '{}')
    cors(res)
    if (url.pathname === '/api/respond') {
      const eventId = body.rpcId
      const pending = modernState.pendingEvents.get(eventId)
      if (!pending || !modernState.eventClientId) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ accepted: false }))
        return true
      }
      const value = body.result?.value
      const answer = pending.event === 'approval/request' ? value?.outcome : value?.answer
      pending.outcome = answer
      const response = await callUpstreamRemote('$events/result', {
        clientId: modernState.eventClientId,
        eventId,
        outcome: { kind: 'result', value: answer },
      })
      const accepted = response.status === 200 && response.body?.result?.ok === true
      if (accepted) resolveModernPendingEvent(eventId, false)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ accepted }))
      return true
    }
    if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'bad-request' }))
      return true
    }
    const translated = await translateModernRpc(body.method, body.payload || {}, body.rpcId)
    if (translated === null) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(legacyEnvelope(body.rpcId, modernError(`Remote method ${body.method} is unavailable on this DSH version`, 'method-unavailable'))))
      return true
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(translated))
    return true
  } catch (error) {
    if (!res.headersSent) {
      cors(res)
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'upstream-incompatible', detail: String(error?.message || error) }))
    return true
  }
}

function proxyLegacyApi(req, res, url) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (['host', 'authorization', 'cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
      'proxy-connection', 'accept-encoding', 'origin', 'referer',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
      'x-dsh-remote-client'].includes(key)) continue
    headers[k] = v
  }
  headers.host = UPSTREAM.host
  Object.assign(headers, dshUpstreamHeaders())
  // /remote/* 由 DSH 插件端点处理；插件侧用网关自身 token 鉴权。
  if (url.pathname.startsWith('/remote/')) headers.authorization = 'Bearer ' + TOKEN

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
  void proxyModernApi(req, res, url).then(handled => {
    if (!handled) proxyLegacyApi(req, res, url)
  }).catch(error => {
    cors(res)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'upstream-unreachable', detail: String(error?.message || error) }))
  })
}

// ---------- 其它 ----------
async function serveHealth(req, res, url) {
  const eventHealth = Object.fromEntries(Object.entries(eventCollectorState).map(([kind, state]) => [kind, {
    connected: state.connected,
    lastEventAt: state.lastEventAt,
    eventLagMs: state.lastEventAt ? Math.max(0, Date.now() - state.lastEventAt) : null,
    lastConnectAt: state.lastConnectAt,
    reconnects: state.reconnects,
    attempt: state.attempt,
    lastError: state.lastError,
    clients: state.clients,
  }]))
  const liveness = { ok: true, pid: process.pid, uptimeMs: Math.max(0, Date.now() - STARTED_AT), runtime: runtimeState }
  if (url?.searchParams.get('probe') === 'live') {
    cors(res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'dsh-remote', version: VERSION, probe: 'live', liveness }))
    return
  }
  let upstreamOk = false
  let upstreamReachable = false
  let upstreamStatus = 0
  let upstreamError = ''
  let timer = null
  try {
    const ctrl = new AbortController()
    timer = setTimeout(() => ctrl.abort(), 5000)
    const probeUrl = new URL(DSH_HEALTH_PATH, UPSTREAM).toString()
    const probe = await fetch(probeUrl, { headers: dshUpstreamHeaders(), signal: ctrl.signal, cache: 'no-store' })
    upstreamReachable = true
    upstreamStatus = probe.status
    upstreamOk = probe.ok
  } catch (err) {
    upstreamError = String(err?.message || err || '')
  } finally {
    if (timer) clearTimeout(timer)
  }
  const eventsOk = eventHealth.mux.connected && eventHealth.host.connected
  const readiness = { ok: upstreamOk && eventsOk, upstreamOk, eventsOk }
  const status = readiness.ok ? 'ready' : upstreamReachable ? 'degraded' : 'offline'
  cors(res)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    ok: true,
    service: 'dsh-remote',
    status,
    liveness,
    readiness,
    version: VERSION,
    protocol: { version: PROTOCOL_VERSION },
    capabilities: CAPABILITIES,
    dshControl: DSH_CONTROL_SUPPORT,
    pid: process.pid,
    upstream: UPSTREAM.origin,
    upstreamProbe: DSH_HEALTH_PATH,
    upstreamOk,
    upstreamReachable,
    upstreamStatus,
    ...(upstreamError ? { upstreamError } : {}),
    events: eventHealth,
    runtime: runtimeState,
  }))
}

function lanAddresses() {
  const out = [...ADVERTISED_HOSTS]
  let groups
  try { groups = Object.values(os.networkInterfaces()) } catch { return out }
  for (const infos of groups) {
    for (const info of infos || []) {
      if (info.family === 'IPv4' && !info.internal && !out.includes(info.address)) out.push(info.address)
    }
  }
  return out
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://dsh-remote.local')
    if (url.pathname === '/fs' || url.pathname.startsWith('/fs/')) return await serveFs(req, res, url)
    if (url.pathname === '/workbench' || url.pathname.startsWith('/workbench/')) return serveWorkbench(req, res, url)
    if (url.pathname === '/feedback') return serveFeedback(req, res, url)
    if (url.pathname.startsWith('/admin/api')) return serveAdminApi(req, res, url)
    if (url.pathname.startsWith('/stats')) return serveStats(req, res, url)
    if (url.pathname === '/api/ws-ticket') return serveWsTicket(req, res, url)
    if (url.pathname === '/api/events.poll') return serveEventPoll(req, res, url)
    if (url.pathname.startsWith('/remote/')) return proxyApi(req, res, url)
    if (url.pathname.startsWith('/api/')) return proxyApi(req, res, url)
    if (url.pathname === '/health') return serveHealth(req, res, url)
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
    if (['host', 'authorization', 'cookie', 'connection', 'upgrade', 'sec-websocket-key',
      'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol',
      'proxy-connection', 'accept-encoding', 'origin', 'referer',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
      'x-dsh-remote-client'].includes(key)) continue
    headers[k] = v
  }
  headers.host = UPSTREAM.host
  Object.assign(headers, dshUpstreamHeaders())
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
  const clientToken = deviceKeyState.enabled ? deviceKeyState.keys[0]?.token : TOKEN
  console.log('DSH Remote 网关 v' + VERSION + ' 已启动')
  console.log('  本机:  http://127.0.0.1:' + PORT + '/?token=' + (clientToken || '请在管理页创建设备密钥'))
  for (const ip of lanAddresses()) {
    console.log('  手机(同一网络): http://' + ip + ':' + PORT + '/?token=' + (clientToken || '请在管理页创建设备密钥'))
  }
  console.log('  管理页: http://127.0.0.1:' + PORT + '/admin')
  if (HOST === '127.0.0.1') {
    console.log('  提示: 监听在 127.0.0.1, 手机请改用 Tailscale serve 或设置 HOST=0.0.0.0')
  }
  console.log('  上游:  ' + UPSTREAM.origin + '  (Ctrl+C 退出)')
  // 事件轮询缓冲：网关自身上游 WS 采集，断线自动重连
  void startCompatibleEventCollectors()
  // 启动 8 秒后首查, 之后每 6 小时查一次 GitHub/镜像最新版
  setTimeout(() => checkForUpdates(false), 8000)
  setInterval(() => checkForUpdates(false), UPDATE_INTERVAL_MS)
  // 统计回填: 启动 2 秒后全量扫描一次, 之后每 5 分钟增量扫描(seq 游标保证幂等)
  scanStatsOnce(2000)
  setInterval(() => scanStatsOnce(0), 5 * 60 * 1000)
})
