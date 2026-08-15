#!/usr/bin/env node
/**
 * DSH Remote 网关 —— 零依赖 Node 服务
 *
 * 作用:
 *   1. 以静态文件方式托管 mobile web 控制台 (public/)
 *   2. 把 /api/* 请求(HTTP + SSE 流)代理到本机 DSH (127.0.0.1:3080)
 *   3. 提供一层 Bearer Token 认证, 使手机可以在局域网 / Tailscale 里安全访问
 *
 * 用法:
 *   node gateway.js                    # 默认 0.0.0.0:8787
 *   PORT=9000 TOKEN=xxx node gateway.js
 *   DSH_UPSTREAM=http://127.0.0.1:3080 node gateway.js
 *
 * 环境变量:
 *   PORT        监听端口, 默认 8787
 *   HOST        监听地址, 默认 0.0.0.0 (局域网可访问; 也可设 127.0.0.1 + Tailscale serve)
 *   DSH_UPSTREAM  DSH web 服务地址, 默认 http://127.0.0.1:3080
 *   TOKEN       访问令牌; 不设置则读取 ./token 文件, 仍没有则自动生成
 *   TOKEN_FILE  令牌文件路径, 默认 <本目录>/token
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '0.0.0.0'
const UPSTREAM = new URL(process.env.DSH_UPSTREAM || 'http://127.0.0.1:3080')
// 默认放在用户主目录(可写); pkg 打包成单文件后项目目录是只读快照
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(os.homedir(), '.dsh-remote', 'token')

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
  // APK 单独存放, 避免被 cap sync 递归打进 App assets
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
    cors(res)   // App 内置页面跨源访问静态资源(update.json 等)同样需要
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=300',
      'content-length': st.size
    })
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(filePath).pipe(res)
  })
}

// ---------- /api 代理 (HTTP + SSE 一并转发) ----------
function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
}

function proxyApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    cors(res)
    res.writeHead(204)
    res.end()
    return
  }
  if (!authorized(req, url)) {
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
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'].includes(key)) continue
    headers[k] = v
  }
  headers.host = UPSTREAM.host

  const upstreamPath = url.pathname + url.search
  const upstreamReq = http.request({
    hostname: UPSTREAM.hostname,
    port: UPSTREAM.port,
    method: req.method,
    path: upstreamPath,
    headers
  }, (upstreamRes) => {
    const out = { ...upstreamRes.headers }
    delete out['content-length'] // 流式转发时长度由底层处理
    cors(res)
    res.writeHead(upstreamRes.statusCode || 502, out)
    upstreamRes.pipe(res)
  })

  upstreamReq.on('error', (err) => {
    cors(res)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    }
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
  res.end(JSON.stringify({ ok: true, service: 'dsh-remote', upstream: UPSTREAM.origin }))
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
  const url = new URL(req.url, 'http://dsh-remote.local')
  if (url.pathname.startsWith('/api/')) return proxyApi(req, res, url)
  if (url.pathname === '/health') return serveHealth(res)
  return serveStatic(req, res, url)
})

server.listen(PORT, HOST, () => {
  console.log('DSH Remote 网关已启动')
  console.log('  本机:  http://127.0.0.1:' + PORT + '/?token=' + TOKEN)
  for (const ip of lanAddresses()) {
    console.log('  手机(同一网络): http://' + ip + ':' + PORT + '/?token=' + TOKEN)
  }
  if (HOST === '127.0.0.1') {
    console.log('  提示: 监听在 127.0.0.1, 手机请改用 Tailscale serve 或设置 HOST=0.0.0.0')
  }
  console.log('  上游:  ' + UPSTREAM.origin + '  (Ctrl+C 退出)')
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://dsh-remote.local')
  if (!url.pathname.startsWith('/api/')) {
    socket.destroy()
    return
  }
  if (!authorized(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  // 把 WebSocket 升级请求转发到 DSH (浏览器事件流走 WS, 不走 SSE)
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    const key = k.toLowerCase()
    if (['host', 'authorization', 'connection', 'upgrade', 'sec-websocket-key',
      'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol',
      'proxy-connection', 'accept-encoding', 'origin', 'referer',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'].includes(key)) continue
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
