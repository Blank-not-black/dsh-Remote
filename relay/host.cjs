'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { RelayClient, enroll } = require('./client.cjs')
const { fault } = require('./registry.cjs')
const DEFAULT_ORIGIN = 'https://relay-pilot.blankalwaysgoeson.site'

// Runs inside the gateway process: no launcher, scheduled task or runtime install.
class RelayHost {
  constructor({ root, gateway, origin = DEFAULT_ORIGIN, ca }) {
    this.root = root; this.gateway = gateway; this.origin = origin; this.ca = ca
    this.file = path.join(root, 'connection.json'); this.keyFile = path.join(root, 'host-private.pem')
    this.legacyRoot = path.join(path.dirname(root), 'owner-preview')
    this.client = null; this.phase = 'disabled'; this.daily = null; this.updatedAt = null; this.busy = false
    this.config = null; this.error = ''
    if (fs.existsSync(this.file)) {
      try { this.config = JSON.parse(fs.readFileSync(this.file, 'utf8')) }
      catch { this.phase = 'error'; this.error = 'LOCAL_STATE_INVALID' }
    }
  }
  save(config) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temp = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
    try { fs.writeFileSync(temp, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, this.file) }
    finally { try { fs.unlinkSync(temp) } catch {} }
    this.config = config
  }
  status() {
    const config = this.config
    let phase = this.phase
    if (config && Date.now() >= config.expiresAt) phase = 'expired'
    else if (config?.enabled && this.daily?.exhausted) phase = 'quota-exceeded'
    else if (config?.enabled && this.daily?.unavailable) phase = 'quota-unavailable'
    return { supported: true, enabled: !!config?.enabled, configured: !!config, phase,
      publicUrl: config?.publicUrl || '', expiresAt: config?.expiresAt || null,
      fingerprint: config?.fingerprint || '', daily: this.daily, usageUpdatedAt: this.updatedAt,
      quotaPending: !!config?.enabled && !this.daily, error: this.error,
      server: this.origin, busy: this.busy, legacyAvailable: !config && !!this.legacy() }
  }
  legacy() {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(this.legacyRoot,'connection.json'),'utf8'))
      if (config.tunnelOrigin !== this.origin || config.expiresAt <= Date.now() || !fs.existsSync(path.join(this.legacyRoot,'host-private.pem'))) return null
      return config
    } catch { return null }
  }
  startSaved() {
    if (this.config?.enabled) {
      try { this.start() } catch { this.phase = 'error'; this.error = 'LOCAL_STATE_INVALID' }
    }
  }
  start() {
    this.stop()
    if (!this.config || !fs.existsSync(this.keyFile)) throw fault('HOST_NOT_CONFIGURED', 409)
    if (this.config.expiresAt <= Date.now()) { this.phase = 'expired'; return }
    // Only the operator-configured service is allowed, never a target supplied by a browser.
    if (this.config.tunnelOrigin !== this.origin) throw fault('RELAY_SERVER_MISMATCH', 409)
    const client = new RelayClient({ ...this.config, gateway: this.gateway, privateKey: fs.readFileSync(this.keyFile), ca: this.ca })
    this.client = client; this.phase = 'connecting'; this.error = ''
    client.on('status', status => { if (this.client === client) this.phase = status })
    client.on('usage', daily => {
      if (this.client !== client) return
      this.daily = daily; this.updatedAt = Date.now()
    })
    client.start()
  }
  stop() { const client = this.client; this.client = null; client?.stop(); this.phase = 'disabled' }
  async change(action, key) {
    if (this.busy) throw fault('RELAY_OPERATION_BUSY', 409)
    this.busy = true
    try {
      if (action === 'import') {
        if (this.config) throw fault('HOST_ALREADY_CONFIGURED',409)
        const config=this.legacy()
        if (!config) throw fault('LEGACY_RELAY_UNAVAILABLE',409)
        const privateKey=fs.readFileSync(path.join(this.legacyRoot,'host-private.pem'))
        new RelayClient({...config,gateway:this.gateway,privateKey,ca:this.ca})
        const publicKey=crypto.createPublicKey(crypto.createPrivateKey(privateKey)).export({format:'pem',type:'spki'}).toString()
        fs.mkdirSync(this.root,{recursive:true,mode:0o700})
        if (fs.existsSync(this.keyFile)) fs.copyFileSync(this.keyFile,this.keyFile+'.before-import-'+crypto.randomBytes(8).toString('hex'),fs.constants.COPYFILE_EXCL)
        const temp=this.keyFile+'.'+crypto.randomBytes(8).toString('hex')+'.tmp'
        try { fs.writeFileSync(temp,privateKey,{flag:'wx',mode:0o600});fs.renameSync(temp,this.keyFile) }
        finally { try { fs.unlinkSync(temp) } catch {} }
        this.save({...config,fingerprint:crypto.createHash('sha256').update(publicKey).digest('hex'),enabled:true})
        // The old launcher observes this file and exits normally. Never kill a PID
        // supplied by a browser or terminate the user's DSH/gateway processes.
        fs.writeFileSync(path.join(this.legacyRoot,'stop.request'),'stop\n',{mode:0o600})
        await new Promise(resolve=>setTimeout(resolve,700))
        this.start()
      } else if (action === 'enroll') {
        if (!/^dsrp_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/.test(String(key || '').trim())) throw fault('INVALID_AUTHORIZATION', 400)
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
        if (!fs.existsSync(this.keyFile)) {
          const pair = crypto.generateKeyPairSync('ed25519')
          fs.writeFileSync(this.keyFile, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
        }
        const privateKey = crypto.createPrivateKey(fs.readFileSync(this.keyFile))
        const publicKey = crypto.createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString()
        const config = await enroll(this.origin, key.trim(), publicKey, this.ca)
        // Construct before replacing a working configuration; a malformed response cannot disable it.
        new RelayClient({ ...config, gateway: this.gateway, privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), ca: this.ca })
        if (config.tunnelOrigin !== this.origin || new URL(config.publicUrl).protocol !== 'https:') throw fault('INVALID_SERVER_RESPONSE', 502)
        this.save({ ...config, fingerprint: crypto.createHash('sha256').update(publicKey).digest('hex'), enabled: true })
        this.daily = null; this.updatedAt = null; this.start()
      } else if (action === 'enable') {
        if (!this.config) throw fault('HOST_NOT_CONFIGURED', 409)
        this.save({ ...this.config, enabled: true }); this.start()
      } else if (action === 'disable') {
        if (this.config) this.save({ ...this.config, enabled: false })
        // Allow the setting response to cross the tunnel before closing it.
        const client = this.client; this.client = null; this.phase = 'disabled'
        const timer = setTimeout(() => client?.stop(), 250); timer.unref?.()
      } else throw fault('INVALID_RELAY_ACTION', 400)
      return this.status()
    } finally { this.busy = false }
  }
}
module.exports = { RelayHost, DEFAULT_ORIGIN }
