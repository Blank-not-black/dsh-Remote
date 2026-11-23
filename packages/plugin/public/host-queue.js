;(function (root) {
  'use strict'
  const tr = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const text = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const contentOf = item => item?.message?.content ?? item?.content
  const editable = item => Array.isArray(contentOf(item)) && contentOf(item).length > 0
    && contentOf(item).every(part => part?.type === 'text' && typeof part.text === 'string')
  const bodyOf = item => (Array.isArray(contentOf(item)) ? contentOf(item) : []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
  const actionable = item => ['queued', 'steering'].includes(item?.placement)
  const denied = error => [error?.code, error?.message].some(value => typeof value === 'string' && /host-state\/access-denied|HTTP 403|permission.denied|forbidden/i.test(value))
  const knownRejection = error => !!(error?.rpcRejected || denied(error) || error?.message === 'AUTH' || /^(?:session\/|schedule[\/_])/.test(error?.code || '')) && !error?.operationPending

  async function readAccess(connection, url) {
    if (!connection.valid() || !connection.token) return false
    const response = await root.fetch(url('/api/host-state-access'), {
      headers: { authorization: 'Bearer ' + connection.token }, cache: 'no-store', signal: AbortSignal.timeout(8000),
    })
    if (response.status === 403) return false
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return (await response.json()).writable === true
  }

  function explain(error) {
    if (denied(error)) return tr('此设备无权修改主机状态。', 'This device cannot modify Host state.')
    switch (error?.code) {
      case 'session/queue-item-not-found': return tr('已不在队列中', 'No longer pending')
      case 'session/steer-unavailable': return tr('当前轮次已不接受插队', 'The current turn no longer accepts steering')
      case 'session/queue-conflict': return tr('内容已变化，请重新打开编辑', 'Item changed; reopen the editor')
      case 'session/queue-edit-attachments': return tr('主机编辑接口无法保留附件', 'The Host cannot preserve attachments when editing')
      case 'session/queue-state-unsupported': return tr('该主机无法提供可核对的队列快照', 'This Host does not provide a verifiable queue snapshot')
      default: return error?.message || tr('主机未确认', 'Not confirmed by the Host')
    }
  }

  async function writeItems({ rpc, sessionId, wanted, snapshot, action, valid }) {
    const targets = new Map(wanted.map(item => [item.id, item]))
    const current = new Map(snapshot.items.map(item => [item.id, item]))
    const ordered = [...snapshot.items.filter(item => targets.has(item.id)), ...wanted.filter(item => !current.has(item.id))]
    const results = []
    let stop = false
    for (const item of ordered) {
      const row = current.get(item.id)
      let result = 'rejected', detail = ''
      if (!valid() || stop) {
        result = 'skipped'
        detail = tr('未提交', 'Not submitted')
      } else if (!row || !actionable(row)) detail = explain({ code: 'session/queue-item-not-found' })
      else if (action.kind === 'steer' && (row.placement !== 'queued' || !snapshot.running)) detail = explain({ code: 'session/steer-unavailable' })
      else if (action.kind === 'edit' && (!editable(row) || JSON.stringify(contentOf(row)) !== JSON.stringify(contentOf(targets.get(item.id))))) {
        detail = explain({ code: editable(row) ? 'session/queue-conflict' : 'session/queue-edit-attachments' })
      } else {
        const expected = action.kind === 'edit' ? { expectedContent: contentOf(row) } : {}
        try {
          const reply = await rpc('session.updateQueue', { sessionId, itemId: row.id, action, ...expected })
          if (!reply?.accepted) throw new Error()
          result = 'accepted'
          detail = tr('主机已接受', 'Accepted by the Host')
        } catch (error) {
          if (knownRejection(error)) {
            detail = explain(error)
            if (denied(error) || error?.message === 'AUTH') stop = true
          }
          else {
            stop = true
            result = 'unknown'
            detail = tr('结果未确认，不会重发', 'Unconfirmed; not retried')
          }
        }
      }
      results.push({ item: targets.get(item.id), result, detail })
    }
    return results
  }

  function create(config) {
    let context, latestSeq, run, revision = 0, results = [], message = '', writable = null, dialog, signature
    const valid = entry => entry && entry === context && entry.connection.valid() && config.session() === entry.sessionId
    const current = () => {
      if (!valid(context)) {
        context = { connection: config.capture(), sessionId: config.session() }
        latestSeq = undefined
        results = []; message = ''; writable = null; signature = undefined
        dialog?.close()
      }
      return context
    }
    function accept(sessionId, seq) {
      const entry = current()
      if (entry.sessionId !== sessionId || !Number.isSafeInteger(seq)) return true
      if (Number.isSafeInteger(latestSeq) && seq < latestSeq) return false
      latestSeq = seq
      return true
    }
    async function refresh(entry = current()) {
      if (!entry.sessionId || !entry.connection.token) return
      const generation = ++revision
      const readQueue = () => config.rpc('session.queueState', { sessionId: entry.sessionId })
      let [snapshot, access] = await Promise.all([readQueue(), config.access(entry.connection)])
      const checkSnapshot = () => {
        if (!Array.isArray(snapshot?.items) || typeof snapshot.running !== 'boolean') throw new Error(tr('未收到主机队列', 'Host queue unavailable'))
        return accept(entry.sessionId, snapshot.seq)
      }
      if (!valid(entry) || generation !== revision) return
      if (!checkSnapshot()) {
        snapshot = await readQueue()
        if (!valid(entry) || generation !== revision) return
        if (!checkSnapshot()) throw new Error(tr('队列正在变化，请重新读取', 'The queue is changing. Read it again.'))
      }
      writable = access
      config.apply(entry.sessionId, snapshot)
      return snapshot
    }
    function reconnect() {
      const entry = current()
      if (!entry.sessionId || !entry.connection.token || run?.entry === entry) return
      writable = null
      render()
      void refresh(entry).then(() => { if (valid(entry)) render() }).catch(error => {
        if (!valid(entry)) return
        writable = denied(error) ? false : null
        message = explain(error)
        render()
      })
    }
    async function mutate(wanted, action) {
      const entry = current()
      if (run || writable !== true || !wanted.length) return
      run = { entry }
      results = []; message = ''
      render()
      try {
        const snapshot = await refresh(entry)
        if (!snapshot || !valid(entry)) return
        if (!writable) throw new Error('host-state/access-denied')
        results = await writeItems({ rpc: config.rpc, sessionId: entry.sessionId, wanted, snapshot, action, valid: () => valid(entry) })
      } catch (error) {
        if (valid(entry)) message = explain(error)
      } finally {
        if (valid(entry)) {
          try { await refresh(entry) } catch (error) {
            if (valid(entry)) {
              writable = denied(error) ? false : null
              message = tr('未能重新读取队列；刷新前不能再次操作。', 'Could not reread the queue. Refresh before another change.')
            }
          }
        }
        run = null
        if (!valid(entry)) results = []
        render()
      }
    }
    function edit(item) {
      if (!editable(item) || writable !== true || run) return
      if (!dialog) {
        dialog = root.document.createElement('dialog')
        dialog.className = 'host-state-dialog'
        dialog.setAttribute('aria-labelledby', 'host-queue-edit-title')
        root.document.body.append(dialog)
      }
      dialog.innerHTML = `<form method="dialog"><h2 id="host-queue-edit-title">${tr('编辑排队消息', 'Edit pending message')}</h2><label>${tr('正文', 'Message')}<textarea rows="6" required></textarea></label><div class="host-state-actions"><button value="cancel" formnovalidate>${tr('取消', 'Cancel')}</button><button value="save">${tr('保存', 'Save')}</button></div></form>`
      const input = dialog.querySelector('textarea')
      input.value = bodyOf(item)
      const entry = current()
      dialog.querySelector('form').onsubmit = event => {
        if (event.submitter?.value !== 'save') return
        event.preventDefault()
        if (!input.value.trim() || !valid(entry)) return
        dialog.close()
        if (input.value !== bodyOf(item)) void mutate([item], { kind: 'edit', content: [{ type: 'text', text: input.value }] })
      }
      dialog.showModal()
    }
    function render() {
      const entry = current()
      const box = config.box()
      if (!box) return
      const items = (config.items() || []).filter(item => item?.id && ['queued', 'steering', 'context'].includes(item.placement))
      const queued = items.filter(item => item.placement === 'queued')
      const running = config.running(), busy = !!run
      const next = JSON.stringify([items, running, busy, writable, results, message, root.I18N?.lang])
      if (signature === next) return
      signature = next
      const expanded = new Set([...box.querySelectorAll('details[open]')].map(node => node.dataset.queueRow))
      box.classList.toggle('hidden', !items.length && (!results.length && !busy))
      const disabled = busy || writable !== true
      const label = placement => placement === 'queued' ? tr('等待下轮', 'Waiting for next turn')
        : placement === 'steering' ? tr('已插队 · 待注入', 'Steered · awaiting injection') : tr('待注入的主机上下文', 'Pending Host context')
      const button = (action, title, locked, reason = '') => `<button type="button" data-queue-action="${action}" ${locked ? 'disabled' : ''} ${reason ? `title="${text(reason)}"` : ''}>${title}</button>`
      box.innerHTML = `<div class="host-state-actions"><strong>${tr('主机队列', 'Host queue')} · ${items.length}</strong>${queued.length ? button('all', tr('全部按顺序插队', 'Steer all in order'), disabled || !running) : ''}${button('refresh', tr('刷新', 'Refresh'), busy)}</div>
        ${writable === false ? `<small>${tr('此设备在这里是只读的。', 'This device has read-only access here.')}</small>` : ''}
        ${message ? `<p role="status">${text(message)}</p>` : ''}
        <div class="host-queue-rows">${items.map(item => `<details data-queue-row="${text(item.id)}" ${expanded.has(item.id) ? 'open' : ''}>
          <summary><strong>${label(item.placement)}</strong> · ${text(bodyOf(item).replace(/\s+/g, ' ').slice(0, 100) || tr('展开查看内容', 'Expand for content'))}</summary>
          <div data-queue-body></div>${actionable(item) ? `<div class="host-state-actions">${button('edit', tr('编辑', 'Edit'), disabled || !editable(item), editable(item) ? '' : explain({ code: 'session/queue-edit-attachments' }))}${button('remove', tr('删除', 'Delete'), disabled)}${item.placement === 'queued' ? button('steer', tr('插队', 'Steer'), disabled || !running) : ''}</div>${!editable(item) ? `<small>${explain({ code: 'session/queue-edit-attachments' })}</small>` : ''}` : ''}
        </details>`).join('')}</div>
        ${results.length ? `<ul class="host-state-results" aria-label="${tr('逐条结果', 'Per-item results')}">${results.map(({ item, detail }) => `<li>${text(bodyOf(item).replace(/\s+/g, ' ').slice(0, 60) || item.id)}：${text(detail)}</li>`).join('')}</ul>` : ''}`
      for (const node of box.querySelectorAll('[data-queue-row]')) {
        const item = items.find(row => row.id === node.dataset.queueRow)
        const showBody = () => {
          const body = node.querySelector('[data-queue-body]')
          if (!node.open || body.dataset.loaded) return
          body.dataset.loaded = '1'
          const parts = contentOf(item)
          body.innerHTML = Array.isArray(parts) ? parts.map(part => {
            if (part?.type === 'text') return `<div class="host-state-pre">${text(part.text)}</div>`
            if (part?.type === 'image' && part.attachment && root.DshImagePreview) return root.DshImagePreview.attachmentHtml(part.attachment, tr('图片', 'Image'), entry.sessionId)
            if (part?.type === 'file' && root.DshChatFiles) return root.DshChatFiles.render(part)
            return `<p>${tr('附件', 'Attachment')}：${text(part?.attachment?.name || part?.name || tr('无可预览内容', 'No preview available'))}</p>`
          }).join('') : tr('正文未公开。', 'Content is not available.')
        }
        node.addEventListener('toggle', showBody)
        showBody()
      }
      box.onclick = event => {
        const trigger = event.target.closest('[data-queue-action]')
        if (!trigger || trigger.disabled || !valid(entry)) return
        const action = trigger.dataset.queueAction
        if (action === 'refresh') return reconnect()
        if (action === 'all') return void mutate(queued, { kind: 'steer' })
        const item = items.find(row => row.id === trigger.closest('[data-queue-row]')?.dataset.queueRow)
        if (!item) return
        if (action === 'edit') return edit(item)
        if (action === 'remove' && !root.confirm(tr('删除这条尚未注入的消息？', 'Delete this pending message?'))) return
        void mutate([item], { kind: action })
      }
    }
    return { accept, reconnect, render }
  }
  const api = { create, writeItems, editable, denied, knownRejection, readAccess }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshHostQueue = api
})(globalThis)
