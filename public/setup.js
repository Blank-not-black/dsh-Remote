/* 首次使用：插件抽屉和管理页共用。仅检查本机包，下载进度交给浏览器。 */
'use strict'
;(function () {
  const words = {
    zh: {
      title: '连接你的第一台手机', again: '安装 App 与连接手机', intro: '电脑保持 DSH 运行，按下面三步开始。已有 App 可直接进行第 3 步。', next: '我已安装，继续配对', back: '返回下载',
      service: '准备电脑端', ready: '网关已运行。首次连接请让手机和电脑处于同一 Wi-Fi。', standalone: '网关当前未就绪，请检查主机上的网关进程。',
      down: '网关尚未就绪。插件已包含网关，可在此启动。', auth: '网关认证异常，请打开控制台查看诊断。', upstream: '网关已运行，但 DSH 暂不可达。可先安装 App，再到控制台检查连接。',
      attention: '网关进程已运行，但尚未能读取管理状态。请到控制台检查。',
      start: '启动网关', console: '打开控制台', diagnose: '检查连接', app: '安装 Android App', checking: '正在检查插件内的安装包…',
      package: '当前主机安装包', version: '版本', missing: '当前插件未附带可下载的 APK，或请求失败。可重试，或打开发行页手动下载。',
      download: '下载到当前设备', retry: '重新检查安装包', releases: '发行页（备用下载）', scanDownload: '用手机扫码下载',
      downloadHint: '电脑上打开此页时，推荐用手机相机扫描下载码。安装包由这台电脑提供，无需访问 GitHub。仅适用于 Android；其他设备可使用浏览器版。',
      requested: '已请求浏览器下载，请在下载列表查看进度。下载完成后，在 Android 手机打开 APK；如系统询问，请允许此次来源的安装，再返回 App。',
      install: '手机下载后打开 APK，按系统提示允许此次来源的安装。随后打开 DSH Remote，进入「设置 → 服务器 → 扫码连接」，点击「实时扫码」。',
      connect: '在 App 中扫码连接', pair: '显示连接二维码', key: '添加设备并配对',
      pairHint: '安装后，在 App 的「设置 → 服务器」中扫码。连接码含访问凭据，请勿分享。下载码不能用于连接。',
      online: '已检测到手机或浏览器在线，可以开始使用。', waiting: '等待手机连接；仅下载或打开安装包不会视为连接成功。',
      noHost: '暂无手机可访问的地址。请先启动网关；若仍无地址，在控制台的「主机 IP 地址」中添加宿主地址。',
      localOnly: '网关仅监听本机，手机无法访问。请在主机配置可供局域网访问的监听地址，再重启网关。',
      host: '手机访问的电脑地址', network: '手机需能访问所选地址。扫码打不开时，检查同一 Wi-Fi、VPN 和电脑防火墙；可在控制台诊断。',
      downloadCode: '下载二维码 · 用手机相机扫描', pairCode: '连接二维码 · 用 DSH Remote 扫描', qrError: '二维码暂不可用，请使用下方地址或打开控制台。',
      unavailable: '状态暂不可用，请稍后重试或打开控制台。', browser: '先用手机版网页', browserHint: '在手机浏览器打开下方地址，再输入控制台中的令牌。', browserKeyHint: '在控制台「添加设备」创建专用密钥；手机浏览器打开下方地址后，输入该设备的令牌。'
    },
    en: {
      title: 'Connect your first phone', again: 'Install the app and connect a phone', intro: 'Keep DSH running on your computer. Follow these three steps, or skip to step 3 if the app is installed.', next: 'App installed — pair now', back: 'Back to download',
      service: 'Prepare your computer', ready: 'The gateway is running. For your first connection, use the same Wi-Fi on both devices.', standalone: 'The gateway is not ready. Check its process on the host.',
      down: 'The gateway is not ready. It is included with the plugin; start it here.', auth: 'Gateway authentication needs attention. Open the console for diagnostics.', upstream: 'The gateway is running, but DSH is unreachable. You can install the app first, then check the console.',
      attention: 'The gateway process is running, but its management state is unavailable. Check the console.',
      start: 'Start gateway', console: 'Open console', diagnose: 'Check connection', app: 'Install the Android app', checking: 'Checking the package included with this plugin…',
      package: 'Package on this host', version: 'Version', missing: 'This plugin has no downloadable APK, or the request failed. Retry or download manually from the releases page.',
      download: 'Download on this device', retry: 'Check package again', releases: 'Releases (backup download)', scanDownload: 'Scan to download on phone',
      downloadHint: 'On a computer, use your phone camera to scan the download code. The package comes from this computer without GitHub access. Android only; other devices can use the web client.',
      requested: 'Browser download requested. Check its downloads list for progress. Open the APK on Android when finished, allow installation from this source if prompted, then return to the app.',
      install: 'Open the downloaded APK on your phone and allow installation from this source if prompted. In DSH Remote, go to Settings → Servers → Scan to pair, then tap Live scan.',
      connect: 'Scan in the app to connect', pair: 'Show connection QR', key: 'Add a device to pair', pairHint: 'After installing, scan under Settings → Servers. The connection code contains credentials; keep it private. The download code is only for downloading.',
      online: 'A phone or web client is online. You are ready to use Remote.', waiting: 'Waiting for a phone. Downloading a package does not confirm a connection.',
      noHost: 'No address accessible to your phone. Start the gateway, then add a host address under “Host IP addresses” in the console if needed.',
      localOnly: 'The gateway listens on loopback only. Configure a LAN listening address on the host and restart the gateway.',
      host: 'Computer address accessible to your phone', network: 'Your phone must reach this address. If scanning fails, check Wi-Fi, VPN and the computer firewall, or open console diagnostics.',
      downloadCode: 'Download QR · scan with your phone camera', pairCode: 'Connection QR · scan in DSH Remote', qrError: 'QR unavailable. Use the address below or open the console.',
      unavailable: 'Status unavailable. Retry later or open the console.', browser: 'Try the mobile web client', browserHint: 'Open this address in your phone browser, then enter the token from the console.', browserKeyHint: 'Create a dedicated key with Add device in the console, then open this address on your phone and enter that device’s token.'
    }
  }
  function mount(root, options) {
    if (!root) return { update() {} }
    const lang = () => window.I18N?.lang === 'en' ? 'en' : 'zh'
    const t = key => words[lang()][key]
    const labels = []
    const node = (tag, label, className) => {
      const el = document.createElement(tag)
      if (label) { el.textContent = t(label); labels.push([el, label]) }
      if (className) el.className = className
      return el
    }
    const details = node('details', '', 'remote-setup')
    const summary = node('summary', 'title')
    details.append(summary, node('p', 'intro'))
    const stepNav = node('div', '', 'setup-step-nav')
    stepNav.setAttribute('aria-label', lang() === 'zh' ? '连接步骤' : 'Connection steps')
    details.append(stepNav)
    const list = node('ol'); details.append(list); root.append(details)
    const steps = [], stepButtons = []
    let currentStep = 1, stepSelected = false
    function step(title) {
      const el = node('li'); el.append(node('h3', title)); list.append(el); steps.push(el); return el
    }
    function button(parent, label, action, primary = false) {
      const el = node('button', label, primary ? 'setup-primary' : '')
      el.type = 'button'; el.addEventListener('click', action); parent.append(el); return el
    }
    const first = step('service'), service = node('p')
    first.append(service)
    const serviceAction = button(first, 'console', () => {
      if (canStart()) options.start()
      else options.console()
    })
    const second = step('app'), packageInfo = node('p')
    packageInfo.setAttribute('role', 'status'); second.append(packageInfo)
    const actions = node('div', '', 'remote-setup-actions')
    const download = node('a', 'download')
    download.href = options.base + 'dsh-remote.apk'; download.download = 'dsh-remote.apk'; download.hidden = true
    const message = node('p', '', 'setup-message'); message.setAttribute('role', 'status')
    download.addEventListener('click', () => { message.textContent = t('requested') })
    actions.append(download)
    const retry = button(actions, 'retry', () => void checkPackage())
    const releases = node('a', 'releases'); releases.href = 'https://github.com/Blank-not-black/dsh-Remote/releases'; releases.target = '_blank'; releases.rel = 'noopener noreferrer'; actions.append(releases)
    second.append(node('p', 'downloadHint'), message)
    const addressLabel = node('label'), select = node('select')
    select.setAttribute('aria-label', t('host')); addressLabel.append(node('span', 'host'), select); second.append(addressLabel)
    const phoneDownload = button(second, 'scanDownload', () => showCode('download'), true)
    second.append(actions)
    const downloadQr = node('div', '', 'setup-qr'); downloadQr.hidden = true; second.append(downloadQr, node('p', 'install'))
    const third = step('connect'), connection = node('p', 'waiting'); connection.setAttribute('role', 'status'); third.append(connection)
    const pair = button(third, 'pair', () => {
      if (state?.deviceKeys?.enabled) options.deviceKey()
      else showCode('pair')
    }, true)
    const pairQr = node('div', '', 'setup-qr'); pairQr.hidden = true; third.append(pairQr, node('p', 'pairHint'))
    button(third, 'browser', () => showCode('browser'))
    const browserQr = node('div', '', 'setup-qr'); browserQr.hidden = true; third.append(browserQr)
    const network = node('p', 'network'); third.append(network)
    for (const [index,title] of ['service','app','connect'].entries()) {
      const control = button(stepNav,title,()=>chooseStep(index))
      stepButtons.push(control)
    }
    const stepActions = node('div','','setup-step-actions')
    const previous = button(stepActions,'back',()=>chooseStep(1))
    const next = button(stepActions,'next',()=>chooseStep(2),true)
    details.append(stepActions)
    function chooseStep(index,manual=true) {
      currentStep = Math.max(0,Math.min(2,index))
      if (manual) stepSelected = true
      steps.forEach((el,i)=>{el.hidden=i!==currentStep})
      if (currentStep===2) third.insertBefore(addressLabel,pair)
      else second.insertBefore(addressLabel,phoneDownload)
      stepButtons.forEach((el,i)=>el.setAttribute('aria-current',i===currentStep?'step':'false'))
      previous.hidden=currentStep!==2
      next.hidden=currentStep!==1
    }
    chooseStep(1,false)
    let state = null, initialized = false, packageReady = false, checking = false
    let packageVersion = '', packageSize = 0, downloadRequested = false
    const shownCodes = new Set(), codeSignatures = new Map()
    const running = () => state?.mode === 'gateway' && !state.gatewayAuthError
    const canStart = () => state && !state.gatewayRunning && state.mode !== 'gateway' && !state.gatewayAuthError && state.gatewayInstalled !== false && options.canStart !== false
    function bases() {
      if (!running() || /^(127\.|localhost$|\[?::1\]?$)/i.test(state.host || '')) return []
      const hosts = options.hosts ? options.hosts(state) : state.lanIPs || []
      const port = Number(state.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return []
      return [...new Set(hosts)].filter(host => typeof host === 'string' && /^[a-z0-9.-]+$/i.test(host)
        && !/^(127\.|0\.0\.0\.0$|localhost$)/i.test(host)).map(host => `http://${host}:${port}`)
    }
    function showCode(kind) {
      shownCodes.add(kind)
      const box = kind === 'download' ? downloadQr : kind === 'pair' ? pairQr : browserQr
      const base = select.value
      if (!bases().includes(base) || (kind === 'download' && !packageReady)
        || (kind === 'pair' && (!state?.token || state.deviceKeys?.enabled))) { box.hidden = true; box.replaceChildren(); return }
      let url = base + (kind === 'download' ? '/dsh-remote.apk' : '/')
      if (kind === 'pair') url = 'dshremote://pair?' + new URLSearchParams({ token: state.token, server: base })
      const signature = lang() + '|' + url + '|' + !!state.deviceKeys?.enabled
      if (!box.hidden && codeSignatures.get(kind) === signature) return
      codeSignatures.set(kind, signature)
      box.replaceChildren()
      const caption = node('p'); caption.textContent = t(kind === 'download' ? 'downloadCode' : kind === 'pair' ? 'pairCode' : state.deviceKeys?.enabled ? 'browserKeyHint' : 'browserHint'); box.append(caption)
      try {
        const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make()
        const image = node('div'); image.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); box.append(image)
      } catch { const error = node('p'); error.textContent = t('qrError'); box.append(error) }
      // 配对凭据只在主动显示连接码后呈现，不写 URL/日志/存储。
      if (kind !== 'pair') {
        const link = node('a', '', 'setup-url'); link.textContent = url; link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link)
      }
      box.hidden = false
    }
    function update(next) {
      state = next
      for (const [el, key] of labels) el.textContent = t(key)
      stepButtons.forEach((el,i)=>{el.textContent=(i+1)+' '+t(['service','app','connect'][i])})
      select.setAttribute('aria-label', t('host'))
      packageInfo.textContent = checking ? t('checking') : packageReady
        ? `${t('package')}${packageVersion ? ' · ' + t('version') + ' ' + packageVersion : ''} · ${(packageSize / 1048576).toFixed(1)} MB` : t('missing')
      if (downloadRequested) message.textContent = t('requested')
      const online = (state?.devices || []).some(d => d.online && (d.kind === 'app' || d.kind === 'web'))
      if (!initialized) { details.open = !online; initialized = !!state }
      if (state && !stepSelected) chooseStep(state.mode === 'gateway' ? 1 : 0,false)
      summary.textContent = t(online ? 'again' : 'title')
      service.textContent = t(!state ? 'unavailable' : state.gatewayAuthError ? 'auth' : !running() ? state.gatewayRunning ? 'attention' : options.canStart === false ? 'standalone' : 'down' : state.upstream?.reachable === false ? 'upstream' : 'ready')
      serviceAction.textContent = t(canStart() ? 'start' : options.inConsole ? 'diagnose' : 'console')
      connection.textContent = t(online ? 'online' : 'waiting')
      pair.textContent = t(state?.deviceKeys?.enabled ? 'key' : 'pair')
      const previous = select.value, urls = bases()
      if (Array.from(select.options).map(o => o.value).join('|') !== urls.join('|')) {
        select.replaceChildren(...urls.map(url => { const el = node('option'); el.value = url; el.textContent = url; return el }))
        if (urls.includes(previous)) select.value = previous
      }
      select.hidden = addressLabel.hidden = !urls.length
      phoneDownload.disabled = !packageReady || !urls.length
      pair.disabled = !urls.length || !running() || (!state?.deviceKeys?.enabled && !state?.token)
      network.textContent = t(urls.length ? 'network' : /^(127\.|localhost$|\[?::1\]?$)/i.test(state?.host || '') && running() ? 'localOnly' : 'noHost')
      for (const kind of shownCodes) showCode(kind)
    }
    select.addEventListener('change', () => { for (const kind of shownCodes) showCode(kind) })
    async function checkPackage() {
      if (checking) return
      checking = true; retry.disabled = true; download.hidden = true; packageReady = false
      packageInfo.textContent = t('checking'); update(state)
      try {
        const [head, metadata] = await Promise.all([
          fetch(options.base + 'dsh-remote.apk', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) }),
          fetch(options.base + 'update.json?local=setup', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null).catch(() => null)
        ])
        const size = Number(head.headers.get('content-length'))
        if (!head.ok || !(size > 0) || !/android.package-archive|octet-stream/i.test(head.headers.get('content-type') || '')) throw Error('APK unavailable')
        packageVersion = typeof metadata?.version === 'string' ? metadata.version.slice(0, 60) : ''
        packageSize = size
        packageReady = true; download.hidden = false
      } catch { packageInfo.textContent = t('missing') }
      finally { checking = false; retry.disabled = false; update(state) }
    }
    void checkPackage()
    download.addEventListener('click', () => { downloadRequested = true })
    function conceal() {
      shownCodes.clear(); codeSignatures.clear()
      for (const box of [downloadQr,pairQr,browserQr]) { box.hidden=true; box.replaceChildren() }
    }
    details.addEventListener('toggle',()=>{if(!details.open)conceal()})
    return { update, conceal, show(step=1) { chooseStep(typeof step === 'number'?step:1); details.open = true; details.scrollIntoView?.({ behavior: 'smooth', block: 'start' }) } }
  }
  window.DshSetup = { mount }
})()
