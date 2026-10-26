/* dsh-remote DSH 插件 · Node half
 * 在 DSH Web 的 httpServer 上挂 /remote 前缀路由:
 *   - /remote/...         移动控制台 + 主机管理页静态资源
 *   - /remote/admin/api   管理控制台数据: 优先代理本地网关(完整设备监控/更新检查),
 *                         网关不可用时回退到插件模式主机状态
 * 浏览器侧入口由 client half 注册在 DSH「更多」菜单(见 client.js)。
 */
import { registerFileDeliveryTools } from './file-delivery.mjs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import net from 'node:net'
import { homedir, hostname, networkInterfaces, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createPluginCenter, detectProfile } from './plugin-center.mjs'
import { readCostInsights } from './insights.mjs'
import { readTeamInsights } from './teams.mjs'
import { readTaskBoard } from './task-board.mjs'
import { readPeakReminders } from './peak-reminders.mjs'
import { serveSessionFile } from './session-file.mjs'
import { createSkillsAdapter } from './skills.mjs'
import { registerDoctorSkill } from './doctor-skill.mjs'
import { readDoctorTarget, watchDoctorWorkspaces } from './doctor-target.mjs'

export const name = 'dsh-remote'
export const inject = ['webServer', 'commands', 'agents', 'connection']

const MOUNT = '/remote'
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const INDEX_FILE = 'index.html'
const LONG_RUNNING_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const LONG_RUNNING_COMMANDS = new Set(['export'])
const COMMAND_OPERATION_RETENTION_MS = 10 * 60_000
// 已登记的命令由 HTTP 请求之外的独立 promise 驱动。这样浏览器断连或等待到期
// 都不会中止长操作；状态仅保存在进程内，DSH 重启后会话事件重新成为权威来源。
const commandOperations = new Map()
const GATEWAY_SCRIPT = fileURLToPath(new URL('./gateway.cjs', import.meta.url))
const gatewayInstalled = existsSync(GATEWAY_SCRIPT)
// 本地网关管理 API 代理: 让插件抽屉显示与网关管理页完全一致的数据。
// 端口读取优先级: DSH_REMOTE_GATEWAY_PORT > ~/.dsh-remote/gateway-port > 8787
function gatewayPortFile() { return `${homedir()}/.dsh-remote/gateway-port` }

function readGatewayPort() {
  const valid = (v) => /^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 65535
  const envPort = process.env.DSH_REMOTE_GATEWAY_PORT
  if (valid(envPort)) return String(Number(envPort))
  try {
    const filePort = readFileSync(gatewayPortFile(), 'utf8').trim()
    if (valid(filePort)) return String(Number(filePort))
  } catch {}
  return '8787'
}

function gatewayBase() {
  return (process.env.DSH_REMOTE_GATEWAY || upstreamUrlForListener({ host: readGatewayHost(), port: readGatewayPort() })).replace(/\/+$/, '')
}

export function readGatewayHost() {
  if (process.env.DSH_REMOTE_GATEWAY_HOST) return process.env.DSH_REMOTE_GATEWAY_HOST
  if (process.env.HOST) return process.env.HOST
  try {
    const host = readFileSync(`${homedir()}/.dsh-remote/gateway-host`, 'utf8').trim()
    if (host) return host
  } catch {}
  return '0.0.0.0'
}

function gatewayToken() {
  if (process.env.DSH_REMOTE_TOKEN || process.env.TOKEN) return process.env.DSH_REMOTE_TOKEN || process.env.TOKEN
  try {
    return readFileSync(process.env.TOKEN_FILE || `${homedir()}/.dsh-remote/token`, 'utf8').trim() || ''
  } catch {
    return ''
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

let version = '0.0.0'
try {
  const v = JSON.parse(readFileSync(new URL('./public/version.json', import.meta.url), 'utf8'))
  if (v?.version) version = v.version
} catch {}

// DSH 实际监听地址由 apply 时从 webServer 服务读取
let dshListen = { host: '127.0.0.1', port: 3080 }
let dshConnection = null

// 监听通配地址不是连接目标；保留地址族，避免 IPv6-only 服务退回 IPv4。
export function upstreamUrlForListener({ host, port }) {
  let target = String(host || '127.0.0.1').replace(/^\[|\]$/g, '')
  if (target === '0.0.0.0') target = '127.0.0.1'
  if (net.isIP(target) === 6 && new URL(`http://[${target}]`).hostname === '[::]') target = '::1'
  return `http://${net.isIP(target) === 6 ? `[${target}]` : target}:${port}`
}

/** Desktop hands a fixed local browser landing to the host's own auth flow. */
export function browserLaunchUrl(ctx) {
  if (typeof ctx.connection?.authenticatedUrl !== 'function') return null
  const base = new URL(upstreamUrlForListener(ctx.webServer))
  if (ctx.webServer.protocol === 'https:') base.protocol = 'https:'
  if (!['127.0.0.1', '[::1]'].includes(base.hostname)) return null
  const url = new URL(ctx.connection.authenticatedUrl(base.href))
  if (url.origin !== base.origin || url.pathname !== '/' || url.username || url.password) return null
  url.hash = 'dsh-remote-connect'
  return url.href
}

function dshUpstreamCookieFile() {
  return process.env.DSH_REMOTE_DSH_COOKIE_FILE || `${homedir()}/.dsh-remote/dsh-upstream.cookie`
}

/**
 * DSH 0.1.2-alpha.1 起，Host RPC 与 WebSocket 都要求浏览器会话 Cookie。
 * 新版 connection 服务可把仅进程内可见的启动令牌兑换为 Cookie；旧版没有
 * authenticatedUrl，直接跳过即可。文件只让同一用户的独立网关读取。
 */
async function refreshDshUpstreamCookie() {
  if (typeof dshConnection?.authenticatedUrl !== 'function') return false
  const upstream = upstreamUrlForListener(dshListen)
  try {
    const loginUrl = dshConnection.authenticatedUrl(upstream)
    const response = await fetch(loginUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    })
    const setCookie = response.headers.get('set-cookie') || ''
    const cookie = setCookie.split(';', 1)[0].trim()
    if (response.status !== 303 || !cookie.includes('=') || cookie.length > 4096 || /[\0\r\n]/.test(cookie)) {
      throw new Error(`认证交换返回 HTTP ${response.status}`)
    }
    const file = dshUpstreamCookieFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, cookie + '\n', { mode: 0o600 })
    chmodSync(file, 0o600)
    return true
  } catch (e) {
    // 禁止记录带启动令牌的 URL 或 Cookie，只保留不含凭据的错误摘要。
    logGateway('刷新 DSH 上游认证失败: ' + (e?.message || String(e)))
    return false
  }
}

function lanIPs() {
  const out = [...configuredAdvertisedHosts()]
  let groups
  try { groups = Object.values(networkInterfaces()) } catch { return out }
  for (const list of groups) {
    for (const it of list ?? []) {
      if (it.family === 'IPv4' && !it.internal && !out.includes(it.address)) out.push(it.address)
    }
  }
  return out
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

function targetPath(pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname.slice(MOUNT.length)) || '/'
  } catch {
    return null
  }
  const file = rel === '/' ? INDEX_FILE : rel.replace(/^\/+/, '')
  const abs = resolve(PUBLIC_DIR, normalize(file))
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR)) return null
  return abs
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []; let size = 0, settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true; chunks.length = 0
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!settled) { settled = true; resolvePromise(Buffer.concat(chunks).toString('utf8')) } })
    req.on('error', reject)
    req.once('aborted', () => reject(Object.assign(new Error('request aborted'), { status: 400 })))
  })
}

