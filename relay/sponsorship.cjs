'use strict'
// Cloud-only application/review service. No payment account access or automatic emails.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Registry, fault, digest, live, issueInState } = require('./registry.cjs')

const MAX_USERS = 79
const MONTHLY_BYTES = 5_000_000_000
const SCREENSHOT_MAX = 2 * 1024 * 1024
const DRAFT_MS = 30 * 60000
function nextMonth(now) {
  const offset = 8 * 3600000
  const date = new Date(now + offset), day = date.getUTCDate()
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1)
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, last))
  return date.getTime() - offset
}
function screenshot(value) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value || ''))
  if (!match || match[2].length > Math.ceil(SCREENSHOT_MAX / 3) * 4) throw fault('INVALID_SCREENSHOT')
  const bytes = Buffer.from(match[2], 'base64')
  const good = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  if (!good || bytes.length < 12 || bytes.length > SCREENSHOT_MAX || bytes.toString('base64') !== match[2]) throw fault('INVALID_SCREENSHOT')
  return { bytes, type: 'image/' + match[1] }
}
function amountCents(value) {
  const text = String(value ?? '')
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(text)) throw fault('INVALID_AMOUNT')
  const [whole, fraction = ''] = text.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (cents < 100) throw fault('MINIMUM_ONE_YUAN')
  return cents
}
function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(value)) throw fault('INVALID_EMAIL')
  return value.toLowerCase()
}
const reserved = (a, now) => a.status === 'submitted' || a.status === 'draft' && a.reservedUntil > now

