/* 纯 JS SHA-256（零依赖，二进制安全）
 * 上传大文件时逐块喂入 4MB slice，最后与网关计算的 SHA-256 比对，防坏包。
 */
'use strict'

function SHA256() {
  this.h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ])
  this.buf = new Uint8Array(64)
  this.bufLen = 0
  this.total = 0
}

SHA256.prototype._process = function (block) {
  const w = new Uint32Array(64)
  for (let i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]
  }
  for (let i = 16; i < 64; i++) {
    const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)
    const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
  }
  let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3]
  let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7]
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const ch = (e & f) ^ (~e & g)
    const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (S0 + maj) >>> 0
    h = g; g = f; f = e; e = (d + t1) >>> 0
    d = c; c = b; b = a; a = (t1 + t2) >>> 0
  }
  this.h[0] = (this.h[0] + a) >>> 0
  this.h[1] = (this.h[1] + b) >>> 0
  this.h[2] = (this.h[2] + c) >>> 0
  this.h[3] = (this.h[3] + d) >>> 0
  this.h[4] = (this.h[4] + e) >>> 0
  this.h[5] = (this.h[5] + f) >>> 0
  this.h[6] = (this.h[6] + g) >>> 0
  this.h[7] = (this.h[7] + h) >>> 0
}

SHA256.prototype.update = function (bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  this.total += data.length
  let i = 0
  if (this.bufLen > 0) {
    const need = 64 - this.bufLen
    const n = Math.min(need, data.length)
    this.buf.set(data.subarray(0, n), this.bufLen)
    this.bufLen += n
    i = n
    if (this.bufLen === 64) {
      this._process(this.buf)
      this.bufLen = 0
    }
  }
  while (i + 64 <= data.length) {
    this._process(data.subarray(i, i + 64))
    i += 64
  }
  if (i < data.length) {
    this.buf.set(data.subarray(i), 0)
    this.bufLen = data.length - i
  }
  return this
}

SHA256.prototype.clone = function () {
  const c = new SHA256()
  c.h.set(this.h)
  c.buf.set(this.buf)
  c.bufLen = this.bufLen
  c.total = this.total
  return c
}

SHA256.prototype.hex = function () {
  const lenBits = this.total * 8
  const pad = new Uint8Array(72)
  pad[0] = 0x80
  const tail = (this.total + 9) % 64
  const zero = tail === 0 ? 0 : 64 - tail
  const padLen = 1 + zero + 8
  // 长度 64 位大端: 高位 32 位 + 低位 32 位
  const hi = Math.floor(lenBits / 0x100000000)
  const lo = lenBits >>> 0
  pad[padLen - 8] = (hi >>> 24) & 0xff
  pad[padLen - 7] = (hi >>> 16) & 0xff
  pad[padLen - 6] = (hi >>> 8) & 0xff
  pad[padLen - 5] = hi & 0xff
  pad[padLen - 4] = (lo >>> 24) & 0xff
  pad[padLen - 3] = (lo >>> 16) & 0xff
  pad[padLen - 2] = (lo >>> 8) & 0xff
  pad[padLen - 1] = lo & 0xff
  this.update(pad.subarray(0, padLen))
  const out = []
  for (let i = 0; i < 8; i++) {
    const v = this.h[i]
    out.push((v >>> 24).toString(16).padStart(2, '0'), ((v >>> 16) & 0xff).toString(16).padStart(2, '0'), ((v >>> 8) & 0xff).toString(16).padStart(2, '0'), (v & 0xff).toString(16).padStart(2, '0'))
  }
  return out.join('')
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])
