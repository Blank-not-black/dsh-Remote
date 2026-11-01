'use strict'
const https = require('node:https')
const { connectPinned, validatePairing } = require('./e2ee-channel.cjs')
const { fault } = require('./registry.cjs')

// Native/Node reference client; pairing is imported via a trusted local channel.
// Caller supplies application credentials only after this Promise resolves.
function connectRelay(pairing, { ca, timeoutMs = 10000, lookup } = {}) {
  return new Promise((resolve, reject) => {
    let url, pinned, routeToken
    try {
      pinned = validatePairing(pairing); routeToken = pairing.routeToken
      url = new URL(pairing.relayUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/relay/v1/e2ee' || url.search || url.hash
          || !/^[A-Za-z0-9_-]{43}$/.test(pairing.routeToken || '') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fault('INVALID_E2EE_PAIRING')
    } catch (error) { reject(error); return }
    const request = https.request(url, { ca, lookup, agent: false, headers: {
      connection: 'Upgrade', upgrade: 'dsh-e2ee-v1', authorization: 'DSHRelay ' + routeToken,
    } })
    let finished = false
    const timer = setTimeout(() => request.destroy(fault('E2EE_RELAY_TIMEOUT', 408)), timeoutMs)
    request.once('error', error => { clearTimeout(timer); if (!finished) { finished = true; reject(error) } })
    request.once('response', response => {
      clearTimeout(timer); response.destroy(); request.destroy()
      if (!finished) { finished = true; reject(fault('E2EE_RELAY_REJECTED', response.statusCode)) }
    })
    request.once('upgrade', (response, socket, head) => {
      clearTimeout(timer)
      if (finished || String(response.headers.upgrade).toLowerCase() !== 'dsh-e2ee-v1') {
        socket.destroy(); if (!finished) { finished = true; reject(fault('INVALID_E2EE_UPGRADE')) }; return
      }
      finished = true; socket.pause(); if (head.length) socket.unshift(head)
      connectPinned({ socket, pairing: pinned, timeoutMs }).then(resolve, reject)
    })
    request.end()
  })
}
module.exports = { connectRelay }
