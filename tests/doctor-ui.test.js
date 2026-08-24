const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

test('管理页提供首次连接向导和可复查 Doctor 清单', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')

  assert.match(html, /id="doctor-card"/)
  assert.match(html, /id="doctor-toggle"[^>]*aria-controls="doctor-body"/)
  assert.match(html, /id="doctor-copy-report"/)
  assert.match(html, /只在可信局域网或 Tailscale 中开放网关端口/)
  assert.match(script, /function buildDoctorChecks\(st\)/)
  for (const id of ['dsh', 'gateway', 'network', 'firewall', 'device', 'realtime']) {
    assert.match(script, new RegExp(`id: '${id}'`))
  }
  assert.match(script, /setInterval\(loadState, 5000\)/)
  assert.match(script, /New-NetFirewallRule[\s\S]*-RemoteAddress \$\{cidr\}[\s\S]*-Profile Private/)
  assert.match(script, /100\.64\.0\.0\/10/)
  assert.match(script, /ufw allow from \$\{cidr\}/)
  assert.doesNotMatch(script, /data-doctor-action="[^"']*token/)
})

test('Doctor 状态数据由网关与插件回退状态共同提供', () => {
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  const plugin = fs.readFileSync(path.join(ROOT, 'packages', 'plugin', 'index.mjs'), 'utf8')

  assert.match(gateway, /platform: process\.platform/)
  assert.match(gateway, /events: eventCollectorState/)
  assert.match(plugin, /platform: process\.platform/)
  assert.match(plugin, /lastError: '网关未运行'/)
})
