/* Clipboard actions belong to one displayed source block, never a whole reply. */
;(function(root) {
  'use strict'
  const scopes = new WeakMap(); let nextScope = 0
  const resetTimers = new WeakMap()
  const label = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  function scope(history) { if (!scopes.has(history)) scopes.set(history, String(++nextScope)); return scopes.get(history) }
  function code(source, language = '', options = {}) {
    const lang = /^[a-zA-Z0-9_+.-]{1,40}$/.test(String(language)) ? String(language) : ''
    const markdown = /^(?:md|markdown)$/i.test(lang)
    const name = markdown ? 'Markdown' : lang || label('代码', 'Code')
    const action = markdown ? label('复制 Markdown', 'Copy Markdown') : options.label || label('复制代码', 'Copy code')
    const scoped = options.scope == null ? '' : ` data-chat-copy-scope="${esc(options.scope)}"`
    return `<div class="chat-code"><div class="chat-code-toolbar"><span class="chat-code-language">${esc(name)}</span><button type="button" class="chat-copy-button" data-chat-copy-code${scoped} aria-label="${esc(action)}" title="${esc(action)}"><svg class="chat-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><svg class="chat-copy-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span class="chat-copy-status" aria-live="polite"></span></button></div><pre><code>${esc(source)}</code></pre></div>`
  }
  function bind(box, host) {
    if (!box || box.dataset.chatCopyBound) return
    box.dataset.chatCopyBound = '1'
    box.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-chat-copy-code]')
      if (!button || !box.contains(button) || button.disabled) return
      const context = host.capture()
      if (!context.valid()) return
      if (context.history && button.dataset.chatCopyScope !== scope(context.history)) return
      const source = button.closest('.chat-code')?.querySelector('pre code')?.textContent
      if (source == null || source === '') return
      event.preventDefault(); event.stopPropagation()
      clearTimeout(resetTimers.get(button))
      delete button.dataset.copyState
      button.disabled = true
      const original = button.getAttribute('aria-label')
      const status = button.querySelector('.chat-copy-status')
      if (status) status.textContent = ''
      try {
        const ok = await host.copy(source)
        if (context.valid() && box.contains(button)) {
          button.dataset.copyState = ok ? 'copied' : 'error'
          const feedback = label(ok ? '已复制' : '复制失败，请重试', ok ? 'Copied' : 'Copy failed. Please retry.')
          button.setAttribute('aria-label', feedback); button.title = feedback
          if (status) status.textContent = ok ? feedback : ''
          if (!ok) host.notice(feedback, 'err')
        }
      } catch { if (context.valid()) host.notice(label('复制失败，请重试', 'Copy failed. Please retry.'), 'err') }
      finally {
        button.disabled = false
        resetTimers.set(button, setTimeout(() => {
          delete button.dataset.copyState
          resetTimers.delete(button)
          if (status) status.textContent = ''
          if (original) { button.setAttribute('aria-label', original); button.title = original }
        }, 1600))
      }
    })
  }
  const api = { scope, code, bind }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshChatCopy = api
})(typeof window === 'undefined' ? globalThis : window)
