'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

test('前端实时流遵守 DSH downlink-only 协议', () => {
  for (const file of [
    path.join(ROOT, 'public/app.js'),
    path.join(ROOT, 'public/desktop/desktop.js')
  ]) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /\.send\(\s*['"]ping['"]\s*\)/, file)
    assert.doesNotMatch(source, /_staleTimer/, file)
    assert.match(source, /streamIsCurrent/, file)
    assert.match(source, /generation/, file)
    assert.match(source, /api\/ws-ticket/, file)
  }
})

test('插件自愈不因上游暂时不可达而重启网关', () => {
  const source = fs.readFileSync(path.join(ROOT, 'packages/plugin/index.mjs'), 'utf8')
  assert.doesNotMatch(source, /health\.upstreamOk\s*===\s*false/)
  assert.match(source, /upstreamReachable/)
})

test('网关为 VPN 连接暴露可调的 Ping/Pong 和握手超时', () => {
  const source = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  assert.match(source, /GATEWAY_WS_PING_MS/)
  assert.match(source, /GATEWAY_WS_PONG_TIMEOUT_MS/)
  assert.match(source, /GATEWAY_WS_UPGRADE_TIMEOUT_MS/)
  assert.match(source, /startWsHeartbeat/)
  assert.match(source, /upstream websocket upgrade failed/)
  assert.match(source, /UPSTREAM_TRANSPORT/)
  assert.match(source, /UPSTREAM_PORT/)
})
