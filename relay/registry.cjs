'use strict'
// Operator-owned relay state. This is separate from every user's Remote profile.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')

function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }) }
function hostname(value) {
  const name = String(value || '').toLowerCase()
  if (name.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(name)) throw fault('INVALID_HOST')
  return name
}
function publicKey(value) {
  if (typeof value !== 'string' || value.length > 1024) throw fault('INVALID_PUBLIC_KEY')
  let key
  try { key = crypto.createPublicKey(value) } catch { throw fault('INVALID_PUBLIC_KEY') }
  if (key.asymmetricKeyType !== 'ed25519') throw fault('INVALID_PUBLIC_KEY')
  return key.export({ format: 'pem', type: 'spki' }).toString()
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const live = (grant, now = Date.now()) => grant && !grant.revokedAt && grant.expiresAt > now
const signingText = (nonce, id, role, session = '') => Buffer.from(JSON.stringify(['dsh-relay-v1', nonce, id, role, session]))

class Registry {
  constructor(file) { this.file = path.resolve(file) }
  read() {
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (state.version !== 1 || !Array.isArray(state.grants)) throw fault('INVALID_REGISTRY', 503)
    return state
  }
  change(fn) {
    const lock = this.file + '.lock'
    let fd
    try { fd = fs.openSync(lock, 'wx', 0o600) } catch { throw fault('REGISTRY_BUSY', 503) }
    try {
      const state = this.read()
      const result = fn(state)
      const temp = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
      try {
        fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        fs.renameSync(temp, this.file)
      } finally { try { fs.unlinkSync(temp) } catch {} }
      return result
    } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
  }
  static init(file, config) {
    const origin = new URL(config.origin)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw fault('HTTPS_ORIGIN_REQUIRED')
    const baseDomain = hostname(config.baseDomain)
    const tunnelValue = config.tunnelHost || origin.hostname
    const tunnelHost = net.isIP(tunnelValue) ? tunnelValue : hostname(tunnelValue)
    const tunnelPort = Number(config.tunnelPort || origin.port || 443)
    if (!Number.isInteger(tunnelPort) || tunnelPort < 1 || tunnelPort > 65535) throw fault('INVALID_PORT')
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, JSON.stringify({ version: 1, origin: origin.origin, baseDomain, tunnelHost, tunnelPort, maxUsers: 5, grants: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return new Registry(file)
  }
  issue({ label = '', domain, expiresAt }) {
    const expires = Number(expiresAt)
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 90 * 86400000) throw fault('INVALID_EXPIRY')
    return this.change(state => {
      if (state.grants.filter(g => live(g)).length >= state.maxUsers) throw fault('PILOT_FULL', 409)
      const id = crypto.randomBytes(8).toString('hex')
      const assigned = hostname(domain || `r-${id}.${state.baseDomain}`)
      if (!assigned.endsWith('.' + state.baseDomain) || assigned === new URL(state.origin).hostname || assigned === state.tunnelHost) throw fault('INVALID_TENANT_DOMAIN')
      if (state.grants.some(g => g.domain === assigned)) throw fault('DOMAIN_ALREADY_ASSIGNED', 409)
      const code = `dsrp_${id}.${crypto.randomBytes(32).toString('base64url')}`
      const grant = { id, label: String(label).slice(0, 80), domain: assigned, expiresAt: expires, createdAt: Date.now(), codeHash: digest(code), publicKey: null, revokedAt: null }
      state.grants.push(grant)
      return { code, grant: this.view(grant) }
    })
  }
  view(g) { return { id: g.id, label: g.label, domain: g.domain, expiresAt: g.expiresAt, state: g.revokedAt ? 'revoked' : !live(g) ? 'expired' : g.publicKey ? 'bound' : 'invited', fingerprint: g.publicKey ? digest(g.publicKey) : null } }
  list() { return this.read().grants.map(g => this.view(g)) }
  revoke(id) {
    return this.change(state => {
      const grant = state.grants.find(g => g.id === id)
      if (!grant) throw fault('NOT_FOUND', 404)
      grant.revokedAt ||= Date.now()
      return this.view(grant)
    })
  }
  enroll(code, key) {
    const match = /^dsrp_([a-f0-9]{16})\.[A-Za-z0-9_-]{43}$/.exec(String(code || ''))
    if (!match) throw fault('INVALID_AUTHORIZATION', 403)
    const normalized = publicKey(key)
    return this.change(state => {
      const grant = state.grants.find(g => g.id === match[1])
      if (!live(grant) || !crypto.timingSafeEqual(Buffer.from(grant.codeHash, 'hex'), Buffer.from(digest(code), 'hex'))) throw fault('INVALID_AUTHORIZATION', 403)
      if (grant.publicKey && grant.publicKey !== normalized) throw fault('HOST_ALREADY_BOUND', 409)
      grant.publicKey = normalized
      return { grantId: grant.id, domain: grant.domain, expiresAt: grant.expiresAt, publicUrl: `https://${grant.domain}`, dailyLimitBytes: 5_000_000_000, timezone: 'Asia/Shanghai', transport: 'https-upgrade', tunnelOrigin: state.origin, tunnelHost: state.tunnelHost, tunnelPort: state.tunnelPort }
    })
  }
  get(id) { return this.read().grants.find(g => g.id === id) }
}

module.exports = { Registry, fault, hostname, publicKey, digest, live, signingText }
