'use strict'
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
function headersOf(input, upgrade = false) {
  const denied = new Set([...HOP, ...String(input.connection || '').toLowerCase().split(',').map(s => s.trim())])
  const out = {}
  for (const [key, value] of Object.entries(input)) if (!denied.has(key.toLowerCase()) && value !== undefined) out[key] = value
  if (upgrade) { out.connection = 'Upgrade'; out.upgrade = 'websocket' }
  else out.connection = 'close'
  return out
}
module.exports = { headersOf }
