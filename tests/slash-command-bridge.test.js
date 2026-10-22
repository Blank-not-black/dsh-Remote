'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')

function loadSlashBridge(relative, endMarker, fetcher) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const start = source.indexOf('async function runSlashCommand')
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, relative + ' should expose a bounded slash bridge')
  const calls = []
  const exports = []
  const compactions = []
  const notices = []
  const context = {
    AbortSignal,
    setTimeout,
    CAP: null,
    console: { error() {} },
    NO_FALLBACK_SLASH_COMMANDS: new Set(['compact', 'export']),
    SLASH_COMMAND_TIMEOUT_MS: 20_000,
    LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS: 125_000,
    slashCommandName: text => {
      const match = /^\/+([^\s/]+)/.exec(String(text || '').trim())
      return match ? match[1].toLowerCase() : ''
    },
    state: { current: 'session-1', token: 'test-token' },
    captureConnection: () => ({ valid: () => true }),
    apiUrl: value => value,
    clientIdHeaders: () => ({ 'x-client-id': 'test-client' }),
    authFailure() { notices.push('auth') },
    toast(message) { notices.push(message) },
    t: key => key,
    downloadSessionExport: async sessionId => { exports.push(sessionId) },
    setCompactionStatus: (sessionId, value) => { compactions.push({ sessionId, value }) },
    fetch: fetcher || (async (url, options) => {
      calls.push({ url, options })
      const line = JSON.parse(options.body).line
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, executed: line === '/status' || line === '/export' }),
      }
    }),
  }
  vm.createContext(context)
  vm.runInContext(`${source.slice(start, end)}\nthis.runSlashCommand = runSlashCommand`, context)
  return { calls, exports, compactions, notices, run: context.runSlashCommand }
}

test('手机和桌面端仅在命令桥明确 executed 时拦截斜杠文本', async () => {
  const variants = [
    ['public/app.js', 'function bytesToBase64'],
    ['public/desktop/desktop.js', 'async function sendMessage'],
  ]
  for (const [relative, endMarker] of variants) {
    const bridge = loadSlashBridge(relative, endMarker)
    assert.equal(await bridge.run('/status'), true, relative)
    assert.equal(await bridge.run('/export'), true, relative)
    assert.equal(await bridge.run('/unknown keep-as-text'), false, relative)
    assert.equal(bridge.calls.length, 3, relative)
    assert.equal(bridge.calls[0].url, '/remote/api/command', relative)
    assert.deepEqual(JSON.parse(bridge.calls[0].options.body), { sessionId: 'session-1', line: '/status', async: true }, relative)
    assert.deepEqual(bridge.exports, ['session-1'], relative)
  }
})

test('丢失桥接响应时不把可能已执行的命令作为普通消息重复发送', async () => {
  const variants = [
    ['public/app.js', 'function bytesToBase64'],
    ['public/desktop/desktop.js', 'async function sendMessage'],
  ]
  for (const [relative, endMarker] of variants) {
    const bridge = loadSlashBridge(relative, endMarker, async () => { throw new Error('timeout') })
    assert.equal(await bridge.run('/compact'), true, relative)
    assert.equal(await bridge.run('/export'), true, relative)
    assert.equal(await bridge.run('/unknown keep-as-text'), true, relative)
  }
})

test('/compact 接受后立即显示压缩状态，不等待摘要完成', async () => {
  const variants = [
    ['public/app.js', 'function bytesToBase64'],
    ['public/desktop/desktop.js', 'async function sendMessage'],
  ]
  for (const [relative, endMarker] of variants) {
    const bridge = loadSlashBridge(relative, endMarker, async () => ({
      status: 202,
      ok: true,
      json: async () => ({ ok: true, executed: true, accepted: true, compact: { active: true, phase: 'running', startedAt: 1000 } }),
    }))
    assert.equal(await bridge.run('/compact'), true, relative)
    assert.equal(bridge.compactions.length, 1, relative)
    assert.equal(bridge.compactions[0].sessionId, 'session-1', relative)
    assert.equal(bridge.compactions[0].value.active, true, relative)
    assert.equal(bridge.compactions[0].value.phase, 'running', relative)
    assert.equal(bridge.compactions[0].value.startedAt, 1000, relative)
    assert.equal(bridge.compactions[0].value.source, 'command', relative)
  }
})

test('长耗时命令使用延长的端到端超时', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
  const plugin = fs.readFileSync(path.join(ROOT, 'packages', 'plugin', 'index.mjs'), 'utf8')
  assert.match(mobile, /LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS = 125_000/)
  assert.match(desktop, /LONG_RUNNING_SLASH_COMMAND_TIMEOUT_MS = 125_000/)
  assert.match(plugin, /LONG_RUNNING_COMMAND_TIMEOUT_MS = 120_000/)
})

test('异步命令以相同 operation 的终态确认：拒执行可回退，失败或失联不重复，权限失败不关闭菜单', async () => {
  for (const [relative, endMarker] of [['public/app.js', 'function bytesToBase64'], ['public/desktop/desktop.js', 'async function sendMessage']]) {
    for (const [terminal, strict, expected] of [
      [{ active: false, phase: 'complete', executed: true }, true, true],
      [{ active: false, phase: 'failed', executed: false }, true, false],
      [{ active: false, phase: 'failed', executed: false }, false, false],
      [{ active: false, phase: 'failed', executed: true }, false, true],
      [null, true, false],
      [{ id: 'different-operation', active: false, phase: 'complete', executed: true }, true, false],
    ]) {
      const requests = []
      const bridge = loadSlashBridge(relative, endMarker, async (url, options) => {
        requests.push({ url, options })
        if (requests.length === 1) return { ok: true, status: 202, json: async () => ({ ok: true, executed: true, accepted: true, operation: { id: 'operation-1', active: true, phase: 'running', startedAt: 1 } }) }
        if (!terminal) throw new Error('status connection lost')
        return { ok: true, status: 200, json: async () => ({ ok: true, operation: { id: 'operation-1', startedAt: 1, ...terminal } }) }
      })
      assert.equal(await bridge.run(strict ? '/permission auto' : '/ordinary', strict), expected, relative + JSON.stringify(terminal))
      assert.equal(requests.length, 2)
      assert.match(requests[1].url, /command-status\?sessionId=session-1$/)
      assert.equal(bridge.notices.length, !strict && terminal?.executed !== false && terminal?.phase === 'failed' ? 1 : 0)
    }
  }
})

test('/export 在命令确认后走 DSH 会话 ZIP 路由', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
  assert.match(mobile, /apiUrl\('\/api\/session\.export'\)/)
  assert.match(mobile, /window\.NativeFile\.downloadToDownloads\(url\.href, filename, state\.token\)/)
  assert.match(desktop, /apiUrl\('\/api\/session\.export'\)/)
  assert.match(desktop, /anchor\.download = sessionLogFilename\(sessionId\)/)
})

test('成功命令桥接在发送路径中先于 session.prompt 生效', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
  assert.match(mobile, /if \(images\.length === 0 && clean && await runSlashCommand\(clean\)\)/)
  const send = desktop.slice(desktop.indexOf('async function sendMessage('), desktop.indexOf('async function cancelSession()'))
  assert.ok(send.indexOf('await runSlashCommand(text)') < send.indexOf("safeRpc('session.prompt'"))
  assert.match(send, /if \(!valid\(\)\) return/)
})
