'use strict'

// Isolated native-client experiment. Not loaded by the gateway, broker or WebUI.
// TLS implements key agreement, AEAD records and sequence numbers (RFC 8446).
const tls = require('node:tls')
const { Duplex } = require('node:stream')
const { X509Certificate, createHash, timingSafeEqual } = require('node:crypto')

const PROTOCOL = 'dsh-remote-native-tls13-prototype-v1'
const fingerprint = raw => createHash('sha256').update(raw).digest('hex')
const fault = code => Object.assign(new Error(code), { code })

// Call ONLY with a certificate obtained directly from the owner's host through
// a trusted local pairing step. Fetching it from the relay defeats pinning.
function createPairing(certificate, hostname) {
  if (typeof certificate !== 'string' || certificate.length > 8192
      || (certificate.match(/-----BEGIN CERTIFICATE-----/g) || []).length !== 1
      || typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname)) {
    throw fault('INVALID_E2EE_PAIRING')
  }
  let cert
  try { cert = new X509Certificate(certificate) } catch { throw fault('INVALID_E2EE_CERTIFICATE') }
  if (tls.checkServerIdentity(hostname, cert.toLegacyObject())) throw fault('E2EE_HOSTNAME_MISMATCH')
  return Object.freeze({ protocol: PROTOCOL, hostname, certificate: cert.toString(), fingerprint: fingerprint(cert.raw) })
}

function validatePairing(value) {
  if (!value || value.protocol !== PROTOCOL || typeof value.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw fault('INVALID_E2EE_PAIRING')
  // Snapshot inputs before opening a connection. No trust-on-first-use or pin refresh.
  const pair = createPairing(value.certificate, value.hostname)
  if (!timingSafeEqual(Buffer.from(pair.fingerprint, 'hex'), Buffer.from(value.fingerprint, 'hex'))) {
    throw fault('E2EE_PIN_MISMATCH')
  }
  return pair
}

// The supplied Duplex carries ONLY inner TLS records. For example, it may be an
// already authenticated outer HTTPS Upgrade tunnel; no token is sent outside it.
// Resolve only after CA, name, version and exact certificate checks succeed.
function connectPinned({ socket, pairing, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    let pair
    try {
      pair = validatePairing(pairing)
      if (!(socket instanceof Duplex)
          || socket.destroyed || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
        throw fault('INVALID_E2EE_TRANSPORT')
      }
    } catch (error) { socket?.destroy?.(); reject(error); return }

    let channel, settled = false
    const fail = error => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error) }
      channel?.destroy()
      socket.destroy()
    }
    const closed = () => { if (!settled) fail(fault('E2EE_CHANNEL_CLOSED')); else channel?.destroy() }
    const transportError = error => { if (!settled) fail(error); else channel?.destroy(error) }
    const timer = setTimeout(() => fail(fault('E2EE_HANDSHAKE_TIMEOUT')), timeoutMs)
    socket.on('error', transportError)
    socket.once('close', closed)
    try {
      channel = tls.connect({
        socket, servername: pair.hostname, ca: pair.certificate,
        rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
        ALPNProtocols: ['http/1.1'],
        // Never supply a cached session or early data. Each connect reauthenticates.
        checkServerIdentity(host, cert) {
          const error = tls.checkServerIdentity(host, cert)
          if (error) return error
          if (!cert.raw || fingerprint(cert.raw) !== pair.fingerprint) return fault('E2EE_PIN_MISMATCH')
        },
      })
      channel.on('error', error => { if (!settled) fail(error) })
      channel.once('close', () => {
        if (!settled) fail(fault('E2EE_CHANNEL_CLOSED'))
        clearTimeout(timer)
        socket.off('error', transportError)
        socket.off('close', closed)
        socket.destroy()
      })
      channel.once('secureConnect', () => {
        if (settled) return
        const cert = channel.getPeerCertificate()
        if (!channel.authorized || channel.getProtocol() !== 'TLSv1.3' || channel.isSessionReused()
            || !cert.raw || fingerprint(cert.raw) !== pair.fingerprint) return fail(fault('E2EE_PEER_REJECTED'))
        clearTimeout(timer); settled = true; resolve(channel)
      })
    } catch (error) { fail(error) }
  })
}

module.exports = { createPairing, connectPinned }
