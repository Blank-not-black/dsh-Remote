/* Conversation context cards. Original nodes and their action handlers stay in place. */
;(function (root) {
  'use strict'
  const priority = { approval: 0, question: 1, file: 2, queue: 3, goal: 4, todos: 5 }
  function createSelection() {
    let rows = [], selected = '', scope = '', scopeSet = false
    const remembered = new Map()
    return {
      get rows() { return rows }, get index() { return rows.findIndex(row => row.key === selected) },
      sync(next, nextScope) {
        const previousIndex = this.index, previousKind = rows[previousIndex]?.kind, changed = !scopeSet || scope !== nextScope
        if (changed) {
          if (scopeSet && selected) remembered.set(scope, selected)
          while (remembered.size > 12) remembered.delete(remembered.keys().next().value)
          scope = nextScope; scopeSet = true; selected = remembered.get(scope) || ''
        }
        rows = next
        if (!rows.some(row => row.key === selected)) {
          const sameKind = !changed && rows.find(row => row.kind === previousKind)
          const preferred = changed || previousIndex < 0 ? [...rows].sort((a, b) => priority[a.kind] - priority[b.kind])[0] : rows[Math.min(previousIndex, rows.length - 1)]
          selected = (sameKind || preferred)?.key || ''
        }
        return this.index
      },
      select(index) { if (rows.length) selected = rows[Math.max(0, Math.min(index, rows.length - 1))].key; return this.index },
      reset() { rows = []; selected = ''; scope = ''; scopeSet = false; remembered.clear() },
    }
  }
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const goalState = phase => ({ active: text('进行中', 'In progress'), paused: text('已暂停', 'Paused'), blocked: text('等待处理', 'Blocked'), complete: text('已完成', 'Complete') })[phase] || String(phase || text('状态未知', 'Unknown state'))
  function taskView(items) {
    const done = items.filter(item => item.status === 'completed').length
    return { done, total: items.length, current: items.find(item => item.status === 'in_progress') || items.find(item => item.status !== 'completed') }
  }
  function taskHtml(items) {
    const view = taskView(items), status = value => ({ completed: text('已完成', 'Done'), in_progress: text('进行中', 'In progress'), pending: text('待开始', 'Pending') })[value] || value
    return `<div class="deck-context-head"><strong>${view.done}/${view.total} ${text('已完成', 'done')}</strong></div><div class="deck-summary-text">${view.current ? esc((view.current.status === 'in_progress' ? text('正在：', 'Now: ') : text('下一步：', 'Next: ')) + (view.current.content || text('未命名任务', 'Untitled task'))) : text('全部任务已完成', 'All tasks completed')}</div><details class="deck-more" data-deck-details="tasks"><summary>${text('全部任务', 'All tasks')}</summary><div class="deck-full-content">${items.map(item => `<p><span class="deck-task-state">${esc(status(item.status))}</span>${esc(item.content || '')}</p>`).join('')}</div></details>`
  }
  function approvalHtml(item, fullDetail) {
    const info = root.DshApprovalRecords?.summary(item) || { kind: 'request', text: item.reason || '' }
    const reason = info.kind === 'auto' && root.I18N?.lang !== 'en' ? root.DshApprovalRecords?.chineseReference(info.text) || info.text : info.text
    const permission = info.target ? ({ 'danger-full-access': text('完整访问', 'Full access'), 'workspace-write': text('工作区写入', 'Workspace write'), 'read-only': text('只读', 'Read only') })[info.target] || info.target : ''
    const badge = info.kind === 'auto' ? text('审查未通过', 'Review denied') : info.kind === 'escalation' ? text('申请：', 'Request: ') + permission : ''
    const args = item.arguments
    let preview = ''
    if (args && typeof args === 'object') {
      for (const key of ['command', 'cmd', 'script', 'path', 'file_path', 'url']) if (typeof args[key] === 'string' && args[key]) { preview = (['command', 'cmd', 'script'].includes(key) ? text('命令', 'Command') : key === 'url' ? text('地址', 'URL') : text('路径', 'Path')) + ': ' + args[key]; break }
    } else if (typeof args === 'string') preview = args
    return `<div class="deck-review-head"><strong>${esc(item.toolName || text('工具调用', 'Tool call'))}</strong>${badge ? `<span class="deck-review-badge">${esc(badge)}</span>` : ''}</div><p class="deck-review-reason">${esc(reason || text('主机未提供申请原因', 'The host provided no reason'))}</p>${preview ? `<div class="deck-argument-preview" title="${esc(preview)}">${esc(preview)}</div>` : ''}<div class="deck-review-footer"><button type="button" class="deck-decision primary" data-session-approve="1">${text('允许一次', 'Allow once')}</button><button type="button" class="deck-decision" data-session-approve="0">${text('拒绝', 'Reject')}</button><details class="deck-more" data-deck-details="approval"><summary>${text('完整请求', 'Full request')}</summary><pre class="deck-full-content">${esc(text('工具：', 'Tool: ') + (item.toolName || '') + '\n' + fullDetail)}</pre></details></div>`
  }
  let instance
  function mount(config) {
    if (instance || !root.document) return instance
    const doc = root.document, deck = doc.getElementById('session-deck')
    if (!deck) return
    const stage = deck.querySelector('.session-deck-stage'), sources = ['session-cards', 'queue-dock', 'session-pending', 'file-inbox-session'].map(id => doc.getElementById(id)).filter(Boolean)
    const selection = createSelection(), labels = () => ({ goal: text('目标', 'Goal'), todos: text('任务', 'Tasks'), approval: text('审批', 'Approvals'), question: text('提问', 'Questions'), file: text('文件', 'Files'), queue: text('队列', 'Queue') })
    const make = (tag, cls, value) => { const el = doc.createElement(tag); el.className = cls; if (value != null) el.textContent = value; return el }
    const control = (name, value, fn) => { const el = make('button', 'session-deck-control', value); el.type = 'button'; el.setAttribute('aria-label', name); el.addEventListener('click', fn); return el }
    const header = make('div', 'session-deck-head'), tabs = make('div', 'session-deck-tabs'), controls = make('div', 'session-deck-controls'), count = make('span', 'session-deck-position')
    const notice = make('span', 'session-deck-sr'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', text('会话卡片分类', 'Conversation card categories'))
    const previous = control(text('上一张卡片', 'Previous card'), '‹', () => move(-1)), next = control(text('下一张卡片', 'Next card'), '›', () => move(1))
    const fold = control(text('收起卡片', 'Collapse cards'), '⌃', () => { folded = !folded; paint() }); fold.setAttribute('aria-controls', 'session-deck-stage')
    controls.append(previous, count, next, fold); header.append(tabs, controls); deck.prepend(header, notice)
    deck.setAttribute('role', 'region'); deck.setAttribute('aria-label', text('会话卡片，可左右切换', 'Conversation cards, switch left or right')); stage.tabIndex = 0
    let folded = false, lastScope = '', lastTabs = '', destroyed = false, queued = false, gesture = null, suppressClickUntil = 0
    const disclosures = new Map()
    const visibleSource = el => el && !el.hidden && !el.classList.contains('hidden')
    function collect() {
      const rows = []
      const add = (el, kind, id) => rows.push({ el, kind, key: kind + ':' + id })
      const cards = doc.getElementById('session-cards')
      for (const el of cards?.children || []) add(el, el.dataset.deckKind || 'todos', el.dataset.deckKind || 'todos')
      const pending = doc.getElementById('session-pending')
      if (visibleSource(pending)) for (const el of pending.querySelectorAll('[data-session-approval],[data-session-question]')) {
        const approval = el.dataset.sessionApproval
        add(el, approval != null ? 'approval' : 'question', approval ?? el.dataset.sessionQuestion)
      }
      const files = doc.getElementById('file-inbox-session')
      if (visibleSource(files)) for (const el of files.querySelectorAll('[data-transfer-id]')) add(el, 'file', el.dataset.transferId)
      const queue = doc.getElementById('queue-dock')
      if (visibleSource(queue) && queue.children.length) { add(queue, 'queue', 'queue'); rows[rows.length - 1].count = queue.querySelectorAll('[data-queue-steer]').length || 1 }
      return rows
    }
    function refresh() {
      if (destroyed) return
      const context = config.context()
      if (!context.inChat || !context.sessionId) { deck.hidden = true; return }
      const changed = lastScope !== context.sessionId
      if (changed) { folded = false; lastScope = context.sessionId; cancelGesture() }
      const rows = collect(); selection.sync(rows, context.sessionId)
      deck.hidden = !rows.length
      if (rows.length) paint()
    }
    function paint() {
      const rows = selection.rows, index = selection.index, names = labels(), counts = {}
      for (const [i, row] of rows.entries()) {
        row.el.dataset.deckCard = row.key
        row.el.toggleAttribute('data-deck-active', i === index)
        row.el.inert = i !== index || folded
        row.el.setAttribute('aria-hidden', String(i !== index || folded))
        for (const detail of row.el.querySelectorAll('details[data-deck-details]')) detail.open = disclosures.has(lastScope + ':' + row.key + ':' + detail.dataset.deckDetails)
        counts[row.kind] = (counts[row.kind] || 0) + (row.count || 1)
      }
      deck.dataset.folded = String(folded); stage.hidden = folded; deck.dataset.multiple = String(rows.length > 1)
      previous.disabled = index <= 0; next.disabled = index >= rows.length - 1
      count.textContent = rows.length ? (index + 1) + '/' + rows.length : ''
      fold.textContent = folded ? '⌄' : '⌃'; fold.setAttribute('aria-expanded', String(!folded)); fold.setAttribute('aria-label', folded ? text('展开卡片', 'Expand cards') : text('收起卡片', 'Collapse cards'))
      const signature = JSON.stringify([counts, rows[index]?.kind, root.I18N?.lang])
      if (signature !== lastTabs) {
        const focused = tabs.contains(doc.activeElement) ? doc.activeElement?.dataset.deckTab : ''
        tabs.replaceChildren()
        for (const kind of ['approval', 'question', 'file', 'goal', 'todos', 'queue']) if (counts[kind]) {
          const el = control(names[kind], '', () => { folded = false; select(selection.rows.findIndex(row => row.kind === kind)) })
          el.className = 'session-deck-tab' + (priority[kind] < 3 ? ' needs-action' : ''); el.dataset.deckTab = kind
          el.setAttribute('aria-pressed', String(rows[index]?.kind === kind)); el.append(make('span', '', names[kind]))
          if (priority[kind] < 3 || kind === 'queue') el.append(make('small', '', String(counts[kind])))
          tabs.append(el)
        }
        tabs.querySelectorAll('[data-deck-tab]').forEach(el => { if (el.dataset.deckTab === focused) el.focus({ preventScroll: true }) })
        lastTabs = signature
      }
      notice.textContent = Object.entries(counts).filter(([kind]) => priority[kind] < 3).map(([kind, n]) => names[kind] + ' ' + n).join('，')
    }
    function select(index) { cancelGesture(); selection.select(index); paint() }
    function move(delta) { folded = false; select(selection.index + delta) }
    function cancelGesture() { gesture = null; stage.style.removeProperty('--deck-drag') }
    function down(event) {
      if (selection.rows.length < 2 || event.isPrimary === false || event.button > 0 || event.target.closest('input,textarea,select,a,[contenteditable="true"]')) return
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, claimed: false }
    }
    function drag(event) {
      if (!gesture || event.pointerId !== gesture.id) return
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
      if (!gesture.claimed) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { cancelGesture(); return }
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return
        gesture.claimed = true; stage.setPointerCapture?.(event.pointerId)
      }
      gesture.dx = dx
      if (event.cancelable) event.preventDefault()
      stage.style.setProperty('--deck-drag', Math.max(-72, Math.min(72, dx)) + 'px')
    }
    function up(event) {
      if (!gesture || event.pointerId !== gesture.id) return
      const { dx, claimed } = gesture
      cancelGesture()
      if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId)
      if (claimed) { suppressClickUntil = Date.now() + 400; if (Math.abs(dx) >= 42) move(dx < 0 ? 1 : -1) }
    }
    function click(event) { if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation() } }
    function disclosure(event) {
      const detail = event.target, card = detail.closest('[data-deck-card]')
      if (!detail.dataset.deckDetails || !card) return
      const key = lastScope + ':' + card.dataset.deckCard + ':' + detail.dataset.deckDetails
      if (detail.open) disclosures.set(key, true); else disclosures.delete(key)
      while (disclosures.size > 64) disclosures.delete(disclosures.keys().next().value)
    }
    function key(event) {
      if (event.target !== stage && !tabs.contains(event.target)) return
      const index = event.key === 'ArrowLeft' ? selection.index - 1 : event.key === 'ArrowRight' ? selection.index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? selection.rows.length - 1 : null
      if (index != null) { event.preventDefault(); folded = false; select(index) }
    }
    const observer = new root.MutationObserver(() => { if (!queued) { queued = true; root.queueMicrotask(() => { queued = false; refresh() }) } })
    for (const source of sources) observer.observe(source, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'], characterData: true })
    stage.addEventListener('pointerdown', down); stage.addEventListener('pointermove', drag); stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', cancelGesture); stage.addEventListener('click', click, true); stage.addEventListener('toggle', disclosure, true); deck.addEventListener('keydown', key)
    deck.dataset.mounted = 'true'
    instance = { refresh, reset() { selection.reset(); disclosures.clear(); lastScope = ''; lastTabs = ''; folded = false; cancelGesture(); deck.hidden = true }, destroy() {
      destroyed = true; observer.disconnect(); cancelGesture(); header.remove(); notice.remove(); delete deck.dataset.mounted
      for (const row of selection.rows) { delete row.el.dataset.deckCard; delete row.el.dataset.deckActive; row.el.inert = false; row.el.removeAttribute('aria-hidden') }
      for (const [name, handler] of [['pointerdown', down], ['pointermove', drag], ['pointerup', up], ['pointercancel', cancelGesture]]) stage.removeEventListener(name, handler)
      stage.removeEventListener('click', click, true); stage.removeEventListener('toggle', disclosure, true); deck.removeEventListener('keydown', key); stage.hidden = false; instance = null
    } }
    refresh(); return instance
  }
  root.DshSessionDeck = { createSelection, goalState, taskView, taskHtml, approvalHtml, mount, refresh: () => instance?.refresh(), reset: () => instance?.reset() }
  if (typeof module !== 'undefined') module.exports = root.DshSessionDeck
})(typeof window !== 'undefined' ? window : globalThis)
