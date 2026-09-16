'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../packages/plugin/index.mjs'), 'utf8')
const healthCode = source.slice(source.indexOf('async function gatewayRunning('), source.indexOf('\nfunction gatewayPidFile('))
const stopCode = source.slice(source.indexOf('async function killGateway('), source.indexOf('\n/** 用户意图持久化'))
function load(fetch) {
  return vm.runInNewContext(healthCode + stopCode + '; ({ gatewayRunning, killGateway })', {
    fetch, AbortSignal, gatewayBase: () => 'http://127.0.0.1:1234', gatewayToken: () => 'test-token',
    logGateway() {}, sleep: async () => {},
    process: { kill() { assert.fail('must not kill a PID') } },
    runExit() { assert.fail('must not invoke taskkill') },
  })
}
test('其他服务和非法 PID 不能成为自动停止目标', async () => {
  for (const body of [{}, { pid: 1234 }, { service: 'dsh-remote', pid: -1, version: '1', upstream: 'http://localhost', events: { mux: {}, host: {} } }]) {
    const api = load(async () => ({ ok: true, json: async () => body }))
    assert.equal((await api.gatewayRunning()).running, false)
  }
  const api = load(() => assert.fail('invalid PID must not make a shutdown request'))
  for (const pid of [-1, 0, 1, 1.5, NaN]) assert.equal(await api.killGateway({ running: true, pid }), false)
  assert.equal(await api.killGateway(), false) // 过期 PID 文件不再作为回退
})
test('仅认证关闭成功才允许重启；拒绝认证或错误响应均停止处理', async () => {
  for (const [status, body, expected] of [[200, { ok: true, bye: true }, true], [401, {}, false], [200, { ok: true }, false]]) {
    const api = load(async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:4321/admin/api/shutdown')
      assert.equal(opts.headers.authorization, 'Bearer test-token')
      return { ok: status === 200, json: async () => body }
    })
    assert.equal(await api.killGateway({ running: true, pid: 1234, base: 'http://127.0.0.1:4321' }), expected)
  }
})