/** 转发到本地网关管理 API；缺少令牌返回 null，超时与连接失败保留具体错误。 */
async function proxyGateway(path, method, body) {
  const token = gatewayToken()
  if (!token) return null
  try {
    const res = await fetch(`${gatewayBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-dsh-remote-client': 'admin',
      },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(path === '/admin/api/relay' ? 18000 : path.startsWith('/admin/api/dsh') ? 15000 : 5000),
    })
    const json = await res.json().catch(() => ({ ok: false, error: `gateway ${res.status}` }))
    return { status: res.status, json }
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return { status: timeout ? 504 : 502, json: { ok: false, code: timeout ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE',
      error: timeout ? '本地网关响应超时，请稍后重试' : '无法连接本地网关，请检查网关运行状态' } }
  }
}

/* ---------- 本地网关开关(持久化 + 自愈) ---------- */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function runExit(cmd, args) {
  return new Promise((resolvePromise) => {
    let p
    try { p = spawn(cmd, args, { stdio: 'ignore' }) }
    catch { return resolvePromise(1) }
    p.on('error', () => resolvePromise(1))
    p.on('exit', (code) => resolvePromise(code ?? 1))
  })
}

const GATEWAY_ENV_KEYS = [
  'TOKEN', 'TOKEN_FILE', 'DSH_REMOTE_TOKEN', 'DSH_REMOTE_DEVICE_KEYS', 'DSH_REMOTE_FS_ROOT', 'DSH_REMOTE_FS_WORKSPACE_CACHE_MS', 'DSH_REMOTE_FS_MAX_UPLOAD',
  'DSH_REMOTE_DSH_COOKIE_FILE',
  'DSH_REMOTE_NOTES', 'DSH_REMOTE_WORKBENCH', 'DSH_REMOTE_ADVERTISE_HOSTS', 'DSH_REMOTE_DSH_SERVICE', 'DSH_REMOTE_SYSTEMCTL', 'DSH_REMOTE_DSH_CONTROL_MODE',
  'DSH_REMOTE_AUTO_RESTART', 'DSH_REMOTE_CRASH_LOG_FILE',
  'DSH_REMOTE_DSH_CONTROL_TIMEOUT_MS', 'DSH_REMOTE_DSH_CONTROL_POLL_MS', 'DSH_REMOTE_FEEDBACK_URL',
  'UPDATE_CHECK_URL', 'UPDATE_INTERVAL_MS', 'UPDATE_PROXY', 'DSH_HEALTH_PATH',
  'GATEWAY_WS_IDLE_MS', 'GATEWAY_WS_PING_MS', 'GATEWAY_WS_PONG_TIMEOUT_MS',
  'GATEWAY_WS_UPGRADE_TIMEOUT_MS', 'GATEWAY_UPSTREAM_TIMEOUT_MS', 'GATEWAY_EVENT_BUFFER_MAX',
  'GATEWAY_WS_TICKET_TTL_MS',
  'GATEWAY_HTTP_REQUEST_TIMEOUT_MS', 'GATEWAY_HTTP_HEADERS_TIMEOUT_MS', 'GATEWAY_HTTP_KEEPALIVE_TIMEOUT_MS',
  'DSH_REMOTE_CORS_ORIGINS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
]

function gatewaySystemdEnvArgs() {
  const args = []
  for (const key of GATEWAY_ENV_KEYS) {
    const value = process.env[key]
    if (value === undefined || /[\0\r\n]/.test(value)) continue
    args.push('--setenv=' + key + '=' + value)
  }
  return args
}

/** 127.0.0.1 端口占用预检: 能连上=被占用, 连接被拒/超时=可用。 */
function portInUse(port) {
  return new Promise((resolvePromise) => {
    const host = new URL(upstreamUrlForListener({ host: readGatewayHost(), port })).hostname.replace(/^\[|\]$/g, '')
    const sock = net.connect({ host, port: Number(port) })
    let done = false
    const finish = (used) => {
      if (done) return
      done = true
      sock.destroy()
      resolvePromise(used)
    }
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
    sock.setTimeout(800, () => finish(false))
  })
}

let gatewayHealthJob = null
async function gatewayRunning() {
  const base = gatewayBase()
  if (gatewayHealthJob?.base === base) return gatewayHealthJob.promise
  const job = { base }
  gatewayHealthJob = job
  job.promise = probeGatewayRunning(base).finally(() => { if (gatewayHealthJob === job) gatewayHealthJob = null })
  return job.promise
}
async function probeGatewayRunning(base) {
  try {
    const res = await fetch(`${base}/health?probe=live`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return { running: false }
    const data = await res.json().catch(() => ({}))
    // Early 0.7.x live probes deliberately omit readiness/upstream fields.
    // Recognize that exact compact shape without invoking the old, blocking
    // full health check. Public health never authorizes a PID kill: takeover
    // still requires the existing token and /admin/api/shutdown below.
    const compact = data.ok === true && data.probe === 'live' && data.liveness?.ok === true
      && !Object.hasOwn(data, 'pid') && !Object.hasOwn(data, 'upstream') && !Object.hasOwn(data, 'events')
    const pid = compact ? data.liveness.pid : data.pid
    if (data.service !== 'dsh-remote' || !Number.isInteger(pid) || pid <= 1
      || typeof data.version !== 'string' || !data.version
      || (!compact && (typeof data.upstream !== 'string' || !data.events?.mux || !data.events?.host))) return { running: false }
    return {
      running: true,
      base,
      pid,
      version: typeof data.version === 'string' ? data.version : '',
      upstream: typeof data.upstream === 'string' ? data.upstream : '',
      upstreamOk: data.upstreamOk === true,
      upstreamReachable: data.upstreamReachable !== false,
      upstreamStatus: Number(data.upstreamStatus) || 0,
      upstreamProbe: typeof data.upstreamProbe === 'string' ? data.upstreamProbe : '',
    }
  } catch {
    return { running: false }
  }
}

function gatewayPidFile() { return `${homedir()}/.dsh-remote/plugin-gateway.pid` }

function writeGatewayPid(pid) {
  try {
    mkdirSync(`${homedir()}/.dsh-remote`, { recursive: true })
    writeFileSync(gatewayPidFile(), String(pid) + '\n')
  } catch {}
}

function logGateway(msg) {
  try {
    mkdirSync(`${homedir()}/.dsh-remote`, { recursive: true })
    appendFileSync(`${homedir()}/.dsh-remote/plugin-gateway.log`, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

async function killGateway(health) {
  // PID 文件和公开健康响应不能证明进程归属；仅走网关认证关闭接口。
  if (!health?.running || !Number.isInteger(health.pid) || health.pid <= 1) return false
  const token = gatewayToken()
  if (!token) return false
  try {
    const res = await fetch(`${health.base || gatewayBase()}/admin/api/shutdown`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-dsh-remote-client': 'admin' },
      signal: AbortSignal.timeout(2000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok !== true || body.bye !== true) return false
    logGateway('已请求旧网关认证关闭')
    await sleep(300)
    return true
  } catch (e) {
    logGateway('认证关闭旧网关失败: ' + (e?.message || String(e)))
    return false
  }
}

/** 用户意图持久化在 ~/.dsh-remote/gateway.enabled: on=跟随 DSH 自启/自愈, off=手动停止。 */
function gatewayStateFile() { return `${homedir()}/.dsh-remote/gateway.enabled` }

function gatewayAutostart() {
  if (process.env.DSH_REMOTE_AUTOSTART === '0') return false
  try {
    const v = readFileSync(gatewayStateFile(), 'utf8').trim()
    return v !== 'off'
  } catch {
    return true // 全新安装: 默认自动拉起网关, 抽屉打开即有网关模式
  }
}

function setGatewayEnabled(on) {
  try {
    mkdirSync(`${homedir()}/.dsh-remote`, { recursive: true })
    writeFileSync(gatewayStateFile(), on ? 'on\n' : 'off\n')
  } catch {}
}

/* ---------- 网关解释器解析 ----------
 * Windows 不允许覆盖正在运行的可执行文件，而 DSH Desktop 的 NSIS 更新器会原地替换整棵
 * 安装目录。旧实现用 process.execPath(桌面版即 DeepSeek Harness.exe) + detached 启动
 * 常驻网关，等于让插件进程长期占用 DSH 安装目录，导致 DSH 自更新失败。因此网关解释器
 * 必须位于安装目录之外，同时保留「网关活过 DSH 退出/重启」的既有设计。
 *
 * 选择顺序(取第一个通过校验的候选):
 *   1. DSH_REMOTE_NODE: 绝对路径, -v 可执行且主版本 >= 18
 *   2. PATH 中的 node: 同样校验
 *   3. DSH Desktop 自带 runtime, 复制到 ~/.dsh-remote/runtime/node-<ver>(.exe)
 *   4. process.execPath 兜底: 显式标记 runtimeInsideInstallDir 并写警告, 不允许静默降级
 * 所有被跳过的候选及原因都会写进 ~/.dsh-remote/plugin-gateway.log。
 */
export const GATEWAY_RUNTIME_MIN_MAJOR = 18
const GATEWAY_RUNTIME_DIR = ['.dsh-remote', 'runtime']

function runtimeProbeEnv() {
  // 桌面版宿主进程的 process.execPath 是 Electron 可执行文件；探测它需要 node 语义。
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_CHANNEL_FD
  delete env.NODE_CHANNEL_SERIALIZATION_MODE
  return env
}

/** 默认探测: 执行 `<candidate> -v`。返回 {ok, version, major, code, detail}，绝不抛错。 */
let probeSequence = 0
function probeNodeVersion(file) {
  // 用临时文件接收 stdout 而不是管道：受限环境/沙箱下 Node 无法创建管道句柄
  // (spawn stdio:'pipe' 会 EPERM)，写文件在各权限模式下都可用。
  let fd = null
  const outputFile = join(tmpdir(), 'dsh-remote-probe-' + process.pid + '-' + randomUUID().slice(0, 8) + '-' + (++probeSequence) + '.txt')
  try {
    fd = openSync(outputFile, 'w')
    const spawned = spawnSync(file, ['-v'], {
      timeout: 5000, windowsHide: true, env: runtimeProbeEnv(),
      stdio: ['ignore', fd, 'ignore'],
    })
    try { closeSync(fd); fd = null } catch {}
    if (spawned.error) {
      return { ok: false, code: 'PROBE_FAILED', detail: String(spawned.error.code || spawned.error.message).slice(0, 160) }
    }
    const output = readFileSync(outputFile, 'utf8')
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(output || '').trim())
    if (!match) return { ok: false, code: 'PROBE_FAILED', detail: '无法解析 node -v 输出' }
    return { ok: true, version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) }
  } catch (error) {
    if (fd !== null) { try { closeSync(fd) } catch {} }
    const detail = String(error?.code ? error.code + ' ' : '') + String(error?.message || error)
    return { ok: false, code: 'PROBE_FAILED', detail: detail.slice(0, 160) }
  } finally {
    try { rmSync(outputFile, { force: true }) } catch {}
  }
}

function normalizeNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim())
  return match ? `${match[1]}.${match[2]}.${match[3]}` : ''
}

/** 比较真实路径；不存在的复制目标也解析最近的既有父目录，避免 junction 绕过边界。 */
function normalizeRuntimePath(value, platform) {
  let text = String(value || '')
  if (!text) return ''
  try {
    text = resolve(text)
    let ancestor = text
    const suffix = []
    for (;;) {
      try { text = join(realpathSync.native(ancestor), ...suffix); break } catch {}
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      suffix.unshift(basename(ancestor))
      ancestor = parent
    }
  } catch { /* 无法规范化时保留原文；候选另有存在/可执行性校验。 */ }
  if (platform === 'win32') text = text.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  if (platform === 'win32') text = text.toLowerCase().replaceAll('/', '\\')
  return text.replace(/[\\/]+$/, '') || text
}

function isPathInsideDir(parent, child, platform) {
  const parentPath = normalizeRuntimePath(parent, platform)
  const childPath = normalizeRuntimePath(child, platform)
  if (!parentPath || !childPath) return false
  const separator = platform === 'win32' ? '\\' : '/'
  return childPath === parentPath || childPath.startsWith(parentPath.endsWith(separator) ? parentPath : parentPath + separator)
}

function desktopBundledNodePath(installDir, platform) {
  return join(installDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node')
}

function runtimeCopyTarget(home, version, platform) {
  return join(home, ...GATEWAY_RUNTIME_DIR, 'node-' + version + (platform === 'win32' ? '.exe' : ''))
}

function envPathValue(env) {
  if (!env || typeof env !== 'object') return ''
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path')
  const value = key ? env[key] : ''
  return typeof value === 'string' ? value : ''
}

/** 按 PATH 顺序列出真实存在的 node 可执行文件；Windows 只看 node.exe(不解析 .cmd 垫片)。 */
function findPathNodeCandidates(env, platform) {
  const names = platform === 'win32' ? ['node.exe'] : ['node']
  const found = []
  for (const rawEntry of envPathValue(env).split(platform === 'win32' ? ';' : ':')) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1')
    if (!entry) continue
    for (const name of names) {
      const file = join(entry, name)
      try { if (statSync(file).isFile()) found.push(file) } catch {}
    }
  }
  return found
}

/** 默认复制实现: 先写 *.partial, 校验大小后原子 rename；失败清理半成品。 */
function copyNodeRuntimeFile(source, target) {
  const dir = dirname(target)
  const partial = target + '.' + process.pid + '.partial'
  try {
    const sourceStat = statSync(source)
    if (!sourceStat.isFile() || sourceStat.size <= 0) return { ok: false, error: '源文件不可用' }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // 清理上次失败留下的半成品, 避免 90MB 级文件无限堆积。
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(basename(target) + '.') && name.endsWith('.partial')) rmSync(join(dir, name), { force: true })
      }
    } catch {}
    copyFileSync(source, partial)
    try { chmodSync(partial, 0o755) } catch {}
    const copiedStat = statSync(partial)
    if (copiedStat.size !== sourceStat.size) throw new Error('复制后大小校验失败')
    rmSync(target, { force: true })
    renameSync(partial, target)
    return { ok: true, bytes: copiedStat.size }
  } catch (error) {
    try { rmSync(partial, { force: true }) } catch {}
    return { ok: false, error: error?.code || error?.message || 'COPY_FAILED' }
  }
}

function insideInstallDirWarning(platform) {
  return platform === 'win32'
    ? '本次网关解释器位于 DSH 安装目录内，DSH 更新可能失败；请安装 Node.js 18+ 到系统 PATH，或设置 DSH_REMOTE_NODE 指向安装目录外的 node。'
    : '本次网关解释器位于 DSH 安装目录内；建议设置 DSH_REMOTE_NODE 或安装系统 Node.js 18+，避免网关占用安装目录。'
}

/**
 * 解析并校验网关解释器。永远返回可用结果(最差为 process.execPath 兜底)，不抛错。
 * 全部选项均可注入，便于在临时目录中测试真实的启动策略。
 */
export async function resolveGatewayRuntime(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const platform = options.platform || process.platform
  const home = options.home || homedir()
  const execPath = resolve(typeof options.execPath === 'string' && options.execPath ? options.execPath : process.execPath)
  const installDir = dirname(execPath)
  const desktopHost = options.desktopHost === undefined
    ? Boolean(process.versions.electron) || existsSync(join(installDir, 'resources', 'app.asar'))
    : options.desktopHost === true
  const probe = typeof options.probe === 'function' ? options.probe : probeNodeVersion
  const copyRuntime = typeof options.copyRuntime === 'function' ? options.copyRuntime : copyNodeRuntimeFile
  const log = typeof options.log === 'function' ? options.log : logGateway

  const attempts = []
  const candidates = []
  const seen = new Set()
  let copy = null

  const addAttempt = (source, candidate, ok, code, detail) => {
    attempts.push({ source, candidate: candidate || '', ok: !!ok, code, detail: detail || '' })
  }
  const skip = (source, candidate, code, detail) => {
    addAttempt(source, candidate, false, code, detail)
    log('网关解释器候选跳过: ' + source + ' ' + (candidate || '(未提供)') + ' - ' + (detail || code))
    return null
  }
  const runProbe = async (file) => {
    try {
      const result = await Promise.resolve(probe(file))
      return result && typeof result === 'object' ? result : { ok: false, code: 'PROBE_FAILED', detail: '无效的探测结果' }
    } catch (error) {
      return { ok: false, code: 'PROBE_FAILED', detail: String(error?.message || error).slice(0, 160) }
    }
  }
  const accept = (source, executable, version, major, reused) => {
    const key = normalizeRuntimePath(executable, platform)
    if (seen.has(key)) return false
    seen.add(key)
    candidates.push({ executable, source, version, major, insideInstallDir: false, reused: !!reused, valid: true })
    addAttempt(source, executable, true, 'OK', reused ? '复用已存在的 node ' + version + ' 副本' : '')
    log('网关解释器: ' + source + ' -> ' + executable + ' (node ' + version + ')')
    return true
  }
  /** 校验一个 node 候选: 绝对路径/存在/边界/probe/版本。boundary=false 用于安装目录内的复制源。 */
  const checkNode = async (source, rawCandidate, { boundary = true } = {}) => {
    if (typeof rawCandidate !== 'string' || !rawCandidate.trim()) return skip(source, '', 'MISSING', '路径为空')
    if (!isAbsolute(rawCandidate)) return skip(source, rawCandidate, 'NOT_ABSOLUTE', '不是绝对路径')
    const candidate = resolve(rawCandidate)
    if (!existsSync(candidate)) return skip(source, candidate, 'MISSING', '文件不存在')
    try { if (!statSync(candidate).isFile()) return skip(source, candidate, 'MISSING', '不是文件') } catch { return skip(source, candidate, 'MISSING', '无法读取文件信息') }
    if (boundary && desktopHost && isPathInsideDir(installDir, candidate, platform)) {
      return skip(source, candidate, 'INSIDE_INSTALL_DIR', '位于 DSH 安装目录内, 会阻止 DSH 原地更新')
    }
    const probed = await runProbe(candidate)
    if (!probed.ok) return skip(source, candidate, 'PROBE_FAILED', '无法执行 -v: ' + (probed.detail || '未知错误'))
    const version = normalizeNodeVersion(probed.version)
    const major = Number(probed.major) || Number((/(\d+)\./.exec(version) || [])[1]) || 0
    if (!version || !Number.isFinite(major) || major < GATEWAY_RUNTIME_MIN_MAJOR) {
      return skip(source, candidate, 'VERSION_TOO_OLD', 'node ' + (version || String(probed.version || '?')) + ' < ' + GATEWAY_RUNTIME_MIN_MAJOR)
    }
    return { executable: candidate, version, major }
  }

  // 1) DSH_REMOTE_NODE
  const envNode = typeof env.DSH_REMOTE_NODE === 'string' ? env.DSH_REMOTE_NODE.trim() : ''
  if (envNode) {
    const checked = await checkNode('env', envNode)
    if (checked) accept('env', checked.executable, checked.version, checked.major, false)
  }

  // 2) PATH 中的 node
  const pathCandidates = findPathNodeCandidates(env, platform)
  if (!pathCandidates.length) skip('path', '', 'NOT_FOUND', 'PATH 中没有找到 node')
  for (const file of pathCandidates) {
    const checked = await checkNode('path', file)
    if (checked && accept('path', checked.executable, checked.version, checked.major, false)) break
  }

  // 3) 按需准备内置副本：没有外部候选，或外部候选实际启动失败时才复制。
  let desktopPrepared = false
  const prepareDesktopRuntime = async () => {
    if (!desktopHost || desktopPrepared) return null
    desktopPrepared = true
    const previousCount = candidates.length
    const source = desktopBundledNodePath(installDir, platform)
    if (!existsSync(source)) {
      skip('desktop-runtime', source, 'SOURCE_MISSING', '未找到桌面版自带 node 运行时')
    } else {
      const sourceChecked = await checkNode('desktop-runtime', source, { boundary: false })
      if (sourceChecked) {
        const target = runtimeCopyTarget(home, sourceChecked.version, platform)
        if (desktopHost && isPathInsideDir(installDir, target, platform)) {
          skip('desktop-runtime', target, 'INSIDE_INSTALL_DIR', 'node 副本目标位于 DSH 安装目录内')
        } else {
          const existingProbe = existsSync(target) ? await runProbe(target) : null
          if (existingProbe?.ok && normalizeNodeVersion(existingProbe.version) === sourceChecked.version) {
            copy = { source, target, version: sourceChecked.version, reused: true, bytes: safeFileSize(target) }
            accept('desktop-runtime', target, sourceChecked.version, sourceChecked.major, true)
          } else {
            let copied = null
            try { copied = await copyRuntime(source, target) } catch (error) { copied = { ok: false, error: error?.message || String(error) } }
            if (!copied?.ok) {
              skip('desktop-runtime', target, 'COPY_FAILED', '复制 node 运行时失败: ' + (copied?.error || '未知错误'))
            } else {
              const verified = await runProbe(target)
              if (!verified?.ok || normalizeNodeVersion(verified.version) !== sourceChecked.version) {
                try { rmSync(target, { force: true }) } catch {}
                skip('desktop-runtime', target, 'COPY_PROBE_FAILED', '副本无法执行或版本不符: ' + (verified?.detail || normalizeNodeVersion(verified?.version) || '未知错误'))
              } else {
                const bytes = Number(copied.bytes) || safeFileSize(target)
                copy = { source, target, version: sourceChecked.version, reused: false, bytes }
                log('已复制网关解释器: ' + source + ' -> ' + target + ' (' + bytes + ' B)')
                accept('desktop-runtime', target, sourceChecked.version, sourceChecked.major, false)
              }
            }
          }
        }
      }
    }
    return candidates[previousCount] || null
  }
  if (!candidates.length) await prepareDesktopRuntime()

  // 4) 兜底 process.execPath: 即使探测失败也保留为最后尝试，但必须显式记录
  const hostKey = normalizeRuntimePath(execPath, platform)
  if (!seen.has(hostKey)) {
    const probed = await runProbe(execPath)
    const version = probed.ok ? normalizeNodeVersion(probed.version) : ''
    const major = probed.ok ? (Number(probed.major) || Number((/(\d+)\./.exec(version) || [])[1]) || 0) : 0
    const insideInstallDir = desktopHost && isPathInsideDir(installDir, execPath, platform)
    candidates.push({ executable: execPath, source: 'host', version, major, insideInstallDir, reused: false, valid: probed.ok })
    seen.add(hostKey)
    addAttempt('host', execPath, probed.ok, probed.ok ? 'OK' : 'PROBE_FAILED', probed.ok ? '' : '无法执行 -v: ' + (probed.detail || '未知错误'))
    if (probed.ok) log('网关解释器兜底: host -> ' + execPath + ' (node ' + version + ')')
    else log('网关解释器兜底: host -> ' + execPath + ' (探测失败, 仍作为最后尝试)')
  }

  const selected = candidates[0]
  const warning = selected?.insideInstallDir ? insideInstallDirWarning(platform) : ''
  if (warning) log('警告: ' + warning)
  const plan = {
    executable: selected.executable,
    source: selected.source,
    version: selected.version,
    major: selected.major,
    installDir,
    desktopHost,
    platform,
    insideInstallDir: !!selected.insideInstallDir,
    // 提示词/文档使用的显式标记名；insideInstallDir 是内部与状态字段名，二者保持同义。
    runtimeInsideInstallDir: !!selected.insideInstallDir,
    warning,
    candidates,
    attempts,
    copy,
  }
  plan.prepareDesktopFallback = async () => {
    const candidate = await prepareDesktopRuntime()
    plan.copy = copy
    if (candidate) {
      // accept() 追加的新候选应排在 host 兜底之前。
      candidates.splice(candidates.indexOf(candidate), 1)
      const hostIndex = candidates.findIndex(entry => entry.source === 'host')
      candidates.splice(hostIndex < 0 ? candidates.length : hostIndex, 0, candidate)
    }
    return candidate
  }
  return plan
}

function safeFileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

function gatewayRuntimeSummary(plan) {
  if (!plan) return null
  return {
    executable: plan.executable,
    source: plan.source,
    version: plan.version,
    major: plan.major,
    installDir: plan.installDir,
    desktopHost: plan.desktopHost,
    insideInstallDir: plan.insideInstallDir,
    runtimeInsideInstallDir: plan.runtimeInsideInstallDir ?? plan.insideInstallDir,
    warning: plan.warning,
    copy: plan.copy ? { target: plan.copy.target, version: plan.copy.version, reused: plan.copy.reused } : null,
    attempts: plan.attempts.map(entry => ({ source: entry.source, ok: entry.ok, code: entry.code, detail: entry.detail })),
  }
}

let gatewayRuntimePlanPromise = null
let gatewayRuntimeState = null
let gatewayRuntimeStartedPid = 0
let gatewayRuntimeSupervisorPid = 0

/** 解析结果按进程缓存(环境变量变化需重启 DSH)；解析失败也回退为显式警告而不是静默。 */
function gatewayRuntimePlan() {
  if (!gatewayRuntimePlanPromise) {
    gatewayRuntimePlanPromise = (async () => {
      let plan
      try {
        plan = await resolveGatewayRuntime()
      } catch (error) {
        const installDir = dirname(resolve(process.execPath))
        const warning = '网关解释器解析失败，回退到 DSH 可执行文件，DSH 更新可能失败: ' + (error?.message || error)
        logGateway('警告: ' + warning)
        plan = {
          executable: process.execPath, source: 'host', version: '', major: 0, installDir,
          desktopHost: Boolean(process.versions.electron), insideInstallDir: true, warning,
          candidates: [{ executable: process.execPath, source: 'host', version: '', major: 0, insideInstallDir: true, reused: false, valid: false }],
          attempts: [], copy: null,
        }
      }
      return plan
    })()
  }
  return gatewayRuntimePlanPromise
}

/** 仅报告绑定到当前 worker PID 的实际解释器；解析计划不能证明现存网关用了它。 */
async function gatewayRuntimeForStatus(reported, health) {
  const current = health || await gatewayRunning()
  if (!current.running) return null
  if (gatewayRuntimeState?.pid === current.pid) return gatewayRuntimeState
  if (reported === undefined) {
    const response = await proxyGateway('/admin/api/runtime', 'GET', '')
    reported = response?.status === 200 && response.json.ok === true ? response.json.gatewayRuntime : null
  }
  if (reported?.pid !== current.pid || typeof reported.executable !== 'string' || !isAbsolute(reported.executable)) {
    return { source: 'unknown', pid: current.pid, executable: '', version: '', insideInstallDir: null,
      runtimeInsideInstallDir: null, warning: '当前网关未报告实际解释器；请停止并重新启动网关后确认。' }
  }
  const plan = await gatewayRuntimePlan()
  if (gatewayRuntimeSupervisorPid && reported.supervisorPid === gatewayRuntimeSupervisorPid) gatewayRuntimeStartedPid = current.pid
  const matched = plan.candidates.find(candidate => normalizeRuntimePath(candidate.executable, process.platform) === normalizeRuntimePath(reported.executable, process.platform))
  const version = normalizeNodeVersion(reported.version)
  const actual = { executable: reported.executable, source: matched?.source || 'external', version,
    major: Number(version.split('.')[0]) || 0, insideInstallDir: plan.desktopHost && isPathInsideDir(plan.installDir, reported.executable, process.platform) }
  gatewayRuntimeState = { ...gatewayRuntimeStateFor(plan, actual), pid: current.pid }
  return gatewayRuntimeState
}

function gatewayRuntimeStateFor(plan, candidate) {
  const used = { ...plan, executable: candidate.executable, source: candidate.source, version: candidate.version, major: candidate.major,
    insideInstallDir: !!candidate.insideInstallDir, runtimeInsideInstallDir: !!candidate.insideInstallDir }
  // 实际启动可能回退到 host(安装目录内)候选: 必须重新给出对应警告，不能沿用首选候选的空 warning。
  const usedWarning = used.insideInstallDir ? (plan.warning || insideInstallDirWarning(plan.platform || process.platform)) : ''
  if (usedWarning) logGateway('警告: ' + usedWarning)
  return { ...gatewayRuntimeSummary({ ...used, warning: usedWarning }), at: Date.now() }
}

/** 启动随插件分发的 gateway.cjs; 已运行则直接返回。 */
const GATEWAY_AUTH_HINT = '网关正在运行，但管理认证不可用。请检查 TOKEN_FILE、TOKEN / DSH_REMOTE_TOKEN 与文件权限；若旧网关无法恢复令牌，请在主机上确认进程归属后手动重启网关，再刷新此页。'

async function startGateway() {
  const upstream = upstreamUrlForListener(dshListen)
  const health = await gatewayRunning()
  if (health.running) {
    const auth = await proxyGateway('/admin/api/state', 'GET', '')
    if (!auth || auth.status !== 200 || auth.json.ok !== true) {
      return { ok: false, running: true, started: false, error: auth?.status === 401 || auth?.status === 403 ? GATEWAY_AUTH_HINT : auth?.json?.error || '本地网关管理接口响应异常，请稍后重试' }
    }
    await gatewayRuntimeForStatus(auth.json.gatewayRuntime ?? null, health)
    setGatewayEnabled(true)
    return { ok: true, running: true, started: false }
  }
  const script = GATEWAY_SCRIPT
  if (!existsSync(script)) {
    return { ok: false, running: false, error: '插件包缺少 gateway.cjs, 请升级插件' }
  }
  const port = readGatewayPort()
  const host = readGatewayHost()
  if (await portInUse(port)) {
    logGateway(`端口 ${port} 已被占用, 拒绝启动`)
    return { ok: false, running: false, error: `端口 ${port} 已被占用，请在插件页修改网关端口后重试` }
  }
  // Windows 上运行中的 exe 不能被覆盖，网关解释器必须位于 DSH 安装目录之外，
  // 否则 DSH 原地更新(NSIS 替换整棵安装目录)会被插件进程挡住。
  // 顺序: DSH_REMOTE_NODE > PATH node > 桌面版内置 runtime 副本 > process.execPath(显式警告)。
  const runtime = await gatewayRuntimePlan()
  logGateway('启动网关, 端口: ' + port + ', 上游: ' + upstream + ', 解释器: ' + runtime.executable
    + ' (' + runtime.source + (runtime.version ? ', node ' + runtime.version : '') + ')')

  // Windows locks a process's current directory. Keep both supervisor and
  // worker outside the replaceable node_modules package during self-update.
  const gatewayCwd = `${homedir()}/.dsh-remote`
  let cwdReady = false
  try { mkdirSync(gatewayCwd, { recursive: true }); cwdReady = true } catch {}

  /** 最多等 4 秒; 超过可能是端口冲突或首次初始化, 前端稍后刷新即可。 */
  const waitGatewayReady = async () => {
    for (let i = 0; i < 16; i++) {
      await sleep(250)
      const healthNow = await gatewayRunning()
      if (healthNow.running) return healthNow
    }
    return null
  }
  const startedResult = (candidate, healthNow) => {
    if (healthNow.pid) writeGatewayPid(healthNow.pid)
    gatewayRuntimeStartedPid = healthNow.pid
    gatewayRuntimeState = { ...gatewayRuntimeStateFor(runtime, candidate), pid: healthNow.pid }
    setGatewayEnabled(true)
    return { ok: true, running: true, started: true, runtime: gatewayRuntimeState }
  }

  // 逐个候选尝试: 解释器立即退出/无法执行时回退下一候选，绝不静默改回 process.execPath。
  const failures = []
  async function* runtimeCandidates() {
    // 快照防止按需准备副本时修改 candidates，导致重复启动或漏掉候选。
    for (const candidate of [...runtime.candidates]) {
      if (candidate.source === 'host' && runtime.prepareDesktopFallback) {
        const fallback = await runtime.prepareDesktopFallback()
        if (fallback) yield fallback
      }
      yield candidate
    }
  }
  for await (const candidate of runtimeCandidates()) {
    // 首选 systemd-run: 网关成为独立 user 单元, DSH 重启/升级不会连带杀掉它
    let sysd = false
    try {
      await runExit('systemctl', ['--user', 'reset-failed', 'dsh-remote-gateway'])
      sysd = (await runExit('systemd-run', [
        '--user', '--unit=dsh-remote-gateway', '--service-type=exec',
        ...gatewaySystemdEnvArgs(),
        '--setenv=PORT=' + port, '--setenv=HOST=' + host, '--setenv=DSH_UPSTREAM=' + upstream,
        '--', candidate.executable, script, '--supervise',
      ])) === 0
    } catch {}
    if (sysd) {
      try {
        const pid = Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'dsh-remote-gateway'], { encoding: 'utf8' }).trim())
        if (Number.isFinite(pid) && pid > 1) { writeGatewayPid(pid); gatewayRuntimeSupervisorPid = pid }
      } catch {}
      const healthNow = await waitGatewayReady()
      if (healthNow) return startedResult(candidate, healthNow)
      // 单元立即失败(解释器不可执行等)才换候选；仍在启动时可能只是慢，不重复拉起。
      const unitState = gatewaySystemdUnitState()
      failures.push({ executable: candidate.executable, reason: 'systemd 单元 ' + (unitState || '未就绪') })
      logGateway('解释器 ' + candidate.executable + ' 的 systemd 单元未就绪(' + (unitState || '未知状态') + '), 尝试下一候选')
      if (unitState === 'activating' || unitState === 'active') return { ok: true, running: false, pending: true, hint: '网关启动中, 稍后刷新' }
      continue
    }

    // 无 systemd 的机器回退: detached 子进程
    if (!cwdReady) return { ok: false, running: false, error: '无法创建网关运行目录，请检查用户目录权限' }
    let logFd = null
    try {
      logFd = openSync(`${homedir()}/.dsh-remote/plugin-gateway.log`, 'a')
    } catch {}
    const gatewayEnv = { ...process.env, PORT: port, HOST: host, DSH_UPSTREAM: upstream }
    delete gatewayEnv.NODE_CHANNEL_FD
    delete gatewayEnv.NODE_CHANNEL_SERIALIZATION_MODE
    let child = null
    try {
      child = spawn(candidate.executable, [script, '--supervise'], {
        cwd: gatewayCwd,
        detached: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        env: gatewayEnv,
      })
    } catch (error) {
      failures.push({ executable: candidate.executable, reason: 'spawn 失败: ' + (error?.message || error) })
      logGateway('解释器 ' + candidate.executable + ' 无法启动网关: ' + (error?.message || error) + ', 尝试下一候选')
      continue
    } finally {
      if (logFd !== null) { try { closeSync(logFd) } catch {} }
    }
    let exited = null
    child.once('exit', (code, signal) => { exited = { code, signal } })
    child.once('error', (error) => { exited = { code: null, error: error?.message || String(error) } })
    child.unref()
    if (Number.isInteger(child.pid) && child.pid > 1) { writeGatewayPid(child.pid); gatewayRuntimeSupervisorPid = child.pid }
    let healthNow = null
    for (let i = 0; i < 16; i++) {
      await sleep(250)
      const healthProbe = await gatewayRunning()
      if (healthProbe.running) { healthNow = healthProbe; break }
      if (exited) break
    }
    if (healthNow) return startedResult(candidate, healthNow)
    if (exited) {
      const detail = 'code=' + exited.code + (exited.signal ? ' signal=' + exited.signal : '') + (exited.error ? ' error=' + exited.error : '')
      failures.push({ executable: candidate.executable, reason: '立即退出(' + detail + ')' })
      logGateway('解释器 ' + candidate.executable + ' 启动的网关立即退出(' + detail + '), 尝试下一候选')
      continue
    }
    // 进程仍活着但 4 秒内未就绪: 保持原行为等待前端刷新，不重复启动第二个网关。
    return { ok: true, running: false, pending: true, hint: '网关启动中, 稍后刷新' }
  }
  const failureDetail = failures.map(item => item.executable + ' (' + item.reason + ')').join('; ')
  logGateway('网关启动失败: 所有解释器候选均未成功: ' + failureDetail)
  return {
    ok: false, running: false,
    error: '网关启动失败: ' + failures.length + ' 个解释器候选均未成功' + (runtime.warning ? '；' + runtime.warning : ''),
    runtime: gatewayRuntimeState || gatewayRuntimeSummary(runtime),
  }
}

function gatewaySystemdUnitState() {
  try {
    return String(execFileSync('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', 'dsh-remote-gateway'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim()
  } catch { return '' }
}

let ensurePromise = null
/** 自愈入口: 状态轮询/DSH 启动时调用。开关为 on 且网关没起来, 就自动拉起(并发只拉一次)。 */
function ensureGateway() {
  if (!gatewayAutostart()) return Promise.resolve(false)
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    try {
      // 提前解析解释器(结果缓存)：即使网关已在运行，插件页也能显示实际选择与理由。
      const runtime = await gatewayRuntimePlan()
      await refreshDshUpstreamCookie()
      const health = await gatewayRunning()
      if (!health.running) {
        const out = await startGateway()
        return !!out.running
      }
      const upstream = upstreamUrlForListener(dshListen)
      const oldUpstream = health.upstream || ''
      const oldVersion = health.version || '?'
      const versionMismatch = oldVersion !== version
      const actualRuntime = runtime.desktopHost ? await gatewayRuntimeForStatus(undefined, health) : null
      // DSH 重启后接管遗留的宿主解释器，或应用新的外部解释器配置。
      // 本进程已尝试并回退的实例不再反复重启，避免坏候选导致重启风暴。
      const runtimeMismatch = runtime.desktopHost && gatewayRuntimeStartedPid !== health.pid
        && !runtime.insideInstallDir && actualRuntime?.executable
        && normalizeRuntimePath(actualRuntime.executable, process.platform) !== normalizeRuntimePath(runtime.executable, process.platform)
      // 上游暂时不可达不应重启网关: VPN/DSH 重启/短暂网络抖动时，
      // 重启只能制造额外断线，网关应保持运行并通过 /health 暴露 degraded 状态。
      if (versionMismatch || runtimeMismatch || (oldUpstream && oldUpstream !== upstream) || (!oldUpstream && upstream)) {
        logGateway(`网关需刷新: 版本 ${oldVersion} -> ${version}, 上游 ${oldUpstream || '?'} -> ${upstream}`)
        if (runtimeMismatch) logGateway('网关解释器需迁移: ' + actualRuntime.executable + ' -> ' + runtime.executable)
        if (!await killGateway(health)) {
          logGateway('拒绝自动重启: 无法通过认证关闭旧网关，请检查令牌或端口占用')
          return false
        }
        for (let i = 0; i < 10; i++) {
          if (!(await gatewayRunning()).running) break
          await sleep(200)
        }
        const out = await startGateway()
        return !!out.running
      }
      return true
    } finally {
      setTimeout(() => { ensurePromise = null }, 4000)
    }
  })()
  return ensurePromise
}

/** 通过网关自身的 /admin/api/shutdown 优雅停止(不管它当初是谁拉起的); 并写入 off 防自愈拉起。 */
async function stopGateway() {
  const health = await gatewayRunning()
  if (!await killGateway(health)) return { ok: false, running: health.running, error: health.running ? GATEWAY_AUTH_HINT : '网关未运行' }
  setGatewayEnabled(false)
  return { ok: true, running: false, bye: true }
}

// ---------- 统计事件投递(实时 assistant/message + usage -> 网关 /stats/ingest) ----------
// 网关未运行时静默失败: 网关启动后会按 seq 游标扫描 session.jsonl.zstd 补齐。
const statsQueues = new Map() // sessionId -> Promise 串行队列(保证 seq 顺序)

function statsSend(session, event) {
  if (event.type !== 'assistant/message') return
  const usage = event.data?.usage
  if (!usage || typeof usage !== 'object') return
  const token = gatewayToken()
  if (!token) return
  let fallbackModel = ''
  try { fallbackModel = session.requestContext?.()?.model || '' } catch {}
  const payload = {
    sessionId: session.id,
    fallbackModel,
    event: {
      type: 'assistant/message',
      seq: event.seq,
      time: event.time,
      data: {
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        message: { source: { model: event.data?.message?.source?.model || '' } },
      },
    },
  }
  const prev = statsQueues.get(session.id) || Promise.resolve()
  const next = prev.then(async () => {
    try {
      await fetch(`${gatewayBase()}/stats/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      })
    } catch {}
  }).finally(() => {
    if (statsQueues.get(session.id) === next) statsQueues.delete(session.id)
  })
  statsQueues.set(session.id, next)
}

