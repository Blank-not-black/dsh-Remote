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
    Blob, URL, AbortController, AbortSignal, Uint8Array, setTimeout, clearTimeout,
    captureConnection: () => ({ valid: () => true }),
    setInterval: () => 1, clearInterval: () => {},
    performance: { now: () => time },
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { classList: { add() {}, remove() {}, toggle() {} }, removeAttribute(key) { delete this[key] } })
      return nodes.get(id)
    },
    t: (key, args) => args?.msg || key,
    sha256Hex: async b => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'),
    ...extra,
  }
  vm.createContext(context)
  vm.runInContext(source.slice(source.indexOf('let activeUpdateCheck'), source.indexOf('async function sha256Hex')), context)
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

test('same-version patch download fetches fresh metadata once and sends its new hash and cache-busting URL to native',async()=>{
 let resolve,calls=0;const installs=[]
 const {context:c,nodes}=harness({state:{localVersion:'0.8.0-rc.2',updateInfo:null},updateBase:()=>'http://host:8787',CAP:{isNativePlatform:()=>true},
  fetch:async(url,options)=>{calls++;assert.match(url,/\/update.json\?t=\d+&local=0.8.0-rc.2/);assert.equal(options.cache,'no-store');return new Promise(r=>{resolve=r})},
  window:{NativeUpdate:{downloadVerifiedAndInstall:(url,hash)=>{installs.push({url,hash});return true},getDownloadStatus:()=>JSON.stringify({phase:'complete',received:100,total:100})}}})
 const first=c.downloadUpdate(true);await c.downloadUpdate(true);assert.equal(calls,1);assert.equal(nodes.get('btn-force-download-update').disabled,true)
 resolve({ok:true,json:async()=>({version:'0.8.0-rc.2',sha256:'b'.repeat(64),apkUrl:'dsh-remote.apk'})});await first
 assert.equal(installs.length,1);assert.equal(installs[0].hash,'b'.repeat(64));assert.match(installs[0].url,/dsh-remote.apk\?dshPatch=.+-bbbbbbbbbbbbbbbb/)
 assert.equal(nodes.get('btn-download-update').disabled,false);assert.equal(nodes.get('btn-force-download-update').disabled,false)
})

test('patch metadata failure, missing hash and a changed connection never install and always unlock download controls',async()=>{
 for(const mode of ['failure','missing-hash','changed-host']){
  let valid=true,installs=0
  const {context:c,nodes}=harness({state:{localVersion:'0.8.0-rc.2',updateInfo:{sha256:'a'.repeat(64)}},updateBase:()=>'http://host:8787',captureConnection:()=>({valid:()=>valid}),CAP:{isNativePlatform:()=>true},
   fetch:async()=>{if(mode==='failure')throw Error('offline');if(mode==='changed-host')valid=false;return {ok:true,json:async()=>({version:'0.8.0-rc.2',...(mode==='missing-hash'?{}:{sha256:'b'.repeat(64)})})}},
   window:{NativeUpdate:{downloadVerifiedAndInstall:()=>{installs++;return true},getDownloadStatus:()=>''}}})
  await c.downloadUpdate(true);assert.equal(installs,0,mode);assert.equal(nodes.get('btn-force-download-update').disabled,false,mode)
 }
})

test('browser patch download ignores stale version metadata, verifies fresh bytes, and never saves a corrupt package',async()=>{
 const bytes=Buffer.from('same-version patch'),hash=crypto.createHash('sha256').update(bytes).digest('hex')
 for(const corrupt of [false,true]){
  const calls=[],saved=[]
  class TestURL extends URL {static createObjectURL(){return 'blob:test'}static revokeObjectURL(){}}
  const {context:c}=harness({URL:TestURL,setTimeout:()=>1,clearTimeout(){},state:{localVersion:'0.8.0-rc.2',updateInfo:null},updateBase:()=>'http://host:8787',CAP:null,window:{},
   fetch:async(url,options)=>{calls.push({url,options});if(url.includes('/update.json'))return {ok:true,json:async()=>({version:'0.8.0-rc.2',sha256:hash})};return new Response(corrupt?'corrupt':bytes)},
   document:{body:{appendChild(){}},createElement:()=>({click(){saved.push(this.download)},remove(){}})}})
  await c.downloadUpdate(true)
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.options.cache==='no-store'));assert.match(calls[1].url,/dshPatch=/)
  assert.deepEqual(saved,corrupt?[]:['dsh-remote.apk'])
 }
})

