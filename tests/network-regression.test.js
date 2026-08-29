'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

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
    assert.match(source, /data-morph-state="\$\{expanded \? 'open' : 'closed'\}"/, relative)
    assert.match(source, /setTimeout\(\(\) => renderSessionCards\(\), 240\)/, relative)
  }
})

test('morphicons 以本地 Web Component 接入并保留静态 SVG 回退', () => {
  const init = fs.readFileSync(path.join(ROOT, 'public/morphicons-init.js'), 'utf8')
  assert.match(init, /defineMorphIcon\(\)/)
  assert.match(init, /new MutationObserver/)
  assert.match(init, /data-morph-state/)
  for (const file of [
    'public/vendor/morphicons/LICENSE',
    'public/vendor/morphicons/README.md',
    'public/vendor/morphicons/element.js',
    'public/vendor/morphicons/controller-CXZuwJ_M.js',
    'public/vendor/morphicons/dom.js',
    'public/vendor/morphicons/spring-CFHloqPP.js',
    'public/vendor/morphicons/normalize-CYnN3Npw.js'
  ]) assert.ok(fs.existsSync(path.join(ROOT, file)), file)
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  const pluginHtml = fs.readFileSync(path.join(ROOT, 'public/plugin.html'), 'utf8')
  const pluginJs = fs.readFileSync(path.join(ROOT, 'public/plugin.js'), 'utf8')
  assert.match(mobileHtml, /type="module" src="morphicons-init\.js"/)
  assert.match(desktopHtml, /type="module" src="\.\.\/morphicons-init\.js"/)
  assert.match(mobileHtml, /id="fs-ico"[\s\S]{0,400}data-morph-open=/)
  assert.match(pluginHtml, /id="plugin-toggle-icon"[\s\S]{0,300}data-morph-open=/)
  assert.match(pluginHtml, /type="module" src="morphicons-init\.js"/)
  assert.match(pluginJs, /plugin-toggle-icon.*data-morph-state/, 'plugin toggle state')
})

test('GSAP 动效层使用 timeline、stagger 和 reduced-motion 保护', () => {
  const motion = fs.readFileSync(path.join(ROOT, 'public/motion.js'), 'utf8')
  assert.ok(fs.existsSync(path.join(ROOT, 'public/vendor/gsap/gsap.min.js')))
  assert.ok(fs.existsSync(path.join(ROOT, 'public/vendor/gsap/NOTICE.md')))
  assert.match(motion, /gsap\.timeline\(/)
  assert.match(motion, /gsap\.fromTo\(/)
  assert.match(motion, /prefers-reduced-motion/)
  assert.match(motion, /stagger:/)
  assert.match(motion, /power2\.out/)
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /DshMotion\?\.view/, relative)
    assert.match(source, /DshMotion\?\.list/, relative)
  }
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  assert.match(mobileHtml, /vendor\/gsap\/gsap\.min\.js/)
  assert.match(mobileHtml, /src="motion\.js"/)
  assert.match(desktopHtml, /\.\.\/vendor\/gsap\/gsap\.min\.js/)
  assert.match(desktopHtml, /src="\.\.\/motion\.js"/)
})

test('第二阶段动效对工作区和会话列表使用位置重排过渡', () => {
  const motion = fs.readFileSync(path.join(ROOT, 'public/motion.js'), 'utf8')
  assert.match(motion, /function relayout\(container, selector, render\)/)
  assert.match(motion, /getBoundingClientRect\(\)/)
  assert.match(motion, /gsap\.set\(node, \{ x, y \}\)/)
  assert.match(motion, /motionListSignature/)
  assert.match(motion, /forEach\(node => view\(node\)\)/)
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /DshMotion\?\.relayout/, relative)
    assert.match(source, /data-motion-key=/, relative)
    assert.match(source, /DshMotion\?\.list\(panel, '\.(?:wb-session|ds-wb-session)'\)/, relative)
  }
})