/** 从 sessionId 解析 DSH Agent：优先取已发布 live agent，否则走 resume。返回 { agent, resolvePath } 便于定位。 */
async function resolveAgent(ctx, sessionId) {
  if (!ctx.agents) return { agent: null, resolvePath: 'no-agents-service' }
  let live
  try {
    live = ctx.agents.get(sessionId)
  } catch (e) {
    live = undefined
  }
  if (live) return { agent: live, resolvePath: 'live' }
  try {
    const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
    if (!handle || !handle.agent) return { agent: null, resolvePath: 'resume-empty-handle' }
    return { agent: handle.agent, resolvePath: 'resume' }
  } catch (e) {
    return { agent: null, resolvePath: 'resume-error' }
  }
}

function commandHead(line) {
  const match = /^\/+(\S+)/.exec(String(line || '').trim())
  return match ? match[1].replace(/^\/+/, '') : ''
}

function commandEntryName(entry) {
  const value = typeof entry === 'string' ? entry : entry?.name
  return String(value || '').trim().replace(/^\/+/, '')
}

function commandWasExecuted(result) {
  // DSH 0.1.x 的 commands.execute() 成功时可以返回 void。只要 Promise 正常
  // 完成，就不应把同一条 /command 再降级为 session.prompt 的普通文本；只有
  // 执行器明确返回 false / { executed: false } 才表示未处理。
  return result !== false && result?.executed !== false
}

