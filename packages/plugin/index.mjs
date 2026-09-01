/* dsh-remote DSH 插件 · Node half
 * 在 DSH Web 的 httpServer 上挂 /remote 前缀路由:
 *   - /remote/...         移动控制台 + 主机管理页静态资源
 *   - /remote/admin/api   管理控制台数据: 优先代理本地网关(完整设备监控/更新检查),
 *                         网关不可用时回退到插件模式主机状态
 * 浏览器侧入口由 client half 注册在 DSH 原生侧边栏(见 client.js)。
 */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import net from 'node:net'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { dirname, extname, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return (process.env.DSH_REMOTE_GATEWAY || `http://127.0.0.1:${readGatewayPort()}`).replace(/\/+$/, '')
}

function gatewayToken() {
  if (process.env.DSH_REMOTE_TOKEN) return process.env.DSH_REMOTE_TOKEN
  try {
    return readFileSync(`${homedir()}/.dsh-remote/token`, 'utf8').trim() || ''
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
  const upstream = `http://${dshListen.host}:${dshListen.port}`
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
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolvePromise(body))
    req.on('error', reject)
  })
}

/** 转发到本地网关管理 API; 失败/超时返回 null。 */
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
      signal: AbortSignal.timeout(1500),
    })
    const json = await res.json().catch(() => ({ ok: false, error: `gateway ${res.status}` }))
    return { status: res.status, json }
  } catch {
    return null
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
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) })
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

