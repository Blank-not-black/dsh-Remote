'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')

function loadSlashBridge(relative, endMarker) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const start = source.indexOf('async function runSlashCommand')
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, relative + ' should expose a bounded slash bridge')
  const calls = []
  const notices = []
  const context = {
    AbortSignal,
    CAP: null,
    console,
    state: { current: 'session-1', token: 'test-token' },
    apiUrl: value => value,
    clientIdHeaders: () => ({ 'x-client-id': 'test-client' }),
    authFailure() { notices.push('auth') },
    toast(message) { notices.push(message) },
    t: key => key,
    fetch: async (url, options) => {
      calls.push({ url, options })
      const line = JSON.parse(options.body).line
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, executed: line === '/status' }),
      }
    },
  }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)}\nthis.runSlashCommand = runSlashCommand`, context)
  return { calls, notices, run: context.runSlashCommand }
}

test('手机和桌面端仅在命令桥明确 executed 时拦截斜杠文本', async () => {
  const variants = [
    ['public/app.js', 'function bytesToBase64'],
    ['public/desktop/desktop.js', 'async function sendMessage'],
  ]
  for (const [relative, endMarker] of variants) {
    const bridge = loadSlashBridge(relative, endMarker)
    assert.equal(await bridge.run('/status'), true, relative)
    assert.equal(await bridge.run('/unknown keep-as-text'), false, relative)
    assert.equal(bridge.calls.length, 2, relative)
    assert.equal(bridge.calls[0].url, '/remote/api/command', relative)
    assert.deepEqual(JSON.parse(bridge.calls[0].options.body), { sessionId: 'session-1', line: '/status' }, relative)
  }
})

test('成功命令桥接在发送路径中先于 session.prompt 生效', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
  assert.match(mobile, /if \(images\.length === 0 && clean && await runSlashCommand\(clean\)\)/)
  assert.match(desktop, /if \(await runSlashCommand\(text\)\) \{ input\.value = ''; return \}/)
})
