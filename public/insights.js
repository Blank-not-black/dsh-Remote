/* Shared read-only context/cost UI. No plugin UI bundles, scripts or settings. */
;(function (root) {
  'use strict'
  const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : null
  const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const esc = v => String(v ?? '').slice(0, 240).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const categories = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']
  const labels = {
    zh: { title: '会话洞察', context: '上下文', cost: '费用与额度', close: '关闭', refresh: '刷新', loading: '正在读取…',
      none: '选择一个会话后查看洞察。', missing: '当前连接暂未提供此会话的上下文数据。',
      unavailable: '读取失败，请重试。已有概览仍可查看。', unsupported: '当前插件或 DSH 版本暂不支持此数据格式。',
      costMissing: '当前连接暂未提供费用数据，可返回插件列表查看运行状态。',
      occupancy: '上下文占用', modelName: '当前模型', estimated: '组成 Token 为插件估算；占用优先使用 DSH 官方投影。',
      system: '系统提示', tools: '工具定义', user: '用户消息', inject: '注入内容', skill: '技能', assistant: '助手消息', tool: '工具结果',
      composition: '当前组成', events: '最近上下文变化', noEvents: '尚无压缩、裁剪或注入记录。',
      compaction: '压缩', prune: '裁剪', model: '模型变更', mode: '模式变更', counts: '累计变化',
      detailsFailed: '变化记录暂不可用，点击刷新重试。', detailsLoading: '正在读取变化记录…',
      session: '当前会话 API 费用', today: '今日 API 费用', equivalent: '含套餐等值估算', subagents: '子代理 API 费用（单列）', todayTokens: '今日 Token（全部渠道）', planEquivalent: '今日 Plan 等值（非实付）', localTokens: '本周期本地 Token', history: '近 7 日账本', api: 'API 费用', plan: 'Plan 等值',
      balance: '账户余额', plans: '套餐额度 · 已用', source: '数据来源', assembled: '摘要读取于', queried: '供应商查询于',
      estimateNote: '费用由插件账本按用量估算，以供应商账单为准；套餐等值金额不计入 API 费用，子代理费用单独列出。',
      sessionMissing: '插件账本尚无此会话记录', noPlans: '主机未启用可展示的套餐额度。', off: '主机未开启查询',
      error: '供应商查询失败', stale: '缓存数据', unknown: '暂无有效数据', unlimited: '不限量', reset: '重置',
      rolling: '滚动窗口', weekly: '每周', monthly: '每月', date: '主机记账日', details: '明细' },
    en: { title: 'Session insights', context: 'Context', cost: 'Cost & quotas', close: 'Close', refresh: 'Refresh', loading: 'Loading…',
      none: 'Select a session to view insights.', missing: 'Context data for this session is not available on this connection.',
      unavailable: 'Could not read data. Retry; the current overview is still available.', unsupported: 'This plugin or DSH version uses an unsupported data format.',
      costMissing: 'Cost data is unavailable on this connection. Check its status in the installed plugins.', occupancy: 'Context occupancy', modelName: 'Current model',
      estimated: 'Composition tokens are plugin estimates; occupancy uses the DSH projection when available.',
      system: 'System prompt', tools: 'Tool definitions', user: 'User messages', inject: 'Injections', skill: 'Skills', assistant: 'Assistant', tool: 'Tool results',
      composition: 'Current composition', events: 'Recent context changes', noEvents: 'No compaction, pruning or injection records yet.',
      compaction: 'Compaction', prune: 'Pruning', model: 'Model change', mode: 'Mode change', counts: 'Total changes',
      detailsFailed: 'Change records are unavailable. Refresh to retry.', detailsLoading: 'Loading change records…',
      session: 'Session API cost', today: 'Today API cost', equivalent: 'Estimate including plan equivalents', subagents: 'Subagent API cost (separate)', todayTokens: 'Tokens today (all channels)', planEquivalent: 'Plan equivalent today (not paid)', localTokens: 'Local tokens in this period', history: 'Last 7 ledger days', api: 'API cost', plan: 'Plan equivalent',
      balance: 'Account balance', plans: 'Plan quotas · used', source: 'Source', assembled: 'Summary read at', queried: 'Provider queried at',
      estimateNote: 'Costs are usage estimates from the plugin ledger. Provider invoices are authoritative. Plan equivalents and subagents are shown separately.',
      sessionMissing: 'No ledger record for this session yet', noPlans: 'No visible plan quota is enabled on this host.', off: 'Query disabled on host',
      error: 'Provider query failed', stale: 'Cached data', unknown: 'No valid data', unlimited: 'Unlimited', reset: 'Resets',
      rolling: 'Rolling window', weekly: 'Weekly', monthly: 'Monthly', date: 'Host ledger date', details: 'Details' },
  }
  let lang = 'zh'
  const t = key => labels[lang][key] || key
  const tokens = v => num(v) === null ? '—' : new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 0 }).format(v)
  const money = (v, currency = 'USD', digits = 4) => num(v) === null || !/^[A-Z]{3}$/.test(currency) ? '—' : currency + ' ' + v.toFixed(digits)
  const time = v => typeof v === 'number' && v > 0 && v < 8640000000000000 ? new Date(v).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : '—'
  function contextOf(value) {
    const data = obj(value), current = obj(data?.current)
    if (!data || !current || num(current.total) === null) return null
    if (categories.some(key => num(current[key]) === null)) return null
    return { ...data, current: Object.fromEntries([...categories, 'total'].map(key => [key, current[key]])) }
  }
  function costOf(value) {
    const data = obj(value)
    if (data?.schema !== 1 || data.available !== true || data.source !== 'dsh-cost-meter' || data.currency !== 'USD') return null
    return data
  }
  function metric(label, value, note = '') {
    return `<div class="ins-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`
  }
  function bar(percent, label) {
    const value = num(percent)
    return value === null ? '' : `<div class="ins-progress" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(value, 100)}"><span style="width:${Math.min(value, 100)}%"></span></div>`
  }
  function contextHtml(session, detail, detailStatus, settings = {}) {
    const values = obj(session?.projections?.values) || {}, head = contextOf(values.contextTimeline)
    // Only combine a detail with the projection revision that requested it.
    const compatible = detail && (!head || head.detailRev === detail.rev)
    const timeline = head || (compatible ? contextOf(detail.head) : null)
    if (timeline?.unsupported) return `<p class="ins-empty">${esc(t('unsupported'))}</p>`
    if (!timeline) return `<p class="ins-empty">${esc(detailStatus === 'loading' ? t('loading') : detailStatus === 'error' ? t('unavailable') : t('missing'))}</p>`
    const pressure = obj(values.contextPressure), occupied = num(pressure?.pressureTokens) ?? timeline.current.total
    const window = num(pressure?.contextWindow) ?? num(timeline.contextWindow), percent = window > 0 ? occupied / window * 100 : null
    let html = `<section class="ins-section"><div class="ins-section-head"><h3>${esc(t('occupancy'))}</h3><span class="ins-badge">dsh-context</span></div>
      <div class="ins-metrics">${metric(t('occupancy'), tokens(occupied), window > 0 ? '/ ' + tokens(window) + ' tokens' : '')}${metric(t('modelName'), timeline.model || '—', timeline.provider || '')}</div>
      ${bar(percent, t('occupancy'))}<p class="ins-note">${esc(t('estimated'))}</p></section>
      <section class="ins-section"><h3>${esc(t('composition'))}</h3><div class="ins-composition">`
    for (const key of categories) {
      const count = timeline.current[key], share = timeline.current.total > 0 ? count / timeline.current.total * 100 : 0
      html += `<div class="ins-category"><span>${esc(t(key))}</span><span class="ins-track"><i style="width:${Math.min(share, 100)}%"></i></span><strong>${tokens(count)}</strong></div>`
    }
    html += '</div></section>'
    const counts = obj(timeline.counts)
    if (counts) html += `<section class="ins-section"><h3>${esc(t('counts'))}</h3><div class="ins-metrics">${['compactions', 'prunes', 'injects'].map((key, i) => metric(t(['compaction', 'prune', 'inject'][i]), tokens(counts[key]))).join('')}</div></section>`
    const events = head?.detailRev !== undefined ? (compatible ? detail.events : []) : timeline.events
    html += `<section class="ins-section"><h3>${esc(t('events'))}</h3>`
    if (head?.detailRev !== undefined && !compatible) html += `<p class="ins-note">${esc(t(detailStatus === 'loading' ? 'detailsLoading' : 'detailsFailed'))}</p>`
    else if (!Array.isArray(events) || !events.length) html += `<p class="ins-note">${esc(t('noEvents'))}</p>`
    else {
      const rows = events.filter(row => obj(row) && ['compaction', 'prune', 'inject', 'model', 'mode'].includes(row.kind) && (!settings.kind || row.kind === settings.kind))
      if (settings.full) html += `<p class="ins-note">${lang === 'en' ? 'Host change records' : '主机提供的变化记录'} · ${rows.length}${rows.length > 500 ? (lang === 'en' ? ' · Showing latest 500' : ' · 显示最近 500 条') : ''}</p>`
      html += '<ol class="ins-events">' + rows.slice(settings.full ? -500 : -8).reverse().map(row => `<li><div><strong>${esc(t(row.kind))}</strong><time>${esc(time(row.time))}</time></div><span>${esc(row.name || row.sub || '')}${num(row.tokens) !== null ? ' · ' + tokens(row.tokens) + ' tokens' : ''}</span></li>`).join('') + '</ol>'
    }
    return html + `</section><p class="ins-source">${esc(t('source'))} · dsh-context / DSH</p>`
  }
  function costHtml(raw, phase, overview = false, withHistory = false, quotasOnly = false) {
    lang = root.I18N?.lang === 'en' ? 'en' : 'zh'
    const data = costOf(raw)
    if (!data) return `<p class="ins-empty">${esc(t(phase === 'loading' ? 'loading' : phase === 'error' ? 'unavailable' : raw?.available === false ? 'costMissing' : 'unsupported'))}</p>`
    const own = data.session?.found === true ? data.session.own : null
    let html = (phase === 'error' ? `<p role="status" class="ins-note">${esc(t('unavailable'))}</p>` : '') + `<section class="ins-section"><div class="ins-section-head"><h3>${esc(t('cost'))}</h3><span class="ins-badge">dsh-cost-meter</span></div><div class="ins-metrics">
      ${overview ? metric(t('todayTokens'), tokens(data.today?.totalTokens), ['input','cacheRead','cacheWrite','output'].map(key => key + ' ' + tokens(data.today?.tokens?.[key])).join(' · ')) : metric(t('session'), money(own?.apiCost), own ? '' : t('sessionMissing'))}${metric(t('today'), money(data.today?.apiCost), data.day ? t('date') + ' · ' + data.day : '')}
      ${overview ? metric(t('planEquivalent'), money(data.today?.planEquivalent)) : ''}
      ${own && num(own.cost) !== null && own.cost !== own.apiCost ? metric(t('equivalent'), money(own.cost)) : ''}
      ${num(data.session?.subagentCount) > 0 ? metric(t('subagents'), money(data.session?.subagents?.apiCost)) : ''}</div><p class="ins-note">${esc(t('estimateNote'))}</p></section>`
    if (quotasOnly) html = phase === 'error' ? `<p role="status" class="ins-note">${esc(t('unavailable'))}</p>` : ''
    if (obj(data.balance)) {
      const balance = data.balance
      html += `<section class="ins-section"><h3>${esc(t('balance'))}</h3><div class="ins-metrics">${metric(t('balance'), balance.status === 'ok' ? money(balance.total, balance.currency, 2) : '—', balance.status === 'ok' ? t('queried') + ' · ' + time(balance.fetchedAt) : t(['off', 'error', 'stale'].includes(balance.status) ? balance.status : 'unknown'))}</div></section>`
    }
    html += `<section class="ins-section"><h3>${esc(t('plans'))}</h3>`
    const plans = Array.isArray(data.plans) ? data.plans.slice(0, 20) : []
    if (!plans.length) html += `<p class="ins-note">${esc(t('noPlans'))}</p>`
    for (const rawPlan of plans) {
      const plan = obj(rawPlan)
      if (!plan) continue
      html += `<div class="ins-plan"><strong>${esc(plan.name)}</strong>`
      if (plan.status !== 'ok') html += `<p class="ins-note">${esc(t(['off', 'error', 'stale'].includes(plan.status) ? plan.status : 'unknown'))}</p>`
      else {
        const rows = Array.isArray(plan.windows) ? plan.windows.slice(0, 8) : []
        if (!rows.length) html += `<p class="ins-note">${esc(t('unknown'))}</p>`
        for (const rawRow of rows) {
          const row = obj(rawRow)
          if (!row) continue
          const percent = num(row.percent)
          html += `<div class="ins-plan-row"><span>${esc(t(row.name))}</span><strong>${row.unlimited === true ? esc(t('unlimited')) : percent !== null && percent <= 100 ? percent.toFixed(1) + '%' : '—'}</strong></div>${row.unlimited === true ? '' : bar(percent, plan.name + ' ' + row.name)}${row.resetsAt ? `<small>${esc(t('reset'))} · ${esc(row.resetsAt)}</small>` : ''}`
          if (num(row.localTokens) !== null) html += `<small>${esc(t('localTokens'))} · ${tokens(row.localTokens)}</small>`
        }
      }
      html += `<small>${esc(t('queried'))} · ${esc(time(plan.fetchedAt))}</small></div>`
    }
    html += '</section>'
    if (withHistory && Array.isArray(data.history) && data.history.length) html += `<section class="ins-section"><h3>${esc(t('history'))}</h3><div class="ins-ledger-table"><table><thead><tr><th>${esc(t('date'))}</th><th>Token</th><th>${esc(t('api'))}</th><th>${esc(t('plan'))}</th></tr></thead><tbody>${data.history.slice(-7).map(row => `<tr><td>${esc(row.date)}</td><td>${tokens(row.totalTokens)}</td><td>${money(row.apiCost)}</td><td>${money(row.planEquivalent)}</td></tr>`).join('')}</tbody></table></div></section>`
    return html + `<p class="ins-source">${esc(t('source'))} · dsh-cost-meter<br>${esc(t('assembled'))} · ${esc(time(data.generatedAt))}</p>`
  }

  let dialog, options, tab = 'context', generation = 0, controller, poll, debounce, page = false, inline = false, eventKind = '', allowedTabs = ['context','cost']
  let detail = null, detailStatus = '', cost = null, costStatus = '', detailTask = false, detailRevision
  function current() { return options?.getSession?.() }
  function valid(g) { return g === generation && dialog?.open && options.connection.valid() && (options.hostOverview || current()?.sessionId === options.sessionId) }
  function render() {
    if (!dialog?.open) return
    if (!valid(generation)) { close(); return }
    const content = dialog.querySelector('.ins-content'), scroll = content.scrollTop
    const html = tab === 'context' ? contextHtml(current(), detail, detailStatus, { full: page, kind: eventKind }) : costHtml(cost, costStatus, options.hostOverview)
    if (content.innerHTML !== html) { content.innerHTML = html; content.scrollTop = scroll }
    for (const button of dialog.querySelectorAll('[data-ins-tab]')) {
      const active = button.dataset.insTab === tab
      button.hidden = page || !allowedTabs.includes(button.dataset.insTab)
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1
    }
    dialog.querySelector('.ins-content').setAttribute('aria-labelledby', 'ins-tab-' + tab)
  }
  async function request(path, body, g) {
    if (!valid(g)) throw new Error('stale')
    const connection = options.connection
    const parent = controller.signal, attempt = new AbortController()
    const abort = () => attempt.abort()
    parent.addEventListener('abort', abort, { once: true })
    const deadline = setTimeout(abort, 25000)
    try {
      const response = await fetch(options.url(path), { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + connection.token,
        'x-dsh-remote-client': 'web', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: attempt.signal })
      if (!valid(g)) throw new Error('stale')
      if (!response.ok) { const error = new Error('read-failed'); error.status = response.status; throw error }
      const source = await response.text()
      if (!valid(g)) throw new Error('stale')
      if (source.length > 2 * 1024 * 1024) throw new Error('too-large')
      const data = JSON.parse(source)
      if (!obj(data) || data.ok !== true) throw new Error('invalid-response')
      return data
    } finally { clearTimeout(deadline); parent.removeEventListener('abort', abort) }
  }
  async function loadContext(force = false) {
    const g = generation, head = contextOf(current()?.projections?.values?.contextTimeline)
    if (!valid(g) || tab !== 'context' || detailTask || head?.unsupported) return
    if (head && head.detailRev === undefined) { detailStatus = ''; render(); return }
    const revision = head?.detailRev ?? null
    if (!force && detail && detailRevision === revision) return
    detailTask = true; detailStatus = 'loading'; render()
    try {
      const data = await request('/api/dsh-context/detail', { sessionId: options.sessionId }, g)
      if (!valid(g)) return
      const next = obj(data.value), newest = contextOf(current()?.projections?.values?.contextTimeline)
      if (next && num(next.rev) !== null && Array.isArray(next.events) && contextOf(next.head)) {
        if (newest?.detailRev !== undefined && newest.detailRev !== next.rev) { detailStatus = 'changed'; return }
        detail = { rev: next.rev, head: next.head, events: next.events }; detailRevision = newest?.detailRev ?? null; detailStatus = ''
      } else if (next === null) detailStatus = 'missing'
      else detailStatus = 'error'
    } catch (error) { if (valid(g)) detailStatus = error.status === 404 ? 'missing' : 'error' }
    finally {
      if (g === generation) { detailTask = false; render(); if (detailStatus === 'changed') scheduleContext() }
    }
  }
  async function loadCost() {
    const g = generation
    if (!valid(g) || tab !== 'cost' || costStatus === 'loading') return
    costStatus = 'loading'; render()
    try {
      const data = await request('/remote/api/insights/cost' + (options.sessionId ? '?sessionId=' + encodeURIComponent(options.sessionId) : ''), null, g)
      if (!valid(g)) return
      if (data.available === false || costOf(data)) { cost = data; costStatus = '' }
      else costStatus = 'error'
    } catch (error) { if (valid(g)) { costStatus = 'error'; if (error.status === 404) { cost = { available: false }; costStatus = '' } } }
    finally { if (valid(g)) render() }
  }
  function scheduleContext() { clearTimeout(debounce); debounce = setTimeout(() => loadContext(), 400) }
  function close() {
    generation++; controller?.abort(); clearInterval(poll); clearTimeout(debounce)
    const onClose = options?.onClose
    if (inline) { if (dialog) { dialog.open = false; dialog.remove(); dialog = null } }
    else if (dialog?.open) dialog.close()
    options = null; detail = null; cost = null; detailTask = false; detailStatus = ''; costStatus = ''
    onClose?.()
  }
  function open(opts, target) {
    close(); options = opts; allowedTabs = ['context','cost'].filter(value => !opts.allowedTabs || opts.allowedTabs.includes(value))
    if (!allowedTabs.length) { options = null; return }
    tab = allowedTabs.includes(opts.tab) ? opts.tab : allowedTabs[0]; lang = root.I18N?.lang === 'en' ? 'en' : 'zh'
    inline = !!target; page = inline || opts.fullPage === true; eventKind = ''
    options.sessionId = opts.hostOverview ? '' : current()?.sessionId
    if (!opts.hostOverview && !options.sessionId) return
    controller = new AbortController(); detailRevision = undefined
    if (target) { dialog?.remove(); dialog = document.createElement('section'); dialog.className = 'ins-dialog ins-page'; dialog.open = true; target.replaceChildren(dialog) }
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'ins-dialog'; document.body.append(dialog)
      dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
      dialog.addEventListener('close', () => { if (options && !dialog.open) close() })
    }
    if (!inline) dialog.className = 'ins-dialog' + (page ? ' ins-full-page' : '')
    const title = opts.hostOverview || page && tab === 'cost' ? t('cost') : page ? (lang === 'en' ? 'Context analysis' : '上下文分析') : allowedTabs.length === 1 ? t(allowedTabs[0]) : t('title')
    dialog.innerHTML = `<header class="ins-header"><div><h2 id="ins-title">${esc(title)}</h2><p>${esc(opts.hostOverview ? (lang === 'en' ? 'Current host · today, balance and plan quotas' : '当前主机 · 今日费用、账户余额与套餐额度') : opts.getTitle?.() || options.sessionId)}</p></div>${inline ? '' : `<button type="button" data-ins-close aria-label="${esc(t('close'))}">${page ? (lang === 'en' ? 'Back' : '返回') : '×'}</button>`}</header>
      <nav class="ins-tabs" role="tablist" aria-label="${esc(t('title'))}"><button type="button" role="tab" id="ins-tab-context" data-ins-tab="context" aria-controls="ins-content">${esc(t('context'))}</button><button type="button" role="tab" id="ins-tab-cost" data-ins-tab="cost" aria-controls="ins-content">${esc(t('cost'))}</button><button type="button" data-ins-refresh>${esc(t('refresh'))}</button></nav><div id="ins-content" class="ins-content" role="tabpanel" tabindex="0"></div>`
    dialog.setAttribute('aria-labelledby', 'ins-title')
    if (!inline) dialog.querySelector('[data-ins-close]').addEventListener('click', close)
    if (page) {
      dialog.querySelectorAll('[data-ins-tab]').forEach(button => { button.hidden = true })
      if (tab === 'context') {
        const filter = document.createElement('select'); filter.setAttribute('aria-label', lang === 'en' ? 'Change type' : '变化类型')
        filter.innerHTML = [['', lang === 'en' ? 'All changes' : '全部变化'], ...['compaction', 'prune', 'inject', 'model', 'mode'].map(kind => [kind, t(kind)])].map(([value,label]) => `<option value="${value}">${esc(label)}</option>`).join('')
        filter.addEventListener('change', () => { eventKind = filter.value; render() }); dialog.querySelector('.ins-tabs').prepend(filter)
      }
    } else if (opts.onFullPage) {
      const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = lang === 'en' ? 'Open page' : '打开完整页面'
      expand.addEventListener('click', () => { const selected = tab; close(); opts.onFullPage(selected) }); dialog.querySelector('.ins-tabs').append(expand)
    }
    function select(value) { if(!allowedTabs.includes(value))return;tab = value; render(); tab === 'cost' ? loadCost() : loadContext() }
    dialog.querySelectorAll('[data-ins-tab]').forEach(button => {
      button.addEventListener('click', () => select(button.dataset.insTab))
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); select(event.key === 'Home' ? allowedTabs[0] : event.key === 'End' ? allowedTabs.at(-1) : allowedTabs[(allowedTabs.indexOf(tab)+1)%allowedTabs.length])
        dialog.querySelector('[data-ins-tab="' + tab + '"]').focus()
      })
    })
    dialog.querySelector('[data-ins-refresh]').addEventListener('click', () => tab === 'cost' ? loadCost() : loadContext(true))
    if (!inline) dialog.showModal(); render(); tab === 'cost' ? loadCost() : loadContext()
    poll = setInterval(() => { if (!valid(generation)) close(); else if (tab === 'cost') loadCost(); else { render(); loadContext() } }, 60000)
  }
  const api = { open, mount: (opts, target) => open(opts, target), close, update() { if (dialog?.open) { render(); if (dialog?.open && tab === 'context') scheduleContext() } }, contextOf, costOf, contextHtml, costHtml }
  root.DshInsights = api
  if (typeof module !== 'undefined') module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
