/* dsh-remote DSH 插件 · Node half
 * 在 DSH Web 的 httpServer 上挂 /remote 前缀路由, 提供移动控制台静态页。
 * 前端页面同源直连 DSH 原生 /api (RPC) 与 /api/events.* (WebSocket),
 * 因此插件本身零网络转发、零令牌、零依赖。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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

/** 主页浮动入口: 内联样式, 宿主 CSS 覆盖不动。青色系(红绿色弱友好)。 */
const ENTRY_BUTTON = `<a href="${MOUNT}" id="dsh-remote-entry" style="position:fixed;right:16px;bottom:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;background:#0f766e;color:#fff;font:600 13px/1 system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(15,118,110,.35);opacity:.92">📱 Remote</a>`

function targetPath(pathname) {
  const rel = decodeURIComponent(pathname.slice(MOUNT.length)) || '/'
  const file = rel === '/' ? INDEX_FILE : rel.replace(/^\/+/, '')
  const abs = resolve(PUBLIC_DIR, normalize(file))
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR)) return null
  return abs
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const abs = targetPath(pathname)
  let info
  try {
    if (abs === null) throw new Error('escape')
    info = await stat(abs)
    if (!info.isFile()) throw new Error('not file')
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
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
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MOUNT,
    handler: serveStatic,
  }), 'dsh-remote: /remote route')

  // 在 DSH 主页注入一个通往 /remote 的浮动入口
  ctx.effect(() => ctx.webServer.tapIndex((html) => {
    if (!html.includes('id="dsh-remote-entry"') && html.includes('</body>')) {
      return html.replace('</body>', `${ENTRY_BUTTON}</body>`)
    }
    return html
  }), 'dsh-remote: index entry')
}
