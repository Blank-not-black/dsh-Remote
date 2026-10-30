'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const modulePromise = import('../packages/plugin/plugin-center.mjs')
const old = '2020-01-01T00:00:00.000Z'
const fetchBackups = new WeakSet()
function mockFetch(t, handler) {
  if (!fetchBackups.has(t)) {
    fetchBackups.add(t)
    const previous = global.fetch
    t.after(() => { global.fetch = previous })
  }
  global.fetch = handler
}
function response(raw, chunkSize = 4093, onCancel = () => {}) {
  const bytes = Buffer.from(raw); let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.subarray(offset, offset += chunkSize))
    }, cancel: onCancel,
  }))
}
test('publication lookup streams a >8 MiB packument, retains real times and caches it', async t => {
  const { publicationTimes } = await modulePromise
  const name = '@fixture/large-publication', time = { '1.0.0': old, '2.0.0': new Date().toISOString() }
  // Braces, escaped quotes, UTF-8 and nested time decoys must not affect projection.
  const raw = JSON.stringify({ readme: '文档}\\"'.repeat(1100000), versions: { '1.0.0': { time: { '1.0.0': 'fake' } } }, name, time, tail: [null, false, -1.5e22] })
  assert.ok(Buffer.byteLength(raw) > 8 * 1024 * 1024)
  let calls = 0
  mockFetch(t, async (url, options) => {
    calls++; assert.equal(url, 'https://registry.npmjs.org/' + encodeURIComponent(name))
    assert.equal(options.headers.accept, 'application/json'); assert.equal(options.redirect, 'error')
    return response(raw)
  })
  const times = await publicationTimes(name)
  assert.deepEqual({ ...times }, time)
  assert.equal(await publicationTimes(name), times); assert.equal(calls, 1)
})
test('publication parser validates fragmented JSON, rejects malformed metadata and never caches failure', async t => {
  const { publicationTimes } = await modulePromise
  const name = 'fixture-invalid-publication'
  const valid = JSON.stringify({ name, time: { '1.0.0': old } })
  const invalid = [
    valid.slice(0, -1), valid + 'null', valid.replace('}}', '},}'),
    valid.replace('"time":', '"name":"other","time":'),
    JSON.stringify({ name: 'wrong', time: { '1.0.0': old } }),
    JSON.stringify({ name, time: { '1.0.0': 1 } }), JSON.stringify({ name, time: [] }),
    '{"name":"' + name + '","ignored":"\\x","time":{}}',
    '{"name":"' + name + '","ignored":[true,],"time":{}}',
    '{"name":"' + name + '","ignored":01,"time":{}}',
    '{"name":"' + name + '","ignored":{"a":},"time":{}}',
    JSON.stringify({ name, modified: old }),
  ]
  for (const raw of invalid) {
    mockFetch(t, async () => response(raw, 1))
    await assert.rejects(publicationTimes(name), error => error.status === 502 && error.message.includes(name))
  }
  mockFetch(t, async () => response(valid.replace('time', 't\\u0069me'), 1))
  assert.equal((await publicationTimes(name))['1.0.0'], old)
})
test('publication limits cancel the stream and report the offending package and actual bytes', async t => {
  const { publicationTimes } = await modulePromise
  const name = 'fixture-oversized-publication', chunk = Buffer.alloc(1024 * 1024, 32)
  let cancelled = false, count = 0
  mockFetch(t, async () => new Response(new ReadableStream({
    pull(controller) { count++; controller.enqueue(chunk) }, cancel() { cancelled = true },
  })))
  await assert.rejects(publicationTimes(name), error => error.status === 502 && error.message.includes(name) && /68157440 bytes; limit 67108864/.test(error.message))
  assert.equal(cancelled, true); assert.ok(count <= 66)
})
test('publication fields have their own memory limit even when the response is below 64 MiB', async t => {
  const { publicationTimes } = await modulePromise
  const name = 'fixture-large-time', raw = JSON.stringify({ name, time: { '1.0.0': 'x'.repeat(1024 * 1024) } })
  mockFetch(t, async () => response(raw))
  await assert.rejects(publicationTimes(name), /publication fields exceed/)
})
test('HTTP failure, invalid UTF-8 and abort are actionable and do not leak arbitrary network messages', async t => {
  const { publicationTimes } = await modulePromise
  const name = 'fixture-network-publication'
  mockFetch(t, async () => new Response('', { status: 503 }))
  await assert.rejects(publicationTimes(name), /fixture-network-publication: HTTP 503/)
  mockFetch(t, async () => new Response(Uint8Array.of(255)))
  await assert.rejects(publicationTimes(name), /response failed or invalid/)
  mockFetch(t, async (url, { signal }) => { signal.throwIfAborted(); throw Error('secret-network-info') })
  await assert.rejects(publicationTimes(name, AbortSignal.abort()), /超时或已取消/)
  await assert.rejects(publicationTimes(name), error => !error.message.includes('secret-network-info'))
})
test('real preflight accepts a large document, preserves release-age blockers and fails closed for missing versions', async t => {
  const { createPluginCenter } = await modulePromise
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-large-preflight-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const name = 'fixture-preflight-plugin', dir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: '1.0.0' }, dsh: { profile: { bundles: [name] } } }))
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'packages:\n  ' + name + '@1.0.0: {}\n')
  const raw = JSON.stringify({ name, versions: { '1.0.0': { readme: 'x'.repeat(9 * 1024 * 1024) } }, time: { '1.0.0': old, '2.0.0': new Date().toISOString() } })
  mockFetch(t, async () => response(raw))
  const center = createPluginCenter({}, { profile: { dir, home, name: 'web', cli: path.join(home, 'cli.cjs') }, details: async () => ({ bundle: true }) })
  const body = { action: 'update', name, version: '2.0.0', revision: (await center.inventory()).revision }
  const { plan } = await center.preflight(body)
  assert.equal(plan.minutes, 1440)
  assert.deepEqual(plan.blockers.map(row => row.version), ['2.0.0'])
  await assert.rejects(center.preflight({ ...body, version: '3.0.0' }), /无法核实.*3\.0\.0/)
  assert.equal(fs.existsSync(path.join(dir, '.remote-plugin-center', 'lock.json')), false)
  assert.equal(fs.readdirSync(path.join(dir, '.remote-plugin-center')).some(file => file.startsWith('job-')), false)
})
