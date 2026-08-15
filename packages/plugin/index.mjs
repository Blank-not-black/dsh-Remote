/* dsh-remote DSH 插件 · Node half
 * 在 DSH Web 的 httpServer 上挂 /remote 前缀路由:
 *   - /remote/...        移动控制台 + 主机管理页静态资源
 *   - /remote/admin/api  插件模式的主机状态(设备监控只在独立网关模式提供)
 * 主页注入右下角悬浮按钮 + 右侧滑出抽屉, iframe 内嵌控制台, 不新开页面。
 * 前端页面同源直连 DSH 原生 /api (RPC) 与 /api/events.* (WebSocket)。
 */
import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { hostname, networkInterfaces } from 'node:os'
import { extname, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-remote'
export const inject = ['webServer']

const MOUNT = '/remote'
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const INDEX_FILE = 'index.html'

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

/** 主页注入: 右下角悬浮按钮 + 右侧滑出抽屉(iframe 懒加载 /remote)。全内联样式, 宿主 CSS 覆盖不动。 */
const INJECT = `
<button id="dsh-remote-fab" title="DSH Remote 控制台" aria-label="打开 DSH Remote" style="position:fixed;right:14px;bottom:14px;z-index:2147483000;width:46px;height:46px;border:none;border-radius:50%;background:#0f766e;color:#fff;font:600 18px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(15,118,110,.4);opacity:.94">📱</button>
<div id="dsh-remote-drawer" aria-hidden="true" style="position:fixed;top:0;right:0;bottom:0;z-index:2147483001;width:min(430px,96vw);background:#0b0e1a;box-shadow:-8px 0 30px rgba(0,0,0,.45);transform:translateX(102%);transition:transform .22s ease;display:flex;flex-direction:column">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#0f766e;color:#fff;font:600 13px/1 system-ui,sans-serif">
    <span>📱 DSH Remote</span>
    <button id="dsh-remote-close" aria-label="关闭" style="border:none;background:transparent;color:#fff;font:600 16px/1 system-ui,sans-serif;cursor:pointer;padding:2px 6px">✕</button>
  </div>
  <iframe id="dsh-remote-frame" title="DSH Remote" style="flex:1;width:100%;border:none;background:#0b0e1a" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"></iframe>
</div>
<script>
(function () {
  var fab = document.getElementById('dsh-remote-fab')
  var drawer = document.getElementById('dsh-remote-drawer')
  var close = document.getElementById('dsh-remote-close')
  var frame = document.getElementById('dsh-remote-frame')
  if (!fab || !drawer || !close || !frame) return
  var loaded = false
  var open = function (show) {
    drawer.style.transform = show ? 'translateX(0)' : 'translateX(102%)'
    drawer.setAttribute('aria-hidden', String(!show))
    if (show && !loaded) { frame.src = '/remote'; loaded = true }
  }
  fab.addEventListener('click', function () { open(true) })
  close.addEventListener('click', function () { open(false) })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') open(false) })
})();
</script>`

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

  // 插件模式的主机状态(管理页 /remote/admin 使用; 网关模式仍走 /admin/api)
  if (pathname === `${MOUNT}/admin/api/state`) {
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
    sendJson(res, 400, { ok: false, error: '设备监控/管理只在独立网关模式(8787)提供' })
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

  // 主页注入悬浮按钮 + 侧边抽屉(iframe 内嵌 /remote, 不新开页面)
  ctx.effect(() => ctx.webServer.tapIndex((html) => {
    if (!html.includes('id="dsh-remote-fab"') && html.includes('</body>')) {
      return html.replace('</body>', `${INJECT}</body>`)
    }
    return html
  }), 'dsh-remote: index drawer injection')
}
