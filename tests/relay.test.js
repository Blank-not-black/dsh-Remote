'use strict'
const { test: nodeTest } = require('node:test')
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { spawnSync, spawn } = require('node:child_process')
const { Registry, signingText } = require('../relay/registry.cjs')
const { createBroker } = require('../relay/broker.cjs')
const { RelayClient, enroll, gatewayAddress } = require('../relay/client.cjs')
const { line, send } = require('../relay/wire.cjs')
const { DailyQuota, DAILY_BYTES, dayAt, resetAt } = require('../relay/quota.cjs')
const { RelayHost } = require('../relay/host.cjs')
const { E2eeEndpoint } = require('../relay/e2ee-endpoint.cjs')
const { generateIdentity, HOSTNAME } = require('../relay/e2ee-identity.cjs')
const { createPairing, connectPinned } = require('../relay/e2ee-channel.cjs')
const { connectRelay } = require('../relay/e2ee-connect.cjs')
const { DeviceStore } = require('../relay/e2ee-devices.cjs')

// Public, throwaway TLS material, used only on loopback. Never a deployed key.
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/relay-test-cert.pem'))
const key = fs.readFileSync(path.join(__dirname, 'fixtures/relay-test-key.pem'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms = 6000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await fn()) return; await pause(20) }
  throw new Error('condition timed out')
}
function keys() {
  const pair = crypto.generateKeyPairSync('ed25519')
  return { publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }
}
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port
}
async function close(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}
function request(port, domain, route, { method = 'GET', token, data, headers = {}, servername, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: route, method, ca: cert, ...(servername ? { servername } : {}), ...(agent === false ? { agent: false } : {}), headers: { host: domain, ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, timeout: 6000 }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error('request timeout'))); req.on('error', reject)
    req.end(data)
  })
}
async function fixture(t, hostCount = 2, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-'))
  const file = path.join(root, 'registry.json')
  const registry = Registry.init(file, { origin: 'https://localhost', baseDomain: 'relay.test', tunnelHost: '127.0.0.1', tunnelPort: 17443 })
  let broker = createBroker({ file, cert, key, frontTls: true, sweepMs: 30, heartbeatMs: 1000, fileBytesPerSecond: 512 * 1024, ...extra })
  const port = await listen(broker.front)
  const tunnelPort = await listen(broker.tunnel)
  registry.change(state => { state.origin = `https://localhost:${port}`; state.tunnelPort = tunnelPort })
  const hosts = []; const clients = []; const upgraded = new Set(); const cleanupTasks = []
  t.after(async () => {
    for (const cleanup of cleanupTasks) await cleanup()
    for (const client of clients) client.stop()
    for (const socket of upgraded) socket.destroy()
    await broker.close()
    for (const host of hosts) await close(host.gateway)
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (let i = 0; i < hostCount; i++) {
    const name = i ? 'beta' : 'alpha'; const token = `isolated-${name}-test-token`
    const received = []
    const gateway = http.createServer((req, res) => {
      received.push(req.url)
      if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); return res.end('unauthorized') }
      if (req.url === '/fs/file?path=image.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)])) }
      if (req.url === '/fs/file?path=fake.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('this is a text file') }
      if (req.url === '/fs/download') { res.writeHead(200); return res.end(Buffer.alloc(128 * 1024, 3)) }
      if (req.url === '/slow' || req.url === '/fs/slow') { res.writeHead(200); res.write('first'); const timer = setTimeout(() => res.end('last'), 1500); res.once('close', () => clearTimeout(timer)); return }
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const payload = Buffer.concat(chunks)
        if (req.url === '/api/session.attachment') {
          const request = JSON.parse(payload), image = request.payload?.attachmentId !== 'not-image'
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ result: { ok: true, value: { attachment: { mediaType: image ? 'image/png' : 'application/octet-stream' }, data: (image ? Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]) : Buffer.from('private file')).toString('base64') } } }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ owner: name, method: req.method, path: req.url, authorization: req.headers.authorization, bytes: payload.length, hash: crypto.createHash('sha256').update(payload).digest('hex') }))
      })
    })
    gateway.on('upgrade', (req, socket) => {
      upgraded.add(socket); socket.once('close', () => upgraded.delete(socket)); socket.on('error', () => {})
      if (req.headers.authorization !== 'Bearer ' + token) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
      const text = Buffer.from(name)
      socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]))
      socket.on('data', chunk => {
        // A masked RFC6455 Ping fixture, echoed as an unmasked Pong.
        if (chunk[0] !== 0x89 || !(chunk[1] & 0x80)) return
        const length = chunk[1] & 0x7f
        if (chunk.length !== length + 6) return
        const output = Buffer.alloc(length + 2); output[0] = 0x8a; output[1] = length
        for (let j = 0; j < length; j++) output[j + 2] = chunk[j + 6] ^ chunk[2 + j % 4]
        socket.write(output)
      })
    })
    const gatewayPort = await listen(gateway)
    const issued = registry.issue({ label: name, domain: `${name}.relay.test`, expiresAt: Date.now() + 60000 })
    if (extra.basicE2ee) registry.change(state => Object.assign(state.grants.find(g => g.id === issued.grant.id), { plan: 'sponsor-basic', periodStartsAt: Date.now() }))
    const pair = keys()
    const config = await enroll(`https://localhost:${port}`, issued.code, pair.publicKey, cert)
    const identity = extra.e2ee ? generateIdentity() : null
    let devices, devicePair
    if (extra.devices) {
      const deviceRoot=path.join(root,name);fs.mkdirSync(path.join(deviceRoot,'e2ee'),{recursive:true,mode:0o700})
      devices=new DeviceStore(deviceRoot,identity)
      devicePair=devices.create({label:name,expiresAt:config.expiresAt,publicUrl:config.publicUrl}).pairing
    }
    const endpoint = identity ? new E2eeEndpoint({ identity, target: { host: '127.0.0.1', port: gatewayPort }, policy: extra.basicE2ee ? 'sponsor-basic' : 'standard', expiresAt: config.expiresAt, devices }) : null
    if (endpoint) cleanupTasks.push(() => endpoint.close())
    const e2ee = endpoint ? { routeTokenHash: crypto.createHash('sha256').update(identity.routeToken).digest('hex'), policy: endpoint.policy, accept: socket => endpoint.accept(socket), ...(extra.allowPlain ? { allowPlain: true, acceptPlain: socket => endpoint.acceptPlain(socket) } : {}) } : undefined
    if(devices)e2ee.devices=devices.routes()
    const client = new RelayClient({ ...config, privateKey: pair.privateKey, gateway: `http://127.0.0.1:${gatewayPort}`, ca: cert, reconnectMs: 30, poolSize: 3, e2ee })
    client.start(); clients.push(client)
    hosts.push({ name, token, gateway, gatewayPort, issued, pair, config, client, identity, received, devices, devicePair, domain: `${name}.relay.test` })
  }
  await until(() => broker.stats().filter(s => s.online && s.pooled >= 2).length === hostCount)
  return { root, file, registry, broker, port, tunnelPort, hosts, clients, cleanupTasks, replaceBroker: value => { broker = value } }
}
function websocket(port, host, route = '/events') {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, ca: cert, path: route, headers: { host: host.domain, authorization: 'Bearer ' + host.token, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } })
    req.on('error', reject)
    req.on('response', res => { res.resume(); reject(new Error('Upgrade rejected: ' + res.statusCode)) })
    req.on('upgrade', (res, socket, head) => { socket.on('error', () => {}); socket.on('data', () => {}); resolve({ socket, head, res }) })
    req.end()
  })
}

function paired(f, host) {
  return { ...createPairing(host.identity.certificate, HOSTNAME), routeToken: host.identity.routeToken,
    relayUrl: `https://${host.domain}:${f.port}/relay/v1/e2ee` }
}
const localLookup = (_, options, done) => done(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4)
function inner(channel, host, route = '/private', { data, method = data ? 'POST' : 'GET', token = host.token, upgrade = false, device, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => channel
    const req = http.request({ host: 'localhost', path: route, method, agent,
      headers: { authorization: 'Bearer ' + token, ...(device ? {'x-dsh-relay-device':device.deviceId+'.'+device.deviceSecret}:{}), ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'sec-websocket-version': '13' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject); req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }))
    req.end(data)
  })
}