test('Android checks and downloads the official release when the host is missing, unavailable, or still on the installed version', async () => {
  for (const scenario of ['missing', '503', 'older-host', 'malformed']) {
    const hash = 'a'.repeat(64), calls = []
    const state = { localVersion: '0.8.6', updateInfo: null }
    const { context: c, nodes } = harness({
      state, updateBase: () => scenario === 'missing' ? '' : 'https://relay.invalid',
      CAP: { isNativePlatform: () => true },
      cmpVersion: (a, b) => a.localeCompare(b, 'en', { numeric: true }),
      toast() {}, resetUpdateExpand() {}, openNotesModal() {}, renderUpdateExpandBtn() {},
      fetch: async (_url, options) => {
        assert.ok(options.signal)
        calls.push('host check')
        if (scenario === '503') return new Response(null, { status: 503 })
        if (scenario === 'malformed') return new Response('not JSON')
        return Response.json({ version: '0.8.6' })
      },
      window: { NativeUpdate: {
        checkOfficialRelease() { calls.push('official check') },
        getOfficialReleaseStatus: () => JSON.stringify({ phase: 'complete', version: '0.8.7', sha256: hash }),
        downloadVerifiedAndInstall() { assert.fail('No request to the host APK') },
        downloadOfficialRelease(version, sha256) {
          calls.push('official download')
          assert.equal(version, '0.8.7')
          assert.equal(sha256, hash)
          return true
        },
        getDownloadStatus: () => JSON.stringify({ phase: 'installer', received: 100, total: 100 }),
      } },
    })
    await c.checkUpdate(false)
    assert.equal(state.updateInfo.source, 'official')
    await c.downloadUpdate()
    assert.deepEqual(calls, [...(scenario === 'missing' ? [] : ['host check']), 'official check', 'official download'])
    assert.equal(nodes.get('update-download-status').textContent, 'update.phase.installer')
    assert.equal(nodes.get('btn-download-update').disabled, false)
  }
})

test('host APK transport failure tries the matching official release once and preserves the selected checksum', async () => {
  const hash = 'b'.repeat(64)
  const calls = []
  let poll, value
  const { context: c, nodes } = harness({
    state: { localVersion: '0.8.6', updateInfo: { version: '0.8.7', sha256: hash } },
    updateBase: () => 'https://relay.invalid',
    CAP: { isNativePlatform: () => true },
    setInterval(fn) { poll = fn; return 1 },
    window: { NativeUpdate: {
      downloadVerifiedAndInstall(url, sha256) {
        calls.push([url, sha256])
        value = { phase: 'error', code: 'unavailable', error: 'HTTP 503' }
        return true
      },
      downloadOfficialRelease(version, sha256) {
        calls.push([version, sha256])
        value = { phase: 'error', code: 'unavailable', error: 'HTTP 503' }
        return true
      },
      getDownloadStatus: () => JSON.stringify(value),
    } },
  })
  await c.downloadUpdate()
  assert.equal(nodes.get('update-download-status').textContent, 'update.phase.official')
  poll()
  assert.deepEqual(calls, [['https://relay.invalid/dsh-remote.apk', hash], ['0.8.7', hash]])
  assert.equal(nodes.get('btn-download-update').disabled, false)
})

test('Android does not substitute official APKs for verification failures, installer errors, RCs or same-version patches', async () => {
  for (const [version, code, force, expected] of [
    ['0.8.7', 'verify', false, 'update.corrupted'],
    ['0.8.7', 'installer', false, 'update.installerFailed'],
    ['0.8.7-rc.1', 'unavailable', false, 'HTTP 503'],
    ['0.8.7', 'unavailable', true, 'HTTP 503'],
  ]) {
    const info = { version, sha256: 'a'.repeat(64) }
    const { context: c, nodes } = harness({
      state: { localVersion: '0.8.7', updateInfo: info }, updateBase: () => 'https://relay.invalid',
      CAP: { isNativePlatform: () => true },
      fetch: async () => Response.json(info),
      window: { NativeUpdate: {
        downloadVerifiedAndInstall: () => true,
        downloadOfficialRelease() { assert.fail('Selected package must not be substituted') },
        getDownloadStatus: () => JSON.stringify({ phase: 'error', code, error: 'HTTP 503' }),
      } },
    })
    await c.downloadUpdate(force)
    assert.equal(nodes.get('update-download-status').textContent, expected)
    assert.equal(nodes.get('btn-download-update').disabled, false)
  }
})
