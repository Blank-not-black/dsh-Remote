'use strict'

// Embedded into gateway.js by scripts/embed-lan.mjs. Only Node built-ins.
function createLanPairing(options) {
  const crypto = require('node:crypto'), dgram = require('node:dgram')
  const clock = options.clock || Date.now
  const instanceId = crypto.randomBytes(16).toString('hex')
  let secret = null, expiresAt = 0, socket = null, timer = null, failures = 0, error = '', revision = 0
  const challenges = new Map(), peers = new Map()
  const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }) }
  const localPeer = address => {
    const ip = String(address || '').replace(/^::ffff:/, '')
    if (ip === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip)) return true
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false
    const bytes = ip.split('.').map(Number)
    if (bytes.length !== 4 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
    return bytes[0] === 10 || bytes[0] === 127 || bytes[0] === 192 && bytes[1] === 168
      || bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31 || bytes[0] === 169 && bytes[1] === 254
  }
  const active = () => !!secret && clock() < expiresAt && options.deviceMode()
  const status = () => ({ supported: true, enabled: active() && !!socket, expiresAt: active() ? expiresAt : 0,
    port: Number(options.discoveryPort || 8788), error })
  function close() {
    revision++
    secret = null; expiresAt = 0; challenges.clear(); peers.clear()
    clearTimeout(timer); timer = null
    if (socket) { try { socket.close() } catch {} socket = null }
  }
  async function open() {
    close(); error = ''
    const openingRevision = revision
    if (!options.deviceMode()) fail(409, 'DEVICE_KEYS_REQUIRED')
    if (options.host === '127.0.0.1' || options.host === '::1') fail(409, 'LAN_LISTENER_REQUIRED')
    const code = crypto.randomBytes(10).toString('hex').toUpperCase()
    secret = crypto.createHash('sha256').update(code).digest(); failures = 0
    expiresAt = clock() + 10 * 60 * 1000
    const candidate = dgram.createSocket('udp4')
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject)
        candidate.bind(Number(options.discoveryPort || 8788), options.discoveryHost || '0.0.0.0', () => {
          candidate.removeListener('error', reject); resolve()
        })
      })
    } catch {
      try { candidate.close() } catch {}
      if (revision === openingRevision) { close(); error = 'DISCOVERY_PORT_UNAVAILABLE' }
      fail(503, 'DISCOVERY_PORT_UNAVAILABLE')
    }
    if (revision !== openingRevision) { try { candidate.close() } catch {} fail(409, 'PAIRING_CLOSED') }
    socket = candidate
    socket.on('error', () => { close(); error = 'DISCOVERY_SOCKET_FAILED' })
    socket.on('message', (message, peer) => {
      if (!active() || !localPeer(peer.address) || message.length < 256 || message.length > 512) return
      let query
      try { query = JSON.parse(message.toString('utf8')) } catch { return }
      if (query?.type !== 'dsh-remote-discover' || query.version !== 1 || !/^[a-f0-9]{32}$/.test(query.nonce)) return
      const now = clock(), previous = peers.get(peer.address)
      if (previous && now - previous.at < 500) return
      if (peers.size >= 128 && !peers.has(peer.address)) return
      peers.set(peer.address, { at: now, count: previous?.count || 0 })
      const reply = Buffer.from(JSON.stringify({ type: 'dsh-remote-host', version: 1, nonce: query.nonce,
        instanceId, name: String(options.name || 'DSH Remote').slice(0, 40), port: options.port }))
      if (reply.length <= message.length) candidate.send(reply, peer.port, peer.address, () => {})
    })
    timer = setTimeout(close, 10 * 60 * 1000); timer.unref?.()
    socket.unref?.()
    return { ...status(), code: code.match(/.{4}/g).join('-') }
  }
  const proof = (role, transcript) => crypto.createHmac('sha256', secret).update(role + '\n' + transcript).digest('hex')
  function pair(address, input) {
    address = String(address || '').replace(/^::ffff:/, '')
    if (!localPeer(address)) fail(403, 'LAN_ONLY')
    if (!active()) { close(); fail(410, 'PAIRING_CLOSED') }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'BAD_REQUEST')
    const now = clock()
    for (const [id, challenge] of challenges) if (challenge.expires <= now) challenges.delete(id)
    if (input.step === 'hello') {
      const limit = peers.get(address) || { at: 0, count: 0 }
      if (limit.count >= 12 || challenges.size >= 32 || peers.size >= 128 && !peers.has(address)) fail(429, 'PAIRING_RATE_LIMIT')
      peers.set(address, { ...limit, count: limit.count + 1 })
      if (input.instanceId !== instanceId || !/^[a-f0-9]{32}$/.test(input.nonce || '')
          || typeof input.clientPublic !== 'string' || input.clientPublic.length > 200
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.clientPublic)
          || Buffer.from(input.clientPublic, 'base64').toString('base64') !== input.clientPublic) fail(400, 'BAD_REQUEST')
      let clientKey, shared
      const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      try {
        clientKey = crypto.createPublicKey({ key: Buffer.from(input.clientPublic, 'base64'), format: 'der', type: 'spki' })
        if (clientKey.asymmetricKeyType !== 'ec' || clientKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail(400, 'BAD_KEY')
        shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: clientKey })
      } catch { fail(400, 'BAD_KEY') }
      const serverPublic = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
      const challengeId = crypto.randomBytes(16).toString('hex')
      const transcript = ['dsh-lan-v1', instanceId, challengeId, input.nonce, input.clientPublic, serverPublic].join('\n')
      challenges.set(challengeId, { address, shared, transcript, expires: now + 30000 })
      return { challengeId, serverPublic, serverProof: proof('server', transcript) }
    }
    if (input.step !== 'finish') fail(400, 'BAD_REQUEST')
    const challenge = challenges.get(input.challengeId)
    challenges.delete(input.challengeId) // A challenge can be used only once, including failed attempts.
    if (!challenge || challenge.address !== address || challenge.expires <= now) fail(410, 'CHALLENGE_EXPIRED')
    const expected = proof('client', challenge.transcript), supplied = String(input.proof || '')
    if (!/^[a-f0-9]{64}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      failures++; if (failures >= 10) close()
      fail(401, 'PAIRING_CODE_INVALID')
    }
    const entry = options.issueDevice()
    if (!entry) fail(503, 'DEVICE_KEY_WRITE_FAILED')
    const key = crypto.createHmac('sha256', secret).update('key\n' + challenge.transcript + '\n').update(challenge.shared).digest()
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(challenge.transcript))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ token: entry.token, deviceId: entry.id })), cipher.final()])
    const result = { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
    close() // Successful pairing closes discovery and the one-time code.
    return result
  }
  return { open, close, status, pair, localPeer }
}

module.exports = { createLanPairing }