async function gatewayRunning() {
  try {
    const res = await fetch(`${gatewayBase()}/health`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { running: false }
    const data = await res.json().catch(() => ({}))
    return {
      running: true,
      pid: Number(data.pid) || 0,
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

function readGatewayPid() {
  try {
    const pid = Number(readFileSync(gatewayPidFile(), 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

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
  const pid = (health && Number(health.pid)) || readGatewayPid()
  if (!pid) return false
  try {
    if (process.platform === 'win32') {
      await runExit('taskkill', ['/F', '/PID', String(pid)])
    } else {
      process.kill(pid)
    }
    logGateway('已停止旧网关 PID=' + pid)
    await sleep(300)
    return true
  } catch (e) {
    logGateway('停止旧网关失败 PID=' + pid + ' ' + (e?.message || String(e)))
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

/** 启动随插件分发的 gateway.cjs; 已运行则直接返回。 */
async function startGateway() {
  const upstream = `http://${dshListen.host}:${dshListen.port}`
  const health = await gatewayRunning()
  if (health.running) {
    setGatewayEnabled(true)
    return { ok: true, running: true, started: false }
  }
  const script = GATEWAY_SCRIPT
  if (!existsSync(script)) {
    return { ok: false, running: false, error: '插件包缺少 gateway.cjs, 请升级插件' }
  }
  const port = readGatewayPort()
  if (await portInUse(port)) {
    logGateway(`端口 ${port} 已被占用, 拒绝启动`)
    return { ok: false, running: false, error: `端口 ${port} 已被占用，请在插件页修改网关端口后重试` }
  }
  logGateway('启动网关, 端口: ' + port + ', 上游: ' + upstream)

  // 首选 systemd-run: 网关成为独立 user 单元, DSH 重启/升级不会连带杀掉它
  let sysd = false
  try {
    await runExit('systemctl', ['--user', 'reset-failed', 'dsh-remote-gateway'])
    sysd = (await runExit('systemd-run', [
      '--user', '--unit=dsh-remote-gateway', '--service-type=exec',
      ...gatewaySystemdEnvArgs(),
      '--setenv=PORT=' + port, '--setenv=HOST=0.0.0.0', '--setenv=DSH_UPSTREAM=' + upstream,
      '--', process.execPath, script,
    ])) === 0
  } catch {}
  if (sysd) {
    try {
      const pid = Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', 'dsh-remote-gateway'], { encoding: 'utf8' }).trim())
      if (Number.isFinite(pid) && pid > 1) writeGatewayPid(pid)
    } catch {}
  }

  // 无 systemd 的机器回退: detached 子进程
  if (!sysd) {
    let logFd = null
    try {
      logFd = openSync(`${homedir()}/.dsh-remote/plugin-gateway.log`, 'a')
    } catch {}
    const child = spawn(process.execPath, [script], {
      cwd: dirname(script),
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      env: { ...process.env, PORT: port, DSH_UPSTREAM: upstream },
    })
    child.unref()
    writeGatewayPid(child.pid)
  }
  // 最多等 4 秒; 超过可能是端口冲突或首次初始化, 前端稍后刷新即可
  for (let i = 0; i < 16; i++) {
    await sleep(250)
    const h = await gatewayRunning()
    if (h.running) {
      if (h.pid) writeGatewayPid(h.pid)
      setGatewayEnabled(true)
      return { ok: true, running: true, started: true }
    }
  }
  return { ok: true, running: false, pending: true, hint: '网关启动中, 稍后刷新' }
}

let ensurePromise = null
/** 自愈入口: 状态轮询/DSH 启动时调用。开关为 on 且网关没起来, 就自动拉起(并发只拉一次)。 */
function ensureGateway() {
  if (!gatewayAutostart()) return Promise.resolve(false)
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    try {
      await refreshDshUpstreamCookie()
      const health = await gatewayRunning()
      if (!health.running) {
        const out = await startGateway()
        return !!out.running
      }
      const upstream = `http://${dshListen.host}:${dshListen.port}`
      const oldUpstream = health.upstream || ''
      const oldVersion = health.version || '?'
      const versionMismatch = oldVersion !== version
      // 上游暂时不可达不应重启网关: VPN/DSH 重启/短暂网络抖动时，
      // 重启只能制造额外断线，网关应保持运行并通过 /health 暴露 degraded 状态。
      if (versionMismatch || (oldUpstream && oldUpstream !== upstream) || (!oldUpstream && upstream)) {
        logGateway(`网关需刷新: 版本 ${oldVersion} -> ${version}, 上游 ${oldUpstream || '?'} -> ${upstream}`)
        await killGateway(health)
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
  const token = gatewayToken()
  if (!token) return { ok: false, running: false, error: '找不到 ~/.dsh-remote/token, 无法认证网关' }
  try {
    const res = await fetch(`${gatewayBase()}/admin/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-dsh-remote-client': 'admin' },
      signal: AbortSignal.timeout(2000),
    })
    const json = await res.json().catch(() => ({}))
    if (res.ok) setGatewayEnabled(false)
    return { ok: res.ok, running: false, ...json }
  } catch (e) {
    return { ok: false, running: false, error: '网关不可达: ' + (e?.message || e) }
  }
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
    return { agent: null, resolvePath: 'resume-error: ' + (e?.message || String(e)) }
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
    active: operation.active === true,
    phase: operation.phase || 'idle',
    command: String(operation.command || ''),
    startedAt: Number(operation.startedAt) || 0,
    endedAt: Number(operation.endedAt) || 0,
    message: String(operation.message || ''),
  }
}

async function executeRegisteredCommand(ctx, agent, line, signal) {
  return ctx.commands.execute.length === 3
    ? ctx.commands.execute(agent, line, signal)
    : ctx.commands.execute(agent, line, [], signal)
}

function beginCommandOperation(ctx, agent, sessionId, line, command) {
  const existing = commandOperations.get(sessionId)
  if (existing?.active) return { operation: existing, reused: true }
  const operation = { active: true, phase: 'running', command, startedAt: Date.now(), endedAt: 0, message: '' }
  commandOperations.set(sessionId, operation)
  // 不把已登记命令绑定到 HTTP 超时：真实 command/done 才是完成边界。
  // 处理器仍接收可用 AbortSignal，以符合命令执行器的契约。
  const signal = new AbortController().signal
  void executeRegisteredCommand(ctx, agent, line, signal).then((result) => {
    operation.active = false
    operation.endedAt = Date.now()
    operation.phase = result?.result?.kind === 'error' ? 'failed' : 'complete'
    operation.message = String(result?.result?.text || '')
  }, (error) => {
    operation.active = false
    operation.endedAt = Date.now()
    operation.phase = 'failed'
    operation.message = error?.message || String(error)
  }).finally(() => {
    const cleanup = setTimeout(() => {
      if (commandOperations.get(sessionId) === operation && !operation.active) commandOperations.delete(sessionId)
    }, COMMAND_OPERATION_RETENTION_MS)
    cleanup.unref?.()
  })
  return { operation, reused: false }
}

async function resolveFile(pathname) {
  let abs = targetPath(pathname)
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

async function serveStatic(req, res, ctx) {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname

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

  // 统计面板数据: 代理到本地网关 /stats/*(网关未运行则返回 502)
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
    const localToken = gatewayToken()
    const proxied = await proxyGateway('/admin/api/state', 'GET', '')
    if (proxied !== null) {
      // 主机端 DSH 面板本身已登录本机用户, 管理页无需令牌门禁;
      // 把真实网关令牌一并返回, 抽屉里直接显示并允许复制(供手机 App 使用)。
      sendJson(res, proxied.status, { ...proxied.json, token: localToken, mode: 'gateway', via: 'gateway', gatewayInstalled })
      return
    }
    sendJson(res, 200, {
      ok: true,
      mode: 'plugin',
      version,
      token: localToken || '',
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
      try {
        mkdirSync(`${homedir()}/.dsh-remote`, { recursive: true })
        writeFileSync(gatewayPortFile(), String(port) + '\n')
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '写入端口配置失败: ' + (e?.message || String(e)) })
        return
      }
      const effectivePort = Number(readGatewayPort())
      if (effectivePort !== oldPort) {
        if (oldHealth.running) await killGateway(oldHealth)
      }
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
      sendJson(res, 200, { ok: true, running: h.running, version: h.version || '', upstream: h.upstream || '', upstreamOk: h.upstreamOk === true })
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
    const proxied = await proxyGateway('/admin/api/dsh', req.method, body)
    if (proxied !== null) {
      sendJson(res, proxied.status, proxied.json)
    } else {
      sendJson(res, 502, { ok: false, error: '本地网关不可用，无法控制 DSH' })
    }
    return
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
    } catch {
      sendJson(res, 400, { ok: false, message: 'invalid json' })
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
        commandNames = ['list-error: ' + (e?.message || String(e))]
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
      if (name && name !== 'export') {
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
      sendJson(res, 200, { ok: false, message: e?.message || String(e) })
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
    'content-type': MIME[extname(abs)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
    'last-modified': lastModified,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(abs).pipe(res)
}

export function apply(ctx) {
  dshListen = { host: ctx.webServer.host, port: ctx.webServer.port }
  dshConnection = ctx.connection
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: (req, res) => serveStatic(req, res, ctx),
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