test('relay devices: outer routing and inner authorization are independent; revocation kills existing WS and preserves another tenant', async t => {
  const f=await fixture(t,2,{e2ee:true,devices:true}),[a,b]=f.hosts
  const pair=h=>({...h.devicePair,relayUrl:`https://${h.domain}:${f.port}/relay/v1/e2ee`})
  const open=h=>connectRelay(pair(h),{ca:cert,lookup:localLookup})
  assert.equal((await inner(await open(a),a,'/private',{device:pair(a)})).status,200)
  assert.equal((await inner(await open(a),a,'/private')).status,403)
  assert.equal((await inner(await open(a),a,'/private',{device:pair(b)})).status,403)
  const legacy=paired(f,a)
  await assert.rejects(connectRelay(legacy,{ca:cert,lookup:localLookup}),/E2EE_RELAY_REJECTED/)
  const ws=await inner(await open(a),a,'/events',{device:pair(a),upgrade:true})
  assert.equal(ws.status,101);ws.socket.on('data',()=>{});ws.socket.on('error',()=>{})
  const closed=once(ws.socket,'close');a.devices.revoke(a.devicePair.deviceId);await closed
  // Simulate a malicious/stale broker accepting the old outer route: host still rejects it.
  assert.equal((await inner(await open(a),a,'/private',{device:pair(a)})).status,403)
  assert.equal((await inner(await open(b),b,'/private',{device:pair(b)})).status,200)
})

test('relay E2EE: production broker and host endpoint carry inner HTTP, images and WS without cloud plaintext', async t => {
  const f = await fixture(t, 2, { e2ee: true, basicE2ee: true }), [a,b] = f.hosts, traces = [], outerAuth = []
  f.broker.front.on('upgrade', (req, socket) => {
    if (req.url !== '/relay/v1/e2ee') return
    outerAuth.push(req.headers.authorization); socket.on('data', chunk => traces.push(Buffer.from(chunk)))
  })
  const connect = host => connectRelay(paired(f, host), { ca: cert, lookup: localLookup })
  for (const host of [a,b]) {
    const response = await inner(await connect(host), host, '/api/test', { data: JSON.stringify({ text: 'private-e2ee-body' }) })
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).owner, host.name)
    assert.equal((await inner(await connect(host), host, '/private', { token: b === host ? a.token : b.token })).status, 401)
    assert.equal((await inner(await connect(host), host, '/fs/file?path=image.png')).status, 200)
    assert.equal((await inner(await connect(host), host, '/fs/file?path=fake.png')).status, 403)
    assert.equal((await inner(await connect(host), host, '/fs/download')).status, 403)
    assert.equal((await inner(await connect(host), host, 'http://untrusted.invalid/api/test')).status, 400)
    const ws = await inner(await connect(host), host, '/api/events.mux', { upgrade: true })
    assert.equal(ws.status, 101)
    const frame = ws.head.length ? ws.head : (await once(ws.socket, 'data'))[0]
    assert.equal(frame.subarray(2).toString(), host.name); ws.socket.destroy()
    assert.equal((await request(f.port, host.domain, '/private', { token: host.token })).status, 426)
  }
  const emptyTicket = await inner(await connect(a), a, '/api/ws-ticket', { method: 'POST' })
  assert.equal(emptyTicket.status, 200)
  assert.equal(JSON.parse(emptyTicket.body).bytes, 0)
  const malformedTicket = await inner(await connect(a), a, '/api/ws-ticket', { data: 'invalid-json' })
  assert.equal(malformedTicket.status, 400)
  assert.equal(JSON.parse(malformedTicket.body).error, 'INVALID_JSON')
  const emptyRpc = await inner(await connect(a), a, '/api/test', { method: 'POST' })
  assert.equal(emptyRpc.status, 400)

  const wire = Buffer.concat(traces)
  for (const secret of [a.token,b.token,'private-e2ee-body','/api/test','/fs/file','/api/ws-ticket']) assert.equal(wire.includes(Buffer.from(secret)), false)
  assert.ok(outerAuth.every(value => value.startsWith('DSHRelay ')))
  assert.ok(f.broker.monthlyQuota.view(a.issued.grant.id).usedBytes > 0)
  await assert.rejects(connectRelay({ ...paired(f,a), routeToken: b.identity.routeToken }, { ca: cert, lookup: localLookup }), { status: 403 })
})

test('relay E2EE: opaque traffic honors monthly quota, revocation, and tenant isolation', async t => {
  const f = await fixture(t, 2, { e2ee: true, basicE2ee: true, quotaOptions: { limit: 32768, block: 128 } }), [a,b] = f.hosts
  const connect = host => connectRelay(paired(f,host), { ca: cert, lookup: localLookup })
  const active = await inner(await connect(a), a, '/api/events.mux', { upgrade: true })
  active.socket.resume()
  const closed = once(active.socket, 'close')
  const remaining = f.broker.monthlyQuota.view(a.issued.grant.id).remainingBytes
  f.broker.monthlyQuota.consume(a.issued.grant.id, remaining)
  await assert.rejects(connect(a))
  // Refusing a new over-budget connection also closes existing tenant traffic.
  await closed
  assert.equal((await inner(await connect(b), b)).status, 200)
  const bws = await inner(await connect(b), b, '/api/events.mux', { upgrade: true })
  bws.socket.resume()
  const revoked = once(bws.socket, 'close'); f.registry.revoke(b.issued.grant.id); await revoked
  await assert.rejects(connect(b), { status: 403 })
})

test('relay optional encryption: explicit HTTPS-only choice keeps policy and quota, while default still encrypts', async t => {
  const f = await fixture(t, 1, { e2ee: true, basicE2ee: true, allowPlain: true }), [a] = f.hosts, traces = []
  f.broker.front.on('upgrade', (req, socket) => { if (req.url === '/relay/v1/plain') socket.on('data', chunk => traces.push(Buffer.from(chunk))) })
  const options = { ca: cert, lookup: localLookup }, pairedHost = paired(f,a)
  await assert.rejects(connectRelay(pairedHost, { ...options, mode:'legacy' }), { code:'RELAY_DISCLOSURE_ACK_REQUIRED' })
  const encrypted = await connectRelay(pairedHost, options)
  assert.equal(encrypted.getPeerCertificate().fingerprint256, new crypto.X509Certificate(a.identity.certificate).fingerprint256)
  const active = await inner(encrypted,a,'/api/events.mux',{upgrade:true}); active.socket.resume(); t.after(()=>active.socket.destroy())
  const legacy = () => connectRelay(pairedHost,{...options,mode:'legacy',acknowledgeDisclosure:true})
  assert.equal((await inner(await legacy(),a,'/api/test',{data:JSON.stringify({text:'visible-to-relay-after-warning'})})).status,200)
  assert.equal((await inner(await legacy(),a,'/private',{token:'wrong-token'})).status,401)
  assert.equal((await inner(await legacy(),a,'/fs/download')).status,403)
  const wire = Buffer.concat(traces)
  assert.equal(wire.includes(Buffer.from(a.token)),true); assert.equal(wire.includes(Buffer.from('visible-to-relay-after-warning')),true)
  assert.equal(active.socket.destroyed,false)
  assert.ok(f.broker.monthlyQuota.view(a.issued.grant.id).usedBytes>0)
  const again = await connectRelay(pairedHost,options)
  assert.equal(again.getPeerCertificate().fingerprint256,new crypto.X509Certificate(a.identity.certificate).fingerprint256);again.destroy()
})

test('relay optional encryption: a host without explicit plain capability refuses HTTPS-only route',async t=>{
  const f=await fixture(t,1,{e2ee:true,basicE2ee:true}),[a]=f.hosts
  await assert.rejects(connectRelay(paired(f,a),{ca:cert,lookup:localLookup,mode:'legacy',acknowledgeDisclosure:true}),{status:403})
})

