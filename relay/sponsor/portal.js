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
    CLOSED: '当前暂停新申请。已有编号可继续办理。',
    MAIL_UNAVAILABLE: '邮件暂时未发出。可继续在申请页查询和留言。',
    EMAIL_VERIFICATION_COOLDOWN: '请在上次试发 60 秒后重试。',
    INVALID_CODE: '收信确认链接无效。',
    CODE_EXPIRED: '收信确认链接已失效。',
    INVALID_MESSAGE: '请输入 1 至 1500 字的留言。',
    MESSAGE_LIMIT: '本申请的留言已达到上限，请保留申请编号联系运营者。',
    EMAIL_ALREADY_ACTIVE: '该邮箱有待审核申请、有效资格或尚在续费期。请恢复原申请，切勿重复付款。',
    RENEWAL_UNAVAILABLE: '此资格当前不能续费。请刷新原申请，若已付款请在原申请留言。',
    RENEWAL_PAYMENT_OUTSIDE_WINDOW: '到账时间必须在该续费编号有效的付款窗口内，且不能晚于材料提交。请核对微信收款记录。',
    RENEWAL_TERM_ENDED: '拟续费的 30 天已结束，不能开通。请联系申请人处理。'
  })
  async function api(route, { token, data, blob } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await fetch('/sponsor/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), credentials: 'omit', cache: 'no-store', signal: controller.signal })
      if (blob && response.ok) return await response.blob()
      const result = await response.json()
      if (!response.ok) {
        throw Error(errors[result.error] || '操作未完成：' + result.error)
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
  function inbox(getContext, role) {
    let pending = null, displayed = 0
    const panel = $('inbox-panel'), field = $('message-text'), form = $('message-form')
    function clear() {
      pending = null; displayed = 0; field.value = ''; $('messages').replaceChildren()
    }
    function show(data) {
      $('messages').replaceChildren()
      for (const row of data.messages) {
        const item = document.createElement('li'), author = document.createElement('strong'), body = document.createElement('p')
        author.textContent = (row.sender === 'operator' ? '运营方' : '申请人') + ' · ' + when(row.at)
        body.textContent = row.text
        item.append(author, body); $('messages').append(item)
      }
      displayed = data.messages.at(-1)?.number || 0
      if (role === 'operator') $('notify-reply').hidden = !data.canNotify
    }
    async function refresh() {
      const ctx = getContext()
      if (!ctx || panel.hidden) return
      const data = await api(ctx.route + '/messages', { token: ctx.token })
      if (!ctx.valid()) return
      show(data)
      if (data.unread && displayed) await api(ctx.route + '/messages', { token: ctx.token, data: { seenThrough: displayed } })
    }
    form.addEventListener('submit', event => {
      event.preventDefault()
      void run($('send-message'), async () => {
        const ctx = getContext(), text = field.value.trim()
        if (!ctx || !text) return
        if (pending?.text !== text || pending.route !== ctx.route) {
          const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
          pending = { text, requestId, route: ctx.route }
        }
        const { requestId } = pending
        const data = await api(ctx.route + '/messages', { token: ctx.token, data: { text, requestId } })
        if (!ctx.valid()) return
        if (field.value.trim() === text) field.value = ''
        pending = null
        show(data)
      })
    })
    return { clear, refresh }
  }
  if (document.body.hasAttribute('data-admin')) {
    const paymentTemplate = $('renewal-payment-field')
    if (paymentTemplate?.content) $('review-form').prepend(paymentTemplate.content.cloneNode(true))
    const reviewNotice = $('review-message') || $('message'), revokeNotice = $('revoke-message') || $('message'), deliveryNotice = $('delivery-message') || $('message')
    let token = '', selected = '', proofUrl = '', generation = 0, rows = [], settings = null, thread = ''
    const adminInbox = inbox(() => {
      if (!thread || !token) return null
      const id = thread, current = generation
      return { route: 'admin/applications/' + id, token, valid: () => thread === id && generation === current }
    }, 'operator')
    function clear() {
      generation++; pageGeneration++; token = ''; selected = ''; rows = []; settings = null; thread = ''
      $('inbox').hidden = true; adminInbox.clear(); $('admin-token').value = ''; $('applications').replaceChildren()
      $('review').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-email').textContent = ''; $('delivery-subject').value = ''; $('review-info').textContent = ''; $('review-title').textContent = ''; $('receipt').value = ''; $('verified').checked = false
      $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''; message('')
      $('admin-capacity').textContent = ''; $('reject-note').value = ''; reviewNotice.textContent = ''; revokeNotice.textContent = ''; deliveryNotice.textContent = ''
      $('reload').hidden = true
      $('traffic-alerts').hidden = true; $('alerts-list').replaceChildren()
      $('diagnostics-summary').textContent = ''; $('diagnostics-list').replaceChildren()
      $('paid-at').value = ''; $('paid-at').required = false; $('paid-at-label').hidden = true
      $('admin-controls').hidden = $('revoke-panel').hidden = true; $('revoke-note').value = ''; $('revoke-confirm').checked = false; $('revoke-title').textContent = ''; $('search').value = ''; $('filter').value = 'all'; $('accepting-status').textContent = ''
    }
    async function load() {
      const version = generation, [data, config] = await Promise.all([api('admin/applications', { token }), api('admin/config', { token })])
      if (version !== generation) return
      $('reload').hidden = false
      $('admin-capacity').textContent = '剩余可申请名额 ' + data.capacity.remaining + ' / ' + data.capacity.maxUsers + '。待审核申请、有效资格及 7 天续费保留期占用名额。邮件服务' + (config.mailEnabled ? '已配置。' : '未配置。')
      rows = data.applications; settings = config; $('admin-controls').hidden = false
      $('accepting-status').textContent = config.emergencyPaused ? '环境配置已紧急暂停新申请。' : config.accepting ? '正在接受新申请。' : '已暂停新申请。'
      $('toggle-accepting').textContent = config.accepting ? '暂停新申请' : '恢复新申请'; $('toggle-accepting').disabled = config.emergencyPaused
      renderRows(version)
      renderAlerts(data.alerts || [], data.diagnostics)
    }
    function renderAlerts(alerts, diagnostics) {
      const labels = { SPONSOR_RELAY_SUSTAINED_TRAFFIC: '持续高流量', SPONSOR_RELAY_REQUEST_SURGE: '请求突增', SPONSOR_RELAY_POLICY_REJECTIONS: '多次触发转发限制', SPONSOR_RELAY_ROUTE_AUTH_FAILURES: '多次中转路由鉴权失败', SPONSOR_RELAY_QUOTA_ALERT: '流量额度或账本异常', SPONSOR_RELAY_FAILURE_SURGE: '故障信号突增' }
      const sources = { client: '客户端请求', host: '主机端', relay: '中转端', unknown: '未定位' }
      const reasons = { E2EE_TRANSPORT_REQUIRED: '客户端未按要求使用加密通道', INVALID_RELAY_ROUTE_TOKEN: '中转路由鉴权未通过',
        UPSTREAM_HTTP_503: '主机侧返回 HTTP 503', UPSTREAM_HTTP_403: '主机侧返回 HTTP 403', UPSTREAM_HTTP_426: '主机侧返回 HTTP 426',
        RELAY_BUFFER_LIMIT: '中转缓冲并发已满', RELAY_TENANT_CONCURRENCY_LIMIT: '中转单授权并发已满', QUOTA_STORAGE_UNAVAILABLE: '中转账本不可用',
        HOST_CONTROL_DISCONNECTED: '未检测到主机控制连接', HOST_WORK_QUEUE_FULL: '等待主机通道的队列已满', HOST_WORK_TIMEOUT: '等待主机通道超时',
        HOST_CONNECTION_LOST: '未收到完整主机握手或响应头', HOST_RESPONSE_INTERRUPTED: '主机响应传输中断', RELAY_TUNNEL_INTERRUPTED: '中转隧道异常中断' }
      const reason = code => reasons[code] || code
      $('alerts-list').replaceChildren(...alerts.map(alert => {
        const item = document.createElement('li')
        const application = alert.grantId && rows.find(row => row.grantId === alert.grantId)
        item.textContent = [when(alert.at), labels[alert.event] || alert.event, sources[alert.source], application?.id || alert.grantId,
          alert.count ? alert.count + ' 次' : '', alert.consecutiveWindows ? '连续 ' + alert.consecutiveWindows + ' 分钟' : '', reason(alert.code)].filter(Boolean).join(' · ')
        return item
      }))
      $('diagnostics-summary').textContent = diagnostics
        ? '自 ' + when(diagnostics.since) + ' 起累计' + (diagnostics.failures.length ? '。分类是观测位置，不代表已经确认根因。' : '，未观察到可分类的故障。')
        : '当前中转服务未提供分端统计。'
      $('diagnostics-list').replaceChildren(...(diagnostics?.failures || []).map(signal => {
        const item = document.createElement('li')
        item.textContent = [sources[signal.source], reason(signal.code), signal.total + ' 次', '最近 ' + when(signal.lastAt)].join(' · ')
        return item
      }))
      $('alerts-empty').hidden = alerts.length > 0
      $('traffic-alerts').hidden = false
    }
    function renderRows(version = generation) {
      $('applications').replaceChildren()
      const filter = $('filter').value, query = $('search').value.trim().toLowerCase()
      for (const row of rows.filter(row => (filter === 'all' || filter === 'unread' && row.unreadMessages > 0 || filter === 'unsent' && row.status === 'approved' && !row.deliveredAt || row.status === filter) && (!query || (row.id + ' ' + row.email).toLowerCase().includes(query)))) {
        const card = document.createElement('article'); card.className = 'card'
        const heading = document.createElement('h2'); heading.textContent = row.id
        const info = document.createElement('p'); info.textContent = row.email + (row.amountCents ? ' · ¥' + (row.amountCents / 100).toFixed(2) : '') + ' · ' + ({ draft: '尚未提交', submitted: '待审核', approved: row.deliveredAt ? '已标记发送' : '已通过，待发送', rejected: '未通过', expired: '已到期', revoked: '已撤销' }[row.status] || row.status) + (row.expiresAt ? '\n有效期至 ' + when(row.expiresAt) + (row.bound ? ' · 已绑定网关' : ' · 未绑定网关') : '') + (row.note ? '\n处理说明：' + row.note : '')
        info.textContent += row.emailVerified ? ' · 邮箱已验证' : ' · 邮箱未验证'
        if (row.renewalOf) info.textContent += '\n续费原申请 ' + row.renewalOf + ' · 付款截止 ' + when(row.renewalDeadline) + (row.paidAt ? ' · 实际到账 ' + when(row.paidAt) : '')
        if (row.usage) info.textContent += row.usage.unavailable ? '\n云端流量账本暂不可读，传输暂停。' : '\n' + (row.usage.online ? '网关在线' : '网关离线') + ' · 本服务月已用 ' + (Number(row.usage.usedBytes) / 1e9).toFixed(2) + ' / ' + (Number(row.usage.limitBytes) / 1e9).toFixed(2) + ' GB'
        card.append(heading, info)
        const reply = document.createElement('button')
        reply.textContent = row.unreadMessages ? '用户有新留言（' + row.unreadMessages + '）' : '查看申请留言'
        reply.addEventListener('click', () => void run(reply, async () => {
          thread = row.id; adminInbox.clear(); $('inbox').hidden = false
          $('inbox-title').textContent = '申请留言 · ' + thread
          await adminInbox.refresh()
          if (version !== generation) return
          row.unreadMessages = 0; reply.textContent = '查看申请留言'
          $('inbox').scrollIntoView({ behavior: 'smooth', block: 'start' })
        }))
        card.append(reply)
        if (['submitted', 'approved'].includes(row.status)) {
          const button = document.createElement('button'); button.textContent = row.status === 'submitted' ? '查看付款并审核' : '查看通过通知'
          button.addEventListener('click', () => void run(button, async () => {
            if (row.status === 'approved') return delivery(row.id)
            const image = await api('admin/applications/' + row.id + '/proof', { token, blob: true })
            if (version !== generation) return
            selected = row.id; $('revoke-panel').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-email').textContent = ''; $('delivery-subject').value = ''; $('review').hidden = false
            $('review-title').textContent = row.id; $('review-info').textContent = info.textContent
            if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = URL.createObjectURL(image); $('review-proof').src = proofUrl
            $('receipt').value = ''; $('verified').checked = false; $('reject-note').value = ''; reviewNotice.textContent = ''
            $('paid-at-label').hidden = !row.renewalOf; $('paid-at').required = !!row.renewalOf; $('paid-at').value = ''
            $('approve').textContent = row.renewalOf ? '核验付款并延长原到期时间 30 天' : '审核通过并生成一个月密钥'
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
    $('reload').addEventListener('click', () => void run($('reload'), async () => { await load(); await adminInbox.refresh() }))
    $('notify-reply').addEventListener('click', () => void run($('notify-reply'), async () => {
      const id = thread, version = generation
      await api('admin/applications/' + id + '/notify', { token, data: {} })
      if (version === generation && thread === id) {
        await adminInbox.refresh()
        message('回复提醒已发送。')
      }
    }))
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
        const renewal = rows.find(row => row.id === id)?.renewalOf
        const paidAt = renewal ? Date.parse($('paid-at').value + '+08:00') : null
        if (renewal && !Number.isSafeInteger(paidAt)) throw Error('请填写收款记录中的实际到账时间（北京时间）。')
        await api('admin/applications/' + id + '/approve', { token, data: { verified: true, receipt, ...(renewal ? { paidAt } : {}) } })
        if (version !== generation) return
        $('review').hidden = true
        try { await load(); if (version !== generation) return; await delivery(id) }
        catch (error) { throw Error('审核已通过，但页面刷新或通知读取失败：' + error.message + ' 请刷新申请。用户仍可在原申请页领取密钥，无需再次审批。') }
        if (version === generation) message('审核通过。用户可在原申请页领取密钥。', deliveryNotice)
      }, reviewNotice)
    })
    $('reject').addEventListener('click', () => { const id = selected, version = generation; void run($('reject'), async () => { await api('admin/applications/' + id + '/reject', { token, data: { note: $('reject-note').value.trim() } }); if (version !== generation) return; $('review').hidden = true; await load(); message('已记录未通过原因。需要联系对方或退款时，请另行完成。') }, reviewNotice) })
    $('copy-mail').addEventListener('click', () => void run($('copy-mail'), async () => { await navigator.clipboard.writeText($('delivery-text').value); message('邮件正文已复制。', deliveryNotice) }, deliveryNotice))
    $('delivered').addEventListener('click', () => { const id = selected, version = generation; void run($('delivered'), async () => { await api('admin/applications/' + id + '/delivered', { token, data: {} }); if (version !== generation) return; await load(); message('已标记人工发送。', deliveryNotice) }, deliveryNotice) })
    window.addEventListener('pagehide', clear)
    return
  }
  const storageKey = 'dsh-relay-sponsor-application-v1'
  const appMode = location.search === '?app=1'
  const manageOnly = location.hash === '#manage'
  if (appMode) document.body.setAttribute?.('data-app-mode', '')
  if (manageOnly) document.body.setAttribute?.('data-manage-only', '')
  const storage = () => appMode ? localStorage : sessionStorage
  let application = null, status = null, config = null, qrUrl = '', cooldown = 0, pollTimer, cooldownTimer, stopped = false
  const applicantInbox = inbox(() => {
    const current = application, version = pageGeneration
    if (!current) return null
    return { route: 'applications/' + current.id, token: current.token,
      valid: () => current === application && version === pageGeneration && !stopped }
  }, 'applicant')
  const emailLink = /^#confirm=(R[A-F0-9]{16})\.([A-Za-z0-9_-]{43})$/.exec(location.hash || '')
  if (emailLink) {
    history.replaceState(null, '', location.pathname + location.search)
    $('confirm-email').hidden = false
    $('confirm-email-button').addEventListener('click', () => void run($('confirm-email-button'), async () => {
      await api('applications/' + emailLink[1] + '/verify', { data: { code: emailLink[2] } })
      $('confirm-email-button').hidden = true
      message('已确认收信，可以返回原申请页。', $('confirm-email-status'))
    }, $('confirm-email-status')))
  }
  try { application = JSON.parse(storage().getItem(storageKey)) } catch {}
  if (!/^R[A-F0-9]{16}$/.test(application?.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(application?.token || '')) application = null
  function save() {
    try { storage().setItem(storageKey, JSON.stringify({ id: application.id, token: application.token })) }
    catch { message('无法保存申请进度，请先复制并私下保管查询凭证，再关闭页面。') }
  }
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
    $('send-code').disabled = !config?.mailEnabled || seconds > 0
    $('send-code').textContent = seconds ? '可在 ' + seconds + ' 秒后重试' : '发送测试邮件'
    if (seconds && !$('verification').hidden && !stopped) cooldownTimer = setTimeout(updateCountdown, 1000)
  }
  function controls() {
    $('first-application').hidden = !!application || manageOnly
    $('existing-application').hidden = !!application
    $('capacity').textContent = !config ? '暂时无法确认申请名额，请勿付款。'
      : !config.open ? '当前暂停新申请。已有编号的申请可继续办理。'
      : config.remaining ? '可全天申请，请先获取编号再付款。' : '当前名额已满，请勿付款。'
    $('begin').hidden = !!application || manageOnly || config?.open === false
    $('begin').disabled = !!application || manageOnly || !config?.open || !config.remaining
    updateCountdown()
  }
  function showStatus(value) {
    if (status?.id !== value.id || status?.email !== value.email) $('email').value = value.email || ''
    status = value
    const draft = value.status === 'draft'
    $('submission-title').textContent = value.renewal ? '3. 提交续费申请' : '3. 提交开通申请'
    $('verification').hidden = $('submission').hidden = !draft
    if (!draft || value.renewal && value.serverTime > value.renewalDeadline) clearQr()
    $('renewal').hidden = !value.renewable && !(draft && value.renewal)
    $('renew').hidden = !value.renewable
    $('renewal-detail').textContent = value.renewable || value.renewal
      ? '请在 ' + when(value.renewalDeadline) + '前完成付款。人工确认到账后，按原到期日加 30 天，保留原网关和公网地址。' : ''
    if (value.renewalDeadline && value.serverTime > value.renewalDeadline) $('renewal-detail').textContent = '付款窗口已结束，切勿付款。已有续费编号可恢复申请，已付款可在编号预留时间内提交材料。'
    $('verification-hint').textContent = value.emailVerified ? '这个邮箱已确认收信。'
      : value.verifySent ? '测试邮件已提交发送。收到后可点击邮件里的确认链接。'
      : config?.mailEnabled ? '试发为可选项。' : '邮件试发暂不可用，申请和留言可继续办理。'
    cooldown = performance.now() + Math.max(0, (value.cooldownUntil || 0) - (value.serverTime || 0))
    $('draft-reservation').textContent = draft ? '编号预留至 ' + when(value.reservedUntil) + '。请先保存下方私密查询凭证。' : ''
    $('application-id').textContent = value.id
    $('verified-email').textContent = draft ? '接收邮箱：' + ($('email').value || '请在上方填写') : ''
    $('reservation').textContent = draft ? '该编号预留至 ' + when(value.reservedUntil) + (value.renewal ? '，付款截止以两者中较早的时间为准。' : '。请在此之前完成付款并提交。') : ''
    $('progress').hidden = $('inbox').hidden = false
    $('claim').hidden = value.status !== 'approved'
    if (value.status !== 'approved') clearClaim()
    $('open-inbox').textContent = value.unreadMessages ? '查看留言（' + value.unreadMessages + ' 条新回复）' : '查看留言'
    $('restart').hidden = manageOnly || value.renewable || !['expired', 'rejected', 'revoked'].includes(value.status)
    const overdue = value.renewal && value.serverTime > value.renewalDeadline
    $('status').textContent = value.id + '\n' + ({ draft: overdue ? '付款窗口已结束。已付款可继续提交；未付款请勿付款。' : '等待付款并提交申请。', submitted: '已提交，等待人工审核。可在本页查看回复，请勿重复付款。', approved: (value.renewal ? '续费通过。请领取新密钥，在原网关重新激活。有效期至 ' : '审核通过。请在此页领取密钥。有效期至 ') + when(value.expiresAt), rejected: '申请未通过：' + value.note, revoked: '使用资格已撤销：' + (value.note || '可在申请留言中联系运营方。'), expired: value.approvedAt ? '本次使用资格已到期。' : '编号预留已到期。如果已经付款，请在原申请留言并保留付款记录。' }[value.status] || value.status)
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
    if (value.status !== 'draft' || qrUrl || value.renewal && value.serverTime > value.renewalDeadline) return
    const image = await api(route + '/qr', { token, blob: true })
    if (version !== pageGeneration || stopped || application !== current || status?.status !== 'draft') return
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
        const value = await api('config')
        if (version !== pageGeneration) return
        config = value
      } catch (error) {
        if (version === pageGeneration) { config = null; controls() }
        throw error
      }
      if (config.contactEmail && $('contact').hidden) {
        const link = document.createElement('a'); link.textContent = config.contactEmail; link.href = 'mailto:' + encodeURIComponent(config.contactEmail)
        $('contact').textContent = '到账核对、补充材料或退款联系：'; $('contact').append(link); $('contact').hidden = false
      }
      controls()
      await refresh(version)
      if (status?.unreadMessages && !$('inbox-panel').hidden) await applicantInbox.refresh()
    } catch (error) {
      if (version === pageGeneration) { clearQr(); if (first) message(error.message) }
    } finally {
      clearTimeout(pollTimer)
      if (!stopped) pollTimer = setTimeout(poll, 5000)
    }
  }
  $('lookup').addEventListener('click', () => {
    $('recovery').open = true
    $('restore-code').focus()
  })
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
      clearQr(); clearClaim(); applicantInbox.clear(); $('inbox-panel').hidden = true
      application = restored; save(); $('recovery').open = false
      await refresh(pageGeneration, value)
      $('progress').focus()
    })
  })
  async function continueApplication(value) {
    application = value
    save()
    await refresh()
    if (status?.status === 'draft') $('verification').focus()
  }
  $('begin').addEventListener('click', () => void applicantAction($('begin'), async () => continueApplication(await api('applications', { data: {} }))))
  $('renew').addEventListener('click', () => void applicantAction($('renew'), async () => {
    const next = await api('applications/' + application.id + '/renew', { token: application.token, data: {} })
    clearQr(); clearClaim(); applicantInbox.clear(); $('inbox-panel').hidden = true
    await continueApplication(next)
  }))
  $('email-form').addEventListener('submit', event => {
    event.preventDefault()
    void applicantAction($('send-code'), async () => {
      await api('applications/' + application.id + '/email', { token: application.token, data: { email: $('email').value.trim() } })
      await refresh()
    })
  })
  $('email').addEventListener('input', () => { $('verified-email').textContent = '接收邮箱：' + $('email').value })
  $('open-inbox').addEventListener('click', () => void run($('open-inbox'), async () => {
    $('inbox-panel').hidden = false
    await applicantInbox.refresh()
    $('open-inbox').textContent = '查看留言'
  }))
  function clearClaim() {
    $('claim-code').value = ''; $('claim-panel').hidden = $('claim-help').hidden = true
  }
  $('claim').addEventListener('click', () => void applicantAction($('claim'), async () => {
    const version = pageGeneration, current = application
    const result = await api('applications/' + current.id + '/claim', { token: current.token })
    if (version !== pageGeneration || current !== application) return
    $('claim-code').value = result.code
    $('claim-panel').hidden = $('claim-help').hidden = false
  }))
  $('copy-id').addEventListener('click', () => void run($('copy-id'), async () => { await navigator.clipboard.writeText(application.id); message('已复制，请将编号填写在微信付款备注中。') }))
  $('refresh').addEventListener('click', () => void applicantAction($('refresh'), refresh))
  $('restart').addEventListener('click', () => { application = null; try { storage().removeItem(storageKey) } catch {}; location.reload() })
  $('application-form').addEventListener('submit', event => {
    event.preventDefault()
    void applicantAction($('submit'), async () => {
      if (!$('email').reportValidity()) throw Error(errors.INVALID_EMAIL)
      const file = $('proof').files[0]
      if (!file || file.size > 2 * 1024 * 1024) throw Error(errors.INVALID_SCREENSHOT)
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('截图读取失败')); reader.readAsDataURL(file) })
      await api('applications/' + application.id, { token: application.token, data: { amount: $('amount').value, screenshot: data, email: $('email').value.trim(), notifyEmail: $('notify-email').checked } })
      $('proof').value = ''; await refresh()
    })
  })
  window.addEventListener('pagehide', () => {
    stopped = true; pageGeneration++
    clearTimeout(pollTimer); clearTimeout(cooldownTimer); clearQr(); clearClaim(); applicantInbox.clear()
  })
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; void poll(true) } })
  recovery()
  controls()
  void poll(true)
})()
