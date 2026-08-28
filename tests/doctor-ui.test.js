const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

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

test('管理页将主机 IP 做成可持久选择的地址表', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')
  assert.match(html, /id="host-ip-card"/)
  assert.match(html, /id="host-ip-rows"/)
  assert.match(html, /id="btn-host-ip-add"/)
  assert.match(html, /data-i18n="hostIPs\.addressColumn">主机 IP/)
  assert.match(script, /const HOST_IP_SELECTION_KEY = 'dshAdminEnabledHostIPsV1'/)
  assert.match(script, /function enabledHostIPs\(st\)/)
  assert.match(script, /function saveEnabledHostIPs\(st, selected\)/)
  assert.match(script, /const MANUAL_HOST_IP_KEY = 'dshAdminManualHostIPsV1'/)
  assert.match(script, /function saveManualHostIPs\(st, values\)/)
  assert.match(html, /至少保留一个可用地址/)
  assert.match(script, /pairTarget\(st, accessToken\)[\s\S]{0,180}enabledHostIPs\(st\)/)
})

test('插件管理页保留反向代理 Basic Auth，不用 Bearer 覆盖 Authorization', () => {
  const script = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')
  assert.match(script, /function adminHeaders\(extra = \{\}, accessToken = token\)/)
  assert.match(script, /if \(!pluginMode && accessToken\) headers\.authorization/)
  assert.match(script, /credentials: 'same-origin'/)
  assert.match(script, /AUTH_LAYER/)
  const start = script.indexOf('function adminHeaders')
  const end = script.indexOf('let timer', start)
  for (const pluginMode of [true, false]) {
    const context = { pluginMode, token: 'remote-token' }
    vm.createContext(context)
    vm.runInContext(`${script.slice(start, end)}\nthis.headers = adminHeaders({ accept: 'application/json' })`, context)
    assert.equal(context.headers.accept, 'application/json')
    assert.equal(context.headers.authorization, pluginMode ? undefined : 'Bearer remote-token')
  }
})

test('Doctor 状态数据由网关与插件回退状态共同提供', () => {
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  const plugin = fs.readFileSync(path.join(ROOT, 'packages', 'plugin', 'index.mjs'), 'utf8')

  assert.match(gateway, /platform: process\.platform/)
  assert.match(gateway, /events: eventCollectorState/)
  assert.match(gateway, /dshControl: DSH_CONTROL_SUPPORT/)
  assert.match(gateway, /dshLifecycle: DSH_CONTROL_SUPPORT\.supported \? 2 : 0/)
  assert.match(gateway, /DSH_REMOTE_DSH_CONTROL_MODE/)
  assert.match(plugin, /platform: process\.platform/)
  assert.match(plugin, /DSH_REMOTE_ADVERTISE_HOSTS/)
  assert.match(plugin, /lastError: '网关未运行'/)
})
