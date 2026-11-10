/* Native browser APIs only. The operator, never this page, verifies actual payment. */
;(function () {
  'use strict'
  const $ = id => document.getElementById(id)
  const message = (text, target = $('message')) => {
    $('message').textContent = text
    if (target !== $('message')) target.textContent = text
    if (text) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  const when = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）'
  let running = false, pageGeneration = 0
  const errors = { PILOT_FULL: '当前名额已满，请勿付款。', APPLICATIONS_PAUSED: '当前暂停新申请，请勿付款。', TRY_LATER: '操作较频繁，请稍后再试。', APPLICATION_EXPIRED: '编号预留已到期。已付款请保留截图联系运营者，切勿重复付款。', APPLICATION_NOT_EDITABLE: '申请已提交或编号已到期，请刷新进度确认，切勿重复付款。', EMAIL_ALREADY_ACTIVE: '此邮箱已有待审核或有效资格，暂不能预付下个月。', RECEIPT_ALREADY_USED: '这笔到账已用于其他申请，不能重复开通。', VERIFIED_RECEIPT_REQUIRED: '请核实到账并填写收款端交易编号。', INVALID_SCREENSHOT: '请选择不超过 2MiB 的 PNG、JPG 或 WebP 付款截图。', MINIMUM_ONE_YUAN: '赞助金额至少为1元。', INVALID_AMOUNT: '请填写正确的赞助金额，最多两位小数。', INVALID_EMAIL: '请填写有效的接收邮箱。', UNAUTHORIZED: '审核密钥无效。', APPLICATION_UNAUTHORIZED: '申请查询凭证无效，请保留付款信息联系运营者。', DELIVERY_INACTIVE: '该开通信息已到期、撤销或被后续申请替换。', DELIVERY_KEY_UNAVAILABLE: '无法解密交付密钥，请检查服务端审核密钥是否被更换。', REVIEW_NOTE_REQUIRED: '请填写未通过原因及后续处理方式。' }
  Object.assign(errors, {
    CLOSED: '当前无法执行此操作，请查看营业时间或暂停提示。',
    EMAIL_NOT_VERIFIED: '请先验证接收邮箱。',
    EMAIL_VERIFICATION_COOLDOWN: '请在上次发送 60 秒后重发。',
    VERIFY_SEND_LIMIT: '此申请 24 小时内最多发送 5 次验证码。',
    INVALID_CODE: '验证码错误。',
    CODE_EXPIRED: '验证码已过期，请重新发送。',
    TOO_MANY_ATTEMPTS: '验证码错误次数已达上限，请重新发送。'
  })
  async function api(route, { token, data, blob } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await fetch('/sponsor/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), credentials: 'omit', cache: 'no-store', signal: controller.signal })
      if (blob && response.ok) return await response.blob()
      const result = await response.json()
      if (!response.ok) {
        const attempts = result.error === 'INVALID_CODE' && Number.isInteger(result.attemptsLeft) ? '剩余 ' + result.attemptsLeft + ' 次。' : ''
        throw Error((errors[result.error] || '操作未完成：' + result.error) + attempts)
      }
      return result
    } finally { clearTimeout(timer) }
  }
  async function run(button, fn, notice = $('message')) {
    if (button.disabled || running) return
    const version = pageGeneration
    running = true
    button.disabled = true; button.setAttribute('aria-busy', 'true'); message('', notice)
    try { await fn() } catch (error) { if (version === pageGeneration) message(error.name === 'AbortError' || error instanceof TypeError ? '结果尚未确认，请刷新进度后再决定是否重试。不要重复付款。' : error.message || '暂时无法连接，请稍后刷新确认。', notice.closest('[hidden]') ? $('message') : notice) }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); running = false }
  }
  if (document.body.hasAttribute('data-admin')) {
    const reviewNotice = $('review-message') || $('message'), revokeNotice = $('revoke-message') || $('message'), deliveryNotice = $('delivery-message') || $('message')
    let token = '', selected = '', proofUrl = '', generation = 0, rows = [], settings = null
    function clear() {
      generation++; pageGeneration++; token = ''; selected = ''; rows = []; settings = null; $('admin-token').value = ''; $('applications').replaceChildren()
      $('review').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-email').textContent = ''; $('delivery-subject').value = ''; $('review-info').textContent = ''; $('review-title').textContent = ''; $('receipt').value = ''; $('verified').checked = false
      $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''; message('')
      $('admin-capacity').textContent = ''; $('reject-note').value = ''; reviewNotice.textContent = ''; revokeNotice.textContent = ''; deliveryNotice.textContent = ''
      $('reload').hidden = true
      $('admin-controls').hidden = $('revoke-panel').hidden = true; $('revoke-note').value = ''; $('revoke-confirm').checked = false; $('revoke-title').textContent = ''; $('search').value = ''; $('filter').value = 'all'; $('accepting-status').textContent = ''
    }
    async function load() {
      const version = generation, [data, config] = await Promise.all([api('admin/applications', { token }), api('admin/config', { token })])
      if (version !== generation) return
      $('reload').hidden = false
      $('admin-capacity').textContent = '剩余可申请名额 ' + data.capacity.remaining + ' / ' + data.capacity.maxUsers + '。获取编号即预留90分钟，待审核申请和有效资格也占用名额。验证码服务' + (config.mailerOnline ? '在线。' : '离线。')
      rows = data.applications; settings = config; $('admin-controls').hidden = false
      $('accepting-status').textContent = config.emergencyPaused ? '环境配置已紧急暂停新申请。' : config.accepting ? '正在接受新申请。' : '已暂停新申请。'
      $('toggle-accepting').textContent = config.accepting ? '暂停新申请' : '恢复新申请'; $('toggle-accepting').disabled = config.emergencyPaused
      renderRows(version)
    }
    function renderRows(version = generation) {
      $('applications').replaceChildren()
      const filter = $('filter').value, query = $('search').value.trim().toLowerCase()
      for (const row of rows.filter(row => (filter === 'all' || filter === 'unsent' && row.status === 'approved' && !row.deliveredAt || row.status === filter) && (!query || (row.id + ' ' + row.email).toLowerCase().includes(query)))) {
        const card = document.createElement('article'); card.className = 'card'
        const heading = document.createElement('h2'); heading.textContent = row.id
        const info = document.createElement('p'); info.textContent = row.email + ' · ¥' + (row.amountCents / 100).toFixed(2) + ' · ' + ({ submitted: '待审核', approved: row.deliveredAt ? '已标记发送' : '已通过，待发送', rejected: '未通过', expired: '已到期', revoked: '已撤销' }[row.status] || row.status) + (row.expiresAt ? '\n有效期至 ' + when(row.expiresAt) + (row.bound ? ' · 已绑定网关' : ' · 未绑定网关') : '') + (row.note ? '\n处理说明：' + row.note : '')
        info.textContent += row.emailVerified ? ' · 邮箱已验证' : ' · 邮箱未验证'
        if (row.usage) info.textContent += row.usage.unavailable ? '\n云端流量账本暂不可读，传输暂停。' : '\n' + (row.usage.online ? '网关在线' : '网关离线') + ' · 本服务月已用 ' + (Number(row.usage.usedBytes) / 1e9).toFixed(2) + ' / ' + (Number(row.usage.limitBytes) / 1e9).toFixed(2) + ' GB'
        card.append(heading, info)
        if (['submitted', 'approved'].includes(row.status)) {
          const button = document.createElement('button'); button.textContent = row.status === 'submitted' ? '查看付款并审核' : '读取开通邮件'
          button.addEventListener('click', () => void run(button, async () => {
            if (row.status === 'approved') return delivery(row.id)
            const image = await api('admin/applications/' + row.id + '/proof', { token, blob: true })
            if (version !== generation) return
            selected = row.id; $('revoke-panel').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-email').textContent = ''; $('delivery-subject').value = ''; $('review').hidden = false
            $('review-title').textContent = row.id; $('review-info').textContent = info.textContent
            if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = URL.createObjectURL(image); $('review-proof').src = proofUrl
            $('receipt').value = ''; $('verified').checked = false; $('reject-note').value = ''; reviewNotice.textContent = ''
            $('review').scrollIntoView({ behavior: 'smooth', block: 'start' })
          }))
          card.append(button)
          if (row.status === 'approved') {
            const revoke = document.createElement('button'); revoke.textContent = '撤销资格'; revoke.className = 'secondary'
            revoke.addEventListener('click', () => {
              if (running || version !== generation) return
              selected = row.id; $('review').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-subject').value = ''; $('delivery-email').textContent = ''
              $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''
              $('revoke-title').textContent = '撤销资格 · ' + row.id; $('revoke-panel').hidden = false; $('revoke-note').value = ''; $('revoke-confirm').checked = false; revokeNotice.textContent = ''
              $('revoke-panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
            }); card.append(revoke)
          }
        }
        $('applications').append(card)
      }
    }
    async function delivery(id) {
      const version = generation, data = await api('admin/applications/' + id + '/delivery', { token })
      if (version !== generation) return
      selected = id; $('review').hidden = $('revoke-panel').hidden = true; $('delivery').hidden = false
      $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''
      $('delivery-email').textContent = '收件人：' + data.email; $('delivery-subject').value = data.subject; $('delivery-text').value = data.text; deliveryNotice.textContent = ''
      $('delivery').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const login = $('admin-form')
    login.addEventListener('submit', event => {
      event.preventDefault()
      if (running) return
      const entered = $('admin-token').value
      clear(); token = entered
      void run(event.submitter || login.querySelector('button'), load)
    })
    $('logout').addEventListener('click', clear)
    $('reload').addEventListener('click', () => void run($('reload'), load))
    $('filter').addEventListener('change', () => renderRows())
    $('search').addEventListener('input', () => renderRows())
    $('toggle-accepting').addEventListener('click', () => { const version = generation; void run($('toggle-accepting'), async () => { await api('admin/config', { token, data: { accepting: !settings.accepting } }); if (version === generation) await load() }) })
    $('revoke').addEventListener('click', () => { const id = selected, version = generation; void run($('revoke'), async () => {
      if (!$('revoke-confirm').checked) throw Error('请先确认撤销资格。')
      await api('admin/applications/' + id + '/revoke', { token, data: { note: $('revoke-note').value.trim() } })
      if (version !== generation) return
      $('revoke-panel').hidden = true; await load(); message('使用资格已撤销。请另行完成通知或退款。')
    }, revokeNotice) })
    const receiptError = '请填写微信收款记录中的真实交易编号（8–120 位字母、数字、下划线或连字符）。'
    $('receipt').addEventListener('invalid', () => message(receiptError, reviewNotice))
    $('verified').addEventListener('invalid', () => message('请先核实微信真实到账，并勾选核验确认。', reviewNotice))
    $('review-form').addEventListener('submit', event => {
      event.preventDefault(); const id = selected, version = generation
      void run($('approve'), async () => {
        const receipt = $('receipt').value.trim()
        if (!/^[A-Za-z0-9_-]{8,120}$/.test(receipt)) throw Error(receiptError)
        if (!$('verified').checked) throw Error('请先核实微信真实到账，并勾选核验确认。')
        await api('admin/applications/' + id + '/approve', { token, data: { verified: true, receipt } })
        if (version !== generation) return
        $('review').hidden = true
        try { await load(); if (version !== generation) return; await delivery(id) }
        catch (error) { throw Error('审核已通过，但页面刷新或开通邮件读取失败：' + error.message + ' 请点击“刷新申请”，从“待发送”读取开通邮件，无需再次审批。') }
        if (version === generation) message('审核通过。请发送开通邮件，实际发出后再标记。', deliveryNotice)
      }, reviewNotice)
    })
    $('reject').addEventListener('click', () => { const id = selected, version = generation; void run($('reject'), async () => { await api('admin/applications/' + id + '/reject', { token, data: { note: $('reject-note').value.trim() } }); if (version !== generation) return; $('review').hidden = true; await load(); message('已记录未通过原因。需要联系对方或退款时，请另行完成。') }, reviewNotice) })
    $('copy-mail').addEventListener('click', () => void run($('copy-mail'), async () => { await navigator.clipboard.writeText($('delivery-text').value); message('邮件正文已复制。', deliveryNotice) }, deliveryNotice))
    $('delivered').addEventListener('click', () => { const id = selected, version = generation; void run($('delivered'), async () => { await api('admin/applications/' + id + '/delivered', { token, data: {} }); if (version !== generation) return; await load(); message('已标记人工发送。', deliveryNotice) }, deliveryNotice) })
    window.addEventListener('pagehide', clear)
    return
  }
  const storageKey = 'dsh-relay-sponsor-application-v1'
  let application = null, status = null, config = null, qrUrl = '', cooldown = 0, pollTimer, cooldownTimer, mailerTimer, stopped = false
  try { application = JSON.parse(sessionStorage.getItem(storageKey)) } catch {}
  if (!/^R[A-F0-9]{16}$/.test(application?.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(application?.token || '')) application = null
  function save() { try { sessionStorage.setItem(storageKey, JSON.stringify(application)) } catch { message('此浏览器不能保存申请进度，请勿关闭本页，提交后保留申请编号。') } }
  function recovery() {
    $('recovery-label').hidden = $('copy-recovery').hidden = !application
    $('recovery-code').value = application ? application.id + '.' + application.token : ''
  }
  function clearQr() {
    if (qrUrl) URL.revokeObjectURL(qrUrl)
    qrUrl = ''; $('qr').removeAttribute('src'); $('payment').hidden = true
  }
  function updateCountdown() {
    clearTimeout(cooldownTimer)
    const seconds = Math.max(0, Math.ceil((cooldown - performance.now()) / 1000))
    $('send-code').disabled = !config?.mailerOnline || !config.emailSendingOpen || seconds > 0
    $('send-code').textContent = seconds ? '重发验证码（' + seconds + ' 秒）' : status?.email ? '重新发送验证码' : '发送验证码'
    if (seconds && !$('verification').hidden && !stopped) cooldownTimer = setTimeout(updateCountdown, 1000)
  }
  function controls() {
    const hours = (config?.hours || '09:00-23:00').replace('-', '–')
    $('capacity').textContent = !config ? '暂时无法确认申请名额，请勿付款。'
      : config.reason === 'hours' ? '当前非营业时间（每天 ' + hours + '），暂不接收新申请。请在营业时间内再来。已有编号的申请不受影响。下次开放时间：' + when(config.opensAt)
      : !config.open ? '当前暂停新申请。已有编号的申请可继续办理。'
      : config.remaining ? '当前仍有申请名额，请先获取编号并验证邮箱再付款。' : '当前名额已满，请勿付款。'
    $('begin').hidden = !!application || config?.open === false
    $('begin').disabled = !!application || !config?.open || !config.remaining
    $('mailer-status').hidden = config?.mailerOnline !== false
    $('verification-hours').hidden = config?.emailSendingOpen !== false
    if (!config?.mailerOnline) clearQr()
    updateCountdown()
  }
  function showStatus(value) {
    if (status?.id !== value.id || status?.email !== value.email) $('email').value = value.email || ''
    status = value
    const draft = value.status === 'draft', verified = draft && value.emailVerified
    $('verification').hidden = !draft || verified
    $('submission').hidden = !verified
    if (!verified) clearQr()
    const activeCode = value.verifyExpiresAt > value.serverTime
    $('verify-form').hidden = !activeCode
    $('verification-hint').textContent = value.verifyError ? '该邮箱收不到信（' + value.verifyError + '），请换一个常用邮箱。'
      : activeCode ? '验证码 1 分钟内送达，请检查垃圾邮件/广告邮件文件夹。'
      : value.verifyExpiresAt ? '验证码已过期，请重新发送。' : ''
    cooldown = performance.now() + Math.max(0, (value.cooldownUntil || 0) - (value.serverTime || 0))
    $('draft-reservation').textContent = draft ? '编号预留至 ' + when(value.reservedUntil) + '。' : ''
    $('application-id').textContent = value.id
    $('verified-email').textContent = verified ? '已验证邮箱：' + value.email : ''
    $('reservation').textContent = verified ? '该编号预留名额至 ' + when(value.reservedUntil) + '。请在此之前完成付款并提交；提交后保留名额等待审核。' : ''
    $('progress').hidden = false
    $('restart').hidden = !['expired', 'rejected', 'revoked'].includes(value.status)
    $('status').textContent = application.id + '\n' + ({ draft: verified ? '邮箱已验证，等待付款并提交申请。' : '等待验证接收邮箱。', submitted: '已提交，等待人工审核。请勿重复付款，密钥将发送至你填写的邮箱。', approved: '审核通过。' + (value.deliveredAt ? '运营者已标记发送，请检查收件箱及垃圾邮件。' : '等待运营者发送密钥与使用说明。') + '有效期至 ' + when(value.expiresAt), rejected: '申请未通过：' + value.note, revoked: '使用资格已撤销：' + (value.note || '请联系运营者核对。'), expired: value.approvedAt ? '本次使用资格已到期。如果试运营仍开放，可重新申请一个月。' : '编号预留已到期。已经付款请保留截图联系运营者，勿重复付款。' }[value.status] || value.status)
    controls()
  }
  async function refresh(version = pageGeneration, value) {
    const current = application
    if (!current || stopped) return
    recovery()
    const route = 'applications/' + current.id, token = current.token
    value ||= await api(route, { token })
    if (version !== pageGeneration) return
    showStatus(value)
    if (value.status !== 'draft' || !value.emailVerified || !config?.mailerOnline || qrUrl) return
    const image = await api(route + '/qr', { token, blob: true })
    if (version !== pageGeneration || !config?.mailerOnline) return
    qrUrl = URL.createObjectURL(image); $('qr').src = qrUrl; $('payment').hidden = false
  }
  async function applicantAction(button, fn) {
    if (button.disabled || running) return
    pageGeneration++
    await run(button, fn)
    controls()
  }
  async function poll(first = false) {
    const version = pageGeneration
    try {
      if (running) return
      try {
        const started = performance.now()
        const value = await api('config')
        if (version !== pageGeneration) return
        config = value
        clearTimeout(mailerTimer)
        if (value.mailerOnline) {
          const remaining = value.mailerOnlineUntil - value.serverTime - (performance.now() - started)
          if (remaining <= 0) value.mailerOnline = false
          else mailerTimer = setTimeout(() => { value.mailerOnline = false; controls() }, remaining)
        }
      } catch (error) {
        if (version === pageGeneration) { clearTimeout(mailerTimer); config = null; controls() }
        throw error
      }
      if (config.contactEmail && $('contact').hidden) {
        const link = document.createElement('a'); link.textContent = config.contactEmail; link.href = 'mailto:' + encodeURIComponent(config.contactEmail)
        $('contact').textContent = '到账核对、补充材料或退款联系：'; $('contact').append(link); $('contact').hidden = false
      }
      controls()
      if (first || !status || status.status === 'draft') await refresh(version)
    } catch (error) {
      if (version === pageGeneration) { clearQr(); if (first) message(error.message) }
    } finally {
      clearTimeout(pollTimer)
      if (!stopped) pollTimer = setTimeout(poll, 5000)
    }
  }
  $('copy-recovery').addEventListener('click', () => void run($('copy-recovery'), async () => { await navigator.clipboard.writeText($('recovery-code').value); message('查询凭证已复制，请私下保存。它不能用来连接中转。') }))
  $('restore-form').addEventListener('submit', event => {
    event.preventDefault()
    void applicantAction($('restore'), async () => {
      const code = $('restore-code').value.trim(), match = /^(R[A-F0-9]{16})\.([A-Za-z0-9_-]{43})$/.exec(code)
      $('restore-code').value = ''
      if (!match) throw Error('查询凭证格式不正确，请粘贴完整凭证。')
      const restored = { id: match[1], token: match[2] }
      // Verify before replacing the existing application; wrong credentials cannot lose it.
      const value = await api('applications/' + restored.id, { token: restored.token })
      clearQr(); $('verify-code').value = ''
      application = restored; save(); await refresh(pageGeneration, value)
    })
  })
  $('begin').addEventListener('click', () => void applicantAction($('begin'), async () => { application = await api('applications', { data: {} }); save(); await refresh() }))
  $('email-form').addEventListener('submit', event => {
    event.preventDefault()
    void applicantAction($('send-code'), async () => {
      await api('applications/' + application.id + '/email', { token: application.token, data: { email: $('email').value.trim() } })
      cooldown = performance.now() + 60000; $('verify-code').value = ''
      await refresh()
    })
  })
  $('verify-form').addEventListener('submit', event => {
    event.preventDefault()
    void applicantAction($('verify'), async () => {
      const code = $('verify-code').value
      await api('applications/' + application.id + '/verify', { token: application.token, data: { code } })
      $('verify-code').value = ''; await refresh()
    })
  })
  $('copy-id').addEventListener('click', () => void run($('copy-id'), async () => { await navigator.clipboard.writeText(application.id); message('已复制，请将编号填写在微信付款备注中。') }))
  $('refresh').addEventListener('click', () => void applicantAction($('refresh'), refresh))
  $('restart').addEventListener('click', () => { application = null; try { sessionStorage.removeItem(storageKey) } catch {}; location.reload() })
  $('application-form').addEventListener('submit', event => {
    event.preventDefault()
    void applicantAction($('submit'), async () => {
      const file = $('proof').files[0]
      if (!file || file.size > 2 * 1024 * 1024) throw Error(errors.INVALID_SCREENSHOT)
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('截图读取失败')); reader.readAsDataURL(file) })
      await api('applications/' + application.id, { token: application.token, data: { amount: $('amount').value, screenshot: data } })
      $('proof').value = ''; await refresh()
    })
  })
  window.addEventListener('pagehide', () => {
    stopped = true; pageGeneration++
    clearTimeout(pollTimer); clearTimeout(cooldownTimer); clearTimeout(mailerTimer); clearQr()
  })
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void poll(true) } })
  recovery()
  void poll(true)
})()