function remoteCommandAuthorized(req) {
  const expected = gatewayToken()
  return !!expected && req.headers.authorization === `Bearer ${expected}`
}

function commandOperationSnapshot(operation) {
  if (!operation) return { active: false, phase: 'idle', command: '', startedAt: 0, endedAt: 0, message: '' }
  return {
    id: operation.id,
    active: operation.active === true,
    phase: operation.phase || 'idle',
    command: String(operation.command || ''),
    startedAt: Number(operation.startedAt) || 0,
    endedAt: Number(operation.endedAt) || 0,
    message: String(operation.message || ''),
    ...(typeof operation.executed === 'boolean' ? { executed: operation.executed } : {}),
  }
}

async function executeRegisteredCommand(ctx, agent, line, signal) {
  return ctx.commands.execute.length === 3
    ? ctx.commands.execute(agent, line, signal)
    : ctx.commands.execute(agent, line, [], signal)
}

function beginCommandOperation(ctx, agent, sessionId, line, command) {
  const existing = commandOperations.get(sessionId)
  if (existing?.active) {
    if (existing.line !== line) throw new Error('当前会话已有命令正在执行，请等待完成后再提交。')
    return { operation: existing, reused: true }
  }
  const operation = { id: randomUUID(), active: true, phase: 'running', command, line, startedAt: Date.now(), endedAt: 0, message: '' }
  commandOperations.set(sessionId, operation)
  // 不把已登记命令绑定到 HTTP 超时：真实 command/done 才是完成边界。
  // 处理器仍接收可用 AbortSignal，以符合命令执行器的契约。
  const signal = new AbortController().signal
  void executeRegisteredCommand(ctx, agent, line, signal).then((result) => {
    operation.active = false
    operation.endedAt = Date.now()
    operation.executed = commandWasExecuted(result)
    operation.phase = !operation.executed || result?.result?.kind === 'error' ? 'failed' : 'complete'
    operation.message = operation.phase === 'failed' ? (operation.executed ? 'command-failed' : 'command-not-executed') : String(result?.result?.text || '').slice(0, 2000)
  }, (error) => {
    operation.active = false
    operation.endedAt = Date.now()
    operation.phase = 'failed'
    operation.message = 'command-failed'
  }).finally(() => {
    const cleanup = setTimeout(() => {
      if (commandOperations.get(sessionId) === operation && !operation.active) commandOperations.delete(sessionId)
    }, COMMAND_OPERATION_RETENTION_MS)
    cleanup.unref?.()
  })
  return { operation, reused: false }
}