nodeTest('relay E2EE: Android system SSLEngine interoperates with the actual broker and host', { timeout: 60000 }, async t => {
  if (spawnSync('javac', ['-version'], { windowsHide: true }).status !== 0) return t.skip('JDK unavailable')
  const f = await fixture(t, 1, { e2ee: true, basicE2ee: true, allowPlain: true, devices:true }), [a] = f.hosts
  // Test-only DNS fixture: connect to localhost while exercising production route selection.
  f.registry.change(state => { state.grants[0].domain = 'localhost' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2ee-java-'))
  f.cleanupTasks.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'E2eeClient.java')
  fs.writeFileSync(source, `package com.dshremote.app;
import java.io.*;import java.net.*;import java.util.*;import java.security.*;import java.security.cert.*;import javax.net.ssl.*;
public class E2eeClient {
 public static void main(String[] args) throws Exception {
  Properties p = new Properties();try(InputStream in=new FileInputStream(args[0])){p.load(in);}
  KeyStore ks=KeyStore.getInstance(KeyStore.getDefaultType());ks.load(null);
  ks.setCertificateEntry("fixture",CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(Base64.getDecoder().decode(p.getProperty("ca")))));
  TrustManagerFactory tf=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());tf.init(ks);
  SSLContext ctx=SSLContext.getInstance("TLS");ctx.init(null,tf.getTrustManagers(),new SecureRandom());SSLContext.setDefault(ctx);
  String mode=args.length>1?args[1]:"",pin=p.getProperty("wrong-host".equals(mode)?"otherpin":"pin");if("bad-pin".equals(mode))pin="0".repeat(64);
  byte[] pairedCert=Base64.getDecoder().decode(p.getProperty("wrong-host".equals(mode)?"othercert":"cert"));
  try(E2eeTls.Channel c=E2eeTls.connect(new URI(p.getProperty("url")),p.getProperty("route"),pairedCert,pin,ctx.getSocketFactory())){
   byte[] request=("GET /private HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer "+p.getProperty("token")+"\\r\\nX-DSH-Relay-Device: "+p.getProperty("device")+"\\r\\nConnection: close\\r\\n\\r\\n").getBytes("UTF-8");c.write(request,0,request.length);
   ByteArrayOutputStream body=new ByteArrayOutputStream();byte[] data=new byte[4096];int n;while((n=c.read(data))>=0)body.write(data,0,n);
   if(!body.toString("UTF-8").contains("paired")&&!body.toString("UTF-8").contains("alpha"))throw new Exception("response missing");
   if(args.length>1)throw new Exception("bad pin accepted");System.out.println("E2EE_NATIVE_OK");
   try(E2eeProxy proxy=new E2eeProxy(new URI(p.getProperty("url")),p.getProperty("route"),Base64.getDecoder().decode(p.getProperty("cert")),pin,true,p.getProperty("device"),Long.parseLong(p.getProperty("expiry")))){
    HttpURLConnection conn=(HttpURLConnection)new URL(proxy.base()+"/private").openConnection();conn.setRequestProperty("Authorization","Bearer "+p.getProperty("token"));
    if(conn.getResponseCode()!=200)throw new Exception("proxy response rejected");try(InputStream bodyStream=conn.getInputStream()){if(!new String(bodyStream.readAllBytes(),"UTF-8").contains("alpha"))throw new Exception("proxy body missing");}conn.disconnect();
    URL wrong=new URL(proxy.base());HttpURLConnection denied=(HttpURLConnection)new URL("http://127.0.0.1:"+wrong.getPort()+"/private").openConnection();if(denied.getResponseCode()!=503)throw new Exception("missing capability accepted");denied.disconnect();System.out.println("E2EE_LOOPBACK_OK");
   }
   try(E2eeProxy plain=new E2eeProxy(new URI(p.getProperty("url")),p.getProperty("route"),pairedCert,pin,false,p.getProperty("device"),Long.parseLong(p.getProperty("expiry")))){
    HttpURLConnection conn=(HttpURLConnection)new URL(plain.base()+"/private").openConnection();conn.setRequestProperty("Authorization","Bearer "+p.getProperty("token"));if(conn.getResponseCode()!=200)throw new Exception("HTTPS-only connection failed");conn.disconnect();System.out.println("HTTPS_ONLY_OK");
   }
  }catch(Exception error){if("bad-pin".equals(mode)&&"E2EE_PIN_MISMATCH".equals(error.getMessage())){System.out.println("E2EE_BAD_PIN_REJECTED");return;}if("wrong-host".equals(mode)&&String.valueOf(error.getMessage()).contains("E2EE_PEER_REJECTED")){System.out.println("E2EE_WRONG_HOST_REJECTED");return;}throw error;}
 }
}`)
  const compile = spawnSync('javac', ['-encoding', 'UTF-8', '-d', dir, ...['E2eeTls.java','E2eeProxy.java'].map(name => path.join(__dirname, '../android/app/src/main/java/com/dshremote/app', name)), source], { encoding: 'utf8', windowsHide: true })
  assert.equal(compile.status, 0, compile.stderr)
  const properties = path.join(dir, 'fixture.properties')
  const other = generateIdentity()
  fs.writeFileSync(properties, [
    'url=https://localhost:' + f.port + '/relay/v1/e2ee', 'route=' + a.devicePair.routeToken,
    'device='+a.devicePair.deviceId+'.'+a.devicePair.deviceSecret,'expiry='+a.devicePair.expiresAt,
    'pin=' + createPairing(a.identity.certificate, HOSTNAME).fingerprint,
    'cert=' + new crypto.X509Certificate(a.identity.certificate).raw.toString('base64'),
    'ca=' + new crypto.X509Certificate(cert).raw.toString('base64'), 'token=' + a.token,
    'otherpin=' + createPairing(other.certificate, HOSTNAME).fingerprint,
    'othercert=' + new crypto.X509Certificate(other.certificate).raw.toString('base64'),
  ].join('\n'))
  async function run(extra = []) {
    const child = spawn('java', ['-cp', dir, 'com.dshremote.app.E2eeClient', properties, ...extra], { windowsHide: true })
    f.cleanupTasks.push(() => { if (child.exitCode === null) child.kill() })
    let out = '', err = ''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => err += data)
    const [code] = await once(child, 'exit'); assert.equal(code, 0, err); return out
  }
  assert.match(await run(), /HTTPS_ONLY_OK/)
  const count = a.received.length
  assert.match(await run(['bad-pin']), /E2EE_BAD_PIN_REJECTED/)
  assert.match(await run(['wrong-host']), /E2EE_WRONG_HOST_REJECTED/)
  assert.equal(a.received.length, count)
})

