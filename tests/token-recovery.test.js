'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../gateway.js'), 'utf8')
const code = source.slice(source.indexOf('function loadToken()'), source.indexOf('const WS_TICKET_TTL_MS'))

test('令牌创建必须落盘，删除后恢复原值，已有文件不覆盖', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const TOKEN_FILE = path.join(dir, 'token')
  const api = vm.runInNewContext(code + '; ({ TOKEN, restoreMissingTokenFile })', {
    fs, path, crypto, TOKEN_FILE, process: { env: {} }, console: { warn() {}, error() {} },
  })
  assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), api.TOKEN)
  fs.unlinkSync(TOKEN_FILE)
  api.restoreMissingTokenFile()
  assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), api.TOKEN)
  if (process.platform !== 'win32') assert.equal(fs.statSync(TOKEN_FILE).mode & 0o777, 0o600)
  fs.writeFileSync(TOKEN_FILE, 'replacement')
  api.restoreMissingTokenFile()
  assert.equal(fs.readFileSync(TOKEN_FILE, 'utf8'), 'replacement')
})

test('读写失败或写后校验失败必须中止初始化，环境令牌不要求文件', () => {
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  for (const mock of [
    { readFileSync: denied },
    { readFileSync: missing, mkdirSync() {}, writeFileSync: denied },
    { readFileSync: () => '', mkdirSync() {}, writeFileSync() {} },
  ]) {
    assert.throws(() => vm.runInNewContext(code, {
      fs: mock, path, crypto, TOKEN_FILE: 'token', process: { env: {} },
    }), /无法读取令牌文件|无法持久化令牌文件/)
  }
  assert.equal(vm.runInNewContext(code + '; TOKEN', {
    process: { env: { TOKEN: 'fixed-token' } },
  }), 'fixed-token')
})

const panel = fs.readFileSync(path.join(__dirname, '../public/plugin.js'), 'utf8')
test('插件监听配置优先级兼容环境变量、文件与 IPv4 默认值', () => {
  const plugin = fs.readFileSync(path.join(__dirname, '../packages/plugin/index.mjs'), 'utf8')
  const hostCode = plugin.slice(plugin.indexOf('export function readGatewayHost()'), plugin.indexOf('function gatewayToken()')).replace('export ', '')
  for (const [env, file, expected] of [
    [{ DSH_REMOTE_GATEWAY_HOST: '::', HOST: '127.0.0.1' }, '0.0.0.0', '::'],
    [{ HOST: '::1' }, '0.0.0.0', '::1'],
    [{}, '::\n', '::'], [{}, '', '0.0.0.0'],
  ]) {
    assert.equal(vm.runInNewContext(hostCode + '; readGatewayHost()', {
      process: { env }, homedir: () => '/unused', readFileSync: () => file,
    }), expected)
  }
})

test('插件面板显示运行中认证异常，并报告 HTTP 200 中的操作失败', async () => {
  const elements = new Map()
  const $ = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {},
    })
    return elements.get(id)
  }
  const renderCode = panel.slice(panel.indexOf('function render(st)'), panel.indexOf('async function load()'))
  const toggleCode = panel.slice(panel.indexOf('async function toggleGateway()'), panel.indexOf('async function copyToken()'))
  const api = vm.runInNewContext('let latest; ' + renderCode + toggleCode + '; ({render, toggleGateway})', {
    $, text: (id, value) => { $(id).textContent = value }, Date,
    usageLoadedAt: Date.now(), renderUsage() {}, loadUsage() {}, busy: false, setBusy() {}, API: '/remote/admin/api',
    fetch: async (_url, options) => {
      assert.equal(JSON.parse(options.body).action, 'stop')
      return { ok: true, json: async () => ({ ok: false, error: '请手动重启网关' }) }
    },
  })
  api.render({ mode: 'plugin', gatewayRunning: true, gatewayAuthError: '请手动重启网关', gatewayVersion: '0.6.26' })
  assert.equal($('plugin-status').textContent, '网关需要关注')
  assert.equal($('plugin-status-desc').textContent, '请手动重启网关')
  assert.equal($('plugin-primary').dataset.action, 'console')
  assert.equal($('plugin-toggle-label').textContent, '停止网关')
  await api.toggleGateway()
  assert.match($('plugin-error').textContent, /请手动重启网关/)
})
