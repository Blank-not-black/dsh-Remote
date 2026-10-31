/* Native browser APIs only. The operator, never this page, verifies actual payment. */
;(function () {
  'use strict'
  const $ = id => document.getElementById(id)
  const message = text => { $('message').textContent = text }
  const when = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）'
  let running = false, pageGeneration = 0
  const errors = { PILOT_FULL: '当前名额已满，请勿付款。', APPLICATIONS_PAUSED: '当前暂停新申请，请勿付款。', TRY_LATER: '操作较频繁，请稍后再试。', APPLICATION_EXPIRED: '编号预留已到期。已付款请保留截图联系运营者，切勿重复付款。', APPLICATION_NOT_EDITABLE: '申请已提交或编号已到期，请刷新进度确认，切勿重复付款。', EMAIL_ALREADY_ACTIVE: '此邮箱已有待审核或有效资格，暂不能预付下个月。', RECEIPT_ALREADY_USED: '这笔到账已用于其他申请，不能重复开通。', VERIFIED_RECEIPT_REQUIRED: '请核实到账并填写收款端交易编号。', INVALID_SCREENSHOT: '请选择不超过 2MiB 的 PNG、JPG 或 WebP 付款截图。', MINIMUM_ONE_YUAN: '赞助金额至少为1元。', INVALID_AMOUNT: '请填写正确的赞助金额，最多两位小数。', INVALID_EMAIL: '请填写有效的接收邮箱。', UNAUTHORIZED: '审核密钥无效。', APPLICATION_UNAUTHORIZED: '申请查询凭证无效，请保留付款信息联系运营者。', DELIVERY_INACTIVE: '该开通信息已到期、撤销或被后续申请替换。', DELIVERY_KEY_UNAVAILABLE: '无法解密交付密钥，请检查服务端审核密钥是否被更换。', REVIEW_NOTE_REQUIRED: '请填写未通过原因及后续处理方式。' }
  async function api(route, { token, data, blob } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await fetch('/sponsor/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), credentials: 'omit', cache: 'no-store', signal: controller.signal })
      if (blob && response.ok) return await response.blob()
      const result = await response.json()
      if (!response.ok) throw Error(errors[result.error] || '操作未完成：' + result.error)
      return result
    } finally { clearTimeout(timer) }
  }
  async function run(button, fn) {
    if (button.disabled || running) return
    const version = pageGeneration
    running = true
    button.disabled = true; message('')
    try { await fn() } catch (error) { if (version === pageGeneration) message(error.name === 'AbortError' || error instanceof TypeError ? '结果尚未确认，请刷新进度后再决定是否重试。不要重复付款。' : error.message || '暂时无法连接，请稍后刷新确认。') }
    finally { button.disabled = false; running = false }
  }
  if (document.body.hasAttribute('data-admin')) {
    let token = '', selected = '', proofUrl = '', generation = 0, rows = [], settings = null
    function clear() {
      generation++; pageGeneration++; token = ''; selected = ''; rows = []; settings = null; $('admin-token').value = ''; $('applications').replaceChildren()
      $('review').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-email').textContent = ''; $('delivery-subject').value = ''; $('review-info').textContent = ''; $('review-title').textContent = ''; $('receipt').value = ''; $('verified').checked = false
      $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''; message('')
      $('admin-capacity').textContent = ''; $('reject-note').value = ''
      $('reload').hidden = true
      $('admin-controls').hidden = $('revoke-panel').hidden = true; $('revoke-note').value = ''; $('revoke-confirm').checked = false; $('revoke-title').textContent = ''; $('search').value = ''; $('filter').value = 'all'; $('accepting-status').textContent = ''
    }
    async function load() {
      const version = generation, [data, config] = await Promise.all([api('admin/applications', { token }), api('admin/config', { token })])
      if (version !== generation) return
      $('reload').hidden = false
      $('admin-capacity').textContent = '剩余名额 ' + data.capacity.remaining + ' / ' + data.capacity.maxUsers
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
            $('receipt').value = ''; $('verified').checked = false; $('reject-note').value = ''
            $('review').scrollIntoView({ behavior: 'smooth', block: 'start' })
          }))
          card.append(button)
          if (row.status === 'approved') {
            const revoke = document.createElement('button'); revoke.textContent = '撤销资格'; revoke.className = 'secondary'
            revoke.addEventListener('click', () => {
              if (running || version !== generation) return
              selected = row.id; $('review').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-subject').value = ''; $('delivery-email').textContent = ''
              $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''
              $('revoke-title').textContent = '撤销资格 · ' + row.id; $('revoke-panel').hidden = false; $('revoke-note').value = ''; $('revoke-confirm').checked = false
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
      $('delivery-email').textContent = '收件人：' + data.email; $('delivery-subject').value = data.subject; $('delivery-text').value = data.text
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
    }) })
    $('review-form').addEventListener('submit', event => {
      event.preventDefault(); const id = selected, version = generation
      void run($('approve'), async () => {
        await api('admin/applications/' + id + '/approve', { token, data: { verified: $('verified').checked, receipt: $('receipt').value.trim() } })
        if (version !== generation) return
        await load(); await delivery(id); message('审核通过。请发送开通邮件，实际发出后再标记。')
      })
    })
    $('reject').addEventListener('click', () => { const id = selected, version = generation; void run($('reject'), async () => { await api('admin/applications/' + id + '/reject', { token, data: { note: $('reject-note').value.trim() } }); if (version !== generation) return; $('review').hidden = true; await load(); message('已记录未通过原因。需要联系对方或退款时，请另行完成。') }) })
    $('copy-mail').addEventListener('click', () => void run($('copy-mail'), async () => { await navigator.clipboard.writeText($('delivery-text').value); message('邮件正文已复制。') }))
    $('delivered').addEventListener('click', () => { const id = selected, version = generation; void run($('delivered'), async () => { await api('admin/applications/' + id + '/delivered', { token, data: {} }); if (version !== generation) return; await load(); message('已标记人工发送。') }) })
    window.addEventListener('pagehide', clear)
    return
  }
  const storageKey = 'dsh-relay-sponsor-application-v1'
  let application = null
  try { application = JSON.parse(sessionStorage.getItem(storageKey)) } catch {}
  if (!/^R[A-F0-9]{16}$/.test(application?.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(application?.token || '')) application = null
  function save() { try { sessionStorage.setItem(storageKey, JSON.stringify(application)) } catch { message('此浏览器不能保存申请进度，请勿关闭本页，提交后保留申请编号。') } }
  function recovery() {
    $('recovery-label').hidden = $('copy-recovery').hidden = !application
    $('recovery-code').value = application ? application.id + '.' + application.token : ''
  }
  function showDraft() {
    $('begin').hidden = true; $('payment').hidden = $('submission').hidden = false; $('progress').hidden = false
    $('application-id').textContent = application.id
    $('reservation').textContent = '该编号预留名额至 ' + when(application.reservedUntil) + '。请在此之前完成付款并提交；提交后保留名额等待审核。'
  }
  async function refresh() {
    if (!application) return
    recovery()
    const value = await api('applications/' + application.id, { token: application.token })
    $('progress').hidden = false
    if (value.status === 'draft') showDraft()
    else { $('payment').hidden = $('submission').hidden = true; $('begin').hidden = true }
    $('restart').hidden = !['expired', 'rejected', 'revoked'].includes(value.status)
    $('status').textContent = application.id + '\n' + ({ draft: '等待付款并提交申请。', submitted: '已提交，等待人工审核。请勿重复付款，密钥将发送至你填写的邮箱。', approved: '审核通过。' + (value.deliveredAt ? '运营者已标记发送，请检查收件箱及垃圾邮件。' : '等待运营者发送密钥与使用说明。') + '有效期至 ' + when(value.expiresAt), rejected: '申请未通过：' + value.note, revoked: '使用资格已撤销：' + (value.note || '请联系运营者核对。'), expired: value.approvedAt ? '本次使用资格已到期。如果试运营仍开放，可重新申请一个月。' : '编号预留已到期。已经付款请保留截图联系运营者，勿重复付款。' }[value.status] || value.status)
    if (value.status === 'draft') { application.reservedUntil = value.reservedUntil; save(); showDraft() }
  }
  $('copy-recovery').addEventListener('click', () => void run($('copy-recovery'), async () => { await navigator.clipboard.writeText($('recovery-code').value); message('查询凭证已复制，请私下保存。它不能用来连接中转。') }))
  $('restore-form').addEventListener('submit', event => {
    event.preventDefault()
    void run($('restore'), async () => {
      const code = $('restore-code').value.trim(), match = /^(R[A-F0-9]{16})\.([A-Za-z0-9_-]{43})$/.exec(code)
      $('restore-code').value = ''
      if (!match) throw Error('查询凭证格式不正确，请粘贴完整凭证。')
      const restored = { id: match[1], token: match[2] }
      // Verify before replacing the existing application; wrong credentials cannot lose it.
      const value = await api('applications/' + restored.id, { token: restored.token })
      application = { ...restored, reservedUntil: value.reservedUntil }; save(); await refresh()
    })
  })
  $('begin').addEventListener('click', () => void run($('begin'), async () => { application = await api('applications', { data: {} }); save(); showDraft(); await refresh() }))
  $('copy-id').addEventListener('click', () => void run($('copy-id'), async () => { await navigator.clipboard.writeText(application.id); message('已复制，请将编号填写在微信付款备注中。') }))
  $('refresh').addEventListener('click', () => void run($('refresh'), refresh))
  $('restart').addEventListener('click', () => { application = null; try { sessionStorage.removeItem(storageKey) } catch {}; location.reload() })
  $('application-form').addEventListener('submit', event => {
    event.preventDefault()
    void run($('submit'), async () => {
      const file = $('proof').files[0]
      if (!file || file.size > 2 * 1024 * 1024) throw Error(errors.INVALID_SCREENSHOT)
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('截图读取失败')); reader.readAsDataURL(file) })
      await api('applications/' + application.id, { token: application.token, data: { amount: $('amount').value, screenshot: data, email: $('email').value.trim() } })
      $('proof').value = ''; $('email').value = ''; await refresh()
    })
  })
  void (async () => {
    recovery()
    try {
      const config = await api('config')
      if (config.contactEmail) {
        const link = document.createElement('a'); link.textContent = config.contactEmail; link.href = 'mailto:' + encodeURIComponent(config.contactEmail)
        $('contact').textContent = '到账核对、补充材料或退款联系：'; $('contact').append(link); $('contact').hidden = false
      }
      $('capacity').textContent = !config.accepting ? '当前暂停新申请，请勿付款。' : config.remaining ? '当前仍有申请名额，请先获取编号再付款。' : '当前名额已满，请勿付款。'
      $('begin').disabled = !config.accepting || !config.remaining
      if (application) await refresh()
    } catch (error) { message(error.message); $('capacity').textContent = '暂时无法确认申请名额，请勿付款。' }
  })()
})()
