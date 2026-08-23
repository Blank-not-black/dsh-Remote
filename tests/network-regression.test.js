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

test('反馈默认走公网 HTTPS 收集器，不依赖用户加入项目内网', () => {
  const source = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  assert.match(source, /DSH_REMOTE_FEEDBACK_URL/)
  assert.match(source, /https:\/\/vm-0-2-ubuntu\.tail1f6fc4\.ts\.net\/submit/)
  assert.doesNotMatch(source, /https?:\/\/100\.84\.128\.29\/submit/)
})

test('同源 WebUI 不会因为 state.server 为空而误报网关离线', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /gateway:\s*!!state\.token\s*&&\s*\(!!state\.server\s*\|\|\s*\/\^https\?:\$\/\.test\(location\.protocol\)\)/, relative)
  }
})

test('mux/host 后打开的通道也会刷新用户可见总览', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  assert.match(mobile, /function updateConn\(\) \{[\s\S]{0,180}renderOverview\(\)/)
  assert.match(desktop, /function updateConn\(\) \{[\s\S]{0,180}renderOverviewDesktop\(\)/)
})

test('图片撑高历史区后，紧随其后的实时回复仍进入可见窗口', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  assert.match(source, /h\.renderEnd = h\.visible\.length\s*\n\s*renderHistory\(false, 'fixed'\)/)
  assert.match(source, /mode === 'fixed'\) box\.scrollTop = oldTop/)
})

test('并发会话卡片请求不会重复追加子代理', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /const renderGeneration = \+\+sessionCardsRenderGeneration/, relative)
    assert.match(source, /renderGeneration !== sessionCardsRenderGeneration \|\| state\.current !== sessionId/, relative)
  }
})