test('工作区和工作区内会话支持长按拖动并保存当前设备顺序', () => {
  const motion = fs.readFileSync(path.join(ROOT, 'public/motion.js'), 'utf8')
  assert.match(motion, /function bindLongPressReorder\(container, selector, options = \{\}\)/)
  assert.match(motion, /LONG_PRESS_MS = 300/)
  assert.match(motion, /MOVE_TOLERANCE = 28/)
  assert.match(motion, /pointerdown/)
  assert.match(motion, /touchstart/)
  assert.match(motion, /touchmove/)
  assert.match(motion, /reorder-scroll-lock/)
  assert.match(motion, /document\.addEventListener\('touchmove', onDocumentMove, \{ passive: false, capture: true \}\)/)
  assert.match(motion, /event\.preventDefault\(\)/)
  assert.match(motion, /const autoScroll = drag =>/)
  assert.match(motion, /scrollTargetsFrom/)
  assert.match(motion, /const reorderDraggedItems = \(drag, clientY\) =>/)
  assert.match(motion, /scrollTop = Math\.max\(/)
  assert.match(motion, /document\.addEventListener\('pointerup'/)
  assert.match(motion, /document\.addEventListener\('touchcancel'/)
  assert.match(motion, /visibilitychange/)
  assert.match(motion, /reorder-placeholder/)
  assert.match(motion, /gsap\.quickTo\(press\.item, 'y'/)
  assert.match(motion, /gsap\.fromTo\(drag\.item, \{ x: dx, y: dy, scale: 1\.02 \}/)
  assert.match(motion, /const payload = \{ item: drag\.item, list: drag\.list, group: drag\.group, order \}/)
  const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  for (const source of [mobile, desktop]) {
    assert.match(source, /WORKBENCH_ORDER_CACHE_KEY = 'workbenchOrderV1'/)
    assert.match(source, /orderedWorkspaceItems/)
    assert.match(source, /orderedWorkspaceSessions/)
    assert.match(source, /bindLongPressReorder/, 'long press reorder binding')
    assert.match(source, /commitWorkspaceOrder/, 'workspace order commit')
    assert.match(source, /commitWorkspaceSessionOrder/, 'session order commit')
    assert.match(source, /data-reorder-handle/, 'visible drag affordance')
  }
  assert.match(mobile, /bindLongPressReorder\(panel, '\.session-swipe'/)
  assert.match(desktop, /bindLongPressReorder\(panel, '\.ds-wb-session'/)
  assert.match(mobile, /bindLongPressReorder\(list, '\.session-workspace-group'/)
  assert.match(desktop, /bindLongPressReorder\(list, '\.ds-session-workspace-group'/)
  const mobileCss = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')
  const desktopCss = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.css'), 'utf8')
  for (const css of [mobileCss, desktopCss]) {
    assert.match(css, /touch-action: pan-y/)
    assert.match(css, /reorder-dragging[^\n]*touch-action: none/)
  }
})

test('P0 会话生命周期：重命名、停止本轮、归档和重连重建', () => {
  const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  for (const source of [mobile, desktop]) {
    assert.match(source, /session\.rename/, 'native rename RPC')
    assert.match(source, /session\.cancel/, 'native cancel RPC')
    assert.match(source, /workspace\.archiveSession/, 'native archive RPC')
    assert.match(source, /hydrateSessionProjections/, 'history projection hydration')
    assert.match(source, /pendingProjections/, 'projection race buffer')
    assert.match(source, /resyncAfterStreamOpen/, 'reconnect state rebuild')
  }
  assert.match(mobile, /sessionId, title/, 'mobile rename payload')
  assert.match(desktop, /sessionId, title/, 'desktop rename payload')
  assert.match(mobileHtml, /id="btn-rename-session"/)
  assert.match(mobileHtml, /id="btn-archive-session"/)
  assert.match(mobileHtml, /id="modal-rename"/)
  assert.match(desktopHtml, /id="btn-rename-session"/)
  assert.match(desktopHtml, /id="btn-archive-session"/)
  assert.match(desktopHtml, /id="btn-cancel"[^>]*data-i18n="ds\.sessionStop"/)
  assert.match(desktopHtml, /id="modal-rename"/)
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
  assert.match(poll, /newFixedThreadPool\(2\)/, 'native poll parallel channels')
  assert.match(poll, /optBoolean\("truncated", false\)/, 'native poll truncated replay')
  assert.match(poll, /effectiveSince = reset \? 0 : since/, 'native poll cursor reset')
  assert.match(poll, /host\/session-status/, 'native poll task completion')
  assert.match(poll, /&wait=25000/, 'native long poll')
  assert.match(poll, /registerDefaultNetworkCallback/, 'native network recovery')
  assert.match(poll, /onAvailable\(Network network\)/, 'native network recovery callback')
  assert.match(gateway, /eventPollWaiters/, 'gateway long poll waiters')
  assert.match(gateway, /waitSupported/, 'gateway long poll capability')
  assert.match(gateway, /flushEventPollWaiters/, 'gateway wakes long poll')
  assert.match(app, /since=\$\{since\}&wait=25000/, 'web long poll')
  assert.match(gateway, /healthProbes: 1/, 'health probe capability')
  assert.match(gateway, /probe.*live/, 'liveness probe')
  assert.match(gateway, /readiness/, 'readiness state')
  assert.match(gateway, /fsEntityTag/, 'file ETag')
  assert.match(gateway, /upload-expires/, 'upload expiration')
  assert.match(gateway, /cleanupExpiredUploadParts/, 'upload cleanup')
  assert.match(app, /Upload-Offset/, 'tus-style upload offset')
  assert.match(app, /Upload-Length/, 'tus-style upload length')
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

test('二维码配对会携带并导入全部主机 IP，同时兼容旧单地址', () => {
  const admin = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8')
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')

  const helperStart = admin.indexOf('function normalizedHostIPs')
  const helperEnd = admin.indexOf('function renderHostIPs', helperStart)
  const pairStart = admin.indexOf('function pairTarget')
  const pairEnd = admin.indexOf('function renderQr', pairStart)
  const adminContext = {
    URLSearchParams,
    location: { hostname: 'test-host' },
    store: { get() { return null }, set() {} },
    gatewayPort: 8787,
    HOST_IP_SELECTION_KEY: 'dshAdminEnabledHostIPsV1',
    MANUAL_HOST_IP_KEY: 'dshAdminManualHostIPsV1',
  }
  vm.createContext(adminContext)
  vm.runInContext(`${admin.slice(helperStart, helperEnd)}\n${admin.slice(pairStart, pairEnd)}\nthis.pairTarget = pairTarget`, adminContext)

  const target = adminContext.pairTarget({
    lanIPs: ['192.168.1.10', '100.64.0.2', '192.168.1.10'],
    port: 9876,
  }, 'qr-token')
  const pairUrl = new URL(target.url)
  assert.deepEqual(pairUrl.searchParams.getAll('server'), [
    'http://192.168.1.10:9876',
    'http://100.64.0.2:9876',
  ])
  assert.equal(target.base, 'http://192.168.1.10:9876')

  adminContext.store.get = key => key === 'dshAdminEnabledHostIPsV1'
    ? JSON.stringify({ 'test-host|0.0.0.0': ['100.64.0.2'] })
    : null
  const selected = adminContext.pairTarget({
    hostname: 'test-host', host: '0.0.0.0',
    lanIPs: ['192.168.1.10', '100.64.0.2'], port: 9876,
  }, 'qr-token')
  assert.deepEqual(new URL(selected.url).searchParams.getAll('server'), ['http://100.64.0.2:9876'])
  assert.equal(selected.base, 'http://100.64.0.2:9876')

  adminContext.store.get = key => key === 'dshAdminManualHostIPsV1'
    ? JSON.stringify({ 'docker-host': ['100.105.242.110', 'dsh-host.tailnet.test'] })
    : null
  const dockerTarget = adminContext.pairTarget({
    hostname: 'docker-host', host: '0.0.0.0', lanIPs: ['172.18.0.2'], port: 8787,
  }, 'qr-token')
  assert.deepEqual(new URL(dockerTarget.url).searchParams.getAll('server'), [
    'http://172.18.0.2:8787',
    'http://100.105.242.110:8787',
    'http://dsh-host.tailnet.test:8787',
  ])

  const scanStart = app.indexOf('function applyPairUrl')
  const scanEnd = app.indexOf('/** 拍照/相册得到的 dataUrl', scanStart)
  let nextId = 0
  let fsResetCount = 0
  let saved = null
  const elements = new Map()
  const appContext = {
    URL,
    state: { token: '', server: '', servers: [], activeGroup: '默认', groupActive: {} },
    LS: { set() {} },
    normalizedServerToken: token => typeof token === 'string' ? token.trim() : '',
    newServerId: () => `qr-${++nextId}`,
    saveServers: () => { saved = appContext.state.servers.map(server => server.url) },
    resetFsForServer: () => { fsResetCount++ },
    renderServers() {},
    syncBgConfig() {},
    t: key => key,
    $: id => elements.get(id) || (() => {
      const element = { textContent: '' }
      elements.set(id, element)
      return element
    })(),
  }
  vm.createContext(appContext)
  vm.runInContext(`${app.slice(scanStart, scanEnd)}\nthis.applyPairUrl = applyPairUrl`, appContext)

  assert.equal(appContext.applyPairUrl(target.url), true)
  assert.equal(appContext.state.token, 'qr-token')
  assert.equal(appContext.state.server, 'http://192.168.1.10:9876')
  assert.deepEqual(appContext.state.servers.map(server => server.url), [
    'http://192.168.1.10:9876',
    'http://100.64.0.2:9876',
  ])
  assert.deepEqual(appContext.state.servers.map(server => server.token), ['qr-token', 'qr-token'])
  assert.deepEqual(saved, appContext.state.servers.map(server => server.url))
  assert.equal(fsResetCount, 1)

  appContext.state = { token: '', server: '', servers: [], activeGroup: '默认', groupActive: {} }
  assert.equal(appContext.applyPairUrl('dshremote://pair?token=legacy&server=http%3A%2F%2F10.0.0.8%3A8787'), true)
  assert.equal(appContext.state.token, 'legacy')
  assert.deepEqual(appContext.state.servers.map(server => server.url), ['http://10.0.0.8:8787'])
  assert.equal(fsResetCount, 2)

  appContext.state = {
    token: 'old-token', server: 'http://10.0.0.8:8787', activeGroup: '默认', groupActive: {},
    servers: [{ id: 'old', url: 'http://10.0.0.8:8787', note: 'old', group: '默认', token: 'old-token' }],
  }
  assert.equal(appContext.applyPairUrl('dshremote://pair?token=new-token&server=http%3A%2F%2F10.0.0.8%3A8787'), true)
  assert.deepEqual(appContext.state.servers.map(server => server.token), ['new-token', 'old-token'])
  assert.equal(appContext.state.token, 'new-token')
  assert.equal(fsResetCount, 3)
})

test('服务器连接身份同时包含地址和令牌，避免测速与切换混用令牌', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    const start = source.indexOf('function normalizedServerToken')
    const end = source.indexOf('function currentServerEntry', start)
    const context = {}
    vm.createContext(context)
    vm.runInContext(`${source.slice(start, end)}\nthis.serverIdentity = serverIdentity`, context)
    assert.notEqual(context.serverIdentity('http://gateway.test', 'token-a'), context.serverIdentity('http://gateway.test', 'token-b'), relative)
    assert.equal(context.serverIdentity('http://gateway.test/', 'token-a'), context.serverIdentity('http://gateway.test', 'token-a'), relative)
    assert.match(source, /serverLatency\[serverKey\(/, relative)
    assert.match(source, /token: normalizedServerToken\(state\.token\)/, relative)
  }
})

test('投票支持网关不可达时直连公网收集器托底，普通反馈仍走网关', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  assert.match(source, /DIRECT_POLL_FEEDBACK_URL\s*=\s*'https:\/\/vm-0-2-ubuntu\.tail1f6fc4\.ts\.net\/submit'/)
  const vote = source.slice(source.indexOf('async function submitAnnouncementVote'), source.indexOf('function closeAnnouncement', source.indexOf('async function submitAnnouncementVote')))
  assert.match(vote, /if \(!res \|\| res\.status === 401\)/)
  assert.match(vote, /fetch\(DIRECT_POLL_FEEDBACK_URL[\s\S]{0,260}mode: 'cors'/)
  const feedback = source.slice(source.indexOf('async function submitFeedback'), source.indexOf('function fmtTime', source.indexOf('async function submitFeedback')))
  assert.doesNotMatch(feedback, /DIRECT_POLL_FEEDBACK_URL/)
})

test('统计页同时展示 token 量趋势和原有费用趋势', () => {
  const mobileHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const mobile = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  const desktopHtml = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.html'), 'utf8')
  const desktop = fs.readFileSync(path.join(ROOT, 'public/desktop/desktop.js'), 'utf8')
  for (const source of [mobileHtml, mobile, desktopHtml, desktop]) assert.match(source, /stats-token-chart/)
  assert.match(mobile, /const maxCost/)
  assert.match(mobile, /const maxTokens/)
  assert.match(desktop, /const maxCost/)
  assert.match(desktop, /const maxTokens/)
  assert.match(mobileHtml, /statsPage\.costTrend/)
  assert.match(desktopHtml, /ds\.statsCostTrend/)
})

test('移动端统计页支持切换图表指标并记住选择', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  const source = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8')
  assert.match(html, /data-stats-mode="token"/)
  assert.match(html, /data-stats-mode="cost"/)
  assert.match(html, /data-stats-panel="cost"/)
  assert.match(html, /data-stats-panel="token"/)
  assert.match(source, /statsChartModeV1/)
  assert.match(source, /function applyStatsChartMode\(\)/)
  assert.match(source, /panel\.classList\.toggle\('hidden', !active\)/)
})

test('总览优先使用网关健康探测判断 DSH 可达，并在 host.describe 失败后重试', () => {
  for (const relative of ['public/app.js', 'public/desktop/desktop.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    assert.match(source, /function dshReachable\(\)[\s\S]{0,260}typeof health\.upstreamReachable === 'boolean'/)
    assert.match(source, /dsh: dshReachable\(\)/)
    assert.match(source, /hostDescribeFailures\+\+[\s\S]{0,100}scheduleHostDescribeRetry/)
    assert.match(source, /allStreamsOpen\(\)[\s\S]{0,180}refreshHostDescription/)
    const start = source.indexOf('function activeGatewayHealth')
    const end = source.indexOf('async function selectFastestServer', start)
    const context = {
      location: { origin: 'http://gateway.test' },
      state: { server: '', hostInfo: null, gatewayHealth: { 'http://gateway.test': { upstreamReachable: true } } },
    }
    vm.createContext(context)
    vm.runInContext(`${source.slice(start, end)}\nthis.dshReachable = dshReachable`, context)
    assert.equal(context.dshReachable(), true)
    context.state.hostInfo = { version: 'test' }
    context.state.gatewayHealth['http://gateway.test'].upstreamReachable = false
    assert.equal(context.dshReachable(), false)
    delete context.state.gatewayHealth['http://gateway.test']
    assert.equal(context.dshReachable(), true)
  }
})
