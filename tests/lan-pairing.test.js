'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto'), dgram = require('node:dgram'), http = require('node:http')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const { createLanPairing } = require('../lib/lan-pairing.cjs')

async function port() {
  const socket = dgram.createSocket('udp4')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const value = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return value
}
async function fixture(t, overrides = {}) {
  const discoveryPort = await port(), issued = []
  const service = createLanPairing({ host: '0.0.0.0', port: 8787, name: 'Test computer', discoveryHost: '127.0.0.1', discoveryPort,
    deviceMode: () => true, issueDevice: () => { const value = { token: crypto.randomBytes(24).toString('base64url'), id: 'device' }; issued.push(value); return value }, ...overrides })
  t.after(() => service.close())
  return { service, issued, discoveryPort }
}
async function discover(discoveryPort) {
  const socket = dgram.createSocket('udp4'), nonce = crypto.randomBytes(16).toString('hex')
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  const request = Buffer.from(JSON.stringify({ type: 'dsh-remote-discover', version: 1, nonce, padding: ' '.repeat(200) }))
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('discovery timeout')), 2000)
    socket.once('message', message => { clearTimeout(timer); resolve(message) })
  })
  socket.send(request, discoveryPort, '127.0.0.1')
  try { const raw = await response; assert.ok(raw.length <= request.length); const value = JSON.parse(raw); assert.equal(value.nonce, nonce); return value }
  finally { socket.close() }
}
function hello(service, instanceId, code, address = '127.0.0.1') {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const clientPublic = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), nonce = crypto.randomBytes(16).toString('hex')
  const response = service.pair(address, { step: 'hello', instanceId, clientPublic, nonce })
  const transcript = ['dsh-lan-v1', instanceId, response.challengeId, nonce, clientPublic, response.serverPublic].join('\n')
  const secret = crypto.createHash('sha256').update(code.replace(/-/g, '')).digest()
  const proof = role => crypto.createHmac('sha256', secret).update(role + '\n' + transcript).digest('hex')
  assert.equal(response.serverProof, proof('server'))
  const shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(response.serverPublic, 'base64'), format: 'der', type: 'spki' }) })
  const key = crypto.createHmac('sha256', secret).update('key\n' + transcript + '\n').update(shared).digest()
  return { finish: { step: 'finish', challengeId: response.challengeId, proof: proof('client') }, key, transcript }
}

test('LAN discovery is opt-in, nonce-bound, bounded and never advertises credentials', async t => {
  const { service, discoveryPort, issued } = await fixture(t)
  assert.equal(service.status().enabled, false)
  const opened = await service.open(), found = await discover(discoveryPort)
  assert.equal(opened.enabled, true); assert.match(opened.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){4}$/)
  assert.deepEqual(Object.keys(found).sort(), ['instanceId', 'name', 'nonce', 'port', 'type', 'version'])
  assert.equal(found.port, 8787); assert.equal(issued.length, 0)
  assert.ok(!JSON.stringify(service.status()).includes(opened.code))
  for (const ip of ['8.8.8.8', '100.64.0.1', '', '10..1.1']) assert.equal(service.localPeer(ip), false)
  assert.throws(() => service.pair('8.8.8.8', {}), { code: 'LAN_ONLY' })
  service.close(); assert.equal(service.status().enabled, false)
})

test('pairing authenticates both peers, encrypts a device token, consumes the code and rejects replay', async t => {
  const { service, discoveryPort, issued } = await fixture(t)
  const { code } = await service.open(), found = await discover(discoveryPort)
  const client = hello(service, found.instanceId, code)
  const encrypted = service.pair('127.0.0.1', client.finish)
  assert.equal(issued.length, 1)
  assert.ok(!JSON.stringify(encrypted).includes(issued[0].token))
  const decipher = crypto.createDecipheriv('aes-256-gcm', client.key, Buffer.from(encrypted.iv, 'base64'))
  decipher.setAAD(Buffer.from(client.transcript)); decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
  const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]))
  assert.equal(decoded.token, issued[0].token)
  assert.equal(service.status().enabled, false)
  assert.throws(() => service.pair('127.0.0.1', client.finish), { code: 'PAIRING_CLOSED' })
})