test('relay registry: hashed invitations, idempotent binding, no host/key reassignment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-registry-'))
  try {
    const file = path.join(root, 'state.json')
    const registry = Registry.init(file, { origin: 'https://control.relay.test', baseDomain: 'relay.test', tunnelHost: 'tunnel.relay.test', tunnelPort: 17443 })
    const issued = registry.issue({ expiresAt: Date.now() + 60000, domain: 'one.relay.test' })
    assert.ok(!fs.readFileSync(file, 'utf8').includes(issued.code))
    const pair = keys()
    assert.deepEqual(registry.enroll(issued.code, pair.publicKey), registry.enroll(issued.code, pair.publicKey))
    assert.throws(() => registry.enroll(issued.code, keys().publicKey), /HOST_ALREADY_BOUND/)
    assert.throws(() => registry.issue({ expiresAt: Date.now() + 60000, domain: 'one.relay.test' }), /DOMAIN_ALREADY_ASSIGNED/)
    assert.throws(() => registry.issue({ expiresAt: Date.now() + 60000, domain: 'evil.test' }), /INVALID_TENANT_DOMAIN/)
    assert.throws(() => registry.issue({ expiresAt: Date.now() - 1 }), /INVALID_EXPIRY/)
    fs.writeFileSync(file + '.lock', '')
    assert.throws(() => registry.enroll(issued.code, pair.publicKey), /REGISTRY_BUSY/)
    fs.unlinkSync(file + '.lock')
    registry.revoke(issued.grant.id)
    assert.throws(() => registry.enroll(issued.code, pair.publicKey), /INVALID_AUTHORIZATION/)
    assert.equal(registry.list()[0].state, 'revoked')
    assert.ok(!JSON.stringify(registry.list()).includes('codeHash'))
    assert.ok(!JSON.stringify(registry.list()).includes('BEGIN PUBLIC'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('relay HTTP: real two-host isolation, original gateway auth, upload integrity and unknown hosts', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  for (const host of [a, b]) {
    const good = await request(f.port, host.domain, '/private', { token: host.token })
    assert.equal(good.status, 200); assert.equal(JSON.parse(good.body).owner, host.name)
    assert.equal((await request(f.port, host.domain, '/private', { token: host === a ? b.token : a.token })).status, 401)
    assert.equal((await request(f.port, host.domain, '/private')).status, 401)
  }
  assert.equal((await request(f.port, 'unknown.relay.test', '/private', { token: a.token })).status, 404)
  const payload = crypto.randomBytes(1024 * 1024)
  const uploaded = await request(f.port, a.domain, '/upload', { method: 'PUT', token: a.token, data: payload, headers: { 'content-length': payload.length } })
  assert.equal(uploaded.status, 200)
  assert.equal(JSON.parse(uploaded.body).hash, crypto.createHash('sha256').update(payload).digest('hex'))
  assert.equal(JSON.parse(uploaded.body).bytes, payload.length)
  assert.ok(f.broker.stats().find(s => s.grantId === a.issued.grant.id).upstreamBytes >= payload.length)
})

test('sponsor broker blocks file transfers while allowing chat images and normal RPC; monthly quota survives midnight', async t => {
  let now = Date.now()
  const f = await fixture(t, 2, { quotaOptions: { now: () => now, limit: 4096, block: 128 } }), [a, b] = f.hosts
  f.registry.change(state => {
    const grant = state.grants.find(g => g.id === a.issued.grant.id)
    Object.assign(grant, { plan: 'sponsor-basic', periodStartsAt: now })
  })
  await assert.rejects(websocket(f.port, a, '/fs/upload'), /403/)
  const ws = await websocket(f.port, a, '/api/events.mux')
  ws.socket.destroy()
  for (const route of ['/fs/upload', '/fs/file?path=a.txt', '/remote/api/session-file', '/api/file-inbox', '/api/session.export']) {
    const result = await request(f.port, a.domain, route, { token: a.token })
    assert.equal(result.status, 403, route)
    assert.equal(JSON.parse(result.body).error, 'FILE_TRANSFER_NOT_ALLOWED')
  }
  const image = await request(f.port, a.domain, '/fs/file?path=image.png', { token: a.token })
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/png')
  assert.equal((await request(f.port, a.domain, '/fs/file?path=fake.png', { token: a.token })).status, 403)
  for (const [id, status] of [['chat-image', 200], ['not-image', 403]]) {
    const result = await request(f.port, a.domain, '/api/session.attachment', { token: a.token, method: 'POST', data: JSON.stringify({ type: 'client-request', method: 'session.attachment', payload: { attachmentId: id } }) })
    assert.equal(result.status, status)
    if (status === 403) assert.ok(!result.body.toString().includes(Buffer.from('private file').toString('base64')))
  }
  assert.equal((await request(f.port, a.domain, '/api/session.prompt', { token: a.token, method: 'POST', data: JSON.stringify({ type: 'client-request', method: 'session.prompt', payload: {} }) })).status, 200)
  assert.equal((await request(f.port, a.domain, '/api/session.prompt', { token: a.token, method: 'POST', data: JSON.stringify({ type: 'client-request', method: 'session.attachment', payload: {} }) })).status, 403)
  await request(f.port, a.domain, '/upload', { method: 'PUT', token: a.token, data: Buffer.alloc(8192) }).catch(() => {})
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 429)
  now += 86400000
  const blocked = await request(f.port, a.domain, '/private', { token: a.token })
  assert.equal(blocked.status, 429); assert.equal(JSON.parse(blocked.body).error, 'MONTHLY_QUOTA_EXCEEDED')
  assert.equal(JSON.parse(blocked.body).monthly.period, 'month')
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
})

test('relay authorization: concurrent activation binds exactly one key and hides cloud administration', async t => {
  const f = await fixture(t, 0)
  const issued = f.registry.issue({ domain: 'race.relay.test', expiresAt: Date.now() + 60000 })
  const result = await Promise.allSettled([keys(), keys()].map(pair => enroll(`https://localhost:${f.port}`, issued.code, pair.publicKey, cert)))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(result.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1)
  await assert.rejects(enroll(`https://localhost:${f.port}`, issued.code.replace(/.$/, c => c === 'a' ? 'b' : 'a'), keys().publicKey, cert))
  assert.equal((await request(f.port, 'localhost', '/relay/v1/grants')).status, 404)
  assert.equal((await request(f.port, 'localhost', '/admin')).status, 404)
})

test('relay file lane limits concurrency while ordinary RPC stays available', async t => {
  const f = await fixture(t); const a = f.hosts[0]
  const first = request(f.port, a.domain, '/fs/slow', { token: a.token })
  const second = request(f.port, a.domain, '/fs/slow', { token: a.token })
  await until(() => f.broker.stats().find(s => s.grantId === a.issued.grant.id).active >= 2)
  assert.equal((await request(f.port, a.domain, '/fs/third', { token: a.token })).status, 429)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
  assert.deepEqual((await Promise.all([first, second])).map(r => r.body.toString()), ['firstlast', 'firstlast'])
  const payload = crypto.randomBytes(128 * 1024)
  const start = performance.now()
  const result = await request(f.port, a.domain, '/fs/upload', { token: a.token, method: 'PUT', data: payload, headers: { 'content-length': payload.length } })
  assert.equal(JSON.parse(result.body).hash, crypto.createHash('sha256').update(payload).digest('hex'))
  assert.ok(performance.now() - start >= 180, 'file upload was paced instead of bursting the entire body')
  const downloadStart = performance.now()
  const downloaded = await request(f.port, a.domain, '/fs/download', { token: a.token })
  assert.deepEqual(downloaded.body, Buffer.alloc(128 * 1024, 3))
  assert.ok(performance.now() - downloadStart >= 180, 'download remains paced even after upstream has finished')
})

test('relay WebSocket: preserves initial frames and bidirectional RFC6455 Ping/Pong', async t => {
  const f = await fixture(t); const host = f.hosts[0]
  const ws = await websocket(f.port, host)
  t.after(() => ws.socket.destroy())
  let incoming = ws.head
  ws.socket.on('data', data => { incoming = Buffer.concat([incoming, data]) })
  await until(() => incoming.includes(Buffer.from('alpha')))
  const mask = Buffer.from([1, 2, 3, 4]); const text = Buffer.from('alive')
  ws.socket.write(Buffer.concat([Buffer.from([0x89, 0x80 | text.length]), mask, Buffer.from(text.map((v, i) => v ^ mask[i % 4]))]))
  await until(() => incoming.includes(Buffer.concat([Buffer.from([0x8a, 5]), text])))
  assert.equal(ws.res.statusCode, 101)
})

test('relay revocation: closes existing WebSockets and active HTTP, preserves other tenant', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  const aws = await websocket(f.port, a); const bws = await websocket(f.port, b)
  t.after(() => { aws.socket.destroy(); bws.socket.destroy() })
  const interrupted = new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: f.port, ca: cert, path: '/slow', headers: { host: a.domain, authorization: 'Bearer ' + a.token } }, res => {
      res.once('data', () => {
        res.once('aborted', () => resolve(true))
        res.on('error', () => resolve(true))
        f.registry.revoke(a.issued.grant.id)
      })
      res.once('end', () => reject(new Error('revoked stream completed')))
    })
    req.on('error', reject); req.end()
  })
  const aClosed = once(aws.socket, 'close')
  await interrupted; await aClosed
  await until(() => !a.client.running)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 403)
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
  assert.equal(bws.socket.destroyed, false)
})

