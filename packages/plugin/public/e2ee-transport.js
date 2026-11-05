/* Packaged Android WebUI: paired public origins always use the native TLS proxy. */
;(function(root) {
  'use strict'
  const bridge = root.NativeE2ee
  if (!bridge?.resolve) return
  const active = new Set()
  function changed(origin) { for (const request of [...active]) if (request.origin === origin) request.cancel() }
  function resolve(input) {
    const original = String(input), value = JSON.parse(bridge.resolve(original))
    if (value.error || typeof value.url !== 'string') throw new Error('E2EE_TRANSPORT_UNAVAILABLE')
    if ((value.secure || value.paired) && !/^(?:http|ws):\/\/127\.0\.0\.1:\d+\/e2ee-[a-f0-9]{48}\//.test(value.url)) throw new Error('E2EE_TRANSPORT_UNAVAILABLE')
    return value.url
  }
  const fetch = root.fetch.bind(root)
  root.fetch = function(input, init) {
    try {
      const request = typeof root.Request === 'function' && input instanceof root.Request
      const url = request ? input.url : new URL(String(input), root.location.href).href
      const mapped = resolve(url)
      const controller = new root.AbortController(), signal = init?.signal || (request ? input.signal : null)
      const cancel = () => controller.abort(signal?.reason), entry = { origin: new URL(url).origin, cancel: () => controller.abort() }
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true })
      active.add(entry)
      return fetch(mapped === url ? input : request ? new root.Request(mapped, input) : mapped, { ...init, signal: controller.signal })
        .finally(() => { active.delete(entry); signal?.removeEventListener('abort', cancel) })
    } catch (error) { return Promise.reject(error) }
  }
  if (root.WebSocket) {
    const WebSocket = root.WebSocket
    root.WebSocket = class extends WebSocket {
      constructor(url, protocols) {
        const original = new URL(String(url), root.location.href)
        super(resolve(original.href), ...(protocols === undefined ? [] : [protocols]))
        const entry = { origin: original.origin.replace(/^wss:/, 'https:'), cancel: () => this.close() }; active.add(entry)
        this.addEventListener?.('close', () => active.delete(entry), { once: true })
      }
    }
  }
  if (root.XMLHttpRequest) {
    const open = root.XMLHttpRequest.prototype.open
    const entries = new WeakMap()
    root.XMLHttpRequest.prototype.open = function(method, url, ...args) {
      const original = new URL(String(url), root.location.href), mapped = resolve(original.href)
      const previous = entries.get(this); if (previous) active.delete(previous)
      const result = open.call(this, method, mapped, ...args)
      const entry = { origin: original.origin, cancel: () => this.abort() }; active.add(entry); entries.set(this, entry)
      this.addEventListener?.('loadend', () => active.delete(entry), { once: true })
      return result
    }
  }
  function externalAllowed(input) {
    try { const state = JSON.parse(bridge.info(new URL(String(input), root.location.href).origin)); return !state.configured && !state.required } catch { return false }
  }
  const externalNotice = () => root.alert?.(root.I18N?.lang === 'en' ? 'Use this paired relay inside the app. Open management locally on your host.' : '此配对中转需要在应用内使用；管理页面请从主机本地打开。')
  if (root.open) {
    const open = root.open.bind(root)
    root.open = (url, ...args) => { if (!externalAllowed(url)) { externalNotice(); return null }; return open(url, ...args) }
  }
  root.document?.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a[href]')
    if (anchor && !externalAllowed(anchor.href)) { event.preventDefault(); event.stopImmediatePropagation(); externalNotice() }
  }, true)
  root.DshE2eeTransport = { resolve, mount(target, { connection, onConnect, onModeChange, onAutoPaired } = {}) {
    if (!target || target.dataset.e2eeMounted) return
    target.dataset.e2eeMounted = 'true'
    const en = () => root.I18N?.lang === 'en', text = (zh, english) => en() ? english : zh
    const title = document.createElement('h3'), explanation = document.createElement('p'), button = document.createElement('button'), status = document.createElement('p')
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true
    const autoPair = document.createElement('button'); autoPair.type = 'button'
    autoPair.textContent = text('通过当前局域网连接自动配对', 'Pair automatically over the current LAN connection')
    const logBox = document.createElement('details'), logSummary = document.createElement('summary')
    const logPre = document.createElement('pre'), logActions = document.createElement('div'), logHint = document.createElement('p')
    const logCopy = document.createElement('button'), logRefresh = document.createElement('button'), logClear = document.createElement('button')
    logBox.className = 'relay-pair-log'; logSummary.textContent = text('配对日志（可复制反馈）', 'Pairing log (copy for support)')
    logPre.className = 'relay-pair-log-text'; logPre.setAttribute('aria-live', 'polite')
    logActions.className = 'relay-pair-log-actions'; logHint.className = 'relay-pair-log-hint'; logHint.setAttribute('role', 'status')
    logCopy.type = 'button'; logCopy.textContent = text('复制日志', 'Copy log')
    logRefresh.type = 'button'; logRefresh.textContent = text('刷新', 'Refresh')
    logClear.type = 'button'; logClear.textContent = text('清空', 'Clear')
    function renderLog() {
      try {
        const value = root.DshRelayAutoPair?.logText?.() || ''
        logPre.textContent = value || text('暂无配对记录。', 'No pairing records yet.')
      } catch { logPre.textContent = text('日志读取失败。', 'Could not read the log.') }
    }
    async function copyLog() {
      const value = root.DshRelayAutoPair?.logText?.() || ''
      let ok = false
      try { if (root.navigator?.clipboard?.writeText) { await root.navigator.clipboard.writeText(value); ok = true } } catch {}
      if (!ok) {
        try {
          const area = root.document.createElement('textarea')
          area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.top = '-1000px'
          root.document.body.append(area); area.select(); ok = root.document.execCommand?.('copy') === true; area.remove()
        } catch { ok = false }
      }
      logHint.textContent = ok ? text('已复制配对日志。', 'Pairing log copied.') : text('复制失败，请展开日志后手动选择复制。', 'Copy failed. Expand the log and copy it manually.')
    }
    logCopy.addEventListener('click', () => void copyLog())
    logRefresh.addEventListener('click', renderLog)
    logClear.addEventListener('click', () => { root.DshRelayAutoPair?.clearLog?.(); renderLog(); logHint.textContent = text('已清空配对日志。', 'Pairing log cleared.') })
    logActions.append(logCopy, logRefresh, logClear); logBox.append(logSummary, logPre, logActions, logHint)
    autoPair.addEventListener('click', () => {
      const ctx = connection()
      if (!root.DshRelayAutoPair?.localUrl(ctx.url('/relay'))) {
        status.textContent = text('请先连接自己电脑的局域网地址，再配置公网配对。', 'Connect to your computer’s LAN address first, then configure relay pairing.')
        return
      }
      renderLog()
      void root.DshRelayAutoPair.offer({ connection, onPaired: onAutoPaired, force: true, onStatus: (value, error) => {
        status.textContent = value
        if (error) logBox.open = true
        renderLog(); renderMode()
      } })
    })
    const modeLabel = document.createElement('label'), modeSwitch = document.createElement('input'), modeText = document.createElement('span'), modeStatus = document.createElement('p')
    modeLabel.className = 'relay-encryption-switch'; modeSwitch.type = 'checkbox'; modeSwitch.checked = true; modeSwitch.dataset.e2eeToggle = 'true'
    modeText.textContent = text('端到端加密（默认开启）', 'End-to-end encryption (on by default)'); modeLabel.append(modeSwitch, modeText)
    modeStatus.setAttribute('role', 'status'); modeStatus.className = 'relay-encryption-status'
    title.textContent = text('端到端加密配对（试验）', 'End-to-end pairing (experimental)')
    explanation.textContent = text('先连接自己电脑的局域网地址，即可确认并自动配置这台手机的公网配对，无需传文件；也可手动导入。端到端加密默认开启，关闭前必须确认风险，连接失败不会自动切换模式。', 'Connect to your computer’s LAN address to confirm and automatically configure this phone’s relay pairing, without transferring files. Manual import is also available. Encryption defaults on; disabling requires confirmation and connection failures never change the mode.')
    button.type = 'button'; button.textContent = text('导入本机配对文件', 'Import local pairing file')
    status.setAttribute('role', 'status'); target.append(title, explanation, modeLabel, modeStatus, autoPair, button, file, status, logBox)
    let selectedOrigin = '', identity = ''
    function modeContext() {
      const ctx = connection(), key = JSON.stringify([ctx.url('/relay'),ctx.headers?.authorization||''])
      if (key !== identity) { identity = key; selectedOrigin = new URL(ctx.url('/relay'),root.location.href).origin }
      selectedOrigin = root.DshRelayAutoPair?.pairedOrigin(ctx.url('/relay')) || selectedOrigin
      return ctx
    }
    function renderMode() {
      try {
        modeContext(); const state = JSON.parse(bridge.info(selectedOrigin))
        modeSwitch.checked = state.encrypted !== false
        modeSwitch.disabled = !!state.error || !state.configured || typeof bridge.setEncryption !== 'function'
        modeStatus.dataset.security = !state.configured || state.error ? 'pending' : modeSwitch.checked ? 'encrypted' : 'legacy'
        modeStatus.textContent = selectedOrigin + ' · ' + (state.error ? text('无法读取安全状态，请重试；不会自动降级。','Security status unavailable. No automatic fallback.') : !state.configured
          ? text('默认开启，待本地配对；当前连接尚不能标记为已加密。','On by default; local pairing required. This connection is not yet verified as encrypted.')
          : modeSwitch.checked ? text('端到端加密已启用；每次连接仍需通过主机证书校验。','End-to-end encryption enabled; each connection must verify the host certificate.')
          : text('警告：端到端加密已关闭。仅有 HTTPS，中转方在技术上可读取内容和访问令牌。','Warning: end-to-end encryption is OFF. HTTPS remains, but the relay can technically read content and access tokens.'))
      } catch { modeSwitch.disabled = true; modeStatus.textContent = text('无法读取安全状态。','Security status unavailable.') }
    }
    modeSwitch.addEventListener('change', () => {
      const requested = modeSwitch.checked, ctx = modeContext(), origin = selectedOrigin
      renderMode()
      try {
        const state = JSON.parse(bridge.info(origin))
        if (!state.configured || state.error || !ctx.valid()) return
        if (!requested && !root.confirm(text('确认关闭端到端加密？\n关闭后，中转服务器在技术上可读取对话、图片及 Remote 访问令牌。令牌泄露可能导致主机被操作和模型额度被消耗。外层 HTTPS 仍保留，但不能阻止中转方读取内容。\n此选择仅对当前主机保存，重启后仍生效。取消可保持加密。\n目标：','Turn off end-to-end encryption?\nThe relay can technically read conversations, images and the Remote access token. A leaked token may allow host access and model usage. HTTPS remains but does not hide content from the relay.\nThis choice persists for this host after restart. Cancel to keep encryption.\nHost: ') + origin)) return
        if (!ctx.valid()) return
        const result = JSON.parse(bridge.setEncryption(origin, requested, state.fingerprint, !requested))
        if (result.error || result.encrypted !== requested) throw Error('E2EE_MODE_CHANGE_FAILED')
        changed(origin); onModeChange?.(origin, ctx); renderMode()
        status.textContent = requested ? text('已开启；连接失败时不会自动降级。','Enabled. Connection failures never trigger fallback.') : text('已关闭端到端加密，HTTPS 仍保留。','End-to-end encryption disabled; HTTPS remains.')
      } catch { renderMode(); status.textContent = text('模式未能切换，原设置保留。开启失败时请检查系统和证书，不能跳过校验。','Mode change failed; the previous setting is kept. Check system support and the certificate; verification cannot be skipped.') }
    })
    root.setInterval?.(renderMode, 1000); renderMode(); renderLog()
    if (bridge.supported?.() === false) status.textContent = text('此系统不支持 TLS 1.3，加密模式无法连接。可升级系统；若选择关闭，须先确认风险。','This system lacks TLS 1.3. Upgrade Android, or explicitly acknowledge the risks before disabling encryption.')
    button.addEventListener('click', () => file.click())
    file.addEventListener('change', async () => {
      const ctx = connection(), selected = file.files?.[0]; file.value = ''
      if (!selected || selected.size > 16384) { status.textContent = text('请选择不超过 16KB 的配对 JSON 文件。', 'Select a pairing JSON file up to 16KB.'); return }
      button.disabled = true
      try {
        const json = await selected.text(), pair = JSON.parse(json), url = new URL(pair.relayUrl)
        if (!ctx.valid()) return
        if (url.protocol !== 'https:' || url.pathname !== '/relay/v1/e2ee' || !/^[a-f0-9]{64}$/.test(pair.fingerprint)) throw Error('INVALID_E2EE_PAIRING')
        const old = JSON.parse(bridge.info(url.origin))
        if (old.error) throw Error(old.error)
        const prompt = text('确认此文件来自自己的主机本地？\n主机地址：', 'Confirm this file came locally from your own host?\nHost: ') + url.origin
          + '\n' + text('证书指纹：', 'Certificate fingerprint: ') + pair.fingerprint
          + (old.configured && old.fingerprint !== pair.fingerprint ? '\n' + text('主机证书已改变，此操作将替换旧配对。', 'The host certificate changed. This replaces the previous pairing.') : '')
        if (!root.confirm(prompt) || !ctx.valid()) return
        // Reuse a credential only after the current authenticated host confirms
        // this exact certificate and public origin. Never send host A's token to B.
        let sameHost = false
        try {
          const response = await root.fetch(ctx.url('/relay'), { headers: ctx.headers, signal: root.AbortSignal.timeout(8000) })
          const host = response.ok ? await response.json() : null
          sameHost = host?.e2ee?.fingerprint === pair.fingerprint && new URL(host.publicUrl).origin === url.origin
        } catch {}
        if (!ctx.valid()) return
        const result = JSON.parse(bridge.configure(json, old.fingerprint || ''))
        if (result.error || !result.origin) throw Error('E2EE_IMPORT_FAILED')
        selectedOrigin = result.origin
        changed(result.origin)
        status.textContent = sameHost ? text('加密配对已保存，连接时将校验主机证书。', 'Pairing saved. The host certificate will be verified when connecting.')
          : text('加密配对已保存。请在主机与连接中选择对应公网地址并填写该主机的访问令牌，当前连接的凭证不会自动复用。', 'Pairing saved. Select its public URL in Hosts and connections and enter that host’s access token. The current credential will not be reused automatically.')
        if (sameHost) onConnect?.(result.origin, ctx)
        renderMode()
      } catch { if (ctx.valid()) status.textContent = text('配对导入失败，请检查文件、有效期和主机配置；不会使用旧链路重试。', 'Pairing import failed. Check the file, expiry and host configuration. No legacy fallback will be attempted.') }
      finally { button.disabled = false }
    })
  } }
})(typeof window !== 'undefined' ? window : globalThis)
