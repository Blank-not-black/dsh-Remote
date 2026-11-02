'use strict'
// Record actual TCP provenance, rather than trusting forwarded headers or Host.
const ports = new Set()
function track(socket) {
  const register = () => {
    const port = socket.localPort
    if (!port || socket.destroyed) return
    ports.add(port); socket.once('close', () => ports.delete(port))
  }
  if (socket.connecting) socket.once('connect', register); else register()
}
function contains(req) { return ports.has(req.socket.remotePort) }
module.exports = { track, contains }