test('relay expiry and host-offline produce distinct failures and cut active connections', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  const ws = await websocket(f.port, a); const closed = once(ws.socket, 'close')
  f.registry.change(state => { state.grants.find(g => g.id === a.issued.grant.id).expiresAt = Date.now() + 100 })
  await closed
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 403)
  b.client.stop()
  await until(() => !f.broker.stats().find(s => s.grantId === b.issued.grant.id).online)
  const response = await request(f.port, b.domain, '/private', { token: b.token })
  assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).error, 'HOST_OFFLINE')
})

test('relay challenge authentication rejects wrong tenant key and replayed signatures', async t => {
  const f = await fixture(t); const [a, b] = f.hosts
  async function rejected(grantId, privateKey, signatureOverride) {
    const socket = tls.connect({ host: '127.0.0.1', port: f.tunnelPort, ca: cert })
    socket.on('error', () => {})
    const challenge = await line(socket)
    const signature = signatureOverride || crypto.sign(null, signingText(challenge.nonce, grantId, 'control', ''), privateKey).toString('base64url')
    const closed = once(socket, 'close')
    send(socket, { role: 'control', grantId, session: '', signature })
    await closed
    return signature
  }
  await rejected(b.issued.grant.id, a.pair.privateKey)
  // Capture a genuinely valid signature, close that session, then replay it
  // against a fresh challenge. Duplicate-host rejection cannot mask the test.
  const third = f.registry.issue({ domain: 'replay.relay.test', expiresAt: Date.now() + 60000 })
  const thirdKeys = keys(); f.registry.enroll(third.code, thirdKeys.publicKey)
  const first = tls.connect({ host: '127.0.0.1', port: f.tunnelPort, ca: cert }); first.on('error', () => {})
  const challenge = await line(first)
  const signature = crypto.sign(null, signingText(challenge.nonce, third.grant.id, 'control', ''), thirdKeys.privateKey).toString('base64url')
  send(first, { role: 'control', grantId: third.grant.id, session: '', signature })
  assert.equal((await line(first)).type, 'accepted')
  first.destroy()
  await until(() => !f.broker.stats().find(s => s.grantId === third.grant.id).online)
  await rejected(third.grant.id, thirdKeys.privateKey, signature)
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
})

test('relay live host cannot be displaced by a duplicate connection', async t => {
  const f = await fixture(t); const a = f.hosts[0]
  const duplicate = new RelayClient({ ...a.config, privateKey: a.pair.privateKey, gateway: `http://127.0.0.1:${a.gatewayPort}`, ca: cert, reconnectMs: 100 })
  t.after(() => duplicate.stop()); duplicate.start()
  await pause(250)
  assert.equal(duplicate.context, null)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
})

test('relay restarts reconnect without exchanging activation codes again', async t => {
  const f = await fixture(t); const a = f.hosts[0]
  await f.broker.close()
  const replacement = createBroker({ file: f.file, cert, key, frontTls: true, sweepMs: 30, heartbeatMs: 1000 })
  replacement.front.listen(f.port, '127.0.0.1'); replacement.tunnel.listen(f.tunnelPort, '127.0.0.1')
  await Promise.all([once(replacement.front, 'listening'), once(replacement.tunnel, 'listening')])
  f.replaceBroker(replacement)
  await until(() => replacement.stats().filter(s => s.online && s.pooled >= 2).length === 2)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
})

test('relay client requires HTTPS and loopback gateway, TLS certificate verification remains enabled', async t => {
  assert.throws(() => gatewayAddress('http://169.254.169.254/'), /LOCAL_GATEWAY_REQUIRED/)
  assert.throws(() => gatewayAddress('http://127.0.0.1:8787/api'), /LOCAL_GATEWAY_REQUIRED/)
  await assert.rejects(enroll('http://localhost', 'invalid', keys().publicKey), /HTTPS_ORIGIN_REQUIRED/)
  const f = await fixture(t); const a = f.hosts[0]
  await assert.rejects(enroll(`https://localhost:${f.port}`, a.issued.code, a.pair.publicKey), /ENROLLMENT_CONNECTION_FAILED/)
})

test('relay admin CLI stores invitations only in private output files and refuses overwrite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-cli-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = path.join(root, 'registry.json'); const out = path.join(root, 'invitation.json')
  const cli = path.join(__dirname, '../relay/admin.cjs')
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: root, USERPROFILE: root, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }, encoding: 'utf8' })
  assert.equal(run(['init', '--state', state, '--origin', 'https://control.relay.test', '--base-domain', 'relay.test', '--tunnel-host', 'tunnel.relay.test']).status, 0)
  const issued = run(['issue', '--state', state, '--out', out, '--domain', 'dev.relay.test'])
  assert.equal(issued.status, 0, issued.stderr)
  const invite = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.ok(!issued.stdout.includes(invite.code))
  assert.ok(!fs.readFileSync(state, 'utf8').includes(invite.code))
  assert.notEqual(run(['issue', '--state', state, '--out', out, '--domain', 'dev2.relay.test']).status, 0)
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600)
})

test('relay client CLI stop actually terminates its control connection and process', async t => {
  const f = await fixture(t, 0)
  const issued = f.registry.issue({ domain: 'cli.relay.test', expiresAt: Date.now() + 60000 })
  const pair = keys(); const config = f.registry.enroll(issued.code, pair.publicKey)
  const state = path.join(f.root, 'client'); fs.mkdirSync(state)
  fs.writeFileSync(path.join(state, 'host-private.pem'), pair.privateKey, { mode: 0o600 })
  fs.writeFileSync(path.join(state, 'connection.json'), JSON.stringify({ ...config, gateway: 'http://127.0.0.1:1' }))
  const cli = path.join(__dirname, '../relay/client.cjs')
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }
  const child = spawn(process.execPath, [cli, 'run', '--state', state, '--ca', path.join(__dirname, 'fixtures/relay-test-cert.pem')], { env, stdio: 'ignore', cwd: path.join(__dirname, '..') })
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), pause(2000)]) }
  })
  await until(() => f.broker.stats().some(s => s.grantId === issued.grant.id && s.online))
  const exited = once(child, 'exit')
  const stopped = spawnSync(process.execPath, [cli, 'stop', '--state', state], { env, encoding: 'utf8' })
  assert.equal(stopped.status, 0)
  const [code] = await exited; assert.equal(code, 0)
  await until(() => f.broker.stats().every(s => !s.online))
})

test('relay daily quota: decimal 5GB, Beijing midnight, durable reservations and no restart reset', t => {
  assert.equal(DAILY_BYTES, 5_000_000_000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-quota-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-10-16T15:59:59Z')
  const file = path.join(root, 'daily.json'), id = '1122334455667788', other = '8877665544332211'
  const options = { now: () => now, limit: 1000, block: 64 }
  const quota = new DailyQuota(file, options)
  assert.equal(dayAt(now), '2026-10-16')
  assert.equal(resetAt(now), Date.parse('2026-10-16T16:00:00Z'))
  assert.equal(quota.consume(id, 65), true)
  assert.equal(quota.view(id).usedBytes, 65)
  const recovered = new DailyQuota(file, options)
  assert.equal(recovered.view(id).usedBytes, 128, 'uncertain unused reservation stays charged after a crash')
  assert.equal(recovered.consume(id, 1000), false)
  assert.equal(recovered.view(id).exhausted, true)
  assert.equal(new DailyQuota(file, options).view(id).remainingBytes, 0)
  assert.equal(recovered.view(other).remainingBytes, 1000)
  now += 1000
  assert.equal(recovered.view(id).day, '2026-10-17')
  assert.equal(recovered.view(id).usedBytes, 0)
  assert.equal(recovered.consume(id, 10), true)
  recovered.checkpoint()
  assert.equal(new DailyQuota(file, options).view(id).usedBytes, 10)
})

test('relay quota storage fails closed on corrupt state or unavailable disk', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-ledger-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'daily.json')
  fs.writeFileSync(file, '{broken')
  assert.throws(() => new DailyQuota(file))
  fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { bad: { day: 'x', reserved: -1 } } }))
  assert.throws(() => new DailyQuota(file), /QUOTA_STORAGE_UNAVAILABLE/)
  fs.unlinkSync(file)
  const quota = new DailyQuota(file)
  fs.unlinkSync(file); fs.mkdirSync(file)
  assert.throws(() => quota.consume('1122334455667788', 1), /QUOTA_STORAGE_UNAVAILABLE/)
  assert.throws(() => quota.view('1122334455667788'), /QUOTA_STORAGE_UNAVAILABLE/)
})