class Sponsorship {
  constructor({ file, adminToken, maxUsers = MAX_USERS, now = Date.now }) {
    if (typeof adminToken !== 'string' || adminToken.length < 32) throw fault('SPONSOR_ADMIN_TOKEN_REQUIRED')
    if (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > MAX_USERS) throw fault('INVALID_SPONSOR_CAPACITY')
    this.registry = new Registry(file); this.now = now
    this.key = crypto.createHash('sha256').update('dsh-sponsor-delivery-v1\0' + adminToken).digest()
    this.proofDir = path.join(path.dirname(path.resolve(file)), 'sponsor-proofs')
    fs.mkdirSync(this.proofDir, { recursive: true, mode: 0o700 })
    this.registry.change(state => {
      state.sponsorship ||= { version: 1, maxUsers, applications: [] }
      if (state.sponsorship.version !== 1 || !Array.isArray(state.sponsorship.applications)) throw fault('INVALID_SPONSOR_STATE', 503)
      state.sponsorship.maxUsers = maxUsers
      state.maxUsers = maxUsers
    })
  }
  change(fn) {
    return this.registry.change(state => {
      const service = state.sponsorship
      for (const a of service.applications) if (a.status === 'draft' && a.reservedUntil <= this.now()) a.status = 'expired'
      return fn(state, service)
    })
  }
  capacity(state = this.registry.read()) {
    const used = state.grants.filter(g => live(g, this.now())).length + state.sponsorship.applications.filter(a => reserved(a, this.now())).length
    return { maxUsers: state.sponsorship.maxUsers, remaining: Math.max(0, state.sponsorship.maxUsers - used) }
  }
  settings() { return { accepting: this.registry.read().sponsorship.accepting !== false } }
  configure(input) {
    if (typeof input.accepting !== 'boolean') throw fault('INVALID_SPONSOR_SETTINGS')
    return this.change((state, service) => { service.accepting = input.accepting; return { accepting: service.accepting } })
  }
  draft() {
    return this.change((state, service) => {
      if (service.accepting === false) throw fault('APPLICATIONS_PAUSED', 409)
      if (!this.capacity(state).remaining) throw fault('PILOT_FULL', 409)
      // Bound retained drafts, including expired attempts. Paid applications are never silently removed.
      service.applications = service.applications.filter(a => a.status !== 'expired' || a.createdAt > this.now() - 86400000)
      if (service.applications.length >= 10000) throw fault('APPLICATION_STORAGE_FULL', 503)
      const id = 'R' + crypto.randomBytes(8).toString('hex').toUpperCase()
      const token = crypto.randomBytes(32).toString('base64url')
      const row = { id, tokenHash: digest(token), status: 'draft', createdAt: this.now(), reservedUntil: this.now() + DRAFT_MS }
      service.applications.push(row)
      return { id, token, reservedUntil: row.reservedUntil }
    })
  }
  find(state, id) {
    if (!/^R[A-F0-9]{16}$/.test(String(id))) throw fault('NOT_FOUND', 404)
    const row = state.sponsorship.applications.find(a => a.id === id)
    if (!row) throw fault('NOT_FOUND', 404)
    return row
  }
  authorize(row, token) {
    if (!token || !crypto.timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(digest(token), 'hex'))) throw fault('APPLICATION_UNAUTHORIZED', 403)
  }
  status(id, token) {
    const state = this.registry.read(), row = this.find(state, id); this.authorize(row, token)
    return { id: row.id, status: this.phase(state, row), reservedUntil: row.reservedUntil, submittedAt: row.submittedAt, approvedAt: row.approvedAt, expiresAt: row.expiresAt, deliveredAt: row.deliveredAt, note: row.note || '' }
  }
  phase(state, row) {
    if (row.status === 'approved') {
      const grant = state.grants.find(g => g.id === row.grantId)
      if (!grant || grant.revokedAt) return 'revoked'
      if (row.expiresAt <= this.now()) return 'expired'
    }
    return row.status === 'draft' && row.reservedUntil <= this.now() ? 'expired' : row.status
  }
  submit(id, token, input) {
    const cents = amountCents(input.amount), email = emailAddress(input.email), proof = screenshot(input.screenshot)
    return this.change((state, service) => {
      const row = this.find(state, id); this.authorize(row, token)
      if (row.status === 'submitted' && row.email === email && row.amountCents === cents && row.proofHash === digest(proof.bytes)) return this.status(id, token)
      if (row.status !== 'draft') throw fault('APPLICATION_NOT_EDITABLE', 409)
      if (row.reservedUntil <= this.now()) throw fault('APPLICATION_EXPIRED', 409)
      if (service.applications.some(a => a.id !== id && a.email === email && (a.status === 'submitted' || a.status === 'approved' && live(state.grants.find(g => g.id === a.grantId), this.now())))) throw fault('EMAIL_ALREADY_ACTIVE', 409)
      const target = path.join(this.proofDir, id)
      // A failed registry write may leave a proof; the same draft can safely retry it.
      const temp = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
      try {
        const fd = fs.openSync(temp, 'wx', 0o600)
        try { fs.writeFileSync(fd, proof.bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(temp, target)
      } finally { try { fs.unlinkSync(temp) } catch {} }
      Object.assign(row, { status: 'submitted', submittedAt: this.now(), email, amountCents: cents, proofType: proof.type, proofHash: digest(proof.bytes) })
      return { id, status: row.status, submittedAt: row.submittedAt }
    })
  }
  seal(code) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
  }
  unseal(value) {
    try {
      const bytes = Buffer.from(value, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
    } catch { throw fault('DELIVERY_KEY_UNAVAILABLE', 503) }
  }
  approve(id, { verified, receipt }) {
    if (verified !== true || typeof receipt !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(receipt)) throw fault('VERIFIED_RECEIPT_REQUIRED')
    const receiptHash = digest('wechat\0' + receipt)
    return this.change((state, service) => {
      const row = this.find(state, id)
      if (row.status === 'approved' && row.receiptHash === receiptHash) return { id, status: this.phase(state, row), grantId: row.grantId, expiresAt: row.expiresAt }
      if (row.status !== 'submitted') throw fault('APPLICATION_NOT_REVIEWABLE', 409)
      if (service.applications.some(a => a.id !== id && a.receiptHash === receiptHash)) throw fault('RECEIPT_ALREADY_USED', 409)
      if (state.grants.filter(g => live(g, this.now())).length >= service.maxUsers) throw fault('PILOT_FULL', 409)
      const previous = service.applications.filter(a => a.email === row.email && a.status === 'approved').sort((a, b) => b.approvedAt - a.approvedAt)[0]
      let grant = previous && state.grants.find(g => g.id === previous.grantId && !g.revokedAt)
      if (live(grant, this.now())) throw fault('EMAIL_ALREADY_ACTIVE', 409)
      const startsAt = this.now(), expiresAt = nextMonth(startsAt)
      let code
      if (grant) {
        code = `dsrp_${grant.id}.${crypto.randomBytes(32).toString('base64url')}`
        Object.assign(grant, { codeHash: digest(code), expiresAt })
      } else ({ code, grant } = issueInState(state, { label: id, expiresAt, plan: 'sponsor-basic' }))
      Object.assign(grant, { plan: 'sponsor-basic', periodStartsAt: startsAt })
      Object.assign(row, { status: 'approved', approvedAt: startsAt, expiresAt, grantId: grant.id, receiptHash, sealedCode: this.seal(code) })
      return { id, status: row.status, grantId: grant.id, expiresAt }
    })
  }
  reject(id, note) {
    if (typeof note !== 'string' || !note.trim() || note.length > 300) throw fault('REVIEW_NOTE_REQUIRED')
    return this.change(state => {
      const row = this.find(state, id)
      if (row.status === 'rejected' && row.note === note.trim()) return { id, status: row.status }
      if (row.status !== 'submitted') throw fault('APPLICATION_NOT_REVIEWABLE', 409)
      Object.assign(row, { status: 'rejected', reviewedAt: this.now(), note: note.trim() })
      return { id, status: row.status }
    })
  }
  list() {
    const state = this.registry.read()
    return state.sponsorship.applications.filter(a => !['draft', 'expired'].includes(a.status)).map(a => {
      const { tokenHash, sealedCode, receiptHash, proofHash, ...row } = a
      const grant = state.grants.find(g => g.id === a.grantId)
      return { ...row, status: this.phase(state, a), bound: !!grant?.publicKey, publicUrl: grant ? `https://${grant.domain}` : '' }
    }).reverse()
  }
  revoke(id, note) {
    if (typeof note !== 'string' || !note.trim() || note.length > 300) throw fault('REVIEW_NOTE_REQUIRED')
    return this.change(state => {
      const row = this.find(state, id), grant = state.grants.find(g => g.id === row.grantId)
      // An old application must never revoke a later renewal of the same grant.
      if (row.status !== 'approved' || !grant || grant.periodStartsAt !== row.approvedAt || grant.expiresAt !== row.expiresAt) throw fault('DELIVERY_INACTIVE', 409)
      grant.revokedAt ||= this.now()
      row.note = note.trim()
      return { id, status: 'revoked', revokedAt: grant.revokedAt }
    })
  }
  proof(id) {
    const row = this.find(this.registry.read(), id)
    if (!row.proofType) throw fault('NOT_FOUND', 404)
    return { bytes: fs.readFileSync(path.join(this.proofDir, row.id)), type: row.proofType }
  }
  delivery(id) {
    const state = this.registry.read(), row = this.find(state, id)
    const grant = state.grants.find(g => g.id === row.grantId)
    if (row.status !== 'approved' || !live(grant, this.now()) || grant.codeHash !== digest(this.unseal(row.sealedCode))) throw fault('DELIVERY_INACTIVE', 409)
    const code = this.unseal(row.sealedCode)
    return { email: row.email, subject: 'DSH Remote 基础中转开通 · ' + id,
      text: `你的基础中转申请 ${id} 已通过人工审核。\n\n中转密钥：${code}\n有效期至：${new Date(row.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）\n\n在需要绑定的电脑上启动 DSH 和 Remote 网关，进入「更多 → 主机与连接 → 云服务器中转」，填写上述密钥并绑定开启；也可在插件管理页操作。首次激活仅绑定这一台网关，无法绑定其他网关。\n开启后复制生成的公网地址，在手机中使用该地址及你自己的 Remote 访问令牌连接。中转密钥不能替代 Remote 访问令牌。请勿公开密钥。\n\n本服务处于试运营：本服务月含 5GB（5,000,000,000 字节）上传与下载合计额度，对话图片预览计入额度，不包含文件上传下载。更高赞助金额不增加期限、流量或设备数，不提供多月预付。到期后如仍开放试运营，可重新申请一个月。\n` }
  }
  delivered(id) {
    return this.change(state => {
      const row = this.find(state, id)
      if (row.status !== 'approved') throw fault('APPLICATION_NOT_APPROVED', 409)
      const grant = state.grants.find(g => g.id === row.grantId)
      if (!live(grant, this.now()) || grant.codeHash !== digest(this.unseal(row.sealedCode))) throw fault('DELIVERY_INACTIVE', 409)
      row.deliveredAt ||= this.now()
      return { id, deliveredAt: row.deliveredAt }
    })
  }
}

function createSponsorPortal({ file, adminToken, maxUsers = MAX_USERS, qrFile = path.join(__dirname, '../public/donate.png'), now, accepting = true, contactEmail = '', readUsage }) {
  if (contactEmail) contactEmail = emailAddress(contactEmail)
  const store = new Sponsorship({ file, adminToken, maxUsers, now })
  const expected = Buffer.from(digest(adminToken), 'hex'), rates = new Map()
  let readers = 0
  const assets = new Map([['/sponsor/', ['index.html', 'text/html; charset=utf-8']], ['/sponsor/admin', ['admin.html', 'text/html; charset=utf-8']], ['/sponsor/portal.js', ['portal.js', 'text/javascript; charset=utf-8']], ['/sponsor/style.css', ['style.css', 'text/css; charset=utf-8']]])
  function send(res, status, value, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" })
    res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
  }
  async function json(req, max = 3 * 1024 * 1024) {
    if (readers >= 4) throw fault('TRY_LATER', 429)
    readers++
    try {
      const chunks = []; let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > max) throw fault('BODY_TOO_LARGE', 413)
        chunks.push(chunk)
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error()
        return value
      } catch { throw fault('INVALID_JSON') }
    } finally { readers-- }
  }
  function limit(req) {
    const at = Date.now(), ip = req.socket.remoteAddress
    for (const [key, rate] of rates) if (rate.until < at) rates.delete(key)
    if (!rates.has(ip)) { if (rates.size >= 1024) throw fault('TRY_LATER', 429); rates.set(ip, { until: at + 60000, count: 0 }) }
    if (++rates.get(ip).count > 20) throw fault('TRY_LATER', 429)
  }
  return { store, async handle(req, res) {
    const url = new URL(req.url, 'http://sponsor.invalid'), route = url.pathname
    if (!route.startsWith('/sponsor')) return false
    try {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
      if (route === '/sponsor' && req.method === 'GET') { res.writeHead(308, { location: '/sponsor/', 'cache-control': 'no-store' }); res.end(); return true }
      if (route.startsWith('/sponsor/api/admin')) {
        if (!crypto.timingSafeEqual(expected, Buffer.from(digest(token), 'hex'))) throw fault('UNAUTHORIZED', 401)
        if (route === '/sponsor/api/admin/config') {
          if (req.method === 'POST') store.configure(await json(req, 128))
          else if (req.method !== 'GET') throw fault('METHOD_NOT_ALLOWED', 405)
          send(res, 200, { ...store.settings(), emergencyPaused: !accepting }); return true
        }
        if (req.method === 'GET' && route === '/sponsor/api/admin/applications') {
          const applications = store.list().map(row => {
            if (row.status !== 'approved' || typeof readUsage !== 'function') return row
            try {
              const raw = readUsage(row.grantId), usage = { period: 'month', online: raw.online === true }
              for (const name of ['usedBytes', 'limitBytes', 'remainingBytes', 'resetsAt']) usage[name] = Number.isSafeInteger(raw[name]) && raw[name] >= 0 ? raw[name] : null
              return { ...row, usage }
            } catch { return { ...row, usage: { unavailable: true } } }
          })
          send(res, 200, { applications, capacity: store.capacity() }); return true
        }
        const match = /^\/sponsor\/api\/admin\/applications\/(R[A-F0-9]{16})\/(approve|reject|revoke|proof|delivery|delivered)$/.exec(route)
        if (!match) throw fault('NOT_FOUND', 404)
        const [, id, action] = match
        if (action === 'proof' && req.method === 'GET') { const proof = store.proof(id); send(res, 200, proof.bytes, proof.type); return true }
        if (action === 'delivery' && req.method === 'GET') { send(res, 200, store.delivery(id)); return true }
        if (req.method !== 'POST') throw fault('METHOD_NOT_ALLOWED', 405)
        const input = await json(req, 4096)
        send(res, 200, action === 'approve' ? store.approve(id, input) : action === 'reject' ? store.reject(id, input.note) : action === 'revoke' ? store.revoke(id, input.note) : action === 'delivered' ? store.delivered(id) : (() => { throw fault('METHOD_NOT_ALLOWED', 405) })())
      } else if (req.method === 'GET' && assets.has(route)) {
        const [name, type] = assets.get(route); send(res, 200, fs.readFileSync(path.join(__dirname, 'sponsor', name)), type)
      } else if (req.method === 'GET' && route === '/sponsor/qr') send(res, 200, fs.readFileSync(qrFile), 'image/png')
      else if (req.method === 'GET' && route === '/sponsor/api/config') {
        res.setHeader('access-control-allow-origin', '*') // Public capability only; no CORS for personal data/admin APIs.
        send(res, 200, { enabled: true, accepting: accepting && store.settings().accepting, ...store.capacity(), minimumYuan: 1, monthlyBytes: MONTHLY_BYTES, contactEmail })
      } else if (req.method === 'POST' && route === '/sponsor/api/applications') {
        if (!accepting) throw fault('APPLICATIONS_PAUSED', 409)
        limit(req); await json(req, 128); send(res, 201, store.draft())
      } else {
        const match = /^\/sponsor\/api\/applications\/(R[A-F0-9]{16})$/.exec(route)
        if (!match) throw fault('NOT_FOUND', 404)
        if (req.method === 'GET') send(res, 200, store.status(match[1], token))
        else if (req.method === 'POST') {
          limit(req)
          // Authenticate before reading the large screenshot body.
          store.status(match[1], token)
          send(res, 200, store.submit(match[1], token, await json(req)))
        } else throw fault('METHOD_NOT_ALLOWED', 405)
      }
    } catch (error) {
      const known = error.status && error.code
      send(res, known ? error.status : 503, { error: known ? error.code : 'SPONSOR_STORAGE_UNAVAILABLE' })
    }
    return true
  } }
}
module.exports = { Sponsorship, createSponsorPortal, nextMonth, screenshot, amountCents, MONTHLY_BYTES, MAX_USERS }