async function resolveFile(pathname) {
  // 安装包在 public/ 之外，精确映射此文件，不能开放整个插件目录。
  let abs = pathname === `${MOUNT}/dsh-remote.apk`
    ? fileURLToPath(new URL('./apk/dsh-remote.apk', import.meta.url)) : targetPath(pathname)
  if (abs === null) return null
  try {
    let info = await stat(abs)
    if (info.isDirectory()) {
      abs = resolve(abs, INDEX_FILE)
      info = await stat(abs)
    }
    if (!info.isFile() && !extname(abs)) {
      abs = abs + '.html' // /remote/admin -> admin.html
      info = await stat(abs)
    }
    return info.isFile() ? { abs, info } : null
  } catch {
    if (!extname(abs)) {
      // /remote/admin 无此裸文件 -> 再试 admin.html
      try {
        const alt = abs + '.html'
        const info = await stat(alt)
        return info.isFile() ? { abs: alt, info } : null
      } catch {
        return null
      }
    }
    return null
  }
}

// Read metadata inside the actual DSH Host, never from the gateway's cwd/version.
export function hostDescription(ctx, runtime = process) {
  let dshVersion = null, attachedSessions = null
  const profile = detectProfile(ctx, runtime.argv[1], runtime)
  if (profile?.cli) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dirname(profile.cli), '../package.json'), 'utf8'))
      const expected = profile.cliMode === 'desktop' ? '@deepseek-ai/dsh-desktop-host' : '@deepseek-ai/dsh'
      if (pkg.name === expected && typeof pkg.version === 'string') dshVersion = pkg.version.slice(0, 100)
    } catch {}
  }
  try {
    const agents = ctx.agents.list()
    if (Array.isArray(agents)) attachedSessions = agents.length
  } catch {}
  return { version: dshVersion, cwd: runtime.cwd(), attachedSessions, home: homedir(), canOpenPath: false, metadataOnly: true }
}

