'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { Writable } = require('node:stream')
const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')
const code = source.slice(source.indexOf('function fsCommitUpload('), source.indexOf('\nfunction fsUploadRaw('))
function load(fileSystem, reply = () => {}) {
  return vm.runInNewContext(code + '; ({ fsCommitUpload, fsUploadPipeFromTarget })', {
    fs: fileSystem, fsJson: reply, FS_MAX_UPLOAD: 1024,
  })
}
test('文件提交失败保留原件；无覆盖授权不能替换并发提交的文件', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upload-safety-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'target'), part = path.join(dir, 'part')
  fs.writeFileSync(target, 'original'); fs.writeFileSync(part, 'new')
  const failing = load({ ...fs, renameSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } })
  assert.throws(() => failing.fsCommitUpload(part, target, true), { code: 'EACCES' })
  assert.equal(fs.readFileSync(target, 'utf8'), 'original')
  assert.equal(fs.readFileSync(part, 'utf8'), 'new')
  const { fsCommitUpload } = load(fs)
  assert.throws(() => fsCommitUpload(part, target, false), { code: 'EEXIST' })
  assert.equal(fs.readFileSync(target, 'utf8'), 'original')
  fsCommitUpload(part, target, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'new')
  const next = path.join(dir, 'next')
  fs.writeFileSync(part, 'exclusive'); fsCommitUpload(part, next, false)
  assert.equal(fs.readFileSync(next, 'utf8'), 'exclusive')
  assert.equal(fs.existsSync(part), false)
})
test('请求结束后才发生的写盘失败仍响应错误，不提交目标', async () => {
  let commits = 0
  const response = new Promise(resolve => {
    const { fsUploadPipeFromTarget } = load({
      renameSync() { commits++ }, linkSync() { commits++ }, unlinkSync() {},
    }, (_, status, body) => resolve({ status, body }))
    const stream = new Writable({ write(chunk, encoding, cb) {
      setImmediate(() => cb(Object.assign(new Error('disk full'), { code: 'ENOSPC' })))
    } })
    const pipe = fsUploadPipeFromTarget({ headersSent: false }, { stream, tmp: 'part', target: 'target', bytes: 0 })
    pipe.write(Buffer.from('new')); pipe.end()
  })
  const result = await response
  assert.equal(result.status, 500)
  assert.equal(result.body.error, 'write-failed')
  assert.equal(commits, 0)
})