test('wrong proof, wrong peer, expired challenge, rate limit and write failure never issue credentials', async t => {
  let now = Date.now()
  const { service, discoveryPort, issued } = await fixture(t, { clock: () => now })
  const { code } = await service.open(), found = await discover(discoveryPort)
  let client = hello(service, found.instanceId, code)
  assert.throws(() => service.pair('127.0.0.1', { ...client.finish, proof: '0'.repeat(64) }), { code: 'PAIRING_CODE_INVALID' })
  assert.throws(() => service.pair('127.0.0.1', client.finish), { code: 'CHALLENGE_EXPIRED' })
  client = hello(service, found.instanceId, code)
  assert.throws(() => service.pair('192.168.1.9', client.finish), { code: 'CHALLENGE_EXPIRED' })
  client = hello(service, found.instanceId, code)
  now += 31000
  assert.throws(() => service.pair('127.0.0.1', client.finish), { code: 'CHALLENGE_EXPIRED' })
  for (let i = 0; i < 9; i++) hello(service, found.instanceId, code)
  assert.throws(() => hello(service, found.instanceId, code), { code: 'PAIRING_RATE_LIMIT' })
  assert.equal(issued.length, 0)
  now += 10 * 60 * 1000
  assert.throws(() => service.pair('127.0.0.1', {}), { code: 'PAIRING_CLOSED' })
  const failing = await fixture(t, { issueDevice: () => null })
  const open = await failing.service.open(), host = await discover(failing.discoveryPort)
  const attempt = hello(failing.service, host.instanceId, open.code)
  assert.throws(() => failing.service.pair('127.0.0.1', attempt.finish), { code: 'DEVICE_KEY_WRITE_FAILED' })
})

test('discovery requires independent keys and an externally reachable listener', async t => {
  const disabled = await fixture(t, { deviceMode: () => false })
  await assert.rejects(disabled.service.open(), { code: 'DEVICE_KEYS_REQUIRED' })
  const loopback = await fixture(t, { host: '127.0.0.1' })
  await assert.rejects(loopback.service.open(), { code: 'LAN_LISTENER_REQUIRED' })
})

test('Android/JDK crypto interoperates with the production Node pairing factory', async t => {
  if (spawnSync('javac', ['-version'], { windowsHide: true }).status !== 0) return t.skip('JDK unavailable')
  const { service, discoveryPort } = await fixture(t), { code } = await service.open(), host = await discover(discoveryPort)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-java-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pkg = path.join(dir, 'com/dshremote/app'); fs.mkdirSync(pkg, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '../android/app/src/main/java/com/dshremote/app/LanPairCrypto.java'), path.join(pkg, 'LanPairCrypto.java'))
  fs.writeFileSync(path.join(pkg, 'PairClient.java'), `package com.dshremote.app;
import java.net.*;import java.io.*;import java.util.*;import java.util.regex.*;
public class PairClient {
 static String field(String json,String name){Matcher m=Pattern.compile("\\\""+name+"\\\":\\s*\\\"([^\\\"]*)\\\"").matcher(json);if(!m.find())throw new RuntimeException(name);return m.group(1);}
 static String post(String url,String body)throws Exception{HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection();try{c.setConnectTimeout(2000);c.setReadTimeout(2000);c.setRequestMethod("POST");c.setDoOutput(true);try(OutputStream o=c.getOutputStream()){o.write(LanPairCrypto.bytes(body));}return new String(c.getInputStream().readAllBytes(),"UTF-8");}finally{c.disconnect();}}
 public static void main(String[] a)throws Exception{LanPairCrypto c=new LanPairCrypto();Base64.Encoder e=Base64.getEncoder();Base64.Decoder d=Base64.getDecoder();String pub=e.encodeToString(c.publicKey()),nonce="01234567890123456789012345678901";
 String h=post(a[0],"{\\\"step\\\":\\\"hello\\\",\\\"instanceId\\\":\\\""+a[1]+"\\\",\\\"nonce\\\":\\\""+nonce+"\\\",\\\"clientPublic\\\":\\\""+pub+"\\\"}");
 String id=field(h,"challengeId"),sp=field(h,"serverPublic"),tr="dsh-lan-v1\\n"+a[1]+"\\n"+id+"\\n"+nonce+"\\n"+pub+"\\n"+sp;
 try{c.authenticate("00000000000000000000",tr,field(h,"serverProof"));throw new RuntimeException("wrong code accepted");}catch(SecurityException expected){}
 String proof=c.authenticate(a[2],tr,field(h,"serverProof"));String out=post(a[0],"{\\\"step\\\":\\\"finish\\\",\\\"challengeId\\\":\\\""+id+"\\\",\\\"proof\\\":\\\""+proof+"\\\"}");
 byte[] iv=d.decode(field(out,"iv")),body=d.decode(field(out,"ciphertext")),tag=d.decode(field(out,"tag"));String clear=c.decrypt(d.decode(sp),iv,body,tag);if(!clear.contains("token"))throw new RuntimeException("token missing");
 tag[0]^=1;try{c.decrypt(d.decode(sp),iv,body,tag);throw new RuntimeException("tamper accepted");}catch(javax.crypto.AEADBadTagException expected){}System.out.println("PAIR_CRYPTO_OK");}
}`)
  const compile = spawnSync('javac', ['-encoding', 'UTF-8', '-d', dir, path.join(pkg, 'LanPairCrypto.java'), path.join(pkg, 'PairClient.java')], { encoding: 'utf8', windowsHide: true })
  assert.equal(compile.status, 0, compile.stderr)
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    try { res.end(JSON.stringify(service.pair('127.0.0.1', JSON.parse(body)))) } catch (error) { res.writeHead(error.status || 500); res.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const child = spawn('java', ['-cp', dir, 'com.dshremote.app.PairClient', `http://127.0.0.1:${server.address().port}`, host.instanceId, code], { windowsHide: true })
  let output = '', errors = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => errors += value)
  const [exit] = await once(child, 'exit'); assert.equal(exit, 0, errors); assert.match(output, /PAIR_CRYPTO_OK/)
})