async function serveStatic(req, res, ctx) {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  if (pathname === `${MOUNT}/admin/api/browser-launch`) {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
    if (req.headers['x-dsh-remote-client'] !== 'entry') return sendJson(res, 403, { ok: false, code: 'explicit-entry-required' })
    if ([...new URL(req.url, 'http://x').searchParams].length) return sendJson(res, 400, { ok: false, code: 'invalid-query' })
    // Prefix routes are not automatically authenticated by DSH. Require its
    // signed browser cookie before minting a browser launch URL.
    if (typeof ctx.connection?.authorizeIndex !== 'function') return sendJson(res, 503, { ok: false, code: 'browser-auth-unavailable' })
    if (!ctx.connection.authorizeIndex(req, res)) return
    // Never accept a destination/Host header or expose a Remote gateway token.
    let url
    try { url = browserLaunchUrl(ctx) } catch (_) {}
    return sendJson(res, url ? 200 : 503, url ? { ok: true, url } : { ok: false, code: 'browser-auth-unavailable' })
  }
  if (pathname === `${MOUNT}/api/doctor/target` || pathname === `${MOUNT}/admin/api/doctor-target`) {
    res.setHeader('cache-control','no-store')
    if(pathname===`${MOUNT}/api/doctor/target` && !remoteCommandAuthorized(req))return sendJson(res,401,{ok:false,code:'unauthorized'})
    if(req.method!=='GET')return sendJson(res,405,{ok:false,code:'read-only'})
    if([...new URL(req.url,'http://x').searchParams].length)return sendJson(res,400,{ok:false,code:'invalid-query'})
    return sendJson(res,200,readDoctorTarget(ctx))
  }
  if (pathname === `${MOUNT}/api/host-description`) {
    res.setHeader('cache-control', 'no-store')
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, code: 'unauthorized' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'method-not-allowed' })
    return sendJson(res, 200, { ok: true, ...hostDescription(ctx) })
  }
  if (pathname.startsWith(`${MOUNT}/api/skills/`)) {
    res.setHeader('cache-control', 'no-store')
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, code: 'unauthorized' })
    const adapter = createSkillsAdapter(async path => {
      // Use this host's listener, never a URL, origin or cookie supplied by the caller.
      const base = upstreamUrlForListener({ host: ctx.webServer.host, port: ctx.webServer.port })
      let cookie = ''
      try { cookie = readFileSync(dshUpstreamCookieFile(), 'utf8').trim() } catch {}
      const response = await fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(10000) })
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('native-read-failed'), { status: response.status }) }
      const chunks = []; let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) throw new Error('response-too-large')
        chunks.push(chunk)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('unsupported') }
    })
    const url = new URL(req.url, 'http://x')
    const result = await adapter.handle(req.method, pathname.slice(`${MOUNT}/api/skills`.length), url.searchParams)
    return sendJson(res, result.status, result.body)
  }
  if (pathname === `${MOUNT}/api/task-board`) {
    res.setHeader('cache-control', 'no-store')
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, code: 'unauthorized' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'read-only' })
    const result = await readTaskBoard(ctx, new URL(req.url, 'http://x').searchParams)
    return sendJson(res, result.status, result.body)
  }
  if (pathname === `${MOUNT}/api/teams`) {
    res.setHeader('cache-control', 'no-store')
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, code: 'unauthorized' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'read-only' })
    const result = await readTeamInsights(ctx, new URL(req.url, 'http://x').searchParams, async archived => {
      let cookie = ''
      try { cookie = readFileSync(dshUpstreamCookieFile(), 'utf8').trim() } catch {}
      if (cookie.length > 4096 || /[\x00-\x1f]/.test(cookie)) cookie = ''
      return fetch(upstreamUrlForListener(dshListen) + '/plugins/dsh-agent-teams/state' + (archived ? '?archived=1' : ''), {
        headers: cookie ? { cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(20000)
      })
    })
    return sendJson(res, result.status, result.body)
  }
  if (pathname === `${MOUNT}/api/insights/peak-reminders`) {
    res.setHeader('cache-control', 'no-store')
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, code: 'unauthorized' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'read-only' })
    if ([...new URL(req.url, 'http://x').searchParams].length) return sendJson(res, 400, { ok: false, code: 'invalid-query' })
    const result = await readPeakReminders(ctx)
    return sendJson(res, result.status, result.body)
  }
  if (pathname === `${MOUNT}/api/insights/cost`) {
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, code: 'unauthorized' })
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'read-only' })
    const query = new URL(req.url, 'http://x').searchParams
    if ([...query.keys()].some(key => key !== 'sessionId') || query.getAll('sessionId').length > 1) return sendJson(res, 400, { ok: false, code: 'invalid-query' })
    const result = await readCostInsights(ctx, query.get('sessionId') || '')
    res.setHeader('cache-control', 'no-store')
    return sendJson(res, result.status, result.body)
  }
  if (pathname.startsWith(`${MOUNT}/api/plugins/`)) {
    res.setHeader('cache-control', 'no-store')
    if (!remoteCommandAuthorized(req)) return sendJson(res, 401, { ok: false, message: 'unauthorized' })
    try {
      const url = new URL(req.url, 'http://x')
      const body = req.method === 'POST' ? JSON.parse((await readBody(req, 8192)) || '{}') : {}
      const result = await pluginCenters.get(ctx).handle(req.method, pathname.slice(`${MOUNT}/api/plugins`.length), body, url.searchParams)
      return sendJson(res, req.method === 'POST' ? 202 : 200, result)
    } catch (error) {
      return sendJson(res, error.status || (error instanceof SyntaxError ? 400 : 500), { ok: false, message: error.message || 'Plugin operation failed' })
    }
  }

  // 无尾斜杠的入口重定向到带斜杠版本:
  // 否则相对资源 styles.css/app.js 会按 URL 规则解析到上级路径 /styles.css,
  // 被 DSH 的 SPA fallback 返回 HTML, 表现为白底 + 脚本不运行。
  if (pathname === MOUNT) {
    res.writeHead(302, { location: `${MOUNT}/` })
    res.end()
    return
  }
  if (pathname === `${MOUNT}/admin`) {
    res.writeHead(302, { location: `${MOUNT}/admin/` })
    res.end()
    return
  }

  // The embedded panel is already authenticated by the DSH web listener,
  // like the adjacent admin/state route. Read cost-meter without a gateway.
  if (pathname === `${MOUNT}/admin/api/cost`) {
    res.setHeader('cache-control', 'no-store')
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'read-only' })
    const result = await readCostInsights(ctx)
    return sendJson(res, result.status, result.body)
  }

  // Legacy stats API retained for older clients.
  if (pathname === `${MOUNT}/admin/api/stats/summary` || pathname === `${MOUNT}/admin/api/stats/detail`) {
    const query = new URL(req.url ?? '/', 'http://x').search
    const sub = pathname.slice(`${MOUNT}/admin/api/stats`.length)
    const proxied = await proxyGateway(`/stats${sub}${query}`, 'GET', '')
    if (proxied !== null) {
      sendJson(res, proxied.status, proxied.json)
    } else {
      sendJson(res, 502, { ok: false, error: '本地网关不可用, Token 统计需要网关运行' })
    }
    return
  }

  // 管理控制台数据: 优先代理本地网关(设备监控/更新检查完整), 网关不可用回退插件状态
  if (pathname === `${MOUNT}/admin/api/state`) {
    void ensureGateway() // 自愈: 开关为 on 而网关没起来时, 后台拉起, 下个轮询即可见网关
    const health = await gatewayRunning() // 新网关可在健康探测时恢复缺失的令牌文件
    const localToken = gatewayToken()
    const proxied = await proxyGateway('/admin/api/state', 'GET', '')
    if (proxied?.status === 200 && proxied.json.ok === true) {
      // 主机端 DSH 面板本身已登录本机用户, 管理页无需令牌门禁;
      // 把真实网关令牌一并返回, 抽屉里直接显示并允许复制(供手机 App 使用)。
      sendJson(res, proxied.status, { ...proxied.json, token: localToken, mode: 'gateway', via: 'gateway', gatewayInstalled, gatewayRuntime: await gatewayRuntimeForStatus(proxied.json.gatewayRuntime ?? null, health) })
      return
    }
    if (health.running && proxied?.status >= 500) {
      sendJson(res, proxied.status, { ...proxied.json, gatewayRunning: true })
      return
    }
    sendJson(res, 200, {
      ok: true,
      mode: 'plugin',
      gatewayRunning: health.running,
      gatewayAuthError: health.running && (!localToken || proxied?.status === 401 || proxied?.status === 403) ? GATEWAY_AUTH_HINT : '',
      gatewayVersion: health.version || '',
      gatewayRuntime: await gatewayRuntimeForStatus(null, health),
      version,
      token: health.running ? '' : localToken || '',
      gatewayInstalled,
      platform: process.platform,
      hostname: hostname(),
      lanIPs: lanIPs(),
      startedAt: Date.now() - Math.floor(process.uptime() * 1000),
      uptimeSec: Math.floor(process.uptime()),
      host: dshListen.host,
      port: dshListen.port,
      protocol: { version: 1 },
      capabilities: {
        wsTicket: 0,
        eventPolling: 0,
        workspaceFiles: 0,
        imagePromptTransport: 0,
        dshLifecycle: 0,
        centralAnnouncements: 0,
        feedback: 0,
        deviceKeys: 0,
      },
      dshControl: { supported: false, code: 'EXTERNAL_LIFECYCLE', message: '插件内嵌模式不负责管理 DSH 自身进程' },
      deviceKeys: { supported: false, enabled: false, entries: [] },
      upstream: { url: 'DSH 内嵌(同进程, 无需网关)', reachable: true },
      latest: { version, newer: false },
      onlineCount: 0,
      deviceCount: 0,
      totalRequests: 0,
      authFailures: 0,
      events: {
        mux: { connected: false, attempt: 0, lastError: '网关未运行' },
        host: { connected: false, attempt: 0, lastError: '网关未运行' },
      },
      devices: [],
    })
    return
  }
  const gatewayAdminMutations = new Map([
    [`${MOUNT}/admin/api/note`, '/note'],
    [`${MOUNT}/admin/api/kick`, '/kick'],
    [`${MOUNT}/admin/api/token/rotate`, '/token/rotate'],
    [`${MOUNT}/admin/api/device-keys/mode`, '/device-keys/mode'],
    [`${MOUNT}/admin/api/device-keys/create`, '/device-keys/create'],
    [`${MOUNT}/admin/api/device-keys/note`, '/device-keys/note'],
    [`${MOUNT}/admin/api/device-keys/rotate`, '/device-keys/rotate'],
    [`${MOUNT}/admin/api/device-keys/revoke`, '/device-keys/revoke'],
  ])
  if (pathname === `${MOUNT}/admin/api/relay` || pathname === `${MOUNT}/admin/api/autostart`) {
    if (!['GET', 'POST'].includes(req.method)) { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
    const body = req.method === 'POST' ? await readBody(req, 4096) : undefined
    const proxied = await proxyGateway(pathname.endsWith('/autostart') ? '/admin/api/autostart' : '/admin/api/relay', req.method, body)
    sendJson(res, proxied?.status || 502, proxied?.json || { error: 'GATEWAY_UNAVAILABLE' })
    return
  }
  if (gatewayAdminMutations.has(pathname)) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const body = await readBody(req, 4096)
    const sub = gatewayAdminMutations.get(pathname)
    const proxied = await proxyGateway(`/admin/api${sub}`, 'POST', body)
    if (proxied !== null) {
      sendJson(res, proxied.status, proxied.json)
    } else {
      sendJson(res, 502, { ok: false, error: '本地网关不可用, 设备管理需在网关模式操作' })
    }
    return
  }

  // 网关端口配置(仅插件内嵌页使用): GET 当前生效端口 / PUT 修改端口
  if (pathname === `${MOUNT}/admin/api/config`) {
    if (req.method === 'GET') {
      const h = await gatewayRunning()
      sendJson(res, 200, {
        ok: true,
        port: Number(readGatewayPort()),
        running: h.running,
        source: process.env.DSH_REMOTE_GATEWAY_PORT ? 'env' : existsSync(gatewayPortFile()) ? 'file' : 'default',
      })
      return
    }
    if (req.method === 'PUT') {
      let body = {}
      try {
        body = JSON.parse((await readBody(req, 4096)) || '{}')
      } catch {}
      const port = Number(body.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        sendJson(res, 400, { ok: false, error: '端口必须是 1-65535 的整数' })
        return
      }
      const oldPort = Number(readGatewayPort())
      // 先在切换配置前读取旧端口上的健康状态；写入新端口后 gatewayRunning()
      // 只会探测新端口，否则旧网关会变成孤儿进程继续占用旧端口。
      const oldHealth = process.env.DSH_REMOTE_GATEWAY ? { running: false } : await gatewayRunning()
      if (!process.env.DSH_REMOTE_GATEWAY_PORT && port !== oldPort && oldHealth.running && !await killGateway(oldHealth)) {
        sendJson(res, 409, { ok: false, error: '无法通过认证关闭旧网关，端口配置未修改' })
        return
      }
      try {
        mkdirSync(`${homedir()}/.dsh-remote`, { recursive: true })
        writeFileSync(gatewayPortFile(), String(port) + '\n')
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '写入端口配置失败: ' + (e?.message || String(e)) })
        return
      }
      const effectivePort = Number(readGatewayPort())
      let running = (await gatewayRunning()).running
      if (gatewayAutostart()) {
        const startOut = await startGateway()
        running = !!startOut.running || (await gatewayRunning()).running
      }
      sendJson(res, 200, { ok: true, port: Number(port), effectivePort, running })
      return
    }
    res.writeHead(405, { allow: 'GET, PUT' })
    res.end()
    return
  }

  // 本地网关开关(仅插件内嵌页使用): GET 状态 / POST {action:'start'|'stop'}
  if (pathname === `${MOUNT}/admin/api/gateway`) {
    if (req.method === 'GET') {
      const h = await gatewayRunning()
      sendJson(res, 200, {
        ok: true, running: h.running, version: h.version || '', upstream: h.upstream || '', upstreamOk: h.upstreamOk === true,
        runtime: await gatewayRuntimeForStatus(undefined, h),
      })
      return
    }
    if (req.method === 'POST') {
      let action = ''
      try {
        const raw = await readBody(req, 4096)
        action = JSON.parse(raw || '{}').action
      } catch {}
      if (action === 'start') sendJson(res, 200, await startGateway())
      else if (action === 'stop') sendJson(res, 200, await stopGateway())
      else sendJson(res, 400, { ok: false, error: 'action 必须是 start 或 stop' })
      return
    }
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }

  // 远程启动/重启 DSH: 内嵌抽屉通过插件前缀转发到独立网关。
  if (pathname === `${MOUNT}/admin/api/dsh`) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }
    const body = req.method === 'POST' ? await readBody(req, 4096) : ''
    const query = new URL(req.url, 'http://x').search
    const proxied = await proxyGateway('/admin/api/dsh' + query, req.method, body)
    if (proxied !== null) {
      sendJson(res, proxied.status, proxied.json)
    } else {
      sendJson(res, 502, { ok: false, error: '本地网关不可用，无法控制 DSH' })
    }
    return
  }

  if (pathname === `${MOUNT}/api/session-file`) {
    if (!remoteCommandAuthorized(req)) { sendJson(res,401,{ok:false,message:'unauthorized'});return }
    return serveSessionFile(ctx, req, res, new URL(req.url, 'http://host'))
  }
  // 命令状态：由插件进程跟踪长期操作，客户端重连后可恢复可见状态。
  if (pathname === `${MOUNT}/api/command-status`) {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    if (!remoteCommandAuthorized(req)) {
      sendJson(res, 401, { ok: false, message: 'unauthorized' })
      return
    }
    const sessionId = new URL(req.url ?? '/', 'http://x').searchParams.get('sessionId') || ''
    if (!sessionId) {
      sendJson(res, 400, { ok: false, message: 'sessionId required' })
      return
    }
    const operation = commandOperationSnapshot(commandOperations.get(sessionId))
    // compact 为上一版客户端保留，新的客户端统一读取 operation。
    sendJson(res, 200, { ok: true, operation, compact: operation.command === 'compact' ? operation : commandOperationSnapshot(null) })
    return
  }

  // 斜杠命令桥接：客户端 → 网关 → 插件端点 → ctx.commands.execute
  if (pathname === `${MOUNT}/api/command`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!remoteCommandAuthorized(req)) {
      sendJson(res, 401, { ok: false, message: 'unauthorized' })
      return
    }
    let body
    try {
      body = JSON.parse((await readBody(req, 8192)) || '{}')
    } catch (error) {
      sendJson(res, error.status === 413 ? 413 : 400, { ok: false, message: error.status === 413 ? 'body too large' : 'invalid json' })
      return
    }
    const { sessionId, line } = body || {}
    if (!sessionId || typeof line !== 'string') {
      sendJson(res, 400, { ok: false, message: 'sessionId and line required' })
      return
    }
    try {
      const { agent, resolvePath } = await resolveAgent(ctx, sessionId)
      if (!agent) {
        sendJson(res, 200, { ok: false, message: 'agent not found', debug: { resolvePath, commandNames: [] } })
        return
      }
      let commandEntries = null
      let commandNames = []
      try {
        const listed = await ctx.commands.list(agent)
        commandEntries = Array.isArray(listed) ? listed : null
        commandNames = commandEntries ? commandEntries.map(commandEntryName).filter(Boolean) : []
      } catch (e) {
        commandNames = ['list-error']
      }
      const name = commandHead(line)
      if (commandEntries && (!name || !commandEntries.some(entry => commandEntryName(entry) === name))) {
        // 仅把 DSH 已登记的 slash command 截留到命令服务。未知 /xxx 仍让客户端
        // 按普通文本发送，保持 DSH 自己处理自定义提示词的兼容行为。
        sendJson(res, 200, { ok: true, executed: false, debug: { resolvePath, commandNames, reason: 'unknown-command' } })
        return
      }
      // /export 的成功结果必须先回到客户端，由客户端再发起 ZIP 下载；其他已登记
      // 命令统一异步受理，避免把未知耗时绑定到一条 HTTP 请求。
      if (name && (name !== 'export' || body.async === true)) {
        const { operation, reused } = beginCommandOperation(ctx, agent, sessionId, line, name)
        sendJson(res, 202, {
          ok: true,
          executed: true,
          accepted: true,
          operation: commandOperationSnapshot(operation),
          compact: name === 'compact' ? commandOperationSnapshot(operation) : undefined,
          debug: { resolvePath, commandNames, reused },
        })
        return
      }
      // /export 在持久化历史较大时会等待刷新；其他同步命令沿用较短超时。
      const signal = AbortSignal.timeout(LONG_RUNNING_COMMANDS.has(name)
        ? LONG_RUNNING_COMMAND_TIMEOUT_MS
        : DEFAULT_COMMAND_TIMEOUT_MS)
      const result = await executeRegisteredCommand(ctx, agent, line, signal)
      sendJson(res, 200, { ok: true, executed: commandWasExecuted(result), debug: { resolvePath, commandNames } })
    } catch (e) {
      sendJson(res, 200, { ok: false, message: 'command-failed' })
    }
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const found = await resolveFile(pathname)
  if (found === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const { abs, info } = found
  const lastModified = info.mtime.toUTCString()
  const mtimeSec = Math.floor(info.mtime.getTime() / 1000) * 1000
  const ims = req.headers['if-modified-since']
  if (ims && new Date(ims).getTime() >= mtimeSec) {
    res.writeHead(304, { 'last-modified': lastModified })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': extname(abs) === '.apk' ? 'application/vnd.android.package-archive' : MIME[extname(abs)] ?? 'application/octet-stream',
    ...(extname(abs) === '.apk' ? { 'content-disposition': 'attachment; filename="dsh-remote.apk"', 'x-content-type-options': 'nosniff' } : {}),
    'content-length': info.size,
    'cache-control': 'no-cache',
    'last-modified': lastModified,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(abs)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

const pluginCenters = new WeakMap()
export function desktopLaunchConfig(ctx) {
  if (process.platform !== 'win32' || !process.versions.electron) return null
  const profile = detectProfile(ctx)
  const hostScript = process.argv[1] || ''
  if (profile?.name !== 'desktop' || !/[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]index\.js$/.test(hostScript)) return null
  const pid = process.pid, parent = process.ppid
  try {
    const script = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(' + [pid,parent].map(id =>
      "Get-CimInstance Win32_Process -Filter 'ProcessId=" + id + "' | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;executable=$_.ExecutablePath;command=$_.CommandLine;started=$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')} }").join('; ') + ') | ConvertTo-Json -Compress'
    const rows = JSON.parse(execFileSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { encoding:'utf8', timeout:8000, windowsHide:true }))
    const host = rows.find(row => row.pid === pid), root = rows.find(row => row.pid === parent)
    if (!host || !root || host.parent !== root.pid || resolve(root.executable) !== resolve(process.execPath) || resolve(host.executable) !== resolve(process.execPath) || /--(?:type|expose-internals)\b/.test(root.command)) return null
    return { version:1, kind:'desktop', executable:process.execPath, args:[], cwd:dirname(process.execPath), profile:'desktop', env:{DSH_HOME:profile.home},
      upstream:upstreamUrlForListener(ctx.webServer), desktop:{root:{pid:root.pid,started:root.started},host:{pid:host.pid,started:host.started},hostScript,profilePath:profile.dir} }
  } catch (error) { logGateway('Desktop 启动信息核验失败: ' + error.message); return null }
}

export function saveDshLaunchConfig(ctx) {
  if (process.platform !== 'win32') return false
  const desktop = desktopLaunchConfig(ctx)
  if (process.versions.electron && !desktop) return false
  const profile = detectProfile(ctx)
  if (!desktop && (!profile?.cli || profile.name === 'desktop' || resolve(process.argv[1] || '') !== resolve(profile.cli))) return false
  const env = { DSH_HOME: profile.home }
  for (const key of ['HOME', 'USERPROFILE', 'PATH', 'NODE_OPTIONS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const args = desktop ? [] : [profile.cli, ...process.argv.slice(2)]
  if (!desktop && !args.includes('--no-open')) args.push('--no-open')
  const config = desktop || { version: 1, executable: process.execPath, args, cwd: process.cwd(),
    env, profile: profile.name, upstream: upstreamUrlForListener({ host: ctx.webServer.host, port: ctx.webServer.port }) }
  const file = process.env.DSH_REMOTE_DSH_LAUNCH_FILE || `${homedir()}/.dsh-remote/dsh-launch.json`
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch (err) {
    logGateway('无法保存 DSH 启动配置: ' + err.message)
    return false
  }
}

export function apply(ctx) {
  pluginCenters.set(ctx, createPluginCenter(ctx))
  dshListen = { host: ctx.webServer.host, port: ctx.webServer.port }
  dshConnection = ctx.connection
  saveDshLaunchConfig(ctx)
  // Optional on older DSH: register the packaged read-only doctor skill when
  // the host exposes a skill registry. Failure never blocks the plugin.
  registerDoctorSkill(ctx)
  registerFileDeliveryTools(ctx, { gatewayBase, gatewayToken })
  watchDoctorWorkspaces(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: (req, res) => serveStatic(req, res, ctx).catch(error => {
      if (res.writableEnded || res.destroyed) return
      if (res.headersSent) return res.destroy()
      if (error.status === 413) res.setHeader('connection', 'close')
      sendJson(res, error.status || (error instanceof SyntaxError ? 400 : 500), { ok: false, message: error.status === 413 ? 'body too large' : 'request-failed' })
    }),
  }), 'dsh-remote: /remote route')
  // 实时统计: 监听 DSH 会话事件流, 把带 usage 的 assistant/message 投递到网关聚合
  ctx.on('session/event', (session, event) => {
    statsSend(session, event)
  })
  // DSH 启动/重启后自愈: 用户没关过网关就自动拉起(默认开, DSH_REMOTE_AUTOSTART=0 关闭)
  void ensureGateway()
  // apply 可能早于 Web 监听完成；延迟再交换一次新版 DSH 的会话 Cookie。
  ctx.effect(() => {
    const timer = setTimeout(() => { void ensureGateway() }, 5000)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'dsh-remote: refresh upstream authentication')
}
