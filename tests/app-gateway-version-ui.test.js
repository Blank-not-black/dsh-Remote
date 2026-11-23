'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')

test('App 与网关版本比较支持正式版和 rc 语义', () => {
  const start = app.indexOf('function parseVersion')
  const end = app.indexOf('function isAppVersionWarningOpen', start)
  const context = {}
  vm.createContext(context)
  vm.runInContext(`${app.slice(start, end)}\nthis.behind = isAppBehindGateway`, context)

  assert.equal(context.behind('0.6.12', '0.6.13'), true)
  assert.equal(context.behind('0.6.13-rc.1', '0.6.13'), true)
  assert.equal(context.behind('0.6.13', '0.6.13-rc.2'), false)
  assert.equal(context.behind('0.6.13', '0.6.13'), false)
  assert.equal(context.behind('', '0.6.13'), false)
  assert.equal(context.behind('unknown', '0.6.13'), false)
})

test('仅 App 环境读取当前网关 health 版本并按版本对去重提醒', () => {
  assert.match(app, /if \(!CAP\?\.isNativePlatform\?\.\(\) \|\| !state\.localVersion\) return false/)
  assert.match(app, /const gatewayVersion = String\(health\?\.version \|\| ''\)\.trim\(\)/)
  assert.match(app, /state\.warnedGatewayVersions\.has\(warningKey\)/)
  assert.match(app, /await maybeWarnAppBehindGateway\(\{ probe: true \}\)/)
  assert.match(app, /await maybeWarnAppBehindGateway\(\)/)
})

test('版本落后弹窗展示 App 和网关版本并提供稍后与更新入口', () => {
  assert.match(html, /id="modal-app-version-warning"[^>]*role="dialog"/)
  assert.match(html, /id="app-version-current"/)
  assert.match(html, /id="app-version-gateway"/)
  assert.match(html, /id="app-version-later"/)
  assert.match(html, /id="app-version-update"/)
  assert.match(app, /showSettingsPage\('about'\)/)
  assert.match(app, /void checkUpdate\(false\)/)
})

test('启动公告和自动更新检查不会覆盖版本落后提醒', () => {
  assert.match(app, /if \(isAppVersionWarningOpen\(\)\) return/)
  assert.match(app, /if \(!shown && state\.token && !isAppVersionWarningOpen\(\)\) checkUpdate\(true\)/)
  assert.match(app, /scheduleStartupNotices\(\)/)
})

test('侧栏显示当前客户端版本，并将手动检查定位到版本设置', async () => {
  const calls = []
  const elements = {
    'group-drawer-version': {},
    'update-desc': {},
    'settings-update-row': { scrollIntoView: options => calls.push(['scroll', options.block]) },
    'btn-check-update': { focus: options => calls.push(['focus', options.preventScroll]) },
  }
  const state = { localVersion: '' }
  const context = vm.createContext({
    state, $: id => elements[id], CAP: undefined, window: {},
    t: (key, values) => values?.version || key,
    fetch: async () => ({ ok: true, json: async () => ({ version: '0.8.9-rc.3' }) }),
    showView: id => calls.push(['view', id]),
    showSettingsPage: name => calls.push(['page', name]),
    checkUpdate: silent => calls.push(['check', silent]),
  })
  const open = app.indexOf('function openUpdateSettings()')
  const version = app.indexOf('async function loadLocalVersion()')
  vm.runInContext(app.slice(open, app.indexOf('function resetUpdateExpand', open)) +
    app.slice(version, app.indexOf('\n/*', version)), context)

  await context.loadLocalVersion()
  assert.equal(elements['group-drawer-version'].textContent, 'v0.8.9-rc.3')
  context.openUpdateSettings()
  assert.deepEqual(calls, [
    ['view', 'view-settings'], ['page', 'about'], ['scroll', 'start'], ['focus', true], ['check', false],
  ])
})
