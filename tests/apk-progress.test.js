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
