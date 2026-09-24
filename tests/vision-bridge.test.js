'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const http = require('node:http')
const crypto = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')
const rejection = { result: { ok: false, error: { code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } } } }
const accepted = { result: { ok: true, value: { accepted: true } } }
const markdown = '![图片](/api/dsh-image-vision/raw/sha256%3Aabcd?m=image%2Fpng&b=4&w=1&h=1)'

async function fixture(t, options = {}) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    calls.push({ url: req.url, body, cookie: req.headers.cookie })
    res.setHeader('content-type', 'application/json')
    if (req.url.endsWith('/config')) {
      res.statusCode = options.missing ? 404 : 200
      res.end(JSON.stringify({ config: { enabled: options.enabled !== false } }))
    } else if (req.url.endsWith('/attach')) {
      const n = calls.filter(c => c.url.endsWith('/attach')).length
      res.end(JSON.stringify({ ok: true, markdown: options.failSecond && n === 2 ? 'bad' : markdown }))
    } else {
      const payload = body.args?.request || body.payload
      res.end(JSON.stringify(options.result || (payload.content.some(p => p.type === 'image') ? rejection : accepted)))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const upstream = new URL(`http://127.0.0.1:${server.address().port}`)
  const ctx = vm.createContext({ fetch, URL, AbortSignal, crypto, UPSTREAM: upstream, UPSTREAM_REQUEST_TIMEOUT_MS: 2000,
    dshUpstreamHeaders: headers => ({ ...headers, cookie: 'upstream-session=private' }),
    recordCompatibility: () => {}, modernResponseNeedsLegacyFallback: () => false, remoteFailureKind: () => '',
    callUpstreamRemote: async (endpoint, args, rpcId) => {
      const r = await fetch(new URL('/api/' + endpoint, upstream), { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'upstream-session=private' }, body: JSON.stringify({ args, rpcId }) })
      return { status: r.status, body: await r.json() }
    },
  })
  vm.runInContext(source.slice(source.indexOf('function legacyEnvelope('), source.indexOf('function modernResponseNeedsLegacyFallback('))
    + source.slice(source.indexOf('async function translateModernRpc('), source.indexOf('/** 递归截断'))
    + source.slice(source.indexOf('function imageAdmissionRejected('), source.indexOf('function sendBufferedUpstreamResponse(')), ctx)
  const payload = { sessionId: 'chosen-session', requestId: 'same-request', mode: 'steer', content: [
    { type: 'image', mediaType: 'image/png', data: 'YWJjZA==', name: '图.png' },
    { type: 'text', text: '看看这两张图' },
    { type: 'image', mediaType: 'image/png', data: 'ZWZnaA==' },
  ] }
  async function send(modern) {
    if (modern) return ctx.translateModernRpc('session.prompt', payload, 'rpc1')
    const response = await ctx.forwardLegacyRpc(new URL('/api/session.prompt', upstream), JSON.stringify({ type: 'client-request', method: 'session.prompt', rpcId: 'rpc1', payload }))
    return JSON.parse(response.raw)
  }
  return { calls, send, payload }
}

for (const modern of [false, true]) {
  const protocol = modern ? 'modern' : 'legacy'
  test(`vision bridge ${protocol}: rejected images become references, mode and identity survive`, async t => {
    const f = await fixture(t)
    assert.equal((await f.send(modern)).result.value.accepted, true)
    const prompts = f.calls.filter(c => !c.url.includes('dsh-image-vision'))
    assert.equal(prompts.length, 2)
    const sent = prompts[1].body.args?.request || prompts[1].body.payload
    assert.equal(sent.sessionId, f.payload.sessionId)
    assert.equal(sent.requestId, f.payload.requestId)
    assert.equal(sent.mode, 'steer')
    assert.deepEqual(sent.content, [{ type: 'text', text: markdown }, f.payload.content[1], { type: 'text', text: markdown }])
    assert.equal(f.payload.content[0].type, 'image')
    assert.equal(f.calls.filter(c => c.url.endsWith('/attach')).length, 2)
    assert.ok(f.calls.every(c => c.cookie === 'upstream-session=private'))
  })
  for (const result of [accepted, { result: { ok: false, error: { code: 'session/agent-busy' } } }, { error: 'timeout' }]) {
    test(`vision bridge ${protocol}: no retry without explicit admission rejection ${JSON.stringify(result)}`, async t => {
      const f = await fixture(t, { result })
      await f.send(modern)
      assert.equal(f.calls.length, 1)
    })
  }
  for (const options of [{ enabled: false }, { missing: true }, { failSecond: true }]) {
    test(`vision bridge ${protocol}: failed preparation never submits partial content ${JSON.stringify(options)}`, async t => {
      const f = await fixture(t, options)
      assert.equal((await f.send(modern)).result.error.code, 'image-vision-failed')
      assert.equal(f.calls.filter(c => !c.url.includes('dsh-image-vision')).length, 1)
    })
  }
}
