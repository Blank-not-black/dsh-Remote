'use strict'
// Opt-in, bounded mixed-load exercise. All servers, files and tokens are fixtures.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { createRealisticStack } = require('./fixtures/realistic-stack.cjs')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('receipt saturation: 1000 durable intents reject the next write while reads and exact retries remain available', {
  skip: process.env.DSH_TEST_EXTREMES !== '1', timeout: 180000,
}, async t => {
  const s = await createRealisticStack()
  t.after(() => s.stop())
  const headers = { authorization: 'Bearer ' + s.token, 'content-type': 'application/json' }
  const ids = Array.from({ length: 1000 }, () => crypto.randomUUID())
  const body = JSON.stringify({ method: 'session.prompt', payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'isolated capacity fixture' }] } })
  const submit = id => fetch(s.base + '/api/operations?id=' + id, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(15000),
  })
  let next = 0
  const began = Date.now()
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < ids.length) {
      const index = next++, response = await submit(ids[index])
      assert.ok([200, 202].includes(response.status), 'operation ' + index + ' HTTP ' + response.status)
      await response.arrayBuffer()
    }
  }))
  for (let i = 0; i < 100 && s.records.prompts.length < 1000; i++) await pause(50)
  assert.equal(s.records.prompts.length, 1000)
  let response = await submit(crypto.randomUUID())
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error, 'operation-capacity')
  assert.equal(s.records.prompts.length, 1000)
  response = await submit(ids[0])
  assert.ok([200, 202].includes(response.status)); await response.arrayBuffer()
  response = await fetch(s.base + '/api/operations?id=' + ids[0], { headers, signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).phase, 'complete')
  assert.equal(s.records.prompts.length, 1000, 'exact retry at capacity must not execute a duplicate')
  response = await fetch(s.base + '/api/session.list', { method: 'POST', headers,
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} }), signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).result.ok, true)
  response = await fetch(s.base + '/health', { signal: AbortSignal.timeout(5000) })
  const health = await response.json()
  assert.equal(health.ok, true)
  assert.equal(health.runtime.uncaughtExceptions, 0)
  const files = fs.readdirSync(path.join(s.tmpRoot, 'operations')).filter(name => name.endsWith('.json'))
  assert.equal(files.length, 1000)
  t.diagnostic(JSON.stringify({ phase: 'receipt-capacity', accepted: 1000, nextStatus: 429, exactRetryDidNotRepeat: true,
    upstreamIntents: s.records.prompts.length, durableReceipts: files.length, healthOk: health.ok, durationMs: Date.now() - began }))
})

