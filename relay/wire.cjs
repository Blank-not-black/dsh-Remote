'use strict'
const { fault } = require('./registry.cjs')

// One bounded JSON line for each state transition, then unmodified TCP bytes.
// Pausing and unshifting the tail preserves coalesced handshake + HTTP packets.
function line(socket, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => finish(fault('HANDSHAKE_TIMEOUT', 408)), timeout)
    const clean = () => { clearTimeout(timer); socket.off('data', data); socket.off('error', error); socket.off('close', closed) }
    const finish = (err, result) => { clean(); err ? reject(err) : resolve(result) }
    const error = () => finish(fault('CHANNEL_ERROR', 503))
    const closed = () => finish(fault('CHANNEL_CLOSED', 503))
    const data = chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf(10)
      if (end < 0 && buffered.length <= 8192) return
      if (end < 0 || end > 8192) return finish(fault('HANDSHAKE_TOO_LARGE', 413))
      socket.pause()
      const tail = buffered.subarray(end + 1)
      if (tail.length) socket.unshift(tail)
      try { finish(null, JSON.parse(buffered.subarray(0, end).toString('utf8'))) } catch { finish(fault('INVALID_HANDSHAKE')) }
    }
    socket.on('data', data); socket.once('error', error); socket.once('close', closed)
    socket.resume()
  })
}
function send(socket, value) { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n') }
function link(left, right) {
  left.on('error', () => right.destroy()); right.on('error', () => left.destroy())
  left.once('close', () => right.destroy()); right.once('close', () => left.destroy())
  left.pipe(right); right.pipe(left)
  left.resume(); right.resume()
}
module.exports = { line, send, link }
