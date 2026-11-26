'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const { RelayHost } = require('../relay/host.cjs')

function relayHost(config, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2ee-plan-'))
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({
    enabled: true,
    expiresAt: Date.now() + 86400000,
    tunnelOrigin: 'https://relay.example.test',
    publicUrl: 'https://relay.example.test',
    quotaPeriod: 'month',
    ...config,
  }))
  return { root, host: new RelayHost({ root, gateway: 'http://127.0.0.1:1', origin: 'https://relay.example.test', e2eeEnabled: false, ...overrides }) }
}

test('basic monthly relay has no encrypted entry until a data pack is known', () => {
  const { root, host } = relayHost({})
  try {
    assert.equal(host.status().e2ee.allowed, false)
    assert.equal(host.status().e2ee.enabled, false)
    assert.equal(host.status().e2ee.configured, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('data-pack relay allows the encrypted entry but it stays off by default', () => {
  const { root, host } = relayHost({ dataPack: true, e2eeEnabled: false })
  try {
    assert.equal(host.status().e2ee.allowed, true)
    assert.equal(host.status().e2ee.enabled, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('non-monthly relay keeps the legacy encrypted capability', () => {
  const { root, host } = relayHost({ quotaPeriod: 'day', dailyLimitBytes: 5e9 })
  try {
    assert.equal(host.status().e2ee.allowed, true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('basic plan refuses enabling encryption through the local API', async () => {
  const { root, host } = relayHost({})
  try {
    await assert.rejects(host.changeDevice({ action: 'enable-encryption' }), error => error.code === 'E2EE_PLAN_REQUIRED')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('relay settings only mounts device management when the plan allows encryption', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/relay-settings.js'), 'utf8')
  assert.match(source, /const e2eeAllowed = !!value && value\?\.e2ee\?\.allowed !== false/)
  assert.match(source, /deviceTarget\.hidden = !e2eeAllowed/)
  assert.match(source, /if \(e2eeAllowed && !devices\)/)
  assert.match(source, /基础档不含端到端加密/)
  const devices = fs.readFileSync(path.join(ROOT, 'public/relay-devices.js'), 'utf8')
  assert.match(devices, /host\?\.e2ee\?\.allowed===false/)
})

test('E2EE transport UI is gated by host eligibility and defaults off', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/e2ee-transport.js'), 'utf8')
  assert.match(source, /const allowed = value\?\.e2ee\?\.allowed !== false && value\?\.e2ee\?\.enabled === true/)
  assert.match(source, /guide\.hidden = !allowed/)
  assert.match(source, /端到端加密（默认关闭）/)
  assert.match(source, /modeSwitch\.checked = !!state\.configured && state\.encrypted !== false/)
})
