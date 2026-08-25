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

test('子代理卡片默认折叠并支持展开收起', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /subagentExpandedSession/, relative)
    assert.match(source, /data-subagent-toggle/, relative)
    assert.match(source, /aria-expanded=\"\$\{expanded\}\"/, relative)
    assert.match(source, /subagent-list\$\{expanded \? '' : ' hidden'\}/, relative)
    assert.match(source, /state\.subagentExpandedSession = expanded \? '' : sessionId/, relative)
  }
})

test('排队消息支持按 DSH 原生协议逐条插话', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /session\/queue/, relative)
    assert.match(source, /placement === 'queued'/, relative)
    assert.match(source, /session\.updateQueue/, relative)
    assert.match(source, /action: \{ kind: 'steer' \}/, relative)
    assert.match(source, /data-queue-steer/, relative)
    assert.match(source, /queue-dock/, relative)
  }
})

test('会话排序只在本轮开始/结束时更新时间，不跟随中间事件抖动', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /sessionTurnTimes/, relative)
    assert.match(source, /event\??\.type === 'turn\/start' \|\| event\??\.type === 'turn\/end'/, relative)
    assert.match(source, /function sessionSortTime\(s\)/, relative)
    assert.doesNotMatch(source, /s\.updatedAt = Date\.now\(\)/, relative)
  }
})

test('运行中的会话在输入框上方显示动态状态', () => {
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  assert.match(mobileHtml, /id="composer-status"/, 'mobile html')
  assert.match(desktopHtml, /id="composer-status"/, 'desktop html')
  assert.match(mobile, /composerStatus\.classList\.toggle\('hidden', !s\?\.running\)/, 'mobile js')
  assert.match(desktop, /function updateComposerStatus\(\)/, 'desktop js')
})

test('重连重放审批和提问时按稳定 ID 去重', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    const approval = source.indexOf("if (f.type === 'approval/requested')")
    const question = source.indexOf("if (f.type === 'question/requested')")
    assert.ok(approval >= 0 && question >= 0, relative)
    assert.match(source.slice(approval, approval + 360), /state\.approvals = state\.approvals\.filter\(a => a\.approvalId !== f\.approvalId\)/, relative)
    assert.match(source.slice(question, question + 360), /state\.questions = state\.questions\.filter\(q => q\.rpcId !== full\.rpcId\)/, relative)
  }
})

test('设备识别使用跨标签页持久化 client ID，并让 HTTP 与 WS 共用它', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /const key = 'dshRemoteClientIdV2'[\s\S]{0,80}localStorage\.getItem\(key\)/, relative)
    assert.match(source, /x-dsh-remote-client-id/, relative)
    assert.match(source, /clientIdHeaders\(\)/, relative)
    assert.doesNotMatch(source, /sessionStorage\.getItem\('dshRemoteClientId'\)/, relative)
  }
  const gateway = fs.readFileSync(path.join(ROOT, 'gateway.js'), 'utf8')
  assert.match(gateway, /x-dsh-remote-client-id/, 'gateway')
  assert.match(gateway, /extra\.clientId \|\| headerClientId/, 'gateway')
  assert.match(gateway, /legacyDeviceAliases/, 'gateway legacy aliases')
  assert.match(gateway, /sameUa = requestUa && legacy\.ua && requestUa === legacy\.ua/, 'gateway legacy fingerprint')
  assert.match(gateway, /knownDeviceForLegacy/, 'gateway reverse legacy migration')
  assert.match(gateway, /Dalvik\\\/2\\\.1\\\.0/, 'gateway native poll fingerprint')
  assert.match(gateway, /devices\.delete\(ip\)/, 'gateway legacy migration')
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  assert.match(app, /clientId: CLIENT_ID/, 'background service config')
  const activity = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/dshremote/app/MainActivity.java'), 'utf8')
  assert.match(activity, /putString\("client_id", clientId/, 'native client ID persistence')
  const poll = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/dshremote/app/RemotePollService.java'), 'utf8')
  assert.match(poll, /X-Dsh-Remote-Client-Id/, 'native poll client ID')
  assert.match(poll, /X-Dsh-Remote-Client/, 'native poll client kind')
})

test('扫码连接优先使用实时摄像头取帧，识别失败仍保留拍照回退', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  assert.match(html, /id="modal-scan-live"/)
  assert.match(html, /id="scan-live-video"[^>]*autoplay[^>]*playsinline/)
  assert.match(source, /navigator\.mediaDevices\?\.getUserMedia/)
  assert.match(source, /window\.BarcodeDetector/)
  assert.match(source, /const maxSide = 480/)
  assert.match(source, /const side = Math\.floor\(Math\.min\(video\.videoWidth, video\.videoHeight\) \* 0\.64\)/)
  assert.match(source, /window\.jsQR\?\./)
  assert.match(source, /new Worker\(liveScanWorkerUrl\)/)
  assert.match(source, /liveScanWorker\.postMessage\(/)
  assert.match(source, /xhr\.setRequestHeader\('x-dsh-remote-client-id'/)
  assert.match(source, /if \(source === 'CAMERA'\) \{[\s\S]{0,600}scanPairLive\(\)/)
  assert.match(source, /camera\.getPhoto\(/)
})
