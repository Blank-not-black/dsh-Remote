/* Bootstrap a device pairing through an authenticated, user-confirmed LAN host. */
;(function(root) {
  'use strict'
  const bridge = root.NativeE2ee, attempts = new Set(), pairedOrigins = new Map(), progress = new Map()
  let busy = false
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const LOG_KEY = 'dshRelayPairLogV1', LOG_MAX = 240, WAIT_LIMIT_SECONDS = 90, WAIT_STEP_MS = 2000
  let log = []
  try {
    const saved = JSON.parse(root.localStorage?.getItem(LOG_KEY) || '[]')
    if (Array.isArray(saved)) log = saved.filter(row => row && typeof row === 'object' && typeof row.at === 'number' && typeof row.step === 'string').slice(-LOG_MAX)
  } catch {}
  function persist() { try { root.localStorage?.setItem(LOG_KEY, JSON.stringify(log.slice(-LOG_MAX))) } catch {} }
  function scalar(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'boolean' || typeof value === 'string') return typeof value === 'string' ? value.slice(0, 200) : value
    return undefined
  }
  function record(step, detail = {}) {
    const row = { at: Date.now(), step: String(step).slice(0, 40) }
    for (const [key, value] of Object.entries(detail || {})) {
      const clean = scalar(value)
      if (clean !== undefined) row[String(key).slice(0, 32)] = clean
    }
    log.push(row)
    if (log.length > LOG_MAX) log = log.slice(-LOG_MAX)
    persist()
    return row
  }
  function logText() {
    return log.slice(-150).map(row => {
      const rest = {}
      for (const [key, value] of Object.entries(row)) if (key !== 'at' && key !== 'step') rest[key] = value
      return `${new Date(row.at).toISOString()} ${row.step}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}`
    }).join('\n')
  }
  function clearLog() { log = []; persist() }
  function fail(code) { const error = new Error(code); error.code = code; return error }
  function localUrl(value) {
    try {
      const u = new URL(value), h = u.hostname.replace(/^\[|\]$/g, '')
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false
      if (h === 'localhost' || h === '::1' || h.includes(':') && /^(?:fc|fd|fe[89ab])[a-f0-9:]*$/i.test(h)) return true
      const parts = h.split('.').map(Number)
      if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false
      const [a, b] = parts
      return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31
    } catch { return false }
  }
  const reason = (code, error) => {
    const table = {
      E2EE_NATIVE_UNAVAILABLE: ['自动配对仅支持 Android App（0.8.5 及以上）；浏览器请使用“导入本机配对文件”。', 'Auto pairing runs in the Android app (0.8.5+). In a browser, import a pairing file instead.'],
      E2EE_TLS_UNAVAILABLE: ['此设备不支持 TLS 1.3，无法使用端到端加密。', 'This device does not support TLS 1.3, so end-to-end encryption is unavailable.'],
      E2EE_BUSY: ['正在配置配对，请稍候。', 'Pairing is already in progress.'],
      E2EE_CONNECTION_INVALID: ['当前连接已失效，请重新连接局域网地址。', 'The current connection is no longer valid. Reconnect to the LAN address.'],
      E2EE_NOT_LOCAL: ['请先连接自己电脑的局域网地址，再配置公网配对。', 'Connect to your computer’s LAN address before configuring relay pairing.'],
      E2EE_HOST_UNAVAILABLE: ['局域网主机没有响应，请确认电脑上的 Remote 网关正在运行。', 'The LAN host did not respond. Make sure the Remote gateway is running on the computer.'],
      E2EE_LOCAL_ONLY: ['主机没有把这次请求识别为直接局域网连接，无法创建配对。', 'The host did not treat this request as a direct LAN connection, so it cannot create a pairing.'],
      E2EE_HOST_NOT_ENCRYPTED: ['电脑尚未开启端到端加密中转；请先在电脑本机开启后再试。', 'Encrypted relay is not enabled on the computer. Enable it locally first.'],
      E2EE_HOST_INVALID: ['主机返回的公网地址或证书指纹无效。', 'The host returned an invalid public address or certificate fingerprint.'],
      E2EE_HOST_MISMATCH: ['主机证书与返回的公网地址不匹配。', 'The host certificate does not match the returned public address.'],
      E2EE_STORAGE_UNAVAILABLE: ['手机保存配对失败，请检查存储空间后重试。', 'The phone could not store the pairing. Check storage and retry.'],
      E2EE_CANCELLED: ['已取消自动配对。', 'Automatic pairing was cancelled.'],
      E2EE_PAIR_REQUEST_FAILED: ['未收到电脑的配对回执。请先在电脑的中转设备列表检查是否已经创建，再决定是否重试。', 'The computer did not return a pairing receipt. Check its relay device list before retrying.'],
      E2EE_NOT_CONFIGURED: ['电脑尚未开启端到端加密中转。', 'Encrypted relay is not enabled on the computer.'],
      E2EE_PAIRING_CHANGED: ['主机证书已变化，请在手机上重新确认后重试。', 'The host certificate changed. Confirm again on the phone and retry.'],
      LOCAL_PAIRING_REQUIRED: ['配对请求必须来自直接局域网连接。', 'The pairing request must come from a direct LAN connection.'],
      RELAY_OPERATION_BUSY: ['主机正在处理另一项中转操作，请稍后重试。', 'The host is busy with another relay operation. Retry shortly.'],
      E2EE_SETUP_ALREADY_USED: ['电脑已收到这张连接码的配对请求。若手机未保存配对，请在电脑关闭连接码，再生成新码。', 'The computer already received a pairing for this code. If the phone did not save it, close the code on the computer and generate a new one.'],
      E2EE_DEVICE_LIMIT: ['这台主机的配对设备数量已达上限。', 'This host has reached its paired-device limit.'],
      E2EE_PAIRING_INVALID: ['主机返回的配对数据不完整或无效。', 'The host returned incomplete or invalid pairing data.'],
      E2EE_IMPORT_FAILED: ['手机未能保存配对（证书可能已变化）。', 'The phone could not store the pairing (the certificate may have changed).'],
      E2EE_RELAY_OFFLINE: ['配对已保存，但主机公网通道在约 90 秒内未就绪；请稍后重试。局域网连接保留。', 'The pairing was saved, but the host relay channel did not become ready within about 90 seconds. Retry later; the LAN connection is kept.'],
      E2EE_SESSION_VERIFY_FAILED: ['已验证公网主机身份，但未能读取会话列表。请检查电脑上的 DSH 后重新验证。', 'The public host identity was verified, but the session list could not be read. Check DSH on the computer, then verify again.'],
      E2EE_VERIFY_FAILED: ['公网通道已在线，但主机身份验证未通过，请稍后重试。局域网连接保留。', 'The relay channel was online but the host identity check failed. Retry later; the LAN connection is kept.'],
      E2EE_BAD_RESPONSE: ['主机返回了无法解析的响应。', 'The host returned an unreadable response.'],
    }
    const entry = table[code] || ['公网配对尚未完成，局域网连接保留。请到云服务器中转重试；不会自动关闭加密。', 'Relay pairing did not complete. The LAN connection is kept; retry from Cloud relay. Encryption is never disabled automatically.']
    const status = error?.httpStatus ? ` HTTP ${error.httpStatus}` : ''
    return text(`${entry[0]}（${code}${status}）`, `${entry[1]} (${code}${status})`)
  }
  async function read(c, url, timeout = 8000, options = {}) {
    let response
    try {
      response = await root.fetch(url, { headers: c.headers, cache: 'no-store', redirect: 'error', signal: root.AbortSignal.timeout(timeout), ...options })
    } catch {
      throw fail('E2EE_HOST_UNAVAILABLE')
    }
    if (!response.ok) {
      const error = fail('E2EE_HTTP_' + response.status)
      error.httpStatus = response.status
      throw error
    }
    try { return await response.json() } catch { throw fail('E2EE_BAD_RESPONSE') }
  }
  async function waitOnline(c, endpoint, onProgress) {
    let last = ''
    const started = Date.now(), deadline = started + WAIT_LIMIT_SECONDS * 1000
    while (c.valid() && Date.now() < deadline) {
      try {
        const status = await read(c, endpoint.href, Math.max(1, Math.min(8000, deadline - Date.now())))
        const phase = String(status?.phase || 'unknown')
        if (phase !== last) { last = phase; record('relay.phase', { phase }) }
        if (phase === 'online') return true
      } catch (error) {
        record('relay.phase.error', { code: error?.code || 'E2EE_HOST_UNAVAILABLE', httpStatus: error?.httpStatus })
      }
      if (!c.valid()) return false
      onProgress?.(Math.min(WAIT_LIMIT_SECONDS, Math.floor((Date.now() - started) / 1000)))
      const remaining = deadline - Date.now()
      if (remaining > 0) await new Promise(resolve => root.setTimeout(resolve, Math.min(WAIT_STEP_MS, remaining)))
    }
    return false
  }
  async function verifyIdentity(c, origin, pin) {
    for (let attempt = 1; attempt <= 4 && c.valid(); attempt++) {
      try {
        const remote = await read(c, origin + '/relay')
        if (remote?.e2ee?.fingerprint !== pin || new URL(remote.publicUrl).origin !== origin) throw fail('E2EE_HOST_MISMATCH')
        record('verify', { attempt, ok: true })
        return true
      } catch (error) {
        record('verify', { attempt, ok: false, code: error?.code || 'E2EE_HOST_UNAVAILABLE', httpStatus: error?.httpStatus })
      }
      if (attempt < 4 && c.valid()) await new Promise(resolve => root.setTimeout(resolve, 1000))
    }
    return false
  }
  async function verifySessions(c, origin) {
    const method = 'session.list', rpcId = 'relay-check-' + Date.now()
    try {
      const response = await read(c, origin + '/api/' + method, 8000, {
        method: 'POST',
        headers: { ...c.headers, 'content-type': 'application/json', 'x-dsh-remote-client': 'app' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: {} }),
      })
      return response?.result?.ok === true && Array.isArray(response.result.value?.items)
    } catch { return false }
  }
  function contextKey(c) {
    return JSON.stringify([new URL(c.url('/relay'), root.location.href).origin, c.headers?.authorization || ''])
  }
  async function finish(c, endpoint, origin, pin, onPaired, notify) {
    notify(text('公网通道已在线，正在验证主机身份…', 'Relay channel is online. Verifying the host…'))
    if (!await verifyIdentity(c, origin, pin)) throw fail('E2EE_VERIFY_FAILED')
    if (!c.valid()) throw fail('E2EE_CONNECTION_INVALID')
    notify(text('公网主机身份已验证，正在读取会话列表…', 'Public host identity verified. Reading the session list…'))
    if (!await verifySessions(c, origin)) throw fail('E2EE_SESSION_VERIFY_FAILED')
    if (!c.valid()) throw fail('E2EE_CONNECTION_INVALID')
    pairedOrigins.set(endpoint.origin, origin)
    onPaired?.(origin, c)
    notify(text('电脑已确认配对，公网会话读取已验证。局域网连接保留。', 'The computer confirmed pairing and the session list was read over the relay. The LAN connection is kept.'), false, 'ready')
  }
  async function offer({ connection, onPaired, onStatus = () => {}, force = false }) {
    const manual = force === true
    let key = ''
    const notify = (message, error, phase = error ? 'error' : 'working') => {
      if (key) progress.set(key, { message, phase })
      onStatus?.(message, error === true)
    }
    if (!bridge?.configure) {
      if (manual) { record('skipped', { reason: 'native-unavailable' }); notify(reason('E2EE_NATIVE_UNAVAILABLE')) }
      return { ok: false, code: 'E2EE_NATIVE_UNAVAILABLE' }
    }
    if (bridge.supported?.() === false) {
      if (manual) { record('skipped', { reason: 'tls13-unavailable' }); notify(reason('E2EE_TLS_UNAVAILABLE')) }
      return { ok: false, code: 'E2EE_TLS_UNAVAILABLE' }
    }
    if (busy) {
      if (manual) notify(reason('E2EE_BUSY'))
      return { ok: false, code: 'E2EE_BUSY' }
    }
    const c = connection()
    if (!c.valid()) { if (manual) notify(reason('E2EE_CONNECTION_INVALID'), true); return { ok: false, code: 'E2EE_CONNECTION_INVALID' } }
    const endpoint = new URL(c.url('/relay'), root.location.href)
    if (!localUrl(endpoint.href)) {
      if (manual) { record('skipped', { reason: 'not-local' }); notify(reason('E2EE_NOT_LOCAL'), true) }
      return { ok: false, code: 'E2EE_NOT_LOCAL' }
    }
    if (!/^Bearer \S+$/i.test(c.headers?.authorization || '')) {
      if (manual) notify(reason('E2EE_CONNECTION_INVALID'), true)
      return { ok: false, code: 'E2EE_CONNECTION_INVALID' }
    }
    key = contextKey(c)
    const attempt = JSON.stringify([key, c.setupId || ''])
    if (!force && attempts.has(attempt)) return { ok: false, code: 'E2EE_ALREADY_ATTEMPTED' }
    attempts.add(attempt); busy = true
    const started = Date.now()
    record('start', { force: manual })
    try {
      notify(text('正在读取局域网主机信息…', 'Reading LAN host information…'))
      const host = await read(c, endpoint.href)
      record('host', { enabled: !!host?.enabled, canPairLocally: !!host?.canPairLocally, phase: host?.phase, e2ee: !!host?.e2ee?.enabled })
      if (!host?.canPairLocally) throw fail('E2EE_LOCAL_ONLY')
      if (!host.enabled || !host.e2ee?.configured || !host.e2ee.enabled) throw fail('E2EE_HOST_NOT_ENCRYPTED')
      const origin = new URL(host.publicUrl).origin, pin = host.e2ee.fingerprint
      if (new URL(host.publicUrl).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(pin || '')) throw fail('E2EE_HOST_INVALID')
      let old = {}
      try { old = JSON.parse(bridge.info(origin) || '{}') } catch { throw fail('E2EE_STORAGE_UNAVAILABLE') }
      if (old.configured && old.fingerprint === pin && !old.error && old.deviceId && old.expiresAt > Date.now()) {
        record('existing', { deviceId: old.deviceId })
        notify(text('已保留配对，正在等待公网通道就绪…', 'Saved pairing found. Waiting for the relay channel…'))
        if (host.phase !== 'online' && !await waitOnline(c, endpoint, seconds => notify(text(`已保留配对，正在等待公网通道就绪（${seconds}s）…`, `Saved pairing found. Waiting for the relay channel (${seconds}s)…`)))) throw fail('E2EE_RELAY_OFFLINE')
        await finish(c, endpoint, origin, pin, onPaired, notify)
        record('verified', { mode: 'existing', ms: Date.now() - started })
        return { ok: true, mode: 'existing' }
      }
      if (old.error && old.error !== 'E2EE_DEVICE_EXPIRED') throw fail('E2EE_STORAGE_UNAVAILABLE')
      const message = text('为这台手机自动配置公网加密连接？请确认当前局域网连接是你自己的电脑。\n局域网：', 'Automatically configure this phone’s encrypted relay? Confirm this LAN connection is your own computer.\nLAN: ')
        + endpoint.origin + '\n' + text('公网：', 'Public: ') + origin
        + (old.fingerprint && old.fingerprint !== pin ? '\n' + text('主机证书已改变，将替换旧配对。', 'The host certificate changed. This replaces the previous pairing.') : '')
      if (!root.confirm(message) || !c.valid()) {
        record('cancelled')
        notify(text('已取消自动配对。', 'Automatic pairing was cancelled.'), false, 'idle')
        return { ok: false, code: 'E2EE_CANCELLED' }
      }
      notify(text('正在通过局域网创建并保存配对…', 'Creating and storing the pairing over LAN…'))
      const pairUrl = new URL(endpoint.href); pairUrl.pathname = pairUrl.pathname.replace(/\/$/, '') + '/pair'
      let response, data = {}
      try {
        response = await root.fetch(pairUrl.href, { headers: { ...c.headers, 'content-type': 'application/json' }, cache: 'no-store', redirect: 'error', method: 'POST', body: JSON.stringify({ fingerprint: pin, label: text('Android 手机', 'Android phone'), ...(c.setupId ? {setupId:c.setupId} : {}) }), signal: root.AbortSignal.timeout(15000) })
        data = await response.json().catch(() => ({}))
      } catch { throw fail('E2EE_PAIR_REQUEST_FAILED') }
      record('pair.response', { httpStatus: response.status, error: typeof data?.error === 'string' ? data.error : '' })
      if (!c.valid()) { record('aborted'); return { ok: false, code: 'E2EE_CONNECTION_INVALID' } }
      if (!response.ok) throw fail(typeof data?.error === 'string' ? data.error : 'E2EE_HTTP_' + response.status)
      const pair = data.pairing, url = pair && new URL(pair.relayUrl)
      if (!pair || pair.fingerprint !== pin || url.origin !== origin || url.protocol !== 'https:' || url.pathname !== '/relay/v1/e2ee' || url.search || url.hash || url.username || url.password) throw fail('E2EE_PAIRING_INVALID')
      notify(text('电脑已收到并创建设备，正在保存到手机…', 'The computer received the request and created a device. Saving to this phone…'))
      record('paired', { deviceId: String(pair.deviceId || '').slice(0, 64), expiresAt: Number(pair.expiresAt) || 0 })
      const result = JSON.parse(bridge.configure(JSON.stringify(pair), old.fingerprint || ''))
      if (result?.error || result?.origin !== origin) throw fail('E2EE_IMPORT_FAILED')
      record('configured', { origin })
      notify(text('电脑已确认配对，手机已保存。正在等待公网通道就绪（最多约 90 秒）…', 'The computer confirmed pairing and the phone saved it. Waiting for the relay channel (up to about 90 seconds)…'))
      if (!await waitOnline(c, endpoint, seconds => notify(text(`配对已保存，正在等待主机公网通道就绪（${seconds}s）…`, `Pairing saved. Waiting for the host relay channel (${seconds}s)…`)))) throw fail('E2EE_RELAY_OFFLINE')
      await finish(c, endpoint, origin, pin, onPaired, notify)
      record('verified', { mode: 'new', ms: Date.now() - started })
      return { ok: true, mode: 'new' }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'E2EE_PAIR_FAILED'
      record('failed', { code, ms: Date.now() - started, httpStatus: error?.httpStatus })
      if (c.valid()) notify(reason(code, error), true)
      return { ok: false, code }
    } finally {
      if (!c.valid() && progress.get(key)?.phase === 'working') progress.delete(key)
      busy = false
    }
  }
  root.DshRelayAutoPair = { offer, localUrl, logText, clearLog,
    progress: c => { try { return progress.get(contextKey(c)) } catch { return undefined } }, pairedOrigin: value => { try { return pairedOrigins.get(new URL(value, root.location.href).origin) || '' } catch { return '' } } }
})(typeof window !== 'undefined' ? window : globalThis)
