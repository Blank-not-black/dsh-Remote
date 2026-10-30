/* Explicit clipboard actions over the loaded history; no duplicate source cache. */
;(function(root) {
  'use strict'
  const scopes = new WeakMap(); let nextScope = 0
  const label = (zh, en) => root.I18N?.lang === 'en' ? en : zh
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  function scope(history) { if (!scopes.has(history)) scopes.set(history, String(++nextScope)); return scopes.get(history) }
  function messageText(entries, seq) {
    const entry = entries.find(row => String(row.seq) === String(seq))
    if (!['user/message', 'assistant/message'].includes(entry?.event?.type)) return ''
    const data = entry.event.data || {}, blocks = data.message?.content || data.content || []
    return Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n\n') : ''
  }
  function button(seq, history) {
    return `<button type="button" class="chat-copy-button" data-chat-copy-markdown="${esc(seq)}" data-chat-copy-scope="${scope(history)}">${esc(label('复制 Markdown', 'Copy Markdown'))}</button>`
  }
  function code(source) {
    return `<div class="chat-code"><button type="button" class="chat-copy-button" data-chat-copy-code>${esc(label('复制代码', 'Copy code'))}</button><pre><code>${esc(source)}</code></pre></div>`
  }
  function bind(box, host) {
    if (!box || box.dataset.chatCopyBound) return
    box.dataset.chatCopyBound = '1'
    box.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-chat-copy-markdown],[data-chat-copy-code]')
      if (!button || !box.contains(button) || button.disabled) return
      const context = host.capture()
      if (!context.valid()) return
      let source
      if (button.hasAttribute('data-chat-copy-markdown')) {
        if (button.dataset.chatCopyScope !== scope(context.history)) return
        source = messageText(context.history.visible, button.dataset.chatCopyMarkdown)
      } else source = button.closest('.chat-code')?.querySelector('pre code')?.textContent
      if (source == null || source === '') return
      event.preventDefault(); event.stopPropagation()
      button.disabled = true
      try {
        const ok = await host.copy(source)
        if (context.valid()) host.notice(label(ok ? '已复制' : '复制失败，请重试', ok ? 'Copied' : 'Copy failed. Please retry.'), ok ? 'ok' : 'err')
      } catch { if (context.valid()) host.notice(label('复制失败，请重试', 'Copy failed. Please retry.'), 'err') }
      finally { button.disabled = false }
    })
  }
  const api = { scope, messageText, button, code, bind }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.DshChatCopy = api
})(typeof window === 'undefined' ? globalThis : window)
