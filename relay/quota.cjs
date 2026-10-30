'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Duplex } = require('node:stream')
const { fault } = require('./registry.cjs')
const DAILY_BYTES = 5_000_000_000
const OFFSET = 8 * 3600000
function dayAt(now) { return new Date(now + OFFSET).toISOString().slice(0, 10) }
function resetAt(now) { return (Math.floor((now + OFFSET) / 86400000) + 1) * 86400000 - OFFSET }

// Reserve before forwarding: a crash may charge at most one unused 64 KiB
// reservation per grant; it cannot restore previously forwarded quota.
class DailyQuota {
  constructor(file, { now = Date.now, limit = DAILY_BYTES, block = 65536 } = {}) {
    this.file = path.resolve(file); this.now = now; this.limit = limit; this.block = block
    this.used = new Map(); this.failed = false
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (this.state.version !== 1 || !this.state.accounts || Array.isArray(this.state.accounts)) throw fault('QUOTA_STORAGE_UNAVAILABLE', 503)
      for (const [id, row] of Object.entries(this.state.accounts)) {
        if (!/^[a-f0-9]{16}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !Number.isSafeInteger(row.reserved) || row.reserved < 0) throw fault('QUOTA_STORAGE_UNAVAILABLE', 503)
      }
    } else { this.state = { version: 1, accounts: {} }; this.save() }
  }
  save() {
    const temp = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    let fd
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fd = fs.openSync(temp, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify(this.state) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(temp, this.file)
      if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) } }
    } catch { this.failed = true; throw fault('QUOTA_STORAGE_UNAVAILABLE', 503) }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp) } catch {} }
  }
  account(id) {
    if (this.failed) throw fault('QUOTA_STORAGE_UNAVAILABLE', 503)
    const day = dayAt(this.now())
    let row = this.state.accounts[id]
    if (!row || row.day !== day) {
      row = this.state.accounts[id] = { day, reserved: 0 }
      this.used.set(id, 0)
    }
    if (!this.used.has(id)) this.used.set(id, row.reserved)
    return row
  }
  view(id) {
    const row = this.account(id), usedBytes = Math.min(this.limit, this.used.get(id))
    return { day: row.day, timezone: 'Asia/Shanghai', limitBytes: this.limit, usedBytes,
      remainingBytes: Math.max(0, this.limit - usedBytes), resetsAt: resetAt(this.now()), exhausted: usedBytes >= this.limit }
  }
  consume(id, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw fault('INVALID_BYTE_COUNT')
    const row = this.account(id), current = this.used.get(id)
    const next = Math.min(this.limit, current + bytes)
    if (next > row.reserved) {
      row.reserved = Math.min(this.limit, Math.ceil(next / this.block) * this.block)
      this.save()
    }
    this.used.set(id, next)
    return current + bytes <= this.limit
  }
  checkpoint() {
    if (this.failed) return
    for (const id of this.used.keys()) { const row = this.account(id); row.reserved = this.used.get(id) }
    this.save()
  }
}

// Sponsor periods follow the approved service month, never the server's next midnight.
// A new approval renews the same grant with a new periodStartsAt, keeping its host binding.
class MonthlyQuota extends DailyQuota {
  constructor(file, registry, options) {
    super(file, options); this.registry = registry
    for (const row of Object.values(this.state.accounts)) if (!Number.isSafeInteger(row.period) || row.period < 0) throw fault('QUOTA_STORAGE_UNAVAILABLE', 503)
  }
  account(id) {
    if (this.failed) throw fault('QUOTA_STORAGE_UNAVAILABLE', 503)
    const grant = this.registry.get(id)
    if (grant?.plan !== 'sponsor-basic' || !Number.isSafeInteger(grant.periodStartsAt) || !Number.isSafeInteger(grant.expiresAt)) throw fault('QUOTA_STORAGE_UNAVAILABLE', 503)
    let row = this.state.accounts[id]
    if (!row || row.period !== grant.periodStartsAt) {
      row = this.state.accounts[id] = { day: dayAt(grant.periodStartsAt), period: grant.periodStartsAt, reserved: 0 }
      this.used.set(id, 0)
    }
    if (!this.used.has(id)) this.used.set(id, row.reserved)
    return row
  }
  view(id) {
    const view = super.view(id), grant = this.registry.get(id)
    return { ...view, period: 'month', startsAt: grant.periodStartsAt, resetsAt: grant.expiresAt }
  }
}

// Socket facade meters HTTP headers/bodies and all WS frames on the cloud side.
// Handshake/control bytes and TLS overhead are excluded, never application data.
function meteredSocket(raw, charge, exhausted) {
  let stopping = false
  const stop = error => {
    if (stopping) return
    stopping = true; wrapped.destroy(error); exhausted(error)
  }
  const wrapped = new Duplex({
    read() { raw.resume() },
    write(chunk, encoding, done) {
      try {
        if (!charge(chunk.length, 'upstream')) { done(fault('DAILY_QUOTA_EXCEEDED', 429)); stop(fault('DAILY_QUOTA_EXCEEDED', 429)); return }
        raw.write(chunk, encoding, done)
      } catch (error) { done(error); stop(error) }
    },
    final(done) { if (raw.writableEnded || raw.destroyed) done(); else raw.end(done) },
    destroy(error, done) { raw.destroy(); done(error) },
  })
  wrapped.connecting = false
  for (const method of ['setNoDelay', 'setKeepAlive', 'ref', 'unref']) wrapped[method] = (...args) => { raw[method]?.(...args); return wrapped }
  wrapped.setTimeout = (ms, callback) => { raw.setTimeout(ms); if (callback) wrapped.once('timeout', callback); return wrapped }
  raw.on('timeout', () => wrapped.emit('timeout'))
  raw.on('data', chunk => {
    try {
      if (!charge(chunk.length, 'downstream')) return stop(fault('DAILY_QUOTA_EXCEEDED', 429))
      if (!wrapped.push(chunk)) raw.pause()
    } catch (error) { stop(error) }
  })
  raw.once('end', () => wrapped.push(null))
  raw.once('error', error => wrapped.destroy(error))
  // A complete upstream can close while a paced download still drains buffered
  // bytes. Preserve its readable tail; abort only an incomplete transport.
  raw.once('close', () => { if (!raw.readableEnded) wrapped.destroy() })
  wrapped.on('error', () => {})
  raw.pause()
  return wrapped
}
module.exports = { DailyQuota, MonthlyQuota, DAILY_BYTES, dayAt, resetAt, meteredSocket }
