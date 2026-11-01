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
    if (value.secure && !/^(?:http|ws):\/\/127\.0\.0\.1:\d+\/e2ee-[a-f0-9]{48}\//.test(value.url)) throw new Error('E2EE_TRANSPORT_UNAVAILABLE')
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
    try { return !JSON.parse(bridge.info(new URL(String(input), root.location.href).origin)).configured } catch { return false }
  }
  const externalNotice = () => root.alert?.(root.I18N?.lang === 'en' ? 'This paired host requires the encrypted connection inside the app. Open management locally on your host.' : '此主机已启用加密配对，请在应用内使用；管理页面请从主机本地打开。')
  if (root.open) {
    const open = root.open.bind(root)
    root.open = (url, ...args) => { if (!externalAllowed(url)) { externalNotice(); return null }; return open(url, ...args) }
  }
  root.document?.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a[href]')
    if (anchor && !externalAllowed(anchor.href)) { event.preventDefault(); event.stopImmediatePropagation(); externalNotice() }
  }, true)
  root.DshE2eeTransport = { resolve, mount(target, { connection, onConnect } = {}) {
    if (!target || target.dataset.e2eeMounted) return
    target.dataset.e2eeMounted = 'true'
    const en = () => root.I18N?.lang === 'en', text = (zh, english) => en() ? english : zh
    const title = document.createElement('h3'), explanation = document.createElement('p'), button = document.createElement('button'), status = document.createElement('p')
    const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true
    title.textContent = text('端到端加密配对（试验）', 'End-to-end pairing (experimental)')
    explanation.textContent = text('仅导入从自己主机本地取得的配对文件。需要主机启用加密中转；配对后此公网地址的请求只走加密通道，失败时不会降级。', 'Import a pairing file obtained locally from your own host. The host must enable encrypted relay. Requests to the paired public URL never fall back to the legacy connection.')
    button.type = 'button'; button.textContent = text('导入本机配对文件', 'Import local pairing file')
    status.setAttribute('role', 'status'); target.append(title, explanation, button, file, status)
    if (bridge.supported?.() === false) { button.disabled = true; status.textContent = text('此系统不支持 TLS 1.3，请升级 Android 后使用加密中转。', 'This system does not support TLS 1.3. Upgrade Android to use encrypted relay.') }
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
        changed(result.origin)
        status.textContent = sameHost ? text('加密配对已保存，连接时将校验主机证书。', 'Pairing saved. The host certificate will be verified when connecting.')
          : text('加密配对已保存。请在主机与连接中选择对应公网地址并填写该主机的访问令牌，当前连接的凭证不会自动复用。', 'Pairing saved. Select its public URL in Hosts and connections and enter that host’s access token. The current credential will not be reused automatically.')
        if (sameHost) onConnect?.(result.origin, ctx)
      } catch { if (ctx.valid()) status.textContent = text('配对导入失败，请检查文件、有效期和主机配置；不会使用旧链路重试。', 'Pairing import failed. Check the file, expiry and host configuration. No legacy fallback will be attempted.') }
      finally { button.disabled = false }
    })
  } }
})(typeof window !== 'undefined' ? window : globalThis)
