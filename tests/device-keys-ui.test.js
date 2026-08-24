'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8')
const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')
const mobile = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')
const desktop = fs.readFileSync(path.join(ROOT, 'public', 'desktop', 'desktop.js'), 'utf8')
const plugin = fs.readFileSync(path.join(ROOT, 'packages', 'plugin', 'index.mjs'), 'utf8')

test('网关控制台提供独立设备密钥开关和要求的令牌行操作顺序', () => {
  assert.match(html, /id="device-key-enabled"[^>]*role="switch"/)
  assert.match(html, /id="device-key-panel"/)
  assert.match(html, /data-i18n="deviceKeys\.note">备注内容/)
  assert.match(html, /data-i18n="deviceKeys\.ip">IP/)
  assert.match(admin, /function renderDeviceKeys\(/)
  assert.match(admin, /function setDeviceKeyMode\(/)
  assert.match(admin, /function createDeviceKey\(/)
  assert.match(admin, /function rotateDeviceKey\(/)
  assert.match(admin, /function revokeDeviceKey\(/)

  const rowStart = admin.indexOf('class="device-key-actions"')
  const rowEnd = admin.indexOf('</div>', rowStart)
  const row = admin.slice(rowStart, rowEnd)
  assert.ok(row.indexOf('data-device-key-qr') < row.indexOf('data-device-key-rotate'))
  assert.ok(row.indexOf('data-device-key-rotate') < row.indexOf('data-device-key-copy'))
  assert.ok(row.indexOf('data-device-key-copy') < row.indexOf('data-device-key-revoke'))
})

test('插件抽屉代理设备密钥管理端点，网关不可用时显式声明不支持', () => {
  for (const action of ['mode', 'create', 'note', 'rotate', 'revoke']) {
    assert.match(plugin, new RegExp(`admin/api/device-keys/${action}`))
  }
  assert.match(plugin, /deviceKeys:\s*\{ supported: false, enabled: false, entries: \[\] \}/)
})

test('移动端和桌面端读取 health 能力并对旧网关保持兼容回退', () => {
  for (const source of [mobile, desktop]) {
    assert.match(source, /gatewayHealth:/)
    assert.match(source, /function activeGatewayCapability\(/)
    assert.match(source, /activeGatewayCapability\('wsTicket'\) === false/)
    assert.match(source, /ticket 接口不可用时临时回退旧 token 握手/)
  }
  assert.match(mobile, /activeGatewayCapability\('dshLifecycle'\) === false/)
})
