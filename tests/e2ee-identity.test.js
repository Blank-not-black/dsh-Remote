'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { generateIdentity, validateIdentity, loadIdentity, HOSTNAME } = require('../relay/e2ee-identity.cjs')

test('E2EE native-generated X.509 identity is self-signed, named, time-bounded and distinct per host', () => {
  const a = generateIdentity(), b = generateIdentity(), cert = new crypto.X509Certificate(a.certificate)
  assert.equal(cert.checkHost(HOSTNAME), HOSTNAME); assert.equal(cert.ca, false)
  assert.equal(cert.verify(cert.publicKey), true); assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(a.privateKey)), true)
  assert.ok(Date.parse(cert.validFrom) < Date.now()); assert.ok(Date.parse(cert.validTo) > Date.now())
  assert.notEqual(a.certificate, b.certificate); assert.notEqual(a.routeToken, b.routeToken)
  assert.throws(() => validateIdentity({ ...a, privateKey: b.privateKey }), /E2EE_IDENTITY_INVALID/)
  assert.throws(() => validateIdentity(generateIdentity(Date.now() - 400 * 86400000)), /E2EE_IDENTITY_INVALID/)
})

test('E2EE persisted identity survives restart and refuses corrupt state instead of silently re-pairing', { timeout: 30000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-e2ee-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const a = loadIdentity(root), b = loadIdentity(root)
  assert.deepEqual(a, b)
  const file = path.join(root, 'e2ee/identity.json')
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700) }
  fs.writeFileSync(file, '{corrupt')
  assert.throws(() => loadIdentity(root))
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt')
})
