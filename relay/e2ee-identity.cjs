'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createPairing } = require('./e2ee-channel.cjs')
const { fault } = require('./registry.cjs')
const HOSTNAME = 'dsh-remote-e2ee.local'

// DER for one self-signed X.509 v3 identity. Signing and verification use native
// node:crypto. This implements a certificate encoding, not a cipher/protocol.
function der(tag, ...parts) {
  const value = Buffer.concat(parts), length = value.length
  const size = length < 128 ? Buffer.from([length]) : length < 256 ? Buffer.from([0x81, length]) : Buffer.from([0x82, length >> 8, length & 255])
  return Buffer.concat([Buffer.from([tag]), size, value])
}
const seq = (...parts) => der(0x30, ...parts)
const oid = hex => der(6, Buffer.from(hex, 'hex'))
const bit = bytes => der(3, Buffer.from([0]), bytes)
const extension = (id, value, critical = false) => seq(oid(id), ...(critical ? [Buffer.from([1, 1, 255])] : []), der(4, value))
function generateIdentity(now = Date.now()) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const algorithm = seq(oid('2a8648ce3d040302')) // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(oid('550403'), der(12, Buffer.from(HOSTNAME)))))
  const time = value => {
    const date = new Date(value), stamp = date.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z')
    return date.getUTCFullYear() >= 1950 && date.getUTCFullYear() < 2050 ? der(23, Buffer.from(stamp.slice(2))) : der(24, Buffer.from(stamp))
  }
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] ||= 1
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm, name,
    seq(time(now - 300000), time(now + 365 * 86400000)), name,
    pair.publicKey.export({ format: 'der', type: 'spki' }),
    der(0xa3, seq(extension('551d13', seq(), true),
      extension('551d0f', der(3, Buffer.from([7, 0x80])), true),
      extension('551d25', seq(oid('2b06010505070301'))),
      extension('551d11', seq(der(0x82, Buffer.from(HOSTNAME)))))))
  const bytes = seq(tbs, algorithm, bit(crypto.sign('sha256', tbs, pair.privateKey)))
  const certificate = '-----BEGIN CERTIFICATE-----\n' + bytes.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'
  const parsed = new crypto.X509Certificate(certificate)
  if (!parsed.verify(pair.publicKey)) throw fault('E2EE_IDENTITY_INVALID')
  return { certificate, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), routeToken: crypto.randomBytes(32).toString('base64url') }
}
function validateIdentity(value) {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.routeToken || '')) throw fault('E2EE_IDENTITY_INVALID')
  const cert = new crypto.X509Certificate(value.certificate), key = crypto.createPrivateKey(value.privateKey)
  const now = Date.now(), from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !cert.checkPrivateKey(key) || !cert.verify(cert.publicKey) || now < from || now >= to) throw fault('E2EE_IDENTITY_INVALID')
  createPairing(value.certificate, HOSTNAME)
  return value
}
function privateDirectory(root) {
  const dir = path.join(root, 'e2ee'), file = path.join(dir, 'identity.json')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(dir).isSymbolicLink() || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw fault('E2EE_IDENTITY_INVALID')
  if (process.platform === 'win32') {
    // Apply before writing secrets. An ACL failure is fatal, never a warning.
    const script = "$ErrorActionPreference='Stop'; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetOwner($owner); foreach($sid in @($owner,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; [System.IO.Directory]::SetAccessControl($env:DSH_E2EE_PRIVATE_DIRECTORY,$acl)"
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, DSH_E2EE_PRIVATE_DIRECTORY: dir }, windowsHide: true, stdio: 'pipe', timeout: 10000,
    })
    if (result.status !== 0) throw fault('E2EE_PRIVATE_DIRECTORY_UNAVAILABLE', 503)
  } else fs.chmodSync(dir, 0o700)
  return {dir, file}
}
function rotateIdentity(root) {
  const {file,dir} = privateDirectory(root), value = generateIdentity()
  const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
  try { fs.writeFileSync(temp, JSON.stringify(value) + '\n', {flag:'wx',mode:0o600}); fs.renameSync(temp,file) }
  finally { fs.rmSync(temp,{force:true}) }
  // An interruption before this reset makes the mismatched store fail closed.
  const pairing = createPairing(value.certificate, HOSTNAME)
  const store = path.join(dir,'devices.json'), pending = store + '.reset.tmp'
  try { fs.writeFileSync(pending, JSON.stringify({schema:1,fingerprint:pairing.fingerprint,devices:[]})+'\n',{flag:'wx',mode:0o600}); fs.renameSync(pending,store) }
  finally { fs.rmSync(pending,{force:true}) }
  fs.rmSync(path.join(dir,'pairing.json'),{force:true})
  return value
}
function loadIdentity(root) {
  const {file} = privateDirectory(root)
  if (fs.existsSync(file)) return validateIdentity(JSON.parse(fs.readFileSync(file, 'utf8')))
  const value = generateIdentity(), temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    // Exclusive link avoids replacing an identity generated by another process.
    try { fs.linkSync(temp, file) } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { fs.rmSync(temp, { force: true }) }
  return validateIdentity(JSON.parse(fs.readFileSync(file, 'utf8')))
}
module.exports = { HOSTNAME, generateIdentity, validateIdentity, loadIdentity, rotateIdentity }