test('mixed soak: reconnecting clients, interrupted uploads and duplicate mutations remain isolated', {
  skip: process.env.DSH_TEST_EXTREMES !== '1', timeout: 660000,
}, async t => {
  const duration = Number(process.env.DSH_TEST_EXTREME_SOAK_MS || 180000)
  assert.ok(Number.isInteger(duration) && duration >= 1000 && duration <= 600000)
  const s = await createRealisticStack(), clients = new Set(), activeUploads = new Set()
  t.after(async () => {
    for (const req of activeUploads) req.destroy()
    for (const ws of clients) try { ws.close() } catch {}
    await s.stop()
  })
  const headers = { authorization: 'Bearer ' + s.token }
  const request = (route, options = {}) => fetch(s.base + route, {
    ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(5000),
  })
  const json = async (route, options = {}) => {
    const response = await request(route, options)
    const body = await response.json()
    assert.equal(response.status, 200, route + ': ' + JSON.stringify(body))
    return body
  }
  const rpc = method => json('/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: method === 'session.history' ? { sessionId: 'session-1' } : {} }) })
  const connect = async () => {
    const ticket = await json('/api/ws-ticket', { method: 'POST' })
    const ws = new WebSocket(s.base.replace(/^http/, 'ws') + '/api/events.mux?ticket=' + encodeURIComponent(ticket.ticket))
    clients.add(ws)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('WS connect timed out')), 5000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('WS connect failed')) }, { once: true })
    })
    return ws
  }
  const close = async ws => {
    if (ws.readyState === WebSocket.CLOSED) { clients.delete(ws); return }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('WS close timed out')), 5000)
      ws.addEventListener('close', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.close()
    })
    clients.delete(ws)
  }
  const wsClients = await Promise.all(Array.from({ length: 16 }, connect))
  // A real TCP client stops in the middle of an upload. No final target may appear.
  const abortUpload = async round => {
    const name = 'aborted-' + round + '.bin'
    await new Promise((resolve, reject) => {
      let finished = false
      const done = error => {
        if (finished) return
        finished = true; clearTimeout(timer); activeUploads.delete(req)
        error ? reject(error) : resolve()
      }
      const req = http.request(s.base + '/fs/upload?path=' + encodeURIComponent(s.tmpRoot) + '&name=' + name, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '1048576' },
      })
      activeUploads.add(req)
      const timer = setTimeout(() => { req.destroy(); done(Error('abort upload timed out')) }, 5000)
      req.on('error', error => { if (error.code !== 'ECONNRESET') done(error) })
      req.on('close', () => done())
      req.write(Buffer.alloc(65536, round % 255), error => {
        if (error) return done(error)
        setTimeout(() => req.destroy(), 30)
      })
    })
    await pause(60)
    assert.equal(fs.existsSync(path.join(s.tmpRoot, name)), false)
  }
  const resumable = async round => {
    const name = '中文 空格-' + round + '.bin', session = crypto.randomUUID()
    const data = crypto.randomBytes(32768), middle = 12345
    const route = '/fs/upload?path=' + encodeURIComponent(s.tmpRoot) + '&name=' + encodeURIComponent(name) + '&session=' + session
    let response = await request(route + '&offset=0', { method: 'POST', body: data.subarray(0, middle) })
    assert.equal(response.status, 200); await response.arrayBuffer()
    const probe = await json('/fs/upload-probe?path=' + encodeURIComponent(s.tmpRoot) + '&name=' + encodeURIComponent(name) + '&session=' + session)
    assert.equal(probe.partialSize, middle)
    response = await request(route + '&offset=' + middle + '&finish=1&sha256=' + crypto.createHash('sha256').update(data).digest('hex'), {
      method: 'POST', body: data.subarray(middle),
    })
    assert.equal(response.status, 201); await response.arrayBuffer()
    assert.deepEqual(fs.readFileSync(path.join(s.tmpRoot, name)), data)
    fs.unlinkSync(path.join(s.tmpRoot, name))
  }
  const duplicateIntent = async round => {
    const id = crypto.randomUUID(), route = '/api/operations?id=' + id
    const body = JSON.stringify({ method: 'session.prompt', payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'fixture ' + round }] } })
    const before = s.records.prompts.length
    await Promise.all(Array.from({ length: 32 }, async () => {
      const response = await request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      assert.ok([200, 202].includes(response.status)); await response.arrayBuffer()
    }))
    let receipt
    for (let i = 0; i < 100; i++) {
      receipt = await json(route)
      if (receipt.phase === 'complete') break
      await pause(20)
    }
    assert.equal(receipt.phase, 'complete')
    assert.equal(s.records.prompts.length - before, 1, '32 retries must execute one fixture intent')
  }
  const firstHealth = await json('/health'), pid = firstHealth.pid
  const fdCount = () => {
    try { return fs.readdirSync('/proc/' + pid + '/fd').length } catch { return null }
  }
  const rssMiB = () => {
    try { return Number(fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) / 1024 } catch { return null }
  }
  const samples = [], latencies = [], start = Date.now()
  let rounds = 0
  while (Date.now() - start < duration) {
    const began = Date.now()
    await Promise.all(Array.from({ length: 16 }, (_, i) => rpc(i % 2 ? 'session.history' : 'session.list')))
    const health = await json('/health')
    latencies.push(Date.now() - began)
    assert.equal(health.pid, pid, 'gateway may not crash or silently restart under load')
    assert.equal(health.events.mux.connected, true)
    assert.equal(health.runtime.uncaughtExceptions, 0)
    assert.equal(health.runtime.unhandledRejections, 0)
    const denied = await fetch(s.base + '/fs/file?path=' + encodeURIComponent(path.join(s.tmpRoot, 'sample.txt')), { signal: AbortSignal.timeout(5000) })
    assert.equal(denied.status, 401); await denied.arrayBuffer()
    await Promise.all([abortUpload(rounds), resumable(rounds), duplicateIntent(rounds)])
    const slot = rounds % wsClients.length
    await close(wsClients[slot]); wsClients[slot] = await connect()
    rounds++
    if (rounds === 5 || rounds % 10 === 0) samples.push({ round: rounds, elapsedMs: Date.now() - start, fds: fdCount(), rssMiB: rssMiB() })
    await pause(400)
  }
  for (const ws of wsClients) await close(ws)
  await pause(300)
  const endFd = fdCount(), stableFd = samples.find(x => x.fds !== null)?.fds
  if (stableFd !== undefined && stableFd !== null && endFd !== null) assert.ok(endFd <= stableFd + 16, 'gateway FD count must stay bounded after client churn')
  latencies.sort((a, b) => a - b)
  t.diagnostic(JSON.stringify({ phase: 'mixed-soak', durationMs: Date.now() - start, rounds, parallelReads: 16,
    duplicateRetries: rounds * 32, upstreamIntents: s.records.prompts.length, abortedUploads: rounds, verifiedResumes: rounds,
    websocketReconnects: rounds, samples, finalFds: endFd, healthBatchP95Ms: latencies[Math.floor(latencies.length * .95)] }))
})