test('relay quota enforces HTTP and existing WS, survives restart, resets by server day and isolates users', async t => {
  let now = Date.parse('2026-10-16T15:59:59Z')
  const quotaOptions = { now: () => now, limit: 4096, block: 128 }
  const f = await fixture(t, 2, { quotaOptions }); const [a,b] = f.hosts
  const aws = await websocket(f.port, a), bws = await websocket(f.port, b)
  t.after(() => { aws.socket.destroy(); bws.socket.destroy() })
  const closed = once(aws.socket, 'close')
  await request(f.port, a.domain, '/upload', { method: 'PUT', token: a.token, data: Buffer.alloc(8192) }).catch(() => {})
  await closed
  const blocked = await request(f.port, a.domain, '/private', { token: a.token })
  assert.equal(blocked.status, 429)
  assert.equal(JSON.parse(blocked.body).daily.remainingBytes, 0)
  assert.equal(JSON.parse(blocked.body).error, 'DAILY_QUOTA_EXCEEDED')
  await until(() => a.client.running && a.client.context)
  assert.equal((await request(f.port, b.domain, '/private', { token: b.token })).status, 200)
  assert.equal(bws.socket.destroyed, false)
  await f.broker.close()
  const replacement = createBroker({ file: f.file, cert, key, frontTls: true, quotaOptions, sweepMs: 30, heartbeatMs: 1000 })
  replacement.front.listen(f.port, '127.0.0.1'); replacement.tunnel.listen(f.tunnelPort, '127.0.0.1')
  await Promise.all([once(replacement.front, 'listening'), once(replacement.tunnel, 'listening')]); f.replaceBroker(replacement)
  await until(() => replacement.stats().filter(s => s.online && s.pooled >= 2).length === 2)
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 429)
  now += 1000
  assert.equal((await request(f.port, a.domain, '/private', { token: a.token })).status, 200)
  assert.equal(replacement.quota.view(a.issued.grant.id).day, '2026-10-17')
})

