'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')

function harness(extra = {}) {
  let time = 0
  const nodes = new Map()
  const context = {
    Blob, URL, AbortController, Uint8Array, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    performance: { now: () => time },
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { classList: { remove() {} }, removeAttribute(key) { delete this[key] } })
      return nodes.get(id)
    },
    t: (key, args) => args?.msg || key,
    sha256Hex: async b => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'),
    ...extra,
  }
  vm.createContext(context)
  vm.runInContext(source.slice(source.indexOf('let updateDownloadBusy'), source.indexOf('/* ---------------- 通知 ---------------- */')), context)
  return { context, nodes, tick: n => { time = n } }
}

test('APK progress displays percentage and measured speed, handles unknown size and stalls', () => {
  const { context: c, nodes, tick } = harness()
  c.updateDownloadProgress({ received: 0, total: 4096 })
  tick(1000)
  c.updateDownloadProgress({ received: 2048, total: 4096 })
  assert.equal(nodes.get('update-download-bar').value, 50)
  assert.match(nodes.get('update-download-detail').textContent, /50%.*2.0 KB\/s/)
  tick(2000)
  c.updateDownloadProgress({ received: 2048, total: 4096 })
  assert.match(nodes.get('update-download-detail').textContent, /0.0 KB\/s/)
  c.updateDownloadProgress({ received: 2048, total: 0 })
  assert.equal(nodes.get('update-download-bar').value, undefined)
})

test('Browser downloads APK once, retains verified bytes and rejects corrupt/truncated content', async () => {
  const bytes = Buffer.from('sample apk content')
  const hash = crypto.createHash('sha256').update(bytes).digest('hex')
  let calls = 0, declared = bytes.length
  const { context: c } = harness({ fetch: async () => {
    calls++
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close()
    } }), { headers: { 'content-length': String(declared) } })
  } })
  const result = await c.verifyUpdateApk({ sha256: hash }, 'http://localhost/update.apk')
  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes)
  assert.equal((await c.verifyUpdateApk({ sha256: '0'.repeat(64) }, 'http://localhost/update.apk')).corrupted, true)
  declared++
  assert.equal((await c.verifyUpdateApk({}, 'http://localhost/update.apk')).corrupted, true)
})

test('Native update uses progress bridge without JS predownload and prevents duplicate clicks', async () => {
  let calls = 0
  const { context: c, nodes } = harness({
    state: { updateInfo: { sha256: 'a'.repeat(64) } }, updateBase: () => 'http://localhost:8787',
    CAP: { isNativePlatform: () => true },
    fetch: () => { throw new Error('must not predownload') },
    window: { NativeUpdate: {
      downloadVerifiedAndInstall: (url, hash) => { calls++; assert.equal(hash, 'a'.repeat(64)); return true },
      getDownloadStatus: () => JSON.stringify({ phase: 'downloading', received: 50, total: 100 }),
    } },
  })
  await c.downloadUpdate(); await c.downloadUpdate()
  assert.equal(calls, 1)
  assert.equal(nodes.get('update-download-bar').value, 50)
  assert.equal(nodes.get('btn-download-update').disabled, true)
  c.finishUpdateDownload()
  assert.equal(nodes.get('btn-download-update').disabled, false)
})
