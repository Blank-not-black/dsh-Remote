'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

for (const client of [
  { html: 'public/index.html', js: 'public/app.js', css: 'public/styles.css', prefix: '' },
  { html: 'public/desktop/desktop.html', js: 'public/desktop/desktop.js', css: 'public/desktop/desktop.css', prefix: 'ds-' },
]) {
  test(`${client.html} 的反馈必须由用户选择才上传兼容性诊断`, () => {
    const html = fs.readFileSync(path.join(ROOT, client.html), 'utf8')
    const js = fs.readFileSync(path.join(ROOT, client.js), 'utf8')
    const css = fs.readFileSync(path.join(ROOT, client.css), 'utf8')
    assert.match(html, /id="fb-include-diagnostics" type="checkbox"/)
    assert.match(html, /diagnosticsPrivacy/i)
    assert.match(js, /fb-include-diagnostics'\)\.checked = false/)
    assert.match(js, /const includeDiagnostics = \$\('fb-include-diagnostics'\)\.checked/)
    assert.match(js, /includeDiagnostics/)
    assert.match(css, new RegExp(`\\.${client.prefix}fb-diagnostics`))
  })
}

test('网关诊断只暴露脱敏的协议证据，并将用户同意传给收集器', () => {
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  assert.match(gateway, /function compatibilityDiagnostics\(\)/)
  assert.match(gateway, /function serveDiagnostics\(/)
  assert.match(gateway, /payload\.includeDiagnostics === true/)
  assert.match(gateway, /diagnostics: compatibilityDiagnostics\(\)/)
  assert.match(gateway, /Bearer \[redacted\]/)
  assert.match(gateway, /compatibilityAdapter: 2/)
})

test('新版 Remote 的活动与错误契约会被转换成跨端可消费的增量状态', () => {
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  assert.match(gateway, /value\.event === 'api-session\/activity'/)
  assert.match(gateway, /type: 'host\/session-activity'/)
  assert.match(gateway, /function remoteFailureKind\(/)
  assert.match(gateway, /generated-rpc-error/)
  assert.match(gateway, /legacy-rpc-error/)
  for (const client of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, client), 'utf8')
    assert.match(source, /f\.type === 'host\/session-activity'/)
    assert.match(source, /session\.updatedAt = Number\(f\.updatedAt\)/)
  }
})