for (const encrypted of [false, true, 'default']) test('relay gateway settings: single-file enrollment, admin boundary, restart recovery and disable' + (encrypted === 'default' ? ' with default encryption' : encrypted ? ' with E2EE' : ''), async t => {
  const f = await fixture(t, 0), home = path.join(f.root, 'isolated-home')
  fs.mkdirSync(home)
  const gatewayCopy = path.join(home, 'gateway.cjs')
  fs.copyFileSync(path.join(__dirname, '../gateway.js'), gatewayCopy)
  const reservation = http.createServer(); const gatewayPort = await listen(reservation); await close(reservation)
  const origin = `https://localhost:${f.port}`, base = `http://127.0.0.1:${gatewayPort}`
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_REMOTE_FS_ROOT: home,
    DSH_REMOTE_RELAY_ORIGIN: origin, DSH_REMOTE_RELAY_CA_FILE: path.join(__dirname, 'fixtures/relay-test-cert.pem'),
    PORT: String(gatewayPort), HOST: '127.0.0.1', TOKEN: 'relay-settings-admin-test', DSH_UPSTREAM: 'http://127.0.0.1:1',
    DSH_REMOTE_DSH_CONTROL_MODE: 'disabled', UPDATE_CHECK_URL: 'http://127.0.0.1:1', DSH_REMOTE_ANNOUNCEMENTS_URL: '',
    DSH_REMOTE_RELAY_E2EE: encrypted ? '1' : '0',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' }
  // Do not inherit real profile/file overrides from the invoking shell.
  if (encrypted === 'default') delete env.DSH_REMOTE_RELAY_E2EE
  for (const name of ['TOKEN_FILE','DSH_REMOTE_DEVICE_KEYS','DSH_REMOTE_RELAY_STATE','DSH_REMOTE_NOTES','DSH_REMOTE_WORKBENCH','DSH_REMOTE_CRASH_LOG_FILE','DSH_REMOTE_DSH_COOKIE_FILE','DSH_REMOTE_PAIR_LOG']) delete env[name]
  let child
  const start = async () => {
    child = spawn(process.execPath, [gatewayCopy], { env, cwd: home, stdio: 'ignore' })
    await until(async () => { try { return (await fetch(base+'/health')).ok } catch { return false } })
  }
  const stop = async () => { if (child && child.exitCode===null) { const done=once(child,'exit');child.kill();await done } }
  f.cleanupTasks.push(stop)
  const api = async (route, payload, token=env.TOKEN) => {
    const res = await fetch(base+route,{method:payload===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})})
    return { status:res.status, body:await res.json() }
  }
  await start()
  if (encrypted === 'default') {
    const pub=path.join(home,'public');fs.mkdirSync(pub)
    const resource=path.join(pub,'cache.js');fs.writeFileSync(resource,'const a=1;')
    const stat=fs.statSync(resource),first=await fetch(base+'/cache.js',{headers:{'accept-encoding':'identity'}}),old=first.headers.get('etag')
    await first.text();fs.writeFileSync(resource,'const a=2;');fs.utimesSync(resource,stat.atime,stat.mtime)
    const changed=await fetch(base+'/cache.js',{headers:{'accept-encoding':'identity','if-none-match':old,'if-modified-since':stat.mtime.toUTCString()}})
    assert.equal(changed.status,200);assert.equal(await changed.text(),'const a=2;');assert.notEqual(changed.headers.get('etag'),old)
  }
  assert.equal((await api('/relay',undefined,'invalid')).status,401)
  assert.equal((await api('/relay',{action:'enroll',key:'invalid',server:'http://169.254.169.254'})).status,400)
  const initial = await api('/relay'); assert.equal(initial.body.canManage,true);assert.equal(initial.body.configured,false)
  assert.equal(initial.body.canPairLocally,true)
  const preflight=await fetch(base+'/relay/pair',{method:'OPTIONS',headers:{origin:'https://localhost','access-control-request-method':'POST','access-control-request-headers':'authorization, content-type'}})
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://localhost')
  assert.equal((await api('/relay/pair',undefined,'invalid')).status,401)
  assert.equal((await api('/relay/pair')).status,405)
  for(const headers of [{'x-forwarded-for':'192.168.1.2'},{host:'public.example.test:'+gatewayPort}]) {
    const denied=await new Promise((resolve,reject)=>{
      const req=http.request(base+'/relay/pair',{method:'POST',headers:{authorization:'Bearer '+env.TOKEN,'content-type':'application/json',...headers}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))})
      req.on('error',reject);req.end('{}')
    })
    assert.equal(denied,403,'proxy or public Host cannot export pairing credentials: '+JSON.stringify(headers))
  }
  const issued = f.registry.issue({domain:'alpha.relay.test',expiresAt:Date.now()+60000})
  const activated = await api('/relay',{action:'enroll',key:issued.code})
  assert.equal(activated.status,200,JSON.stringify(activated.body));assert.equal(activated.body.enabled,true)
  if(!encrypted)assert.equal((await api('/relay/e2ee',{action:'enable-encryption'})).status,409,'an explicit operator environment policy cannot be bypassed by the UI')
  await until(()=>f.broker.stats().some(s=>s.online&&s.pooled>=2))
  const identityFile = path.join(home,'.dsh-remote/relay-pilot/integrated/e2ee/identity.json')
  let originalPairing = null
  const setupId = '5'.repeat(32)
  if (encrypted) {
    const state=await api('/relay')
    assert.equal((await api('/relay/pair',{label:'Test Android',fingerprint:'0'.repeat(64)})).status,409)
    const made=encrypted==='default'
      ?await api('/relay/pair',{label:'Test Android',fingerprint:state.body.e2ee.fingerprint,setupId})
      :await api('/relay/e2ee',{action:'create-device',label:'Test Android',days:7})
    assert.equal(made.status,200,JSON.stringify(made.body));originalPairing=made.body.pairing
    assert.ok(originalPairing.deviceSecret);assert.ok(!fs.existsSync(path.join(path.dirname(identityFile),'pairing.json')))
    if (encrypted === 'default') {
      const pairingLog = fs.readFileSync(path.join(home,'.dsh-remote/pairing.log'),'utf8')
      const [activity] = (await api('/relay')).body.pairingActivity
      assert.equal(activity.setupId,setupId)
      assert.ok(activity.createdAt>0)
      assert.equal(activity.firstPublicAccessAt,null)
      const duplicate = await api('/relay/pair',{label:'Duplicate',fingerprint:state.body.e2ee.fingerprint,setupId})
      assert.equal(duplicate.body.error,'E2EE_SETUP_ALREADY_USED')
      assert.equal((await api('/relay')).body.pairingActivity.length,1)
      assert.match(pairingLog,/"event":"pair\.created"/)
      assert.ok(pairingLog.includes(originalPairing.deviceId))
      assert.equal(pairingLog.includes(originalPairing.deviceSecret),false,'pairing log must not contain the device secret')
      assert.equal(pairingLog.includes(originalPairing.routeToken),false,'pairing log must not contain the route token')
      assert.match(pairingLog,/"event":"pair\.denied"/)
      assert.match(pairingLog,/"event":"pair\.rejected"/)
    }
    await until(()=>f.broker.stats().some(s=>s.online&&s.pooled>=2))
  }
  const publicRead = async () => {
    if (!encrypted) return request(f.port,'alpha.relay.test','/relay',{token:env.TOKEN})
    const pairing = { ...originalPairing, relayUrl: `https://alpha.relay.test:${f.port}/relay/v1/e2ee` }
    return inner(await connectRelay(pairing,{ca:cert,lookup:localLookup}),{token:env.TOKEN},'/relay',{device:pairing})
  }
  const publicStatus = await publicRead()
  assert.equal(JSON.parse(publicStatus.body).configured,true)
  assert.equal(JSON.parse(publicStatus.body).canManageDevices,false,'relay TCP provenance forbids local management even with the admin token')
  assert.equal(JSON.parse(publicStatus.body).canPairLocally,false,'relay connections cannot bootstrap trust')
  assert.equal(JSON.parse(publicStatus.body).pairingActivity,undefined)
  if (encrypted) {
    const p={...originalPairing,relayUrl:`https://alpha.relay.test:${f.port}/relay/v1/e2ee`}
    assert.equal((await inner(await connectRelay(p,{ca:cert,lookup:localLookup}),{token:env.TOKEN},'/relay/e2ee',{device:p,headers:{host:'127.0.0.1:'+gatewayPort}})).status,403,'even a forged local Host plus admin token is blocked by TCP provenance')
    const blocked=await inner(await connectRelay(p,{ca:cert,lookup:localLookup}),{token:env.TOKEN},'/relay/pair',{data:JSON.stringify({fingerprint:p.fingerprint,label:'forged'}),device:p,headers:{host:'127.0.0.1:'+gatewayPort}})
    assert.equal(blocked.status,403,'public relay cannot provision a device using a forged LAN Host')
    assert.equal((await inner(await connectRelay(p,{ca:cert,lookup:localLookup}),{token:env.TOKEN},'/relay')).status,403,'inner device secret is required independently of outer route and Remote token')
  } else assert.equal((await request(f.port,'alpha.relay.test','/relay/e2ee',{token:env.TOKEN})).status,403)
  const local = await api('/relay')
  assert.equal(local.body.daily.limitBytes,DAILY_BYTES)
  assert.ok(!JSON.stringify(local).includes(issued.code))
  assert.ok(!JSON.stringify(local).includes('PRIVATE KEY'))
  if (encrypted) {
    assert.equal(local.body.e2ee.configured,true)
    if (encrypted === 'default') {
      assert.equal(local.body.pairingActivity[0].setupId,setupId)
      assert.ok(local.body.pairingActivity[0].firstPublicAccessAt>0)
    }
    assert.equal(JSON.stringify(local).includes(originalPairing.routeToken),false)
    assert.equal((await request(f.port,'alpha.relay.test','/relay',{token:env.TOKEN})).status,426)
  }
  const localState = path.join(home,'.dsh-remote/relay-pilot/integrated/connection.json')
  assert.ok(!fs.readFileSync(localState,'utf8').includes(issued.code))
  const device = await api('/admin/api/device-keys/create',{note:'isolated device'})
  const deviceToken = device.body.entry?.token
  assert.ok(deviceToken,'fixture created a device key')
  assert.equal((await api('/admin/api/device-keys/mode',{enabled:true})).status,200)
  const deviceRead = await api('/relay',undefined,deviceToken)
  assert.equal(deviceRead.status,200);assert.equal(deviceRead.body.canManage,false)
  assert.equal((await api('/relay',{action:'disable'},deviceToken)).status,403)
  assert.equal((await api('/relay/e2ee',undefined,deviceToken)).status,403)
  await stop();await until(()=>f.broker.stats().every(s=>!s.online));await start()
  await until(()=>f.broker.stats().some(s=>s.online&&s.pooled>=2))
  assert.equal((await api('/relay')).body.configured,true)
  if (encrypted) {
    assert.equal(createPairing(JSON.parse(fs.readFileSync(identityFile,'utf8')).certificate,HOSTNAME).fingerprint,originalPairing.fingerprint)
    assert.equal((await publicRead()).status,200)
    const before=await api('/relay/e2ee')
    assert.equal(before.body.devices.filter(d=>d.active).length,1)
    assert.ok(!JSON.stringify(before).includes(originalPairing.deviceSecret))
    assert.equal((await api('/relay/e2ee',{action:'revoke-device',id:originalPairing.deviceId})).status,200)
    assert.equal((await api('/relay/e2ee')).body.devices[0].active,false)
    await until(()=>f.broker.stats().some(s=>s.online&&s.pooled>=2))
    const p={...originalPairing,relayUrl:`https://alpha.relay.test:${f.port}/relay/v1/e2ee`}
    await assert.rejects(connectRelay(p,{ca:cert,lookup:localLookup}),/E2EE_RELAY_REJECTED/)
    assert.equal((await api('/relay/e2ee',{action:'rotate-identity',confirm:'wrong'})).status,400)
    const rotated=await api('/relay/e2ee',{action:'rotate-identity',confirm:'REPAIR_ALL_DEVICES'})
    assert.equal(rotated.status,200);assert.notEqual(rotated.body.e2ee.fingerprint,originalPairing.fingerprint);assert.equal(rotated.body.devices.length,0)
    const own=await api('/admin/api/relay/pair',{label:'Authorized LAN phone',fingerprint:rotated.body.e2ee.fingerprint},deviceToken)
    assert.equal(own.status,200,JSON.stringify(own.body));assert.ok(own.body.pairing.deviceSecret)
    assert.ok(!JSON.stringify(own.body).includes('PRIVATE KEY'))
  }
  assert.equal((await api('/admin/api/relay',{action:'disable'})).body.enabled,false)
  await until(()=>f.broker.stats().every(s=>!s.online))
  await until(async()=>(await request(f.port,'alpha.relay.test','/health')).status===503)
})

