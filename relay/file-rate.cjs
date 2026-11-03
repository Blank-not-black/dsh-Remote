'use strict'
const { Transform } = require('node:stream')
class FileRate extends Transform {
  constructor(rate) {
    super(); this.rate = rate; this.nextAt = 0; this.timer = null
    this.once('close', () => clearTimeout(this.timer))
  }
  _transform(chunk, encoding, done) {
    let offset = 0
    const step = () => {
      if (this.destroyed) return
      const wait = this.nextAt - performance.now()
      if (wait > 1) { this.timer = setTimeout(step, wait); return }
      const end = Math.min(offset + 16384, chunk.length)
      this.push(chunk.subarray(offset, end))
      this.nextAt = Math.max(performance.now(), this.nextAt) + (end - offset) / this.rate * 1000
      offset = end
      if (offset === chunk.length) done()
      else step()
    }
    step()
  }
}

module.exports = { FileRate }
