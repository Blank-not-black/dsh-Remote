/* dsh-remote DSH 插件 · Node half
 * 在 DSH Web 的 httpServer 上挂 /remote 前缀路由:
 *   - /remote/...         移动控制台 + 主机管理页静态资源
 *   - /remote/admin/api   管理控制台数据: 优先代理本地网关(完整设备监控/更新检查),
 *                         网关不可用时回退到插件模式主机状态
 * 浏览器侧入口由 client half 注册在 DSH 原生侧边栏(见 client.js)。
 */
import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { extname, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-remote'
export const inject = ['webServer']

const MOUNT = '/remote'
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const INDEX_FILE = 'index.html'
// 本地网关管理 API 代理: 让插件抽屉显示与 8787 网关管理页完全一致的数据。
const GATEWAY_BASE = (process.env.DSH_REMOTE_GATEWAY || 'http://127.0.0.1:8787').replace(/\/+$/, '')

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

function lanIPs() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const it of list ?? []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address)
    }
  }
  return out
}

function targetPath(pathname) {
  const rel = decodeURIComponent(pathname.slice(MOUNT.length)) || '/'
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
    const res = await fetch(`${GATEWAY_BASE}${path}`, {
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

async function serveStatic(req, res) {
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

  // 管理控制台数据: 优先代理本地网关(设备监控/更新检查完整), 网关不可用回退插件状态
  if (pathname === `${MOUNT}/admin/api/state`) {
    const proxied = await proxyGateway('/admin/api/state', 'GET', '')
    if (proxied !== null) {
      sendJson(res, proxied.status, { ...proxied.json, mode: 'gateway', via: 'gateway' })
      return
    }
    sendJson(res, 200, {
      ok: true,
      mode: 'plugin',
      version,
      hostname: hostname(),
      lanIPs: lanIPs(),
      startedAt: Date.now() - Math.floor(process.uptime() * 1000),
      uptimeSec: Math.floor(process.uptime()),
      host: dshListen.host,
      port: dshListen.port,
      upstream: { url: 'DSH 内嵌(同进程, 无需网关)', reachable: true },
      latest: { version, newer: false },
      onlineCount: 0,
      deviceCount: 0,
      totalRequests: 0,
      authFailures: 0,
      devices: [],
    })
    return
  }
  if (pathname === `${MOUNT}/admin/api/note` || pathname === `${MOUNT}/admin/api/kick`) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const body = await readBody(req, 4096)
    const sub = pathname.endsWith('/note') ? '/note' : '/kick'
    const proxied = await proxyGateway(`/admin/api${sub}`, 'POST', body)
    if (proxied !== null) {
      sendJson(res, proxied.status, proxied.json)
    } else {
      sendJson(res, 502, { ok: false, error: '本地网关不可用, 设备管理需在 8787 网关模式操作' })
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
  res.writeHead(200, {
    'content-type': MIME[extname(abs)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(abs).pipe(res)
}

export function apply(ctx) {
  dshListen = { host: ctx.webServer.host, port: ctx.webServer.port }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: serveStatic,
  }), 'dsh-remote: /remote route')
}