test('relay quota also meters WS frames without HTTP body traffic', async t => {
  const f = await fixture(t,1,{quotaOptions:{limit:2048,block:64}}), a=f.hosts[0]
  const ws=await websocket(f.port,a), closed=new Promise(resolve=>ws.socket.once('close',resolve))
  const before=f.broker.quota.view(a.issued.grant.id).usedBytes
  const mask=Buffer.from([1,2,3,4]),payload=Buffer.alloc(120,7)
  const frame=Buffer.concat([Buffer.from([0x89,0x80|120]),mask,Buffer.from(payload.map((v,i)=>v^mask[i%4]))])
  for(let i=0;i<30&&!ws.socket.destroyed;i++){ws.socket.write(frame);await pause(10)}
  await closed
  assert.ok(before>0,'upgrade headers were metered')
  assert.equal(f.broker.quota.view(a.issued.grant.id).remainingBytes,0)
  assert.equal((await request(f.port,a.domain,'/private',{token:a.token})).status,429)
})

test('relay settings takes over the prior CLI trial with the same key and stops only that client', async t => {
  const f=await fixture(t,0),root=path.join(f.root,'private-relay'),legacy=path.join(root,'owner-preview')
  fs.mkdirSync(legacy,{recursive:true})
  const pair=keys(),issued=f.registry.issue({domain:'alpha.relay.test',expiresAt:Date.now()+60000})
  const config=f.registry.enroll(issued.code,pair.publicKey)
  fs.writeFileSync(path.join(legacy,'host-private.pem'),pair.privateKey,{mode:0o600})
  fs.writeFileSync(path.join(legacy,'connection.json'),JSON.stringify({...config,gateway:'http://127.0.0.1:1'}))
  const env={...process.env,HOME:f.root,USERPROFILE:f.root,DSH_REMOTE_FS_ROOT:f.root,TOKEN:'migration-test-token',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'*'}
  const child=spawn(process.execPath,[path.join(__dirname,'../relay/client.cjs'),'run','--state',legacy,'--ca',path.join(__dirname,'fixtures/relay-test-cert.pem')],{env,cwd:path.join(__dirname,'..'),stdio:'ignore'})
  const manager=new RelayHost({root:path.join(root,'integrated'),gateway:'http://127.0.0.1:1',origin:`https://localhost:${f.port}`,ca:cert})
  f.cleanupTasks.push(async()=>{manager.stop();if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done}})
  await until(()=>f.broker.stats().some(s=>s.online))
  assert.equal(manager.status().legacyAvailable,true)
  fs.mkdirSync(path.join(root,'integrated'))
  const unusedKey=keys().privateKey
  fs.writeFileSync(path.join(root,'integrated/host-private.pem'),unusedKey,{mode:0o600})
  const exited=once(child,'exit')
  await manager.change('import')
  assert.equal((await exited)[0],0)
  await until(()=>manager.phase==='online')
  assert.equal(manager.status().publicUrl,config.publicUrl)
  assert.equal(fs.readFileSync(path.join(root,'integrated/host-private.pem'),'utf8'),pair.privateKey)
  const saved=fs.readdirSync(path.join(root,'integrated')).find(name=>name.startsWith('host-private.pem.before-import-'))
  assert.equal(fs.readFileSync(path.join(root,'integrated',saved),'utf8'),unusedKey)
  assert.equal(f.registry.get(issued.grant.id).publicKey,pair.publicKey)
  await assert.rejects(manager.change('import'),/HOST_ALREADY_CONFIGURED/)
})

test('three-role sponsor flow issues, binds, meters and revokes one gateway through the broker', async t => {
  const admin = 'isolated-three-role-admin-test-secret-123456', access = 'isolated-three-role-access-token'
  const sponsorNow = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 + 4 * 3600000
  const f = await fixture(t, 0, { sponsor: { adminToken: admin, now: () => sponsorNow } })
  const api = async (route, token, data) => {
    const result = await request(f.port, 'localhost', '/sponsor/api/' + route, {
      token, method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : { data: JSON.stringify(data), headers: { 'content-type': 'application/json' } })
    })
    return { status: result.status, data: JSON.parse(result.body) }
  }
  const draft = (await api('applications', null, {})).data
  const screenshot = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]).toString('base64')
  assert.equal((await api('applications/' + draft.id, draft.token, { amount: '1', screenshot, email: 'three-role@example.test' })).status, 200)
  assert.equal((await api('admin/applications/' + draft.id + '/approve', admin, { verified: true, receipt: 'wx-three-role-0001' })).status, 200)
  const { code } = (await api('applications/' + draft.id + '/claim', draft.token)).data
  const gateway = http.createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer ' + access ? 200 : 401, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  const port = await listen(gateway)
  const host = new RelayHost({ root: path.join(f.root, 'host'), gateway: 'http://127.0.0.1:' + port, origin: 'https://localhost:' + f.port, ca: cert, e2eeEnabled: false })
  f.cleanupTasks.push(async () => { host.stop(); await close(gateway) })
  const state = await host.change('enroll', code)
  assert.equal(state.quotaPeriod, 'month'); assert.equal(state.fileTransfer, false); assert.equal(state.monthlyLimitBytes, 5e9)
  assert.ok(!JSON.stringify(state).includes(code))
  await until(() => host.status().phase === 'online' && host.status().daily?.period === 'month')
  const domain = new URL(state.publicUrl).hostname
  // The local fixture certificate identifies localhost; Host still routes the random tenant.
  const tenant = route => request(f.port, domain, route, { token: access, servername: 'localhost', agent: false })
  assert.equal((await tenant('/health')).status, 200)
  assert.equal((await tenant('/fs/list')).status, 403)
  const reviewed = (await api('admin/applications', admin)).data.applications[0]
  assert.equal(reviewed.usage.period, 'month'); assert.equal(reviewed.usage.online, true); assert.equal(reviewed.usage.limitBytes, 5e9)
  assert.ok(reviewed.usage.usedBytes > 0)
  assert.equal((await api('applications/' + draft.id, draft.token)).data.status, 'approved')
  assert.equal((await api('admin/applications/' + draft.id + '/delivered', admin, {})).status, 200)
  assert.equal((await api('admin/applications/' + draft.id + '/revoke', admin, { note: '隔离验收：人工停止并联系申请人。' })).data.status, 'revoked')
  await until(() => f.broker.stats().every(row => !row.online))
  assert.equal((await tenant('/health')).status, 403)
  assert.equal((await api('applications/' + draft.id, draft.token)).data.status, 'revoked')
})

// Host-side work-channel pool: the Android pre-handshake pool takes up to four ready
// channels, so the host must park more than the old fixed four. The broker parks at most eight.
test('RelayClient parks six work channels by default and honours DSH_REMOTE_RELAY_POOL', () => {
  const pair = keys()
  const config = { grantId: 'a'.repeat(16), privateKey: pair.privateKey, tunnelHost: '127.0.0.1', tunnelPort: 443, expiresAt: Date.now() + 60000, gateway: 'http://127.0.0.1:8787', ca: cert }
  const previous = process.env.DSH_REMOTE_RELAY_POOL
  try {
    delete process.env.DSH_REMOTE_RELAY_POOL
    assert.equal(new RelayClient(config).poolSize, 6, 'default pool is six')
    process.env.DSH_REMOTE_RELAY_POOL = '3'
    assert.equal(new RelayClient(config).poolSize, 3, 'environment overrides the default')
    assert.equal(new RelayClient({ ...config, poolSize: 2 }).poolSize, 2, 'explicit poolSize wins over the environment')
    process.env.DSH_REMOTE_RELAY_POOL = '99'
    assert.equal(new RelayClient(config).poolSize, 6, 'values above six clamp to the broker limit')
    process.env.DSH_REMOTE_RELAY_POOL = '0'
    assert.equal(new RelayClient(config).poolSize, 1, 'values below one clamp to one')
    process.env.DSH_REMOTE_RELAY_POOL = 'abc'
    assert.equal(new RelayClient(config).poolSize, 6, 'malformed values fall back to six')
  } finally {
    if (previous === undefined) delete process.env.DSH_REMOTE_RELAY_POOL
    else process.env.DSH_REMOTE_RELAY_POOL = previous
  }
})

