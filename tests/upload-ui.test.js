'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm'), crypto = require('node:crypto')
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8')
function fixture({ bytes = 'abcdef', probe, upload, confirm = () => true } = {}) {
  const file = new Blob([bytes]); file.name = '测试 文件.txt'
  const calls = [], notices = []; let valid = true
  const up = { session: 'ui-upload', path: '/fixture', name: file.name, size: file.size, offset: 0, file }
  class XHR {
    constructor() { this.upload = {} }
    open(_, url) { this.params = Object.fromEntries(new URL(url).searchParams) }
    setRequestHeader() {}
    abort() { this.onabort?.() }
    send(blob) {
      calls.push(this.params)
      Promise.resolve(upload?.(this.params, blob, calls.length) || { status: 201, json: { sha256: this.params.sha256 } })
        .then(r => { this.status = r.status; this.responseText = JSON.stringify(r.json); this.onload() })
    }
  }
  const context = vm.createContext({ Blob, Uint8Array, XMLHttpRequest: XHR, Date, Error, AbortController, AbortSignal, setTimeout, clearTimeout,
    window: { DshNetwork: require('../public/network.js') }, CAP: null, CLIENT_ID: '',
    state: { token: 'fixture', fs: { upload: up } }, captureConnection: () => ({ valid: () => valid }),
    fetch: async () => ({ status: 200, ok: true, json: async () => probe ? probe() : { ok: true, partialSize: 0 } }),
    fsApiUrl: (_, p) => 'http://fixture/?' + new URLSearchParams(p), fsHeaders: () => ({}),
    confirm, t: k => k, toast: (...args) => notices.push(args), setFsButtons() {}, showFsProgress() {}, hideFsProgress() {}, setFsProgressText() {}, loadFs() {}, fsAuthError() {},
  })
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../public/sha256.js'), 'utf8'), context)
  vm.runInContext(source.slice(source.indexOf('async function cancelFsUpload()'), source.indexOf('\nfunction fsUp()')), context)
  return { context, up, calls, notices, run: () => context.runFsUpload(up), invalidate: () => { valid = false; context.state.fs.upload = null } }
}
test('空文件收尾时遇到覆盖冲突，只确认一次并带覆盖授权重试', async () => {
  let confirms = 0
  const h = fixture({ bytes: '', confirm: () => ++confirms < 4, upload: p => p.overwrite ? { status: 201, json: {} } : { status: 409, json: { error: 'conflict' } } })
  await h.run()
  assert.equal(h.calls.length, 2)
  assert.equal(confirms, 1)
  assert.equal(h.calls[1].overwrite, '1')
})
test('续传偏移被服务器纠正后，重新计算实际前缀的哈希', async () => {
  let probes = 0
  const h = fixture({ probe: () => ({ ok: true, partialSize: probes++ ? 3 : 0 }), upload: (p, _, n) => n === 1 ? { status: 409, json: { error: 'offset-mismatch' } } : { status: 201, json: { sha256: p.sha256 } } })
  await h.run()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].offset, '3')
  assert.equal(h.calls[1].sha256, crypto.createHash('sha256').update('abcdef').digest('hex'))
})
test('等待续传探测时切换主机，迟到结果不能继续上传', async () => {
  let release, started
  const ready = new Promise(r => { started = r })
  const h = fixture({ probe: () => { started(); return new Promise(r => { release = r }) } })
  const pending = h.run(); await ready; h.invalidate(); release({ ok: true, partialSize: 0 }); await pending
  assert.equal(h.calls.length, 0)
})
test('探测响应的偏移越界时保留任务并提示，不能跳过校验提交', async () => {
  const h = fixture({ probe: () => ({ ok: true, partialSize: 7 }) })
  await h.run()
  assert.equal(h.calls.length, 0)
  assert.equal(h.up.active, false)
  assert.equal(h.up.paused, true)
  assert.equal(h.notices.at(-1)[1], 'err')
})
test('探测响应体一直不返回时，有界结束并允许用户继续', async () => {
  const h = fixture({ probe: () => new Promise(() => {}) })
  const network = require('../public/network.js')
  h.context.window.DshNetwork = { profile: network.profile, readWithDeadline: (read, _, signal) => network.readWithDeadline(read, 10, signal) }
  await h.run()
  assert.equal(h.calls.length, 0)
  assert.equal(h.up.active, false)
  assert.equal(h.up.paused, true)
  assert.equal(h.notices.at(-1)[1], 'err')
})
test('探测完成前连续点击继续，只启动一个上传任务', async () => {
  let release, started
  const ready = new Promise(r => { started = r })
  const h = fixture({ probe: () => { started(); return new Promise(r => { release = r }) } })
  const first = h.run(); await ready; await h.run(); release({ ok: true, partialSize: 0 }); await first
  assert.equal(h.calls.length, 1)
})
test('服务器持续返回偏移冲突时有界暂停，不能无限重试', async () => {
  const h = fixture({ upload: () => ({ status: 409, json: { error: 'offset-mismatch' } }) })
  await h.run()
  assert.equal(h.calls.length, 4)
  assert.equal(h.up.paused, true)
  assert.equal(h.up.active, false)
})
test('旧取消请求迟到时不能清空用户新建的上传任务', async () => {
  const h = fixture(); let release
  h.context.fetch = () => new Promise(r => { release = r })
  const pending = h.context.cancelFsUpload()
  const next = { session: 'next-upload' }
  h.context.state.fs.upload = next; release({ ok: true }); await pending
  assert.equal(h.context.state.fs.upload, next)
})
