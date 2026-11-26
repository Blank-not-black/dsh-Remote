/* Plan mode status, reviewed-plan requests and read-only plan history.
 *
 * This module owns no durable state: every value comes from the Host through an
 * explicit adapter. Plan mode is the `plan` Session projection
 * (`{ active, pending }`, written by @deepseek-ai/dsh-plan-mode); entering and
 * leaving use the Host `/plan` and `/plan off` slash-command bridge; a pending
 * review is the Host `user-questions` waterfall request whose question carries
 * `intent.kind === "plan-review"`, and it is answered through the Host
 * client-response channel with the Host-provided option label — never through a
 * normal chat message.
 *
 * Adapter contract (all optional except the used ones):
 *   command(line, { sessionId }) -> Promise<{ executed:boolean, message?:string }>
 *     Host slash-command bridge (`POST /remote/api/command`, polls command status).
 *   respond(rpcId, value) -> Promise<boolean>
 *     Host interaction answer channel (`POST /api/respond`); true when accepted.
 *   state.sessionId() -> string|null
 *   state.snapshot(sessionId) -> {
 *     plan?: { active:boolean, pending:boolean },  // Session projection value
 *     questions?: Array<{ rpcId, sessionId, questions }>, // pending mux frames
 *     connected?: boolean, readOnly?: boolean,
 *     capability?: boolean | { plan?: boolean }
 *   } | null
 *   state.entries(sessionId) -> Array<{ seq, event }>   // Session log entries
 *   dom.root -> Element                                  // container for rendered HTML
 *   onOpenPlan({ sessionId, planText, title, source, seq, callId }) -> void
 *   notify(message, kind) -> void                        // optional toast bridge
 */
