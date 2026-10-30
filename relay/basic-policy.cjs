'use strict'
const { fault } = require('./registry.cjs')
const IMAGE = /^image\/(?:png|jpeg|gif|webp)$/
const IMAGE_MAX = 12 * 1024 * 1024
function basicPolicy(req) {
  const url = new URL(req.url, 'http://relay.invalid')
  let route
  try { route = decodeURIComponent(url.pathname).replace(/\/+$/, '') } catch { throw fault('INVALID_PATH') }
  if (/[\\%]/.test(route)) throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
  if (route === '/fs/file' && ['GET', 'HEAD'].includes(req.method)
      && url.searchParams.getAll('path').length === 1 && /\.(?:png|jpe?g|gif|webp)$/i.test(url.searchParams.get('path')) && !req.headers.range) return 'image'
  if (route === '/fs' || route.startsWith('/fs/') || /^\/(?:remote\/)?(?:admin\/)?api\/(?:session-file|file-inbox)(?:\/|$)/.test(route)
      || /^\/api\/(?:session[./]export|attachments?(?:[./]|$)|files?(?:[./]|$))/.test(route)) throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
  if (route === '/api/session.attachment') return 'attachment'
  return null
}
async function imageResponse(response, res, mode) {
  const deny = () => {
    response.destroy()
    if (res.headersSent) return res.destroy()
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'FILE_TRANSFER_NOT_ALLOWED', message: '基础中转不支持文件传输，仅允许对话图片预览。' }))
  }
  // Buffer only bounded image responses. No arbitrary file bytes reach the browser first.
  try {
    const parts = []; let size = 0
    const max = mode === 'attachment' ? Math.ceil(IMAGE_MAX / 3) * 4 + 16384 : IMAGE_MAX
    if (Number(response.headers['content-length']) > max || response.headers['content-encoding']) return deny()
    if (response.statusCode === 304) { res.writeHead(304, { 'cache-control': 'no-cache' }); res.end(); return }
    if (mode === 'image' && !IMAGE.test(String(response.headers['content-type'] || '').split(';')[0])) return deny()
    for await (const chunk of response) { size += chunk.length; if (size > max) return deny(); parts.push(chunk) }
    const data = Buffer.concat(parts)
    if (mode === 'attachment') {
      const envelope = JSON.parse(data.toString('utf8')), value = envelope?.result?.value
      if (envelope?.result?.ok !== true || !IMAGE.test(value?.attachment?.mediaType || '') || typeof value?.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return deny()
      if (!imageMagic(Buffer.from(value.data, 'base64'), value.attachment.mediaType)) return deny()
    } else if (!imageMagic(data, String(response.headers['content-type']).split(';')[0]) && data.length) return deny()
    res.writeHead(response.statusCode, { 'content-type': mode === 'attachment' ? 'application/json' : response.headers['content-type'], 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', ...(response.headers.etag ? { etag: response.headers.etag } : {}) })
    res.end(data)
  } catch { deny() }
}
function imageMagic(bytes, type) {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (type === 'image/gif') return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
  return type === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
}
async function basicBody(req) {
  const url = new URL(req.url, 'http://relay.invalid')
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return null
  const parts = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw fault('BODY_TOO_LARGE', 413); parts.push(chunk) }
  const raw = Buffer.concat(parts)
  let value
  try { value = JSON.parse(raw.toString('utf8')) } catch { throw fault('INVALID_JSON') }
  if (value?.type === 'client-request' && value.method !== decodeURIComponent(url.pathname.slice(5))) throw fault('RPC_ROUTE_MISMATCH', 403)
  // The operations endpoint must not be used to tunnel a file/attachment request.
  if (url.pathname === '/api/operations' && /^(?:session[./](?:attachment|export)|files?[./])/.test(String(value?.method))) throw fault('FILE_TRANSFER_NOT_ALLOWED', 403)
  return raw
}
module.exports = { basicPolicy, imageResponse, basicBody }
