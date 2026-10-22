/* Completed-turn actions derived from durable events. No dependencies. */
'use strict';
;(function(root) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const text = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
  const count = n => typeof n === 'number' && Number.isFinite(n) && n >= 0
  function messageText(event) {
    const data = event.data || {}, blocks = data.message?.content ?? data.content
    if (Array.isArray(blocks)) return blocks.filter(b => b?.type === 'text').map(b => String(b.text ?? '')).join('\n\n').trim()
    return typeof data.text === 'string' ? data.text.trim() : ''
  }
  function summarize(entries, sessionId) {
    const results = new Map(), seen = new Set()
    let turn = null
    const fresh = (id, started = false) => ({ id, started, messages: 0, missing: false, samples: 0, total: 0, usage: Object.fromEntries(keys.map(k => [k, 0])), text: '' })
    for (const entry of entries) {
      const event = entry.event || {}, data = event.data || {}, id = data.turn
      if (!Number.isSafeInteger(entry.seq) || seen.has(entry.seq)) continue
      seen.add(entry.seq)
      if (event.type === 'turn/start') { turn = fresh(id, true); continue }
      if (event.type === 'user/message') {
        const source = data.source ?? data.message?.source
        if ((!source || source.kind === 'user') && (!turn || !turn.started)) turn = fresh(id)
      }
      if (event.type === 'assistant/message') {
        if (!turn || id != null && turn.id != null && id !== turn.id) turn = fresh(id)
        if (turn.id == null) turn.id = id
        turn.messages++
        const body = messageText(event)
        if (body) turn.text = body
        const u = data.usage
        if (u && (count(u.totalTokens) || count(u.inputTokens) && count(u.outputTokens))) {
          for (const k of keys) if (count(u[k])) turn.usage[k] += u[k]
          // DSH counters are disjoint. Reasoning is already included in output.
          turn.total += count(u.totalTokens) ? u.totalTokens : keys.reduce((n, k) => n + (count(u[k]) ? u[k] : 0), 0)
          turn.samples++
        } else turn.missing = true
      }
      if (event.type !== 'turn/end') continue
      if (turn?.messages && (id == null || turn.id == null || id === turn.id)) {
        const time = typeof event.time === 'number' ? event.time : Date.parse(event.time)
        results.set(entry.seq, { sessionId, atSeq: entry.seq, text: turn.text,
          time: Number.isFinite(time) && time > 0 ? time : null,
          total: turn.samples ? turn.total : null, usage: turn.usage,
          partial: !turn.started || turn.missing })
      }
      turn = null
    }
    return results
  }
  function decorate(prepared, entries, options = {}) {
    const results = summarize(entries, options.sessionId)
    return prepared.map(entry => results.has(entry.seq) && entry.event?.type === 'turn/end'
      ? { ...entry, view: { ...entry.view, turnResult: { ...results.get(entry.seq), canFork: options.canFork === true } } }
      : entry)
  }
  const paths = {
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    fork: '<circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6 8v8m12-8a8 8 0 0 1-8 8H6"/>',
    usage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>'
  }
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`
  function formatTokens(n) {
    for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (n >= size) return (n / size).toFixed(1).replace(/\.0$/, '') + suffix
    return String(n)
  }
  function html(result) {
    const button = (action, label, disabled = false) => `<button type="button" data-turn-action="${action}" title="${esc(label)}" aria-label="${esc(label)}"${disabled ? ' disabled' : ''}>${icon(action)}<span>${esc(label)}</span></button>`
    const total = result.total == null ? '—' : formatTokens(result.total) + ' tok'
    const label = text(result.partial && result.total != null ? '已知用量' : '用量', result.partial && result.total != null ? 'Known usage' : 'Usage')
    const u = result.usage
    const detail = result.total == null ? text('主机未提供该回合的用量。', 'The host did not report usage for this turn.')
      : `${text('输入', 'Input')} ${u.inputTokens} · ${text('输出', 'Output')} ${u.outputTokens} · ${text('缓存读取', 'Cache read')} ${u.cacheReadTokens} · ${text('缓存写入', 'Cache write')} ${u.cacheWriteTokens} · ${text('合计', 'Total')} ${result.total}` + (result.partial ? text('（记录未加载完整或部分调用未报告用量）', ' (history incomplete or some calls did not report usage)') : '')
    const date = result.time == null ? null : new Date(result.time)
    const stamp = date ? date.toLocaleString(root.I18N?.lang === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : text('时间未知', 'Time unavailable')
    const labels = [text('输入', 'Input'), text('输出', 'Output'), text('缓存读取', 'Cache read'), text('缓存写入', 'Cache write')]
    const breakdown = result.total == null ? `<p>${esc(detail)}</p>` : `<dl>${keys.map((key, index) => `<div><dt>${esc(labels[index])}</dt><dd>${u[key].toLocaleString()} tok</dd></div>`).join('')}<div><dt>${esc(text('合计', 'Total'))}</dt><dd>${result.total.toLocaleString()} tok</dd></div></dl>${result.partial ? `<p>${esc(text('记录未加载完整，或部分调用未报告用量。', 'History is incomplete, or some calls did not report usage.'))}</p>` : ''}`
    return `<div class="turn-result" data-turn-seq="${result.atSeq}" data-turn-session="${esc(result.sessionId)}" role="group" aria-label="${esc(text('回合结果', 'Turn result'))}">${button('copy', text('复制结果', 'Copy result'), !result.text)}${result.canFork ? button('fork', text('从此处分支', 'Branch from here')) : ''}<details class="turn-result-usage" data-activity-key="turn-usage:${result.atSeq}"><summary title="${esc(detail)}">${icon('usage')}${esc(label)} ${esc(total)}</summary><div class="turn-result-breakdown">${breakdown}</div></details><time${date ? ` datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}"` : ''}>${esc(stamp)}</time><span class="turn-result-status" role="status" aria-live="polite"></span></div>`
  }
  // Delegate on the stable history container so paging/redraws need no new listeners.
  function bind(box, host) {
    if (!box || box.dataset.turnResultsBound) return
    box.dataset.turnResultsBound = '1'
    const pending = new Set()
    box.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-turn-action]'), row = button?.closest('.turn-result')
      if (!row || !box.contains(row)) return
      const context = host.capture(), atSeq = Number(row.dataset.turnSeq)
      if (context.sessionId !== row.dataset.turnSession || !context.valid()) return
      const result = summarize(context.entries, context.sessionId).get(atSeq)
      if (!result) return
      const key = context.key + ':' + context.sessionId + ':' + atSeq + ':' + button.dataset.turnAction
      if (pending.has(key)) return
      const status = row.querySelector('.turn-result-status')
      pending.add(key); button.disabled = true
      try {
        if (button.dataset.turnAction === 'copy') {
          if (!result.text || !await host.copy(result.text)) throw Error(text('复制失败，请重试', 'Copy failed. Please retry.'))
          if (context.valid()) status.textContent = text('已复制', 'Copied')
        } else if (button.dataset.turnAction === 'fork' && context.canFork) {
          status.textContent = text('正在创建分支…', 'Creating branch…')
          // No prompt is sent to the child. Unknown write receipts are never replayed.
          const child = await host.fork({ sessionId: context.sessionId, atSeq })
          if (!context.valid()) return
          if (!child?.sessionId) throw Error(text('主机未返回分支会话', 'The host did not return a branch session'))
          status.textContent = text('正在打开分支…', 'Opening branch…')
          await host.open(child.sessionId, context)
        }
      } catch (error) {
        if (context.valid()) status.textContent = error.message || text('操作失败', 'Action failed')
      } finally {
        pending.delete(key)
        if (context.valid()) button.disabled = false
      }
    })
  }
  const api = { summarize, decorate, html, bind }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshTurnResults = api
})(typeof window === 'undefined' ? globalThis : window)