'use strict'
;(function (root) {
  const text = (zh, en) => (root.I18N?.lang === 'en' ? en : zh)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const MAX_HISTORY = 20
  const MAX_PLAN_CHARS = 24000

  function clip(value, max) {
    const body = String(value ?? '')
    return body.length > max ? body.slice(0, max) + '…' : body
  }
  function cleanup(body) {
    return String(body ?? '').replace(/\r\n/g, '\n').trim()
  }
  function firstHeading(plan) {
    for (const line of String(plan || '').split('\n')) {
      const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
      if (match) return match[1]
    }
    return ''
  }
  function preview(plan, max = 180) {
    const lines = cleanup(plan).split('\n').map(line => line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim()).filter(Boolean)
    return clip(lines.slice(0, 2).join(' · '), max)
  }
  function safeArray(value) { return Array.isArray(value) ? value : [] }
  function safeCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }
  function parseArguments(value) {
    if (value && typeof value === 'object') return value
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }
  function resultText(data) {
    const direct = data?.result ?? data?.output ?? data?.message ?? data
    if (typeof direct === 'string') return direct
    const blocks = Array.isArray(direct?.content) ? direct.content : Array.isArray(data?.content) ? data.content : []
    if (Array.isArray(blocks)) return blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n')
    if (direct && typeof direct.text === 'string') return direct.text
    return ''
  }

  /* ---------------------------------------------------------------- plan state */

  /**
   * The Host plan projection value, never a client guess. Capability absence is
   * the key's absence, so an unknown value is reported as unsupported instead of
   * being rendered as "inactive".
   */
  function normalizePlan(value) {
    if (!value || typeof value !== 'object') return { supported: false, active: false, pending: false, target: null }
    const active = value.active === true
    const pending = value.pending === true
    return { supported: true, active, pending, target: pending ? !active : active }
  }

  function capabilityOf(snapshot) {
    const capability = snapshot?.capability
    if (typeof capability === 'boolean') return capability
    if (capability && typeof capability === 'object' && typeof capability.plan === 'boolean') return capability.plan
    return null
  }

  /**
   * Derive everything the chip renders, including why an action is unavailable.
   * The returned `action.kind` is `enter` or `exit`; a pending selection disables
   * the control until the Host projection settles.
   */
  function describePlan(snapshot) {
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : {}
    const capability = capabilityOf(snap)
    const plan = normalizePlan(snap.plan)
    const connected = snap.connected !== false
    const readOnly = snap.readOnly === true
    const supported = capability === true || (capability !== false && plan.supported)
    // A plan is only "known" when the Host says it is active or a switch/review is pending.
    // Disconnected sessions must not surface a stale Plan card when neither is true.
    const exists = plan.supported && (plan.active || plan.pending)
    const state = {
      supported, connected, readOnly, exists,
      active: plan.active, pending: plan.pending, target: plan.target,
      status: 'unsupported', label: '', hint: '', action: null,
    }
    if (!supported) {
      state.label = text('此主机不支持 Plan 模式', 'Plan mode is not available on this host')
      state.hint = text('主机未提供 plan 投影（旧版主机或未启用 plan-mode 插件）。', 'The Host exposes no plan projection (older Host or plan-mode not enabled).')
      return state
    }
    if (!connected) {
      state.status = 'disconnected'
      state.label = text('连接已断开，无法读取 Plan 状态', 'Disconnected — plan state unavailable')
      state.hint = text('重新连接后以主机状态为准。', 'Reconnect to read the Host state.')
      return state
    }
    if (!plan.supported) {
      state.status = 'unavailable'
      state.label = text('等待主机 Plan 状态', 'Waiting for the Host plan state')
      state.hint = text('投影尚未加载，不能推断当前模式。', 'The projection has not loaded; the current mode is unknown.')
      return state
    }
    if (readOnly) {
      state.status = 'readonly'
      state.label = plan.active
        ? text('Plan 模式已开启（只读会话）', 'Plan mode is on (read-only session)')
        : text('Plan 模式未开启（只读会话）', 'Plan mode is off (read-only session)')
      state.hint = text('只读会话不能进入、退出或审批计划。', 'A read-only session cannot enter, leave, or review a plan.')
      return state
    }
    if (plan.pending) {
      state.status = plan.active ? 'leaving' : 'entering'
      state.label = plan.active
        ? text('正在退出 Plan 模式…', 'Leaving plan mode…')
        : text('正在进入 Plan 模式…', 'Entering plan mode…')
      state.hint = text('等待主机确认，暂不可再次切换。', 'Waiting for Host confirmation; switching is paused.')
      state.action = { kind: plan.active ? 'exit' : 'enter', label: text('切换中…', 'Switching…'), disabled: true }
      return state
    }
    if (plan.active) {
      state.status = 'active'
      state.label = text('Plan 模式已开启', 'Plan mode is on')
      state.action = { kind: 'exit', label: text('退出计划模式', 'Leave plan mode'), disabled: false }
    } else {
      state.status = 'inactive'
      state.label = text('Plan 模式未开启', 'Plan mode is off')
      state.action = { kind: 'enter', label: text('进入计划模式', 'Enter plan mode'), disabled: false }
    }
    return state
  }

  /* ------------------------------------------------------------ review request */

  /**
   * Recognize the Host plan-review question. The plan markdown is the question
   * `detail`; the approve label is named by `intent.approve` and any other option
   * declines. No intent means this is an ordinary question, not a plan review.
   */
  function planReviewOf(question) {
    // Accept one question, a questions array, or a frame-like `{ questions }`
    // object so both ingestion shapes used by the clients resolve the review.
    if (Array.isArray(question)) {
      for (const item of question) {
        const found = planReviewOf(item)
        if (found) return found
      }
      return null
    }
    if (!question || typeof question !== 'object') return null
    if (!question.intent && Array.isArray(question.questions)) return planReviewOf(question.questions)
    const intent = question.intent
    if (!intent || intent.kind !== 'plan-review') return null
    const planText = cleanup(question.detail)
    const options = safeArray(question.options).filter(option => option && typeof option.label === 'string' && option.label)
    const approveLabel = typeof intent.approve === 'string' && intent.approve ? intent.approve : ''
    const decline = options.find(option => option.label !== approveLabel) || null
    const header = typeof question.header === 'string' ? question.header.trim() : ''
    return {
      questionId: typeof question.id === 'string' ? question.id : '',
      header,
      title: firstHeading(planText) || header || text('计划审阅', 'Plan review'),
      planText,
      hasPlan: planText.length > 0,
      summary: preview(planText),
      options,
      approveLabel,
      approveDescription: (options.find(option => option.label === approveLabel) || {}).description || '',
      keepLabel: decline ? decline.label : '',
      keepDescription: decline ? decline.description || '' : '',
      callId: typeof intent.callId === 'string' ? intent.callId : '',
    }
  }

  /** Extract a plan review from one mux `question/requested` frame. */
  function reviewFromFrame(frame) {
    const payload = frame && frame.payload && typeof frame.payload === 'object' ? frame.payload : frame
    if (!payload || payload.type !== 'question/requested') return null
    for (const question of safeArray(payload.questions)) {
      const review = planReviewOf(question)
      if (review) return { rpcId: String(frame?.rpcId ?? payload.rpcId ?? ''), sessionId: String(payload.sessionId || ''), ...review }
    }
    return null
  }

  /* ------------------------------------------------------------- plan history */

  /** Read-only plan invocations recorded by the Host as `exit_plan_mode` calls. */
  function historyPlans(entries) {
    const rows = safeArray(entries).filter(entry => entry && entry.event && typeof entry.event === 'object')
    const sorted = rows.slice().sort((a, b) => safeCount(a.seq) - safeCount(b.seq))
    const seen = new Set()
    const calls = new Map()
    const outcomes = new Map()
    for (const entry of sorted) {
      if (Number.isSafeInteger(entry.seq)) {
        if (seen.has(entry.seq)) continue
        seen.add(entry.seq)
      }
      const event = entry.event
      const data = event.data || {}
      if (event.type === 'tool/call') {
        const name = data.name || data.toolName
        if (name !== 'exit_plan_mode') continue
        const args = parseArguments(data.arguments ?? data.args ?? data.input)
        const planText = cleanup(args?.plan)
        if (!planText) continue
        const callId = String(data.callId || '')
        calls.set(callId || 'seq-' + entry.seq, {
          seq: Number.isSafeInteger(entry.seq) ? entry.seq : null,
          turn: Number.isSafeInteger(data.turn) ? data.turn : null,
          callId,
          planText,
          title: firstHeading(planText) || text('未命名计划', 'Untitled plan'),
          outcome: 'unknown',
        })
        continue
      }
      if (event.type !== 'tool/result') continue
      const callId = String(data.callId || data.message?.source?.callId || '')
      if (!callId) continue
      const failed = data.error !== undefined || data.ok === false || data.isError === true
      const body = resultText(data)
      outcomes.set(callId, failed ? 'failed' : /plan approved/i.test(body) ? 'approved' : /dismissed|keep planning/i.test(body) ? 'dismissed' : 'unknown')
    }
    for (const [key, call] of calls) {
      const outcome = outcomes.get(call.callId) || 'unknown'
      calls.set(key, { ...call, outcome, readOnly: true })
    }
    return Array.from(calls.values()).sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, MAX_HISTORY)
  }

  /* ------------------------------------------------------------------ markup */

  function statusHtml(view) {
    const state = view.plan
    // There is nothing to show while disconnected and no plan was ever active or pending.
    if (state.status === 'disconnected' && !state.exists) return ''
    const reviewClass = view.review ? ' dr-plan-status--review' : ''
    const action = state.action
    const button = action
      ? `<button type="button" class="dr-plan-btn dr-plan-btn--${esc(action.kind)}" data-dr-plan-action="${esc(action.kind)}"${action.disabled ? ' disabled' : ''}>${esc(action.label)}</button>`
      : ''
    return `<div class="dr-plan-status dr-plan-status--${esc(state.status)}${reviewClass}" data-dr-plan-status role="status" aria-live="polite">
      <span class="dr-plan-badge">Plan</span>
      <span class="dr-plan-status-copy">${esc(state.label)}</span>
      ${button}
      ${state.hint ? `<span class="dr-plan-status-hint">${esc(state.hint)}</span>` : ''}
      ${view.review ? `<span class="dr-plan-status-review">${esc(text('有待审阅计划', 'Plan awaiting review'))}</span>` : ''}
    </div>`
  }

  function reviewHtml(view) {
    const review = view.review
    if (!review) return ''
    const locked = view.busy === 'approve' || view.busy === 'keep' || !view.plan.connected || view.plan.readOnly
    const disabled = locked || !review.rpcId
    const approveButton = review.approveLabel
      ? `<button type="button" class="dr-plan-btn dr-plan-btn--approve" data-dr-plan-action="approve" title="${esc(text('主机选项：', 'Host option: ') + review.approveLabel)}"${disabled ? ' disabled' : ''}>${esc(text('批准并退出计划模式', 'Approve and leave plan mode'))}<span class="dr-plan-option">${esc(review.approveLabel)}</span></button>`
      : ''
    const keepButton = review.keepLabel
      ? `<button type="button" class="dr-plan-btn dr-plan-btn--keep" data-dr-plan-action="keep" title="${esc(text('主机选项：', 'Host option: ') + review.keepLabel)}"${disabled ? ' disabled' : ''}>${esc(text('继续完善计划', 'Keep planning'))}<span class="dr-plan-option">${esc(review.keepLabel)}</span></button>`
      : ''
    const feedback = review.keepLabel
      ? `<label class="dr-plan-feedback"><span>${esc(text('反馈（随主机选项提交，可留空）', 'Feedback (sent with the Host option, optional)'))}</span><textarea rows="2" maxlength="2000" data-dr-plan-feedback placeholder="${esc(text('希望计划如何调整…', 'What should change in the plan…'))}"></textarea></label>`
      : ''
    let hint = ''
    if (!review.hasPlan) hint = text('主机未提供计划正文，无法查看完整计划。', 'The Host supplied no plan text, so the full plan cannot be shown.')
    else if (!review.approveLabel) hint = text('主机未提供批准选项，不能猜测审批结果。', 'The Host named no approve option; the verdict is not guessed.')
    else if (!review.rpcId) hint = text('主机未提供请求标识，无法提交审批。', 'The Host supplied no request id, so the review cannot be answered.')
    else if (!view.plan.connected) hint = text('连接已断开，无法提交审批。', 'Disconnected — the review cannot be submitted.')
    else if (view.plan.readOnly) hint = text('只读会话不能提交审批。', 'A read-only session cannot answer the review.')
    else if (view.busy === 'approve' || view.busy === 'keep') hint = text('正在提交…', 'Submitting…')
    return `<section class="dr-plan-review" data-dr-plan-scope data-dr-plan-review="${esc(review.rpcId)}" aria-label="${esc(text('计划审阅', 'Plan review'))}">
      <div class="dr-plan-review-head"><span class="dr-plan-review-strip">${esc(text('计划审阅', 'Plan review'))}</span><span class="dr-plan-review-state">${esc(text('待审阅', 'Awaiting review'))}</span></div>
      <h4 class="dr-plan-review-title">${esc(review.title)}</h4>
      ${review.hasPlan ? `<p class="dr-plan-review-summary">${esc(review.summary)}</p>
      <details class="dr-plan-doc" data-dr-plan-doc><summary>${esc(text('查看完整计划', 'View full plan'))}</summary><pre>${esc(clip(review.planText, MAX_PLAN_CHARS))}</pre></details>` : ''}
      ${hint ? `<p class="dr-plan-hint">${esc(hint)}</p>` : ''}
      <div class="dr-plan-review-actions">${approveButton}${keepButton}</div>
      ${feedback}
      <p class="dr-plan-review-note">${esc(text('审批通过与继续完善都会按主机提供的选项经交互接口提交，不会作为普通聊天消息发送。', 'Approve and keep-planning are submitted through the Host interaction channel using the Host options, never as chat messages.'))}</p>
      <span class="dr-plan-review-status" data-dr-plan-review-status role="status" aria-live="polite"></span>
    </section>`
  }

  const OUTCOME_LABELS = {
    approved: () => text('已批准', 'Approved'),
    dismissed: () => text('继续计划中', 'Kept planning'),
    failed: () => text('审批失败', 'Review failed'),
    unknown: () => text('结果未知', 'Outcome unknown'),
  }

  function historyHtml(plans) {
    const rows = safeArray(plans)
    if (!rows.length) return ''
    return `<section class="dr-plan-history" data-dr-plan-history aria-label="${esc(text('历史计划（只读）', 'Plan history (read-only)'))}">
      <h4 class="dr-plan-history-head">${esc(text('历史计划（只读）', 'Plan history (read-only)'))}</h4>
      ${rows.map(plan => `<article class="dr-plan-history-item" data-dr-plan-history-item="${plan.seq ?? ''}">
        <div class="dr-plan-history-top"><span class="dr-plan-history-title">${esc(plan.title)}</span><span class="dr-plan-history-badge">${esc(text('历史 · 只读', 'History · read-only'))}</span></div>
        <div class="dr-plan-history-meta">${plan.turn != null ? esc(text('回合 ', 'Turn ') + plan.turn) + ' · ' : ''}${esc((OUTCOME_LABELS[plan.outcome] || OUTCOME_LABELS.unknown)())}</div>
        <details class="dr-plan-doc"><summary>${esc(text('查看计划正文', 'View plan text'))}</summary><pre>${esc(clip(plan.planText, MAX_PLAN_CHARS))}</pre></details>
      </article>`).join('')}
    </section>`
  }

  function noticeHtml(view) {
    if (!view.notice) return ''
    return `<p class="dr-plan-notice dr-plan-notice--${esc(view.notice.kind || 'info')}" data-dr-plan-notice role="status" aria-live="polite">${esc(view.notice.text)}</p>`
  }

  function viewHtml(view) {
    return `<div class="dr-plan" data-dr-plan-root>${statusHtml(view)}${noticeHtml(view)}${reviewHtml(view)}${historyHtml(view.plans)}</div>`
  }

  /**
   * Whether the plan section has anything meaningful to show. Kept outside the
   * DOM so the app can hide the whole section when a disconnected session has
   * no plan and no review/history to display.
   */
  function hasContent(view) {
    if (!view || typeof view !== 'object') return false
    if (view.review) return true
    if (Array.isArray(view.plans) && view.plans.length) return true
    const plan = view.plan
    if (!plan || typeof plan !== 'object') return false
    if (!plan.supported) return plan.status === 'unsupported'
    if (plan.status === 'disconnected') return plan.exists === true
    return true
  }

  /* --------------------------------------------------------------- controller */

  function create(adapter) {
    const api = adapter && typeof adapter === 'object' ? adapter : {}
    const stateApi = api.state && typeof api.state === 'object' ? api.state : {}
    let sessionId = typeof stateApi.sessionId === 'function' ? stateApi.sessionId() : (stateApi.sessionId || null)
    let rootEl = api.dom?.root || null
    let unbind = null
    let disposed = false
    let busy = ''
    let notice = null
    const frameReviews = new Map()
    const resolved = new Set()
    const answered = new Set()
    const knownReviews = new Set()
    const extraEntries = new Map()

    function currentSnapshot(id) {
      if (typeof stateApi.snapshot !== 'function') return {}
      const value = stateApi.snapshot(id)
      return value && typeof value === 'object' ? value : {}
    }
    function currentEntries(id) {
      const base = typeof stateApi.entries === 'function' ? safeArray(stateApi.entries(id)) : []
      const extra = extraEntries.get(id) || []
      if (!extra.length) return base
      const seen = new Set(base.map(entry => entry?.seq))
      return base.concat(extra.filter(entry => entry && !seen.has(entry.seq))).sort((a, b) => safeCount(a.seq) - safeCount(b.seq))
    }
    function currentReview(id) {
      const snap = currentSnapshot(id)
      for (const frame of safeArray(snap.questions)) {
        if (!frame || typeof frame !== 'object') continue
        if (frame.sessionId && id && String(frame.sessionId) !== String(id)) continue
        const rpcId = String(frame.rpcId || '')
        if (rpcId && (resolved.has(rpcId) || answered.has(rpcId))) continue
        for (const question of safeArray(frame.questions)) {
          const review = planReviewOf(question)
          if (review) return { rpcId, sessionId: id, source: 'state', ...review }
        }
      }
      const frames = Array.from(frameReviews.entries()).reverse()
      for (const [rpcId, review] of frames) {
        if (review.sessionId && id && String(review.sessionId) !== String(id)) continue
        if (resolved.has(rpcId) || answered.has(rpcId)) continue
        return { ...review, rpcId, sessionId: id, source: 'frame' }
      }
      return null
    }
    function buildView() {
      const snap = currentSnapshot(sessionId)
      const plan = describePlan(snap)
      const review = currentReview(sessionId)
      if (review && review.rpcId) knownReviews.add(review.rpcId)
      return {
        sessionId,
        plan,
        review,
        plans: historyPlans(currentEntries(sessionId)),
        busy,
        notice,
      }
    }
    function render(container) {
      if (container && typeof container === 'object') {
        if (rootEl && rootEl !== container) { if (unbind) unbind(); unbind = null }
        rootEl = container
      }
      const view = buildView()
      if (rootEl && typeof rootEl === 'object' && 'innerHTML' in rootEl) {
        rootEl.innerHTML = viewHtml(view)
        if (!unbind) unbind = bind(rootEl, controller)
      }
      return view
    }
    function describeProblem() {
      if (disposed) return text('模块已释放', 'The module was disposed')
      if (!sessionId) return text('未选择会话', 'No session selected')
      const plan = describePlan(currentSnapshot(sessionId))
      if (!plan.supported) return text('此主机不支持 Plan 模式', 'Plan mode is not available on this host')
      if (!plan.connected) return text('连接已断开，无法提交', 'Disconnected — nothing was submitted')
      if (plan.readOnly) return text('只读会话无法提交', 'A read-only session cannot submit')
      return ''
    }
    function fail(message) {
      notice = { kind: 'err', text: message }
      render()
      return { ok: false, error: message }
    }
    function succeed(message) {
      notice = { kind: 'ok', text: message }
      render()
      return { ok: true }
    }
    async function runPlanCommand(line, message) {
      if (busy) return { ok: false, error: text('操作进行中', 'An action is already running') }
      const problem = describeProblem()
      if (problem) return fail(problem)
      if (typeof api.command !== 'function') return fail(text('未接入主机命令接口，无法切换 Plan 模式', 'The Host command bridge is not connected'))
      busy = 'command'
      render()
      try {
        const result = await api.command(line, { sessionId })
        if (disposed) return { ok: false, error: text('模块已释放', 'The module was disposed') }
        if (!result || result.executed !== true) {
          const reason = result?.message ? String(result.message).slice(0, 300) : text('主机未执行该命令', 'The Host did not execute the command')
          return fail(reason)
        }
        return succeed(message)
      } catch (error) {
        if (disposed) return { ok: false, error: text('模块已释放', 'The module was disposed') }
        return fail(error?.message ? String(error.message).slice(0, 300) : text('主机命令失败', 'The Host command failed'))
      } finally {
        busy = ''
        render()
      }
    }
    async function submitAnswer(review, value, successMessage) {
      if (busy) return { ok: false, error: text('操作进行中', 'An action is already running') }
      if (typeof api.respond !== 'function') return fail(text('未接入主机交互接口，无法提交审批', 'The Host interaction channel is not connected'))
      const problem = describeProblem()
      if (problem) return fail(problem)
      if (!review.rpcId) return fail(text('主机未提供请求标识，无法提交审批', 'The Host supplied no request id'))
      busy = 'approve'
      render()
      try {
        const accepted = await api.respond(review.rpcId, value)
        if (disposed) return { ok: false, error: text('模块已释放', 'The module was disposed') }
        if (accepted !== true) return fail(text('主机未接受本次提交：待审阅请求可能已在其他终端处理或已失效。', 'The Host did not accept the submission; the review may have been handled elsewhere or expired.'))
        answered.add(review.rpcId)
        frameReviews.delete(review.rpcId)
        return succeed(successMessage)
      } catch (error) {
        if (disposed) return { ok: false, error: text('模块已释放', 'The module was disposed') }
        return fail(error?.message ? String(error.message).slice(0, 300) : text('提交审批失败', 'The review submission failed'))
      } finally {
        busy = ''
        render()
        api.notify?.(notice?.text || '', notice?.kind)
      }
    }
    const controller = {
      get session() { return sessionId },
      view: buildView,
      render,
      refresh() { return render() },
      setSession(next) {
        sessionId = next === null || next === undefined || next === '' ? null : String(next)
        notice = null
        busy = ''
        return render()
      },
      handleFrame(frame) {
        if (disposed) return false
        const payload = frame && frame.payload && typeof frame.payload === 'object' ? frame.payload : frame
        if (!payload || typeof payload !== 'object') return false
        if (payload.type === 'question/requested') {
          const review = reviewFromFrame(frame)
          if (!review || !review.rpcId) return false
          resolved.delete(review.rpcId)
          answered.delete(review.rpcId)
          frameReviews.set(review.rpcId, review)
          notice = null
          render()
          return true
        }
        if (payload.type === 'question/resolved') {
          const rpcId = String(payload.questionRpcId || '')
          if (!rpcId) return false
          const frameReview = frameReviews.get(rpcId)
          const sameSession = !frameReview?.sessionId || !sessionId || String(frameReview.sessionId) === String(sessionId)
          const known = sameSession && (frameReviews.has(rpcId) || knownReviews.has(rpcId))
          const ours = answered.has(rpcId)
          resolved.add(rpcId)
          frameReviews.delete(rpcId)
          if (known && !ours) notice = { kind: 'info', text: text('待审阅请求已在其他终端处理或已结束。', 'The review was handled in another client or has ended.') }
          render()
          return known || ours
        }
        if (payload.type === 'session/projection') {
          if (payload.key !== 'plan') return false
          render()
          return true
        }
        return false
      },
      handleEvent(eventSessionId, event) {
        if (disposed || !event || typeof event !== 'object') return false
        const id = eventSessionId || sessionId
        if (!id) return false
        if (event.type !== 'tool/call' && event.type !== 'tool/result') return false
        const extra = extraEntries.get(String(id)) || []
        if (!extra.some(entry => entry.seq === event.seq)) extra.push({ seq: event.seq, event })
        extraEntries.set(String(id), extra)
        if (event.type === 'tool/result') render()
        return true
      },
      enter() { return runPlanCommand('/plan', text('已提交进入 Plan 模式的主机命令，等待 Plan 状态更新。', 'Host command submitted to enter plan mode; waiting for the plan state.')) },
      exit() { return runPlanCommand('/plan off', text('已提交退出 Plan 模式的主机命令，等待 Plan 状态更新。', 'Host command submitted to leave plan mode; waiting for the plan state.')) },
      approve() {
        const review = currentReview(sessionId)
        if (!review) return Promise.resolve(fail(text('待审阅请求已结束或已由其他终端处理。', 'The review has ended or was handled in another client.')))
        if (!review.approveLabel) return Promise.resolve(fail(text('主机未提供批准选项，不能猜测审批结果。', 'The Host named no approve option; the verdict is not guessed.')))
        if (!review.questionId) return Promise.resolve(fail(text('主机未提供问题标识，无法提交审批。', 'The Host supplied no question id')))
        return submitAnswer(review, { sessionId, answer: { answers: [{ id: review.questionId, selected: [review.approveLabel] }] } },
          text('已提交批准；主机确认后会退出 Plan 模式。', 'Approval submitted; plan mode exits once the Host confirms.'))
      },
      keep(feedback) {
        const review = currentReview(sessionId)
        if (!review) return Promise.resolve(fail(text('待审阅请求已结束或已由其他终端处理。', 'The review has ended or was handled in another client.')))
        const custom = cleanup(feedback).slice(0, 2000)
        if (!review.keepLabel && !custom) return Promise.resolve(fail(text('主机未提供“继续计划”选项，且没有反馈内容。', 'The Host named no keep-planning option and no feedback was provided.')))
        if (!review.questionId) return Promise.resolve(fail(text('主机未提供问题标识，无法提交审批。', 'The Host supplied no question id')))
        const answer = { id: review.questionId, selected: review.keepLabel ? [review.keepLabel] : [] }
        if (custom) answer.custom = custom
        return submitAnswer(review, { sessionId, answer: { answers: [answer] } },
          text('已提交“继续完善计划”的反馈；等待主机继续。', 'Keep-planning feedback submitted; waiting for the Host to continue.'))
      },
      isCurrentPlanReview(rpcId) {
        const review = currentReview(sessionId)
        return !!review && review.rpcId === String(rpcId || '')
      },
      dispose() {
        disposed = true
        if (unbind) unbind()
        unbind = null
        frameReviews.clear()
        resolved.clear()
        answered.clear()
        knownReviews.clear()
        extraEntries.clear()
        notice = null
      },
    }
    if (rootEl) render()
    return controller
  }

  /* ------------------------------------------------------------------ binding */

  function bind(container, controller) {
    if (!container || typeof container.addEventListener !== 'function') return () => {}
    if (container.dataset && container.dataset.drPlanBound === '1') return () => {}
    if (container.dataset) container.dataset.drPlanBound = '1'
    const onClick = event => {
      const target = event?.target
      const button = target && typeof target.closest === 'function' ? target.closest('[data-dr-plan-action]') : null
      if (!button || button.disabled === true) return
      const action = button.dataset?.drPlanAction || button.getAttribute?.('data-dr-plan-action') || ''
      const box = typeof button.closest === 'function' ? button.closest('[data-dr-plan-scope]') : null
      const feedback = box && typeof box.querySelector === 'function' ? box.querySelector('[data-dr-plan-feedback]')?.value || '' : ''
      const run = {
        enter: () => controller.enter(),
        exit: () => controller.exit(),
        approve: () => controller.approve(),
        keep: () => controller.keep(feedback),
        refresh: () => controller.refresh(),
        'view-plan': () => {
          const details = box?.querySelector?.('[data-dr-plan-doc]')
          if (details && typeof details.setAttribute === 'function') details.setAttribute('open', '')
          return controller.view().review
        },
      }[action]
      if (!run) return
      Promise.resolve(run()).catch(() => {})
    }
    container.addEventListener('click', onClick)
    return () => {
      container.removeEventListener?.('click', onClick)
      if (container.dataset) delete container.dataset.drPlanBound
    }
  }

  const api = {
    MAX_HISTORY,
    normalizePlan, describePlan, planReviewOf, reviewFromFrame, historyPlans, hasContent,
    statusHtml, reviewHtml, historyHtml, noticeHtml, viewHtml,
    create, init: create, bind, esc, firstHeading,
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshPlanReview = api
})(typeof window === 'undefined' ? globalThis : window)
