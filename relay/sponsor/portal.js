/* Native browser APIs only. The operator, never this page, verifies actual payment. */
;(function () {
  'use strict'
  const $ = id => document.getElementById(id)
  const message = text => { $('message').textContent = text }
  const when = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）'
  const errors = { PILOT_FULL: '当前名额已满，请勿付款。', APPLICATIONS_PAUSED: '当前暂停新申请，请勿付款。', TRY_LATER: '操作较频繁，请稍后再试。', APPLICATION_EXPIRED: '编号预留已到期。已付款请保留截图联系运营者，切勿重复付款。', APPLICATION_NOT_EDITABLE: '申请已提交或编号已到期，请刷新进度确认，切勿重复付款。', EMAIL_ALREADY_ACTIVE: '此邮箱已有待审核或有效资格，暂不能预付下个月。', RECEIPT_ALREADY_USED: '这笔到账已用于其他申请，不能重复开通。', VERIFIED_RECEIPT_REQUIRED: '请核实到账并填写收款端交易编号。', INVALID_SCREENSHOT: '请选择不超过 2MiB 的 PNG、JPG 或 WebP 付款截图。', MINIMUM_ONE_YUAN: '赞助金额至少为1元。', INVALID_AMOUNT: '请填写正确的赞助金额，最多两位小数。', INVALID_EMAIL: '请填写有效的接收邮箱。', UNAUTHORIZED: '审核密钥无效。', APPLICATION_UNAUTHORIZED: '申请查询凭证无效，请保留付款信息联系运营者。', DELIVERY_INACTIVE: '该开通信息已到期、撤销或被后续申请替换。', DELIVERY_KEY_UNAVAILABLE: '无法解密交付密钥，请检查服务端审核密钥是否被更换。', REVIEW_NOTE_REQUIRED: '请填写未通过原因及后续处理方式。' }
  async function api(route, { token, data, blob } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await fetch('/sponsor/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), cache: 'no-store', signal: controller.signal })
      if (blob && response.ok) return await response.blob()
      const result = await response.json()
      if (!response.ok) throw Error(errors[result.error] || '操作未完成：' + result.error)
      return result
    } finally { clearTimeout(timer) }
  }
  async function run(button, fn) {
    if (button.disabled) return
    button.disabled = true; message('')
    try { await fn() } catch (error) { message(error.name === 'AbortError' ? '结果尚未确认，请刷新进度后再决定是否重试。不要重复付款。' : error.message || '暂时无法连接，请稍后刷新确认。') }
    finally { button.disabled = false }
  }
  if (document.body.hasAttribute('data-admin')) {
    let token = '', selected = '', proofUrl = '', generation = 0
    function clear() {
      generation++; token = ''; selected = ''; $('admin-token').value = ''; $('applications').replaceChildren()
      $('review').hidden = $('delivery').hidden = true; $('delivery-text').value = ''; $('delivery-email').textContent = ''; $('delivery-subject').value = ''; $('review-info').textContent = ''; $('review-title').textContent = ''; $('receipt').value = ''; $('verified').checked = false
      $('review-proof').removeAttribute('src'); if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = ''; message('')
      $('admin-capacity').textContent = ''; $('reject-note').value = ''
      $('reload').hidden = true
    }
    async function load() {
      const version = generation, data = await api('admin/applications', { token })
      if (version !== generation) return
      $('reload').hidden = false
      $('admin-capacity').textContent = '剩余名额 ' + data.capacity.remaining + ' / ' + data.capacity.maxUsers
      $('applications').replaceChildren()
      for (const row of data.applications) {
        const card = document.createElement('article'); card.className = 'card'
        const heading = document.createElement('h2'); heading.textContent = row.id
        const info = document.createElement('p'); info.textContent = row.email + ' · ¥' + (row.amountCents / 100).toFixed(2) + ' · ' + ({ submitted: '待审核', approved: row.deliveredAt ? '已标记发送' : '已通过，待发送', rejected: '未通过' }[row.status] || row.status)
        card.append(heading, info)
        if (row.status !== 'rejected') {
          const button = document.createElement('button'); button.textContent = row.status === 'submitted' ? '查看付款并审核' : '读取开通邮件'
          button.addEventListener('click', () => void run(button, async () => {
            if (row.status === 'approved') return delivery(row.id)
            const image = await api('admin/applications/' + row.id + '/proof', { token, blob: true })
            if (version !== generation) return
            selected = row.id; $('delivery').hidden = true; $('delivery-text').value = ''; $('review').hidden = false
            $('review-title').textContent = row.id; $('review-info').textContent = info.textContent
            if (proofUrl) URL.revokeObjectURL(proofUrl); proofUrl = URL.createObjectURL(image); $('review-proof').src = proofUrl
            $('receipt').value = ''; $('verified').checked = false; $('reject-note').value = ''
            $('review').scrollIntoView({ behavior: 'smooth', block: 'start' })
          }))
          card.append(button)
        }
        $('applications').append(card)
      }
    }
    async function delivery(id) {
      const version = generation, data = await api('admin/applications/' + id + '/delivery', { token })
      if (version !== generation) return
      selected = id; $('review').hidden = true; $('delivery').hidden = false
      $('delivery-email').textContent = '收件人：' + data.email; $('delivery-subject').value = data.subject; $('delivery-text').value = data.text
      $('delivery').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    const login = $('admin-form')
    login.addEventListener('submit', event => {
      event.preventDefault()
      const entered = $('admin-token').value
      void run(event.submitter || login.querySelector('button'), async () => { clear(); token = entered; await load() })
    })
    $('logout').addEventListener('click', clear)
    $('reload').addEventListener('click', () => void run($('reload'), load))
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
  function showDraft() {
    $('begin').hidden = true; $('payment').hidden = $('submission').hidden = false; $('progress').hidden = false
    $('application-id').textContent = application.id
    $('reservation').textContent = '该编号预留名额至 ' + when(application.reservedUntil) + '。请在此之前完成付款并提交；提交后保留名额等待审核。'
  }
  async function refresh() {
    if (!application) return
    const value = await api('applications/' + application.id, { token: application.token })
    $('progress').hidden = false
    if (value.status === 'draft') showDraft()
    else { $('payment').hidden = $('submission').hidden = true; $('begin').hidden = true }
    $('restart').hidden = !['expired', 'rejected'].includes(value.status)
    $('status').textContent = application.id + '\n' + ({ draft: '等待付款并提交申请。', submitted: '已提交，等待人工审核。请勿重复付款，密钥将发送至你填写的邮箱。', approved: '审核通过。' + (value.deliveredAt ? '运营者已标记发送，请检查收件箱及垃圾邮件。' : '等待运营者发送密钥与使用说明。') + '有效期至 ' + when(value.expiresAt), rejected: '申请未通过：' + value.note, expired: value.approvedAt ? '本次使用资格已到期。如果试运营仍开放，可重新申请一个月。' : '编号预留已到期。已经付款请保留截图联系运营者，勿重复付款。' }[value.status] || value.status)
  }
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