test('standalone gateway gates LAN management, pairs a revocable device and keeps codes out of readback', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lan-gateway-')), discoveryPort = await port()
  const upstream = http.createServer((req, res) => res.end('{}'))
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const gatewayPort = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: home, HOST: '0.0.0.0', PORT: String(gatewayPort),
    TOKEN: 'lan-test-admin-token', DSH_REMOTE_TOKEN: '', TOKEN_FILE: path.join(home, 'token'), DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_DEVICE_KEYS: path.join(home, 'keys.json'), DSH_REMOTE_DISCOVERY_PORT: String(discoveryPort),
    DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', DSH_REMOTE_ANNOUNCEMENTS_URL: '', DSH_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    UPDATE_CHECK_URL: 'http://127.0.0.1:1/update', UPDATE_PROXY: '', NO_PROXY: '*' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[key]
  const child = spawn(process.execPath, [path.join(__dirname, '../gateway.js')], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume(); let errors = ''; child.stderr.on('data', value => errors += value)
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    await new Promise(resolve => upstream.close(resolve)); fs.rmSync(home, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${gatewayPort}`, headers = { authorization: 'Bearer lan-test-admin-token', 'content-type': 'application/json' }
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(200) })).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, errors)
  const post = (route, body, auth = headers) => fetch(base + route, { method: 'POST', headers: auth, body: JSON.stringify(body) })
  assert.equal((await fetch(base + '/admin/api/lan')).status, 401)
  assert.equal((await post('/admin/api/lan', { enabled: true })).status, 409)
  assert.equal((await post('/admin/api/device-keys/mode', { enabled: true })).status, 200)
  const opened = await (await post('/admin/api/lan', { enabled: true })).json()
  assert.equal(opened.enabled, true)
  const readback = await (await fetch(base + '/admin/api/lan', { headers })).json()
  assert.equal(readback.code, undefined)
  assert.equal((await post('/api/lan-pair', {}, { 'content-type': 'application/json', origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await post('/api/lan-pair', {}, {})).status, 415)
  const found = await discover(discoveryPort), keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const clientPublic = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), nonce = crypto.randomBytes(16).toString('hex')
  const response = await (await post('/api/lan-pair', { step: 'hello', instanceId: found.instanceId, clientPublic, nonce }, { 'content-type': 'application/json' })).json()
  const transcript = ['dsh-lan-v1', found.instanceId, response.challengeId, nonce, clientPublic, response.serverPublic].join('\n')
  const secret = crypto.createHash('sha256').update(opened.code.replace(/-/g, '')).digest()
  assert.equal(response.serverProof, crypto.createHmac('sha256', secret).update('server\n' + transcript).digest('hex'))
  const proof = crypto.createHmac('sha256', secret).update('client\n' + transcript).digest('hex')
  const encrypted = await (await post('/api/lan-pair', { step: 'finish', challengeId: response.challengeId, proof }, { 'content-type': 'application/json' })).json()
  const shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(response.serverPublic, 'base64'), format: 'der', type: 'spki' }) })
  const key = crypto.createHmac('sha256', secret).update('key\n' + transcript + '\n').update(shared).digest()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64')); decipher.setAAD(Buffer.from(transcript)); decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
  const device = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]))
  assert.equal((await fetch(base + '/api/events.poll?kind=mux&since=0', { headers: { authorization: 'Bearer ' + device.token } })).status, 200)
  assert.equal((await fetch(base + '/admin/api/lan', { headers: { authorization: 'Bearer ' + device.token } })).status, 401)
  assert.equal((await fetch(base + '/admin/api/lan', { headers }).then(r => r.json())).enabled, false)
  assert.equal((await post('/admin/api/device-keys/revoke', { id: device.deviceId })).status, 200)
  assert.equal((await fetch(base + '/api/events.poll?kind=mux&since=0', { headers: { authorization: 'Bearer ' + device.token } })).status, 401)
})
